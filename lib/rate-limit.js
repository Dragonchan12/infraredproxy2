const buckets = new Map();

function getWindowConfig() {
  const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS || "60000");
  const max = Number(process.env.RATE_LIMIT_MAX || "60");
  return {
    windowMs: Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 60000,
    max: Number.isFinite(max) && max > 0 ? max : 60
  };
}

export function checkRateLimit(key) {
  const now = Date.now();
  const { windowMs, max } = getWindowConfig();
  const current = buckets.get(key);

  if (!current || now > current.resetAt) {
    const next = {
      count: 1,
      resetAt: now + windowMs
    };
    buckets.set(key, next);
    return {
      ok: true,
      remaining: max - 1,
      resetAt: next.resetAt
    };
  }

  if (current.count >= max) {
    return {
      ok: false,
      remaining: 0,
      resetAt: current.resetAt
    };
  }

  current.count += 1;
  return {
    ok: true,
    remaining: max - current.count,
    resetAt: current.resetAt
  };
}
