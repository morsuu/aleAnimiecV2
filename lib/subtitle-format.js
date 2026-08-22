/* subtitle-format.js – decoding and normalising subtitle files to WebVTT.
 *
 * Split out of server.js so the conversion can be unit tested without booting
 * an HTTP server.
 */
'use strict';

const path = require('path');

/**
 * Subtitle files are rarely UTF-8 in the wild – Polish .srt files are usually
 * saved as Windows-1250, which decodes into mojibake if we assume UTF-8.
 * Falls back to latin1, which never throws, if the platform lacks the encoding.
 */
function decodeSubtitle(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^﻿/, '');
  } catch (_) {
    try {
      return new TextDecoder('windows-1250').decode(buffer).replace(/^﻿/, '');
    } catch (__) {
      return buffer.toString('latin1');
    }
  }
}

/** Convert SubRip to WebVTT: comma decimals become dots, plus the header. */
function srtToVtt(text) {
  const body = text
    .replace(/\r\n?/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{1,3})/g, '$1.$2');
  return `WEBVTT\n\n${body.trim()}\n`;
}

/**
 * Take the raw bytes of an uploaded subtitle file and return WebVTT text.
 * Detects the format from the extension and from the content, because plenty of
 * files are named .srt while already being VTT and the other way round.
 */
function normalizeToVtt(buffer, originalName) {
  const text = decodeSubtitle(buffer).replace(/\r\n?/g, '\n').trim();
  const looksLikeVtt = text.startsWith('WEBVTT');
  const isVttName = path.extname(originalName || '').toLowerCase() === '.vtt';

  if (looksLikeVtt) return `${text}\n`;
  // A .vtt file missing its header is still VTT – it just needs one.
  if (isVttName && !/,\d{1,3}\s*-->/.test(text)) return `WEBVTT\n\n${text}\n`;
  return srtToVtt(text);
}

/** Cheap sanity check: anything without a cue timing is not subtitles. */
function looksLikeSubtitles(vttText) {
  return /-->/.test(vttText);
}

/** seconds → "HH:MM:SS.mmm" */
function formatVttTime(seconds) {
  const t = Math.max(0, seconds);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const ms = Math.round((t - Math.floor(t)) * 1000);
  // Rounding 999.6 ms up must not produce ":60.000".
  if (ms === 1000) return formatVttTime(Math.floor(t) + 1);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

const CUE_TIME = /(\d{1,3}):(\d{2}):(\d{2})[.,](\d{1,3})|(\d{1,3}):(\d{2})[.,](\d{1,3})/g;

/**
 * Bake a time offset into the cue timings of a WebVTT file.
 *
 * The Cast receiver fetches subtitles by URL and knows nothing about the offset
 * the admin dialled in, so the shift has to be part of the file it downloads.
 * Only timing lines are touched – cue text is left alone.
 */
function shiftVtt(text, offsetSeconds) {
  const offset = Number(offsetSeconds);
  if (!Number.isFinite(offset) || offset === 0) return text;

  return String(text).split('\n').map((line) => {
    if (!line.includes('-->')) return line;
    return line.replace(CUE_TIME, (match, h, m, s, ms, m2, s2, ms2) => {
      const base = h !== undefined
        ? (+h) * 3600 + (+m) * 60 + (+s) + (+String(ms).padEnd(3, '0')) / 1000
        : (+m2) * 60 + (+s2) + (+String(ms2).padEnd(3, '0')) / 1000;
      return formatVttTime(base + offset);
    });
  }).join('\n');
}

module.exports = {
  decodeSubtitle,
  srtToVtt,
  normalizeToVtt,
  looksLikeSubtitles,
  shiftVtt,
  formatVttTime,
};
