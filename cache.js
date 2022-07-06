const { createClient } = require('redis');

module.exports = function (connectionStr) {
    if (connectionStr && connectionStr.indexOf('redis://') === 0) {
        const PREFIX = 'video-recorder:';
        let client = createClient({
            url: connectionStr
        });

        client.on('error', (err) => console.log('Redis error', err));
        client.connect();

        process.on("SIGINT", () => { client.quit() } );
        process.on("SIGTERM", () =>{ client.quit() } );

        return {
            getCache: async function(key) {
                let value = await client.get(PREFIX + key);

                if (value == 'nil') {
                    return null;
                }

                client.expire(PREFIX + key, 60 * 60 * 3, 'GT'); // refresh it
                return value ? JSON.parse(value) : null;
            },
            setCache: async function(key, value) {
                // Assume after 24 hours nothing is using it
                return await client.setEx(PREFIX + key, 60 * 60 * 3, JSON.stringify(value));
            },

            has: async function(key) {
                let has = await client.exists(PREFIX + key);
                return has > 0;
            },
        }
    } else {
        const memory = new Map();
        return {
            getCache: (key) => Promise.resolve(memory.get(key) || null),
            setCache: (key, value) => Promise.resolve(memory.set(key, value) && true),
            has: (key) => Promise.resolve(memory.has(key)),
        }
    }
};