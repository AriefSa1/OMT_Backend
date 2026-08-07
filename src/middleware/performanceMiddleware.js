/**
 * Performance logging middleware.
 * Logs requests that exceed a slow threshold to stderr (so it doesn't interfere
 * with the Express JSON response stream). Configurable via env.
 *
 * Slow endpoint detection: this is the first line of defense for finding
 * slow Shopee API calls or N+1 query issues before users report latency.
 *
 * NOTE: The X-Response-Time-ms header is intentionally NOT set here. Setting
 * headers inside res.on('finish') throws ERR_HTTP_HEADERS_SENT (headers are
 * already flushed by the time 'finish' fires), and Express 4 does not emit a
 * reliable 'header' event on the response object. If timing headers are needed,
 * use the `on-headers` package or set them in each controller's response wrapper.
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
  });

  next();
}

module.exports = { performanceLogger, SLOW_THRESHOLD_MS };
