// At the top of your goatvc.js or a voiceManager module:
const { SlashCommandBuilder } = require('@discordjs/builders');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const path = require('path');

// ...rest of your goatvc.js...


// One per guild: { connection, timer }
const bleatSessions = new Map();

function randomIntervalMs() {
  return Math.floor(30_000 + Math.random() * (15 * 60_000 - 30_000)); // 30s to 15m
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('goatvc')
    .setDescription('Moksi VC goat bleater')
    .addSubcommand(c => c.setName('start').setDescription('Start goat bleats'))
    .addSubcommand(c => c.setName('stop').setDescription('Stop goat bleats and leave')),

  async execute(interaction) {
    // Which subcommand?
    const sc = interaction.options.getSubcommand();

    if (sc === 'start') {
      // Check if user is in a VC
      const userVC = interaction.member?.voice?.channel;
      if (!userVC) return interaction.reply("You must be in a voice channel!");

      // Prevent multiple sessions per guild
      if (bleatSessions.has(interaction.guild.id)) {
        return interaction.reply("I'm already goat-bleating in this server!");
      }

      // Join the channel
      const connection = joinVoiceChannel({
        channelId: userVC.id,
        guildId: userVC.guild.id,
        adapterCreator: userVC.guild.voiceAdapterCreator,
      });

      // Bleat function, schedules itself randomly
      async function scheduleBleat() {
        const player = createAudioPlayer();
        const audioPath = path.join(__dirname, '..', '..', 'assets', 'goat_bleat.mp3');
        const resource = createAudioResource(audioPath);

        connection.subscribe(player);
        player.play(resource);

        // Wait until playback is done
        await new Promise(res => {
          player.once(AudioPlayerStatus.Idle, res);
        });

        // Set up next bleat unless cancelled
        const session = bleatSessions.get(interaction.guild.id);
        if (session && !session.stopped) {
          session.timer = setTimeout(scheduleBleat, randomIntervalMs());
          bleatSessions.set(interaction.guild.id, session);
        }
      }

      // Track session
      bleatSessions.set(interaction.guild.id, { connection, stopped: false, timer: null });

      // Start first bleat soon
      await interaction.reply("I'm in the VC! Get ready for regular goat mayhem.");
      const session = bleatSessions.get(interaction.guild.id);
      session.timer = setTimeout(scheduleBleat, 2000); // first bleat in 2s
    }

    if (sc === 'stop') {
      const session = bleatSessions.get(interaction.guild.id);
      if (!session) return interaction.reply("Not in a voice channel right now!");

      // Signal stop
      session.stopped = true;
      if (session.timer) clearTimeout(session.timer);

      // Disconnect
      session.connection.destroy();
      bleatSessions.delete(interaction.guild.id);

      await interaction.reply("I've left the VC. Goat silence resumes.");
    }
  },
};
