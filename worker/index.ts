import { apiFetch, WorkersCache } from "../src/core/core";

interface Env {
  ASSETS: Fetcher;
}

// Shared across requests: wraps the Workers Cache API.
const cache = new WorkersCache(caches.default);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const api = await apiFetch(cache, request);
    if (api) return api;
    // Static frontend (Vite build output) for everything else.
    return env.ASSETS.fetch(request);
  },
};