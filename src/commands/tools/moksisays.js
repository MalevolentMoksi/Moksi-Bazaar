const { SlashCommandBuilder } = require('discord.js');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const LANGUAGE_API_KEY = process.env.LANGUAGE_API_KEY;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('moksisays')
        .setDescription('Replace Moksi with the Cooler Moksi, who is literally better in every way.')
        .addStringOption(opt =>
            opt
                .setName('request')
                .setDescription('Optionally, ask Cooler Moksi anything.')
                .setRequired(false)
        ),

    async execute(interaction) {
        await interaction.deferReply();
        try {
            // Always fetch recent context
            const messages = await interaction.channel.messages.fetch({ limit: 20 });
            const recentMessages = Array.from(messages.values())
                .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
                .slice(-15);
            const recent = recentMessages
                .map(msg => `${msg.author.username}: ${msg.content}`)
                .join('\n');
            const userRequest = interaction.options.getString('request');

            let prompt;
            if (userRequest) {
                prompt =
                    `You're Cooler Moksi, a cynic bot replacement of a guy named Moksi. Here are the latest chat messages on this Discord server:\n` +
                    `${recent}\n\n` +
                    `A user now asks: "${userRequest}"\n` +
                    `Reply as Cooler Moksi (one or two sentences), addressing the request (and the context IF it's relevant to the request). Try to write naturally (lowercase, no excessive punctuation, etc.).`;
            } else {
                prompt =
                    `You're Cooler Moksi, a cynic bot replacement of a guy named Moksi. These are the last Discord chat messages:\n${recent}\n\n` +
                    `Respond with a witty or pithy one- or two-sentence reply to add to the conversation. Try to write naturally (lowercase, no excessive punctuation, etc.).`;
            }

            const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${LANGUAGE_API_KEY}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: 'llama-3.3-70b-versatile',
                    messages: [{ role: 'user', content: prompt }],
                    max_tokens: 100,
                    temperature: 0.7,
                }),
            });

            if (!response.ok) {
                const errText = await response.text();
                await interaction.editReply('Groq API error: ' + errText);
                return;
            }

            const data = await response.json();
            let reply =
                data.choices?.[0]?.message?.content?.trim() ||
                data.choices?.[0]?.text?.trim() ||
                data.content?.trim() ||
                '*No witty summary returned.*';

            // If the user requested, format as asked by them, small and italicized
            if (userRequest) {
                // Ping user
                reply = `-# <@${interaction.user.id}> asked *"${userRequest}"*\n\n${reply}`;
            }

            await interaction.editReply(reply);


        } catch (error) {
            await interaction.editReply('Internal error: ' + (error?.message || error));
        }
    },
};
