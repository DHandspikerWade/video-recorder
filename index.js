const express = require('express');
const Docker = require('dockerode');
const mqtt = require('mqtt')
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
            docker.pull('handspiker2/youtube-dl:latest', (err, stream) => {
                docker.modem.followProgress(stream, (err, output) => { 
                    console.log('Finished Pull');
                    hasImage = true; 
                    downloadQueue.forEach((method) => { method() });
                    downloadQueue = [];
                }, () => {});
            });
        } else {
            hasImage = true; 
            downloadQueue.forEach((method) => { method() });
            downloadQueue = [];
        }
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

        console.log('Creating container for ' + username);
        getConnection().createContainer({
            Image: 'handspiker2/youtube-dl',
            name: 'twitch_' + getUniqueId(),
            WorkingDir: '/data',
            Cmd: ['-f', 'best', '--add-metadata', '--embed-subs', '--all-subs', '--merge-output-format', 'mkv', '-c', url],
            HostConfig: {
                AutoRemove: true,
                Binds: [
                    downloadPath + ':/data',
                ],
            }
        }).then(function(container) {
            return container.start();
        }).catch(function(err) {
            console.log(err);
        });
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

        console.log('Creating container for ' + videoId);
        getConnection().createContainer({
            Image: 'handspiker2/youtube-dl',
            name: 'youtube_' + getUniqueId(),
            WorkingDir: '/data',
            Cmd: ['-f', 'best', '--add-metadata', '--embed-subs', '--all-subs', '--merge-output-format', 'mkv', '-c', url],
            HostConfig: {
                AutoRemove: true,
                Binds: [
                    downloadPath + ':/data',
                ],
            }
        }).then(function(container) {
            return container.start();
        }).catch(function(err) {
            console.log(err);
        });
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

            if (service != 'state') {
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

function stop() {
    server.close();
    if (mqttClient) {
        mqttClient.publish(baseTopic + '/state', 'offline');
        mqttClient.end()
    }
}

process.on("SIGINT", () => { console.log('Recieved SIGINT'); stop() } );
process.on("SIGTERM", () => { console.log('Recieved SIGTERM'); stop() });