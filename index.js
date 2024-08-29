// const Docker = require('dockerode');
// const DockerEvents = require('docker-events');
const mqtt = require('mqtt');
// const cache = require('./cache')(process.env.REDIS_CONNECTION || '');
const kubeClient = require('./kube-api');

const downloadPath = process.env.DOWNLOAD_PATH || '/tmp'

const DEFAULT_FORMAT = '%(title)s [%(id)s].%(ext)s'; // Default 
const TWITCH_FORMAT = process.env.TITLE_FORMAT_TWITCH || DEFAULT_FORMAT;
const YOUTUBE_FORMAT = process.env.TITLE_FORMAT_YOUTUBE || DEFAULT_FORMAT;

function checkCookieFileExists() {
    return kubeClient.fileExists('cookies.txt');
}

async function downloadVideo(url, source, trigger, includeSubs, subdirectory) {
    const youtubeOptions = ['-f', 'bestvideo+bestaudio/best', '--add-metadata', '--embed-subs', '--merge-output-format', 'mkv', '-c', '--wait-for-video', '60', '--embed-thumbnail'];

    subdirectory = subdirectory || '';

    if (typeof includeSubs === 'undefined' || includeSubs) {
        youtubeOptions.push('--all-subs');
    }

    if (process.env.ALWAYS_MKV > 0) {
        youtubeOptions.push('--remux-video', 'mkv');
    }

    if (process.env.SAVE_MTIME > 0) {
        youtubeOptions.push('--mtime');
    } else {
        youtubeOptions.push('--no-mtime');
    }

    checkCookieFileExists().then((hasCookie) => {
        if (hasCookie) {
            youtubeOptions.push('--cookies', '/data/cookies.txt');
        }

        console.log('getting metadata for ' + trigger);
        kubeClient.getVideoMetadata(url.trim()).then((metadata) => {
            // youtubeOptions.push(url.trim());
            console.log('Creating  downloader  for ' + trigger + (hasCookie ? ' (with cookies)' : ''));

            let isLive = false;
            if (metadata && metadata.is_live && metadata.is_live != 'was_live') {
                isLive = true;
            }

            let ignoreChat = false;
            if (url.indexOf('twitch') !== -1) {
                // https://github.com/yt-dlp/yt-dlp/issues/4280
                youtubeOptions.push('--fixup', 'never');

                // https://github.com/yt-dlp/yt-dlp/issues/5747
                ignoreChat = true;
            }

            if (source == 'youtube') {
                youtubeOptions.push('-o', YOUTUBE_FORMAT);
            } else if (source == 'twitch') {
                youtubeOptions.push('-o', TWITCH_FORMAT);
            } else {
                youtubeOptions.push('-o', DEFAULT_FORMAT);
            }

            if (url.indexOf('youtube') !== -1 && isLive) {
                // TODO: Youtube live chat and saving video is no longer parallel action causing video to be missed by waiting until chat is done before downloading video
                // Hotfix
                ignoreChat = true;
            }

            if (ignoreChat) {
                ['--all-subs', '--embed-subs'].forEach(function (option) {
                    let index = youtubeOptions.indexOf(option);
                    if (index !== -1) {
                        youtubeOptions.splice(index, 1);
                    }
                });
            }

            kubeClient.downloadVideo(url.trim(), source, trigger, youtubeOptions, subdirectory, isLive);
        });
    });
}

function downloadTwitch(username, directory) {

    let url =  'https://www.twitch.tv/';

    if (username.match(/^\d{4}\d+$/)) { // If "username" is a long number, it's probably a VOD.
        url += 'videos/';
    }

    url += username;
    downloadVideo(url, 'twitch', username, false, directory);

}

function downloadYoutube(videoId, directory) {
    let url =  'https://www.youtube.com/watch?v=';
    url += videoId;

    downloadVideo(url, 'youtube', videoId, true, directory);
}

function handleService(serviceName, message, directory) {
    directory = directory || '';

    if (serviceName && message) {
        switch (serviceName) {
            case 'twitch':
                downloadTwitch(message, directory);
                return true;

            case 'youtube':
                downloadYoutube(message, directory);
                return true;

            case 'url':
                downloadVideo(message, 'url', message, true, directory);
                return true;
        }

        
        if (serviceName.indexOf('directory/') === 0) {
            let parts = serviceName.substring(10).split('/');

            if (parts.length > 1) {
                let newDirectory = directory;
                if (newDirectory) {
                    newDirectory += '/';
                }

                newDirectory += parts[0];

                kubeClient.createDirectory(newDirectory).then(() => {
                    parts.shift();
                    let newService = parts.join('/');
                    handleService(newService, message, newDirectory);
                });

                return true;
            }
        }
    }

    return false;
} 

let mqttClient;
const alreadyRequested = new Set();
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

        // video-recorder/<service>
        mqttClient.subscribe(baseTopic + '/#');
        // mqttClient.subscribe(baseTopic + '/directory/+/url');
    });

    mqttClient.on('message', (topic, message) => {
        if (topic.indexOf(baseTopic + '/') === 0) {
            // MQTT can repeat message when sent as QoS 0, we don't need to process every duplicate
            if (!alreadyRequested.has(topic + message)) {
                alreadyRequested.add(topic + message);

                let service = topic.replace(baseTopic + '/', '');

                message = message.toString().trim();
                if (service !== 'status') {
                    handleService(service, message);
                }
            }
        } 
    });

    kubeClient.onUpdate((downloads) => {
        const data = {
            count: downloads.size,
            // Keep "containers" key for backwards support
            containers: Object.fromEntries(downloads)
        };

        mqttClient.publish(baseTopic + '/status', JSON.stringify(data));

    });
}

let lastTick = 0;
const tickInterval = setInterval(() => {
    // minutes
    let time = Math.floor((Date.now() /1000) / 60);

    if (lastTick === time) { // Jobs are scheduled based on minutes but we tick faster
        return;
    }

    lastTick = time;

    // Clear the flast minute of requests
    alreadyRequested.clear();

    if (mqttClient) {
        if (time % 5 == 0) {
            mqttClient.publish(baseTopic + '/state', 'online');
        }
    }

    if (time % 30) {
        kubeClient.garbageCollect();
    }

}, 20 * 1000) // 20 seconds

function stop() {
    console.log('Shutting down...')
    // dockerEmitter.stop();
    clearInterval(tickInterval);
    if (mqttClient) {
        mqttClient.publish(baseTopic + '/state', 'offline');
        mqttClient.end()
    }

    kubeClient.disconnect();
}

process.on("SIGINT", () => { console.log('Recieved SIGINT'); stop() } );
process.on("SIGTERM", () => { console.log('Recieved SIGTERM'); stop() });