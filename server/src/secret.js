const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.POS_DATA_DIR || path.join(path.dirname(__dirname), 'data');
const JWT_SECRET_FILE = path.join(DATA_DIR, 'jwt-secret');

function getSecret() {
  try {
    const value = fs.readFileSync(JWT_SECRET_FILE, 'utf8').trim();
    if (value) return value;
  } catch (e) {}
  const value = require('crypto').randomBytes(48).toString('hex');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(JWT_SECRET_FILE, value, { mode: 0o600 });
  return value;
}

module.exports = { getSecret, JWT_SECRET_FILE };
