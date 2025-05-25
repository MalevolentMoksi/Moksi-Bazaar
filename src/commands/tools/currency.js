const { SlashCommandBuilder } = require('discord.js');
const { getBalance, updateBalance } = require('../../utils/db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('currency')
    .setDescription('Beg for cash or check your balance')
    .addSubcommand(sub =>
      sub.setName('beg').setDescription('Get random cash when you have $0')
    )
    .addSubcommand(sub =>
      sub.setName('balance').setDescription('Check your current balance')
    ),

  async execute(interaction) {
    const userId = interaction.user.id;
    const mention = interaction.user.toString();
    const sub = interaction.options.getSubcommand();

    if (sub === 'beg') {
      const bal = await getBalance(userId);
      if (bal > 0) {
        return interaction.reply({ content: `${mention}, nice try—but you still have $${bal}! You can only beg when you’re flat broke.`, ephemeral: true });
      }
      const amount = Math.floor(Math.random() * 200) + 1;
      await updateBalance(userId, amount);
      return interaction.reply(`${mention}, a benevolent stranger dropped $${amount} in your lap. Your new balance is $${amount}.`);
    }

    if (sub === 'balance') {
      const bal = await getBalance(userId);
      return interaction.reply(`${mention}, your current balance is $${bal}.`);
    }
  }
};
