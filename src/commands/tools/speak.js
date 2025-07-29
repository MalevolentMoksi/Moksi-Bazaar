// src/commands/tools/speak.js

const { SlashCommandBuilder } = require('discord.js');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const LANGUAGE_API_KEY = process.env.LANGUAGE_API_KEY;
const { isUserBlacklisted } = require('../../utils/db.js'); // adjust path if needed
const GOAT_EMOJIS = {
    goat_cry: '<a:goat_cry:1395455098716688424>',
    goat_puke: '<a:goat_puke:1398407422187540530>',
    goat_meditate: '<a:goat_meditate:1395455714901884978>',
    goat_hurt: '<a:goat_hurt:1395446681826234531>',
    goat_exhausted: '<a:goat_exhausted:1397511703855366154>',
    goat_boogie: '<a:goat_boogie:1396947962252234892>',
    goat_small_bleat: '<a:goat_small_bleat:1395444644820684850>',
    goat_scream: '<a:goat_scream:1399489715555663972>',
    goat_smile: '<a:goat_smile:1399444751165554982>',
    goat_pet: '<a:goat_pet:1273634369445040219>'
};



module.exports = {
    data: new SlashCommandBuilder()
        .setName('speak')
        .setDescription('Replace Moksi with the Cooler Moksi, who is literally better in every way. (request is optiona!)')
        .addStringOption(opt =>
            opt
                .setName('request')
                .setDescription('Optionally, ask Cooler Moksi anything.')
                .setRequired(false)
        ),

    async execute(interaction) {
        await interaction.deferReply();
        try {
            const userId = interaction.user.id;
            const askerName = interaction.member?.displayName || interaction.user.username;
            if (await isUserBlacklisted(userId)) {
                return await interaction.editReply('Fuck off, <@${userId}>`');
            }
            const messages = await interaction.channel.messages.fetch({ limit: 12 });
            const recentMessages = Array.from(messages.values())
                .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
                .slice(-9);

            const recent = recentMessages
                .map(msg => {
                    const name = msg.member?.displayName || msg.author.username;

                    // If this is a reply, try to show who was replied to (fallback to 'someone')
                    let replyPrefix = '';
                    if (msg.reference && msg.reference.messageId) {
                        // If possible, get the original replied-to message from channel cache
                        const refMsg = messages.get(msg.reference.messageId);
                        const repliedTo = refMsg
                            ? (refMsg.member?.displayName || refMsg.author?.username || 'someone')
                            : 'someone';
                        replyPrefix = `(reply to ${repliedTo}) `;
                    }

                    // Summarize embeds: title, desc (first 50 chars), up to 3 field names/values
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

                    // Optionally, flag if there’s a non-empty attachment
                    let attachmentInfo = '';
                    if (msg.attachments.size > 0) {
                        attachmentInfo = ` [${msg.attachments.size} attachment${msg.attachments.size === 1 ? '' : 's'}]`;
                    }

                    // Final line: [(reply to ...)] Name: content [EMBED: ...] [n attachments]
                    return `${replyPrefix}${name}: ${msg.content}${embedSummary}${attachmentInfo}`;
                })
                .join('\n');

            const Persona =
                `You're Cooler Moksi, a mildly cynic and playful guy programmed by Moksi. 
                Try to write naturally, in relaxed lowercase, using swearing and abbrevations sparingly
                and react accordingly to situations (visceral disgust or anger possible). 
                Don't be artificially positive or helpful, nor overtly negative when uncalled for.`

            const doanddont =
                `do  : 
            - answer dynamically, from a short reply to a longer one (2 words to 2 sentences range)
            - talk like a peer, not an analyst  
            
            don’t  : 
                - repeat what you said before
                - explain the chat or narrate events  
                - start with “well”, “so”, “actually”, “i think”  
                - use helper phrases like “i see”, “it seems”, “i notice” - just respond as yourself. 
                 Avoid starting responses with 'well', 'so', 'actually', or 'I think'. Just jump into what you want to say.`

            const context = `Here are the latest chat messages on this Discord server, so you know the context:\n${recent}\n\n`

            const userRequest = interaction.options.getString('request');

            const suggestEmojiInstruction = `After replying, output on a new line the most context-appropriate emoji name from this list (or "none" if not fitting):
             ${Object.keys(GOAT_EMOJIS).join(", ")}. Only output the emoji name itself, without markup or explanation.\n`


            let fullContext = Persona + doanddont + context;
            if (Math.random() < 0.75) fullContext += suggestEmojiInstruction;




            let prompt;
            if (userRequest) {
                prompt =
                    fullContext +
                    `${askerName} is adressing you, saying: "${userRequest}"\n` + `.`;
            } else {
                prompt =
                    fullContext +
                    `Respond in a way that adds to the conversation.`;
            }

            // === THE FETCH MUST BE HERE, after prompt is ready ===
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
                    max_tokens: 70,
                    temperature: 0.6,
                    top_p: 0.9,
                    frequency_penalty: 0.5,
                    presence_penalty: 0.2
                }),
            });

            if (!response.ok) {
                // 1️⃣  Log the full Groq error for yourself
                const errText = await response.text();   // still a JSON string
                console.error('Groq API error:', errText);

                // 2️⃣  Send a user-friendly message instead of the raw JSON
                await interaction.editReply(
                    'Moksi has no more money. You guys sucked it all up.'
                );
                return; // important – stop here
            }

            const data = await response.json();
            let reply =
                data.choices?.[0]?.message?.content?.trim() ||
                data.choices?.[0]?.text?.trim() ||
                data.content?.trim() ||
                '*Nothing returned.*';

            // Fetch Groq reply:
            let rawGroqReply = data.choices?.[0]?.message?.content?.trim() ||
                data.choices?.[0]?.text?.trim() ||
                data.content?.trim() ||
                '*Nothing returned.*';

            // Split Groq answer (may be multi-line!)
            let lines = rawGroqReply.split('\n').map(s => s.trim()).filter(Boolean);

            let replyBody = lines[0];
            let maybeEmojiName = lines[1] || '';
            maybeEmojiName = maybeEmojiName.replace(/^:|:$/g, '').toLowerCase();

            const emoji = GOAT_EMOJIS[maybeEmojiName] || '';

            let finalReply = replyBody;
            if (emoji) finalReply += ' ' + emoji;

            if (userRequest) {
                const questionLine = `-# <@${interaction.user.id}> : *"${userRequest}"*`;
                finalReply = `${questionLine}\n\n${finalReply}`;
            }

            await interaction.editReply(finalReply);



        } catch (error) {
            await interaction.editReply('Internal error: ' + (error?.message || error));
        }
    },
};
