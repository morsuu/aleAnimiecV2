/* rate-limit.js – per-key failure tracking with escalating lockouts.
 *
 * Used to slow down password guessing. The clock is injectable so the behaviour
 * can be unit tested without sleeping.
 */
'use strict';

const DEFAULTS = {
  maxFails: 8,                       // failures inside the window before a lockout
  windowMs: 15 * 60 * 1000,          // failures older than this are forgotten
  baseLockoutMs: 60 * 1000,          // first lockout
  maxLockoutMs: 30 * 60 * 1000,      // ceiling for the doubling
  maxEntries: 5000,                  // bound the map so many IPs can't exhaust memory
};

/**
 * @param {Partial<typeof DEFAULTS> & { now?: () => number }} [options]
 */
function createAttemptLimiter(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const now = options.now || Date.now;

  /** @type {Map<string, {fails:number, firstFailAt:number, lockedUntil:number, lockouts:number}>} */
  const entries = new Map();

  /** Seconds the key must wait, or 0 when it may try. */
  function check(key) {
    const rec = entries.get(key);
    if (!rec) return 0;
    const t = now();
    if (rec.lockedUntil > t) return Math.ceil((rec.lockedUntil - t) / 1000);
    if (t - rec.firstFailAt > cfg.windowMs) entries.delete(key);
    return 0;
  }

  /**
   * Record a failed attempt. Returns the seconds the key is now locked out for
   * (0 when it is still below the threshold).
   */
  function fail(key) {
    const t = now();
    let rec = entries.get(key);

    // Start a fresh window when there is no record, or the old one has aged out
    // while not locked.
    if (!rec || (rec.lockedUntil <= t && t - rec.firstFailAt > cfg.windowMs)) {
      rec = { fails: 0, firstFailAt: t, lockedUntil: 0, lockouts: 0 };
      if (entries.size >= cfg.maxEntries) evictOne(t);
      entries.set(key, rec);
    }

    rec.fails += 1;

    if (rec.fails >= cfg.maxFails) {
      rec.lockouts += 1;
      const span = Math.min(cfg.baseLockoutMs * 2 ** (rec.lockouts - 1), cfg.maxLockoutMs);
      rec.lockedUntil = t + span;
      // Counting restarts, but `lockouts` keeps growing so repeat offenders wait
      // longer each time.
      rec.fails = 0;
      rec.firstFailAt = t;
      return Math.ceil(span / 1000);
    }
    return 0;
  }

  /** A correct password clears the key's history. */
  function succeed(key) {
    entries.delete(key);
  }

  /** Drop one expired (or, failing that, arbitrary) record to stay under the cap. */
  function evictOne(t) {
    for (const [key, rec] of entries) {
      if (rec.lockedUntil <= t && t - rec.firstFailAt > cfg.windowMs) {
        entries.delete(key);
        return;
      }
    }
    const first = entries.keys().next();
    if (!first.done) entries.delete(first.value);
  }

  /** Purge records that are neither locked nor inside their window. */
  function sweep() {
    const t = now();
    for (const [key, rec] of entries) {
      if (rec.lockedUntil <= t && t - rec.firstFailAt > cfg.windowMs) entries.delete(key);
    }
  }

  return { check, fail, succeed, sweep, size: () => entries.size };
}

module.exports = { createAttemptLimiter, DEFAULTS };
