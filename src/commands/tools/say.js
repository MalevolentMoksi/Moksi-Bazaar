const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { isOwner } = require('../../utils/constants');
const logger = require('../../utils/logger');

/** Discord rejects anything longer; the option itself allows up to 6000. */
const MAX_MESSAGE_CHARS = 2000;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('say')
    .setDescription('Bot repeats your message anonymously')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(opt =>
      opt.setName('message')
        .setDescription('What should I say?')
        .setRequired(true)
        .setMaxLength(MAX_MESSAGE_CHARS)
    ),
  async execute(interaction) {
    const text = interaction.options.getString('message');

    if (!isOwner(interaction.user.id)) {
      return interaction.reply({ content: `You don't speak for me <@${interaction.user.id}>, you little worm.` });
    }

    // Acknowledged before the send, not after. Posting to a channel is a full
    // API round trip, and doing it first meant a slow one burned the three
    // seconds the interaction had to live: the message went out and the owner
    // was told the command failed.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      await interaction.channel.send(text);
    } catch (error) {
      logger.warn('/say could not post', { channelId: interaction.channelId, error: error.message });
      return interaction.editReply(`Could not post that: ${error.message}`);
    }
    return interaction.editReply('✅ Message sent.');
  },
};
