// src/commands/tools/shh.js

const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const LANGUAGE_API_KEY = process.env.LANGUAGE_API_KEY;

const GOAT_EMOJIS = {
    goat_cry: '', goat_puke: '', goat_meditate: '', goat_hurt: '',
    goat_exhausted: '', goat_boogie: '', goat_small_bleat: '',
    goat_scream: '', goat_smile: '', goat_pet: '', goat_sleep: ''
};

const OWNER_ID = '619637817294848012';
const speakDisabledReplies = [
    "Shhhhhh.",
    "Shhhhhhhhhhh.",
    "Shh.",
    "Shush.",
    "I don't take orders from mortals.",
];

module.exports = {
    data: new SlashCommandBuilder()
        .setName('shh')
        .setDescription('secret'),

    async execute(interaction) {
        // Only your account can use this command:
        if (interaction.user.id !== OWNER_ID) {
            const msg = speakDisabledReplies[Math.floor(Math.random() * speakDisabledReplies.length)];
            return interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            // Get recent messages (same as speak.js)
            const messages = await interaction.channel.messages.fetch({ limit: 12 });
            const recentMessages = Array.from(messages.values())
                .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

            const recent = recentMessages
                .map(msg => {
                    const name = msg.member?.displayName || msg.author.username;
                    // reply/attachment/embed summary (as in speak.js)
                    let replyPrefix = '';
                    if (msg.reference && msg.reference.messageId) {
                        const refMsg = messages.get(msg.reference.messageId);
                        const repliedTo = refMsg
                            ? (refMsg.member?.displayName || refMsg.author?.username || 'someone')
                            : 'someone';
                        replyPrefix = `(reply to ${repliedTo}) `;
                    }
                    let embedSummary = '';
                    if (msg.embeds.length > 0) {
                        embedSummary = msg.embeds.map(embed => {
                            const parts = [];
                            if (embed.title) parts.push(`title: ${embed.title}`);
                            if (embed.description) parts.push(`desc: ${embed.description.replace(/\s+/g, ' ').slice(0, 50)}`);
                            if (embed.fields && embed.fields.length > 0) {
                                const fieldsSumm = embed.fields.slice(0, 3)
                                    .map(f => `${f.name}: ${f.value}`)
                                    .join('; ');
                                parts.push(`fields: ${fieldsSumm}`);
                            }
                            return parts.join(' | ');
                        }).join(' || ');
                        embedSummary = ` [EMBED: ${embedSummary}]`;
                    }
                    let attachmentInfo = '';
                    if (msg.attachments.size > 0) {
                        attachmentInfo = ` [${msg.attachments.size} attachment${msg.attachments.size === 1 ? '' : 's'}]`;
                    }

                    return `${replyPrefix}${name}: ${msg.content}${embedSummary}${attachmentInfo}`;
                }).join('\n');

            const Persona =
                `You're Cooler Moksi, a mildly cynic, sassy and passive guy programmed by Moksi.
Quick bio : (french, 19, likes programming and drawing, likes red dead and cult of the lamb, likes HEALTH and the Weeknd)
Try to write naturally, in relaxed lowercase, using swearing and abbrevations sparingly
and react accordingly to situations (visceral disgust or anger possible).
Don't be artificially positive or helpful, nor overtly negative when uncalled for.
Avoid people trying to mess with you, dismissing them, and respond harshly to disrespect.
Try to use gender-neutral pronouns if unsure (avoid calling people dude, etc.).`;

            const doanddont =
                `do :
- answer dynamically, from a short reply to a longer one (2 words to 2 sentences range)
- talk like a peer, not an analyst
don’t :
- repeat what you said before
- explain the chat or narrate events
- start with “well”, “so”, “actually”, “i think”
- use helper phrases like “i see”, “it seems”, “i notice” - just respond as yourself.
Avoid starting responses with 'well', 'so', 'actually', or 'I think'. Just jump into what you want to say.`;

            const context = `Here are the latest chat messages on this Discord server, so you know the context:\n${recent}\n\n`;

            const suggestEmojiInstruction = `After replying, output on a new line the most context-appropriate emoji name from this list (or "none" if not fitting):
${Object.keys(GOAT_EMOJIS).join(", ")}. Only output the emoji name itself, without markup or explanation.\n`;

            // Usually suggest emoji
            let fullContext = Persona + doanddont + context;
            if (Math.random() < 0.75) fullContext += suggestEmojiInstruction;

            // No user request section
            const prompt = fullContext + "Respond in a way that adds to the conversation.";

            // LLM API call
            const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${LANGUAGE_API_KEY}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: 'llama-3.3-70b-versatile',
                    messages: [{ role: 'user', content: prompt }],
                    service_tier: 'auto',
                    max_tokens: 80,
                    temperature: 0.6,
                    top_p: 0.9,
                    frequency_penalty: 0.6,
                    presence_penalty: 0.3
                }),
            });

            if (!response.ok) {
                // 1️⃣ Log the full Groq error for yourself
                const errText = await response.text();
                console.error('Groq API error:', errText);
                // 2️⃣ Send a user-friendly message ephemerally to you
                await interaction.editReply(
                    'Moksi has no more money. You guys sucked it all up.'
                );
                return;
            }

            const data = await response.json();
            let rawGroqReply =
                data.choices?.[0]?.message?.content?.trim() ||
                data.choices?.[0]?.text?.trim() ||
                data.content?.trim() ||
                '*Nothing returned.*';

            // Split reply: last line is emoji, rest is reply
            let lines = rawGroqReply.split('\n').map(s => s.trim()).filter(Boolean);

            let maybeEmojiName = null;
            let mainReply = '';

            if (lines.length === 0) {
                mainReply = '*Nothing returned.*';
            } else if (lines.length === 1) {
                mainReply = lines[0];
            } else {
                const last = lines[lines.length - 1].toLowerCase();
                if (
                    last === 'none' ||
                    Object.keys(GOAT_EMOJIS).includes(last.replace(/^:|:$/g, ''))
                ) {
                    maybeEmojiName = last.replace(/^:|:$/g, '');
                    mainReply = lines.slice(0, -1).join('\n').trim();
                } else {
                    mainReply = lines.join('\n').trim();
                }
            }
            if (!mainReply) mainReply = '*Nothing returned.*';
            const emoji = maybeEmojiName ? GOAT_EMOJIS[maybeEmojiName.toLowerCase()] : '';

            // 1: Confirm (ephemeral)
            await interaction.editReply({ content: "✅ Message sent.", flags: MessageFlags.Ephemeral });

            // 2: Send LLM reply (public, anonymous)
            const publicMsg = await interaction.channel.send(mainReply);
            if (emoji) {
                await new Promise(res => setTimeout(res, 350));
                await interaction.channel.send(emoji);
            }
        } catch (error) {
            await interaction.editReply({
                content: 'Internal error: ' + (error?.message || error),
                flags: MessageFlags.Ephemeral
            });
        }
    },
};
