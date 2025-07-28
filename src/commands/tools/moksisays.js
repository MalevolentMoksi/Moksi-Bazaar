// src/commands/tools/moksisays.js

const { SlashCommandBuilder } = require('discord.js');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// Stored as an environment variable!
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;


module.exports = {
  data: new SlashCommandBuilder()
    .setName('moksisays')
    .setDescription('Let Moksi summarize the last 10 messages with AI wit!'),

  async execute(interaction) {
    await interaction.deferReply();

    // Fetch last 15 messages for filtering (to ensure 10 user messages)
    const messages = await interaction.channel.messages.fetch({ limit: 15 });
    // Get the last 10 non-bot messages, sorted oldest to newest
    const recent = messages
      .filter(msg => !msg.author.bot)
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .slice(-10)
      .map(msg => `${msg.author.username}: ${msg.content}`)
      .join('\n');

    const prompt = `These are the last Discord chat messages:\n${recent}\n\nRespond with a witty or pithy one- or two-sentence recap, as if you're a cheeky mascot named Moksi.`;

    // Send to Claude 3 Haiku API
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 100,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      return interaction.editReply('Claude API error; please try again later.');
    }

    const data = await response.json();
    // Haiku returns: { content: [{ type: "text", text: "..." }], ... }
    let reply;
    if(Array.isArray(data.content)) {
      reply = data.content.map(chunk => chunk.text).join(' ').trim();
    } else {
      reply = data.content?.text?.trim() || data.content || '*No witty summary returned.*';
    }
    await interaction.editReply(reply);
  },
};
