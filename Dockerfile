FROM node:22-alpine

LABEL org.opencontainers.image.source="https://github.com/DHandspikerWade/video-recorder"
LABEL org.opencontainers.image.title="Video Recorder"
LABEL org.opencontainers.image.description="Easy way to record live streams"

WORKDIR /home/node
COPY package.json package-lock.json /home/node/
RUN npm ci
COPY *.js /home/node/

ENV MQTT_BROKER ''
ENV MQTT_TOPIC ''
# Optional. Only preserves trigger details across restarts
ENV REDIS_CONNECTION ''
ENV DOWNLOAD_PATH '/tmp'
# Set to '1' to force single stream files to output as MKV (Useful as MKV stores more metadata than mp4)
ENV ALWAYS_MKV '0'
ENV SAVE_MTIME '1'

ENV UMASK ''
ENV TITLE_FORMAT_YOUTUBE ''
ENV TITLE_FORMAT_TWITCH ''

CMD [ "node", "index.js"]