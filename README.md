[![Build Status](https://ci.spikedhand.com/api/badges/5/status.svg)](https://ci.spikedhand.com/repos/5)

Quick and dirty way to trigger a Twitch recording by spawning a Docker container that handles the download. I use it to record live streams that are too late for me watch live without chunks of audio removed.

**This is completely unsecured and talks directly to the Docker socket. As a result is this is INCREDIBLY UNSAFE. Only use on trusted networks and NEVER expose it publicly. Don't blame me if your machine gets turned into a botnet**

## Environment Variables

| Name | Required? | Purpose | 
| --- | --- | --- |
| MQTT_BROKER | Required | Connection string to connect to MQTT to accept commands. Should start with `mqtt://`|
| MQTT_TOPIC | Optional | Topic prefix to listen for commands. Defaults to `video-recorder`. | 
| DOWNLOAD_PATH | Optional (Recommended) | Host path to map container downloads to. Must be an absolute path or the name of a pre-existing docker volume. Defaults to `/tmp` |
| REDIS_CONNECTION | Optional | Connection string to connect to Redis to perserve metadata on in-progress downloads across container restarts. Needed if running multiple recorder on same host to prevent container name conflicts. Should start with `redis://` |
| ALWAYS_MKV | Optional | Enables post-processing to remux video into a MKV container regardless of recieved container. Expects `1` or `0`. Defaults to `0` |

## Topics exposed:

| Topic | Purpose | Accepted Messages |
| --- | --- | --- |
| {BASE_MQTT_TOPIC}/twitch | Record/Download Twitch streams | Twitch username or VOD ID| 
| {BASE_MQTT_TOPIC}/youtube | Download single youtube video. Includes subtitles. Will wait for a stream to start. | Youtube video ID|
| {BASE_MQTT_TOPIC}/url | One-off downloads of video for offline use | Any service URL [supported](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md) by YT-DLP |
| {BASE_MQTT_TOPIC}/directory/{custom_directory}/{service} | Can be chained with other commands to create subdirectories of DOWNLOAD_PATH. Good for organization and can also chain itself | Depends on chained service| 

## Example Docker compose

```
version: "3"
services:
  recorder:
    environment:
      MQTT_BROKER: 'mqtt://mqtt.example.com'
      MQTT_TOPIC: 'internet-dvr'
      DOWNLOAD_PATH: /home/Devin/Downloads
      REDIS_CONNECTION: redis://redis.example.com:6379
    volumes:
      - '/var/run/docker.sock:/var/run/docker.sock'
```