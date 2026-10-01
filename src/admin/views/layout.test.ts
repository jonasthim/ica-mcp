import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { escapeHtml } from './escape.js';
import { bare, shell } from './layout.js';
import { loginPage, consentPage, homePage, icaConnectPage } from './index.js';
import { testPageCtx } from './fixtures.js';

describe('layout', () => {
  it('escapes html', () => expect(escapeHtml('<b>&"\'')).toBe('&lt;b&gt;&amp;&quot;&#39;'));

  it('links the hashed stylesheet and module scripts with the nonce', () => {
    const ctx = testPageCtx();
    const html = shell(ctx, { title: 'Home', nav: 'home', body: '<p>x</p>' });
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain(`<link rel="stylesheet" href="${ctx.assets.url('app.css')}">`);
    expect(html).toContain(`<script type="module" src="${ctx.assets.url('app.js')}" nonce="${ctx.nonce}"></script>`);
    expect(html).toContain('aria-current="page"');
  });

  it('shows Users and Activity in the nav only for admins', () => {
    const member = shell(testPageCtx({ role: 'member' }), { title: 'Home', nav: 'home', body: '' });
    const admin = shell(testPageCtx({ role: 'admin' }), { title: 'Home', nav: 'home', body: '' });
    expect(member).not.toContain('href="/admin/users"');
    expect(member).not.toContain('href="/admin/activity"');
    expect(admin).toContain('href="/admin/users"');
    expect(admin).toContain('href="/admin/activity"');
  });

  it('shows Settings to admins only: a nav item (wider screens) and the same link in the top bar (phones), chosen by CSS', () => {
    const member = shell(testPageCtx({ role: 'member' }), { title: 'Home', nav: 'home', body: '' });
    const admin = shell(testPageCtx({ role: 'admin' }), { title: 'Settings', nav: 'settings', body: '' });
    expect(member).not.toContain('href="/admin/settings"');
    expect(admin).toMatch(/<a class="nav-item nav-item--settings" href="\/admin\/settings" aria-current="page">/);
    expect(admin).toMatch(/<header class="topbar">[\s\S]*<a class="topbar-settings" href="\/admin\/settings" aria-current="page">[\s\S]*<span class="visually-hidden">Settings<\/span>[\s\S]*<\/header>/);
    const css = readFileSync(new URL('../assets/app.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.nav-item--settings \{ display: none; \}/);
    expect(css).toMatch(/@media \(min-width: 768px\) \{[^}]*\}[\s\S]*\.nav-item--settings \{ display: flex; \}[\s\S]*\.topbar-settings \{ display: none; \}/);
  });

  it('puts the theme on <html> only when not following the system', () => {
    expect(bare(testPageCtx({ theme: 'dark' }), { title: 'x', body: '' })).toContain('<html lang="en" data-theme="dark">');
    expect(bare(testPageCtx({ theme: 'system' }), { title: 'x', body: '' })).toContain('<html lang="en">');
  });

  it('home shows the empty-shelves state only while nothing is connected', () => {
    const ctx = testPageCtx();
    const none = { tone: 'none', label: 'Not connected' } as const;
    const ok = { tone: 'ok', label: 'Connected' } as const;
    const page = (web: typeof none | typeof ok, connected: number) => homePage(ctx, { ica: { web, app: none }, claude: { connected, lastUsedAt: null }, mcpUrl: 'https://x/mcp' });
    expect(page(none, 0)).toContain('<h2 lang="sv">Tomt i hyllorna! Ska vi fylla på?</h2>');
    expect(page(ok, 0)).not.toContain('Tomt i hyllorna');
    expect(page(none, 1)).not.toContain('Tomt i hyllorna');
  });

  it('home shows ICA and Claude status and ticks the next steps from the same data', () => {
    const html = homePage(testPageCtx(), {
      ica: { web: { tone: 'warn', label: 'Connected · expires in 3 days', title: 'Expires 4 Oct' }, app: { tone: 'bad', label: 'Needs reconnect' } },
      claude: { connected: 2, lastUsedAt: null }, mcpUrl: 'https://ica.example/mcp',
    });
    expect(html).toContain('<span class="badge badge--warn" title="Expires 4 Oct">Connected · expires in 3 days</span>');
    expect(html).toContain('<span class="badge badge--bad">Needs reconnect</span>');
    expect(html).toContain('<span class="badge badge--ok">Connected · 2 apps</span>');
    expect(html).toContain('id="mcp-url">https://ica.example/mcp</code>');
    expect(html).toContain('data-copy="https://ica.example/mcp"');
    expect(html.match(/<li data-done>/g)).toHaveLength(2); // ICA connected, Claude added; app access needs reconnect
  });

  it('login page carries oauth_query and the OIDC button only when configured', () => {
    const ctx = testPageCtx({ user: null });
    const html = loginPage(ctx, { oauthQuery: 'a=1&sig=<x>', oidcLabel: undefined, localLogin: true, error: undefined });
    expect(html).not.toContain('finish connecting');
    expect(loginPage(ctx, { oauthQuery: 'a=1', oidcLabel: undefined, localLogin: true, error: undefined, continuingApp: true })).toContain('finish connecting');
    expect(html).toContain('name="oauth_query" value="a=1&amp;sig=&lt;x&gt;"');
    expect(html).not.toContain('/admin/login/oidc');
    expect(loginPage(ctx, { oauthQuery: '', oidcLabel: 'Authentik', localLogin: true, error: undefined })).toContain('Authentik');
  });

  it('login page puts the OIDC button first and drops the local form and divider when local login is off', () => {
    const ctx = testPageCtx({ user: null });
    const both = loginPage(ctx, { oauthQuery: '', oidcLabel: 'Authentik', localLogin: true, error: undefined });
    expect(both.indexOf('Continue with Authentik')).toBeLessThan(both.indexOf('or sign in with a local account'));
    expect(both.indexOf('or sign in with a local account')).toBeLessThan(both.indexOf('name="password"'));
    expect(both).toMatch(/<input [^>]*name="email"[^>]*autocomplete="username"[^>]*inputmode="email"/);
    expect(both).toMatch(/<input [^>]*name="password"[^>]*autocomplete="current-password"/);
    const oidcOnly = loginPage(ctx, { oauthQuery: '', oidcLabel: 'Authentik', localLogin: false, error: undefined });
    expect(oidcOnly).toContain('Continue with Authentik');
    expect(oidcOnly).not.toContain('name="password"');
    expect(oidcOnly).not.toContain('or sign in with a local account');
  });

  it('login page maps error codes to fixed messages and ignores anything else', () => {
    const ctx = testPageCtx({ user: null });
    const page = (error: string) => loginPage(ctx, { oauthQuery: '', oidcLabel: undefined, localLogin: true, error });
    const toast = (m: string) => `<div class="toast toast--error" role="alert">${m}</div>`;
    expect(page('credentials')).toContain(toast('Wrong email or password'));
    expect(page('failed')).toContain(toast('Sign-in failed'));
    expect(page('rate')).toContain(toast('Too many sign-in attempts. Try again later.'));
    const forged = page('Your account is locked, call 0701234567');
    expect(forged).not.toContain('toast--error');
    expect(forged).not.toContain('0701234567');
    expect(page('__proto__')).not.toContain('toast--error');
  });

  it('consent page lists client and scopes', () => {
    const html = consentPage(testPageCtx(), { clientName: 'Claude', scopes: ['mcp', 'offline_access'], oauthQuery: 'x=1', redirectHost: 'claude.ai', verified: false });
    expect(html).toContain('Claude'); expect(html).toContain('name="oauth_query" value="x=1"');
  });

  it('consent page describes scopes in plain language and lists unknown ones verbatim', () => {
    const html = consentPage(testPageCtx(), { clientName: 'Claude', scopes: ['openid', 'profile', 'email', 'mcp', 'offline_access', 'x<y'], oauthQuery: '', redirectHost: 'claude.ai', verified: true });
    expect(html).toContain('Use your ICA data through ICA-MCP&#39;s tools');
    expect(html).toContain('Stay connected without asking again');
    expect(html.match(/Know who you are/g)).toHaveLength(1); // openid, profile and email are one line
    expect(html).toContain('<code>x&lt;y</code>');
    expect(html).not.toContain('card--warn');
  });

  it('consent page shows the destination and warns only about unverified clients, escaping the host', () => {
    const ok = consentPage(testPageCtx(), { clientName: 'Claude', scopes: ['mcp'], oauthQuery: '', redirectHost: 'claude.ai', verified: true });
    expect(ok).toContain('The access code will be sent to: <strong>claude.ai</strong>');
    expect(ok).not.toContain('has not been verified');
    const bad = consentPage(testPageCtx(), { clientName: 'Claude', scopes: ['mcp'], oauthQuery: '', redirectHost: 'evil.example<b>', verified: false });
    expect(bad).toContain('This app registered itself and has not been verified — only allow it if you started this from that site.');
    expect(bad).toContain('card--warn');
    expect(bad).toContain('evil.example&lt;b&gt;');
  });

  it('the QR page announces only the functional status in its live region', () => {
    const html = icaConnectPage(testPageCtx(), { statusUrl: '/s', flow: 'web' });
    const live = /<p id="msg"[^>]*aria-live="polite"[^>]*>([\s\S]*?)<\/p>/.exec(html)![1];
    expect(live).toBe('Waiting for BankID…');
    expect(html).toContain('Hämtar veckans fynd från lagret…'); // still on the page, outside the live region
  });
});
