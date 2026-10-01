// The first eleven supported printer models.
//
// These are real, current models, but the point of seeding them as rows is that
// a row is a claim someone can check, not code that silently assumes. Two
// things are deliberately marked in `quirks`:
//
//   verified: false  the capabilities are the standard for this class of
//                    machine, not measured against a physical unit. Before a
//                    shop relies on one, somebody should confirm paper width
//                    and columns against the actual printer.
//   source           where the model is from, so a later correction is traceable
//                    rather than a silent edit.
//
// What is solid: the model names, the 80mm/58mm split, and 203dpi. What is
// genuinely firmware dependent and therefore per-profile is the code page
// number that means Thai, which is why none of these claim one. A wrong guess
// there prints mojibake, so it is left unset and the driver falls back to its
// default rather than to a confident wrong answer.
//
// Columns follow the usual rule: 48 for 80mm and 32 for 58mm at 203dpi, font A.
'use strict';

// name, vendor, model, paper width, columns, extras
const SEED = [
  { vendor: 'Epson', model: 'TM-T88VII', paper: 80, note: 'Ethernet, the most common POS receipt printer in Thailand' },
  { vendor: 'Epson', model: 'TM-T88VI', paper: 80, note: 'Ethernet, previous generation' },
  { vendor: 'Epson', model: 'TM-T20II', paper: 80, note: 'USB or serial, still fitted on older tills' },
  { vendor: 'Epson', model: 'TM-T82III', paper: 80, note: 'USB, low cost counter unit' },
  { vendor: 'Epson', model: 'TM-T88III', paper: 80, note: 'Long retired, still in service somewhere' },
  { vendor: 'Star Micronics', model: 'TSP143III', paper: 80, note: 'USB, common on Mac and small counters' },
  { vendor: 'Bixolon', model: 'SRP-Q300', paper: 80, note: 'Ethernet, built-in cutter' },
  { vendor: 'Citizen', model: 'CT-S310', paper: 80, note: 'Ethernet, front-loading paper' },
  { vendor: 'Rongta', model: 'RP80A', paper: 80, note: 'Ethernet, very widely fitted across Asia' },
  { vendor: 'Xprinter', model: 'XP-N160II', paper: 80, note: 'Ethernet, common budget option' },
  { vendor: 'Xprinter', model: 'XP-Q200', paper: 58, note: '58mm narrow paper, included to exercise the narrower column count' },
];

// The usual column count for each paper width at 203dpi, font A.
const COLUMNS = { 58: 32, 80: 48 };

function build() {
  return SEED.map((entry) => ({
    vendor: entry.vendor,
    model: entry.model,
    aliases: [entry.model.toLowerCase().replace(/[^a-z0-9]+/g, '-')],
    protocol: 'escpos-network',
    transport: 'tcp',
    paper_width_mm: entry.paper,
    dpi: 203,
    columns: COLUMNS[entry.paper],
    // Thai first, because that is the shop this is written for, but the number
    // that selects it is firmware dependent so no code page is claimed here.
    code_pages: ['CP874', 'CP437'],
    supports_cut: true,
    supports_drawer: true,
    supports_image: true,
    supports_colour: false,
    max_char_width_px: 512,
    quirks: {
      verified: false,
      source: 'seeded from the model name and the 80/58mm class default',
      note: entry.note,
      // No codePage key on purpose. Setting it would be a guess.
    },
  }));
}

module.exports = { build, SEED, COLUMNS };
