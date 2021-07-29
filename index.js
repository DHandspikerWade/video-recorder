const express = require('express');
const Docker = require('dockerode');
const mqtt = require('mqtt');
const app = express();
const port = 3000;

// Counter to keep each container name unique
let uniqueId = Math.floor(Math.random() * 10000);

const downloadPath = process.env.DOWNLOAD_PATH || '/tmp'

function getUniqueId() {
    return ++uniqueId;
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

let containerDetails = {};
function downloadVideo(url, source, trigger, includeSubs) {
    let containerName = 'downloader_' + getUniqueId();
    const youtubeOptions = ['-f', 'best', '--add-metadata', '--embed-subs', '--merge-output-format', 'mkv', '-c',];

    if (typeof includeSubs === 'undefined' || includeSubs) {
        youtubeOptions.push('--all-subs');
    }

    youtubeOptions.push(url);

    console.log('Creating ' + containerName + ' for ' + trigger);
    getConnection().createContainer({
        Image: 'handspiker2/youtube-dl',
        name: containerName,
        WorkingDir: '/data',
        Cmd: youtubeOptions,
        HostConfig: {
            AutoRemove: true,
            Binds: [
                downloadPath + ':/data',
            ],
        }
    }).then(function(container) {
        containerDetails[containerName] = {
            source,
            trigger,
        };
        return container.start();

    }).catch(function(err) {
        console.log(err);
    });
}

function getContainerStatus(callback) {
    let docker = getConnection();

    docker.listContainers({all: 'true', filters: { name: ['downloader']}}).then((containerInfo) => {
        let newStatus = {};

        containerInfo.forEach((container) => {
            let status = {
                id: container.Id,
                state: container.State,
                image: container.Image,
                created: container.Created,
                name: container.Names[0].replace(/^\//, ''),
                status: container.Status,
            }

            if (status.name.match(/^downloader\_\d+$/)) {
                if (containerDetails[status.name]) {
                    Object.assign(status, containerDetails[status.name]);
                }

                newStatus[status.name] = status;
            }
        });

        for (const detail in containerDetails) {
            if (!(detail in newStatus)) {
                delete containerDetails[detail];
            }
        }

        if (callback) {
            callback({
                count: Object.keys(newStatus).length,
                containers: newStatus
            });
            // callback.apply(null, newStatus);
        }


    }).catch((error) => {
        console.error(error);
        callback(false);
        return;
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

app.get('/', (req, res) => {
    res.send('Hello!');
});

app.post('/twitch/:username', (req, res) => {
    if (req.params.username && req.params.username !== 'null') {
        downloadTwitch(req.params.username);
    }
    res.send('Got it!');
});

app.post('/youtube/:videoID', (req, res) => {
    if (req.params.videoID && req.params.videoID !== 'null') {
        downloadYoutube(req.params.videoID);
    }
    res.send('Got it!');
});

const server = app.listen(port, () => {
    console.log(`Server listening on ${port}`);
});
server.timeout = 4000;

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
        // video-recorder/<service>
        mqttClient.subscribe(baseTopic + '/+');
        mqttClient.publish(baseTopic + '/state', 'online')
    });

    mqttClient.on('message', (topic, message) => {
        if (topic.indexOf(baseTopic + '/') === 0) {
            let service = topic.replace(baseTopic + '/', '');

            message = message.toString();

            if (service != 'state' && message) {
                switch (service) {
                    case 'twitch':
                        downloadTwitch(message);
                        break;

                    case 'youtube':
                        downloadYoutube(message);
                        break;

                }
            }
        }
        
    });
}

let lastTick = 0;
const tickInterval = setInterval(() => {
    // minutes
    let time = Math.floor((Date.now() /1000) / 60);

    if (mqttClient) {
        getContainerStatus((data) => {
            mqttClient.publish(baseTopic + '/state', 'online');
            mqttClient.publish(baseTopic + '/status', JSON.stringify(data));
        });
    }

    if (lastTick === time) { // Jobs are scheduled based on minutes but we tick faster for status updates
        return;
    }

    lastTick = time;

    if (mqttClient) {
        if (time % 5 == 0) {
            mqttClient.publish(baseTopic + '/state', 'online');
        }
    }

    if (time % 60 == 0 && time % (6 * 60) == 0) {
        updateImage('handspiker2/youtube-dl:latest');
    } else if (time % 60 == 0) {
        ensureImages();
    }
}, 20 * 1000) // 20 seconds

function stop() {
    clearInterval(tickInterval);
    server.close();
    if (mqttClient) {
        mqttClient.publish(baseTopic + '/state', 'offline');
        mqttClient.end()
    }
}

process.on("SIGINT", () => { console.log('Recieved SIGINT'); stop() } );
process.on("SIGTERM", () => { console.log('Recieved SIGTERM'); stop() });