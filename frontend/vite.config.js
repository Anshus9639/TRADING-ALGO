import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { resolveApiUrl } from './src/lib/apiConfig.mjs';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  // Development falls back to localhost; production must define VITE_API_URL.
  resolveApiUrl({ ...env, MODE: mode });

  return {
    plugins: [react()]
  };
});
