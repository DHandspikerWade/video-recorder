FROM node:16-alpine
WORKDIR /home/node
COPY package.json package-lock.json /home/node/
RUN npm ci
COPY index.js /home/node/

ENV MQTT_BROKER ''
ENV MQTT_TOPIC ''
ENV DOWNLOAD_PATH '/tmp'
# Set to '1' to force single stream files to output as MKV (Useful as MKV stores more metadata than mp4)
ENV ALWAYS_MKV '0'

CMD [ "node", "index.js"]