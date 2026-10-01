import qrcode from 'qrcode-terminal';
import { FORM, form, hidden, type Session } from './http.js';

export const IMS = 'https://ims.icagruppen.se';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Print an animated BankID QR in the terminal (one frame per poll). */
export function printQr(qr: string): void {
  console.clear();
  console.log('Scan with the BankID app (the code changes every second):\n');
  qrcode.generate(qr, { small: true });
}

/**
 * Drive ICA's `icase-bankid-qr` authenticator headlessly. Precondition: the session already
 * GET-ed an ims /oauth/v2/authorize URL (any client: ica.se, the app's DCR client, OcadoB2C) so ims
 * holds the authorization request in its cookies. Returns the response of the final form POST with
 * `redirect: 'manual'`; the caller decides whether to follow `location` (web/Handla) or parse it (app).
 */
export async function bankidQrRelay(s: Session, onQr: (qr: string) => void = printQr, pollMs = 1000): Promise<{ status: number; location: string | null }> {
  const start = await s.fetch(`${IMS}/authn/authenticate/icase-bankid-qr`);
  if (!start.ok) throw new Error(`bankid start: HTTP ${start.status}`);
  const deadline = Date.now() + 3 * 60_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error('bankid: not scanned within 3 minutes');
    const r = await s.fetch(`${IMS}/authn/authenticate/icase-bankid-qr/wait`, { method: 'POST', headers: { Accept: 'application/json' } });
    const j = (await r.json().catch(() => ({}))) as { stopPolling?: boolean; message?: { qrCode?: string } };
    if (j.stopPolling) break;
    if (!j.message?.qrCode) throw new Error(`bankid poll: no qrCode (HTTP ${r.status})`);
    onQr(j.message.qrCode);
    await sleep(pollMs);
  }
  const launch = await s.fetch(`${IMS}/authn/authenticate/icase-bankid-qr/launch`, { method: 'POST', headers: FORM, body: form({ _pollingDone: 'true' }) });
  const html = await launch.text();
  const action = /id="form1" action="([^"]*)"/.exec(html)?.[1];
  if (!action) throw new Error(`bankid launch: no form1 action (HTTP ${launch.status})`);
  const token = hidden(html, 'token'); const state = hidden(html, 'state');
  const actionUrl = new URL(action.replace(/%3F/g, '?'), launch.url).toString();
  const done = await s.fetch(actionUrl, { method: 'POST', headers: FORM, body: form({ token, state }), redirect: 'manual' });
  console.log(`bankid: final POST → HTTP ${done.status}`);
  return { status: done.status, location: done.headers.get('location') };
}
