import { existsSync, readFileSync } from 'node:fs';
import { Cookie } from 'tough-cookie';
import { CHROME_UA, newSession, save } from './lib/http.js';
import { HANDLA, handlaCsrf, handlaHeaders } from './lib/handla-auth.js';
import { saveJar } from './lib/jar.js';

const storeId = process.env.HANDLA_STORE_ID;
if (!storeId) throw new Error('set HANDLA_STORE_ID in .env (from spike/06)');
const cookiePath = 'spike/out/handla-cookie-A.txt';
if (!existsSync(cookiePath)) {
  throw new Error(
    `missing ${cookiePath} — log in to handlaprivatkund.ica.se in Chrome, copy the Cookie request ` +
      'header of any /api/cart/ call (DevTools → Network → request → Headers), and paste it into that file',
  );
}
const header = readFileSync(cookiePath, 'utf8').trim();
if (!header) throw new Error(`${cookiePath} is empty — paste the Cookie header value into it`);
const s = newSession(CHROME_UA);
for (const part of header.split(';')) {
  const [k, ...v] = part.trim().split('=');
  if (k) await s.jar.setCookie(new Cookie({ key: k, value: v.join('='), domain: 'handlaprivatkund.ica.se', path: '/', secure: true }), `${HANDLA}/`);
  else console.log(`warning: skipping cookie fragment with empty key: "${part.trim()}"`);
}
const csrf = await handlaCsrf(s, storeId);
const cart = await s.fetch(`${HANDLA}/stores/${storeId}/api/cart/v1/carts/active`, { headers: handlaHeaders(storeId, csrf) });
console.log(`cart via pasted cookies HTTP ${cart.status}`); save('handla-cart-via-pasted-cookies', { status: cart.status });
if (cart.ok) saveJar(s.jar, 'handla-jar-A');
