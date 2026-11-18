import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { resolveBuildApiUrl } from './src/lib/buildConfig.mjs';

// Only the `e2e` mode swaps the exchange bridge for the deterministic stub in
// tests/e2e/socketStub.mjs. Production and preview builds are untouched.
const E2E_SOCKET_STUB = fileURLToPath(new URL('./tests/e2e/socketStub.mjs', import.meta.url));

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  // Development serves from localhost; any build command must define
  // VITE_API_URL even when a custom mode such as `staging` is selected.
  resolveBuildApiUrl({ command, mode, env });

  return {
    plugins: [react()],
    resolve: {
      alias: mode === 'e2e' ? { 'socket.io-client': E2E_SOCKET_STUB } : {}
    }
  };
});
