// src/commands/media/videoEdit.js
const { SlashCommandBuilder } = require('discord.js');
const { handleMediaCommand, fetchRecentMedia, resolveMedia, downloadMediaToTemp } = require('../../utils/media/mediaHelpers');
const { runFFmpeg, hasAudio, atempoChain, loopVideo } = require('../../utils/media/ffmpegUtils');
const { createTempPath } = require('../../utils/media/tempFiles');
const { isGifInput, mediaFilePayload } = require('../../utils/media/formatHelpers');

function isVideoOrGif(mediaInfo) {
    return mediaInfo.isVideo || mediaInfo.ext === 'gif' || mediaInfo.isGifLike;
}

function applyGifOutput(cmd) {
    cmd
        .noAudio()
        .outputOptions([
            '-loop 0',
            '-gifflags -offsetting',
        ]);
}

function applyMp4Output(cmd) {
    cmd.outputOptions(['-pix_fmt yuv420p', '-movflags faststart']);
}

const reverse = {
    data: new SlashCommandBuilder()
        .setName('reverse')
        .setDescription('Reverse a video or GIF (plays it backwards)')
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Video or GIF to reverse (optional: uses recent media if omitted)').setRequired(false)
        ),
    async execute(interaction) {
        await handleMediaCommand(interaction, {
            allowImage: true,
            allowVideo: true,
            mediaPredicate: isVideoOrGif,
            invalidMediaMessage: 'This command supports videos and GIFs only.',
            processFn: async (inputPath, ext, context) => {
                const gifInput = await isGifInput(inputPath, ext, context);
                const outputPath = createTempPath(gifInput ? 'gif' : 'mp4');
                const audio = !gifInput && await hasAudio(inputPath);
                await runFFmpeg(inputPath, outputPath, cmd => {
                    cmd.videoFilters('reverse');
                    if (gifInput) {
                        applyGifOutput(cmd);
                    } else if (audio) {
                        cmd.audioFilters('areverse');
                    } else {
                        cmd.noAudio();
                    }
                    if (!gifInput) applyMp4Output(cmd);
                });
                return outputPath;
            },
        });
    },
};

const speed = {
    data: new SlashCommandBuilder()
        .setName('speed')
        .setDescription('Change the playback speed of a video or GIF')
        .addNumberOption(opt =>
            opt.setName('multiplier')
                .setDescription('Speed multiplier (e.g. 2 = double speed, 0.5 = half speed)')
                .setRequired(true)
                .setMinValue(0.25)
                .setMaxValue(4)
        )
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Video or GIF to adjust (optional: uses recent media if omitted)').setRequired(false)
        ),
    async execute(interaction) {
        const multiplier = interaction.options.getNumber('multiplier');
        await handleMediaCommand(interaction, {
            allowImage: true, allowVideo: true,
            mediaPredicate: isVideoOrGif,
            invalidMediaMessage: 'This command supports videos and GIFs only.',
            processFn: async (inputPath, ext, context) => {
                const gifInput = await isGifInput(inputPath, ext, context);
                const outputPath = createTempPath(gifInput ? 'gif' : 'mp4');
                const audio = !gifInput && await hasAudio(inputPath);
                // setpts is inverse of speed: 0.5x speed = PTS*2
                const pts = (1 / multiplier).toFixed(4);
                await runFFmpeg(inputPath, outputPath, cmd => {
                    cmd.videoFilters(`setpts=${pts}*PTS`);
                    if (gifInput) applyGifOutput(cmd);
                    else if (audio) cmd.audioFilters(atempoChain(multiplier));
                    else cmd.noAudio();
                    if (!gifInput) applyMp4Output(cmd);
                });
                return outputPath;
            },
        });
    },
};

const trim = {
    data: new SlashCommandBuilder()
        .setName('trim')
        .setDescription('Trim a video or GIF to a specific time range')
        .addStringOption(opt =>
            opt.setName('start').setDescription('Start time (e.g. 00:00:05 or 5)').setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName('end').setDescription('End time (e.g. 00:00:15 or 15)').setRequired(true)
        )
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Video or GIF to trim (optional: uses recent media if omitted)').setRequired(false)
        ),
    async execute(interaction) {
        const start = interaction.options.getString('start');
        const end = interaction.options.getString('end');
        await handleMediaCommand(interaction, {
            allowImage: true, allowVideo: true,
            mediaPredicate: isVideoOrGif,
            invalidMediaMessage: 'This command supports videos and GIFs only.',
            processFn: async (inputPath, ext, context) => {
                const gifInput = await isGifInput(inputPath, ext, context);
                const outputPath = createTempPath(gifInput ? 'gif' : 'mp4');
                await runFFmpeg(inputPath, outputPath, cmd => {
                    // Output-side -ss/-to keeps accurate timestamps at the cost of decoding from start
                    cmd.outputOptions([`-ss ${start}`, `-to ${end}`]);
                    if (gifInput) applyGifOutput(cmd);
                    else applyMp4Output(cmd);
                });
                return outputPath;
            },
        });
    },
};

const mute = {
    data: new SlashCommandBuilder()
        .setName('mute')
        .setDescription('Remove the audio track from a video')
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Video to mute (optional: uses recent media if omitted)').setRequired(false)
        ),
    async execute(interaction) {
        await handleMediaCommand(interaction, {
            allowImage: false, allowVideo: true,
            mediaPredicate: (mediaInfo) => mediaInfo.isVideo && !mediaInfo.isGifLike,
            invalidMediaMessage: 'This command supports videos only. GIFs do not have audio to remove.',
            processFn: async (inputPath) => {
                const outputPath = createTempPath('mp4');
                await runFFmpeg(inputPath, outputPath, cmd => {
                    cmd.noAudio().outputOptions(['-c:v copy']);
                });
                return outputPath;
            },
        });
    },
};

const loop = {
    data: new SlashCommandBuilder()
        .setName('loop')
        .setDescription('Loop a video or GIF multiple times')
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Video or GIF to loop (optional: uses recent media if omitted)').setRequired(false)
        )
        .addIntegerOption(opt =>
            opt.setName('count').setDescription('Number of times to loop (default 3, max 10)').setMinValue(2).setMaxValue(10)
        ),
    async execute(interaction) {
        const count = interaction.options.getInteger('count') ?? 3;
        await handleMediaCommand(interaction, {
            allowImage: true, allowVideo: true,
            mediaPredicate: isVideoOrGif,
            invalidMediaMessage: 'This command supports videos and GIFs only.',
            processFn: async (inputPath, ext, context) => {
                const gifInput = await isGifInput(inputPath, ext, context);
                const outputPath = createTempPath(gifInput ? 'gif' : 'mp4');
                if (gifInput) {
                    await runFFmpeg(inputPath, outputPath, cmd => {
                        cmd.inputOptions([`-stream_loop ${count - 1}`]);
                        applyGifOutput(cmd);
                    });
                } else {
                    await loopVideo(inputPath, outputPath, count);
                }
                return outputPath;
            },
        });
    },
};

const addaudio = {
    data: new SlashCommandBuilder()
        .setName('addaudio')
        .setDescription('Overlay an audio file onto a video')
        .addAttachmentOption(opt =>
            opt.setName('audio').setDescription('Audio file (MP3, WAV, OGG, etc.)').setRequired(true)
        )
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Video file (optional: uses recent media if omitted)').setRequired(false)
        )
        .addNumberOption(opt =>
            opt.setName('volume').setDescription('Audio volume (0–2, default 1)').setMinValue(0).setMaxValue(2)
        ),
    async execute(interaction) {
        await interaction.deferReply();

        const videoAttachment = interaction.options.getAttachment('media');
        const audioAttachment = interaction.options.getAttachment('audio');
        const volume = interaction.options.getNumber('volume') ?? 1;

        const { downloadToTemp, cleanup, extFromUrl } = require('../../utils/media/tempFiles');
        const fs = require('fs');

        let videoInfo = null;

        if (videoAttachment) {
            videoInfo = resolveMedia(videoAttachment.url, videoAttachment.contentType, videoAttachment.proxyURL);
            if (!videoInfo?.isVideo || videoInfo.isGifLike) {
                return interaction.editReply('Please provide a video file. GIFs should stay GIFs and cannot keep audio.');
            }
        } else {
            videoInfo = await fetchRecentMedia(interaction, {
                allowImage: false,
                allowVideo: true,
                mediaPredicate: (mediaInfo) => mediaInfo.isVideo && !mediaInfo.isGifLike,
            });
            if (!videoInfo) {
                return interaction.editReply(
                    'No video found. Attach one to the command, or post one in the recent channel messages first.'
                );
            }
        }

        const audioExt = extFromUrl(audioAttachment.url);

        const videoPath = await downloadMediaToTemp(videoInfo);
        const audioPath = await downloadToTemp(audioAttachment.url, audioExt);
        const outputPath = createTempPath('mp4');

        try {
            const videoHasAudio = await hasAudio(videoPath);
            await runFFmpeg(videoPath, outputPath, cmd => {
                cmd
                    .input(audioPath)
                    .complexFilter(
                        videoHasAudio
                            ? `[0:a][1:a]amix=inputs=2:duration=first:weights=1 ${volume}[a]`
                            : `[1:a]volume=${volume}[a]`
                    )
                    .outputOptions([
                        '-map 0:v', '-map [a]',
                        '-c:v copy', '-shortest',
                        '-movflags faststart',
                    ]);
            });

            const stats = fs.statSync(outputPath);
            if (stats.size > 24 * 1024 * 1024) {
                return interaction.editReply('⚠️ The output file is too large to send (24 MB limit).');
            }
            await interaction.editReply({ files: [mediaFilePayload(outputPath, interaction.commandName)] });
        } catch (err) {
            try { await interaction.editReply(`❌ Processing failed: ${err.message}`); } catch {}
            throw err;
        } finally {
            await cleanup(videoPath, audioPath, outputPath);
        }
    },
};

module.exports = [reverse, speed, trim, mute, loop, addaudio];
