import { s } from '../i18n.js';
import type { NavKey, PageCtx } from '../page-ctx.js';
import { escapeHtml as e } from './escape.js';
import { flashRegion, icon, mascot } from './components.js';

function head(ctx: PageCtx, title: string): string {
  const theme = ctx.theme === 'system' ? '' : ` data-theme="${ctx.theme}"`;
  return `<!doctype html><html lang="en"${theme}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">`
    + `<meta name="color-scheme" content="light dark"><title>${e(title)} · ${s.app.name}</title>`
    + `<link rel="icon" href="${ctx.assets.url('icon.svg')}#brand" type="image/svg+xml">`
    + `<link rel="stylesheet" href="${ctx.assets.url('app.css')}">`
    + `<script type="module" src="${ctx.assets.url('app.js')}" nonce="${ctx.nonce}"></script></head>`;
}

const brandMark = (ctx: PageCtx): string =>
  `<svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><use href="${ctx.assets.url('icon.svg')}#brand"></use></svg>`;

/** The disclaimer on every page (shell and bare). The only place the UI names the ad character. */
const footer = (): string =>
  `<footer class="site-footer"><p><span lang="sv">${e(s.brand.disclaimer)}</span> <a href="${s.brand.projectHref}">${s.brand.projectLink}</a></p></footer>`;

const NAV: { key: NavKey; href: string; admin?: true }[] = [
  { key: 'home', href: '/admin' }, { key: 'ica', href: '/admin/ica' }, { key: 'apps', href: '/admin/apps' },
  { key: 'users', href: '/admin/users', admin: true }, { key: 'activity', href: '/admin/activity', admin: true },
  { key: 'settings', href: '/admin/settings', admin: true },
];

/**
 * The signed-in app shell: top bar, bottom tab bar on phones / sidebar on wider screens, and the page's main column.
 * Admins' Settings sits in the top bar on phones and in the nav from 768 px.
 */
export function shell(ctx: PageCtx, o: { title: string; nav: NavKey; body: string; wide?: boolean; subtitle?: string }): string {
  const u = ctx.user;
  const items = NAV.filter((n) => !n.admin || u?.role === 'admin').map((n) =>
    `<a class="nav-item${n.key === 'settings' ? ' nav-item--settings' : ''}" href="${n.href}"${n.key === o.nav ? ' aria-current="page"' : ''}>${icon(ctx, n.key)}<span>${s.nav[n.key]}</span></a>`).join('');
  const user = u
    ? `<a class="usermenu" href="/admin/profile"${o.nav === 'profile' ? ' aria-current="page"' : ''} aria-label="${s.app.menu}: ${e(u.name || u.email)}">${icon(ctx, 'profile')}<span class="truncate wrap-anywhere">${e(u.name || u.email)}</span></a>`
    : '';
  // Settings: a nav item from 768 px; on phones the six bottom tabs would be too tight, so CSS shows this top-bar link
  // instead (same markup at every width, one of the two is display:none).
  const settings = u?.role === 'admin'
    ? `<a class="topbar-settings" href="/admin/settings"${o.nav === 'settings' ? ' aria-current="page"' : ''}>${icon(ctx, 'settings')}<span class="visually-hidden">${s.nav.settings}</span></a>`
    : '';
  return `${head(ctx, o.title)}<body><a class="visually-hidden skip" href="#main">${s.app.skip}</a><div class="shell">`
    + `<header class="topbar"><a class="brand" href="/admin">${brandMark(ctx)}<span>${s.app.name}</span></a><div class="topbar-end">${settings}${user}</div></header>`
    + `<nav class="nav" aria-label="${s.app.navLabel}">${items}</nav>`
    + `<main id="main" class="main${o.wide ? ' main--wide' : ''}">${pageHead(o.title, o.subtitle)}${flashRegion(ctx)}${o.body}${footer()}</main></div>`
    + `<dialog id="confirm" class="card" aria-labelledby="confirm-text"><form method="dialog" class="stack"><p id="confirm-text" data-confirm-text></p>`
    + `<div class="cluster"><button class="btn btn-secondary" value="cancel">${s.common.cancel}</button><button class="btn btn-danger" value="ok">${s.common.confirm}</button></div></form></dialog>`
    + '</body></html>';
}

/** The page title, with an optional playful Swedish subtitle (e.g. diagnostics: "Lagret"). */
const pageHead = (title: string, subtitle?: string): string => subtitle
  ? `<div class="page-head"><h1 class="page-title">${e(title)}</h1><p class="page-subtitle" lang="sv">${e(subtitle)}</p></div>`
  : `<h1 class="page-title">${e(title)}</h1>`;

/**
 * A centred single card for pages outside the shell: sign-in, consent, invite, errors. `hero` puts the mascot and the
 * tagline next to the wordmark (the sign-in page).
 */
export function bare(ctx: PageCtx, o: { title: string; body: string; hero?: boolean }): string {
  const brand = `<p class="brand">${brandMark(ctx)}<span>${s.app.name}</span></p>`;
  const top = o.hero
    ? `<div class="hero">${mascot(ctx, 'md')}<div class="hero-text">${brand}<p class="tagline" lang="sv">${e(s.brand.tagline)}</p></div></div>`
    : brand;
  return `${head(ctx, o.title)}<body class="bare"><main id="main" class="bare-card card">${top}`
    + `<h1 class="page-title">${e(o.title)}</h1>${flashRegion(ctx)}<div class="stack">${o.body}</div></main>${footer()}</body></html>`;
}
