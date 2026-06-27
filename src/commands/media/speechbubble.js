// src/commands/media/speechbubble.js
const { SlashCommandBuilder } = require('discord.js');
const { handleMediaCommand } = require('../../utils/media/mediaHelpers');
const { isGifImage } = require('../../utils/media/mediaProbe');
const {
    renderSpeechBubbleImage,
    renderSpeechBubbleGif,
    renderSpeechBubbleVideo,
    DEFAULT_SCALE,
} = require('../../utils/media/speechBubbleUtils');

const speechbubble = {
    data: new SlashCommandBuilder()
        .setName('speechbubble')
        .setDescription('Add an esmBot-style speech bubble to an image, GIF, or video')
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Image, GIF, or video (optional: uses recent media if omitted)').setRequired(false)
        )
        .addStringOption(opt =>
            opt.setName('position')
                .setDescription('Where to put the bubble (default: top)')
                .addChoices(
                    { name: 'Top', value: 'top' },
                    { name: 'Bottom', value: 'bottom' }
                )
        )
        .addStringOption(opt =>
            opt.setName('color')
                .setDescription('Transparent cuts the bubble out (videos fall back to white). Default: transparent')
                .addChoices(
                    { name: 'Transparent', value: 'transparent' },
                    { name: 'White', value: 'white' },
                    { name: 'Black', value: 'black' }
                )
        )
        .addNumberOption(opt =>
            opt.setName('scale')
                .setDescription('Bubble height as a fraction of the image (0.01–1.0, default 0.2)')
                .setMinValue(0.01)
                .setMaxValue(1.0)
        )
        .addBooleanOption(opt =>
            opt.setName('flip').setDescription('Mirror the bubble horizontally (point the tail the other way)')
        ),
    async execute(interaction) {
        const opts = {
            position: interaction.options.getString('position') ?? 'top',
            color: interaction.options.getString('color') ?? 'transparent',
            scale: interaction.options.getNumber('scale') ?? DEFAULT_SCALE,
            flip: interaction.options.getBoolean('flip') ?? false,
        };
        await handleMediaCommand(interaction, {
            allowImage: true,
            allowVideo: true,
            processFn: async (inputPath, ext, { isVideo, isGifLike }) => {
                const gifInput = isGifLike || ext === 'gif' || await isGifImage(inputPath);
                if (gifInput) {
                    return renderSpeechBubbleGif(inputPath, opts);
                }
                if (isVideo) {
                    return renderSpeechBubbleVideo(inputPath, opts);
                }
                return renderSpeechBubbleImage(inputPath, opts);
            },
        });
    },
};

module.exports = speechbubble;
