// Vite aliases `socket.io-client` to this module when building with
// `--mode e2e`, so the workstation can be exercised in a browser without a
// live exchange bridge. Tests drive server events through
// `window.__marketStream.serverEmit(...)`.
const sockets = [];
const focusEvents = [];

function dispatch(socket, event, payload) {
  const handlers = socket.__handlers.get(event);
  if (!handlers) return;
  for (const handler of [...handlers]) handler(payload);
}

function createSocket() {
  let connected = false;
  const socket = {
    __handlers: new Map(),
    emitted: [],
    get connected() {
      return connected;
    },
    on(event, handler) {
      if (typeof handler !== 'function') return socket;
      const handlers = socket.__handlers.get(event) || new Set();
      handlers.add(handler);
      socket.__handlers.set(event, handlers);
      return socket;
    },
    off(event, handler) {
      const handlers = socket.__handlers.get(event);
      if (handlers) handlers.delete(handler);
      return socket;
    },
    removeAllListeners() {
      socket.__handlers.clear();
      return socket;
    },
    emit(event, payload) {
      socket.emitted.push({ event, payload });
      if (event === 'market:focus') focusEvents.push(payload);
      return socket;
    },
    disconnect() {
      connected = false;
      return socket;
    },
    __connect() {
      connected = true;
      dispatch(socket, 'connect', undefined);
    }
  };
  sockets.push(socket);
  // The real client connects asynchronously; deferring lets the hook register
  // its handlers before the first `connect` (and the focus emit it triggers).
  setTimeout(() => socket.__connect(), 0);
  return socket;
}

const control = {
  get focusEvents() {
    return focusEvents.slice();
  },
  get socketCount() {
    return sockets.length;
  },
  connections() {
    return sockets.filter(socket => socket.connected).length;
  },
  serverEmit(event, payload) {
    for (const socket of sockets) {
      if (socket.connected) dispatch(socket, event, payload);
    }
  },
  reset() {
    sockets.length = 0;
    focusEvents.length = 0;
  }
};

if (typeof window !== 'undefined') {
  window.__marketStream = control;
}

export default function io() {
  return createSocket();
}
