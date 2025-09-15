// src/commands/tools/speak.js

const { SlashCommandBuilder } = require('discord.js');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const LANGUAGE_API_KEY = process.env.LANGUAGE_API_KEY;
const { isUserBlacklisted } = require('../../utils/db.js'); // adjust path if needed
const { getSettingState } = require('../../utils/db.js');

// Debug boilerplate: will help Railway show crashes and runtime logs
console.log('speak.js: starting at', new Date().toISOString());
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err && (err.stack || err.message || err));
});
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
});

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
    goat_pet: '<a:goat_pet:1273634369445040219>',
    goat_sleep: '<a:goat_sleep:1395450280161710262>'
};

module.exports = {
    data: new SlashCommandBuilder()
        .setName('speak')
        .setDescription('Speak a short summary of recent messages using the model'),

    async execute(interaction) {
        await interaction.deferReply();

        // basic guards (preserve your original checks)
        if (!LANGUAGE_API_KEY) {
            await interaction.editReply('Language API key not configured.');
            return;
        }
        const userId = interaction.user.id;
        if (await isUserBlacklisted(userId)) {
            await interaction.editReply('You are blacklisted from using this command.');
            return;
        }

        // Pull recent messages for context (keeps your original logic)
        const messages = await interaction.channel.messages.fetch({ limit: 12 });
        const recentMessages = Array.from(messages.values()).sort((a, b) => a.createdTimestamp - b.createdTimestamp);

        const recent = recentMessages.map(msg => {
            const name = msg.member?.displayName || msg.author.username;
            let replyPrefix = '';
            if (msg.reference && msg.reference.messageId) {
                const refMsg = messages.get(msg.reference.messageId);
                const repliedTo = refMsg ? (refMsg.member?.displayName || refMsg.author?.username || 'someone') : 'someone';
                replyPrefix = `(reply to ${repliedTo}) `;
            }

            let embedSummary = '';
            if (msg.embeds.length > 0) {
                const e = msg.embeds[0];
                embedSummary = ` [embed: ${e.title || ''} ${e.description ? e.description.slice(0, 50) : ''}]`;
            }

            return `${name}: ${replyPrefix}${msg.content?.slice(0, 180) || ''}${embedSummary}`;
        }).join('\n');

        // Build system + user prompt (keep your original prompt logic)
        let prompt = "You are a helpful assistant that summarizes recent chat messages for TTS output. Keep it short, friendly, and safe. Output only the final text to be spoken — no internal tags or explanations.";
        prompt += "\n\nContext:\n" + recent;

        // choose model (keep default from old working file but allow override)
        const model = process.env.LANGUAGE_MODEL || 'qwen/qwen3-32b';

        // === THE FETCH MUST BE HERE, after prompt is ready ===
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${LANGUAGE_API_KEY}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify((() => {
                    // Build body object programmatically so we can conditionally add Groq reasoning opts
                    const body = {
                        model: model || 'qwen/qwen3-32b',
                        messages: [{ role: 'user', content: prompt }],
                        service_tier: 'auto',
                        max_tokens: 80,
                        temperature: 0.6,
                        top_p: 0.9,
                        frequency_penalty: 0.6,
                        presence_penalty: 0.3,
                        // Prefer plain text outputs and keep tokens small for TTS usage
                        response_format: 'text'
                    };
                    // If model looks like a Qwen variant, explicitly disable thinking
                    if ((body.model || '').toLowerCase().includes('qwen')) {
                        body.reasoning_effort = 'none'; // supported by Qwen 3
                        // Also ask Groq to return only the final answer (no <think> block)
                        body.reasoning_format = 'hidden';
                    } else {
                        // For reasoning models in general, hide the reasoning tokens to avoid <think>
                        body.reasoning_format = 'hidden';
                    }
                    return body;
                })())
            });

            if (!response.ok) {
                const errText = await response.text().catch(() => '<no-text>');
                console.error('Groq API responded with non-OK status', response.status, errText);
                await interaction.editReply('Model error — check logs.');
                return;
            }

            const data = await response.json();
            console.error('Groq response status =', response.ok, response.status);
            console.error('Groq response JSON:', JSON.stringify(data, null, 2));

            // robust extractor for common Groq/OpenAI-like shapes
            function firstString(...vals) {
                for (const v of vals) {
                    if (typeof v === 'string' && v.trim()) return v.trim();
                    if (Array.isArray(v)) {
                        for (const item of v) {
                            if (typeof item === 'string' && item.trim()) return item.trim();
                            if (item && typeof item.text === 'string' && item.text.trim()) return item.text.trim();
                            if (item && typeof item.content === 'string' && item.content.trim()) return item.content.trim();
                        }
                    }
                    if (v && typeof v === 'object') {
                        if (typeof v.text === 'string' && v.text.trim()) return v.text.trim();
                        if (typeof v.content === 'string' && v.content.trim()) return v.content.trim();
                        if (Array.isArray(v.content)) {
                            for (const c of v.content) {
                                if (typeof c === 'string' && c.trim()) return c.trim();
                                if (c && typeof c.text === 'string' && c.text.trim()) return c.text.trim();
                            }
                        }
                    }
                }
                return '';
            }

            const rawGroqReply = firstString(
                data?.choices?.[0]?.message?.content,
                data?.choices?.[0]?.text,
                data?.choices?.[0]?.message?.content?.parts?.join('\n'),
                data?.outputs?.[0]?.content,
                data?.outputs?.[0]?.content?.[0]?.text,
                data?.output?.[0]?.content?.[0]?.text,
                data?.result,
                data?.response?.output_text,
                data?.additional_kwargs?.reasoning_content,
                data?.text,
                data?.content
            ) || '*Nothing returned.*';

            // Split Groq answer (may be multi-line!)
            let lines = rawGroqReply.split('\n').map(s => s.trim()).filter(Boolean);

            // If the model accidentally returned a <think> block, strip it aggressively
            lines = lines.map(l => l.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()).filter(Boolean);

            // Build main response (shorten to 120 chars to keep TTS pleasantly short)
            let mainResponse = lines.slice(0, 3).join('\n');
            if (mainResponse.length > 220) mainResponse = mainResponse.slice(0, 217) + '...';

            if (!mainResponse || mainResponse === '*Nothing returned.*') {
                console.error('No usable output from model, raw reply:', rawGroqReply.substring(0, 800));
                await interaction.editReply('Model returned nothing usable — check the logs.');
                return;
            }

            // Optionally write debug file to /tmp for Railway debugging
            try {
                const fs = require('fs');
                fs.writeFileSync('/tmp/speak-debug.json', JSON.stringify({ time: new Date().toISOString(), raw: rawGroqReply }, null, 2));
                console.log('Wrote /tmp/speak-debug.json');
            } catch (e) {
                console.error('Failed writing /tmp debug file', e);
            }

            // Reply with the text ready for TTS (your old code likely converts this to audio)
            await interaction.editReply(mainResponse);

            // Temporary debug pause: keep process alive briefly in case Railway dies too quickly while debugging
            if (process.env.DEBUG_KEEP_ALIVE === 'true') {
                console.log('Debug pause enabled — keeping process alive for 2 minutes');
                setTimeout(() => {
                    console.log('Debug pause ended.');
                }, 2 * 60 * 1000);
            }
    }
};
