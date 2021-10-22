FROM node:16-alpine
WORKDIR /home/node
COPY package.json package-lock.json /home/node/
RUN npm ci
COPY index.js /home/node/

ENV MQTT_BROKER ''
ENV MQTT_TOPIC ''
ENV DOWNLOAD_PATH '/tmp'

CMD [ "node", "index.js"]