// src/commands/media/speechbubble.js
const { SlashCommandBuilder } = require('discord.js');
const { handleMediaCommand } = require('../../utils/media/mediaHelpers');
const { isGifImage } = require('../../utils/media/mediaProbe');
const {
    renderSpeechBubbleImage,
    renderSpeechBubbleGif,
    renderSpeechBubbleVideo,
} = require('../../utils/media/speechBubbleUtils');

const speechbubble = {
    data: new SlashCommandBuilder()
        .setName('speechbubble')
        .setDescription('Add a MediaForge-style speech bubble to an image, GIF, or video')
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
        ),
    async execute(interaction) {
        const position = interaction.options.getString('position') ?? 'top';
        const color = interaction.options.getString('color') ?? 'transparent';
        await handleMediaCommand(interaction, {
            allowImage: true,
            allowVideo: true,
            processFn: async (inputPath, ext, { isVideo, isGifLike }) => {
                const gifInput = isGifLike || ext === 'gif' || await isGifImage(inputPath);
                if (gifInput) {
                    return renderSpeechBubbleGif(inputPath, position, color);
                }
                if (isVideo) {
                    return renderSpeechBubbleVideo(inputPath, position, color);
                }
                return renderSpeechBubbleImage(inputPath, position, color);
            },
        });
    },
};

module.exports = speechbubble;
