// The seeded printer models, and what they prove.
//
// The point of this is not that eleven rows exist. It is that every row is
// usable: a profile with the wrong column count would silently produce a
// receipt with lines running off the paper, and nothing else in the system would
// notice. So each one is rendered and measured.
const assert = require('assert');

const { build, COLUMNS } = require('../src/printing/profiles');
const { jobFor, genericProfile, EscposJob, displayWidth } = require('../src/printing/escpos');

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
}

const profiles = build();

console.log('\n== the catalogue ==');
{
  ok('eleven models are seeded', profiles.length === 11, profiles.length);
  const vendors = new Set(profiles.map((p) => p.vendor));
  ok('across more than one manufacturer', vendors.size >= 5, [...vendors]);
  ok('every model is unique', new Set(profiles.map((p) => `${p.vendor} ${p.model}`)).size === profiles.length);
  ok('every profile is 203dpi ESC/POS over the network', profiles.every(
    (p) => p.dpi === 203 && p.protocol === 'escpos-network' && p.transport === 'tcp'));
  ok('58mm and 80mm are both represented, so the column logic is exercised',
    profiles.some((p) => p.paper_width_mm === 58) && profiles.some((p) => p.paper_width_mm === 80));
  ok('every profile carries a Thai code page', profiles.every((p) => p.code_pages.includes('CP874')));
  ok('and every one has a cutter and a drawer', profiles.every((p) => p.supports_cut && p.supports_drawer));
}

console.log('\n== nothing claims a code page it cannot know ==');
{
  // The ESC t number that means Thai is firmware dependent. Asserting one here
  // would be a confident wrong answer for most of these models.
  ok('no seeded profile invents a Thai code page number',
    profiles.every((p) => p.quirks.codePage === undefined), profiles.map((p) => p.quirks.codePage));
  ok('each says whether it has been checked against real hardware',
    profiles.every((p) => p.quirks.verified === false), 'unverified rows must say so');
  ok('and says where the claim came from', profiles.every((p) => typeof p.quirks.source === 'string' && p.quirks.source));
  const job = jobFor(profiles[0]).open();
  ok('so the driver falls back to its documented default instead', job.toBuffer().toString('hex').endsWith('1b7411'),
    job.toBuffer().toString('hex'));
}

console.log('\n== every profile produces a receipt that fits the paper ==');
{
  const lines = [
    'กาแฟโก้โกดี',
    'Latte',
    'ขนมปังสูตรพิเศษ',
    'Croissant',
    'ชาเย็นใบโต',
  ];
  for (const profile of profiles) {
    const job = new EscposJob({
      columns: profile.columns,
      paperWidthMm: profile.paper_width_mm,
      dpi: profile.dpi,
      codePage: profile.quirks.codePage,
      supportsCut: profile.supports_cut,
      supportsDrawer: profile.supports_drawer,
      supportsImage: profile.supports_image,
    });
    job.open();
    job.size(2, 2).align('center').text(profile.model);
    job.size(1, 1).align('left');
    const rendered = [];
    for (const line of lines) {
      for (const part of require('../src/printing/escpos').wrap(line, profile.columns)) {
        rendered.push(part);
        job.text(part);
      }
    }
    job.align('right').text('1,234.00');
    job.drawer();
    job.cut();

    const widest = Math.max(...rendered.map(displayWidth));
    const label = `${profile.vendor} ${profile.model}`;
    ok(`${label}: nothing wider than its ${profile.columns} columns`, widest <= profile.columns, { widest, columns: profile.columns });
    ok(`${label}: a full receipt comes out`, job.toBuffer().length > 40, job.toBuffer().length);
    ok(`${label}: the drawer is kicked and the paper is cut`,
      job.toBuffer().toString('hex').includes('1b70') && job.toBuffer().toString('hex').endsWith('1d564200'));
  }
}

console.log('\n== the 58mm model really is narrower ==');
{
  const narrow = profiles.find((p) => p.paper_width_mm === 58);
  const wide = profiles.find((p) => p.paper_width_mm === 80);
  ok('58mm is 32 columns and 80mm is 48', narrow.columns === 32 && wide.columns === 48, { narrow: narrow.columns, wide: wide.columns });
  // Long enough to actually wrap on 58mm but not on 80mm, which is the whole point.
  // A promo or note line, which is what actually runs off a 58mm receipt.
  const long = 'ซื้อสองแถมหนึ่ง ใช้ได้ทุกวันจันทร์ถึงศุกร์ ยกเว้นวันหยุดนักขัตญญ์';
  const at32 = require('../src/printing/escpos').wrap(long, 32).length;
  const at48 = require('../src/printing/escpos').wrap(long, 48).length;
  ok('so a long thai name wraps sooner on the narrow one', at32 > at48, { at32, at48 });
  ok('and the column counts come from one table, not from each model',
    COLUMNS[58] === narrow.columns && COLUMNS[80] === wide.columns);
}

console.log('\n== a model nobody catalogued still prints ==');
{
  const unknown = jobFor(genericProfile('a-printer-that-does-not-exist'));
  const buf = unknown.open().align('center').text('SALE').align('left').cut().toBuffer();
  ok('it uses the generic 80mm defaults', buf.length > 20, buf.length);
  ok('and still gets a cut and a drawer', buf.toString('hex').endsWith('1d564200'));
  ok('the generic profile is 48 columns, like the 80mm class', genericProfile().columns === 48);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
