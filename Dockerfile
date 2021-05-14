FROM node:16-alpine
WORKDIR /home/node
COPY package.json package-lock.json /home/node/
RUN npm ci
COPY index.js /home/node/

CMD [ "node", "index.js"]