// src/commands/tools/moksisays.js

const { SlashCommandBuilder } = require('discord.js');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

// Stored as an environment variable!
const LANGUAGE_API_KEY = process.env.LANGUAGE_API_KEY;


module.exports = {
    data: new SlashCommandBuilder()
        .setName('moksisays')
        .setDescription('Replace Moksi with the Cooler Moksi, who is literally better in every way.'),

    async execute(interaction) {
        await interaction.deferReply();

        try {
            // Fetch last 20 messages for filtering (to ensure 15 user messages)
            const messages = await interaction.channel.messages.fetch({ limit: 20 });
            // Get the last 15 non-bot messages, sorted oldest to newest
            const recentMessages = Array.from(messages.values())
                .filter(msg => !msg.author.bot)
                .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
                .slice(-15);

            const recent = recentMessages
                .map(msg => `${msg.author.username}: ${msg.content}`)
                .join('\n');


            const prompt = `You're Cooler Moksi, a cynic bot replacement of a guy named Moksi. These are the last Discord chat messages:\n${recent}\n\nRespond with a witty or pithy one- or two-sentence reply to add to the conversation.`;

            // Send to Groq API
            const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${LANGUAGE_API_KEY}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: 'llama-3.3-70b-versatile', // or 'llama3-8b-8192' -- see Groq dashboard for available models
                    messages: [{ role: 'user', content: prompt }],
                    max_tokens: 100,
                    temperature: 0.7,
                }),
            });


            if (!response.ok) {
                const errText = await response.text();
                await interaction.editReply('Claude API error: ' + errText);
                return;
            }


            const data = await response.json();
            // Groq/OpenAI returns { choices: [{ message: { content } }] }
            let reply =
                data.choices?.[0]?.message?.content?.trim() ||
                data.choices?.[0]?.text?.trim() ||
                data.content?.trim() ||
                '*No witty summary returned.*';
            await interaction.editReply(reply);
        } catch (error) {
            await interaction.editReply('Internal error: ' + (error?.message || error));
        }
    },
};
