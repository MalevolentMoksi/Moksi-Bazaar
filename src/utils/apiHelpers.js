// src/utils/apiHelpers.js - Shared API Call Utilities
const logger = require('./logger');
const telemetry = require('./telemetry');
const health = require('./health');
const { TIMEOUTS } = require('./constants');

/**
 * How many calls in a row have to fail before the bot admits it out loud.
 *
 * One failure is a provider hiccup and the pipeline already falls back around
 * it. Three in a row means every reply in the server is coming out wrong, and
 * nothing else says so: a dead model looks exactly like a quiet afternoon.
 */
const AI_FAIL_STREAK = 3;
let aiFailures = 0;

/**
 * Every exit from callOpenRouterAPI passes through here, success or not, so
 * this is the whole of the AI's health signal. The fallback path recurses into
 * the same function, which is why a primary failure rescued by a fallback nets
 * out to healthy rather than counting against the streak.
 */
function noteApiOutcome(outcome) {
    if (outcome === 'ok') {
        if (aiFailures >= AI_FAIL_STREAK) health.report('ai', 'ok');
        aiFailures = 0;
        return;
    }
    aiFailures += 1;
    if (aiFailures >= AI_FAIL_STREAK) {
        health.report('ai', 'degraded', `${aiFailures} calls failed in a row`);
    }
}

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
        fallbackModel = null,
        // Overrides for the request-shaping defaults below. Passing null keeps
        // the default; pass an object to replace it wholesale.
        reasoning = null,
        provider = null,
        // {kind, extra}: names this call in telemetry. Rows are only written
        // when a telemetry trace is active (i.e. inside the speak pipeline).
        telemetry: telemetryMeta = null
    } = options;

    if (!OPENROUTER_API_KEY) {
        logger.error('OpenRouter API key not configured');
        return null;
    }

    const startedAt = Date.now();
    const record = (fields) => {
        noteApiOutcome(fields?.outcome);
        return telemetry.logCall({
            kind: telemetryMeta?.kind ?? 'model_call',
            model,
            input: messages,
            latencyMs: Date.now() - startedAt,
            extra: telemetryMeta?.extra ?? null,
            ...fields,
        });
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
        // When caching is enabled, mark the system message as the cache prefix boundary.
        // OpenRouter requires cache_control on the message object itself, not at body root.
        const resolvedMessages = cacheControl
            ? messages.map(msg => msg.role === 'system' ? { ...msg, cache_control: { type: 'ephemeral' } } : msg)
            : messages;

        const body = {
            model,
            messages: resolvedMessages,
            max_tokens: maxTokens,
            temperature,
            // Off unless a caller asks otherwise. The writers and utility
            // models here are hybrid reasoners, and providers that default
            // reasoning ON spend the entire max_tokens budget on thinking
            // that goes to a separate field: finish_reason "length", empty
            // content, full price. Three calls in one traced reply died
            // exactly that way, including the judge, whose 6-token budget
            // cannot survive a single thought. effort "none" is OpenRouter's
            // documented "disables reasoning entirely" form; exclude would
            // merely hide the thinking while still paying for it.
            reasoning: reasoning ?? { effort: 'none' },
            // Without a sort OpenRouter load-balances by price, which is how
            // a reply got routed to a host generating at 2 tokens/second
            // while the same model did 121/s elsewhere. At this bot's token
            // counts the price spread between providers is noise.
            provider: provider ?? { sort: 'throughput' },
            // Usage accounting: the response reports real token counts and the
            // actual dollar cost, so telemetry records facts, not estimates.
            usage: { include: true }
        };

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

        // The timer stays armed until the BODY is consumed, not just the
        // headers. A provider can answer 200 in half a second and then
        // trickle tokens for a minute; clearing here made the timeout a
        // time-to-first-byte check and let one such call hold a reply
        // hostage for 61 seconds. The abort signal covers the body reads
        // below, and the finally clears the timer on every exit.
        if (!response.ok) {
            const errorText = await response.text();
            logger.error('OpenRouter API error', { status: response.status, error: errorText, model });
            record({ outcome: `http_${response.status}`, error: errorText.slice(0, 300) });

            // Try fallback model if primary failed
            if (fallbackModel && fallbackModel !== model) {
                logger.info('Attempting OpenRouter fallback model', { primary: model, fallback: fallbackModel });
                return await callOpenRouterAPI(fallbackModel, messages, {
                    ...options,
                    fallbackModel: null,
                    telemetry: telemetryMeta
                        ? { ...telemetryMeta, extra: { ...(telemetryMeta.extra ?? {}), fallbackFor: model } }
                        : null,
                });
            }

            return null;
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content?.trim();

        // Remove thinking blocks if present (DeepSeek sometimes adds these)
        const cleanContent = content ? content.replace(/<think>[\s\S]*?<\/think>/g, '').trim() : null;

        const usage = data.usage ?? {};
        record({
            output: cleanContent,
            tokensIn: Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : null,
            tokensOut: Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : null,
            costUsd: Number.isFinite(usage.cost) ? usage.cost : null,
            outcome: cleanContent ? 'ok' : 'empty',
        });

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
        if (error.name === 'AbortError') {
            logger.warn('OpenRouter API timeout', { timeout, model });
            record({ outcome: 'timeout', error: `timed out after ${timeout}ms` });
        } else {
            logger.error('OpenRouter API exception', { error: error.message, model });
            record({ outcome: 'exception', error: error.message });
        }

        return null;
    } finally {
        clearTimeout(timeoutId);
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
