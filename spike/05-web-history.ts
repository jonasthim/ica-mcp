import { CHROME_UA, newSession, redact, save } from './lib/http.js';
import { WEB } from './lib/app-auth.js';
import { loadJar } from './lib/jar.js';

const jar = loadJar('web-jar-A'); if (!jar) throw new Error('run 01-bankid-login first');
const s = newSession(CHROME_UA, jar);
const months = await s.fetch(`${WEB}/api/cpa/purchases/historical/me/monthsummaries`, { headers: { Accept: 'application/json' } });
const mj = (await months.json().catch(() => null)) as { monthSummaries?: { year: number; month: number }[] } & Record<string, unknown> | null;
console.log(`monthsummaries HTTP ${months.status}; months=${mj?.monthSummaries?.length}`);
save('history-months-redacted', redact(mj));
const latest = mj?.monthSummaries?.at(-1) ?? mj?.monthSummaries?.[0];
if (latest) {
  const ym = `${latest.year}-${String(latest.month).padStart(2, '0')}`;
  const r = await s.fetch(`${WEB}/api/cpa/purchases/historical/me/byyearmonth/${ym}`, { headers: { Accept: 'application/json' } });
  console.log(`byyearmonth ${ym} HTTP ${r.status}`);
  save('history-month-redacted', redact(await r.json().catch(() => null)));
}
