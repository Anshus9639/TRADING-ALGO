import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { resolveBuildApiUrl } from './src/lib/buildConfig.mjs';

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  // Development serves from localhost; any build command must define
  // VITE_API_URL even when a custom mode such as `staging` is selected.
  resolveBuildApiUrl({ command, mode, env });

  return {
    plugins: [react()]
  };
});
