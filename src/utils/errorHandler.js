// src/utils/errorHandler.js - Centralized Error Handling
const logger = require('./logger');
const { MessageFlags } = require('discord.js');

/**
 * Error types with user-friendly messages
 */
const ERROR_MESSAGES = {
    API_TIMEOUT: 'My brain timed out. The AI servers might be slow right now. Try again?',
    RATE_LIMIT: 'I\'m talking too much today. Try again in a bit.',
    NETWORK_ERROR: 'Can\'t reach the AI servers. Check your connection or try later.',
    DATABASE_ERROR: 'Database hiccup. This has been logged. Try again?',
    BLACKLISTED: 'You\'re blocked from using this command. Contact an admin if you believe this is an error.',
    INSUFFICIENT_FUNDS: 'You don\'t have enough money for that.',
    INVALID_INPUT: 'That input doesn\'t look right. Check your command and try again.',
    PERMISSION_DENIED: 'You don\'t have permission to do that.',
    MEDIA_ANALYSIS_FAILED: 'Couldn\'t analyze that image. It might be too large or in an unsupported format.',
    UNKNOWN_ERROR: 'Something broke. This has been logged.'
};

/**
 * Handles command errors with logging and user-friendly responses
 * @param {Interaction} interaction - Discord interaction
 * @param {Error} error - Error object
 * @param {Object} context - Additional context for logging
 * @param {string} errorType - Optional explicit error type
 */
async function handleCommandError(interaction, error, context = {}, errorType = null) {
    // Determine error type
    const type = errorType || determineErrorType(error);
    
    // Log structured error
    logger.error('Command error', {
        command: interaction.commandName,
        user: interaction.user.id,
        guild: interaction.guild?.id,
        errorType: type,
        message: error.message,
        stack: error.stack,
        ...context
    });

    // Get user-friendly message
    const userMessage = ERROR_MESSAGES[type] || ERROR_MESSAGES.UNKNOWN_ERROR;

    // Send response (try both methods in case reply was already sent)
    try {
        if (interaction.replied || interaction.deferred) {
            await interaction.editReply({
                content: userMessage,
                flags: MessageFlags.Ephemeral
            });
        } else {
            await interaction.reply({
                content: userMessage,
                flags: MessageFlags.Ephemeral
            });
        }
    } catch (replyError) {
        logger.error('Failed to send error message to user', {
            originalError: type,
            replyError: replyError.message
        });
    }
}

/**
 * Determines error type from error object
 * @param {Error} error - Error to analyze
 * @returns {string} Error type constant
 */
function determineErrorType(error) {
    if (!error) return 'UNKNOWN_ERROR';
    
    const message = error.message?.toLowerCase() || '';
    const code = error.code?.toUpperCase() || '';

    if (error.name === 'AbortError' || message.includes('timeout')) {
        return 'API_TIMEOUT';
    }
    if (message.includes('rate limit') || code === 'RATE_LIMIT') {
        return 'RATE_LIMIT';
    }
    if (message.includes('network') || code === 'ENOTFOUND' || code === 'ETIMEDOUT') {
        return 'NETWORK_ERROR';
    }
    if (code?.startsWith('PG') || message.includes('database') || message.includes('pool')) {
        return 'DATABASE_ERROR';
    }
    if (message.includes('permission') || message.includes('forbidden')) {
        return 'PERMISSION_DENIED';
    }
    if (message.includes('blacklist')) {
        return 'BLACKLISTED';
    }

    return 'UNKNOWN_ERROR';
}

/**
 * Gets user-friendly error message for a given type
 * @param {string} errorType - Error type constant
 * @returns {string} User-friendly message
 */
function getErrorMessage(errorType) {
    return ERROR_MESSAGES[errorType] || ERROR_MESSAGES.UNKNOWN_ERROR;
}

/**
 * Logs warning without sending user message
 * @param {string} message - Warning message
 * @param {Object} context - Additional context
 */
function logWarning(message, context = {}) {
    logger.warn(message, context);
}

/**
 * Sends a simple error reply
 * @param {Interaction} interaction - Discord interaction
 * @param {string} message - Custom error message
 * @param {boolean} ephemeral - Whether reply should be ephemeral
 */
async function sendError(interaction, message, ephemeral = true) {
    const flags = ephemeral ? MessageFlags.Ephemeral : undefined;
    
    try {
        if (interaction.replied || interaction.deferred) {
            await interaction.editReply({ content: message, flags });
        } else {
            await interaction.reply({ content: message, flags });
        }
    } catch (error) {
        logger.error('Failed to send simple error', { error: error.message });
    }
}

module.exports = {
    handleCommandError,
    determineErrorType,
    getErrorMessage,
    logWarning,
    sendError,
    ERROR_MESSAGES
};
