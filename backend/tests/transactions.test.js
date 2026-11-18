const { createTransactionSupport } = require('../lib/transactions');

function fakeMongoose(handlers) {
  const calls = [];
  const admin = {
    async command(command) {
      const name = Object.keys(command)[0];
      calls.push(name);
      const handler = handlers[name];
      if (!handler) throw new Error(`Unexpected command ${name}`);
      return handler(command);
    }
  };
  return {
    calls,
    mongoose: { connection: { db: { admin: () => admin } } }
  };
}

function commandNotFound() {
  const err = new Error('no such command: hello');
  err.code = 59;
  err.codeName = 'CommandNotFound';
  return err;
}

describe('transaction support probe', () => {
  test('accepts a replica set reported by hello', async () => {
    const { mongoose, calls } = fakeMongoose({
      hello: async () => ({ setName: 'rs0' })
    });
    const support = createTransactionSupport({ mongoose });
    expect(await support.isSupported()).toBe(true);
    expect(calls).toEqual(['hello']);
  });

  test('accepts mongos reported by hello', async () => {
    const { mongoose } = fakeMongoose({
      hello: async () => ({ msg: 'isdbgrid' })
    });
    const support = createTransactionSupport({ mongoose });
    expect(await support.isSupported()).toBe(true);
  });

  test('falls back to isMaster only when hello is not implemented', async () => {
    const { mongoose, calls } = fakeMongoose({
      hello: async () => { throw commandNotFound(); },
      isMaster: async () => ({ setName: 'legacy-rs' })
    });
    const support = createTransactionSupport({ mongoose });
    expect(await support.isSupported()).toBe(true);
    expect(calls).toEqual(['hello', 'isMaster']);
  });

  test('a failed isMaster fallback leaves trading disabled', async () => {
    const { mongoose } = fakeMongoose({
      hello: async () => { throw commandNotFound(); },
      isMaster: async () => { throw new Error('connection reset'); }
    });
    const support = createTransactionSupport({ mongoose });
    expect(await support.isSupported()).toBe(false);
  });

  test('a standalone server is rejected without another probe', async () => {
    const { mongoose, calls } = fakeMongoose({
      hello: async () => ({ isWritablePrimary: true })
    });
    const support = createTransactionSupport({ mongoose });
    expect(await support.isSupported()).toBe(false);
    expect(calls).toEqual(['hello']);
  });

  test('an unrecognized hello failure is not masked by the legacy probe', async () => {
    const unauthorized = new Error('not authorized on admin to execute command');
    unauthorized.code = 13;
    unauthorized.codeName = 'Unauthorized';
    const { mongoose, calls } = fakeMongoose({
      hello: async () => { throw unauthorized; }
    });
    const support = createTransactionSupport({ mongoose });
    expect(await support.isSupported()).toBe(false);
    expect(calls).toEqual(['hello']);
  });

  test('the probe result is cached until the cache window or reset', async () => {
    let clock = 1_000;
    const { mongoose, calls } = fakeMongoose({
      hello: async () => ({ setName: 'rs0' })
    });
    const support = createTransactionSupport({
      mongoose,
      cacheMs: 500,
      now: () => clock
    });

    expect(await support.isSupported()).toBe(true);
    expect(await support.isSupported()).toBe(true);
    expect(calls).toEqual(['hello']);

    clock += 501;
    expect(await support.isSupported()).toBe(true);
    expect(calls).toEqual(['hello', 'hello']);

    support.reset();
    expect(await support.isSupported()).toBe(true);
    expect(calls).toEqual(['hello', 'hello', 'hello']);
  });
});
