// src/utils/apiHelpers.js - Shared API Call Utilities
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const logger = require('./logger');
const { TIMEOUTS } = require('./constants');

const GROQ_API_KEY = process.env.LANGUAGE_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

/**
 * Calls Groq API with timeout and error handling
 * @param {string} prompt - The prompt to send
 * @param {Object} options - Configuration options
 * @param {string} options.model - Model to use (default: llama-3.3-70b-versatile)
 * @param {number} options.maxTokens - Max tokens (default: 150)
 * @param {number} options.temperature - Temperature (default: 0.8)
 * @param {number} options.timeout - Timeout in ms (default: 15000)
 * @returns {Promise<string|null>} AI response or null on error
 */
async function callGroqAPI(prompt, options = {}) {
    const {
        model = 'meta-llama/llama-3.3-70b-versatile',
        maxTokens = 150,
        temperature = 0.8,
        timeout = TIMEOUTS.API_CALL
    } = options;

    if (!GROQ_API_KEY) {
        logger.error('GROQ API key not configured');
        return null;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${GROQ_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model,
                messages: [{ role: 'user', content: prompt }],
                max_tokens: maxTokens,
                temperature
            }),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorText = await response.text();
            logger.error('Groq API error', { status: response.status, error: errorText });
            return null;
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content?.trim();
        
        if (content) {
            logger.debug('Groq API success', { model, tokens: maxTokens, promptLength: prompt.length });
        }

        return content || null;
    } catch (error) {
        clearTimeout(timeoutId);
        
        if (error.name === 'AbortError') {
            logger.warn('Groq API timeout', { timeout, model });
        } else {
            logger.error('Groq API exception', { error: error.message, model });
        }
        
        return null;
    }
}

/**
 * Calls OpenRouter API with timeout and error handling
 * @param {string} model - Model identifier (e.g., 'deepseek/deepseek-chat')
 * @param {Array} messages - Array of message objects with role/content
 * @param {Object} options - Configuration options
 * @param {number} options.maxTokens - Max tokens (default: 200)
 * @param {number} options.temperature - Temperature (default: 1.0)
 * @param {number} options.timeout - Timeout in ms (default: 15000)
 * @returns {Promise<string|null>} AI response or null on error
 */
async function callOpenRouterAPI(model, messages, options = {}) {
    const {
        maxTokens = 200,
        temperature = 1.0,
        timeout = TIMEOUTS.API_CALL
    } = options;

    if (!OPENROUTER_API_KEY) {
        logger.error('OpenRouter API key not configured');
        return null;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://discord.com',
                'X-Title': 'Cooler Moksi'
            },
            body: JSON.stringify({
                model,
                messages,
                max_tokens: maxTokens,
                temperature
            }),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorText = await response.text();
            logger.error('OpenRouter API error', { status: response.status, error: errorText, model });
            return null;
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content?.trim();
        
        // Remove thinking blocks if present (DeepSeek sometimes adds these)
        const cleanContent = content ? content.replace(/<think>[\s\S]*?<\/think>/g, '').trim() : null;
        
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
    callGroqAPI,
    callOpenRouterAPI,
    getErrorType
};
