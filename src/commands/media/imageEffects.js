// src/commands/media/imageEffects.js
const { SlashCommandBuilder } = require('discord.js');
const { handleMediaCommand } = require('../../utils/media/mediaHelpers');
const img = require('../../utils/media/imageUtils');

const blur = {
    data: new SlashCommandBuilder()
        .setName('blur')
        .setDescription('Apply a Gaussian blur to an image')
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Image to blur (optional: uses recent media if omitted)').setRequired(false)
        )
        .addNumberOption(opt =>
            opt.setName('amount').setDescription('Blur strength (default 5, max 100)').setMinValue(0.3).setMaxValue(100)
        ),
    async execute(interaction) {
        await handleMediaCommand(interaction, {
            allowImage: true, allowVideo: false,
            processFn: (inputPath, ext) => img.blur(inputPath, interaction.options.getNumber('amount') ?? 5, ext),
        });
    },
};

const invert = {
    data: new SlashCommandBuilder()
        .setName('invert')
        .setDescription('Invert the colors of an image')
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Image to invert (optional: uses recent media if omitted)').setRequired(false)
        ),
    async execute(interaction) {
        await handleMediaCommand(interaction, {
            allowImage: true, allowVideo: false,
            processFn: (inputPath, ext) => img.invert(inputPath, ext),
        });
    },
};

const rotate = {
    data: new SlashCommandBuilder()
        .setName('rotate')
        .setDescription('Rotate an image')
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Image to rotate (optional: uses recent media if omitted)').setRequired(false)
        )
        .addIntegerOption(opt =>
            opt.setName('degrees').setDescription('Degrees to rotate clockwise (default 90)').setRequired(false)
        ),
    async execute(interaction) {
        await handleMediaCommand(interaction, {
            allowImage: true, allowVideo: false,
            processFn: (inputPath, ext) => img.rotate(inputPath, interaction.options.getInteger('degrees') ?? 90, ext),
        });
    },
};

const flip = {
    data: new SlashCommandBuilder()
        .setName('flip')
        .setDescription('Flip an image vertically (upside down)')
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Image to flip (optional: uses recent media if omitted)').setRequired(false)
        ),
    async execute(interaction) {
        await handleMediaCommand(interaction, {
            allowImage: true, allowVideo: false,
            processFn: (inputPath, ext) => img.flip(inputPath, ext),
        });
    },
};

const flop = {
    data: new SlashCommandBuilder()
        .setName('flop')
        .setDescription('Flop an image horizontally (mirror)')
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Image to flop (optional: uses recent media if omitted)').setRequired(false)
        ),
    async execute(interaction) {
        await handleMediaCommand(interaction, {
            allowImage: true, allowVideo: false,
            processFn: (inputPath, ext) => img.flop(inputPath, ext),
        });
    },
};

const resize = {
    data: new SlashCommandBuilder()
        .setName('resize')
        .setDescription('Resize an image (preserves aspect ratio, shrinks only)')
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Image to resize (optional: uses recent media if omitted)').setRequired(false)
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
            return interaction.reply({ content: 'Please provide at least one of `width` or `height`.', ephemeral: true });
        }
        await handleMediaCommand(interaction, {
            allowImage: true, allowVideo: false,
            processFn: (inputPath, ext) => img.resize(inputPath, width, height, ext),
        });
    },
};

const grayscale = {
    data: new SlashCommandBuilder()
        .setName('grayscale')
        .setDescription('Convert an image to grayscale')
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Image to desaturate (optional: uses recent media if omitted)').setRequired(false)
        ),
    async execute(interaction) {
        await handleMediaCommand(interaction, {
            allowImage: true, allowVideo: false,
            processFn: (inputPath, ext) => img.grayscale(inputPath, ext),
        });
    },
};

const deepfry = {
    data: new SlashCommandBuilder()
        .setName('deepfry')
        .setDescription('Apply the deep fry effect to an image')
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Image to deep fry (optional: uses recent media if omitted)').setRequired(false)
        ),
    async execute(interaction) {
        await handleMediaCommand(interaction, {
            allowImage: true, allowVideo: false,
            processFn: (inputPath, ext) => img.deepfry(inputPath, ext),
        });
    },
};

module.exports = [blur, invert, rotate, flip, flop, resize, grayscale, deepfry];
