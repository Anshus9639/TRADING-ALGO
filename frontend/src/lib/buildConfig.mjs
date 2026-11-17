import { resolveApiUrl } from './apiConfig.mjs';

// Vite runs `build` for every production bundle, including custom modes such as
// `vite build --mode staging`. The command, not the mode name, decides whether
// the output can fall back to the development default.
export function resolveBuildApiUrl({ command, mode, env = {} } = {}) {
  return resolveApiUrl({ ...env, MODE: mode, PROD: command === 'build' });
}
