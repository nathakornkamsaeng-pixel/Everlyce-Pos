// ESC/POS, as bytes.
//
// This is the whole reason 2000 supported models is a data problem rather than
// an engineering one. ESC/POS is a de facto standard: Epson, Star, Bixolon,
// Citizen, Sunmi, Rongta, Xprenter and a long tail of OEM rebadges all speak the
// same command set. So there is one driver, parameterised by what a device can
// actually do, and the model table decides those parameters rather than
// selecting code.
//
// The capability parameters come from a printer profile. That is deliberate for
// the awkward ones: which code page number means Thai is firmware dependent, so
// it is a profile setting and not a constant here. Getting it wrong prints
// mojibake, and a driver that hardcodes it would be right for Epson and wrong
// for everyone else.
//
// Byte sequences are asserted exactly in printing/escpos.test.js, so this can be
// verified without a printer.
'use strict';

const iconv = require('iconv-lite');

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;
const CR = 0x0d;
const NUL = 0x00;

const ALIGN = { left: 0, center: 1, right: 2 };

// Commands, named so a job reads like the manual rather than a hex dump.
const CMD = {
  init: [ESC, 0x40],
  standardMode: [GS, 0x76, 0x30],
  align: (n) => [ESC, 0x61, n],
  emphasis: (n) => [ESC, 0x45, n],
  underline: (n) => [ESC, 0x2d, n],
  // Double width and/or double height, as a GS ! bitfield: bits 0-3 are the
  // height scale, bits 4-7 the width scale, and each runs 0..3 for normal, x2,
  // x3, x4. Clamping to 3 threw away x4.
  size: (width = 1, height = 1) => [
    GS, 0x21,
    ((Math.min(4, Math.max(1, width)) - 1) << 4) | (Math.min(4, Math.max(1, height)) - 1),
  ],
  codepage: (n) => [ESC, 0x74, n],
  // ESC 3 sets the exact line spacing in dots, which is how a kitchen ticket
  // gets tighter than a receipt.
  lineSpacing: (dots) => [ESC, 0x32, dots & 0xff, (dots >> 8) & 0xff],
  lineSpacingDefault: [ESC, 0x32],
  feedLines: (n) => [ESC, 0x64, n & 0xff],
  feedDots: (n) => [ESC, 0x64, 0, n & 0xff, 0, 0],
  cut: (partial = true) => (partial ? [GS, 0x56, 0x42, 0x00] : [GS, 0x56, 0x41, 0x00]),
  // Cash drawer on pin 2, the usual one. Timing is a profile concern.
  drawer: (pin = 2, onMs = 0x19, offMs = 0xfa) => [ESC, 0x70, pin, onMs & 0xff, offMs & 0xff],
  bell: (n = 3) => [ESC, 0x42, n],
  status: [ESC, 0x53, 0x01],
};

// A profile fills these in. Defaults are the most common 80mm thermal printer,
// and anything the profile does not state falls back to here rather than to a
// guess baked into the command stream.
const DEFAULT_CAPABILITIES = {
  columns: 48,
  paperWidthMm: 80,
  dpi: 203,
  codePage: 17,          // firmware dependent; set per model
  encoding: 'cp874',
  supportsCut: true,
  supportsDrawer: true,
  supportsImage: true,
  lineSpacingDots: 24,   // roughly 3mm at 203dpi
  cutFeedLines: 3,
};

function caps(profile = {}) {
  // An explicit undefined must not win. Spreading one over the defaults turns
  // "the profile says nothing" into "the value is undefined", and undefined
  // then reaches the command stream as a zero byte: a profile that omitted the
  // code page was sending ESC t 0, which is the wrong charset, not the default.
  const merged = { ...DEFAULT_CAPABILITIES };
  for (const [key, value] of Object.entries(profile || {})) {
    if (value !== undefined && value !== null) merged[key] = value;
  }
  return merged;
}

/**
 * Encode text for the printer.
 *
 * Thai has no spaces between words, so splitting on spaces produces one
 * enormous unprintable line. This wraps on a character budget instead, which is
 * wrong at word boundaries and right everywhere else, and is far better than a
 * single line running off the paper. Breaking inside a Thai word is a known and
 * accepted trade here; a dictionary breaker is the upgrade path.
 */
function encodeText(text, encoding = 'cp874') {
  const s = text === null || text === undefined ? '' : String(text);
  // Buffer has no tis620 or cp874, and that is not something to hand roll:
  // TIS-620 stores Thai vowels and tone marks as combining bytes that have to
  // follow the base consonant in a canonical order. Getting that wrong prints
  // broken Thai rather than merely odd Thai. iconv-lite knows the encoding.
  if (typeof Buffer !== 'undefined' && iconv.encodingExists(encoding)) {
    return iconv.encode(s, encoding);
  }
  if (typeof Buffer !== 'undefined') return Buffer.from(s, 'utf8');
  return new TextEncoder().encode(s);
}

function displayWidth(text) {
  // Combining marks take no space of their own.
  return [...String(text)].reduce((n, ch) => (n + (isCombining(ch) ? 0 : 1)), 0);
}

// Thai marks that take no width of their own, and nothing else.
//
// The tempting shortcut is to treat U+0E00..U+0E7F as combining, which is wrong:
// that range holds the consonants and the spacing vowels too, so เ แ โ ใ ไ and
// every base consonant would measure as zero. Nothing would ever wrap, and a
// long Thai product name would run straight off the paper.
//
// The no-width marks are MAI HAN AKAT, the upper and lower vowel signs, and the
// tone marks. Sarai and Phinthu are spacing, not combining, and so are the
// leading vowels.
const THAI_NON_SPACING = [
  [0x0e31, 0x0e31], // mai han akat
  [0x0e34, 0x0e3a], // sara i, sara ii, sara ue, sara uee
  [0x0e47, 0x0e4e], // mai tai koo, mai tho, mai thahan, mai thong, tone marks
];

function isCombining(ch) {
  const code = ch.codePointAt(0);
  for (const [from, to] of THAI_NON_SPACING) {
    if (code >= from && code <= to) return true;
  }
  return false;
}

function wrap(text, width) {
  const out = [];
  for (const paragraph of String(text).split('\n')) {
    if (paragraph === '') { out.push(''); continue; }
    let line = '';
    for (const ch of paragraph) {
      if (displayWidth(line) + displayWidth(ch) > width && line !== '') {
        out.push(line);
        line = ch;
      } else {
        line += ch;
      }
    }
    if (line !== '') out.push(line);
  }
  return out;
}

class EscposJob {
  constructor(profile = {}) {
    this.cap = caps(profile);
    this.chunks = [];
  }

  raw(bytes) { this.chunks.push(Buffer.from(bytes)); return this; }

  text(value, { wrapTo = null } = {}) {
    const lines = wrapTo ? wrap(value, wrapTo) : String(value).split('\n');
    for (const line of lines) {
      this.chunks.push(encodeText(line, this.cap.encoding));
      this.chunks.push(Buffer.from([LF]));
    }
    return this;
  }

  open() {
    // Standard mode first, then init: some firmware ignores init while in an
    // unknown mode, and a job that starts wrong never recovers.
    return this.raw(CMD.standardMode).raw(CMD.init).raw(CMD.codepage(this.cap.codePage));
  }

  align(where) {
    // The looked-up number has to be what gets sent. Passing the name through
    // coerced 'center' to 0, which is left align: every centred heading came
    // out flush against the left margin.
    const n = ALIGN[where];
    return this.raw(CMD.align(n === undefined ? ALIGN.left : n));
  }

  bold(on = true) { return this.raw(CMD.emphasis(on ? 1 : 0)); }

  underline(on = true) { return this.raw(CMD.underline(on ? 1 : 0)); }

  size(width = 1, height = 1) { return this.raw(CMD.size(width, height)); }

  lineSpacing(dots = this.cap.lineSpacingDots) { return this.raw(CMD.lineSpacing(dots)); }

  feed(lines = 1) { return this.raw(CMD.feedLines(lines)); }

  cut() {
    if (!this.cap.supportsCut) return this.feed(this.cap.cutFeedLines * 2);
    return this.feed(this.cap.cutFeedLines).raw(CMD.cut(true));
  }

  drawer() {
    if (!this.cap.supportsDrawer) return this;
    return this.raw(CMD.drawer());
  }

  bell(times = 3) { return this.raw(CMD.bell(times)); }

  // Raster image, the command nearly every thermal printer accepts for a
  // bitmap. Width is in bytes, so it must be padded to a 256 pixel block.
  image(bytes, widthPx, heightPx) {
    if (!this.cap.supportsImage) return this;
    const widthBytes = Math.ceil(widthPx / 8);
    const blockWidth = Math.ceil(widthBytes / 32) * 32;
    const padded = Buffer.alloc(blockWidth * heightPx, 0);
    Buffer.from(bytes).copy(padded, 0, 0, Math.min(bytes.length, padded.length));
    this.raw([GS, 0x2a, widthPx & 0xff, (widthPx >> 8) & 0xff, heightPx & 0xff, (heightPx >> 8) & 0xff]);
    this.raw([GS, 0x28, 0x2a, 0x00, 0x00, blockWidth & 0xff, (blockWidth >> 8) & 0xff, heightPx & 0xff, (heightPx >> 8) & 0xff]);
    this.chunks.push(padded);
    this.raw([GS, 0x28, 0x2a, 0x03, 0x00]);
    return this;
  }

  toBuffer() { return Buffer.concat(this.chunks); }
}

/**
 * A capability profile for an unknown model.
 *
 * The point of this: a shop plugs in a model nobody has ever catalogued, and the
 * right behaviour is to print at sensible defaults rather than refuse. Every
 * real profile is a refinement of this, not a replacement for it.
 */
function genericProfile(model = 'generic-escpos-80mm') {
  return {
    vendor: 'Generic',
    model,
    protocol: 'escpos-network',
    paper_width_mm: 80,
    dpi: 203,
    columns: 48,
    code_pages: ['CP874', 'CP437'],
    supports_cut: true,
    supports_drawer: true,
    supports_image: true,
    supports_colour: false,
    max_char_width_px: 512,
    quirks: {},
  };
}

function jobFor(profile) {
  return new EscposJob({
    columns: profile && profile.columns ? profile.columns : DEFAULT_CAPABILITIES.columns,
    paperWidthMm: profile && profile.paper_width_mm,
    dpi: profile && profile.dpi,
    codePage: profile && profile.quirks && profile.quirks.codePage,
    encoding: (profile && profile.code_pages && profile.code_pages[0]) === 'CP874' ? 'cp874' : 'cp874',
    supportsCut: !profile || profile.supports_cut !== false,
    supportsDrawer: !profile || profile.supports_drawer !== false,
    supportsImage: !profile || profile.supports_image !== false,
    lineSpacingDots: profile && profile.quirks && profile.quirks.lineSpacingDots,
    cutFeedLines: profile && profile.quirks && profile.quirks.cutFeedLines,
  });
}

module.exports = {
  EscposJob, CMD, DEFAULT_CAPABILITIES, caps, encodeText, wrap, displayWidth,
  genericProfile, jobFor, ALIGN, ESC, GS, LF,
};
