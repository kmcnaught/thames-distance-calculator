// Overpass API helper with mirror fallback.
//
// Usage: import { overpass } from './overpass.mjs';
//        const json = await overpass(`[out:json][timeout:180]; … out geom;`);
//
// Pass { cachePath } to persist the raw response to disk and short-circuit
// subsequent calls with the same query. Useful during iterative dev when
// Overpass is slow or flaky. The cache is invalidated when the query changes.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const UA = 'thameswise-build/0.1 (Thames trip planner)';

export async function overpass(query, { timeoutMs = 240_000, cachePath = null } = {}) {
  if (cachePath && existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (cached.__query === query) {
      process.stderr.write(`[overpass] cache hit: ${cachePath}\n`);
      return cached.response;
    }
    process.stderr.write(`[overpass] cache miss (query changed): ${cachePath}\n`);
  }

  let lastErr;
  for (const endpoint of ENDPOINTS) {
    process.stderr.write(`[overpass] POST ${endpoint}\n`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': UA,
        },
        body: 'data=' + encodeURIComponent(query),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      const json = await res.json();
      process.stderr.write(`[overpass] ok, ${json.elements?.length ?? 0} elements\n`);
      if (cachePath) {
        mkdirSync(dirname(cachePath), { recursive: true });
        writeFileSync(cachePath, JSON.stringify({ __query: query, response: json }));
        process.stderr.write(`[overpass] cached → ${cachePath}\n`);
      }
      return json;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      process.stderr.write(`[overpass] ${endpoint} failed: ${err.message}\n`);
    }
  }
  throw new Error(`All Overpass endpoints failed. Last error: ${lastErr?.message}`);
}
