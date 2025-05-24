const { SlashCommandBuilder } = require('@discordjs/builders');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('say')
    .setDescription('I repeats your message')
    .addStringOption(opt =>
      opt.setName('message')
         .setDescription('What should I say?')
         .setRequired(true)
    ),
    
  async execute(interaction) {
    const text = interaction.options.getString('message');
    await interaction.reply(text);
  }
};