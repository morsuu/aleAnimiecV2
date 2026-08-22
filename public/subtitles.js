/* subtitles.js – WebVTT parsing and rendering, shared by viewer and admin.
 *
 * We render cues ourselves instead of using <track>, for two reasons:
 *   1. the offset must be adjustable live, without reloading the file;
 *   2. <track> from another origin (the Render backend) needs crossorigin
 *      plumbing that breaks the moment CORS is slightly off.
 *
 * Loads as a browser global (window.Subtitles) and as a CommonJS module, so the
 * parser can be unit tested in Node. createRenderer needs a DOM; parse does not.
 */
'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.Subtitles = api;
}(typeof globalThis !== 'undefined' && globalThis.document ? globalThis : null, function () {

  const TIMESTAMP = /(\d{1,3}):(\d{2}):(\d{2})[.,](\d{1,3})|(\d{1,3}):(\d{2})[.,](\d{1,3})/;

  /** "01:02:03.456" or "02:03.456" → seconds */
  function parseTimestamp(value) {
    const m = value.trim().match(TIMESTAMP);
    if (!m) return null;
    if (m[1] !== undefined) {
      return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4].padEnd(3, '0')) / 1000;
    }
    return (+m[5]) * 60 + (+m[6]) + (+m[7].padEnd(3, '0')) / 1000;
  }

  const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

  /** Strip cue markup; the renderer inserts text nodes, never HTML. */
  function cleanText(raw) {
    return raw
      .replace(/<[^>]*>/g, '')
      .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] || m)
      .replace(/\{\\[^}]*\}/g, '')   // leftover ASS/SSA overrides
      .trim();
  }

  /**
   * Parse WebVTT into `[{ start, end, lines }]`, sorted by start time.
   * Tolerates SubRip-style commas and missing cue identifiers.
   */
  function parse(text) {
    const cues = [];
    const blocks = String(text)
      .replace(/^﻿/, '')
      .replace(/\r\n?/g, '\n')
      .split(/\n{2,}/);

    blocks.forEach((block) => {
      const lines = block.split('\n').filter((l) => l.trim() !== '');
      if (!lines.length) return;
      if (/^WEBVTT/i.test(lines[0]) && lines.length === 1) return;
      if (/^NOTE\b/i.test(lines[0])) return;

      let timingIndex = lines.findIndex((l) => l.includes('-->'));
      if (timingIndex === -1) return;

      const [rawStart, rawRest] = lines[timingIndex].split('-->');
      const start = parseTimestamp(rawStart);
      const end = parseTimestamp(rawRest || '');
      if (start === null || end === null) return;

      const body = lines.slice(timingIndex + 1).map(cleanText).filter(Boolean);
      if (!body.length) return;

      cues.push({ start, end: Math.max(end, start), lines: body });
    });

    cues.sort((a, b) => a.start - b.start);
    return cues;
  }

  /**
   * Drive a subtitle layer from a playback clock.
   * `layer` is an element positioned over the video.
   */
  function createRenderer(layer) {
    let cues = [];
    let offset = 0;
    let visible = true;
    let renderedKey = null;
    let searchFrom = 0;

    function clearLayer() {
      if (renderedKey === null) return;
      layer.textContent = '';
      layer.classList.add('hidden');
      renderedKey = null;
    }

    function render(active) {
      const key = active.map((c) => c.start).join('|');
      if (key === renderedKey) return;
      renderedKey = key;

      layer.textContent = '';
      if (!active.length) {
        layer.classList.add('hidden');
        return;
      }
      active.forEach((cue) => {
        const box = document.createElement('div');
        box.className = 'subtitle-line';
        cue.lines.forEach((line, i) => {
          if (i) box.appendChild(document.createElement('br'));
          box.appendChild(document.createTextNode(line));
        });
        layer.appendChild(box);
      });
      layer.classList.remove('hidden');
    }

    return {
      setCues(list) {
        cues = Array.isArray(list) ? list : [];
        searchFrom = 0;
        renderedKey = null;
        clearLayer();
      },
      setOffset(value) {
        const n = Number(value);
        offset = Number.isFinite(n) ? n : 0;
        searchFrom = 0;
      },
      getOffset() { return offset; },
      setVisible(on) {
        visible = !!on;
        if (!visible) clearLayer();
        else { renderedKey = null; searchFrom = 0; }
      },
      isVisible() { return visible; },
      hasCues() { return cues.length > 0; },
      clear() {
        cues = [];
        clearLayer();
      },
      /** Call every frame with the video's current time. */
      update(currentTime) {
        if (!visible || !cues.length || !Number.isFinite(currentTime)) {
          clearLayer();
          return;
        }
        const t = currentTime - offset;

        // Cues are sorted, so walk forward from the last hit; reset when the
        // clock jumps backwards (seek).
        if (searchFrom > 0 && cues[searchFrom - 1] && cues[searchFrom - 1].start > t) searchFrom = 0;
        while (searchFrom < cues.length && cues[searchFrom].end < t) searchFrom++;

        const active = [];
        for (let i = searchFrom; i < cues.length; i++) {
          if (cues[i].start > t) break;
          if (cues[i].end >= t) active.push(cues[i]);
        }
        render(active);
      },
    };
  }

  return { parse, createRenderer };
}));
