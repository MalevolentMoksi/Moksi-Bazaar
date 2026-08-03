/**
 * Logger Module
 * Structured logging with Winston
 */

const winston = require('winston');
const path = require('path');
const fs = require('fs');
const { LOGGING_CONFIG } = require('./constants');

// Ensure logs directory exists
const logsDir = path.join(__dirname, '../..', 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Define logger format
const customFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

// Create logger
const logger = winston.createLogger({
  level: LOGGING_CONFIG.LEVEL,
  format: customFormat,
  defaultMeta: { service: 'moksis-bazaar' },
  transports: [
    // File transport - all logs
    new winston.transports.File({
      filename: path.join(logsDir, 'bot.log'),
      maxsize: 10485760, // 10MB
      maxFiles: 5,
    }),
    // File transport - errors only
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      maxsize: 10485760,
      maxFiles: 5,
    }),
  ],
});

// Console transport: always on. In production stdout is the only place logs
// survive at all: Railway ingests it, while the files above sit on an
// ephemeral disk that vanishes on every redeploy.
const consoleFormat = process.env.NODE_ENV === 'production'
  ? winston.format.printf(({ level, message, timestamp, ...meta }) => {
      delete meta.service;
      const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
      return `${timestamp} [${level}]: ${message}${metaStr}`;
    })
  : winston.format.combine(
      winston.format.colorize(),
      winston.format.printf(({ level, message, timestamp, ...meta }) => {
        const metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
        return `${timestamp} [${level}]: ${message} ${metaStr}`;
      })
    );
logger.add(new winston.transports.Console({ format: consoleFormat }));

module.exports = logger;
