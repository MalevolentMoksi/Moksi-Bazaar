// src/commands/media/magick.js
const { SlashCommandBuilder } = require('discord.js');
const { handleMediaCommand } = require('../../utils/media/mediaHelpers');
const { ackPublic, replyPublic } = require('../../utils/interactionAck');
const { isGifImage } = require('../../utils/media/mediaProbe');
const {
    magickAvailable,
    magickImage,
    magickGif,
    magickVideo,
} = require('../../utils/media/magickUtils');

const magick = {
    data: new SlashCommandBuilder()
        .setName('magick')
        .setDescription("Apply ImageMagick's content-aware (liquid) scale: the classic warped \"magik\" effect")
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Image, GIF, or video (optional: uses recent media if omitted)').setRequired(false)
        )
        .addIntegerOption(opt =>
            opt.setName('strength')
                .setDescription('Output is this % of original size; smaller = stronger warp (default 50)')
                .setMinValue(1)
                .setMaxValue(99)
        ),
    async execute(interaction) {
        // Claimed first: the availability check spawns a process to ask
        // ImageMagick its version, and on a cold container that can outlast
        // Discord's three-second window. It is cached, so only the first
        // invocation after a deploy pays for it, which is exactly the one
        // that would fail.
        await ackPublic(interaction);
        if (!(await magickAvailable())) {
            return replyPublic(interaction,
                '⚠️ The `magick` command requires ImageMagick, which is not available on this host. '
                + '(It is enabled in the deployed bot.)');
        }
        const strength = interaction.options.getInteger('strength') ?? 50;
        await handleMediaCommand(interaction, {
            allowImage: true,
            allowVideo: true,
            processFn: async (inputPath, ext, { isVideo, isGifLike }) => {
                const gifInput = isGifLike || ext === 'gif' || await isGifImage(inputPath);
                if (gifInput) {
                    return magickGif(inputPath, strength);
                }
                if (isVideo) {
                    return magickVideo(inputPath, strength);
                }
                return magickImage(inputPath, strength, ext);
            },
        });
    },
};

module.exports = magick;
