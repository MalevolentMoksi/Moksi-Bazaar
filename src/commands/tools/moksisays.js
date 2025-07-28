// src/commands/tools/moksisays.js

const { SlashCommandBuilder } = require('discord.js');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

// Stored as an environment variable!
const LANGUAGE_API_KEY = process.env.LANGUAGE_API_KEY;


module.exports = {
    data: new SlashCommandBuilder()
        .setName('moksisays')
        .setDescription('Let Moksi summarize the last 10 messages with AI wit!'),

    async execute(interaction) {
        await interaction.deferReply();

        try {
            // Fetch last 15 messages for filtering (to ensure 10 user messages)
            const messages = await interaction.channel.messages.fetch({ limit: 15 });
            // Get the last 10 non-bot messages, sorted oldest to newest
            const recentMessages = Array.from(messages.values())
                .filter(msg => !msg.author.bot)
                .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
                .slice(-10);

            const recent = recentMessages
                .map(msg => `${msg.author.username}: ${msg.content}`)
                .join('\n');


            const prompt = `These are the last Discord chat messages:\n${recent}\n\nRespond with a witty or pithy one- or two-sentence recap/reply, as if you're a cynic bot replacement of a guy named Moksi.`;

            // Send to Groq API
            const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${LANGUAGE_API_KEY}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: 'mixtral-8x7b-32768', // or 'llama3-8b-8192' -- see Groq dashboard for available models
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
