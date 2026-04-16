// src/utils/apiHelpers.js - Shared API Call Utilities
const logger = require('./logger');
const { TIMEOUTS } = require('./constants');

// DEPRECATED (April 2026): Groq API removed. All models migrated to OpenRouter.
// - Sentiment: MiMo-V2-Flash (primary) + Groq Llama 8B (fallback) + DeepSeek V3 (safety)
// - Relationships: MiMo-V2-Flash (primary) + Gemma 4 31B (fallback)
// - Chat: DeepSeek V3 (unchanged, kept for personality coherence)
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;


/**
 * Calls OpenRouter API with timeout and error handling
 * @param {string} model - Model identifier (e.g., 'deepseek/deepseek-chat')
 * @param {Array} messages - Array of message objects with role/content
 * @param {Object} options - Configuration options
 * @param {number} options.maxTokens - Max tokens (default: 200)
 * @param {number} options.temperature - Temperature (default: 1.0)
 * @param {number} options.timeout - Timeout in ms (default: 15000)
 * @param {boolean} options.cacheControl - Enable cache control (default: false)
 * @param {string} options.fallbackModel - Fallback model if primary fails
 * @returns {Promise<string|null>} AI response or null on error
 */
async function callOpenRouterAPI(model, messages, options = {}) {
    const {
        maxTokens = 200,
        temperature = 1.0,
        timeout = TIMEOUTS.API_CALL,
        cacheControl = false,
        fallbackModel = null
    } = options;

    if (!OPENROUTER_API_KEY) {
        logger.error('OpenRouter API key not configured');
        return null;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
        const body = {
            model,
            messages,
            max_tokens: maxTokens,
            temperature
        };
        
        // Add cache control if enabled (for large system prompts)
        if (cacheControl) {
            body.cache_control = { type: 'ephemeral' };
        }
        
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://discord.com',
                'X-Title': 'Cooler Moksi'
            },
            body: JSON.stringify(body),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorText = await response.text();
            logger.error('OpenRouter API error', { status: response.status, error: errorText, model });
            
            // Try fallback model if primary failed
            if (fallbackModel && fallbackModel !== model) {
                logger.info('Attempting OpenRouter fallback model', { primary: model, fallback: fallbackModel });
                return await callOpenRouterAPI(fallbackModel, messages, { ...options, fallbackModel: null });
            }
            
            return null;
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content?.trim();
        
        // Remove thinking blocks if present (DeepSeek sometimes adds these)
        const cleanContent = content ? content.replace(/<think>[\s\S]*?<\/think>/g, '').trim() : null;
        
        // Log cache performance if caching was enabled
        if (cacheControl) {
            const cacheReadTokens = response.headers.get('openrouter-x-cache-read-input-tokens') || 0;
            const cacheCreationTokens = response.headers.get('openrouter-x-cache-creation-input-tokens') || 0;
            if (cacheReadTokens > 0 || cacheCreationTokens > 0) {
                logger.debug('OpenRouter cache performance', {
                    model,
                    cacheReadTokens: parseInt(cacheReadTokens),
                    cacheCreationTokens: parseInt(cacheCreationTokens)
                });
            }
        }
        
        if (cleanContent) {
            logger.debug('OpenRouter API success', { model, tokens: maxTokens });
        }

        return cleanContent || null;
    } catch (error) {
        clearTimeout(timeoutId);
        
        if (error.name === 'AbortError') {
            logger.warn('OpenRouter API timeout', { timeout, model });
        } else {
            logger.error('OpenRouter API exception', { error: error.message, model });
        }
        
        return null;
    }
}

/**
 * Determines error type from exception
 * @param {Error} error - The error object
 * @returns {string} Error type constant
 */
function getErrorType(error) {
    if (error.name === 'AbortError') return 'API_TIMEOUT';
    if (error.message.includes('rate limit')) return 'RATE_LIMIT';
    if (error.message.includes('network') || error.code === 'ENOTFOUND') return 'NETWORK_ERROR';
    if (error.message.includes('database') || error.code?.startsWith('PG')) return 'DATABASE_ERROR';
    return 'UNKNOWN_ERROR';
}

module.exports = {
    callOpenRouterAPI,
    getErrorType
};
