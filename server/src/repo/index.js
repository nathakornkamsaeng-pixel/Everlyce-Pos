// The repository: everything that knows where the data actually lives.
//
// db.js used to hold one module-level `state` object and twenty-odd functions
// that reached into it. That works, and it is untestable: a service that wants
// to try an order total has to boot the whole HTTP server to get at it.
//
// The repository moves the state behind an object with a small surface:
//
//   coll(name)         the active store's live collection
//   nextId(name)       a monotonic id for that collection
//   now()              one clock for the whole request
//   touch()            mark the snapshot dirty and persist it
//   transaction(fn)    run fn against a copy, persist on success, discard on throw
//   withStore / eachStore
//   store lookups
//
// Services take a repository instead of importing one, so a test can hand them
// an in-memory one and run in milliseconds. The default instance is backed by
// the file engine through server/src/storage, so nothing about production
// behaviour changes.
'use strict';

const { runWithStore, currentStoreId } = require('../storeContext');

class MissingStoreContextError extends Error {
  constructor(name) {
    super(`No store is active, so "${name}" cannot be read. Every tenant read has to happen inside withStore().`);
    this.name = 'MissingStoreContextError';
    this.code = 'store_required';
    this.status = 400;
  }
}

// The document is reached through get/set rather than held here. Two copies of
// the same variable is exactly the bug this refactor exists to remove: a
// transaction swaps one of them and the other goes stale, and the next write
// persists the wrong half. Sharing the variable keeps a single source of truth,
// and a test can still point it at its own.
function createRepo({ getDoc, setDoc, isGlobal, blankBucket, bucketFor, persist, storage, clock } = {}) {
  if (!isGlobal) throw new Error('createRepo needs isGlobal');
  if (!persist) throw new Error('createRepo needs persist');
  if (typeof getDoc !== 'function' || typeof setDoc !== 'function') {
    throw new Error('createRepo needs getDoc and setDoc');
  }

  const now = clock || (() => new Date().toISOString());
  const doc = () => getDoc();
  let depth = 0;

  function requireStore() {
    const id = currentStoreId();
    if (!id) throw new MissingStoreContextError('collection');
    return id;
  }

  const repo = {
    // Escape hatches for the parts of the system that genuinely own the whole
    // document: the migration, the health report and the startup load.
    get document() { return getDoc(); },
    set document(next) { setDoc(next); },
    isLoaded: () => getDoc() !== null,

    coll(name) {
      if (isGlobal(name)) {
        if (!doc()) throw new Error('Data has not been loaded yet');
        return doc()[name];
      }
      if (name === 'settings') {
        const id = requireStore();
        return bucketFor(doc(), id, blankBucket).settings;
      }
      return bucketFor(doc(), requireStore(), blankBucket)[name];
    },

    nextId(name) {
      if (isGlobal(name)) {
        if (!doc()) throw new Error('Data has not been loaded yet');
        const list = doc()[name];
        const highest = Array.isArray(list) && list.length ? Math.max(...list.map((r) => Number(r.id) || 0)) : 0;
        const n = Math.max(Number(doc().nextIds[name]) || 0, highest) + 1;
        doc().nextIds[name] = n;
        return n;
      }
      const bucket = bucketFor(doc(), requireStore(), blankBucket);
      const list = bucket[name];
      const highest = Array.isArray(list) && list.length ? Math.max(...list.map((r) => Number(r.id) || 0)) : 0;
      const n = Math.max(Number(bucket.nextIds[name]) || 0, highest) + 1;
      bucket.nextIds[name] = n;
      return n;
    },

    now,

    touch() {
      if (!doc()) throw new Error('Data has not been loaded yet');
      persist(doc(), null);
    },

    // A deep copy is swapped in before the mutator runs, so a throw halfway
    // through leaves both memory and disk exactly as they were. The copy is the
    // point: it is what makes "all of it or none of it" true.
    //
    // Re-entrant on purpose. Several callers, the batch till and the PromptPay
    // confirmation among them, already wrap their work and then call something
    // that wants a transaction of its own. If the inner one committed, a
    // failure on the second order of a batch would leave the first one paid on
    // disk, which is precisely the half-applied state this exists to prevent.
    // The outermost call already guarantees atomicity, so a nested one just
    // runs and lets the outer frame decide.
    transaction(mutator) {
      if (depth > 0) return mutator(doc());
      if (!doc()) throw new Error('Data has not been loaded yet');
      const previous = doc();
      const candidate = JSON.parse(JSON.stringify(previous));
      setDoc(candidate);
      depth += 1;
      try {
        const result = mutator(candidate);
        depth -= 1;
        persist(candidate, previous);
        return result;
      } catch (e) {
        depth -= 1;
        setDoc(previous);
        throw e;
      }
    },

    // True while a transaction is open. Services use it to tell an inner
    // transaction from an outer one when they need to know.
    inTransaction: () => depth > 0,

    withStore(store, fn) {
      return runWithStore(store, fn);
    },

    eachStore(fn) {
      if (!doc()) throw new Error('Data has not been loaded yet');
      const results = [];
      for (const store of doc().stores) results.push(runWithStore(store, () => fn(store)));
      return results;
    },

    storeList() {
      if (!doc()) throw new Error('Data has not been loaded yet');
      return doc().stores;
    },

    findStoreBySlug(slug) {
      const wanted = String(slug || '').trim().toLowerCase();
      if (!wanted || !doc()) return null;
      return doc().stores.find((s) => String(s.slug).toLowerCase() === wanted) || null;
    },

    findStoreById(id) {
      const wanted = Number(id);
      if (!wanted || !doc()) return null;
      return doc().stores.find((s) => Number(s.id) === wanted) || null;
    },

    defaultStore(fallbackSlug) {
      if (!doc()) return null;
      return this.findStoreBySlug(fallbackSlug) || doc().stores[0] || null;
    },

    storage,
  };

  return repo;
}

// bucketFor is shared with db.js so there is still exactly one rule about what a
// valid store id is and when a bucket gets created.
function bucketFor(doc, storeId, blankBucket) {
  const id = Number(storeId);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw Object.assign(new Error(`Invalid store id: ${storeId}`), { status: 500 });
  }
  if (!doc.storeData[String(id)]) doc.storeData[String(id)] = blankBucket();
  return doc.storeData[String(id)];
}

module.exports = { createRepo, bucketFor, MissingStoreContextError };
