const { SlashCommandBuilder } = require('discord.js');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const LANGUAGE_API_KEY = process.env.LANGUAGE_API_KEY;
const GOAT_EMOJIS = {
  goat_cry: '<a:goat_cry:1395455098716688424>',
  goat_meditate: '<a:goat_meditate:1395455714901884978>',
  goat_hurt: '<a:goat_hurt:1395446681826234531>',
  goat_exhausted: '<a:goat_exhausted:1397511703855366154>',
  goat_boogie: '<a:goat_boogie:1396947962252234892>',
  goat_small_bleat: '<a:goat_small_bleat:1395444644820684850>',
  goat_scream: '<a:goat_scream:1286713787826831483>',
  goat_smile: '<a:goat_smile:1399444751165554982>',
  goat_pet: '<a:goat_pet:1273634369445040219>'
};



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
            const contextAndPersona =
                `You're Cooler Moksi, a mildly cynic and playful guy.  Try to write naturally (lowercase, no excessive punctuation, etc.).` +
                `Here are the latest chat messages on this Discord server, so you know the context:\n${recent}\n\n`;
            const userRequest = interaction.options.getString('request');

            const suggestEmojiInstruction = `After replying, output on a new line the most context-appropriate emoji name from this list (or "none" if not fitting): ${Object.keys(GOAT_EMOJIS).join(", ")}. Only output the emoji name itself, without markup or explanation.\n`
            if (Math.random() < 0.45) contextAndPersona += suggestEmojiInstruction;

            let prompt;
            if (userRequest) {
                prompt =
                    contextAndPersona +
                    `A user now asks: "${userRequest}"\n` +
                    `Reply as Cooler Moksi (one or two sentences), addressing the request (and the context IF it's relevant to the request).`;
            } else {
                prompt =
                    contextAndPersona +
                    `Respond with a witty or pithy one- or two-sentence reply to add to the conversation.`;
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

            // Split response into main reply and possible emoji name
            let [mainReply, maybeEmojiName] = reply.trim().split('\n').map(s => s.trim());

            // Clean up: remove any accidental colons, ensure lowercase
            if (maybeEmojiName) maybeEmojiName = maybeEmojiName.replace(/^:|:$/g, '').toLowerCase();

            // Look up the corresponding emoji markup, or fallback to empty string
            const emoji = GOAT_EMOJIS[maybeEmojiName] || '';

            // Combine the main reply with the emoji, if present
            const finalReply = emoji ? `${mainReply} ${emoji}` : mainReply;

            await interaction.editReply(finalReply);


        } catch (error) {
            await interaction.editReply('Internal error: ' + (error?.message || error));
        }
    },
};
