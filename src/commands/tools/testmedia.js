// src/commands/tools/testmedia.js - Quick test for media processing

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { processMediaInMessage, getMediaAnalysisProvider } = require('../../utils/db.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('testmedia')
    .setDescription('Test media analysis on recent messages (admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  async execute(interaction) {
    await interaction.deferReply();

    try {
      // Check current media provider setting
      const provider = await getMediaAnalysisProvider();
      console.log(`[TEST MEDIA] Current provider: ${provider}`);

      // Get recent messages
      const messages = await interaction.channel.messages.fetch({ limit: 5 });
      console.log(`[TEST MEDIA] Fetched ${messages.size} messages`);

      let results = [];
      results.push(`**Media Analysis Test**`);
      results.push(`Provider: ${provider}`);
      results.push(`Messages checked: ${messages.size}`);
      results.push('');

      // Process each message
      for (const [messageId, message] of messages) {
        if (message.author.bot) continue;

        const author = message.member?.displayName || message.author.username;
        console.log(`[TEST MEDIA] Processing message from ${author}`);
        console.log(`[TEST MEDIA] - Attachments: ${message.attachments?.size || 0}`);
        console.log(`[TEST MEDIA] - Embeds: ${message.embeds?.length || 0}`);
        console.log(`[TEST MEDIA] - Content length: ${message.content?.length || 0}`);

        // Check for attachments
        if (message.attachments && message.attachments.size > 0) {
          results.push(`📎 **${author}** has ${message.attachments.size} attachment(s):`);

          for (const [attachmentId, attachment] of message.attachments) {
            results.push(`  - ${attachment.name} (${attachment.contentType || 'unknown type'})`);
            results.push(`  - Size: ${(attachment.size / 1024).toFixed(1)}KB`);
            results.push(`  - URL: ${attachment.url.substring(0, 100)}...`);
          }
        }

        // Check for embeds
        if (message.embeds && message.embeds.length > 0) {
          results.push(`🖼️ **${author}** has ${message.embeds.length} embed(s):`);

          message.embeds.forEach((embed, i) => {
            if (embed.image?.url) {
              results.push(`  - Embed ${i+1} image: ${embed.image.url.substring(0, 80)}...`);
            }
            if (embed.thumbnail?.url) {
              results.push(`  - Embed ${i+1} thumbnail: ${embed.thumbnail.url.substring(0, 80)}...`);
            }
          });
        }

        // Check for custom emojis
        if (message.content) {
          const customEmojiRegex = /<a?:([^:]+):(\d+)>/g;
          let emojiMatches = [];
          let match;

          while ((match = customEmojiRegex.exec(message.content)) !== null) {
            emojiMatches.push(`${match[1]} (ID: ${match[2]})`);
          }

          if (emojiMatches.length > 0) {
            results.push(`😀 **${author}** has ${emojiMatches.length} custom emoji(s):`);
            emojiMatches.forEach(emoji => {
              results.push(`  - ${emoji}`);
            });
          }
        }

        // Try processing media
        console.log(`[TEST MEDIA] Attempting to process media for message from ${author}`);
        try {
          const mediaDescriptions = await processMediaInMessage(message);
          console.log(`[TEST MEDIA] Got ${mediaDescriptions.length} media descriptions:`, mediaDescriptions);

          if (mediaDescriptions.length > 0) {
            results.push(`✅ **Media Analysis Results:**`);
            mediaDescriptions.forEach(desc => {
              results.push(`  ${desc}`);
            });
          } else {
            results.push(`❌ **No media processed** (may be disabled or no analyzable media)`);
          }
        } catch (error) {
          console.error(`[TEST MEDIA] Error processing media:`, error);
          results.push(`❌ **Error processing media:** ${error.message}`);
        }

        results.push(''); // Empty line between messages
      }

      if (results.length === 4) { // Just headers
        results.push('No recent messages with media found.');
      }

      // Split response if too long
      const response = results.join('\n');
      if (response.length > 2000) {
        const chunks = response.match(/[\s\S]{1,1900}/g) || [];
        await interaction.editReply(chunks[0]);

        // Send additional chunks as follow-ups
        for (let i = 1; i < chunks.length && i < 3; i++) {
          await interaction.followUp({ content: chunks[i], ephemeral: true });
        }
      } else {
        await interaction.editReply(response);
      }

    } catch (error) {
      console.error('[TEST MEDIA] Command error:', error);
      await interaction.editReply(`Error: ${error.message}`);
    }
  }
};