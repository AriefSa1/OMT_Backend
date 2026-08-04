/**
 * Express 4 does not catch rejections from async route handlers. An unhandled rejection
 * leaves the request without a response, so the client waits until it times out — and
 * the frontend cannot detect that, because `fetch` never rejects on a hanging request.
 *
 * asyncHandler forwards any rejection to Express's error pipeline instead.
 */
function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    return Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Wraps every function on a controller's exports object. Applied even to handlers that
 * already have try/catch — a throw raised inside the catch block would otherwise escape.
 */
function wrapHandlers(handlers) {
  return Object.fromEntries(
    Object.entries(handlers).map(([name, handler]) => [
      name,
      typeof handler === 'function' ? asyncHandler(handler) : handler,
    ])
  );
}

module.exports = { asyncHandler, wrapHandlers };
