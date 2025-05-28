const { SlashCommandBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Replies with Pong!'),
    async execute(interaction, client) {
        const message = await interaction.deferReply({
            fetchReply : true
        });

    const newMessage = `Pong!\nAPI Latency: ${client.ws.ping}ms\nMessage Latency: ${message.createdTimestamp - interaction.createdTimestamp}ms`;
    await interaction.editReply({
        content: newMessage
        });
    }
}