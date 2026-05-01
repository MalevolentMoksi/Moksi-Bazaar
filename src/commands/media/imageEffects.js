// src/commands/media/imageEffects.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { handleMediaCommand } = require('../../utils/media/mediaHelpers');
const img = require('../../utils/media/imageUtils');

const blur = {
    data: new SlashCommandBuilder()
        .setName('blur')
        .setDescription('Apply a Gaussian blur to an image, GIF, or video')
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Image, GIF, or video to blur (optional: uses recent media if omitted)').setRequired(false)
        )
        .addNumberOption(opt =>
            opt.setName('amount').setDescription('Blur strength (default 5, max 100)').setMinValue(0.3).setMaxValue(100)
        ),
    async execute(interaction) {
        await handleMediaCommand(interaction, {
            allowImage: true, allowVideo: true,
            processFn: (inputPath, ext, context) => img.blur(inputPath, interaction.options.getNumber('amount') ?? 5, ext, context),
        });
    },
};

const invert = {
    data: new SlashCommandBuilder()
        .setName('invert')
        .setDescription('Invert the colors of an image, GIF, or video')
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Image, GIF, or video to invert (optional: uses recent media if omitted)').setRequired(false)
        ),
    async execute(interaction) {
        await handleMediaCommand(interaction, {
            allowImage: true, allowVideo: true,
            processFn: (inputPath, ext, context) => img.invert(inputPath, ext, context),
        });
    },
};

const rotate = {
    data: new SlashCommandBuilder()
        .setName('rotate')
        .setDescription('Rotate an image, GIF, or video')
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Image, GIF, or video to rotate (optional: uses recent media if omitted)').setRequired(false)
        )
        .addIntegerOption(opt =>
            opt.setName('degrees').setDescription('Degrees to rotate clockwise (default 90)').setRequired(false)
        ),
    async execute(interaction) {
        await handleMediaCommand(interaction, {
            allowImage: true, allowVideo: true,
            processFn: (inputPath, ext, context) => img.rotate(inputPath, interaction.options.getInteger('degrees') ?? 90, ext, context),
        });
    },
};

const flip = {
    data: new SlashCommandBuilder()
        .setName('flip')
        .setDescription('Flip an image, GIF, or video vertically')
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Image, GIF, or video to flip (optional: uses recent media if omitted)').setRequired(false)
        ),
    async execute(interaction) {
        await handleMediaCommand(interaction, {
            allowImage: true, allowVideo: true,
            processFn: (inputPath, ext, context) => img.flip(inputPath, ext, context),
        });
    },
};

const flop = {
    data: new SlashCommandBuilder()
        .setName('flop')
        .setDescription('Flop an image, GIF, or video horizontally')
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Image, GIF, or video to flop (optional: uses recent media if omitted)').setRequired(false)
        ),
    async execute(interaction) {
        await handleMediaCommand(interaction, {
            allowImage: true, allowVideo: true,
            processFn: (inputPath, ext, context) => img.flop(inputPath, ext, context),
        });
    },
};

const resize = {
    data: new SlashCommandBuilder()
        .setName('resize')
        .setDescription('Resize an image, GIF, or video')
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Image, GIF, or video to resize (optional: uses recent media if omitted)').setRequired(false)
        )
        .addIntegerOption(opt =>
            opt.setName('width').setDescription('Target width in pixels').setMinValue(1).setMaxValue(4096)
        )
        .addIntegerOption(opt =>
            opt.setName('height').setDescription('Target height in pixels').setMinValue(1).setMaxValue(4096)
        ),
    async execute(interaction) {
        const width = interaction.options.getInteger('width');
        const height = interaction.options.getInteger('height');
        if (!width && !height) {
            return interaction.reply({ content: 'Please provide at least one of `width` or `height`.', flags: MessageFlags.Ephemeral });
        }
        await handleMediaCommand(interaction, {
            allowImage: true, allowVideo: true,
            processFn: (inputPath, ext, context) => img.resize(inputPath, width, height, ext, context),
        });
    },
};

const grayscale = {
    data: new SlashCommandBuilder()
        .setName('grayscale')
        .setDescription('Convert an image, GIF, or video to grayscale')
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Image, GIF, or video to desaturate (optional: uses recent media if omitted)').setRequired(false)
        ),
    async execute(interaction) {
        await handleMediaCommand(interaction, {
            allowImage: true, allowVideo: true,
            processFn: (inputPath, ext, context) => img.grayscale(inputPath, ext, context),
        });
    },
};

const deepfry = {
    data: new SlashCommandBuilder()
        .setName('deepfry')
        .setDescription('Apply the deep fry effect to an image, GIF, or video')
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Image, GIF, or video to deep fry (optional: uses recent media if omitted)').setRequired(false)
        ),
    async execute(interaction) {
        await handleMediaCommand(interaction, {
            allowImage: true, allowVideo: true,
            processFn: (inputPath, ext, context) => img.deepfry(inputPath, ext, context),
        });
    },
};

module.exports = [blur, invert, rotate, flip, flop, resize, grayscale, deepfry];
