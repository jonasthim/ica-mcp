import { s } from '../i18n.js';
import type { PageCtx } from '../page-ctx.js';
import { shell } from './layout.js';
import { button, card, dataTable, icon, mascot, postForm, quip } from './components.js';
import { escapeHtml as e } from './escape.js';
import { appStatus, icaStatus, NO_WEB_SESSION, statusBadge, timeTag } from './status.js';

const t = s.ica;

export type IcaAppAccessView = { expiresAt: string | null; lastOkAt: string | null; lastError: string | null };
export type IcaAccountView = {
  displayName: string; expiresAt: string | null; lastOkAt: string | null; lastError: string | null; hasSession: boolean;
  /** The web session's loginState as last recorded (2 = purchase history available) and when it was checked. */
  loginState?: number | null; loginStateAt?: string | null;
  /** The experimental app session, if one is stored. */
  app?: IcaAppAccessView | undefined;
};

const dl = (rows: [string, string, string?][]): string =>
  `<dl class="kv">${rows.map(([k, v, cls]) => `<dt>${k}</dt><dd${cls ? ` class="${cls}"` : ''}>${v}</dd>`).join('')}</dl>`;
const when = (iso: string | null, fallback: string): string => (iso ? timeTag(iso) : e(fallback));

/**
 * Purchase history as last observed, always with the time of that observation (it lapses on its own within hours, so
 * "Available" is only a claim about that moment). Never inferred from elapsed time.
 */
function purchaseText(a: IcaAccountView): string {
  const at = a.loginStateAt ? ` · ${timeTag(a.loginStateAt)}` : '';
  if (a.loginState === undefined || a.loginState === null) return a.loginStateAt ? `${e(s.common.unknown)}${at}` : e(t.purchaseUnknown);
  return `${e(a.loginState === 2 ? t.purchaseAvailable : t.purchaseNeedsBankId)}${at}`;
}

function webCard(ctx: PageCtx, a: IcaAccountView | undefined): string {
  const st = icaStatus(a && (a.hasSession ? a : { expiresAt: null, lastOkAt: null, lastError: NO_WEB_SESSION }));
  const connect = postForm(ctx, { action: '/admin/ica/connect', body: button({ label: a ? t.reconnect : t.connect, kind: !a || st.tone === 'bad' ? 'primary' : 'secondary' }) });
  if (!a) return card({ title: t.webTitle, aside: statusBadge(st), body: `<p>${t.notConnected}</p>`, footer: connect });
  const rows: [string, string, string?][] = [[t.account, `<span class="wrap-anywhere">${e(a.displayName)}</span>`]];
  if (a.hasSession) {
    rows.push([t.sessionExpires, when(a.expiresAt, t.sessionNoExpiry)], [t.lastWorked, when(a.lastOkAt, s.common.never)]);
    if (a.lastError) rows.push([t.lastError, e(a.lastError), 'err']);
    rows.push([t.purchaseHistory, purchaseText(a)]);
  }
  const missing = a.hasSession ? '' : `<p class="err">${t.noWebSession}</p>`;
  return card({ title: t.webTitle, aside: statusBadge(st), body: `${dl(rows)}${missing}`, footer: connect });
}

function appCard(ctx: PageCtx, a: IcaAccountView | undefined): string {
  const app = a?.app;
  const st = appStatus(app);
  const intro = `<p class="muted"><strong>${t.experimental}.</strong> ${e(t.appIntro)}</p><p class="muted">${e(t.appPurchaseNote)}</p>`;
  if (!a) return card({ title: t.appTitle, aside: statusBadge(st), body: `${intro}<p>${t.connectFirst}</p>` });
  const details = app
    ? dl([
      [t.tokenExpires, when(app.expiresAt, s.common.unknown)], [t.lastWorked, when(app.lastOkAt, s.common.never)],
      ...(app.lastError ? [[t.lastError, e(app.lastError), 'err'] as [string, string, string]] : []),
    ])
    : `<p>${t.appNotConnected}</p>`;
  return card({
    title: t.appTitle, aside: statusBadge(st), body: `${intro}${details}`,
    footer: postForm(ctx, { action: '/admin/ica/connect-app', body: button({ label: app ? t.appReconnect : t.appConnect, kind: 'secondary' }) }),
  });
}

/**
 * The ICA account: a status card each for the web session and the (experimental) app access, a self-service
 * disconnect (to switch to another person's ICA account), and the diagnostics link.
 */
export function icaPage(ctx: PageCtx, o: { account: IcaAccountView | undefined }): string {
  const disconnect = o.account ? card({
    title: t.disconnectTitle, body: `<p class="muted">${e(t.disconnectHint)}</p>`,
    footer: postForm(ctx, { action: '/admin/ica/disconnect', body: button({ label: t.disconnect, kind: 'secondary' }) }),
  }) : '';
  const diagnostics = card({
    title: t.diagnostics, body: `<p class="muted">${t.diagnosticsHint}</p>`,
    footer: `<a class="btn btn-secondary" href="/admin/ica/diagnostics">${t.diagnostics}</a>`,
  });
  return shell(ctx, { title: t.title, nav: 'ica', body: `<div class="grid-cards">${webCard(ctx, o.account)}${appCard(ctx, o.account)}</div>${disconnect}${diagnostics}` });
}

/** The confirmation step of the self-service disconnect (a shared account is only unlinked for this user). */
export function icaDisconnectConfirmPage(ctx: PageCtx, o: { shared: boolean }): string {
  const form = postForm(ctx, {
    action: '/admin/ica/disconnect', className: 'cluster',
    body: `<input type="hidden" name="confirm" value="yes">${button({ label: t.disconnect, kind: 'danger' })}<a class="btn btn-secondary" href="/admin/ica">${s.common.cancel}</a>`,
  });
  return shell(ctx, { title: t.title, nav: 'ica', body: card({ tone: 'bad', title: t.disconnectTitle, body: `<p>${e(o.shared ? t.disconnectConfirmShared : t.disconnectConfirm)}</p>${form}` }) });
}

/**
 * The BankID QR page. `qr.js` polls `statusUrl` once per second and swaps in the server-rendered SVG. The live region
 * (#msg) carries only the functional status; the playful loading line sits outside it and qr.js hides it once a code shows.
 */
export function icaConnectPage(ctx: PageCtx, o: { statusUrl: string; flow?: 'web' | 'app' }): string {
  return shell(ctx, {
    title: o.flow === 'app' ? t.connectTitleApp : t.connectTitleWeb, nav: 'ica',
    body: `<section class="card connect"><div class="mascot-note">${mascot(ctx, 'sm')}${quip(s.brand.qrHint)}</div><p>${t.scanIntro}</p>
<div class="qr"><img id="qr" alt="${t.qrLoading}" width="256" height="256" data-status="${e(o.statusUrl)}" data-alt-ready="${t.qrReady}"></div>
<p id="msg" class="status-line" aria-live="polite" data-lost="${e(t.lost)}" data-done="${e(t.done)}" data-failed="${e(t.failed)}">${t.waiting}</p>
<p id="qr-loading" class="muted" lang="sv">${e(s.brand.loading)}</p>
<noscript><p><a class="tap-link" href="">${t.refresh}</a></p></noscript>
<div class="cluster"><a id="autostart" class="btn btn-secondary" hidden>${t.autostart}</a><a class="btn btn-link" href="/admin/ica">${t.cancel}</a></div></section>
<script type="module" src="${ctx.assets.url('qr.js')}" nonce="${ctx.nonce}"></script>`,
  });
}

export function icaErrorPage(ctx: PageCtx, message: string): string {
  return shell(ctx, {
    title: t.title, nav: 'ica',
    body: card({ tone: 'bad', body: `<p>${e(message)}</p>`, footer: `<a class="btn btn-secondary" href="/admin/ica">${s.common.back}</a>` }),
  });
}

/** Whether diagnostics used an app session for the mobile/* probes. */
export type DiagnosticsAppView = { state: 'none' } | { state: 'used' } | { state: 'error'; problem: string };
export type DiagnosticsView =
  | { kind: 'not-connected' }
  | { kind: 'unreadable' }
  | {
    kind: 'report'; live: boolean; error?: string; app?: DiagnosticsAppView;
    results: { name: string; host: string; auth: string; path: string; status: number | null; sample: string; note?: string }[];
    listIds: { probe: string; ids: string[] }[];
    elements?: { probe: string; label: string; shape: string }[];
  };

export function icaDiagnosticsPage(ctx: PageCtx, v: DiagnosticsView): string {
  const back = `<p><a class="tap-link" href="/admin/ica">${t.backToAccount}</a></p>`;
  const banner = (tone: 'warn' | 'bad', text: string) => `<div class="card card--${tone} callout">${icon(ctx, 'warn')}<p>${e(text)}</p></div>`;
  const page = (body: string, wide = false) => shell(ctx, { title: t.diagnosticsTitle, subtitle: s.brand.diagnosticsSubtitle, nav: 'ica', body: `<div class="stack">${body}</div>`, wide });
  if (v.kind === 'not-connected') return page(`<p>${t.connectFirst}</p><p><a class="btn btn-primary" href="/admin/ica">${t.backToAccount}</a></p>`);
  if (v.kind === 'unreadable') return page(`${banner('bad', t.diag.unreadable)}${back}`);
  const rows = v.results.map((r) => [
    e(r.name), r.status === null ? '—' : e(String(r.status)), e(r.auth),
    `<code>${e(`${r.host} ${r.path}`)}</code>${r.note ? `<br><span class="err">${e(r.note)}</span>` : ''}`, `<pre>${e(r.sample)}</pre>`,
  ]);
  const lists = v.listIds.map((l) => `<li>${e(l.probe)}: ${l.ids.length ? l.ids.map((id) => `<code>${e(id)}</code>`).join(', ') : `<span class="muted">${t.diag.none}</span>`}</li>`).join('');
  const elementRows = (v.elements ?? []).map((x) => [e(x.probe), `<code>${e(x.label)}</code>`, `<pre>${e(x.shape)}</pre>`]);
  const elements = elementRows.length
    ? `<h2>${t.diag.elements}</h2><p class="muted">${e(t.diag.elementsHint)}</p>${dataTable({ caption: t.diag.elements, head: [...t.diag.elementsHead], rows: elementRows, anywhere: [1, 2] })}`
    : '';
  const problem = v.live ? ''
    : v.error === 'logged-out' ? banner('bad', t.diag.loggedOut)
      : banner('warn', t.diag.checkFailed(v.error ?? s.common.unknown));
  const app = !v.app || v.app.state === 'none' ? `<p class="muted">${t.diag.appNone}</p>`
    : v.app.state === 'used' ? `<p>${t.diag.appUsed}</p>`
      : banner('warn', t.diag.appError(v.app.problem));
  return page(`${problem}
<p class="muted">${t.diag.intro}</p>
${app}
${dataTable({ caption: t.diag.caption, head: [...t.diag.head], rows, anywhere: [3, 4] })}
${v.live ? `<h2>${t.diag.listIds}</h2><p class="muted">${e(t.diag.listIdsHint)}</p><ul>${lists}</ul>` : ''}${elements}${back}`, true);
}
