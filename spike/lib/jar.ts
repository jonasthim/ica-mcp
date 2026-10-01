import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { CookieJar } from 'tough-cookie';

const path = (name: string) => `spike/out/${name}.json`;
export function saveJar(jar: CookieJar, name: string): void {
  mkdirSync('spike/out', { recursive: true });
  writeFileSync(path(name), JSON.stringify(jar.serializeSync(), null, 2));
  console.log(`saved ${path(name)} (cookies, gitignored)`);
}
export function loadJar(name: string): CookieJar | null {
  if (!existsSync(path(name))) return null;
  return CookieJar.deserializeSync(JSON.parse(readFileSync(path(name), 'utf8')) as Parameters<typeof CookieJar.deserializeSync>[0]);
}
