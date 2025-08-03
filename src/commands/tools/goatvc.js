// src/commands/tools/goatvc.js

const { SlashCommandBuilder, MessageFlags } = require('@discordjs/builders');
const { joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    entersState,
    VoiceConnectionStatus } = require('@discordjs/voice');
const path = require('path');
const fs = require('fs');
const { Client, GatewayIntentBits } = require('discord.js');


// Per-guild: { connection, timer, stopped }
const bleatSessions = new Map();

function randomIntervalMs() {
    return Math.floor(30_000 + Math.random() * (12 * 60_000 - 3_000)); // 3s to 12m
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('goatvc')
        .setDescription('Moksi VC goat bleater')
        .addSubcommand(c => c.setName('start').setDescription('Start goat bleats'))
        .addSubcommand(c => c.setName('stop').setDescription('Stop goat bleats and leave'))
        .addSubcommand(c => c.setName('sic').setDescription('(Owner) Sic the goat into any VC'))
        .addSubcommand(c => c.setName('test').setDescription('Play a test bleat now')),

    async execute(interaction) {
        const sc = interaction.options.getSubcommand();

        // --- TEST: play a bleat once and leave ---
        if (sc === 'test') {
            const userVC = interaction.member?.voice?.channel;
            if (!userVC) return interaction.reply("You must be in a voice channel!");
            const audioPath = path.join(__dirname, '..', '..', 'assets', 'goat_bleat.mp3');
            if (!fs.existsSync(audioPath)) {
                return interaction.reply(
                    "Test error: Goat audio file missing at: " + audioPath
                );
            }

            // Find if bot is already in user's VC
            const botMember = interaction.guild.members.me;
            const inSameVC = botMember.voice.channelId === userVC.id;

            let connection;
            if (inSameVC) {
                // Already in correct VC (reuse)
                // Use discord.js/voice VoiceConnection utils to get the connection
                connection = botMember.voice?.connection;
                if (!connection) {
                    // Fallback - rejoin if no active connection object (for robustness)
                    connection = joinVoiceChannel({
                        channelId: userVC.id,
                        guildId: userVC.guild.id,
                        adapterCreator: userVC.guild.voiceAdapterCreator,
                    });
                }
            } else {
                // Not in VC or in wrong one, join
                connection = joinVoiceChannel({
                    channelId: userVC.id,
                    guildId: userVC.guild.id,
                    adapterCreator: userVC.guild.voiceAdapterCreator,
                });
            }

            // No destroy after playing!
            connection.on('stateChange', (oldState, newState) => {
                console.log(`[GoatVC] Connection: ${oldState.status} → ${newState.status}`);
            });

            const player = createAudioPlayer();
            connection.subscribe(player);

            player.on('error', (err) => {
                console.error('[GoatVC-Test] Audio error:', err);
                // Do NOT disconnect after test
            });

            player.on(AudioPlayerStatus.Playing, () => {
                console.log('[GoatVC-Test] Bleat started!');
            });

            player.on(AudioPlayerStatus.Idle, () => {
                console.log('[GoatVC-Test] Bleat finished!');
                // Intentionally do nothing here—bot stays in VC
            });

            const resource = createAudioResource(audioPath);
            player.play(resource);

            await interaction.reply("BAAAAAAAAAAAAAAAH (test, bot will stay in VC)");
            return;
        }


        // --- STOP ---
        if (sc === 'stop') {
            const session = bleatSessions.get(interaction.guild.id);
            if (!session) {
                return interaction.reply("Not in a voice channel right now!");
            }
            session.stopped = true;
            if (session.timer) clearTimeout(session.timer);
            session.connection.destroy();
            bleatSessions.delete(interaction.guild.id);
            await interaction.reply("Goat silence resumes.");
            return;
        }

        // --- START ---
        if (sc === 'start') {
            const userVC = interaction.member?.voice?.channel;
            if (!userVC) return interaction.reply("You must be in a voice channel!");
            const guildVoiceState = interaction.guild.members.me.voice;
            let isActuallyInVC = !!guildVoiceState?.channel;

            // Also check the session map, but verify reality
            if (bleatSessions.has(interaction.guild.id)) {
                // If bot is NOT in a VC, reset the session!
                if (!isActuallyInVC) {
                    bleatSessions.delete(interaction.guild.id);
                } else {
                    return interaction.reply("I'm already goat-bleating in this server!");
                }
            }
            // If we got here, either no session, or session is stale and deleted above

            const audioPath = path.join(__dirname, '..', '..', 'assets', 'goat_bleat.mp3');
            if (!fs.existsSync(audioPath)) {
                await interaction.reply("Goat audio file missing at: " + audioPath);
                return;
            }

            const connection = joinVoiceChannel({
                channelId: userVC.id,
                guildId: userVC.guild.id,
                adapterCreator: userVC.guild.voiceAdapterCreator,
            });

            connection.on('stateChange', (oldState, newState) => {
                if (oldState.status !== VoiceConnectionStatus.Destroyed && newState.status === VoiceConnectionStatus.Destroyed) {
                    bleatSessions.delete(interaction.guild.id);
                }
            });


            async function scheduleBleat() {
                try {
                    // Wait for connection to be ready
                    await entersState(connection, VoiceConnectionStatus.Ready, 10_000);

                    const player = createAudioPlayer();
                    const subscription = connection.subscribe(player);

                    if (!subscription) {
                        console.error('[GoatVC] Failed to subscribe player to connection');
                        return;
                    }

                    player.on('error', (err) => {
                        console.error('[GoatVC] Audio error:', err);
                    });

                    player.on(AudioPlayerStatus.Playing, () => {
                        console.log('[GoatVC] Bleat started!');
                    });

                    player.on(AudioPlayerStatus.Idle, () => {
                        console.log('[GoatVC] Bleat finished!');
                    });

                    const resource = createAudioResource(audioPath, {
                        inlineVolume: true
                    });

                    player.play(resource);

                    await new Promise(res => {
                        player.once(AudioPlayerStatus.Idle, res);
                    });

                    const session = bleatSessions.get(interaction.guild.id);
                    if (session && !session.stopped) {
                        session.timer = setTimeout(scheduleBleat, randomIntervalMs());
                        bleatSessions.set(interaction.guild.id, session);
                    }
                } catch (error) {
                    console.error('[GoatVC] Error in scheduleBleat:', error);
                }
            }


            bleatSessions.set(interaction.guild.id, { connection, stopped: false, timer: null });
            await interaction.reply("Yo!");
            const session = bleatSessions.get(interaction.guild.id);
            session.timer = setTimeout(scheduleBleat, 2000); // first bleat in 2s
            return;
        }

        if (sc === 'sic') {
            // Check permission:
            if (interaction.user.id !== '619637817294848012') {
                return interaction.reply({ content: "You can't unleash the goat like that!", flags: MessageFlags.Ephemeral});
            }

            // List all joinable VCs:
            const vcs = interaction.guild.channels.cache
                .filter(ch => ch.type === 2 && ch.joinable)
                .map(ch => ({ name: ch.name, id: ch.id }));

            if (!vcs.length) {
                return interaction.reply({ content: "No joinable voice channels found.", flags: MessageFlags.Ephemeral});
            }

            // Build select menu (up to 25 options for Discord UI)
            const { ActionRowBuilder, StringSelectMenuBuilder, EmbedBuilder } = require('discord.js');
            const options = vcs.slice(0, 25).map(vc => ({
                label: vc.name,
                value: vc.id,
            }));

            const selectRow = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId('goatvc_sic_select')
                    .setPlaceholder('Select a Voice Channel')
                    .addOptions(options)
            );

            const embed = new EmbedBuilder()
                .setTitle('🐐 Sic the Goat!')
                .setDescription('Choose a voice channel below for the bot to enter, bleat, and then leave. No one will see it coming.');

            await interaction.reply({ embeds: [embed], components: [selectRow], flags: MessageFlags.Ephemeral});

            // Handle selector
            const msg = await interaction.fetchReply();
            msg.awaitMessageComponent({ filter: i => i.user.id === '619637817294848012', time: 30_000 })
                .then(async selectInt => {
                    // Safety: Only let owner use and only for chosen VC
                    const chosenId = selectInt.values[0];
                    const vc = interaction.guild.channels.cache.get(chosenId);

                    if (!vc || !vc.joinable || vc.type !== 2) {
                        return selectInt.reply({ content: "Cannot join that VC!", flags: MessageFlags.Ephemeral});
                    }

                    // Play the bleat, then leave
                    const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
                    const path = require('path'), fs = require('fs');
                    const audioPath = path.join(__dirname, '..', '..', 'assets', 'goat_bleat.mp3');
                    if (!fs.existsSync(audioPath)) {
                        return selectInt.reply({ content: "Goat audio missing!", flags: MessageFlags.Ephemeral});
                    }
                    const connection = joinVoiceChannel({
                        channelId: vc.id,
                        guildId: vc.guild.id,
                        adapterCreator: vc.guild.voiceAdapterCreator,
                    });

                    const player = createAudioPlayer();
                    connection.subscribe(player);

                    player.on('error', err => {
                        connection.destroy();
                    });

                    player.on(AudioPlayerStatus.Idle, () => {
                        setTimeout(() => connection.destroy(), 600);
                    });

                    player.on(AudioPlayerStatus.Playing, () => {
                        // Bleat started—no further action needed here
                    });

                    const resource = createAudioResource(audioPath);
                    player.play(resource);

                    await selectInt.reply({ content: `Goat has secretly been sicced into **${vc.name}** (will bail after the bleat)!`, flags: MessageFlags.Ephemeral});
                })
                .catch(() => { /* Timeout/no action; silently ignore */ });

            return;
        }


        // Defensive: if no subcommand matched
        await interaction.reply("Unknown subcommand.");
    },
};
