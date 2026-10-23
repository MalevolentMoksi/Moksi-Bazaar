// src/commands/tools/randomyt.js

const { SlashCommandBuilder } = require('discord.js');
const { io } = require('socket.io-client');
const logger = require('../../utils/logger');

// Establish persistent connection when module is loaded. Astronaut.io runs
// Socket.IO 4, which refuses the v2 client outright, so the major versions
// must match. Reconnection is unlimited: a site that is briefly down should
// not leave the command dead until the next deploy.
const sock = io('http://astronaut.io', {
  path: '/socket.io',
  transports: ['websocket'],
  reconnectionDelay: 3000,
  reconnectionDelayMax: 60_000,
});


let currentVideo = null;
// One line per outage, not one stack trace per retry.
let failing = false;

// Astronaut.io emits random "video" events with { video: { id: "YOUTUBE_ID", ... } }
sock.on('connect', () => {
  failing = false;
  logger.info('[randomyt] Connected to Astronaut.io');
});
sock.on('video', pkt => {
  // Robustly grab ID from nested payload
  if (pkt && pkt.video && pkt.video.id) {
    currentVideo = `https://youtu.be/${pkt.video.id}`;
  } else {
    currentVideo = null;
  }
});


sock.on('connect_error', err => {
  if (failing) return;
  failing = true;
  logger.warn('[randomyt] Astronaut.io unreachable, retrying quietly', { error: err.message });
});
sock.on('disconnect', reason => logger.warn('[randomyt] Disconnected from Astronaut.io', { reason }));

// Export as a standard command for your bot
module.exports = {
  data: new SlashCommandBuilder()
    .setName('randomyt')
    .setDescription('Get a YouTube video with (almost) zero views, via Astronaut.io!'),
    async execute(interaction) {
    if (currentVideo) {
        await interaction.reply(currentVideo);
    } else {
        await interaction.reply('Still connecting or no video received... try again in a few seconds!');
    }
  },
};
