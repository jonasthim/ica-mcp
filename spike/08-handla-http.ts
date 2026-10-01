import { CHROME_UA, newSession, redact, save } from './lib/http.js';
import { HANDLA, handlaBankidLogin, handlaCartQuantity, handlaCsrf, handlaHeaders } from './lib/handla-auth.js';
import { loadJar } from './lib/jar.js';

const storeId = process.env.HANDLA_STORE_ID;
if (!storeId) throw new Error('set HANDLA_STORE_ID in .env (from spike/06)');
const startUrl = process.env.HANDLA_LOGIN_START_URL;
const productId = process.env.HANDLA_TEST_PRODUCT_ID; // from spike/out/handla-search-redacted.json (productId of mjölk)
const saved = loadJar('handla-jar-A');
if (!saved && !startUrl) throw new Error('set HANDLA_LOGIN_START_URL in .env (from the HAR, Task 0.9) or provide spike/out/handla-jar-A.json');
const s = newSession(CHROME_UA, saved ?? undefined);
if (!saved) await handlaBankidLogin(s, startUrl!, 'A');
else console.log('reusing saved Handla session (delete spike/out/handla-jar-A.json to scan again)');
const cookies = await s.jar.getCookies(`${HANDLA}/`);
console.log(`login ok; cookies: ${cookies.map((c) => `${c.key}(exp ${c.expires instanceof Date ? c.expires.toISOString().slice(0, 10) : c.expires})`).join(', ')}`);
const csrf = await handlaCsrf(s, storeId);
const base = `${HANDLA}/stores/${storeId}/api`;
const readCart = async (): Promise<{ status: number; json: unknown }> => {
  const r = await s.fetch(`${base}/cart/v1/carts/active`, { headers: handlaHeaders(storeId) });
  return { status: r.status, json: await r.json() };
};
const initialCart = await readCart();
console.log(`cart GET HTTP ${initialCart.status}`); save('handla-cart-redacted', redact(initialCart.json));

if (productId) {
  const quantityOf = (cart: unknown): number | 'unknown' => handlaCartQuantity(cart, productId);
  const existing = quantityOf(initialCart.json);
  if (existing === 'unknown') {
    throw new Error('cart shape not recognised — inspect spike/out/handla-cart-redacted.json and update handlaCartQuantity');
  }
  if (existing > 0) {
    throw new Error(
      `HANDLA_TEST_PRODUCT_ID ${productId} is already in the cart (quantity ${existing}) — ` +
        'pick another HANDLA_TEST_PRODUCT_ID so this spike cannot clobber a real cart line',
    );
  }
  const post = (qty: number) =>
    s.fetch(`${base}/cart/v1/carts/active/apply-quantity`, {
      method: 'POST',
      headers: handlaHeaders(storeId, csrf),
      body: JSON.stringify([{ productId, quantity: qty }]),
    });
  // Reversible-cart rule (see spike/03-lists-shared.ts): a mid-way failure must never leave the
  // test item sitting in the real cart. We confirmed above the product starts at quantity 0 (and
  // that the cart shape is recognised), so cleanup below can restore to 0 — but *how* to reach 0
  // depends on semantics apply-quantity uses (absolute vs. delta), which this script exists to
  // determine. `semantics` is set once inferred and read by the finally block. A 'unknown'
  // quantity read at any point (the shape stopped matching mid-run) is never treated as 0.
  let semantics: 'absolute' | 'delta' | 'unknown' = 'unknown';
  try {
    const a1 = await post(1); console.log(`apply +1 → HTTP ${a1.status}`);
    save('handla-apply-1-redacted', redact(await a1.json().catch(() => null)));
    const q1 = quantityOf((await readCart()).json); console.log(`quantity after 1st post(1): ${q1}`);
    const a2 = await post(1); console.log(`apply +1 again → HTTP ${a2.status}`);
    const cartAfterTwo = await readCart();
    const q2 = quantityOf(cartAfterTwo.json); console.log(`quantity after 2nd post(1): ${q2}`);
    save('handla-cart-after-two-adds-redacted', redact(cartAfterTwo.json));
    if (q1 === 1 && q2 === 1) {
      semantics = 'absolute'; console.log('semantics: ABSOLUTE (apply-quantity sets the cart line directly)');
    } else if (q1 === 1 && q2 === 2) {
      semantics = 'delta'; console.log('semantics: DELTA (apply-quantity adds to the existing line)');
    } else {
      console.log(`semantics: UNKNOWN (unexpected quantities ${q1}, ${q2} — inspect the saved JSON)`);
    }
  } finally {
    try {
      // Best-effort fallback for anything the semantics-specific branches below can't handle:
      // zero it, re-read, and if a number comes back non-zero, cancel it out as a delta.
      const bestEffortRestore = async (): Promise<void> => {
        const r = await post(0); console.log(`cleanup: apply 0 (best effort) → HTTP ${r.status}`);
        const after = quantityOf((await readCart()).json);
        if (typeof after === 'number' && after !== 0) {
          const r2 = await post(-after); console.log(`cleanup: apply ${-after} (retry) → HTTP ${r2.status}`);
        }
      };
      const current = quantityOf((await readCart()).json);
      if (semantics === 'absolute') {
        const r = await post(0); console.log(`cleanup: apply 0 (absolute) → HTTP ${r.status}`);
      } else if (semantics === 'delta' && typeof current === 'number') {
        const r = await post(-current); console.log(`cleanup: apply ${-current} (delta) → HTTP ${r.status}`);
      } else {
        console.log(`cleanup: semantics=${semantics} current=${current} — using best-effort restore`);
        await bestEffortRestore();
      }
      const finalCart = await readCart();
      save('handla-cart-final-redacted', redact(finalCart.json));
      const finalQuantity = quantityOf(finalCart.json);
      if (finalQuantity === 0) console.log('cleanup: cart restored');
      else if (finalQuantity === 'unknown') console.log('cleanup: WARNING cart shape not recognised on final read — verify by hand');
      else console.log(`cleanup: WARNING quantity is now ${finalQuantity} — remove it by hand`);
    } catch (e) {
      console.log(`cleanup failed: ${String(e)}`);
    }
  }
}
