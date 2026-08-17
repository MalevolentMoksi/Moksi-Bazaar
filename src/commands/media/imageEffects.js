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

/**
 * Every way /flip can turn a picture, in the order the picker shows them.
 *
 * One list, two jobs: the choices Discord offers and the work each one does,
 * so a direction cannot be offered without something behind it. The first
 * entry is the default, which keeps a bare /flip doing exactly what it always
 * did. The right angles go through the same rotate the /rotate command uses,
 * which pads video back to even dimensions afterwards.
 */
const FLIP_MOVES = [
    { value: 'vertical', name: 'Vertical: upside down', run: (input, ext, ctx) => img.flip(input, ext, ctx) },
    { value: 'horizontal', name: 'Horizontal: mirrored', run: (input, ext, ctx) => img.flop(input, ext, ctx) },
    { value: '90', name: 'Quarter turn: 90 clockwise', run: (input, ext, ctx) => img.rotate(input, 90, ext, ctx) },
    { value: '180', name: 'Half turn: 180', run: (input, ext, ctx) => img.rotate(input, 180, ext, ctx) },
    { value: '270', name: 'Quarter turn: 270 clockwise', run: (input, ext, ctx) => img.rotate(input, 270, ext, ctx) },
];

const flip = {
    data: new SlashCommandBuilder()
        .setName('flip')
        .setDescription('Flip an image, GIF, or video: upside down, mirrored, or turned')
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Image, GIF, or video to flip (optional: uses recent media if omitted)').setRequired(false)
        )
        .addStringOption(opt =>
            opt.setName('direction').setDescription('Which way to turn it (default: vertical)').setRequired(false)
                .addChoices(...FLIP_MOVES.map(({ name, value }) => ({ name, value })))
        ),
    async execute(interaction) {
        const asked = interaction.options.getString('direction');
        const move = FLIP_MOVES.find(m => m.value === asked) ?? FLIP_MOVES[0];
        await handleMediaCommand(interaction, {
            allowImage: true, allowVideo: true,
            processFn: (inputPath, ext, context) => move.run(inputPath, ext, context),
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
