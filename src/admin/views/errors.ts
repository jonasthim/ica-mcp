import { s, type Strings } from '../i18n.js';
import type { PageCtx } from '../page-ctx.js';
import { bare } from './layout.js';
import { mascot, quip } from './components.js';

export type ErrorStatus = 400 | 403 | 404 | 410 | 413 | 500;

/** The playful line above the plain explanation; only for the everyday failures. */
const QUIPS: Partial<Record<ErrorStatus, string>> = { 404: s.brand.notFound, 500: s.brand.internal };

/** A styled error page: a fixed sentence per code and a way home — never an error message or a stack. */
export function errorPage(ctx: PageCtx, o: { status: ErrorStatus; code: Exclude<keyof Strings['errors'], 'home'> }): string {
  return bare(ctx, {
    title: s.common.statusTitles[o.status],
    body: `<div class="error-art">${mascot(ctx, 'lg')}${QUIPS[o.status] ? quip(QUIPS[o.status]!) : ''}</div><p>${s.errors[o.code]}</p><p><a class="btn btn-primary" href="/admin">${s.errors.home}</a></p>`,
  });
}
