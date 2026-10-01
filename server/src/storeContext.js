const { AsyncLocalStorage } = require('async_hooks');

// One request can touch exactly one store. The active store is carried on an
// AsyncLocalStorage so `db.coll()` returns that store's data without every
// route having to thread a store argument through its handlers.
const storage = new AsyncLocalStorage();

function runWithStore(store, fn) {
  return storage.run(store || null, fn);
}

function currentStore() {
  return storage.getStore() || null;
}

function currentStoreId() {
  const store = currentStore();
  return store ? Number(store.id) || null : null;
}

module.exports = { runWithStore, currentStore, currentStoreId };
