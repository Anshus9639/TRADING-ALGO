const RATE_LIMITED_MESSAGE = 'Too many requests. Please wait and retry.';

function retryAfterSeconds(req, windowMs) {
  const resetTime = req.rateLimit && req.rateLimit.resetTime;
  const resetMs = resetTime instanceof Date ? resetTime.getTime() : Number(resetTime);
  if (Number.isFinite(resetMs) && resetMs > 0) {
    return Math.max(1, Math.ceil((resetMs - Date.now()) / 1000));
  }
  return Math.max(1, Math.ceil(windowMs / 1000));
}

function rateLimitHandler(message = RATE_LIMITED_MESSAGE) {
  return (req, res, _next, options) => {
    res.set('Retry-After', String(retryAfterSeconds(req, options.windowMs)));
    res.status(options.statusCode).json({
      success: false,
      code: 'RATE_LIMITED',
      message
    });
  };
}

// Options shared by every route-level express-rate-limit instance. Routers call
// `rateLimit(rateLimitOptions(...))` directly so the middleware is explicit in
// the Express chain.
//
// The default store is in memory, so limits are enforced per process. A
// multi-instance deployment would need a shared store (for example Redis) to
// keep the effective limit consistent across instances.
function rateLimitOptions({ windowMs, max, keyGenerator, message } = {}) {
  if (!Number.isFinite(max) || max <= 0 || !Number.isFinite(windowMs) || windowMs <= 0) {
    throw new TypeError('rateLimitOptions requires a positive max and windowMs.');
  }

  const options = {
    windowMs,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: rateLimitHandler(message)
  };

  if (typeof keyGenerator === 'function') options.keyGenerator = keyGenerator;

  return options;
}

// Authenticated routes pass this key so one user cannot exhaust another
// user's budget. Public auth routes keep the library's IP key, which uses
// Express `trust proxy` according to the deployment topology.
function userRateLimitKey(req) {
  return String(req.user.id);
}

module.exports = {
  RATE_LIMITED_MESSAGE,
  rateLimitHandler,
  rateLimitOptions,
  userRateLimitKey
};
