const TRANSACTIONS_UNAVAILABLE = 'TRANSACTIONS_UNAVAILABLE';

// Trading writes must be atomic. This probe verifies the connected deployment
// is a replica set (or mongos) so session.withTransaction() is actually
// supported; standalone servers must refuse trading rather than silently
// falling back to unsafe read-modify-save updates.
function createTransactionSupport({ mongoose, cacheMs = 30000, now = Date.now } = {}) {
  if (!mongoose) throw new TypeError('createTransactionSupport requires mongoose.');

  let cached = { value: null, ts: 0 };

  async function isSupported() {
    const db = mongoose.connection.db;
    if (!db) return false;

    if (cached.value !== null && now() - cached.ts < cacheMs) return cached.value;

    let supported = false;
    try {
      const hello = await db.admin().command({ hello: 1 });
      supported = Boolean(hello.setName) || hello.msg === 'isdbgrid';
    } catch {
      supported = false;
    }

    cached = { value: supported, ts: now() };
    return supported;
  }

  function reset() {
    cached = { value: null, ts: 0 };
  }

  return { isSupported, reset };
}

const defaultSupport = createTransactionSupport({ mongoose: require('mongoose') });

module.exports = {
  TRANSACTIONS_UNAVAILABLE,
  createTransactionSupport,
  defaultTransactionSupport: defaultSupport
};
