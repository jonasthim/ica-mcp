import { existsSync, readFileSync } from 'node:fs';
import { CHROME_UA, IPHONE_UA, newSession, now, save } from './lib/http.js';
import { WEB, appRefresh, gatewayApi, type AppState } from './lib/app-auth.js';
import { loadJar, saveJar } from './lib/jar.js';

// Run daily (cron) to learn: app refresh-token rotation/lifetime (if app tokens exist) and web thSessionId lifetime.
for (const who of ['A', 'B'] as const) {
  const logName = `session-log-${who}`;
  const log: unknown[] = existsSync(`spike/out/${logName}.json`) ? JSON.parse(readFileSync(`spike/out/${logName}.json`, 'utf8')) : [];
  const appPath = `spike/out/app-state-${who}.json`;
  if (existsSync(appPath)) {
    const state = JSON.parse(readFileSync(appPath, 'utf8')) as AppState;
    const s = newSession(IPHONE_UA);
    try {
      const fresh = await appRefresh(s, state);
      const rotated = fresh.token.refresh_token !== state.token.refresh_token;
      let oldStillWorks: boolean | null = null;
      if (rotated) { try { await appRefresh(s, state); oldStillWorks = true; } catch { oldStillWorks = false; } }
      const probe = await gatewayApi(s, fresh.token.access_token, 'GET', 'sverige/digx/mobile/bonusservice/v1/bonus/current');
      log.push({ at: now(), kind: 'app', ok: true, issuedAt: state.issuedAt, rotated, oldStillWorks, probeStatus: probe.status });
      save(`app-state-${who}`, fresh);
      console.log(`${who} app: refresh ok rotated=${rotated} oldStillWorks=${oldStillWorks} probe=${probe.status}`);
    } catch (e) { log.push({ at: now(), kind: 'app', ok: false, issuedAt: state.issuedAt, error: String(e) }); console.log(`${who} app: refresh FAILED: ${String(e)}`); }
  }
  const jar = loadJar(`web-jar-${who}`);
  if (jar) {
    const s = newSession(CHROME_UA, jar);
    const r = await s.fetch(`${WEB}/api/user/information`, { headers: { Accept: 'application/json' } });
    const info = (await r.json().catch(() => ({}))) as { accessToken?: string; loginState?: number };
    // Review Focus 1: a dead session still answers 200 and may hand out a token → also make a real call.
    const real = info.accessToken ? await gatewayApi(s, info.accessToken, 'GET', 'sverige/digx/shopping-list/v1/api/list/all') : null;
    const alive = r.status === 200 && info.loginState !== 0 && real?.status === 200;
    const th = (await s.jar.getCookies(`${WEB}/`)).find((c) => c.key === 'thSessionId');
    log.push({ at: now(), kind: 'web', alive, httpStatus: r.status, loginState: info.loginState, listAllStatus: real?.status ?? null, thExpires: th?.expires instanceof Date ? th.expires.toISOString() : String(th?.expires) });
    saveJar(s.jar, `web-jar-${who}`);   // keep any refreshed cookies
    console.log(`${who} web: alive=${alive} loginState=${info.loginState} list/all=${real?.status ?? 'n/a'}`);
  }
  save(logName, log);
}
