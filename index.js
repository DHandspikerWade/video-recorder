const downloadPath = process.env.DOWNLOAD_PATH || '/tmp'

const DEFAULT_FORMAT = '%(title)s [%(id)s].%(ext)s'; // Default 
const TWITCH_FORMAT = process.env.TITLE_FORMAT_TWITCH || DEFAULT_FORMAT;
const YOUTUBE_FORMAT = process.env.TITLE_FORMAT_YOUTUBE || DEFAULT_FORMAT;

const shutdownHandlers = [];

async function downloadVideo(client, url, source, trigger, includeSubs, subdirectory) {
    const youtubeOptions = [
        '-f', 'bestvideo+bestaudio/best', 
        '--add-metadata', 
        '--embed-subs', 
        '--merge-output-format', 'mkv', 
        '-c', 
        '--wait-for-video', '60', 
        '--embed-thumbnail',
        '--convert-thumbnails', 'webp>jpg', // WebP is not in-spec for MKV but yt-dlp still tries to mixed results. PNG results in segfault with FFmpeg > 6
    ];

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

    client.fileExists('cookies.txt').then((hasCookie) => {
        if (hasCookie) {
            youtubeOptions.push('--cookies', '/data/cookies.txt');
        }

        console.log('getting metadata for ' + trigger);
        client.getVideoMetadata(url.trim()).then((metadata) => {

            if (metadata._type == 'playlist') { 
                metadata.entries.forEach((entry) => {
                    downloadVideo(client, entry.url, source, trigger, includeSubs, subdirectory);
                });
                return;
            }

            console.log('Creating downloader for ' + trigger + (hasCookie ? ' (with cookies)' : ''));

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

            client.downloadVideo(url.trim(), source, trigger, youtubeOptions, subdirectory, isLive);
        });
    });
}

function downloadTwitch(client, username, directory) {
    let url =  'https://www.twitch.tv/';

    if (username.match(/^\d{4}\d+$/)) { // If "username" is a long number, it's probably a VOD.
        url += 'videos/';
    }

    url += username;
    downloadVideo(client, url, 'twitch', username, false, directory);
}

function downloadYoutube(client, videoId, directory) {
    let url =  'https://www.youtube.com/watch?v=';
    url += videoId;

    downloadVideo(client, url, 'youtube', videoId, true, directory);
}

function handleService(client, serviceName, message, directory) {
    directory = directory || '';

    if (serviceName && message) {
        switch (serviceName) {
            case 'twitch':
                downloadTwitch(client, message, directory);
                return true;

            case 'youtube':
                downloadYoutube(client, message, directory);
                return true;

            case 'url':
                downloadVideo(client, message, 'url', message, true, directory);
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

                console.log(`Creating directory "${newDirectory}"`);
                client.createDirectory(newDirectory).then(() => {
                    parts.shift();
                    let newService = parts.join('/');
                    handleService(client, newService, message, newDirectory);
                });

                return true;
            }
        }
    }

    return false;
}

function createInterval(callback, seconds) {
    // Abstract interval to handle shutdown events

    let id = setInterval(callback, seconds * 1e3);
    onShutdown(() => {
        console.log('stopping ' + id);
        clearInterval(id);
    })
}

function onShutdown(callback) {
    shutdownHandlers.push(callback);
}

function setupBroker(client, connectionStr, baseTopic) {
    const mqtt = require('mqtt');

    let mqttClient;
    const alreadyRequested = new Set();

    mqttClient = mqtt.connect(connectionStr, {
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
                if (message && service !== 'status') {
                    (new Set(message.split("\n"))).forEach((item) => {
                        if (item.trim()) {
                            handleService(client, service, item);
                        }
                    });
                }
            }
        } 
    });

    client.onUpdate((downloads) => {
        const data = {
            count: downloads.size,
            // Keep "containers" key for backwards support
            containers: Object.fromEntries(downloads)
        };

        mqttClient.publish(baseTopic + '/status', JSON.stringify(data));
    });

    // Clear the last minute of requests
    createInterval(() => alreadyRequested.clear(), 80);
    // Announce life every 5 minutes
    createInterval(() => mqttClient.publish(baseTopic + '/state', 'online'), 5 * 60);

    onShutdown(() => {
        mqttClient.publish(baseTopic + '/state', 'offline');
        mqttClient.end();
    });

    return mqttClient;
}

function setupClient() {
    let client;

    // TODO check for docker
    client = require('./kube-api');

    if (client) {
        // garbageCollect every 30 minutes
        createInterval(() => client.garbageCollect(), 30 * 60);
    }

    return client;
}

function start() {
    let client = setupClient();

    if (!client) {
        console.error('Could not create a client');
        process.exit(1);
    }

    if (process.env.MQTT_BROKER) {
        let baseTopic = process.env.MQTT_TOPIC || 'video-recorder';
        setupBroker(client, process.env.MQTT_BROKER, baseTopic);
    }

    process.on("SIGINT", () => { console.log('Recieved SIGINT'); stop(client) } );
    process.on("SIGTERM", () => { console.log('Recieved SIGTERM'); stop(client) });
}

function stop(client) {
    console.log('Shutting down...')
    // dockerEmitter.stop();

    for (const index in shutdownHandlers) {
        shutdownHandlers[index]();
    }

    if (client) {
        client.disconnect();
    }
}

start();
