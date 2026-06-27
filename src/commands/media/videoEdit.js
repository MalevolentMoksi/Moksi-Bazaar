// src/commands/media/videoEdit.js
const { SlashCommandBuilder } = require('discord.js');
const { handleMediaCommand, fetchRecentMedia, resolveMedia, downloadMediaToTemp } = require('../../utils/media/mediaHelpers');
const { runFFmpeg, hasAudio, atempoChain, loopVideo, mp4OutputOptions, ensureMediaSize } = require('../../utils/media/ffmpegUtils');
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

function applyMp4Output(cmd, outputOptions) {
    cmd.outputOptions(outputOptions);
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
                const outputOptions = gifInput ? null : await mp4OutputOptions(inputPath);
                await runFFmpeg(inputPath, outputPath, cmd => {
                    cmd.videoFilters('reverse');
                    if (gifInput) {
                        applyGifOutput(cmd);
                    } else if (audio) {
                        cmd.audioFilters('areverse');
                    } else {
                        cmd.noAudio();
                    }
                    if (!gifInput) applyMp4Output(cmd, outputOptions);
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
                const outputOptions = gifInput
                    ? null
                    : await mp4OutputOptions(inputPath, { durationMultiplier: 1 / multiplier });
                // setpts is inverse of speed: 0.5x speed = PTS*2
                const pts = (1 / multiplier).toFixed(4);
                await runFFmpeg(inputPath, outputPath, cmd => {
                    cmd.videoFilters(`setpts=${pts}*PTS`);
                    if (gifInput) applyGifOutput(cmd);
                    else if (audio) cmd.audioFilters(atempoChain(multiplier));
                    else cmd.noAudio();
                    if (!gifInput) applyMp4Output(cmd, outputOptions);
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
                const outputOptions = gifInput ? null : await mp4OutputOptions(inputPath);
                await runFFmpeg(inputPath, outputPath, cmd => {
                    // Output-side -ss/-to keeps accurate timestamps at the cost of decoding from start
                    cmd.outputOptions([`-ss ${start}`, `-to ${end}`]);
                    if (gifInput) applyGifOutput(cmd);
                    else applyMp4Output(cmd, outputOptions);
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
                const outputOptions = await mp4OutputOptions(inputPath, { includeAudio: false });
                await runFFmpeg(inputPath, outputPath, cmd => {
                    cmd.noAudio().outputOptions(outputOptions);
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
        let sendPath = outputPath;

        try {
            const videoHasAudio = await hasAudio(videoPath);
            const outputOptions = await mp4OutputOptions(videoPath, { forceAudio: true });
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
                        '-shortest',
                        ...outputOptions,
                    ]);
            });

            sendPath = await ensureMediaSize(outputPath, 24 * 1024 * 1024);
            const stats = fs.statSync(sendPath);
            if (stats.size > 24 * 1024 * 1024) {
                return interaction.editReply('⚠️ The output file is too large to send (24 MB limit).');
            }
            await interaction.editReply({ files: [mediaFilePayload(sendPath, interaction.commandName)] });
        } catch (err) {
            try { await interaction.editReply(`❌ Processing failed: ${err.message}`); } catch {}
            throw err;
        } finally {
            await cleanup(videoPath, audioPath, outputPath, sendPath !== outputPath ? sendPath : null);
        }
    },
};

// Plays forwards then backwards (a "boomerang"). Concatenates the clip with its reverse.
const boomerang = {
    data: new SlashCommandBuilder()
        .setName('boomerang')
        .setDescription('Make a video or GIF play forwards, then backwards')
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Video or GIF (optional: uses recent media if omitted)').setRequired(false)
        ),
    async execute(interaction) {
        await handleMediaCommand(interaction, {
            allowImage: true, allowVideo: true,
            mediaPredicate: isVideoOrGif,
            invalidMediaMessage: 'This command supports videos and GIFs only.',
            processFn: async (inputPath, ext, context) => {
                const gifInput = await isGifInput(inputPath, ext, context);
                const outputPath = createTempPath(gifInput ? 'gif' : 'mp4');
                const audio = !gifInput && await hasAudio(inputPath);
                const outputOptions = gifInput ? null : await mp4OutputOptions(inputPath);
                await runFFmpeg(inputPath, outputPath, cmd => {
                    if (gifInput) {
                        cmd.complexFilter('[0:v]split=2[v1][v2];[v2]reverse[r];[v1][r]concat=n=2:v=1:a=0[v]')
                            .outputOptions(['-map [v]']);
                        applyGifOutput(cmd);
                    } else if (audio) {
                        cmd.complexFilter(
                            '[0:v]split=2[v1][v2];[0:a]asplit=2[a1][a2];[v2]reverse[r];[a2]areverse[ar];[v1][a1][r][ar]concat=n=2:v=1:a=1[v][a]'
                        ).outputOptions(['-map [v]', '-map [a]', ...outputOptions]);
                    } else {
                        cmd.complexFilter('[0:v]split=2[v1][v2];[v2]reverse[r];[v1][r]concat=n=2:v=1:a=0[v]')
                            .outputOptions(['-map [v]', ...outputOptions]).noAudio();
                    }
                });
                return outputPath;
            },
        });
    },
};

// Shuffles frames using ffmpeg's `random` filter (cache of N frames).
const shuffle = {
    data: new SlashCommandBuilder()
        .setName('shuffle')
        .setDescription('Randomly shuffle the frames of a video or GIF')
        .addIntegerOption(opt =>
            opt.setName('frames').setDescription('Frames held in the shuffle cache (2–512, default 30)').setMinValue(2).setMaxValue(512)
        )
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Video or GIF (optional: uses recent media if omitted)').setRequired(false)
        ),
    async execute(interaction) {
        const frames = interaction.options.getInteger('frames') ?? 30;
        await handleMediaCommand(interaction, {
            allowImage: true, allowVideo: true,
            mediaPredicate: isVideoOrGif,
            invalidMediaMessage: 'This command supports videos and GIFs only.',
            processFn: async (inputPath, ext, context) => {
                const gifInput = await isGifInput(inputPath, ext, context);
                const outputPath = createTempPath(gifInput ? 'gif' : 'mp4');
                const outputOptions = gifInput ? null : await mp4OutputOptions(inputPath);
                await runFFmpeg(inputPath, outputPath, cmd => {
                    cmd.videoFilters(`random=frames=${frames}`);
                    if (gifInput) applyGifOutput(cmd);
                    else applyMp4Output(cmd, outputOptions);
                });
                return outputPath;
            },
        });
    },
};

// Changes the frame rate (FPS) of a video or GIF.
const fps = {
    data: new SlashCommandBuilder()
        .setName('fps')
        .setDescription('Change the frame rate of a video or GIF')
        .addNumberOption(opt =>
            opt.setName('fps').setDescription('Target frames per second (1–60)').setRequired(true).setMinValue(1).setMaxValue(60)
        )
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Video or GIF (optional: uses recent media if omitted)').setRequired(false)
        ),
    async execute(interaction) {
        const targetFps = interaction.options.getNumber('fps');
        await handleMediaCommand(interaction, {
            allowImage: true, allowVideo: true,
            mediaPredicate: isVideoOrGif,
            invalidMediaMessage: 'This command supports videos and GIFs only.',
            processFn: async (inputPath, ext, context) => {
                const gifInput = await isGifInput(inputPath, ext, context);
                const outputPath = createTempPath(gifInput ? 'gif' : 'mp4');
                const outputOptions = gifInput ? null : await mp4OutputOptions(inputPath);
                await runFFmpeg(inputPath, outputPath, cmd => {
                    cmd.videoFilters(`fps=${targetFps}`);
                    if (gifInput) applyGifOutput(cmd);
                    else applyMp4Output(cmd, outputOptions);
                });
                return outputPath;
            },
        });
    },
};

// Sets how many times a GIF loops (-1 = no loop, 0 = infinite, N = N times).
const gifloop = {
    data: new SlashCommandBuilder()
        .setName('gifloop')
        .setDescription('Change how many times a GIF loops')
        .addIntegerOption(opt =>
            opt.setName('count').setDescription('Loop count (-1 = play once, 0 = forever, N = N loops)').setRequired(true).setMinValue(-1).setMaxValue(100)
        )
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('GIF to re-loop (optional: uses recent media if omitted)').setRequired(false)
        ),
    async execute(interaction) {
        const count = interaction.options.getInteger('count');
        await handleMediaCommand(interaction, {
            allowImage: true, allowVideo: false,
            // GIF only — re-looping a non-animated input is meaningless.
            mediaPredicate: (info) => info.ext === 'gif' || info.isGifLike,
            invalidMediaMessage: 'This command works on GIFs only.',
            // The loop count is a container flag; don't normalize/re-encode the input.
            normalizeInput: false,
            processFn: async (inputPath) => {
                const outputPath = createTempPath('gif');
                await runFFmpeg(inputPath, outputPath, cmd => {
                    // -loop is an output option for the gif muxer.
                    cmd.outputOptions(['-loop', String(count)]);
                });
                return outputPath;
            },
        });
    },
};

module.exports = [reverse, speed, trim, mute, loop, addaudio, boomerang, shuffle, fps, gifloop];
