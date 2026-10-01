import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { PAGE_FIXTURES, testPageCtx } from './fixtures.js';

/**
 * A link that stands alone (the only content of its parent, or a pagination step) is a tap target, so it needs the
 * 44 px height of `.btn` or `.tap-link`. Links inside a sentence are exempt (WCAG 2.5.8 inline exception).
 */
function standaloneLinksWithoutTapHeight(html: string): string[] {
  const doc = new JSDOM(html).window.document;
  return [...doc.querySelectorAll('a[href]')].filter((a) => {
    if (a.classList.contains('btn') || a.classList.contains('tap-link') || a.closest('.skip, .nav, .topbar')) return false;
    const parent = a.parentElement!;
    return parent.classList.contains('pagination') || parent.textContent!.trim() === a.textContent!.trim();
  }).map((a) => a.outerHTML);
}

describe.each(Object.entries(PAGE_FIXTURES))('%s', (_name, render) => {
  it('gives every standalone link a 44 px tap height', () => {
    expect(standaloneLinksWithoutTapHeight(render(testPageCtx({ nonce: 'N' })))).toEqual([]);
  });
});
