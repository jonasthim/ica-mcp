import { CHROME_UA, newSession, redact, save } from './lib/http.js';
import { HANDLA, handlaBankidLogin, handlaCsrf, handlaHeaders } from './lib/handla-auth.js';
import { loadJar } from './lib/jar.js';

const storeId = process.env.HANDLA_STORE_ID;
if (!storeId) throw new Error('set HANDLA_STORE_ID in .env (from spike/06)');
const startUrl = process.env.HANDLA_LOGIN_START_URL;
const saved = loadJar('handla-jar-A');
if (!saved && !startUrl) throw new Error('set HANDLA_LOGIN_START_URL in .env (from the HAR, Task 0.9) or provide spike/out/handla-jar-A.json');
const s = newSession(CHROME_UA, saved ?? undefined);
if (!saved) await handlaBankidLogin(s, startUrl!, 'A');
const csrf = await handlaCsrf(s, storeId);
const base = `${HANDLA}/stores/${storeId}/api`;
const slotsPath = process.env.HANDLA_SLOTS_PATH ?? 'ecomslots/v1/slots'; // from docs/api-notes.md — JS-bundle guess until Task 0.9 confirms it from the HAR
const r = await s.fetch(`${base}/${slotsPath}`, { headers: handlaHeaders(storeId, csrf) });
console.log(`slots GET HTTP ${r.status}`); save('handla-slots-redacted', redact(await r.json().catch(() => null)));

// Reservation branch: only when explicitly opted into (HANDLA_TRY_RESERVE=1) AND a body is
// supplied (HANDLA_RESERVE_BODY, from the HAR) — the default run only lists slots.
if (process.env.HANDLA_TRY_RESERVE === '1') {
  const reserveBody = process.env.HANDLA_RESERVE_BODY;
  if (!reserveBody) throw new Error('HANDLA_TRY_RESERVE=1 but HANDLA_RESERVE_BODY is unset — set it (JSON, from the HAR) or unset HANDLA_TRY_RESERVE to only list slots');
  const body = JSON.parse(reserveBody) as unknown;
  // Only when docs/api-notes.md says reservation is free of payment.
  const res = await s.fetch(`${base}/ecomslots/v1/slots/reservation`, { method: 'POST', headers: handlaHeaders(storeId, csrf), body: JSON.stringify(body) });
  console.log(`reserve → HTTP ${res.status}`); save('handla-reserve-redacted', redact(await res.json().catch(() => null)));
  console.log('Now release the slot in the browser (Ändra leveranstid → avboka) and confirm nothing was ordered.');
}
