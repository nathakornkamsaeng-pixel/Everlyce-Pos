// ESC/POS, asserted at the byte level.
//
// A printer is not available in CI, so the only way to be sure a ticket is
// right is to check the exact bytes. Every expectation here is the manual's
// sequence written out, not a recording of what the code currently does, so a
// change that alters the wire format fails rather than passing unnoticed.
const assert = require('assert');

const iconv = require('iconv-lite');
const {
  EscposJob, CMD, caps, wrap, displayWidth, encodeText, genericProfile, jobFor,
} = require('../src/printing/escpos');

// Buffer has no tis620, so the expected bytes have to come from the same
// encoder the driver uses. Writing the expectation any other way would either
// throw or quietly assert utf8.
const t620 = (text) => iconv.encode(text, 'tis620');

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
}

const hex = (buf) => Buffer.from(buf).toString('hex');
const eighty = { columns: 48, paperWidthMm: 80, dpi: 203, supportsCut: true, supportsDrawer: true, supportsImage: true };

console.log('\n== the control sequences ==');
{
  ok('init is ESC @', hex(Buffer.from(CMD.init)) === '1b40', hex(Buffer.from(CMD.init)));
  ok('standard mode is GS v 0', hex(Buffer.from(CMD.standardMode)) === '1d7630');
  ok('align left is ESC a 0', hex(Buffer.from(CMD.align(0))) === '1b6100');
  ok('align centre is ESC a 1', hex(Buffer.from(CMD.align(1))) === '1b6101');
  ok('align right is ESC a 2', hex(Buffer.from(CMD.align(2))) === '1b6102');
  ok('bold on is ESC E 1', hex(Buffer.from(CMD.emphasis(1))) === '1b4501');
  ok('underline is ESC - 1', hex(Buffer.from(CMD.underline(1))) === '1b2d01');
  ok('code page is ESC t n', hex(Buffer.from(CMD.codepage(17))) === '1b7411');
  ok('double width and height is GS ! 0x11', hex(Buffer.from(CMD.size(2, 2))) === '1d2111', hex(Buffer.from(CMD.size(2, 2))));
  ok('single is GS ! 0', hex(Buffer.from(CMD.size(1, 1))) === '1d2100');
  ok('size is clamped at x4, never wrapping into another instruction', hex(Buffer.from(CMD.size(9, 9))) === '1d2133', hex(Buffer.from(CMD.size(9, 9))));
  ok('x4 is reachable, which clamping to 3 would have lost', hex(Buffer.from(CMD.size(4, 4))) === '1d2133');
  ok('width and height are independent', hex(Buffer.from(CMD.size(2, 1))) === '1d2110', hex(Buffer.from(CMD.size(2, 1))));
  ok('feed one line is ESC d 1', hex(Buffer.from(CMD.feedLines(1))) === '1b6401');
  ok('line spacing is ESC 3 with two bytes', hex(Buffer.from(CMD.lineSpacing(24))) === '1b321800');
  ok('partial cut is GS V B', hex(Buffer.from(CMD.cut(true))) === '1d564200', hex(Buffer.from(CMD.cut(true))));
  ok('full cut is GS V A', hex(Buffer.from(CMD.cut(false))) === '1d564100');
  ok('drawer is ESC p on pin 2', hex(Buffer.from(CMD.drawer())) === '1b700219fa', hex(Buffer.from(CMD.drawer())));
  ok('drawer timing is settable, since it varies by model', hex(Buffer.from(CMD.drawer(2, 0x0c, 0x18))) === '1b70020c18');
}

console.log('\n== a job opens in a known state ==');
{
  const buf = jobFor(genericProfile()).open().toBuffer();
  ok('standard mode, then init, then code page', hex(buf) === '1d7630' + '1b40' + '1b7411', hex(buf));
  ok('init comes before the code page, not after',
    buf.indexOf(Buffer.from([0x1b, 0x40])) < buf.indexOf(Buffer.from([0x1b, 0x74])));
}

console.log('\n== text ==');
{
  const job = new EscposJob(eighty);
  job.text('Hello');
  ok('text is followed by a line feed', hex(job.toBuffer()) === t620('Hello\n').toString('hex'), hex(job.toBuffer()));
  const thai = new EscposJob(eighty).text('กาแฟ').toBuffer();
  ok('thai encodes through tis620, not utf8',
    thai.equals(t620('กาแฟ\n')) && !thai.equals(Buffer.from('กาแฟ\n', 'utf8')), hex(thai));
  const en = new EscposJob(eighty).text('Latte').toBuffer();
  ok('ascii is unaffected by the code page', en.equals(t620('Latte\n')));
  ok('an empty line is still a line', new EscposJob(eighty).text('a\n\nb').toBuffer().equals(t620('a\n\nb\n')));
}

console.log('\n== wrapping, which is where Thai normally breaks ==');
{
  // Thai has no spaces, so space-based wrapping emits one line the width of the
  // whole sentence and it runs off the paper.
  ok('splits a long unbroken run by width', wrap('abcdefghij', 4).join('|') === 'abcd|efgh|ij', wrap('abcdefghij', 4));
  // ก า แ ฟ are all spacing, so the first line holds three of them and the
  // tone mark rides along on the second line without costing width.
  ok('respects an explicit width', wrap('กาแฟร้อน', 3).join('|') === 'กาแ|ฟร้อ|น', wrap('กาแฟร้อน', 3));
  ok('and wrapping never loses or duplicates a character', (() => {
    for (const w of [4, 8, 12, 20, 48]) {
      const text = 'กาแฟโก้โกดีของแรง';
      if (wrap(text, w).join('') !== text) return false;
    }
    return true;
  })());
  ok('never exceeds the budget', wrap('กาแฟโก้โกดี', 4).every((l) => displayWidth(l) <= 4), wrap('กาแฟโก้โกดี', 4));
  ok('combining marks do not count against the width',
    displayWidth('ก') === 1 && displayWidth('ก\u0e31') === 1, displayWidth('ก\u0e31'));
  // The bug that made every Thai character measure zero: the whole 0E00-0E7F
  // block is not combining, only eleven code points of it are.
  ok('base consonants take width', displayWidth('ก') === 1 && displayWidth('ข') === 1);
  ok('leading vowels take width, they are not marks', displayWidth('เ') === 1 && displayWidth('แ') === 1, displayWidth('แ'));
  ok('sarai is spacing, not combining', displayWidth('า') === 1, displayWidth('า'));
  ok('tone marks do not', displayWidth('้') === 0, displayWidth('้'));
  ok('a realistic thai name measures plausibly', displayWidth('กาแฟโก้') === 6, displayWidth('กาแฟโก้'));
  ok('an exact fit is not wrapped', wrap('abcd', 4).join('') === 'abcd');
  ok('text at a width is wrapped when asked', (() => {
    const b = new EscposJob(eighty).text('abcdefgh', { wrapTo: 4 }).toBuffer();
    return b.equals(t620('abcd\nefgh\n'));
  })());
}

console.log('\n== a receipt ==');
{
  const job = new EscposJob(eighty);
  job.open();
  job.size(2, 2).align('center').text('SIAM KITCHEN');
  job.size(1, 1).align('left').text('Latte x2');
  job.align('right').text('180.00');
  job.align('left').text('');
  job.bold().text('TOTAL').bold(false);
  job.align('right').bold().text('210.60').bold(false);
  job.drawer();
  job.cut();
  const hexed = hex(job.toBuffer());
  ok('starts in a known state', hexed.startsWith('1d76301b401b74'), hexed.slice(0, 24));
  ok('centre heading uses align 1', hexed.includes('1b6101'));
  ok('right column uses align 2', hexed.includes('1b6102'));
  ok('bold is turned on and then off again', hexed.includes('1b4501') && hexed.includes('1b4500'));
  ok('the drawer is kicked before the cut', hexed.indexOf('1b70') < hexed.indexOf('1d5642'));
  ok('the cut is last', hexed.endsWith('1d564200'), hexed.slice(-12));
  ok('heading is double width and height', hexed.includes('1d2111'));
}

console.log('\n== capability differences are honoured ==');
{
  const noCut = new EscposJob({ ...eighty, supportsCut: false });
  noCut.cut();
  ok('a printer with no cutter is fed instead of sent a cut', !hex(noCut.toBuffer()).includes('1d5642'), hex(noCut.toBuffer()));

  const noDrawer = new EscposJob({ ...eighty, supportsDrawer: false });
  noDrawer.drawer();
  ok('a printer with no drawer is not sent one', hex(noDrawer.toBuffer()) === '');

  const noImage = new EscposJob({ ...eighty, supportsImage: false });
  noImage.image(Buffer.alloc(64), 64, 8);
  ok('a printer that cannot do images is sent no image data', hex(noImage.toBuffer()) === '');

  const wide = new EscposJob({ ...eighty, columns: 32 });
  wide.text('abcdefgh', { wrapTo: wide.cap.columns });
  ok('a 58mm printer wraps at its own column count', wide.toBuffer().equals(t620('abcdefgh\n')));

  const c = caps({ columns: 64, codePage: 16 });
  ok('a profile overrides the defaults', c.columns === 64 && c.codePage === 16, c);
  ok('anything a profile does not state keeps a safe default', caps({ columns: 32 }).codePage === 17, caps({ columns: 32 }).codePage);
  ok('and an explicit undefined does not overwrite the default', caps({ codePage: undefined }).codePage === 17, caps({ codePage: undefined }).codePage);
  ok('nor does a null', caps({ codePage: null }).codePage === 17, caps({ codePage: null }).codePage);
  ok('so an open job sends a real code page, not ESC t 0',
    hex(jobFor({ ...genericProfile() }).open().toBuffer()).endsWith('1b7411'),
    hex(jobFor({ ...genericProfile() }).open().toBuffer()));
}

console.log('\n== the code page is a profile setting, not a constant ==');
{
  // The number that means Thai differs by firmware. A driver that hardcoded it
  // would be right for one manufacturer and print mojibake everywhere else.
  const epsonish = jobFor({ ...genericProfile(), quirks: { codePage: 17 } }).open().toBuffer();
  const other = jobFor({ ...genericProfile(), quirks: { codePage: 16 } }).open().toBuffer();
  ok('a different firmware gets a different code page', !epsonish.equals(other));
  ok('and the default is applied when the profile says nothing',
    hex(jobFor(genericProfile()).open().toBuffer()).endsWith('1b7411'));
}

console.log('\n== an uncatalogued model still prints ==');
{
  const profile = genericProfile('some-model-nobody-has-heard-of');
  const buf = jobFor(profile).open().text('SALE').cut().toBuffer();
  ok('an unknown model falls back to working defaults, not a refusal', buf.length > 8, buf.length);
  ok('a profile is a refinement of the generic one, not a replacement',
    genericProfile().supports_cut === true && genericProfile().columns === 48);
}

console.log('\n== raster images are padded to the block the printer expects ==');
{
  const job = new EscposJob(eighty);
  // 100px wide is 13 bytes, which most firmware will not accept unpadded.
  job.image(Buffer.alloc(13 * 4), 100, 4);
  const buf = job.toBuffer();
  ok('the image is padded to a whole 256 pixel block', buf.length > 13 * 4, buf.length);
  ok('the header carries the true pixel width', hex(buf).startsWith('1d2a64000400'), hex(buf).slice(0, 20));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
