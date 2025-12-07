// src/commands/tools/speak.js - FIXED PARSING & IDENTITY
// ... (Keep your existing imports and GOAT_EMOJIS list) ...
// ... (Keep the buildConversationContext function) ...

// ... Inside module.exports execute ...

      // 1. IDENTITY LOGIC FIX
      const isOwner = userId === "619637817294848012";
      
      // Explicitly tell the AI what the role of the speaker is
      let userRole = "Random User";
      if (isOwner) userRole = "CREATOR (Moksi) - You respect him.";
      else if (activeSpeak === false) userRole = "User (Ignored)"; // Just in case
      else userRole = "Chatter";

      // 2. UPDATED SYSTEM PROMPT
      const systemPrompt = `You are Cooler Moksi.

IDENTITY:
- A cynical, tech-savvy, tired goat AI.
- Tone: Dry, deadpan, slightly rude or sarcastic.
- Speak normally (lowercase). 
- STRICTLY FORBIDDEN: Do NOT use "Zoomer slang" like "fr fr", "no cap".

CURRENT INTERACTION:
- User: ${askerName}
- Role: ${userRole}
- Attitude: ${attitudeInstruction}

REACTION SYSTEM:
1. Write your text reply.
2. STRICT RULE: Do NOT use standard emojis.
3. You can end your message with one of these ID strings to show emotion: [${emojiKeys}].

CHAT LOG:
${conversationContext}

MEMORY:
${memoryText}`;

      // ... (OpenRouter Call remains the same) ...

      const data = await response.json();
      const rawContent = data.choices?.[0]?.message?.content?.trim() || '...';
      
      // 3. FIXED EMOJI PARSING (REGEX METHOD)
      // Instead of relying on lines, we look for the emoji key at the very end of the string
      let replyText = rawContent;
      let finalEmoji = "";

      // Regex looks for a goat emoji key at the end of the string, optionally preceded by newline/space
      // Captures the key (e.g., "goat_exhausted")
      const emojiRegex = new RegExp(`(?:\\s|\\n)(${Object.keys(GOAT_EMOJIS).join('|')})$`, 'i');
      const match = rawContent.match(emojiRegex);

      if (match) {
        const emojiKey = match[1].toLowerCase();
        if (GOAT_EMOJIS[emojiKey]) {
            finalEmoji = GOAT_EMOJIS[emojiKey];
            // Remove the key from the text so we don't duplicate it
            replyText = rawContent.replace(match[0], '').trim(); 
        }
      } else if (rawContent.trim().toLowerCase().endsWith('none')) {
        replyText = rawContent.replace(/none$/i, '').trim();
      }

      // Fallback: If no emoji found, but sentiment is extreme, auto-pick
      if (!finalEmoji) {
         if (sentimentAnalysis.sentiment < -0.6) finalEmoji = GOAT_EMOJIS['goat_exhausted'];
         if (sentimentAnalysis.sentiment > 0.6) finalEmoji = GOAT_EMOJIS['goat_smile'];
      }

      if (!replyText) replyText = "bleat.";

      // ... (Rest of formatting/sending remains the same) ...