'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { createAttemptLimiter } = require('../lib/rate-limit');

/** Limiter with a clock we control, so nothing has to sleep. */
function withClock(overrides = {}) {
  let clock = 1_000_000;
  const limiter = createAttemptLimiter({
    maxFails: 3,
    windowMs: 60_000,
    baseLockoutMs: 10_000,
    maxLockoutMs: 40_000,
    now: () => clock,
    ...overrides,
  });
  return {
    limiter,
    advance(ms) { clock += ms; },
    get time() { return clock; },
  };
}

test('nowy klucz nie jest zablokowany', () => {
  const { limiter } = withClock();
  assert.strictEqual(limiter.check('1.2.3.4'), 0);
});

test('próby poniżej progu nie blokują', () => {
  const { limiter } = withClock();
  assert.strictEqual(limiter.fail('ip'), 0);
  assert.strictEqual(limiter.fail('ip'), 0);
  assert.strictEqual(limiter.check('ip'), 0);
});

test('osiągnięcie progu blokuje na bazowy czas', () => {
  const { limiter } = withClock();
  limiter.fail('ip');
  limiter.fail('ip');
  const locked = limiter.fail('ip');           // trzecia = próg
  assert.strictEqual(locked, 10);              // 10 000 ms
  assert.strictEqual(limiter.check('ip'), 10);
});

test('blokada wygasa po upływie czasu', () => {
  const h = withClock();
  h.limiter.fail('ip'); h.limiter.fail('ip'); h.limiter.fail('ip');
  h.advance(9_000);
  assert.strictEqual(h.limiter.check('ip'), 1);
  h.advance(2_000);
  assert.strictEqual(h.limiter.check('ip'), 0);
});

test('kolejne blokady się podwajają', () => {
  const h = withClock();
  const lockFor = () => {
    h.limiter.fail('ip'); h.limiter.fail('ip');
    return h.limiter.fail('ip');
  };
  assert.strictEqual(lockFor(), 10);
  h.advance(11_000);
  assert.strictEqual(lockFor(), 20);
  h.advance(21_000);
  assert.strictEqual(lockFor(), 40);
});

test('podwajanie zatrzymuje się na maxLockoutMs', () => {
  const h = withClock();
  for (let i = 0; i < 6; i++) {
    h.limiter.fail('ip'); h.limiter.fail('ip'); h.limiter.fail('ip');
    h.advance(41_000);
  }
  h.limiter.fail('ip'); h.limiter.fail('ip');
  assert.strictEqual(h.limiter.fail('ip'), 40);  // sufit, nie 320
});

test('poprawne hasło kasuje historię prób', () => {
  const { limiter } = withClock();
  limiter.fail('ip');
  limiter.fail('ip');
  limiter.succeed('ip');
  assert.strictEqual(limiter.fail('ip'), 0);
  assert.strictEqual(limiter.fail('ip'), 0);     // liczy od zera
  assert.strictEqual(limiter.check('ip'), 0);
});

test('nieudane próby starsze niż okno są zapominane', () => {
  const h = withClock();
  h.limiter.fail('ip');
  h.limiter.fail('ip');
  h.advance(61_000);                              // okno minęło
  assert.strictEqual(h.limiter.fail('ip'), 0);
  assert.strictEqual(h.limiter.fail('ip'), 0);
  assert.strictEqual(h.limiter.check('ip'), 0);
});

test('klucze są niezależne', () => {
  const { limiter } = withClock();
  limiter.fail('a'); limiter.fail('a'); limiter.fail('a');
  assert.ok(limiter.check('a') > 0);
  assert.strictEqual(limiter.check('b'), 0);
});

test('blokada przetrwa wygaśnięcie okna', () => {
  const h = withClock({ baseLockoutMs: 120_000, maxLockoutMs: 120_000 });
  h.limiter.fail('ip'); h.limiter.fail('ip'); h.limiter.fail('ip');
  h.advance(61_000);                              // okno minęło, blokada nie
  assert.ok(h.limiter.check('ip') > 0, 'blokada zniknęła razem z oknem');
});

test('sweep usuwa wygasłe wpisy, zostawia zablokowane', () => {
  const h = withClock({ baseLockoutMs: 600_000, maxLockoutMs: 600_000 });
  h.limiter.fail('stary');
  h.limiter.fail('zablokowany'); h.limiter.fail('zablokowany'); h.limiter.fail('zablokowany');
  assert.strictEqual(h.limiter.size(), 2);

  h.advance(61_000);
  h.limiter.sweep();

  assert.strictEqual(h.limiter.size(), 1);
  assert.ok(h.limiter.check('zablokowany') > 0);
});

test('liczba wpisów nie przekracza maxEntries', () => {
  const h = withClock({ maxEntries: 10 });
  for (let i = 0; i < 50; i++) h.limiter.fail(`ip-${i}`);
  assert.ok(h.limiter.size() <= 10, `rozrosło się do ${h.limiter.size()}`);
});
