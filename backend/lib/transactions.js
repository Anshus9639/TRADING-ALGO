const TRANSACTIONS_UNAVAILABLE = 'TRANSACTIONS_UNAVAILABLE';
// MongoDB servers older than 4.0.3 do not implement `hello`. They still
// support transactions on a replica set, so a CommandNotFound answer is the
// only case that may retry with the legacy `isMaster` probe.
const COMMAND_NOT_FOUND = 59;

function isCommandNotFound(err) {
  return Boolean(err) && (err.code === COMMAND_NOT_FOUND || err.codeName === 'CommandNotFound');
}

// Trading writes must be atomic. This probe verifies the connected deployment
// is a replica set (or mongos) so session.withTransaction() is actually
// supported; standalone servers must refuse trading rather than silently
// falling back to unsafe read-modify-save updates.
function createTransactionSupport({ mongoose, cacheMs = 30000, now = Date.now } = {}) {
  if (!mongoose) throw new TypeError('createTransactionSupport requires mongoose.');

  let cached = { value: null, ts: 0 };

  function topologySupports(hello) {
    return Boolean(hello && (hello.setName || hello.msg === 'isdbgrid'));
  }

  async function probeAdmin(admin) {
    try {
      return topologySupports(await admin.command({ hello: 1 }));
    } catch (err) {
      // Any other failure (network, authorization, standalone rejection) must
      // leave trading disabled instead of being masked by a fallback probe.
      if (!isCommandNotFound(err)) return false;
    }
    try {
      return topologySupports(await admin.command({ isMaster: 1 }));
    } catch {
      return false;
    }
  }

  async function isSupported() {
    const db = mongoose.connection.db;
    if (!db) return false;

    if (cached.value !== null && now() - cached.ts < cacheMs) return cached.value;

    const supported = await probeAdmin(db.admin());

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
