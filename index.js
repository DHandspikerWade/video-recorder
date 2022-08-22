const Docker = require('dockerode');
const DockerEvents = require('docker-events');
const mqtt = require('mqtt');
const cache = require('./cache')(process.env.REDIS_CONNECTION || '');

const downloadPath = process.env.DOWNLOAD_PATH || '/tmp'

function getUniqueName() {
    const nameTemplate = 'video_download_';
    let counter = 0;

    return new Promise((resolve) => {
        // TODO: I might be massively overthinking promises to create a retry loop for IDs. Revist this!

        let nextID = () => {
            counter++;

            let name = nameTemplate + counter;

            cache.has(name).then((exists) => {
                if (exists) {
                    nextID();
                } else {
                    cache.setCache(name, {}); // Reserve the name
                    resolve(name);
                    return;
                }
            });
        };

        nextID();
    });
}

function getConnection() {
    return new Docker({ socketPath: '/var/run/docker.sock' });
}

let hasImage = false;
function ensureImages() {
    let docker = getConnection();
    docker.listImages().then((images) => {
        let missing = true;
        images.forEach((image) => {
            if (image.RepoTags) {
                image.RepoTags.forEach(value => {
                    if (value && value.indexOf('handspiker2/youtube-dl') === 0) {
                        missing = false;
                    }
                });
            }
        });
    
        if (missing) {
            console.log('Pulling handspiker2/youtube-dl');
            updateImage('handspiker2/youtube-dl:latest', function() {
                console.log('Finished Pull');
                hasImage = true; 
                downloadQueue.forEach((method) => { method() });
                downloadQueue = [];
            });
            
        } else {
            hasImage = true; 
            downloadQueue.forEach((method) => { method() });
            downloadQueue = [];
        }
    });
}

function updateImage(image, callback) {
    let docker = getConnection();

    docker.pull(image, (err, stream) => {
        docker.modem.followProgress(stream, (err, output) => { 
            if (typeof callback === 'function') {
                callback();
            }
        }, () => {});
    });
}

async function downloadVideo(url, source, trigger, includeSubs) {
    let containerName = await getUniqueName();
    const youtubeOptions = ['-f', 'bestvideo+bestaudio/best', '--add-metadata', '--embed-subs', '--merge-output-format', 'mkv', '-c', '--wait-for-video', '10'];

    if (typeof includeSubs === 'undefined' || includeSubs) {
        youtubeOptions.push('--all-subs');
    }

    if (process.env.ALWAYS_MKV > 0) {
        youtubeOptions.push('--remux-video', 'mkv');
    }

    // https://github.com/yt-dlp/yt-dlp/issues/4280
    if (url.indexOf('twitch') !== -1) {
        youtubeOptions.push('--fixup', 'never');
    }

    youtubeOptions.push(url.trim());

    console.log('Creating ' + containerName + ' for ' + trigger);
    getConnection().createContainer({
        Image: 'handspiker2/youtube-dl',
        name: containerName,
        WorkingDir: '/data',
        Cmd: youtubeOptions, // Has to be a string array! 
        HostConfig: {
            AutoRemove: true,
            Binds: [
                downloadPath + ':/data',
            ],
        },
        Labels: {
            'com.spikedhand.video-recorder': 'true'
        }
    }).then(function(container) {
        cache.setCache(containerName, {
            source,
            trigger,
        });

        return container.start();

    }).catch(function(err) {
        console.log(err);
    });
}

function getContainerStatus(callback) {
    let docker = getConnection();

    docker.listContainers({all: 'true', filters: { label: ['com.spikedhand.video-recorder']}}).then((containerInfo) => {
        let newStatus = new Map();
        let cacheCalls = [];

        containerInfo.forEach((container) => {
            let status = {
                id: container.Id,
                state: container.State,
                image: container.Image,
                created: container.Created,
                name: container.Names[0].replace(/^\//, ''),
                status: container.Status,
            }

            if (status.name) {
                cacheCalls[cacheCalls.length] = cache.getCache(status.name).then((cachedStatus) => {
                    if (cachedStatus) {
                        Object.assign(status, cachedStatus);
                    }

                    newStatus.set(status.name, status);
                });
            }
        });

        Promise.all(cacheCalls).then(() => {
            callback({
                count: newStatus.size,
                containers: Object.fromEntries(newStatus.entries()),
            });
        });

    }).catch((error) => {
        console.error(error);
        callback(false);
        return;
    });
}

function updateStatus() {
    if (!mqttClient) {
        return false;
    }

    getContainerStatus((data) => {
        mqttClient.publish(baseTopic + '/status', JSON.stringify(data));
    });
}

let downloadQueue = [];
function downloadTwitch(username) {
    let downloadCall = function() {
        let url =  'https://www.twitch.tv/';

        if (username.match(/^\d{4}\d+$/)) { // If "username" is a long number, it's probably a VOD.
            url += 'videos/';
        }

        url += username;
        downloadVideo(url, 'twitch', username, false);
    };

    if (hasImage) {
        downloadCall();
    } else {
        downloadQueue.push(downloadCall);
    }
}

function downloadYoutube(videoId) {
    let downloadCall = function() {
        let url =  'https://www.youtube.com/watch?v=';
        url += videoId;

        downloadVideo(url, 'youtube', videoId);
    };

    if (hasImage) {
        downloadCall();
    } else {
        downloadQueue.push(downloadCall);
    }
}

ensureImages();

let mqttClient;
let baseTopic = process.env.MQTT_TOPIC || 'video-recorder';
if (process.env.MQTT_BROKER) {
    mqttClient = mqtt.connect(process.env.MQTT_BROKER, {
        will: {
            topic: baseTopic + '/state',
            payload: 'offline',
            qos: 1
        }
    });

    mqttClient.on('connect', () => {
        console.log('Connected to ' + mqttClient.options.host);
        mqttClient.publish(baseTopic + '/state', 'online');
        updateStatus();
        // video-recorder/<service>
        mqttClient.subscribe(baseTopic + '/+');
    });

    mqttClient.on('message', (topic, message) => {
        if (topic.indexOf(baseTopic + '/') === 0) {
            let service = topic.replace(baseTopic + '/', '');

            message = message.toString().trim();

            if (service != 'state' && message) {
                switch (service) {
                    case 'twitch':
                        downloadTwitch(message);
                        break;

                    case 'youtube':
                        downloadYoutube(message);
                        break;

                    case 'url':
                        downloadVideo(message, 'url', message);
                        break;
                }
            }
        }
        
    });
}

const dockerEmitter = new DockerEvents({
    docker: getConnection(),
});

const eventUpdate = (message) => {
    if (message.Type && message.Type === 'container') {
        if ('com.spikedhand.video-recorder' in message.Actor.Attributes) {
            updateStatus();
        }
    }
};

dockerEmitter.start();
dockerEmitter.on('create', eventUpdate);
dockerEmitter.on('start', eventUpdate);
dockerEmitter.on('destroy', eventUpdate);

let lastTick = 0;
const tickInterval = setInterval(() => {
    // minutes
    let time = Math.floor((Date.now() /1000) / 60);

    if (lastTick === time) { // Jobs are scheduled based on minutes but we tick faster
        return;
    }

    lastTick = time;

    if (mqttClient) {
        if (time % 5 == 0) {
            mqttClient.publish(baseTopic + '/state', 'online');
            updateStatus();
        }
    }

    if (time % 60 == 0 && time % (6 * 60) == 0) {
        updateImage('handspiker2/youtube-dl:latest');
    } else if (time % 60 == 0) {
        ensureImages();
    }
}, 20 * 1000) // 20 seconds

function stop() {
    dockerEmitter.stop();
    clearInterval(tickInterval);
    if (mqttClient) {
        mqttClient.publish(baseTopic + '/state', 'offline');
        mqttClient.end()
    }
}

process.on("SIGINT", () => { console.log('Recieved SIGINT'); stop() } );
process.on("SIGTERM", () => { console.log('Recieved SIGTERM'); stop() });