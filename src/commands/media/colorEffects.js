// src/commands/media/colorEffects.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { handleMediaCommand } = require('../../utils/media/mediaHelpers');
const img = require('../../utils/media/imageUtils');

// Parse a user-supplied colour: #RRGGBB, RRGGBB, 0xRRGGBB, or a few common names.
const NAMED_COLORS = {
    red: '#ff0000', green: '#00ff00', blue: '#0000ff', white: '#ffffff', black: '#000000',
    yellow: '#ffff00', cyan: '#00ffff', magenta: '#ff00ff', orange: '#ffa500', purple: '#800080',
    pink: '#ffc0cb', gray: '#808080', grey: '#808080',
};
function parseColor(input) {
    if (!input) return null;
    let s = String(input).trim().toLowerCase();
    if (NAMED_COLORS[s]) s = NAMED_COLORS[s];
    s = s.replace(/^#/, '').replace(/^0x/, '');
    if (/^[0-9a-f]{3}$/.test(s)) s = s.split('').map(c => c + c).join('');
    if (!/^[0-9a-f]{6}$/.test(s)) return null;
    return {
        r: parseInt(s.slice(0, 2), 16),
        g: parseInt(s.slice(2, 4), 16),
        b: parseInt(s.slice(4, 6), 16),
    };
}

const hue = {
    data: new SlashCommandBuilder()
        .setName('hue')
        .setDescription('Rotate the hue (colors) of an image, GIF, or video')
        .addIntegerOption(opt =>
            opt.setName('degrees').setDescription('Hue rotation in degrees (0–360, default 180)').setMinValue(0).setMaxValue(360)
        )
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Image, GIF, or video (optional: uses recent media if omitted)').setRequired(false)
        ),
    async execute(interaction) {
        const degrees = interaction.options.getInteger('degrees') ?? 180;
        await handleMediaCommand(interaction, {
            allowImage: true, allowVideo: true,
            processFn: (inputPath, ext, context) => img.hue(inputPath, degrees, ext, context),
        });
    },
};

const tint = {
    data: new SlashCommandBuilder()
        .setName('tint')
        .setDescription('Tint an image, GIF, or video toward a single color')
        .addStringOption(opt =>
            opt.setName('color').setDescription('Color: a hex code (#ff0000) or a name (red, blue, …)').setRequired(true)
        )
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Image, GIF, or video (optional: uses recent media if omitted)').setRequired(false)
        ),
    async execute(interaction) {
        const rgb = parseColor(interaction.options.getString('color'));
        if (!rgb) {
            return interaction.reply({ content: 'Invalid color. Use a hex code like `#ff0000` or a name like `red`.', flags: MessageFlags.Ephemeral });
        }
        await handleMediaCommand(interaction, {
            allowImage: true, allowVideo: true,
            processFn: (inputPath, ext, context) => img.tint(inputPath, rgb, ext, context),
        });
    },
};

const jpeg = {
    data: new SlashCommandBuilder()
        .setName('jpeg')
        .setDescription('Crush an image, GIF, or video into a low-quality JPEG mess')
        .addIntegerOption(opt =>
            opt.setName('strength').setDescription('Compression passes (1–60, default 30) — higher = more destroyed').setMinValue(1).setMaxValue(60)
        )
        .addIntegerOption(opt =>
            opt.setName('quality').setDescription('JPEG quality per pass (1–31, default 10) — lower = worse').setMinValue(1).setMaxValue(31)
        )
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Image, GIF, or video (optional: uses recent media if omitted)').setRequired(false)
        ),
    async execute(interaction) {
        const strength = interaction.options.getInteger('strength') ?? 30;
        const quality = interaction.options.getInteger('quality') ?? 10;
        await handleMediaCommand(interaction, {
            allowImage: true, allowVideo: true,
            processFn: (inputPath, ext, context) => img.jpegify(inputPath, strength, quality, ext, context),
        });
    },
};

module.exports = [hue, tint, jpeg];
