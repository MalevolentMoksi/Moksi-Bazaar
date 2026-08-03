// src/utils/trend.js - Single source of truth for sentiment trend math.
//
// This logic used to live twice: checkrelationship.js (threshold 0.15,
// minimum 3 points) and embedBuilder.js (threshold 0.1, minimum 2 points).
// The two copies drifted, so /checkrelation and /stats could disagree about
// the same history. checkrelationship's semantics are kept as canonical:
// 0.15 is the deliberate choice (0.1 flips the label on ordinary noise),
// and fewer than 3 points is not enough evidence to call a direction at all.
// Call sites keep their own display shapes; this module only classifies.

const TREND_THRESHOLD = 0.15;
const MIN_HISTORY = 3;

/**
 * Classifies a sentiment history's direction.
 *
 * Compares the average of the last 3 values against the average of everything
 * before them. With exactly 3 points there is no "older" baseline, so the
 * delta is zero and the result is 'stable'.
 *
 * @param {number[]} values - Sentiment scores, oldest first.
 * @returns {'rising'|'falling'|'stable'|null} null when history is too short.
 */
function trendDirection(values) {
  if (!Array.isArray(values) || values.length < MIN_HISTORY) return null;

  const recent = values.slice(-3);
  const older = values.slice(0, -3);
  const avg = arr => arr.reduce((sum, v) => sum + v, 0) / arr.length;

  const recentAvg = avg(recent);
  const olderAvg = older.length ? avg(older) : recentAvg;
  const delta = recentAvg - olderAvg;

  if (delta > TREND_THRESHOLD) return 'rising';
  if (delta < -TREND_THRESHOLD) return 'falling';
  return 'stable';
}

module.exports = { TREND_THRESHOLD, MIN_HISTORY, trendDirection };
