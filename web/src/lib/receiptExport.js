import { BRAND_LOGO } from './brand-assets';

function loadImage(src) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

function money(value, currency) {
  const amount = Number(value) || 0;
  const formatted = amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === 'THB' ? `฿${formatted}` : `${currency} ${formatted}`;
}

function wrappedLines(ctx, text, maxWidth) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  const pushChars = (value) => {
    let part = '';
    for (const character of value) {
      if (part && ctx.measureText(part + character).width > maxWidth) {
        lines.push(part);
        part = character;
      } else {
        part += character;
      }
    }
    return part;
  };
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = pushChars(word);
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function line(ctx, x1, y, x2, color = '#d9dde3') {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x1, y);
  ctx.lineTo(x2, y);
  ctx.stroke();
}

function buildCanvas(receipt, order) {
  const width = 1000;
  const measure = document.createElement('canvas');
  measure.width = width;
  measure.height = 1000;
  const ctx = measure.getContext('2d');
  ctx.font = '24px sans-serif';
  let height = 330;
  for (const item of order.items) {
    const label = [item.name, ...(item.modifiers || []).map((modifier) => modifier.option)].filter(Boolean).join(' · ');
    height += Math.max(42, wrappedLines(ctx, label, 620).length * 30 + 18);
  }
  height += 330;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = Math.max(1100, height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#20242b';
  context.textBaseline = 'top';
  return { canvas, context, receipt, order };
}

async function drawReceipt(receipt) {
  const order = receipt.order;
  const { canvas, context } = buildCanvas(receipt, order);
  const logo = await loadImage(BRAND_LOGO);
  const left = 64;
  const right = canvas.width - 64;
  let y = 54;

  if (logo) {
    context.drawImage(logo, left, y, 96, 96);
    context.fillStyle = '#20242b';
    context.font = '700 34px sans-serif';
    context.fillText(receipt.restaurantName, left + 120, y + 12);
    context.fillStyle = '#6b7280';
    context.font = '22px sans-serif';
    context.fillText('Receipt / ใบเสร็จ', left + 120, y + 58);
  } else {
    context.fillStyle = '#20242b';
    context.font = '700 34px sans-serif';
    context.fillText(receipt.restaurantName, left, y + 20);
  }

  context.fillStyle = '#20242b';
  context.font = '700 30px sans-serif';
  context.textAlign = 'right';
  context.fillText(order.orderNumber, right, y + 8);
  context.fillStyle = '#6b7280';
  context.font = '20px sans-serif';
  context.fillText(new Date(order.paidAt || Date.now()).toLocaleString(), right, y + 50);
  context.fillText(`Link expires: ${new Date(order.expiresAt).toLocaleDateString()}`, right, y + 82);
  context.textAlign = 'left';
  y += 132;
  line(context, left, y, right);
  y += 30;

  for (const item of order.items) {
    const label = [item.name, ...(item.modifiers || []).map((modifier) => modifier.option)].filter(Boolean).join(' · ');
    context.fillStyle = '#20242b';
    context.font = '600 24px sans-serif';
    const labelLines = wrappedLines(context, label, 620);
    labelLines.forEach((text, index) => context.fillText(text, left, y + index * 30));
    context.fillStyle = '#6b7280';
    context.font = '20px sans-serif';
    if (item.notes) context.fillText(item.notes, left, y + labelLines.length * 30);
    context.textAlign = 'right';
    context.fillStyle = '#20242b';
    context.font = '700 24px sans-serif';
    context.fillText(`${item.quantity} × ${money(item.lineTotal, receipt.currency)}`, right, y);
    context.textAlign = 'left';
    y += Math.max(42, labelLines.length * 30 + 18);
  }

  line(context, left, y, right);
  y += 24;
  const totals = [
    ['Subtotal', order.subtotal],
    ...(order.discount > 0 ? [['Discount', -order.discount]] : []),
    ['Tax', order.tax],
    ['Service charge', order.serviceCharge],
    ...(order.tip > 0 ? [['Tip', order.tip]] : []),
  ];
  for (const [label, value] of totals) {
    context.fillStyle = '#4b5563';
    context.font = '22px sans-serif';
    context.fillText(label, left, y);
    context.textAlign = 'right';
    context.fillText(money(value, receipt.currency), right, y);
    context.textAlign = 'left';
    y += 34;
  }
  y += 8;
  line(context, left, y, right, '#9aa1ab');
  y += 24;
  context.fillStyle = '#20242b';
  context.font = '800 32px sans-serif';
  context.fillText('Total', left, y);
  context.textAlign = 'right';
  context.fillText(money(order.total, receipt.currency), right, y);
  context.textAlign = 'left';
  y += 52;
  context.fillStyle = '#6b7280';
  context.font = '20px sans-serif';
  context.fillText(`Payment: ${order.paymentMethod || 'paid'}`, left, y);
  y += 44;
  if (order.refundedAmount > 0) {
    context.fillText(`Refunded: ${money(order.refundedAmount, receipt.currency)}`, left, y);
    y += 40;
  }
  context.fillStyle = '#9aa1ab';
  context.font = '18px sans-serif';
  context.fillText('Generated from the POS receipt link. This link expires after 7 days.', left, y);
  return canvas;
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

export async function downloadReceiptImage(receipt) {
  const canvas = await drawReceipt(receipt);
  const blob = await toBlob(canvas, 'image/png');
  download(blob, `${receipt.order.orderNumber}.png`);
}

function concatBytes(parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

// Built on first use rather than at import time. Constructing it at module
// scope made merely importing this file throw in any environment without a
// global TextEncoder, which is every test harness and every worker, even
// though the PDF path is not what those callers wanted.
let _encoder = null;
const enc = () => {
  if (!_encoder) _encoder = new TextEncoder();
  return _encoder;
};

export async function downloadReceiptPdf(receipt) {
  const canvas = await drawReceipt(receipt);
  const jpegBase64 = canvas.toDataURL('image/jpeg', 0.94).split(',')[1];
  const binary = atob(jpegBase64);
  const imageBytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) imageBytes[i] = binary.charCodeAt(i);

  const pageWidth = 595;
  const pageHeight = 842;
  const margin = 24;
  const scale = Math.min((pageWidth - margin * 2) / canvas.width, (pageHeight - margin * 2) / canvas.height);
  const drawWidth = canvas.width * scale;
  const drawHeight = canvas.height * scale;
  const offsetX = (pageWidth - drawWidth) / 2;
  const offsetY = (pageHeight - drawHeight) / 2;
  const content = `q\n${drawWidth.toFixed(2)} 0 0 ${drawHeight.toFixed(2)} ${offsetX.toFixed(2)} ${offsetY.toFixed(2)} cm\n/Im0 Do\nQ\n`;
  const objects = [
    enc().encode('<< /Type /Catalog /Pages 2 0 R >>'),
    enc().encode('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    enc().encode(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`),
    concatBytes([
      enc().encode(`<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${imageBytes.length} >>\nstream\n`),
      imageBytes,
      enc().encode('\nendstream'),
    ]),
    enc().encode(`<< /Length ${enc().encode(content).length} >>\nstream\n${content}endstream`),
  ];
  const header = enc().encode('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const chunks = [header];
  const offsets = [0];
  let position = header.length;
  objects.forEach((object, index) => {
    offsets.push(position);
    const chunk = concatBytes([enc().encode(`${index + 1} 0 obj\n`), object, enc().encode('\nendobj\n')]);
    chunks.push(chunk);
    position += chunk.length;
  });
  const xref = position;
  let table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i += 1) table += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  table += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  chunks.push(enc().encode(table));
  download(new Blob(chunks, { type: 'application/pdf' }), `${receipt.order.orderNumber}.pdf`);
}
