import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ASSET_DIR, loadAssets } from './assets.js';
import { startTestApp, type TestCtx } from '../test-helpers.js';

let t: TestCtx;
beforeAll(async () => { t = await startTestApp(); });
afterAll(async () => { await t.close(); });

describe('hashed assets', () => {
  const m = loadAssets();
  it('names each file by the first 10 hex chars of its sha256', () => {
    const hash = createHash('sha256').update(readFileSync(new URL('app.css', ASSET_DIR))).digest('hex').slice(0, 10);
    expect(m.url('app.css')).toBe(`/admin/assets/app.${hash}.css`);
    expect(m.url('app.js')).toMatch(/^\/admin\/assets\/app\.[0-9a-f]{10}\.js$/);
  });

  it.each([['app.css', 'text/css'], ['app.js', 'text/javascript'], ['qr.js', 'text/javascript'], ['icon.svg', 'image/svg+xml'], ['mascot.svg', 'image/svg+xml']] as const)('serves %s immutable with %s', async (name, type) => {
    const r = await fetch(`${t.url}${m.url(name)}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain(type);
    expect(r.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('answers 404 for a stale hash, an unknown name and path tricks', async () => {
    for (const p of ['/admin/assets/app.0000000000.css', '/admin/assets/secret.txt', '/admin/assets/..%2F..%2Fpackage.json', '/admin/assets/app.css']) {
      expect((await fetch(`${t.url}${p}`)).status, p).toBe(404);
    }
  });

  it('ships a small, self-contained mascot SVG (no script, no external refs, titled)', () => {
    const svg = readFileSync(new URL('mascot.svg', ASSET_DIR), 'utf8');
    expect(Buffer.byteLength(svg)).toBeLessThan(6 * 1024);
    expect(svg).toMatch(/<svg\b[^>]*role="img"/);
    expect(svg).toMatch(/<title\b[^>]*>[^<]+<\/title>/);
    expect(svg).not.toMatch(/<script|<foreignObject|\son[a-z]+\s*=|(?:href|src)\s*=\s*"(?!#)|url\((?!#)|@import/i);
    expect(svg).not.toMatch(/Stig|#e3000b|#e2001a/i);
  });

  it('does not need a session', async () => {
    expect((await fetch(`${t.url}${m.url('app.css')}`, { redirect: 'manual' })).status).toBe(200);
  });
});
