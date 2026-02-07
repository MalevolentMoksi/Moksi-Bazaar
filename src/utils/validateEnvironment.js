/**
 * Environment Validation Module
 * Validates configuration and dependencies at startup
 */

const logger = require('./logger');
const { pool } = require('./db');

/**
 * Validates all required environment variables
 * @returns {Object} {valid: boolean, errors: string[]}
 */
function validateEnvironmentVars() {
  const errors = [];
  const required = ['TOKEN', 'DATABASE_URL', 'CLIENT_ID'];
  const optional = ['OPENROUTER_API_KEY', 'OWNER_ID', 'NODE_ENV', 'LOG_LEVEL'];

  logger.info('Validating environment variables...');

  // Check required vars
  for (const varName of required) {
    if (!process.env[varName]) {
      errors.push(`Missing required environment variable: ${varName}`);
    }
  }

  // Warn about optional vars
  for (const varName of optional) {
    if (!process.env[varName]) {
      logger.warn(`Optional environment variable not set: ${varName}`);
    }
  }

  if (errors.length === 0) {
    logger.info('All required environment variables present');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Tests database connectivity
 * @returns {Promise<Object>} {valid: boolean, error?: string}
 */
async function validateDatabaseConnection() {
  logger.info('Testing database connection...');

  try {
    const result = await pool.query('SELECT 1');
    logger.info('Database connection successful');
    return { valid: true };
  } catch (error) {
    const errMsg = `Database connection failed: ${error.message}`;
    logger.error(errMsg);
    return { valid: false, error: errMsg };
  }
}

/**
 * Validates database pool configuration
 * @returns {Object} {valid: boolean, errors: string[]}
 */
function validatePoolConfiguration() {
  logger.info('Validating database pool configuration...');
  const errors = [];

  // Pool configuration is set in db.js - here we just log the current state
  const poolConfig = pool._options || {};
  logger.debug('Pool configuration', {
    max: poolConfig.max,
    min: poolConfig.min,
    idleTimeoutMillis: poolConfig.idleTimeoutMillis,
  });

  if (errors.length === 0) {
    logger.info('Pool configuration valid');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Tests OpenRouter API key (if provided)
 * @returns {Promise<Object>} {valid: boolean, error?: string}
 */
async function validateOpenRouterKey() {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    logger.warn('OPENROUTER_API_KEY not set - LLM features will be unavailable');
    return { valid: true, warning: 'API Key missing' };
  }

  logger.info('Testing OpenRouter API key...');

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://discord.com',
        'X-Title': 'Moksis Bazaar',
      },
      body: JSON.stringify({
        model: 'openrouter/auto',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 10,
      }),
    });

    if (response.ok) {
      logger.info('OpenRouter API key valid');
      return { valid: true };
    } else if (response.status === 401) {
      logger.error('OpenRouter API key invalid (401)');
      return { valid: false, error: 'Invalid API key' };
    } else {
      logger.warn(`OpenRouter API returned status ${response.status}`);
      return { valid: true, warning: `API status: ${response.status}` };
    }
  } catch (error) {
    logger.warn(`Could not validate OpenRouter key: ${error.message}`);
    return { valid: true, warning: 'Could not test key' };
  }
}

/**
 * Runs all startup validations
 * @returns {Promise<Object>} {valid: boolean, errors: string[]}
 */
async function runAllValidations() {
  logger.info('=== Starting Startup Validations ===');

  const results = {
    envVars: validateEnvironmentVars(),
    poolConfig: validatePoolConfiguration(),
    database: await validateDatabaseConnection(),
    openRouter: await validateOpenRouterKey(),
  };

  const allErrors = [
    ...results.envVars.errors,
    ...results.poolConfig.errors,
    ...(results.database.error ? [results.database.error] : []),
  ];

  const valid = allErrors.length === 0;

  if (valid) {
    logger.info('=== All validations passed ===');
  } else {
    logger.error('=== Validation errors detected ===', { errors: allErrors });
  }

  return {
    valid,
    errors: allErrors,
    results,
  };
}

module.exports = {
  validateEnvironmentVars,
  validateDatabaseConnection,
  validatePoolConfiguration,
  validateOpenRouterKey,
  runAllValidations,
};
