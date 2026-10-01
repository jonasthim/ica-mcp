import { s } from '../i18n.js';
import type { PageCtx } from '../page-ctx.js';
import { shell } from './layout.js';
import { button, card, copyButton, emptyState, icon, mascot, postForm } from './components.js';
import { escapeHtml as e } from './escape.js';
import { statusBadge, timeTag, type IcaStatus } from './status.js';
import type { SettingsProblem } from '../../settings/effective.js';

const t = s.home;
const linked = (st: IcaStatus): boolean => st.tone === 'ok' || st.tone === 'warn';

/** One step of the next-steps list: ticked from the same data the cards show. */
const step = (ctx: PageCtx, done: boolean, text: string, href: string): string => done
  ? `<li data-done>${icon(ctx, 'check')}<span><span class="visually-hidden">${t.stepDone}: </span>${e(text)}</span></li>`
  : `<li>${icon(ctx, 'circle')}<span><span class="visually-hidden">${t.stepTodo}: </span><a href="${href}">${e(text)}</a></span></li>`;

/**
 * The dashboard: ICA web and app status, the Claude connection (how many OAuth apps the user has allowed) with the MCP
 * URL to paste, and the next steps. The empty-shelves state shows only while nothing at all is connected.
 */
export function homePage(ctx: PageCtx, o: {
  ica: { web: IcaStatus; app: IcaStatus }; claude: { connected: number; lastUsedAt: string | null }; mcpUrl: string;
  /** Admins only: sign-in settings problems (AuthHolder), one warning card each with a link to Settings. */
  settingsProblems?: readonly SettingsProblem[];
}): string {
  const problems = (o.settingsProblems ?? []).map((code) => card({
    tone: 'warn', title: s.settings.problemTitle, body: `<p>${e(s.settings.problems[code])}</p>`,
    footer: `<a class="tap-link" href="/admin/settings">${s.settings.openSettings}</a>`,
  })).join('\n');
  const { web, app } = o.ica;
  const claudeOn = o.claude.connected > 0;
  const nothing = web.tone === 'none' && app.tone === 'none' && !claudeOn;
  const empty = nothing ? emptyState({
    art: mascot(ctx, 'md'), title: s.brand.emptyShelves, titleLang: 'sv', body: t.emptyBody,
    action: `<a class="btn btn-primary" href="/admin/ica">${t.emptyAction}</a>`,
  }) : '';
  const icaLink = (st: IcaStatus) => st.tone === 'none'
    ? `<a class="btn btn-secondary" href="/admin/ica">${s.ica.connect}</a>`
    : `<a class="tap-link" href="/admin/ica">${t.manageIca}</a>`;
  const cards = `<div class="grid-cards">
${card({ title: t.webTitle, aside: statusBadge(web), body: `<p class="muted">${e(t.webBody)}</p>`, footer: icaLink(web) })}
${card({ title: t.appTitle, aside: statusBadge(app), body: `<p class="muted">${e(t.appBody)}</p>`, footer: web.tone === 'none' ? `<a class="tap-link" href="/admin/ica">${t.manageIca}</a>` : icaLink(app) })}
</div>
${card({
    title: t.claudeTitle, aside: statusBadge(claudeOn ? { tone: 'ok', label: t.claudeApps(o.claude.connected) } : { tone: 'none', label: t.claudeNone }),
    body: `${o.claude.lastUsedAt ? `<p class="muted">${t.claudeLastUsed} ${timeTag(o.claude.lastUsedAt)}</p>` : ''}<p>${e(t.claudeHow)}</p>`
      + `<div class="copy-row"><code class="wrap-anywhere" id="mcp-url">${e(o.mcpUrl)}</code>${copyButton(o.mcpUrl, t.copyUrl)}</div>`,
  })}`;
  const allSet = linked(web) && claudeOn;
  const steps = card({
    title: t.stepsTitle,
    body: `<ol class="checklist">${step(ctx, linked(web), web.tone === 'bad' ? t.steps.webFix : t.steps.web, '/admin/ica')}`
      + `${step(ctx, linked(app), t.steps.app, '/admin/ica')}${step(ctx, claudeOn, t.steps.claude, '#mcp-url')}</ol>`
      + (allSet ? `<p class="muted">${e(t.steps.done)}</p>` : ''),
  });
  const device = `<section class="stack device" aria-labelledby="device-title"><h2 id="device-title">${t.device}</h2>`
    + `<p class="wrap-anywhere muted">${t.signedInAs} <strong>${e(ctx.user?.email ?? '')}</strong></p>`
    + `<p><a class="tap-link" href="/admin/profile">${t.profileLink}</a></p>`
    + `${postForm(ctx, { action: '/admin/logout', body: button({ label: s.app.signOut, kind: 'secondary' }) })}</section>`;
  return shell(ctx, { title: t.title, nav: 'home', body: `${problems}${empty}${cards}${steps}${device}` });
}
