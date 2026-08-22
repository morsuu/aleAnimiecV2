'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { shiftVtt, formatVttTime } = require('../lib/subtitle-format');
const { parse } = require('../public/subtitles.js');

const VTT = [
  'WEBVTT',
  '',
  '1',
  '00:00:01.000 --> 00:00:02.500',
  'Pierwsza linia',
  '',
  '2',
  '00:01:00.000 --> 00:01:02.000',
  'Druga linia',
  '',
].join('\n');

// ── formatVttTime ───────────────────────────────────────────────────────────

test('formatVttTime: zwykla wartosc', () => {
  assert.strictEqual(formatVttTime(3723.25), '01:02:03.250');
});

test('formatVttTime: zero', () => {
  assert.strictEqual(formatVttTime(0), '00:00:00.000');
});

test('formatVttTime: wartosc ujemna przycinana do zera', () => {
  assert.strictEqual(formatVttTime(-5), '00:00:00.000');
});

test('formatVttTime: zaokraglenie milisekund nie robi ":60.000"', () => {
  assert.strictEqual(formatVttTime(1.9996), '00:00:02.000');
});

// ── shiftVtt ────────────────────────────────────────────────────────────────

test('shiftVtt: offset 0 zwraca plik bez zmian', () => {
  assert.strictEqual(shiftVtt(VTT, 0), VTT);
});

test('shiftVtt: nieliczbowy offset zwraca plik bez zmian', () => {
  assert.strictEqual(shiftVtt(VTT, 'abc'), VTT);
  assert.strictEqual(shiftVtt(VTT, NaN), VTT);
});

test('shiftVtt: przesuwa do przodu', () => {
  const out = shiftVtt(VTT, 1.5);
  assert.match(out, /00:00:02\.500 --> 00:00:04\.000/);
  assert.match(out, /00:01:01\.500 --> 00:01:03\.500/);
});

test('shiftVtt: przesuwa do tylu', () => {
  const out = shiftVtt(VTT, -0.5);
  assert.match(out, /00:00:00\.500 --> 00:00:02\.000/);
});

test('shiftVtt: ujemny wynik przycinany do zera, nie do wartosci ujemnej', () => {
  const out = shiftVtt(VTT, -10);
  assert.match(out, /00:00:00\.000 --> 00:00:00\.000/);
  assert.ok(!out.includes('-00:'), 'wyprodukowal ujemny znacznik czasu');
});

test('shiftVtt: nie rusza tekstu napisow', () => {
  const zTekstem = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nSpotkajmy sie o 00:00:05.000\n';
  const out = shiftVtt(zTekstem, 10);
  assert.match(out, /00:00:11\.000 --> 00:00:12\.000/);
  assert.match(out, /Spotkajmy sie o 00:00:05\.000/, 'ruszyl czas w tresci napisu');
});

test('shiftVtt: zachowuje naglowek i identyfikatory', () => {
  const out = shiftVtt(VTT, 2);
  assert.ok(out.startsWith('WEBVTT'));
  assert.match(out, /\n1\n/);
  assert.match(out, /\n2\n/);
});

test('shiftVtt: zachowuje ustawienia po znaczniku czasu', () => {
  const zUstawieniami = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000 align:middle line:90%\nTekst\n';
  const out = shiftVtt(zUstawieniami, 1);
  assert.match(out, /00:00:02\.000 --> 00:00:03\.000 align:middle line:90%/);
});

test('shiftVtt: radzi sobie ze znacznikiem bez godzin', () => {
  const bezGodzin = 'WEBVTT\n\n01:02.500 --> 01:04.000\nTekst\n';
  const out = shiftVtt(bezGodzin, 1);
  assert.match(out, /00:01:03\.500 --> 00:01:05\.000/);
});

// ── zgodnosc z parserem ─────────────────────────────────────────────────────

test('przesuniety plik dalej parsuje sie poprawnie i ma przesuniete czasy', () => {
  const cues = parse(shiftVtt(VTT, 2.25));
  assert.strictEqual(cues.length, 2);
  assert.strictEqual(cues[0].start, 3.25);
  assert.strictEqual(cues[0].end, 4.75);
  assert.deepStrictEqual(cues[0].lines, ['Pierwsza linia']);
  assert.strictEqual(cues[1].start, 62.25);
});

test('przesuniecie tam i z powrotem wraca do oryginalnych czasow', () => {
  const tam = shiftVtt(VTT, 3);
  const zPowrotem = shiftVtt(tam, -3);
  assert.deepStrictEqual(parse(zPowrotem), parse(VTT));
});
