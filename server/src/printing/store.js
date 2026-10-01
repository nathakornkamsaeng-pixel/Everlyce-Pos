// A shop's printers.
//
// Per store, and that is the whole point: two shops on the same install have
// different machines on different walls, and a printer belonging to one shop
// showing up on another's till is how a receipt with the wrong shop's name on it
// gets printed.
//
// The eleven supported models are seeded as data so a shop picks from a list
// rather than typing a model name and hoping. Every profile is marked
// unverified: the capabilities are the standard for that class of machine, not
// measured against a physical unit. Paper width and columns are solid. The code
// page that means Thai is firmware dependent and is deliberately left unset,
// because a wrong guess prints mojibake and a wrong answer stated confidently is
// worse than no answer.

const { coll, nextId, now, transaction } = require('../db');
const { build: buildProfiles } = require('./profiles');

const KINDS = ['receipt', 'kitchen', 'bar', 'label', 'other'];

const PROTOCOLS = ['browser', 'escpos-network', 'raw-tcp', 'escpos-usb', 'cloud'];

class PrinterError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = 'PrinterError';
    this.code = code;
    this.status = status;
  }
}

/** The models a shop can choose from. Read-only, identical for every shop. */
function catalogue() {
  return buildProfiles();
}

function find(id) {
  return (coll('printers') || []).find((p) => Number(p.id) === Number(id)) || null;
}

function dto(printer) {
  if (!printer) return null;
  return {
    id: printer.id,
    name: printer.name,
    kind: printer.kind,
    protocol: printer.protocol,
    // Not the secret. A cloud printer id can address the machine, so it is shown
    // only as a last few characters, enough to tell two of them apart.
    address: printer.address || '',
    addressHint: printer.address ? String(printer.address).slice(-6) : '',
    vendor: printer.vendor || '',
    model: printer.model || '',
    paperWidthMm: printer.paperWidthMm || 80,
    columns: printer.columns || (printer.paperWidthMm === 58 ? 32 : 48),
    // Whether the profile has been checked against a real unit. Shown in the UI
    // so a shop is not told a receipt width is confirmed when it is not.
    verified: printer.verified === true,
    isDefaultReceipt: printer.isDefaultReceipt === true,
    isDefaultKitchen: printer.isDefaultKitchen === true,
    active: printer.active !== false,
    createdAt: printer.createdAt,
  };
}

function validate(body) {
  const name = String((body && body.name) || '').trim().slice(0, 60);
  if (!name) throw new PrinterError('Give the printer a name you will recognise at the till', 'name_required');
  const kind = KINDS.includes(body.kind) ? body.kind : 'receipt';
  const protocol = PROTOCOLS.includes(body.protocol) ? body.protocol : 'browser';

  // A network printer is useless without somewhere to connect to, and the most
  // common support call is a printer that silently does nothing because the
  // address was left blank.
  const address = String((body && body.address) || '').trim().slice(0, 120);
  if ((protocol === 'escpos-network' || protocol === 'raw-tcp') && !address) {
    throw new PrinterError('A network printer needs an IP address and port, for example 192.168.1.80:9100', 'address_required');
  }

  const width = Number(body.paperWidthMm) === 58 ? 58 : 80;
  const catalogueEntry = catalogue().find((p) => p.vendor === body.vendor && p.model === body.model) || null;

  return {
    name,
    kind,
    protocol,
    address,
    vendor: catalogueEntry ? catalogueEntry.vendor : String((body && body.vendor) || '').trim().slice(0, 40),
    model: catalogueEntry ? catalogueEntry.model : String((body && body.model) || '').trim().slice(0, 60),
    paperWidthMm: width,
    columns: Number(body.columns) > 0 ? Number(body.columns) : (width === 58 ? 32 : 48),
    verified: catalogueEntry ? catalogueEntry.verified === true : false,
    active: body.active !== false,
  };
}

/**
 * Add a printer for this shop.
 *
 * The first receipt printer added becomes the default, because a shop that has
 * configured one and finds it is not being used has to work that out themselves.
 */
function add(body) {
  const fields = validate(body);
  return transaction(() => {
    const existing = coll('printers') || [];
    const printer = {
      id: nextId('printers'),
      ...fields,
      isDefaultReceipt: fields.kind === 'receipt' && !existing.some((p) => p.isDefaultReceipt),
      isDefaultKitchen: fields.kind === 'kitchen' && !existing.some((p) => p.isDefaultKitchen),
      createdAt: now(),
      updatedAt: now(),
    };
    existing.push(printer);
    return printer;
  });
}

function update(id, body) {
  const printer = find(id);
  if (!printer) throw new PrinterError('Printer not found', 'not_found', 404);
  // Marked dirty so the change is written out. Mutating the object alone changes
  // memory and is lost on the next restart.
  require('../db').touch();
  // Only what was sent is changed, so a partial update cannot clear the address
  // of a printer that was set up months ago.
  if (body.name !== undefined) Object.assign(printer, validate({ ...dto(printer), ...body, name: body.name }));
  else Object.assign(printer, validate({ ...dto(printer), ...body }));
  printer.updatedAt = now();
  return printer;
}

function remove(id) {
  const printer = find(id);
  if (!printer) throw new PrinterError('Printer not found', 'not_found', 404);
  transaction(() => {
    const list = coll('printers') || [];
    const at = list.findIndex((p) => Number(p.id) === Number(id));
    if (at >= 0) list.splice(at, 1);
    // A removed default cannot stay the default, or orders have nowhere to go.
    // The next one of that kind takes over rather than leaving the shop silent.
    for (const kind of ['Receipt', 'Kitchen']) {
      const flag = `isDefault${kind}`;
      const others = list.filter((p) => p[`kind`] === kind.toLowerCase() && p.active !== false);
      if (others.length && !others.some((p) => p[flag])) others[0][flag] = true;
    }
  });
  return printer;
}

/**
 * Make one printer the default for its job.
 *
 * Defaults are per kind and only one at a time: two printers both claiming to be
 * the receipt printer means the shop gets two receipts.
 */
function setDefault(id) {
  const before = find(id);
  if (!before) throw new PrinterError('Printer not found', 'not_found', 404);
  const kind = before.kind;

  // transaction() clones the document and swaps it, so anything captured before
  // it belongs to the copy that gets thrown away. The kind is therefore read
  // first and the printer re-found inside, or the flag is set on a discarded
  // object and silently never persists.
  transaction(() => {
    for (const p of coll('printers') || []) {
      if (p.kind !== kind) continue;
      p.isDefaultReceipt = false;
      p.isDefaultKitchen = false;
    }
    const live = find(id);
    if (!live) return;
    if (live.kind === 'receipt') live.isDefaultReceipt = true;
    if (live.kind === 'kitchen') live.isDefaultKitchen = true;
    live.updatedAt = now();
  });
  return find(id);
}

/** The printer that a given job should go to, or null if the shop has none. */
function defaultFor(kind) {
  const want = KINDS.includes(kind) ? kind : 'receipt';
  const list = (coll('printers') || []).filter((p) => p.active !== false && p.kind === want);
  return list.find((p) => (want === 'kitchen' ? p.isDefaultKitchen : p.isDefaultReceipt)) || list[0] || null;
}

/**
 * What this shop can print to.
 *
 * Deliberately reports which jobs have nowhere to go. A shop that has set up no
 * kitchen printer and is about to promise the kitchen display is the failure
 * worth catching, and it is invisible from the till otherwise.
 */
function summary() {
  const list = (coll('printers') || []).map(dto);
  return {
    printers: list,
    catalogue: catalogue(),
    counts: {
      total: list.length,
      active: list.filter((p) => p.active).length,
      receipt: list.filter((p) => p.kind === 'receipt' && p.active).length,
      kitchen: list.filter((p) => p.kind === 'kitchen' && p.active).length,
    },
    // A warning per job with no printer, not a blanket flag.
    warnings: [
      list.some((p) => p.kind === 'receipt' && p.active) ? null : 'No receipt printer. Orders can be taken but no receipt will print.',
      list.some((p) => p.kind === 'kitchen' && p.active) ? null : 'No kitchen printer. Kitchen tickets will not print.',
    ].filter(Boolean),
    protocols: PROTOCOLS,
    kinds: KINDS,
  };
}

module.exports = {
  catalogue, add, update, remove, setDefault, defaultFor, summary, find, dto, validate,
  KINDS, PROTOCOLS, PrinterError,
};