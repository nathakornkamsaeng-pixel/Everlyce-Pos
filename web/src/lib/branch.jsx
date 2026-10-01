import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { get, post, put, del, api } from './api.js';

// One install can run a single shop across several branches: one menu and one
// set of staff, but separate tables, orders, tills and reports per location.
// A store with a single branch hides the switcher entirely.
const BranchCtx = createContext({
  branches: [],
  branch: null,
  branchId: null,
  multi: false,
  ready: true,
  select: () => {},
  reload: () => {},
  create: () => Promise.resolve(),
  update: () => Promise.resolve(),
  remove: () => Promise.resolve(),
});

export function BranchProvider({ slug, children }) {
  const [branches, setBranches] = useState([]);
  const [branchId, setBranchId] = useState(null);
  const [ready, setReady] = useState(true);

  const load = useCallback(async () => {
    if (!slug) {
      setBranches([]);
      setReady(true);
      return;
    }
    try {
      const list = await get('/branches');
      setBranches(Array.isArray(list) ? list : []);
      setReady(true);
    } catch (e) {
      setBranches([]);
      setReady(true);
    }
  }, [slug]);

  useEffect(() => { load(); }, [load]);

  // Keep the remembered choice if it still exists, otherwise fall back to the
  // default branch so a request is never sent with a branch that was removed.
  useEffect(() => {
    if (!branches.length) {
      setBranchId(null);
      return;
    }
    setBranchId((current) => {
      if (current && branches.some((b) => Number(b.id) === Number(current))) return current;
      const remembered = api.lastBranch(slug);
      if (remembered && branches.some((b) => Number(b.id) === Number(remembered))) return Number(remembered);
      const fallback = branches.find((b) => b.isDefault) || branches[0];
      return fallback ? Number(fallback.id) : null;
    });
  }, [branches, slug]);

  // Point the API client at the chosen branch before any child effect fires.
  useEffect(() => {
    if (branchId != null) api.rememberBranch(slug, branchId);
  }, [branchId, slug]);

  const select = useCallback((id) => {
    setBranchId((current) => (Number(current) === Number(id) ? current : Number(id)));
  }, []);

  const create = useCallback(async (payload) => {
    const created = await post('/branches', payload);
    await load();
    return created;
  }, [load]);

  const update = useCallback(async (id, payload) => {
    const updated = await put(`/branches/${id}`, payload);
    await load();
    return updated;
  }, [load]);

  const remove = useCallback(async (id) => del(`/branches/${id}`), []);

  const branch = branches.find((b) => Number(b.id) === Number(branchId)) || null;
  const value = {
    branches,
    branch,
    branchId: branch ? Number(branch.id) : null,
    multi: branches.length > 1,
    ready,
    select,
    reload: load,
    create,
    update,
    remove,
  };

  return <BranchCtx.Provider value={value}>{children}</BranchCtx.Provider>;
}

export const useBranch = () => useContext(BranchCtx);
