import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Router } from 'express';

export const ASSET_NAMES = ['app.css', 'app.js', 'qr.js', 'icon.svg', 'mascot.svg'] as const;
export type AssetName = (typeof ASSET_NAMES)[number];
export type AssetManifest = { url(name: AssetName): string; router: Router };
/** `src/admin/assets/` in dev and tests, `dist/admin/assets/` after `pnpm build` (the build copies the folder). */
export const ASSET_DIR = new URL('./assets/', import.meta.url);
const TYPES: Record<string, string> = { css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', svg: 'image/svg+xml' };

/** Reads every asset once at startup, hashes it, and serves it only under its hashed name. */
export function loadAssets(dir: URL = ASSET_DIR): AssetManifest {
  const byPublicName = new Map<string, { body: Buffer; type: string }>();
  const urls = new Map<AssetName, string>();
  for (const name of ASSET_NAMES) {
    const body = readFileSync(new URL(name, dir));
    const hash = createHash('sha256').update(body).digest('hex').slice(0, 10);
    const dot = name.lastIndexOf('.');
    const ext = name.slice(dot + 1);
    const publicName = `${name.slice(0, dot)}.${hash}.${ext}`;
    byPublicName.set(publicName, { body, type: TYPES[ext]! });
    urls.set(name, `/admin/assets/${publicName}`);
  }
  const router = Router();
  router.get('/:file', (req, res) => {
    const a = byPublicName.get(req.params.file);
    if (!a) { res.status(404).type('text/plain').send('not found'); return; }
    res.set('Cache-Control', 'public, max-age=31536000, immutable').type(a.type).send(a.body);
  });
  return { url: (name) => urls.get(name)!, router };
}
