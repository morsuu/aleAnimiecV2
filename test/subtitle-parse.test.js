'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parse } = require('../public/subtitles.js');
const { normalizeToVtt } = require('../lib/subtitle-format');

test('parse: pojedynczy blok z identyfikatorem', () => {
  const cues = parse('WEBVTT\n\n1\n00:00:01.500 --> 00:00:03.000\nCześć\n');
  assert.deepStrictEqual(cues, [{ start: 1.5, end: 3, lines: ['Cześć'] }]);
});

test('parse: blok bez identyfikatora', () => {
  const cues = parse('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nTekst\n');
  assert.strictEqual(cues.length, 1);
  assert.strictEqual(cues[0].start, 1);
});

test('parse: napisy wielolinijkowe zachowują podział', () => {
  const cues = parse('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nPierwsza\nDruga\n');
  assert.deepStrictEqual(cues[0].lines, ['Pierwsza', 'Druga']);
});

test('parse: znacznik bez godzin (MM:SS.mmm)', () => {
  const cues = parse('WEBVTT\n\n01:02.500 --> 01:04.000\nTekst\n');
  assert.strictEqual(cues[0].start, 62.5);
  assert.strictEqual(cues[0].end, 64);
});

test('parse: znacznik z godzinami liczy poprawnie', () => {
  const cues = parse('WEBVTT\n\n01:02:03.250 --> 01:02:04.000\nTekst\n');
  assert.strictEqual(cues[0].start, 3723.25);
});

test('parse: przecinki w znacznikach (surowy SubRip) też działają', () => {
  const cues = parse('1\n00:00:01,250 --> 00:00:02,000\nTekst\n');
  assert.strictEqual(cues[0].start, 1.25);
});

test('parse: ustawienia po znaczniku czasu są ignorowane', () => {
  const cues = parse('WEBVTT\n\n00:00:01.000 --> 00:00:02.000 align:middle line:90%\nTekst\n');
  assert.strictEqual(cues.length, 1);
  assert.strictEqual(cues[0].end, 2);
  assert.deepStrictEqual(cues[0].lines, ['Tekst']);
});

test('parse: bloki NOTE są pomijane', () => {
  const cues = parse('WEBVTT\n\nNOTE to jest komentarz\nz drugą linią\n\n00:00:01.000 --> 00:00:02.000\nTekst\n');
  assert.strictEqual(cues.length, 1);
  assert.deepStrictEqual(cues[0].lines, ['Tekst']);
});

test('parse: bloki bez znacznika czasu są pomijane', () => {
  const cues = parse('WEBVTT\n\nsam smieciowy tekst\n\n00:00:01.000 --> 00:00:02.000\nTekst\n');
  assert.strictEqual(cues.length, 1);
});

test('parse: blok bez treści jest pomijany', () => {
  const cues = parse('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n\n00:00:03.000 --> 00:00:04.000\nTekst\n');
  assert.strictEqual(cues.length, 1);
  assert.strictEqual(cues[0].start, 3);
});

test('parse: znaczniki wewnętrzne są usuwane, tekst zostaje', () => {
  const cues = parse('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<i>Kursywa</i> i <b>pogrubienie</b>\n');
  assert.deepStrictEqual(cues[0].lines, ['Kursywa i pogrubienie']);
});

test('parse: encje HTML są odkodowane', () => {
  const cues = parse('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nJan &amp; Ola &lt;3\n');
  assert.deepStrictEqual(cues[0].lines, ['Jan & Ola <3']);
});

test('parse: cue są posortowane po czasie startu', () => {
  const cues = parse([
    'WEBVTT', '',
    '00:00:05.000 --> 00:00:06.000', 'Druga', '',
    '00:00:01.000 --> 00:00:02.000', 'Pierwsza', '',
  ].join('\n'));
  assert.deepStrictEqual(cues.map((c) => c.lines[0]), ['Pierwsza', 'Druga']);
});

test('parse: koniec wcześniejszy niż początek jest przycinany do początku', () => {
  const cues = parse('WEBVTT\n\n00:00:05.000 --> 00:00:01.000\nTekst\n');
  assert.strictEqual(cues[0].end, 5);
});

test('parse: CRLF i BOM nie przeszkadzają', () => {
  const cues = parse('﻿WEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000\r\nTekst\r\n');
  assert.strictEqual(cues.length, 1);
  assert.deepStrictEqual(cues[0].lines, ['Tekst']);
});

test('parse: pusty plik daje pustą listę', () => {
  assert.deepStrictEqual(parse(''), []);
  assert.deepStrictEqual(parse('WEBVTT'), []);
});

test('parse: wiele pustych linii między blokami', () => {
  const cues = parse('WEBVTT\n\n\n\n00:00:01.000 --> 00:00:02.000\nA\n\n\n\n00:00:03.000 --> 00:00:04.000\nB\n');
  assert.strictEqual(cues.length, 2);
});

// ── pełna ścieżka: bajty z uploadu → cue gotowe do wyświetlenia ─────────────

test('pełna ścieżka: .srt w Windows-1250 → normalizeToVtt → parse', () => {
  const srt = Buffer.concat([
    Buffer.from('1\n00:00:00,200 --> 00:00:01,000\n', 'latin1'),
    // "Zażółć gęślą jaźń" w cp1250
    Buffer.from([0x5A, 0x61, 0xBF, 0xF3, 0xB3, 0xE6, 0x20,
                 0x67, 0xEA, 0x9C, 0x6C, 0xB9, 0x20,
                 0x6A, 0x61, 0x9F, 0xF1]),
    Buffer.from('\ndruga linia\n\n2\n00:00:01,000 --> 00:00:01,700\nKoniec\n', 'latin1'),
  ]);

  const cues = parse(normalizeToVtt(srt, 'napisy.srt'));

  assert.strictEqual(cues.length, 2);
  assert.deepStrictEqual(cues[0], {
    start: 0.2,
    end: 1,
    lines: ['Zażółć gęślą jaźń', 'druga linia'],
  });
  assert.deepStrictEqual(cues[1], { start: 1, end: 1.7, lines: ['Koniec'] });
});
