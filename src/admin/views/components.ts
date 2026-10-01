import { s } from '../i18n.js';
import type { PageCtx, Theme } from '../page-ctx.js';
import { escapeHtml as e } from './escape.js';

/** An icon from the `icon.svg` sprite; decorative, so hidden from assistive tech (the label next to it carries the meaning). */
export const icon = (ctx: PageCtx, id: string): string =>
  `<svg class="icon" aria-hidden="true" focusable="false"><use href="${ctx.assets.url('icon.svg')}#${id}"></use></svg>`;

export function button(o: { label: string; kind?: 'primary' | 'secondary' | 'danger' | 'link'; type?: 'submit' | 'button'; name?: string; value?: string; attrs?: string }): string {
  const name = o.name === undefined ? '' : ` name="${e(o.name)}"`;
  const value = o.value === undefined ? '' : ` value="${e(o.value)}"`;
  return `<button class="btn btn-${o.kind ?? 'primary'}" type="${o.type ?? 'submit'}"${name}${value}${o.attrs ? ` ${o.attrs}` : ''}>${e(o.label)}</button>`;
}

export const csrfField = (ctx: PageCtx): string => `<input type="hidden" name="_csrf" value="${e(ctx.csrf)}">`;

/**
 * A POST form that always carries the CSRF token. `confirm` asks first (a dialog via app.js; without JS it submits).
 * `confirmField` names a field app.js adds (value `yes`) once the dialog is accepted: for actions whose server answers
 * an unconfirmed POST with its own confirmation page, so the question is asked with and without JS.
 */
export function postForm(ctx: PageCtx, o: { action: string; body: string; confirm?: string; confirmField?: string; className?: string }): string {
  const confirm = (o.confirm ? ` data-confirm="${e(o.confirm)}"` : '') + (o.confirmField ? ` data-confirm-field="${e(o.confirmField)}"` : '');
  const cls = o.className ? ` class="${e(o.className)}"` : '';
  return `<form method="post" action="${e(o.action)}"${confirm}${cls}>${csrfField(ctx)}${o.body}</form>`;
}

/** A card; `aside` is trusted HTML next to the title (a status badge). */
export function card(o: { title?: string; aside?: string; body: string; footer?: string; tone?: 'default' | 'warn' | 'bad' }): string {
  const tone = o.tone && o.tone !== 'default' ? ` card--${o.tone}` : '';
  const header = o.title ? `<div class="card-header"><h2>${e(o.title)}</h2>${o.aside ?? ''}</div>` : '';
  const footer = o.footer ? `<div class="card-footer">${o.footer}</div>` : '';
  return `<section class="card${tone}">${header}<div class="stack">${o.body}</div>${footer}</section>`;
}

export const badge = (tone: 'ok' | 'warn' | 'bad' | 'neutral', label: string): string => `<span class="badge badge--${tone}">${e(label)}</span>`;

/** The ICA-MCP mascot as a hashed image (a self-contained SVG file, so CSP-safe); `size` picks the CSS size. */
export const mascot = (ctx: PageCtx, size: 'sm' | 'md' | 'lg' = 'md'): string =>
  `<img class="mascot mascot--${size}" src="${ctx.assets.url('mascot.svg')}" alt="${e(s.brand.mascotAlt)}" width="120" height="140">`;

/** A playful Swedish line (from `s.brand`), marked `lang="sv"` for screen readers. */
export const quip = (text: string, tag: 'p' | 'h2' = 'p'): string => `<${tag} class="quip" lang="sv">${e(text)}</${tag}>`;

export function emptyState(o: { title: string; body: string; action?: string; art?: string; titleLang?: 'sv' }): string {
  const lang = o.titleLang ? ` lang="${o.titleLang}"` : '';
  const text = `<h2${lang}>${e(o.title)}</h2><p>${e(o.body)}</p>${o.action ?? ''}`;
  return o.art
    ? `<div class="empty empty--art">${o.art}<div class="empty-text">${text}</div></div>`
    : `<div class="empty">${text}</div>`;
}

let fieldSeq = 0;
export function field(o: { label: string; name: string; type?: string; value?: string; autocomplete?: string; required?: boolean; hint?: string; attrs?: string }): string {
  const id = `f-${e(o.name)}-${++fieldSeq}`;
  const hint = o.hint ? `<p class="field-hint" id="${id}-hint">${e(o.hint)}</p>` : '';
  const attrs = [
    `id="${id}"`, `name="${e(o.name)}"`, `type="${e(o.type ?? 'text')}"`,
    o.value === undefined ? '' : `value="${e(o.value)}"`, o.autocomplete ? `autocomplete="${e(o.autocomplete)}"` : '',
    o.required ? 'required' : '', o.hint ? `aria-describedby="${id}-hint"` : '', o.attrs ?? '',
  ].filter(Boolean).join(' ');
  return `<div class="field"><label for="${id}">${e(o.label)}</label><input ${attrs}>${hint}</div>`;
}

/**
 * A table whose cells carry `data-label` from `head`, so below 640 px each row stacks into a labelled card. Cells are HTML.
 * Cells break between words only; `anywhere` lists the column indexes whose content may be one long token (a user
 * agent, a URL, details), which may also break inside a word so the table never grows wider than its column.
 */
export function dataTable(o: { caption: string; head: string[]; rows: string[][]; anywhere?: number[] }): string {
  const head = o.head.map((h) => `<th scope="col">${e(h)}</th>`).join('');
  const cls = (i: number) => (o.anywhere?.includes(i) ? ' class="wrap-anywhere"' : '');
  const rows = o.rows.map((r) => `<tr>${r.map((c, i) => `<td data-label="${e(o.head[i] ?? '')}"${cls(i)}>${c}</td>`).join('')}</tr>`).join('');
  return `<div class="table-wrap"><table class="table"><caption>${e(o.caption)}</caption><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

/** Copies `value`; hidden by CSS until app.js marks the page `.js`, so there is never a dead button. */
export const copyButton = (value: string, label: string): string =>
  `<button type="button" class="btn btn-secondary btn-copy" data-copy="${e(value)}"><span>${e(label)}</span></button>`;

const FLASH_KINDS = new Set(['success', 'error', 'info']);
/**
 * The flash message after a POST-redirect-GET. Only a known code renders (its fixed string, or the string built from
 * `params`); an unknown code or kind renders nothing, so a flash can never carry free text onto the page.
 */
export function flashRegion(ctx: PageCtx): string {
  const f = ctx.flash;
  if (!f || !FLASH_KINDS.has(f.kind) || !Object.hasOwn(s.flash, f.code)) return '';
  // Widened on purpose: later flash strings may be functions of `params`.
  const msg = s.flash[f.code] as string | ((p: Record<string, string>) => string);
  const text = typeof msg === 'function' ? msg(f.params ?? {}) : msg;
  return `<div class="toast toast--${f.kind}" role="status" aria-live="polite">${e(text)}</div>`;
}

/** Light / Dark / Match device, posting to /admin/theme. app.js applies the choice at once and submits on change. */
export function themeForm(ctx: PageCtx, next: string): string {
  const opt = (value: Theme, label: string, ic: string) =>
    `<label class="segment"><input type="radio" name="theme" value="${value}"${ctx.theme === value ? ' checked' : ''}>${icon(ctx, ic)}<span>${e(label)}</span></label>`;
  return postForm(ctx, {
    action: '/admin/theme', className: 'theme-form',
    body: `<input type="hidden" name="next" value="${e(next)}"><fieldset class="segmented"><legend>${s.app.theme}</legend>`
      + `${opt('light', s.app.themeLight, 'sun')}${opt('dark', s.app.themeDark, 'moon')}${opt('system', s.app.themeSystem, 'apps')}</fieldset>`
      + button({ label: s.app.themeSave, kind: 'secondary', attrs: 'data-nojs' }),
  });
}
