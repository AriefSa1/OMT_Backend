/**
 * Performance logging middleware.
 * Logs requests that exceed a slow threshold to stderr (so it doesn't interfere
 * with the Express JSON response stream). Configurable via env.
 *
 * Slow endpoint detection: this is the first line of defense for finding
 * slow Shopee API calls or N+1 query issues before users report latency.
 */
const SLOW_THRESHOLD_MS = Number(process.env.SLOW_THRESHOLD_MS) || 1000; // 1s default

function performanceLogger(req, res, next) {
  const start = Date.now();
  const url = req.originalUrl || req.url;

  res.on('finish', () => {
    const durationMs = Date.now() - start;
    const method = req.method;
    const status = res.statusCode;

    // Log slow requests (above threshold)
    if (durationMs >= SLOW_THRESHOLD_MS) {
      const user = req.user?.id || '-';
      const store = req.query?.store_id || req.query?.storeId || '-';
      console.warn(
        `[PERF] ${method} ${url} -> ${status} | ${durationMs}ms | ` +
        `user=${user} store=${store} ip=${req.ip}`
      );
    }

    // Also emit timing header so frontend can optionally log it too
    res.setHeader('X-Response-Time-ms', String(durationMs));
  });

  next();
}

module.exports = { performanceLogger, SLOW_THRESHOLD_MS };
