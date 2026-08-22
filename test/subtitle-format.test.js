'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  decodeSubtitle,
  srtToVtt,
  normalizeToVtt,
  looksLikeSubtitles,
} = require('../lib/subtitle-format');

/** "Zażółć gęślą jaźń" encoded as Windows-1250, the usual Polish .srt encoding. */
const CP1250_POLISH = Buffer.from([
  0x5A, 0x61, 0xBF, 0xF3, 0xB3, 0xE6,             // Zażółć
  0x20,
  0x67, 0xEA, 0x9C, 0x6C, 0xB9,                   // gęślą
  0x20,
  0x6A, 0x61, 0x9F, 0xF1,                         // jaźń
]);

// ── decodeSubtitle ──────────────────────────────────────────────────────────

test('decodeSubtitle: czyta UTF-8 z polskimi znakami', () => {
  const buf = Buffer.from('Zażółć gęślą jaźń', 'utf8');
  assert.strictEqual(decodeSubtitle(buf), 'Zażółć gęślą jaźń');
});

test('decodeSubtitle: usuwa BOM', () => {
  const buf = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('WEBVTT', 'utf8')]);
  assert.strictEqual(decodeSubtitle(buf), 'WEBVTT');
});

test('decodeSubtitle: wraca do Windows-1250, gdy plik nie jest poprawnym UTF-8', () => {
  assert.strictEqual(decodeSubtitle(CP1250_POLISH), 'Zażółć gęślą jaźń');
});

test('decodeSubtitle: czysty ASCII wychodzi bez zmian', () => {
  assert.strictEqual(decodeSubtitle(Buffer.from('plain ascii', 'utf8')), 'plain ascii');
});

// ── srtToVtt ────────────────────────────────────────────────────────────────

test('srtToVtt: dokleja nagłówek WEBVTT', () => {
  const out = srtToVtt('1\n00:00:01,000 --> 00:00:02,000\nCześć\n');
  assert.ok(out.startsWith('WEBVTT\n\n'), `brak nagłówka w: ${JSON.stringify(out)}`);
});

test('srtToVtt: zamienia przecinki na kropki w znacznikach czasu', () => {
  const out = srtToVtt('1\n00:01:02,345 --> 00:01:04,567\nTekst\n');
  assert.match(out, /00:01:02\.345 --> 00:01:04\.567/);
  assert.ok(!out.includes(','), 'przecinek został w znaczniku czasu');
});

test('srtToVtt: nie rusza przecinków w treści napisów', () => {
  const out = srtToVtt('1\n00:00:01,000 --> 00:00:02,000\nTak, jasne\n');
  assert.match(out, /Tak, jasne/);
});

test('srtToVtt: normalizuje CRLF do LF', () => {
  const out = srtToVtt('1\r\n00:00:01,000 --> 00:00:02,000\r\nTekst\r\n');
  assert.ok(!out.includes('\r'), 'zostały znaki CR');
});

test('srtToVtt: obsługuje znaczniki bez wiodących zer w milisekundach', () => {
  const out = srtToVtt('00:00:01,5 --> 00:00:02,25\nTekst');
  assert.match(out, /00:00:01\.5 --> 00:00:02\.25/);
});

// ── normalizeToVtt ──────────────────────────────────────────────────────────

test('normalizeToVtt: konwertuje .srt i zachowuje polskie znaki z Windows-1250', () => {
  const srt = Buffer.concat([
    Buffer.from('1\n00:00:01,000 --> 00:00:02,000\n', 'latin1'),
    CP1250_POLISH,
    Buffer.from('\n', 'latin1'),
  ]);
  const out = normalizeToVtt(srt, 'napisy.srt');
  assert.ok(out.startsWith('WEBVTT'));
  assert.match(out, /00:00:01\.000 --> 00:00:02\.000/);
  assert.match(out, /Zażółć gęślą jaźń/);
});

test('normalizeToVtt: gotowy WebVTT przechodzi bez konwersji', () => {
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nJuż VTT\n';
  const out = normalizeToVtt(Buffer.from(vtt, 'utf8'), 'napisy.vtt');
  assert.strictEqual(out, vtt);
});

test('normalizeToVtt: .vtt bez nagłówka dostaje nagłówek', () => {
  const out = normalizeToVtt(Buffer.from('00:00:01.000 --> 00:00:02.000\nTekst', 'utf8'), 'napisy.vtt');
  assert.ok(out.startsWith('WEBVTT\n\n'));
  assert.match(out, /00:00:01\.000 --> 00:00:02\.000/);
});

test('normalizeToVtt: plik nazwany .srt, a będący VTT, nie jest konwertowany dwa razy', () => {
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nTekst\n';
  const out = normalizeToVtt(Buffer.from(vtt, 'utf8'), 'napisy.srt');
  assert.strictEqual(out.match(/WEBVTT/g).length, 1, 'nagłówek zdublowany');
});

test('normalizeToVtt: plik nazwany .vtt, a będący SubRipem, dostaje konwersję przecinków', () => {
  const srt = '1\n00:00:01,000 --> 00:00:02,000\nTekst\n';
  const out = normalizeToVtt(Buffer.from(srt, 'utf8'), 'napisy.vtt');
  assert.match(out, /00:00:01\.000 --> 00:00:02\.000/);
});

test('normalizeToVtt: brak nazwy pliku nie wywraca konwersji', () => {
  const out = normalizeToVtt(Buffer.from('00:00:01,000 --> 00:00:02,000\nTekst', 'utf8'), undefined);
  assert.ok(out.startsWith('WEBVTT'));
});

test('normalizeToVtt: kończy się dokładnie jedną nową linią', () => {
  const out = normalizeToVtt(Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nTekst\n\n\n', 'utf8'), 'x.srt');
  assert.ok(out.endsWith('Tekst\n'), JSON.stringify(out.slice(-12)));
});

// ── looksLikeSubtitles ──────────────────────────────────────────────────────

test('looksLikeSubtitles: rozpoznaje plik ze znacznikami czasu', () => {
  assert.strictEqual(looksLikeSubtitles('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nTekst'), true);
});

test('looksLikeSubtitles: odrzuca plik bez znaczników', () => {
  assert.strictEqual(looksLikeSubtitles('WEBVTT\n\nto nie są napisy'), false);
});
