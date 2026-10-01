const { coll, nextId, now } = require('./db');

const MAX_QUANTITY = 100;
const MAX_NOTES_LENGTH = 500;

class ValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function positiveInteger(value, label, maximum = MAX_QUANTITY) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw new ValidationError(`${label} must be an integer between 1 and ${maximum}`);
  return number;
}

function optionalText(value, label, maximum = MAX_NOTES_LENGTH) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (text.length > maximum) throw new ValidationError(`${label} is too long`);
  return text;
}

function productFor(productId) {
  const id = Number(productId);
  if (!Number.isSafeInteger(id) || id < 1) throw new ValidationError('Invalid product');
  const product = coll('products').find((candidate) => Number(candidate.id) === id);
  if (!product) throw new ValidationError('Product not found');
  if (product.available === false) throw new ValidationError('Product is unavailable');
  const price = Number(product.price);
  if (!Number.isFinite(price) || price < 0) throw new ValidationError('Product has an invalid price');
  return product;
}

function groupsFor(productId) {
  return coll('modifierGroups').filter((group) => Array.isArray(group.productIds) && group.productIds.map(Number).includes(Number(productId)));
}

function normalizeModifiers(product, input) {
  if (input === undefined || input === null) input = [];
  if (!Array.isArray(input)) throw new ValidationError('Modifiers must be an array');
  const groups = groupsFor(product.id);
  const selected = new Map();
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') throw new ValidationError('Invalid modifier');
    const optionId = raw.optionId === undefined || raw.optionId === null ? null : Number(raw.optionId);
    const groupId = raw.groupId === undefined || raw.groupId === null ? null : Number(raw.groupId);
    let option = null;
    if (Number.isSafeInteger(optionId) && optionId > 0) option = coll('modifierOptions').find((candidate) => Number(candidate.id) === optionId);
    if (!option && raw.option != null) {
      const matches = coll('modifierOptions').filter((candidate) => String(candidate.name) === String(raw.option));
      const groupMatches = groupId ? matches.filter((candidate) => Number(candidate.groupId) === groupId) : matches;
      if (groupMatches.length === 1) option = groupMatches[0];
    }
    if (!option && raw.name != null) {
      const matches = coll('modifierOptions').filter((candidate) => String(candidate.name) === String(raw.name));
      const groupMatches = groupId ? matches.filter((candidate) => Number(candidate.groupId) === groupId) : matches;
      if (groupMatches.length === 1) option = groupMatches[0];
    }
    if (!option) throw new ValidationError('Invalid modifier option');
    const group = groups.find((candidate) => Number(candidate.id) === Number(option.groupId));
    if (!group) throw new ValidationError('Modifier is not available for this product');
    if (groupId && Number(group.id) !== groupId) throw new ValidationError('Modifier group does not match option');
    const current = selected.get(Number(group.id)) || [];
    if (current.some((candidate) => Number(candidate.optionId) === Number(option.id))) throw new ValidationError('Duplicate modifier option');
    current.push({ groupId: Number(group.id), optionId: Number(option.id), group: group.name, option: option.name, adj: Number(option.priceAdj) || 0 });
    selected.set(Number(group.id), current);
  }
  for (const group of groups) {
    const values = selected.get(Number(group.id)) || [];
    const min = Math.max(group.required ? 1 : 0, Number(group.minSelect) || 0);
    const max = Number(group.maxSelect) || (group.type === 'single' ? 1 : values.length || 1);
    if (values.length < min) throw new ValidationError(`Modifier selection is required: ${group.name}`);
    if (values.length > max) throw new ValidationError(`Too many modifiers selected: ${group.name}`);
    if (group.type !== 'single' && group.type !== 'multiple') throw new ValidationError('Invalid modifier group type');
  }
  return [...selected.values()].flat().sort((a, b) => a.groupId - b.groupId || a.optionId - b.optionId);
}

function buildLine(raw) {
  if (!raw || typeof raw !== 'object') throw new ValidationError('Invalid order item');
  const product = productFor(raw.productId);
  const quantity = positiveInteger(raw.quantity === undefined ? 1 : raw.quantity, 'Quantity');
  const modifiers = normalizeModifiers(product, raw.modifiers);
  return {
    productId: Number(product.id),
    productName: product.name,
    quantity,
    unitPrice: Number(product.price),
    notes: optionalText(raw.notes, 'Notes'),
    modifiers,
  };
}

function buildLines(items) {
  if (!Array.isArray(items) || items.length === 0) throw new ValidationError('Order must include items');
  if (items.length > 100) throw new ValidationError('Too many order items');
  const lines = items.map(buildLine);
  const merged = [];
  const indexes = new Map();
  for (const line of lines) {
    const key = JSON.stringify({ productId: line.productId, notes: line.notes, modifiers: line.modifiers });
    const index = indexes.get(key);
    if (index === undefined) {
      indexes.set(key, merged.length);
      merged.push(line);
    } else {
      merged[index].quantity += line.quantity;
      if (merged[index].quantity > MAX_QUANTITY) throw new ValidationError('Quantity is too large');
    }
  }
  return merged;
}

function movement(orderId, productId, delta, type, itemId = null) {
  coll('stockMovements').push({ id: nextId('stockMovements'), orderId: orderId == null ? null : Number(orderId), productId: Number(productId), itemId: itemId == null ? null : Number(itemId), delta: Number(delta), type, createdAt: now(), createdBy: null });
}

function reserveLines(lines, orderId) {
  const totals = new Map();
  for (const line of lines) {
    const product = productFor(line.productId);
    if (!product.trackStock) continue;
    totals.set(Number(product.id), (totals.get(Number(product.id)) || 0) + line.quantity);
  }
  for (const [productId, quantity] of totals) {
    const product = coll('products').find((candidate) => Number(candidate.id) === productId);
    if ((Number(product.stockCount) || 0) < quantity) throw new ValidationError(`Insufficient stock for ${product.name}`, 409);
  }
  for (const [productId, quantity] of totals) {
    const product = coll('products').find((candidate) => Number(candidate.id) === productId);
    product.stockCount = (Number(product.stockCount) || 0) - quantity;
    movement(orderId, productId, -quantity, 'reserve');
  }
}

function releaseLines(items, orderId) {
  for (const item of items) {
    if (item.stockReserved !== true || item.status === 'cancelled' || item.refunded) continue;
    const product = coll('products').find((candidate) => Number(candidate.id) === Number(item.productId));
    if (product && product.trackStock) {
      product.stockCount = (Number(product.stockCount) || 0) + (Number(item.quantity) || 0);
      movement(orderId, item.productId, Number(item.quantity) || 0, 'release', item.id);
    }
    item.stockReserved = false;
  }
}

function replaceStock(orderId, currentItems, nextLines) {
  releaseLines(currentItems, orderId);
  reserveLines(nextLines, orderId);
  for (const line of nextLines) {
    const item = currentItems.find((candidate) => Number(candidate.productId) === line.productId && JSON.stringify(candidate.modifiers || []) === JSON.stringify(line.modifiers));
    if (item) item.stockReserved = true;
  }
}

function adjustStock(item, nextQuantity, orderId) {
  const quantity = positiveInteger(nextQuantity, 'Quantity');
  const previous = Number(item.quantity) || 0;
  if (quantity === previous || !item.stockReserved) {
    item.quantity = quantity;
    return;
  }
  const product = coll('products').find((candidate) => Number(candidate.id) === Number(item.productId));
  if (!product || !product.trackStock) {
    item.quantity = quantity;
    return;
  }
  if (quantity > previous) reserveLines([{ productId: item.productId, quantity: quantity - previous }], orderId);
  else releaseLines([{ ...item, quantity: previous - quantity, stockReserved: true }], orderId);
  item.quantity = quantity;
}

module.exports = { MAX_QUANTITY, ValidationError, positiveInteger, optionalText, productFor, normalizeModifiers, buildLine, buildLines, reserveLines, releaseLines, replaceStock, adjustStock, groupsFor };
