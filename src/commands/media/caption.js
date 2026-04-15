// src/commands/media/caption.js
const { SlashCommandBuilder } = require('discord.js');
const { handleMediaCommand } = require('../../utils/media/mediaHelpers');
const { renderCaption, renderMeme } = require('../../utils/media/captionUtils');

const caption = {
    data: new SlashCommandBuilder()
        .setName('caption')
        .setDescription('Add an Impact-style caption bar to an image')
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Image to caption').setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName('text').setDescription('Caption text').setRequired(true).setMaxLength(300)
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
            allowImage: true, allowVideo: false,
            processFn: (inputPath) => renderCaption(inputPath, text, position),
        });
    },
};

const meme = {
    data: new SlashCommandBuilder()
        .setName('meme')
        .setDescription('Add classic Impact meme text to an image')
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Image to meme-ify').setRequired(true)
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
            processFn: (inputPath) => renderMeme(inputPath, topText, bottomText),
        });
    },
};

module.exports = [caption, meme];
