// src/commands/media/caption.js
const { SlashCommandBuilder } = require('discord.js');
const { handleMediaCommand } = require('../../utils/media/mediaHelpers');
const { renderCaption, renderCaptionVideo, renderCaptionGif, renderMeme, renderMemeGif } = require('../../utils/media/captionUtils');

const caption = {
    data: new SlashCommandBuilder()
        .setName('caption')
        .setDescription('Add a MediaForge-style caption bar to an image, GIF, or video')
        .addStringOption(opt =>
            opt.setName('text').setDescription('Caption text').setRequired(true).setMaxLength(300)
        )
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Image, GIF, or video to caption (optional: uses recent media if omitted)').setRequired(false)
        )
        .addStringOption(opt =>
            opt.setName('position')
                .setDescription('Where to place the caption (default: bottom)')
                .addChoices(
                    { name: 'Bottom', value: 'bottom' },
                    { name: 'Top', value: 'top' }
                )
        ),
    async execute(interaction) {
        const text = interaction.options.getString('text');
        const position = interaction.options.getString('position') ?? 'bottom';
        await handleMediaCommand(interaction, {
            allowImage: true,
            allowVideo: true,
            processFn: (inputPath, ext, { isVideo }) => {
                if (isVideo) {
                    return renderCaptionVideo(inputPath, text, position);
                }
                if (ext === 'gif') {
                    return renderCaptionGif(inputPath, text, position);
                }
                return renderCaption(inputPath, text, position);
            },
        });
    },
};

const meme = {
    data: new SlashCommandBuilder()
        .setName('meme')
        .setDescription('Add classic Impact meme text to an image or GIF')
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Image or GIF to meme-ify (optional: uses recent media if omitted)').setRequired(false)
        )
        .addStringOption(opt =>
            opt.setName('top').setDescription('Top text').setMaxLength(200)
        )
        .addStringOption(opt =>
            opt.setName('bottom').setDescription('Bottom text').setMaxLength(200)
        ),
    async execute(interaction) {
        const topText = interaction.options.getString('top');
        const bottomText = interaction.options.getString('bottom');
        if (!topText && !bottomText) {
            return interaction.reply({ content: 'Please provide at least `top` or `bottom` text.', ephemeral: true });
        }
        await handleMediaCommand(interaction, {
            allowImage: true, allowVideo: false,
            processFn: (inputPath, ext) => {
                if (ext === 'gif') {
                    return renderMemeGif(inputPath, topText, bottomText);
                }
                return renderMeme(inputPath, topText, bottomText);
            },
        });
    },
};

module.exports = [caption, meme];
