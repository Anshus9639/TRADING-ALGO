import axios from 'axios';
import {
  DEFAULT_DEV_API_URL,
  resolveApiUrl,
  resolveApiOrigin,
  buildAuthHeaders
} from './apiConfig.mjs';

export { DEFAULT_DEV_API_URL };

export const API_URL = resolveApiUrl(import.meta.env);
export const API_ORIGIN = resolveApiOrigin(import.meta.env);
export const authHeaders = buildAuthHeaders;

export const api = axios.create({ baseURL: API_URL });

export default api;
