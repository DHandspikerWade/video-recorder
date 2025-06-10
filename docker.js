const Docker = require('dockerode');
const DockerEvents = require('docker-events');

function getConnection() {
    return new Docker({ socketPath: '/var/run/docker.sock' });
}

async function runCommand(command, options, workingDir, metadata) {
    const labels = {
        'com.spikedhand.video-recorder': 'true'
    };

    if (metadata) {
        if (metadata.ttl) {
            labels['video-recorder.spikedhand.com/ttl'] = metadata.ttl + ''; 
        }
        if (metadata.url) {
            labels['video-recorder.spikedhand.com/url'] = metadata.url;
        }

        if (metadata.sourceType) {
            labels['video-recorder.spikedhand.com/source-type'] = metadata.sourceType;
        }
        if (metadata.trigger) {
            labels['video-recorder.spikedhand.com/trigger'] = metadata.trigger;
        }

        if (metadata.taskType) {
            labels['video-recorder.spikedhand.com/type'] = metadata.taskType;
        }
    }

    if (!labels['video-recorder.spikedhand.com/ttl']) {
        labels['video-recorder.spikedhand.com/ttl'] = (60 * 60 * 100) + ''; 
    }

    getConnection().createContainer({
        Image: 'handspiker2/youtube-dl',
        WorkingDir: '/data/' + (workingDir || ''),
        Cmd: youtubeOptions,

        /* TODO:
            Support UMASK
            User and group
            Variable image
        */
        HostConfig: {
            AutoRemove: true,
            Binds: [
                downloadPath + ':/data',
            ],
        },
        Labels: labels
    }).then(function(container) {
        return container.start();

    }).catch(function(err) {
        console.log(err);
    });

    // TODO Return command logs as promise
}

const dockerEmitter = new DockerEvents({
    docker: getConnection(),
});

dockerEmitter.start();
dockerEmitter.on('create', eventUpdate);
dockerEmitter.on('start', eventUpdate);
dockerEmitter.on('destroy', eventUpdate);


module.exports = {
    downloadVideo: async function(url,  source, trigger, ytOptions, outputDirectory, isLive) {
        let options = ytOptions || [];
        options.push(url);

        const metadata = {
            url,
            taskType: TASK_TYPE_DOWNLOAD,
            sourceType: source,
            trigger
        };

        try {
            await runCommand('yt-dlp', options, outputDirectory, metadata);
            statusUpdate();
        } catch (e) {
            console.error(e);
            return 
        }
    },
    getVideoMetadata: async function(url) {
        try {
            let output = await runCommand('yt-dlp', ['-q', '--no-warnings', '--flat-playlist', '--wait-for-video', '10', '-J', url]);
            return JSON.parse(output);
        } catch (e) {
            console.error(e);
            return null;
        }
    },
    createDirectory: async function(directory) {
        try {
            await runCommand('mkdir', ['-p', directory]);
            return true;
        } catch (e) {
            console.error(e);
            return false;
        }
    },

    fileExists: async function(file) {
        try {
            await runCommand('test', ['-f', file]);
            return true;
        } catch (e) {
            return false;
        }
    },
    /**
     * @param callable
     */
    onUpdate: function(callback) {
        // TODO

        // statusCallbacks.add(callback);
    },
    garbageCollect: async function () {
        // TODO
    },
    disconnect: async function() {
        dockerEmitter.stop();
    }
};
