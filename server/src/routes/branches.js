const express = require('express');
const { coll, touch, transaction, createBranch } = require('../db');
const { requireAuth, requireRole } = require('../middleware');
const { log, EVENTS } = require('../activityLog');

const router = express.Router();

// Branches are a single-store concept: an install may run one shop in several
// places. Reading them must work before activation so the activation screen can
// show what the store is, but changing them needs a live store and an admin.
router.use(requireAuth);

function withStats(branch) {
  return {
    ...branch,
    tableCount: coll('tables').filter((t) => Number(t.branchId) === Number(branch.id)).length,
    orderCount: coll('orders').filter((o) => Number(o.branchId) === Number(branch.id)).length,
  };
}

router.get('/', (req, res) => {
  const branches = coll('branches').slice().sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return (a.name || '').localeCompare(b.name || '');
  });
  res.json(branches.map(withStats));
});

router.post('/', requireRole('admin'), (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  try {
    const branch = transaction(() => createBranch(req.store.id, {
      name: body.name,
      code: body.code,
      address: body.address,
      phone: body.phone,
    }));
    log(EVENTS.BRANCH_CREATE, req, { branch: branch.code, name: branch.name });
    res.status(201).json(withStats(branch));
  } catch (e) {
    if (e && e.status) return res.status(e.status).json({ detail: e.message });
    throw e;
  }
});

router.put('/:id', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const branch = coll('branches').find((b) => Number(b.id) === id);
  if (!branch) return res.status(404).json({ detail: 'Branch not found' });

  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return res.status(400).json({ detail: 'Branch name is required' });
    branch.name = name.slice(0, 120);
  }
  if (body.code !== undefined) {
    const code = String(body.code).trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (!code) return res.status(400).json({ detail: 'Branch code is required' });
    if (coll('branches').some((b) => Number(b.id) !== id && b.code === code)) {
      return res.status(409).json({ detail: 'That branch code is already used' });
    }
    branch.code = code;
  }
  if (body.address !== undefined) branch.address = String(body.address).trim().slice(0, 300);
  if (body.phone !== undefined) branch.phone = String(body.phone).trim().slice(0, 60);
  if (body.active !== undefined) branch.active = Boolean(body.active);
  touch();
  log(EVENTS.BRANCH_UPDATE, req, { branch: branch.code, name: branch.name });
  res.json(withStats(branch));
});

// A branch can only be removed when nothing points at it, so deleting one can
// never silently take tables, orders or sessions with it.
router.delete('/:id', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const branch = coll('branches').find((b) => Number(b.id) === id);
  if (!branch) return res.status(404).json({ detail: 'Branch not found' });
  if (branch.isDefault) return res.status(409).json({ detail: 'The default branch cannot be removed' });
  if (coll('branches').length <= 1) return res.status(409).json({ detail: 'A store must keep at least one branch' });

  const tableCount = coll('tables').filter((t) => Number(t.branchId) === id).length;
  if (tableCount > 0) {
    return res.status(409).json({ detail: `Move or delete this branch's ${tableCount} table(s) first` });
  }
  const orderCount = coll('orders').filter((o) => Number(o.branchId) === id).length;
  if (orderCount > 0) {
    return res.status(409).json({ detail: `This branch has ${orderCount} order(s) in its history, so it cannot be removed. Deactivate it instead.` });
  }

  transaction(() => {
    const live = coll('branches');
    const index = live.findIndex((b) => Number(b.id) === id);
    if (index >= 0) live.splice(index, 1);
  });
  log(EVENTS.BRANCH_DELETE, req, { branch: branch.code, name: branch.name });
  res.json({ ok: true });
});

module.exports = router;
