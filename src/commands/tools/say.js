const { SlashCommandBuilder } = require('@discordjs/builders');
const { MessageFlags } = require('discord.js');
const { isOwner } = require('../../utils/constants');


module.exports = {
  data: new SlashCommandBuilder()
    .setName('say')
    .setDescription('Bot repeats your message anonymously')
    .addStringOption(opt =>
      opt.setName('message')
        .setDescription('What should I say?')
        .setRequired(true)
    ),
  async execute(interaction) {
    const text = interaction.options.getString('message');
    if (isOwner(interaction.user.id)) {
      await interaction.channel.send(text);
      await interaction.reply({ content: "✅ Message sent.", flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: `You don't speak for me <@${interaction.user.id}>, you little worm.` });
    }
  },
};
