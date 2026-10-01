import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** The stylesheet with comments removed. */
const CSS = readFileSync(new URL('assets/app.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Every declaration block (at any nesting depth) whose selector list contains exactly `selector`, joined. */
function decls(selector: string): string {
  const out: string[] = [];
  for (const m of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1]!.split(',').map((x) => x.trim()).includes(selector)) out.push(m[2]!.replace(/\s+/g, ' ').trim());
  }
  return out.join(' ');
}

describe('app.css layout contract (visual pass at 390 and 1280 px)', () => {
  it('keeps the brand on one line beside a long user name; the user menu truncates instead', () => {
    expect(decls('.brand')).toContain('white-space: nowrap');
    expect(decls('.brand')).toContain('flex: none');
  });

  it('breaks table cells between words (long-token columns opt in to anywhere) and keeps a time on one line', () => {
    expect(decls('.table td')).toContain('overflow-wrap: break-word');
    expect(decls('.table td')).not.toContain('overflow-wrap: anywhere');
    expect(decls('.table td.wrap-anywhere')).toContain('overflow-wrap: anywhere');
    expect(decls('.table time')).toContain('white-space: nowrap');
    expect(decls('.table-wrap')).toContain('overflow-x: auto');
  });

  it('gives a standalone text link the 44 px tap height', () => {
    expect(decls('.tap-link')).toContain('min-height: var(--tap)');
    expect(decls('.tap-link')).toContain('display: inline-flex');
  });

  it('pads a wrapped button label, keeps the footer link whole and lets an empty strength line take no gap', () => {
    expect(decls('.btn')).toMatch(/padding: var\(--space-2\) var\(--space-5\)/);
    expect(decls('.site-footer a')).toContain('white-space: nowrap');
    expect(decls('.stack > .field-hint:empty')).toContain('margin-top: calc(-1 * var(--space-4))');
    expect(decls('.stack')).toContain('gap: var(--space-4)');
    expect(decls('.stack > .field-hint:empty')).not.toContain('display: none');
  });
});
