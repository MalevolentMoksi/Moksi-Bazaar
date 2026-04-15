// src/commands/media/convert.js
const { SlashCommandBuilder } = require('discord.js');
const { handleMediaCommand } = require('../../utils/media/mediaHelpers');
const { toFormat } = require('../../utils/media/imageUtils');
const { runFFmpeg, videoToGif } = require('../../utils/media/ffmpegUtils');
const { createTempPath } = require('../../utils/media/tempFiles');

const topng = {
    data: new SlashCommandBuilder()
        .setName('topng')
        .setDescription('Convert an image to PNG')
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Image to convert (optional: uses recent media if omitted)').setRequired(false)
        ),
    async execute(interaction) {
        await handleMediaCommand(interaction, {
            allowImage: true, allowVideo: false,
            processFn: async (inputPath) => toFormat(inputPath, 'png'),
        });
    },
};

const tojpg = {
    data: new SlashCommandBuilder()
        .setName('tojpg')
        .setDescription('Convert an image to JPG')
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Image to convert (optional: uses recent media if omitted)').setRequired(false)
        ),
    async execute(interaction) {
        await handleMediaCommand(interaction, {
            allowImage: true, allowVideo: false,
            processFn: async (inputPath) => toFormat(inputPath, 'jpeg', { quality: 90 }),
        });
    },
};

const towebp = {
    data: new SlashCommandBuilder()
        .setName('towebp')
        .setDescription('Convert an image to WebP')
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Image to convert (optional: uses recent media if omitted)').setRequired(false)
        ),
    async execute(interaction) {
        await handleMediaCommand(interaction, {
            allowImage: true, allowVideo: false,
            processFn: async (inputPath) => toFormat(inputPath, 'webp', { quality: 90 }),
        });
    },
};

const togif = {
    data: new SlashCommandBuilder()
        .setName('togif')
        .setDescription('Convert a video to a GIF')
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Video to convert (optional: uses recent media if omitted)').setRequired(false)
        )
        .addIntegerOption(opt =>
            opt.setName('fps').setDescription('Frame rate (default 15, max 30)').setMinValue(1).setMaxValue(30)
        )
        .addIntegerOption(opt =>
            opt.setName('width').setDescription('Output width in pixels (default 480)').setMinValue(64).setMaxValue(1280)
        ),
    async execute(interaction) {
        await handleMediaCommand(interaction, {
            allowImage: false, allowVideo: true,
            processFn: async (inputPath) => {
                const fps = interaction.options.getInteger('fps') ?? 15;
                const width = interaction.options.getInteger('width') ?? 480;
                const outputPath = createTempPath('gif');
                await videoToGif(inputPath, outputPath, fps, width);
                return outputPath;
            },
        });
    },
};

const tomp4 = {
    data: new SlashCommandBuilder()
        .setName('tomp4')
        .setDescription('Convert a GIF or video to MP4')
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('GIF or video to convert (optional: uses recent media if omitted)').setRequired(false)
        ),
    async execute(interaction) {
        await handleMediaCommand(interaction, {
            allowImage: true, allowVideo: true,
            processFn: async (inputPath) => {
                const outputPath = createTempPath('mp4');
                await runFFmpeg(inputPath, outputPath, cmd => {
                    cmd
                        .outputOptions([
                            '-vf scale=trunc(iw/2)*2:trunc(ih/2)*2', // ensure even dimensions
                            '-movflags faststart',
                            '-pix_fmt yuv420p',
                        ]);
                });
                return outputPath;
            },
        });
    },
};

module.exports = [topng, tojpg, towebp, togif, tomp4];
