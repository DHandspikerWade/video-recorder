const k8s = require('@kubernetes/client-node');

const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const k8sContext = kc.getContextObject(kc.getCurrentContext());
const k8sCoreApi = kc.makeApiClient(k8s.CoreV1Api);
const k8sBatchApi = kc.makeApiClient(k8s.BatchV1Api);

const watcher = new k8s.Watch(kc);

const internalWaiting = new Map();
const statusCallbacks = new Set();

const NAMESPACE = k8sContext.namespace || 'default';
const CONTAINER_IMAGE = 'handspiker2/youtube-dl';
const PVC_NAME = 'recorded-video-pvc'; // TODO: Make a parameter or config option
const PRIORITY_CLASS_HIGH = 'realtime'; // TODO: Make a parameter or config option
const PRIORITY_CLASS_LOW = 'whenever-you-get-chance'; // TODO: Make a parameter or config option
const PRIORITY_CLASS_METADATA = PRIORITY_CLASS_LOW; // TODO: Make a parameter or config option

const TASK_TYPE_DOWNLOAD = 'download';

const DEFAULT_RESOURCE_LIMITS = {
    requests: {
        cpu: "300m",
        memory: "512Mi",
        'ephemeral-storage': "1Gi"
    },
    limits: {
        cpu: "2",
        memory: "2Gi",
    }
};

function addInternalWaiter(uid, type, callback) {
    if (!internalWaiting.has(uid)) {
        internalWaiting.set(uid, {});
    }

    if (type == 'DELETED') {
        console.warn('[warn] "DELETED" event handler is undefined behavior due to scheduler. Job object might not exist at runtime.');
    }

    // make every event type an array if I ever need multiple. 
    let handler = internalWaiting.get(uid);
    if (!(type in handler)) {
        handler[type] = [];
    }

    handler[type].push(callback);
}

function addObjectMetadata(object, parameters) {
    object.metadata.annotations = object.metadata.annotations || {};
    object.metadata.labels = object.metadata.labels || {};

    if (!object.metadata.annotations['video-recorder.spikedhand.com/ttl']) {
        // Default to 100 hours. It something is still actually running after 100 hours, something has likely gone very wrong
        object.metadata.annotations['video-recorder.spikedhand.com/ttl'] = (60 * 60 * 100) + ''; 
    }

    if (parameters) {
        if (parameters.url) {
            object.metadata.annotations['video-recorder.spikedhand.com/url'] = parameters.url;
        }

        if (parameters.sourceType) {
            object.metadata.annotations['video-recorder.spikedhand.com/source-type'] = parameters.sourceType;
        }
        if (parameters.trigger) {
            object.metadata.annotations['video-recorder.spikedhand.com/trigger'] = parameters.trigger;
        }

        if (parameters.taskType) {
            object.metadata.annotations['video-recorder.spikedhand.com/type'] = parameters.taskType;
        }

        if (parameters.taskType) {
            object.metadata.labels['video-recorder.spikedhand.com/type'] = parameters.taskType;
        }
    }

}

async function getLogs(job) {
    const listResponse = await k8sCoreApi.listNamespacedPod(
        job.metadata.namespace, 
        'false', 
        null, 
        null, 
        null, 
        'batch.kubernetes.io/controller-uid=' + job.metadata.uid,
        5
    );

    if (listResponse.body.items.length > 0) {
        const pod = listResponse.body.items.pop();
        const response = await k8sCoreApi.readNamespacedPodLog(pod.metadata.name, pod.metadata.namespace, 'task', false, undefined, undefined, undefined, undefined, undefined, 50000);


        // The k8s library seems to be automatically converting JSON into objects without clear way to disable it. I want strings for consistentcy 
        if (typeof response.body !== 'string') {
            return JSON.stringify(response.body);
        }

        return response.body;
    }

    return '';
}

function getStatusFromJob(job) {
    let status = false;
    if (job.status.conditions) {
        for (let i = 0; i < job.status.conditions.length; i++) {
            const conditionType = job.status.conditions[i].type;
            
            if (conditionType === 'Failed' || conditionType === 'Complete') {
                status = conditionType;
                break;
            }
        }
    }

    return status;
}

function runCommand(command, options, priority, workingDir, metadata, prefix, backoffLimit) {
    const newJob = {
        metadata: {
            generateName: prefix || 'asynctask-',
            labels: {
                'video-recorder.spikedhand.com/type': 'task',
            }
        },
        spec: {
            completions: 1,
            parallelism: 1,
            backoffLimit: backoffLimit || 5,
            template:{
                spec: {
                    restartPolicy: 'Never',
                    volumes: [
                        {
                            name: 'workspace',
                            persistentVolumeClaim: {
                                claimName: PVC_NAME
                            }
                        }
                    ],
                    containers: [
                        {
                            name: 'task',
                            image: CONTAINER_IMAGE,
                            resources: DEFAULT_RESOURCE_LIMITS,
                            imagePullPolicy: 'IfNotPresent',
                            workingDir: '/data/' + (workingDir || ''),
                            command: [command],
                            args: options,
                            volumeMounts: [
                                {
                                    name: "workspace",
                                    mountPath: '/data'
                                }
                            ]
                        }
                    ]
                }
            }
        }
    };

    if (priority) {
        newJob.spec.template.spec.priorityClassName = priority;
    }

    addObjectMetadata(newJob, metadata);

    return new Promise((resolve, reject) => {
        k8sBatchApi.createNamespacedJob(NAMESPACE, newJob).then((response) => {
            let wait = (job, phase) => {
                const status = getStatusFromJob(job);
                if (status) {
                    getLogs(job).then((output) => {
                        removeJob(job.metadata.name);
                        (status === 'Complete' ? resolve : reject)(output);
                    });
                }
            };

            addInternalWaiter(response.body.metadata.uid, 'MODIFIED', wait);

        }).catch(function (ex) {
            console.error("Caught exception: ");
            console.error(ex.message);
        });
    });
}

/**
 * @returns Map<string, object>
 */
async function getAllDownloads() {
    let downloads = new Map();
    let response = await k8sBatchApi.listNamespacedJob(NAMESPACE, undefined, false, undefined, undefined, 'video-recorder.spikedhand.com/type')
    if (response.body.items) {
        response.body.items.forEach((job) => {
            if (job.metadata.labels['video-recorder.spikedhand.com/type'] !== TASK_TYPE_DOWNLOAD) {
                return;
            }

            let state = 'unknown';
            if (job.status.active > 0) {
                state = 'running';
            } else if (job.status.succeeded > 0) {
                state = 'complete';
            } else if (job.status.failed > 0) {
                state = 'failed';
            }
            let data = {
                "id": job.metadata.uid,
                "state": state,
                "image": job.spec.template.spec.containers.length ? job.spec.template.spec.containers[0].image : null,
                "created": Math.floor(Date.parse(job.metadata.creationTimestamp) / 1000),
                "name": job.metadata.name,
                "source": job.metadata.annotations['video-recorder.spikedhand.com/source-type'],
                "trigger": job.metadata.annotations['video-recorder.spikedhand.com/trigger']
            };

            downloads.set(data.name, data);
        });
    }

    return downloads;
}

function statusUpdate() {
    getAllDownloads().then((downloads) => {
        statusCallbacks.forEach((handler) => handler(downloads));
    });
}

async function removeJob(name) {
    // kubectl adds a policy to delete pods orphaned by jobs. API doesn't do anything by default.
    // Background because, don't really care when clean-up happens. 
    const propagationPolicy = 'Background';
    k8sBatchApi.deleteNamespacedJob(name, NAMESPACE, 'false', undefined, undefined, undefined, propagationPolicy);
}

async function startListening() {
    const req = watcher.watch(`/apis/batch/v1/namespaces/${NAMESPACE}/jobs`, {"labelSelector": "video-recorder.spikedhand.com/type"}, function(status, job, event) {
        if (job.metadata.uid && internalWaiting.has(job.metadata.uid)) {
            let handler = internalWaiting.get(job.metadata.uid);
            if (status in handler) {
                handler[status].forEach((callback) => { callback(job, status); });
            }
        }
        
        switch(status) {
            case "DELETED":
                if (job.metadata.uid && internalWaiting.has(job.metadata.uid)) {
                    // GC handlers once a job is deleted
                    internalWaiting.delete(job.metadata.uid);
                }

                // no break

            case "MODIFIED":
            case "ADDED":
                if (job.metadata.labels['video-recorder.spikedhand.com/type'] == TASK_TYPE_DOWNLOAD) {
                    statusUpdate();

                    // TODO: does this need to be rate-limited?

                    // updateTimeoutId = setTimeout(() => {
                    //     updateTimeoutId = null;
                    // }, 1000);
                }

                break;
            default:
                // unknown event
                // console.log(arguments);
                break;
        }
    
    }, (err) => { 
        throw err;
    });
}

startListening();


// END TODO

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
            await runCommand('yt-dlp', options, (isLive ? PRIORITY_CLASS_HIGH : PRIORITY_CLASS_LOW), outputDirectory, metadata,  'download-');
            statusUpdate();
        } catch (e) {
            console.error(e);
            return 
        }
    },
    getVideoMetadata: async function(url) {
        try {
            let output = await runCommand('yt-dlp', ['-q', '--no-warnings', '-J', url], PRIORITY_CLASS_METADATA);
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
            await runCommand('test', ['-f', file], null, null, {}, 'file-check', 1);
            return true;
        } catch (e) {
            return false;
        }
    },
    /**
     * @param callable
     */
    onUpdate: function(callback) {
        statusCallbacks.add(callback);
    },
    garbageCollect: async function () {
        let response = await k8sBatchApi.listNamespacedJob(NAMESPACE, undefined, false, undefined, undefined, 'video-recorder.spikedhand.com/type')
        if (response.body.items) {
            response.body.items.forEach((job) => {
                let ttl; 
                if (!('video-recorder.spikedhand.com/ttl' in job.metadata.annotations)) {
                    // Assume a day if some bug creates a job without a ttl
                    ttl = 24 * 60 * 60;
                } else {
                    ttl = job.metadata.annotations['video-recorder.spikedhand.com/ttl'];
                }

                let clean = false;

                if ((Date.parse(job.metadata.creationTimestamp) + (ttl * 1000)) < Date.now()) {
                    clean = true;
                }

                if (!internalWaiting.has(job.metadata.uid) && getStatusFromJob(job)) {
                    // Job with a complete status but no handlers was abandoned by a past instance.
                    clean = true;
                }

                if (clean) {
                    removeJob(job.metadata.name);
                }
            });
        }
    },
    disconnect: async function() {
        // No action. 

        // temp
        clearInterval(intervalId);
    }
};
