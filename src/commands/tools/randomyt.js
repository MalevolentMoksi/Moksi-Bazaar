// src/commands/tools/randomyt.js

const { SlashCommandBuilder } = require('discord.js');
const { io } = require('socket.io-client');

// Establish persistent connection when module is loaded
const sock = io('http://astronaut.io', {
  path: '/socket.io',
  transports: ['websocket'],
  reconnection: true,
  reconnectionAttempts: 20,
  reconnectionDelay: 3000,
});


let currentVideo = null;

// Astronaut.io emits random "video" events with { id: "YOUTUBE_ID", ... }
sock.on('connect', () => console.log('[randomyt] Connected to Astronaut.io'));
sock.on('video', pkt => {
  currentVideo = `https://youtu.be/${pkt.id}`;
});
sock.on('connect_error', err => console.error('[randomyt] Astronaut.io error:', err));
sock.on('disconnect', () => console.warn('[randomyt] Disconnected from Astronaut.io'));

// Export as a standard command for your bot
module.exports = {
  data: new SlashCommandBuilder()
    .setName('randomyt')
    .setDescription('Get a YouTube video with (almost) zero views, via Astronaut.io!'),
  async execute(interaction) {
    if (currentVideo) {
      await interaction.reply(currentVideo);
    } else {
      await interaction.reply('Still connecting to the Astronaut.io video feed... try again in a few seconds!');
    }
  },
};
