import { JSDOM } from 'jsdom';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { PAGE_FIXTURES, testPageCtx } from './fixtures.js';
import * as views from './index.js';

const NONCE = 'TESTNONCE0123456789abc==';
const pages = Object.entries(PAGE_FIXTURES);

describe('page fixtures', () => {
  it('cover every exported *Page view', () => {
    const exported = Object.keys(views).filter((k) => k.endsWith('Page'));
    const covered = new Set(pages.map(([name]) => name.split(':')[0]));
    expect(exported.filter((k) => !covered.has(k))).toEqual([]);
  });
});

const MASCOT_PAGES = ['loginPage:local', 'loginPage:oidc-only', 'homePage:new-user', 'errorPage:404', 'errorPage:500', 'icaConnectPage:web', 'icaConnectPage:app', 'setupPage:code'];
describe.each(MASCOT_PAGES)('%s mascot', (name) => {
  it('shows the mascot as a hashed image with meaningful alt text', () => {
    const html = PAGE_FIXTURES[name]!(testPageCtx({ nonce: NONCE }));
    expect(html).toMatch(/<img [^>]*src="\/admin\/assets\/mascot\.[0-9a-f]{10}\.svg"[^>]*alt="[^"]{12,}"/);
  });
});

describe('setupPage choose step', () => {
  it('offers the password path when password sign-in is on', () => {
    const html = PAGE_FIXTURES['setupPage:choose']!(testPageCtx({ nonce: NONCE }));
    expect(html).toContain('Create admin with password');
    expect(html).toContain('Set up single sign-on first');
  });
  it('hides the password path when password sign-in is off, leaving only single sign-on', () => {
    const html = PAGE_FIXTURES['setupPage:choose-sso-only']!(testPageCtx({ nonce: NONCE }));
    expect(html).not.toContain('Create admin with password');
    expect(html).not.toContain('type="password"');
    expect(html).toContain('Set up single sign-on first');
  });
});

/** Every element, including those inside `<template>` content (a separate fragment querySelectorAll does not enter). */
const elements = (root: ParentNode): Element[] => [...root.querySelectorAll('*')].flatMap((el) =>
  [el, ...(el.tagName === 'TEMPLATE' ? elements((el as HTMLTemplateElement).content) : [])]);

const FOOTER = /<footer class="site-footer"[^>]*>[\s\S]*?<\/footer>/g;

describe.each(pages)('%s', (_name, render) => {
  const html = render(testPageCtx({ nonce: NONCE }));
  it('is branded ICA-MCP in the <title> and carries the disclaimer footer', () => {
    expect(html).toMatch(/<title>[^<]+ · ICA-MCP<\/title>/);
    const footers = html.match(FOOTER) ?? [];
    expect(footers).toHaveLength(1);
    expect(footers[0]).toContain('ICA-MCP är ett inofficiellt hobbyprojekt – inte ICA, inte Stig.');
  });
  it('names "Stig" nowhere outside the footer disclaimer', () => {
    expect(html.replace(FOOTER, '')).not.toMatch(/stig/i);
  });
  it('has no inline style attribute, no <style>, no inline handlers', () => {
    // Checked on the parsed DOM: escaped text or attribute values such as a hostile app name "&lt;img onerror=…&gt;"
    // are harmless and must not count, while any real style or on* attribute must.
    const all = elements(new JSDOM(html).window.document);
    expect(all.flatMap((el) => el.getAttributeNames()).filter((a) => a === 'style' || /^on/i.test(a))).toEqual([]);
    expect(all.filter((el) => el.tagName === 'STYLE')).toEqual([]);
    expect(html).not.toMatch(/<style[\s>]/i);
  });
  it('every <script> is external and carries the nonce', () => {
    const scripts = html.match(/<script\b[^>]*>/gi) ?? [];
    for (const tag of scripts) {
      expect(tag).toMatch(/\ssrc="\/admin\/assets\/[a-z]+\.[0-9a-f]{10}\.js"/);
      expect(tag).toContain(`nonce="${NONCE}"`);
    }
    expect(html).not.toMatch(/<script\b[^>]*>[^<]+<\/script>/i);
  });
  it('every POST form carries the CSRF token', () => {
    const forms = html.match(/<form\b[^>]*method="post"[^>]*>[\s\S]*?<\/form>/gi) ?? [];
    for (const f of forms) expect(f).toContain('name="_csrf" value="test-csrf"');
  });
  it('passes axe (color-contrast excluded: jsdom has no layout)', async () => {
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    dom.window.eval(axe.source);
    const w = dom.window as unknown as { axe: typeof axe };
    const r = await w.axe.run(dom.window.document, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  });
});

describe('Connected apps', () => {
  it('shows a hostile app name as text only, and one Revoke per app with the no-JS confirm field', () => {
    const html = PAGE_FIXTURES['appsPage:hostile-name']!(testPageCtx({ nonce: NONCE }));
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html.match(/data-confirm-field="confirm"/g)).toHaveLength(2);
    expect(PAGE_FIXTURES['appConfirmPage:revoke']!(testPageCtx({ nonce: NONCE }))).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('sign-in OIDC errors', () => {
  const render = (name: string) => PAGE_FIXTURES[name]!(testPageCtx({ nonce: NONCE }));
  it('names the refused email escaped, in an alert, with no password form when local login is off', () => {
    const html = render('loginPage:oidc-error-not-invited');
    expect(html).toMatch(/<div class="toast toast--error" role="alert">No ICA-MCP account for &lt;script&gt;alert\(1\)&lt;\/script&gt;annakarin[^<]* — ask an admin for an invite\.<\/div>/);
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('type="password"');
    expect(html).toContain('Continue with Authentik');
  });
  it('falls back to fixed messages: no email kept, or an unknown code', () => {
    expect(render('loginPage:oidc-error-no-email')).toContain('No ICA-MCP account for this sign-in — ask an admin for an invite.');
    const odd = render('loginPage:oidc-error-unknown');
    expect(odd).toContain('Sign-in with &lt;script&gt;alert(1)&lt;/script&gt; failed. Please try again.');
    expect(odd).not.toContain('<script>alert');
  });
});

describe('the inline-handler check', () => {
  it('also looks inside <template> content', () => {
    const doc = new JSDOM('<template><div><img src=x onerror="x()"></div></template>').window.document;
    expect(doc.querySelectorAll('img')).toHaveLength(0); // what a plain querySelectorAll would miss
    expect(elements(doc).flatMap((el) => el.getAttributeNames())).toContain('onerror');
  });
});

describe('Settings', () => {
  const render = (name: string) => PAGE_FIXTURES[name]!(testPageCtx({ nonce: NONCE }));
  it('the secret input never carries a value; its hint says whether one is stored', () => {
    const ui = render('settingsPage:ui');
    const secret = /<input [^>]*name="client_secret"[^>]*>/.exec(ui)![0];
    expect(secret).not.toMatch(/\svalue=/); expect(secret).toContain('type="password"'); expect(secret).toContain('autocomplete="new-password"');
    expect(ui).toContain('Stored. Leave blank to keep it.');
    expect(render('settingsPage:ui-empty')).toContain('Required.');
  });
  it('asks for the secret again after a test with a typed one, and marks an unreadable stored secret; both required', () => {
    const retype = render('settingsPage:retype-secret');
    expect(retype).toContain('Type the secret again before saving (it is never kept).');
    expect(retype).not.toContain('Stored. Leave blank to keep it.');
    const unreadable = render('settingsPage:unreadable-secret');
    expect(unreadable).toContain('The stored secret cannot be decrypted');
    expect(/<input [^>]*name="client_secret"[^>]*>/.exec(unreadable)![0]).toContain(' required');
  });
  it('Test connection posts the same form to its own action, without validation', () => {
    expect(render('settingsPage:ui')).toMatch(/<button class="btn btn-secondary" type="submit" formaction="\/admin\/settings\/oidc\/test" formnovalidate>Test connection<\/button>/);
  });
  it('lists every check with its badge and fixed sentence; an unknown detail code shows nothing', () => {
    const ui = render('settingsPage:ui');
    expect(ui.match(/<li><span class="badge/g)).toHaveLength(9);
    expect(ui).toContain('Sign-in page on the issuer’s host');
    expect(ui).toContain('The keys are on another host and were not fetched.');
    expect(ui).not.toContain('<script>alert');
  });
  it('shows the check only for the issuer it tested, and the unlink acknowledgement only with links', () => {
    expect(render('settingsPage:problems')).not.toContain('Connection test');
    expect(render('settingsPage:ui')).toContain('name="unlink_ack"');
    expect(render('settingsPage:problems')).not.toContain('name="unlink_ack"');
  });
  it('env-managed: read-only values, a fixed mask for the secret, no inputs', () => {
    const env = render('settingsPage:env');
    expect(env).toContain('Managed by the environment.');
    expect(env).toContain('••••••••');
    expect(env).not.toContain('name="client_secret"');
    expect(env).not.toContain('name="issuer_url"');
    expect(env).not.toContain('name="local_login"');
    expect(env).not.toContain('/admin/settings/oidc/remove');
  });
  it('an env-managed switch is shown read-only instead of as an input', () => {
    const p = render('settingsPage:problems');
    expect(p).not.toContain('name="link_by_email"');
    expect(p).toContain('name="admin_group"');
  });
  it('the unreachable problem offers Try again; every problem has its card', () => {
    const p = render('settingsPage:problems');
    expect(p.match(/card--warn/g)).toHaveLength(4);
    expect(p).toContain('action="/admin/settings/reload"');
    expect(p).toContain('It is retried when the sign-in page is next opened.');
  });
});
