const express = require('express');
const bcrypt = require('bcryptjs');
const { coll, nextId, now, touch } = require('../db');
const { publicUser, requireAuth, requireRole, bumpAuthVersion } = require('../middleware');
const { rejectIfOverLimit } = require('../planLimits');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

const ROLES = ['admin', 'cashier', 'kds', 'display'];

function activeAdminCount(excludeId = null) {
  return coll('users').filter((user) => user.role === 'admin' && user.active && Number(user.id) !== Number(excludeId)).length;
}

function validatePin(pin) {
  if (pin === null || pin === undefined || pin === '') return null;
  const value = String(pin);
  if (!/^\d{4,8}$/.test(value)) return undefined;
  return value;
}

function validatePassword(password) {
  if (password === undefined || password === null || password === '') return null;
  const value = String(password);
  if (value.length < 12 || value.length > 200) return undefined;
  return value;
}

router.get('/', (req, res) => {
  res.json(coll('users').map(publicUser));
});

router.post('/', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const { username, name, role = 'cashier', pin = null, password, cashierId = null, language = 'th' } = body;
  if (!username || !String(username).trim()) return res.status(400).json({ detail: 'username is required' });
  if (!ROLES.includes(role)) return res.status(400).json({ detail: 'Invalid role' });
  if (coll('users').some((user) => user.username && user.username.toLowerCase() === String(username).toLowerCase())) return res.status(409).json({ detail: 'Username already exists' });
  const overLimit = rejectIfOverLimit(req, res, 'maxUsers', coll('users').length);
  if (overLimit) return overLimit;
  const normalizedPin = validatePin(pin);
  if (normalizedPin === undefined) return res.status(400).json({ detail: 'PIN must contain 4 to 8 digits' });
  const normalizedPassword = validatePassword(password);
  if (normalizedPassword === undefined) return res.status(400).json({ detail: 'Password must contain 12 to 200 characters' });
  if (role === 'admin' && normalizedPin) return res.status(400).json({ detail: 'Admin accounts must use a password, not a PIN' });
  if (role === 'admin' && !normalizedPassword) return res.status(400).json({ detail: 'Admin accounts require a password' });
  if (role === 'display' && cashierId != null) {
    const cashier = coll('users').find((user) => Number(user.id) === Number(cashierId) && ['cashier', 'admin'].includes(user.role));
    if (!cashier) return res.status(400).json({ detail: 'Linked cashier not found' });
  }
  const user = {
    id: nextId('users'),
    username: String(username).trim(),
    name: String(name || username).trim(),
    role,
    pinHash: normalizedPin ? await bcrypt.hash(normalizedPin, 10) : null,
    cashierId: role === 'display' && cashierId ? Number(cashierId) : null,
    language: language === 'en' ? 'en' : 'th',
    passwordHash: normalizedPassword ? await bcrypt.hash(normalizedPassword, 10) : null,
    active: true,
    authVersion: 1,
    createdAt: now(),
  };
  coll('users').push(user);
  touch();
  res.status(201).json(publicUser(user));
});

router.put('/:id', async (req, res) => {
  const user = coll('users').find((candidate) => Number(candidate.id) === Number(req.params.id));
  if (!user) return res.status(404).json({ detail: 'User not found' });
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const { username, name, role, pin, active, password, cashierId, language } = body;
  if (role !== undefined && !ROLES.includes(role)) return res.status(400).json({ detail: 'Invalid role' });
  if (user.role === 'admin' && user.active && activeAdminCount(user.id) === 0 && (role !== undefined && role !== 'admin' || active === false)) return res.status(400).json({ detail: 'The last active admin cannot be disabled' });
  if (username !== undefined) {
    const value = String(username).trim();
    if (!value) return res.status(400).json({ detail: 'username is required' });
    if (coll('users').some((candidate) => candidate.id !== user.id && candidate.username && candidate.username.toLowerCase() === value.toLowerCase())) return res.status(409).json({ detail: 'Username already exists' });
    if (value !== user.username) { user.username = value; bumpAuthVersion(user); }
  }
  if (name !== undefined) user.name = String(name).trim() || user.username;
  if (role !== undefined && role !== user.role) {
    user.role = role;
    if (role === 'admin') user.pinHash = null;
    bumpAuthVersion(user);
  }
  if (role !== undefined && role !== 'display') user.cashierId = null;
  if (cashierId !== undefined) {
    if (role === 'display' || user.role === 'display') {
      if (cashierId != null && !coll('users').some((candidate) => Number(candidate.id) === Number(cashierId) && ['cashier', 'admin'].includes(candidate.role))) return res.status(400).json({ detail: 'Linked cashier not found' });
      user.cashierId = user.role === 'display' && cashierId ? Number(cashierId) : null;
    }
  }
  if (language !== undefined) user.language = language === 'en' ? 'en' : 'th';
  if (pin !== undefined) {
    const normalizedPin = validatePin(pin);
    if (normalizedPin === undefined) return res.status(400).json({ detail: 'PIN must contain 4 to 8 digits' });
    user.pinHash = normalizedPin ? await bcrypt.hash(normalizedPin, 10) : null;
    bumpAuthVersion(user);
  }
  if (active !== undefined && !!active !== user.active) { user.active = !!active; bumpAuthVersion(user); }
  if (password) {
    const normalizedPassword = validatePassword(password);
    if (normalizedPassword === undefined) return res.status(400).json({ detail: 'Password must contain 12 to 200 characters' });
    user.passwordHash = await bcrypt.hash(normalizedPassword, 10);
    bumpAuthVersion(user);
  }
  touch();
  res.json(publicUser(user));
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id === Number(req.user.id)) return res.status(400).json({ detail: 'Cannot delete yourself' });
  const user = coll('users').find((candidate) => Number(candidate.id) === id);
  if (!user) return res.status(404).json({ detail: 'User not found' });
  if (user.role === 'admin' && user.active && activeAdminCount(id) === 0) return res.status(400).json({ detail: 'The last active admin cannot be deleted' });
  coll('users').splice(coll('users').indexOf(user), 1);
  touch();
  res.json({ ok: true });
});

module.exports = router;
