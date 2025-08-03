const { SlashCommandBuilder } = require('@discordjs/builders');

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
    if (interaction.user.id === "619637817294848012") {
      await interaction.channel.send(text);
      await interaction.reply({ content: "✅ Message sent.", flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: `You don't speak for me <@${interaction.user.id}>, you little worm.` });
    }
  },
};
