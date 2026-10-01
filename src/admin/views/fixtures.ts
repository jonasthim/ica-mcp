import { loadAssets } from '../assets.js';
import { s } from '../i18n.js';
import type { PageCtx, PageUser, Theme } from '../page-ctx.js';
import { appStatus, icaStatus } from './status.js';
import {
  activityPage, appConfirmPage, appsPage, consentPage, errorPage, homePage, icaConnectPage, icaDiagnosticsPage, icaDisconnectConfirmPage, icaErrorPage, icaPage, invitePage, inviteSharePage, loginPage,
  profilePage, settingsConfirmPage, settingsPage, setupPage, userConfirmPage, userEmailPage, usersPage,
  type AppView, type EventRow, type ProfileView, type SettingsView, type SetupSsoView, type UserRowView,
} from './index.js';

const assets = loadAssets();

/** A page context for view tests: fixed CSRF token, real hashed assets, and a signed-in user unless `user: null`. */
export function testPageCtx(o: { nonce?: string; role?: 'admin' | 'member'; theme?: Theme; user?: null } = {}): PageCtx {
  const user: PageUser = { id: 'u1', name: 'Åsa Öberg-Ängström', email: 'asa.oberg-angstrom@example.com', role: o.role ?? 'admin' };
  return { nonce: o.nonce ?? 'test-nonce', assets, csrf: 'test-csrf', theme: o.theme ?? 'system', ...(o.user === null ? {} : { user }) };
}

/** Hostile and oversized values every page must survive: markup, a 120-character name, an email with no break points. */
export const HOSTILE = {
  script: '<script>alert(1)</script>',
  longName: 'Anna-Karin Margareta Elisabet Östergren-Åkerlund af Söderhjelm, Hushållet på Storgatan 4 i Skellefteå, Västerbottens län',
  longEmail: 'annakarinmargaretaelisabetostergrenakerlundafsoderhjelm@hushallet-pa-storgatan-fjorton.example',
} as const;

const inDays = (d: number): string => new Date(Date.now() + d * 86_400_000).toISOString();
const withUser = (ctx: PageCtx, u: Partial<PageUser>): PageCtx => (ctx.user ? { ...ctx, user: { ...ctx.user, ...u } } : ctx);
const hostileCtx = (ctx: PageCtx) => withUser(ctx, { name: HOSTILE.longName, email: HOSTILE.longEmail });

/** A household for the Users page: the signed-in admin, a second admin, a disabled member with a 120-character name. */
const HOUSEHOLD: UserRowView[] = [
  {
    id: 'u1', name: 'Åsa Öberg-Ängström', email: 'asa.oberg-angstrom@example.com', role: 'admin', disabled: false, isSelf: true,
    lastSignInAt: inDays(-0.1), ica: icaStatus({ expiresAt: inDays(80), lastOkAt: inDays(-1), lastError: null }), signInMethods: ['Password', 'Authentik'], emailUnconfirmed: false,
  },
  {
    id: 'u2', name: 'Erik', email: 'erik@example.com', role: 'admin', disabled: false, isSelf: false,
    lastSignInAt: null, ica: icaStatus({ expiresAt: inDays(5), lastOkAt: null, lastError: null }), signInMethods: ['Authentik'], emailUnconfirmed: false,
  },
  {
    id: 'u"3<x>', name: HOSTILE.longName, email: HOSTILE.longEmail, role: 'member', disabled: true, isSelf: false,
    lastSignInAt: inDays(-40), ica: icaStatus(undefined), signInMethods: [HOSTILE.script], emailUnconfirmed: true,
  },
];

const TOKEN = 'Q2hvb3NlIGEgbG9uZyByYW5kb20gdG9rZW4gaGVyZQx';
/** A tiny stand-in for `qrcode`'s SVG output (same shape: one svg, two paths, no style or script). */
const QR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5 5" shape-rendering="crispEdges"><path fill="#ffffff" d="M0 0h5v5H0z"/><path stroke="#000000" d="M1 1.5h3M1 3.5h3"/></svg>';

/** A member's Profile: this laptop, a phone, and an unrecognised device; a password and a linked IdP. */
const PROFILE: ProfileView = {
  name: 'Åsa Öberg-Ängström', email: 'asa.oberg-angstrom@example.com',
  methods: [{ providerId: 'credential', label: 'Password' }, { providerId: 'upstream', label: 'Authentik' }],
  canChangePassword: true, theme: 'system', hasPassword: true, isAdmin: false, emailUnconfirmed: false,
  sessions: [
    { id: 's1', device: 'Firefox on Linux', ip: '192.168.1.20', lastSeenAt: inDays(-0.01), createdAt: inDays(-0.2), current: true },
    { id: 's"2<x>', device: 'Safari on iPhone', ip: '2001:db8::1', lastSeenAt: inDays(-1), createdAt: inDays(-3), current: false },
    { id: 's3', device: 'Unknown device', ip: null, lastSeenAt: inDays(-5), createdAt: inDays(-6), current: false },
  ],
  activity: [
    {
      id: 3, at: inDays(-0.2), actorUserId: 'u1', action: 'auth.login', targetType: 'user', targetId: 'u1', ip: '192.168.1.20', userAgent: 'Mozilla/5.0',
      outcome: 'success', details: { method: 'local' }, actorLabel: 'you', targetLabel: 'you',
    },
    {
      id: 2, at: inDays(-1), actorUserId: 'u1', action: 'settings.changed', targetType: 'user', targetId: 'u1', ip: null, userAgent: null,
      outcome: 'failure', details: { setting: 'password' }, actorLabel: 'you', targetLabel: 'you',
    },
  ],
};

/** A connected Claude (verified, used an hour ago) and an unverified app with an unknown scope that was never used. */
const APPS: AppView[] = [
  {
    clientId: 'claude-web', name: 'Claude', scopes: ['openid', 'mcp', 'offline_access'], firstUsedAt: inDays(-30), lastUsedAt: inDays(-0.04),
    redirectHost: 'claude.ai', verified: true,
  },
  {
    clientId: 'dcr"x<y>', name: 'Home dashboard', scopes: ['mcp', 'lists:write'], firstUsedAt: inDays(-2), lastUsedAt: null,
    redirectHost: 'my.dashboard:/oauth/callback', verified: false,
  },
];

/** Settings with single sign-on managed in the UI, active, and a passing test with warnings. */
const SETUP_SSO: SetupSsoView = {
  step: 'sso', managed: 'ui', switchesEnv: { linkByEmail: false, adminGroup: false, memberGroup: false }, hasLinks: false, callbackUrl: 'https://ica.example/auth/callback/upstream',
  fields: { issuerUrl: 'https://auth.example/application/o/ica-hub/', clientId: 'ica-hub', label: 'Authentik', linkByEmail: true, adminGroup: '', memberGroup: '', secret: 'none' },
};
const SETTINGS_UI: SettingsView = {
  problems: [], callbackUrl: 'https://ica.example/auth/callback/upstream',
  oidc: {
    managed: 'ui', active: true, configured: true, hasLinks: true, switchesEnv: { linkByEmail: false, adminGroup: false, memberGroup: false },
    fields: { issuerUrl: 'https://auth.example.com/application/o/ica-hub/', clientId: 'ica-hub', label: HOSTILE.script, linkByEmail: true, adminGroup: 'ica-admins', memberGroup: 'ica-users', secret: 'stored' },
  },
  check: {
    issuerUrl: 'https://auth.example.com/application/o/ica-hub/', ok: true,
    rows: [
      { id: 'scheme', status: 'pass' }, { id: 'discovery', status: 'pass' }, { id: 'issuer', status: 'pass' }, { id: 'endpoints', status: 'pass' },
      { id: 'authorize_origin', status: 'warn', code: 'other_origin' }, { id: 'jwks', status: 'warn', code: 'other_host' }, { id: 'scopes', status: 'pass' },
      { id: 'email_verified', status: 'warn', code: 'missing_claim' }, { id: 'groups', status: 'fail', code: HOSTILE.script },
    ],
  },
  signIn: { localLogin: true, managed: 'ui', activeAdmins: 2, adminsWithOidc: 1 },
};

export const PAGE_FIXTURES: Record<string, (ctx: PageCtx) => string> = {
  'loginPage:local': (ctx) => loginPage(ctx, { oauthQuery: '', oidcLabel: undefined, localLogin: true, error: undefined, next: '/admin' }),
  'loginPage:error': (ctx) => loginPage(ctx, { oauthQuery: '', oidcLabel: undefined, localLogin: true, error: 'credentials' }),
  'loginPage:oidc+oauth': (ctx) => loginPage(ctx, { oauthQuery: `a=1&sig="><script>x</script>`, oidcLabel: HOSTILE.script, localLogin: true, error: 'rate' }),
  'loginPage:local-off': (ctx) => loginPage(ctx, { oauthQuery: '', oidcLabel: 'Authentik', localLogin: false, error: 'local_disabled' }),
  'loginPage:oidc-only': (ctx) => loginPage(ctx, { oauthQuery: '', oidcLabel: 'Authentik', localLogin: false, error: undefined }),
  'loginPage:oidc-error-not-invited': (ctx) => loginPage(ctx, {
    oauthQuery: '', oidcLabel: 'Authentik', localLogin: false, error: undefined, oidcError: { code: 'not_invited', email: `${HOSTILE.script}${HOSTILE.longEmail}` },
  }),
  'loginPage:oidc-error-no-email': (ctx) => loginPage(ctx, { oauthQuery: '', oidcLabel: 'Authentik', localLogin: true, error: undefined, oidcError: { code: 'not_invited' } }),
  'loginPage:oidc-error-unknown': (ctx) => loginPage(ctx, { oauthQuery: '', oidcLabel: HOSTILE.script, localLogin: true, error: undefined, oidcError: { code: HOSTILE.script } }),
  'consentPage:verified': (ctx) => consentPage(ctx, { clientName: 'Claude', scopes: ['mcp', 'offline_access'], oauthQuery: 'x=1', redirectHost: 'claude.ai', verified: true }),
  'consentPage:unverified': (ctx) => consentPage(ctx, {
    clientName: HOSTILE.script, scopes: ['mcp', HOSTILE.script], oauthQuery: 'x="1"', redirectHost: `${HOSTILE.longEmail}.example<b>`, verified: false,
  }),
  'homePage:new-user': (ctx) => homePage(ctx, { ica: { web: icaStatus(undefined), app: appStatus(undefined) }, claude: { connected: 0, lastUsedAt: null }, mcpUrl: 'https://ica.example/mcp' }),
  'homePage:all-set': (ctx) => homePage(ctx, {
    ica: { web: icaStatus({ expiresAt: inDays(80), lastOkAt: inDays(-0.1), lastError: null }), app: appStatus({ expiresAt: inDays(0.02), lastOkAt: null, lastError: null }) },
    claude: { connected: 1, lastUsedAt: inDays(-0.2) }, mcpUrl: 'https://ica.example/mcp',
  }),
  'homePage:settings-problem': (ctx) => homePage(ctx, {
    ica: { web: icaStatus(undefined), app: appStatus(undefined) }, claude: { connected: 0, lastUsedAt: null }, mcpUrl: 'https://ica.example/mcp',
    settingsProblems: ['oidc_unreachable', 'local_login_forced'],
  }),
  'homePage:hostile': (ctx) => homePage(hostileCtx(ctx), {
    ica: { web: { tone: 'bad', label: HOSTILE.script, title: HOSTILE.script }, app: appStatus({ expiresAt: null, lastOkAt: null, lastError: HOSTILE.script }) },
    claude: { connected: 12, lastUsedAt: HOSTILE.script }, mcpUrl: `https://${HOSTILE.longEmail}/mcp"><script>`,
  }),
  'icaPage:none': (ctx) => icaPage(ctx, { account: undefined }),
  'icaDisconnectConfirmPage:own': (ctx) => icaDisconnectConfirmPage(ctx, { shared: false }),
  'icaDisconnectConfirmPage:shared': (ctx) => icaDisconnectConfirmPage(hostileCtx(ctx), { shared: true }),
  'icaPage:connected': (ctx) => icaPage(hostileCtx(ctx), {
    account: {
      displayName: HOSTILE.longName, hasSession: true, expiresAt: '2026-10-06T08:00:00.000Z', lastOkAt: '2026-09-29T07:12:00.000Z', lastError: HOSTILE.script,
      loginState: 1, loginStateAt: '2026-09-29T07:12:00.000Z',
      app: { expiresAt: null, lastOkAt: null, lastError: 'app session expired — reconnect' },
    },
  }),
  'icaPage:needs-reconnect': (ctx) => icaPage(ctx, {
    account: {
      displayName: 'Åsa', hasSession: true, expiresAt: inDays(-2), lastOkAt: inDays(-9), lastError: 'ICA session is no longer logged in',
      app: { expiresAt: inDays(3), lastOkAt: inDays(-1), lastError: null },
    },
  }),
  'icaPage:temporarily-unavailable': (ctx) => icaPage(ctx, {
    account: {
      displayName: 'Åsa', hasSession: true, expiresAt: inDays(40), lastOkAt: inDays(-1), lastError: 'geo-blocked (451)',
      app: { expiresAt: inDays(0.02), lastOkAt: inDays(-1), lastError: 'the app token could not be refreshed' },
    },
  }),
  'icaPage:no-session': (ctx) => icaPage(ctx, { account: { displayName: 'Åsa', hasSession: false, expiresAt: null, lastOkAt: null, lastError: null } }),
  'icaConnectPage:web': (ctx) => icaConnectPage(ctx, { statusUrl: '/admin/ica/connect/abc"def/status', flow: 'web' }),
  'icaConnectPage:app': (ctx) => icaConnectPage(hostileCtx(ctx), { statusUrl: '/admin/ica/connect/x/status', flow: 'app' }),
  'icaErrorPage:start': (ctx) => icaErrorPage(ctx, HOSTILE.script),
  'icaDiagnosticsPage:not-connected': (ctx) => icaDiagnosticsPage(ctx, { kind: 'not-connected' }),
  'icaDiagnosticsPage:unreadable': (ctx) => icaDiagnosticsPage(ctx, { kind: 'unreadable' }),
  'icaDiagnosticsPage:report': (ctx) => icaDiagnosticsPage(hostileCtx(ctx), {
    kind: 'report', live: true, app: { state: 'error', problem: HOSTILE.script },
    results: [
      { name: 'web-list-all', host: 'handla.api.ica.se', auth: 'web bearer', path: '/api/user/offline-shopping-lists', status: 200, sample: 'object{shoppingLists: array[2] of object{offlineId: string, title: string}}' },
      { name: 'mobile-bonus', host: 'apimgw-pub.ica.se', auth: 'app bearer', path: `/sverige/digx/mobile/${HOSTILE.longEmail}`, status: null, sample: HOSTILE.script, note: 'geo-blocked (451)' },
    ],
    listIds: [{ probe: 'web-list-all', ids: ['list-shared-1', HOSTILE.longEmail] }, { probe: 'mobile-shoppinglists', ids: [] }],
    elements: [{ probe: 'mobile-bonus', label: HOSTILE.script, shape: HOSTILE.script }],
  }),
  'icaDiagnosticsPage:offline': (ctx) => icaDiagnosticsPage(ctx, { kind: 'report', live: false, error: 'geo-blocked (451)', results: [], listIds: [] }),
  'activityPage:filtered': (ctx) => {
    const rows: EventRow[] = [
      {
        id: 2, at: '2030-01-02T00:00:00.000Z', actorUserId: 'admin1', action: 'user.role_changed',
        targetType: 'user', targetId: 'member1', ip: '203.0.113.5', userAgent: HOSTILE.script,
        outcome: 'success', details: { from: 'member', to: 'admin', via: 'admin' },
        actorLabel: 'Admin', targetLabel: HOSTILE.longName,
      },
      {
        id: 1, at: '2026-09-01T00:00:00.000Z', actorUserId: null, action: 'auth.login_failed',
        targetType: null, targetId: null, ip: '198.51.100.9', userAgent: 'Mozilla/5.0',
        outcome: 'failure', details: { method: 'local', reason: 'credentials', email: HOSTILE.script },
        actorLabel: s.activity.system, targetLabel: '',
      },
    ];
    return activityPage(ctx, {
      rows, total: 61, page: 1, pageSize: 50,
      filter: { user: 'admin1', action: 'user.role_changed', from: '2030-01-02', to: '2030-01-02' },
      users: [{ id: 'admin1', label: 'Admin' }, { id: 'member1', label: HOSTILE.longName }],
    });
  },
  'activityPage:empty': (ctx) => activityPage(ctx, {
    rows: [], total: 0, page: 1, pageSize: 50, filter: {}, users: [{ id: 'admin1', label: 'Admin' }],
  }),
  'activityPage:past-end': (ctx) => activityPage(ctx, {
    rows: [], total: 61, page: 99, pageSize: 50, filter: {}, users: [{ id: 'admin1', label: 'Admin' }],
  }),
  'usersPage:household': (ctx) => usersPage(ctx, { users: HOUSEHOLD, invites: [
    { id: 'i1', email: HOSTILE.longEmail, role: 'member', expiresAt: inDays(6), shareable: true },
    { id: 'i"2<x>', email: 'kid@example.com', role: 'admin', expiresAt: inDays(0.5), shareable: false },
  ] }),
  'usersPage:group-roles': (ctx) => usersPage(ctx, { users: HOUSEHOLD, invites: [], groupRoles: { label: HOSTILE.script } }),
  'usersPage:single-admin': (ctx) => usersPage(ctx, { users: [{ ...HOUSEHOLD[0]!, ica: icaStatus(undefined), signInMethods: [] }, HOUSEHOLD[2]!], invites: [] }),
  'userEmailPage:default': (ctx) => userEmailPage(ctx, { user: { id: 'u2', name: 'Erik', email: 'erik@example.com' }, unconfirmed: false }),
  'userEmailPage:unconfirmed': (ctx) => userEmailPage(ctx, { user: { id: 'u"3<x>', name: HOSTILE.longName, email: HOSTILE.longEmail }, unconfirmed: true }),
  'userConfirmPage:remove': (ctx) => userConfirmPage(ctx, { kind: 'remove', user: { id: 'u"3', name: HOSTILE.longName, email: HOSTILE.longEmail } }),
  'userConfirmPage:disable': (ctx) => userConfirmPage(ctx, { kind: 'disable', user: { id: 'u2', name: HOSTILE.script, email: 'kid@example.com' } }),
  'userConfirmPage:disconnect': (ctx) => userConfirmPage(ctx, { kind: 'disconnect', user: { id: 'u2', name: '', email: 'kid@example.com' } }),
  'userConfirmPage:unlink-shared': (ctx) => userConfirmPage(ctx, { kind: 'disconnect', icaShared: true, user: { id: 'u2', name: 'Kid', email: 'kid@example.com' } }),
  'invitePage:accept-local+oidc': (ctx) => invitePage({ ...ctx, user: undefined }, { state: 'accept', email: HOSTILE.longEmail, token: TOKEN, localLogin: true, oidcLabel: HOSTILE.script }),
  'invitePage:accept-local': (ctx) => invitePage({ ...ctx, user: undefined }, { state: 'accept', email: 'partner@example.com', token: TOKEN, localLogin: true }),
  'invitePage:accept-oidc-only': (ctx) => invitePage({ ...ctx, user: undefined }, { state: 'accept', email: 'partner@example.com', token: TOKEN, localLogin: false, oidcLabel: 'Authentik' }),
  'setupPage:code': (ctx) => setupPage({ ...ctx, user: undefined }, { step: 'code' }),
  'setupPage:choose': (ctx) => setupPage({ ...ctx, user: undefined }, { step: 'choose', sso: { managed: 'none', ready: false }, localLogin: true }),
  'setupPage:choose-env': (ctx) => setupPage({ ...ctx, user: undefined }, { step: 'choose', sso: { managed: 'env', label: 'Authentik', ready: true }, localLogin: true }),
  // AUTH_LOCAL_LOGIN=false with OIDC in env: the password option is hidden, SSO is the only way to become the admin.
  'setupPage:choose-sso-only': (ctx) => setupPage({ ...ctx, user: undefined }, { step: 'choose', sso: { managed: 'env', label: 'Authentik', ready: true }, localLogin: false }),
  'setupPage:sso-form': (ctx) => setupPage({ ...ctx, user: undefined }, {
    ...SETUP_SSO, fields: { ...SETUP_SSO.fields, issuerUrl: `https://${HOSTILE.longEmail}/o/`, label: HOSTILE.script, secretTyped: true },
    check: { issuerUrl: `https://${HOSTILE.longEmail}/o/`, ok: false, rows: [{ id: 'discovery', status: 'pass' }, { id: 'issuer', status: 'fail', code: 'issuer_mismatch' }] },
  }),
  'setupPage:sso-ready': (ctx) => setupPage({ ...ctx, user: undefined }, {
    ...SETUP_SSO, fields: { ...SETUP_SSO.fields, secret: 'stored' }, ready: { label: 'Authentik' },
    check: { issuerUrl: SETUP_SSO.fields.issuerUrl, ok: true, rows: [{ id: 'discovery', status: 'pass' }, { id: 'jwks', status: 'warn', code: 'other_host' }] },
  }),
  'setupPage:sso-env': (ctx) => setupPage({ ...ctx, user: undefined }, {
    ...SETUP_SSO, managed: 'env', switchesEnv: { linkByEmail: true, adminGroup: true, memberGroup: true }, fields: { ...SETUP_SSO.fields, secret: 'stored' }, ready: { label: HOSTILE.script },
  }),
  'setupPage:sso-error': (ctx) => setupPage({ ...ctx, user: undefined }, {
    ...SETUP_SSO, fields: { ...SETUP_SSO.fields, secret: 'stored' }, ready: { label: 'Authentik' }, oidcError: { code: 'not_invited' },
  }),
  'invitePage:gone': (ctx) => invitePage({ ...ctx, user: undefined }, { state: 'gone' }),
  'invitePage:other-user': (ctx) => invitePage(ctx, { state: 'other-user', email: 'partner@example.com', signedInAs: HOSTILE.longEmail, token: `${TOKEN}"><script>` }),
  'invitePage:same-user': (ctx) => invitePage(ctx, { state: 'same-user', email: HOSTILE.script }),
  'inviteSharePage:fresh': (ctx) => inviteSharePage(ctx, {
    email: HOSTILE.longEmail, role: 'member', link: `https://ica.example/admin/invite/${TOKEN}`, qrSvg: QR_SVG, expiresAt: inDays(7), inviteId: 'i1',
  }),
  'inviteSharePage:expired-share': (ctx) => inviteSharePage(ctx, { email: 'kid@example.com', role: 'admin', expiresAt: inDays(6.9), inviteId: 'i"2<x>' }),
  'profilePage:local': (ctx) => profilePage(ctx, PROFILE),
  'profilePage:oidc-only': (ctx) => profilePage(ctx, {
    ...PROFILE, methods: [{ providerId: 'upstream', label: 'Authentik' }], canChangePassword: false, hasPassword: false, theme: 'dark', activity: [],
  }),
  'profilePage:admin': (ctx) => profilePage(ctx, { ...PROFILE, isAdmin: true }),
  'profilePage:email-unconfirmed': (ctx) => profilePage(ctx, { ...PROFILE, emailUnconfirmed: true }),
  'profilePage:long-name': (ctx) => profilePage(hostileCtx(ctx), {
    ...PROFILE, name: HOSTILE.longName, email: HOSTILE.longEmail, methods: [{ providerId: 'x', label: HOSTILE.script }],
    sessions: [{ ...PROFILE.sessions[0]!, device: HOSTILE.script, ip: HOSTILE.longEmail }], moreSessions: 912,
  }),
  'appsPage:one': (ctx) => appsPage(ctx, { apps: [APPS[0]!], mcpUrl: 'https://ica.example/mcp' }),
  'appsPage:two': (ctx) => appsPage(ctx, { apps: APPS, mcpUrl: 'https://ica.example/mcp' }),
  'appsPage:empty': (ctx) => appsPage(ctx, { apps: [], mcpUrl: 'https://ica.example/mcp' }),
  'appsPage:hostile-name': (ctx) => appsPage(hostileCtx(ctx), {
    apps: [{ ...APPS[1]!, name: '<img src=x onerror=alert(1)>', redirectHost: `${HOSTILE.longEmail}<b>`, scopes: [HOSTILE.script] }, { ...APPS[0]!, name: HOSTILE.longName, redirectHost: null }],
    mcpUrl: `https://${HOSTILE.longEmail}/mcp"><script>`,
  }),
  'appConfirmPage:revoke': (ctx) => appConfirmPage(ctx, { clientId: 'dcr"x<y>', name: '<img src=x onerror=alert(1)>', redirectHost: HOSTILE.longEmail }),
  'settingsPage:ui': (ctx) => settingsPage(ctx, SETTINGS_UI),
  'settingsPage:ui-empty': (ctx) => settingsPage(ctx, {
    problems: [], callbackUrl: 'https://ica.example/auth/callback/upstream',
    oidc: {
      managed: 'ui', active: false, configured: false, hasLinks: false, switchesEnv: { linkByEmail: false, adminGroup: false, memberGroup: false },
      fields: { issuerUrl: '', clientId: '', label: 'Single sign-on', linkByEmail: true, adminGroup: '', memberGroup: '', secret: 'none' },
    },
    check: { issuerUrl: '', ok: false, rows: [{ id: 'scheme', status: 'fail', code: 'invalid_url' }] },
    signIn: { localLogin: true, managed: 'ui', activeAdmins: 1, adminsWithOidc: 0 },
  }),
  // The environment's view has no secret field at all: the page can only show the fixed mask.
  'settingsPage:env': (ctx) => settingsPage(ctx, {
    problems: [], callbackUrl: `https://${HOSTILE.longEmail}/auth/callback/upstream`,
    oidc: {
      managed: 'env', active: true, configured: true, hasLinks: true, switchesEnv: { linkByEmail: true, adminGroup: true, memberGroup: true },
      fields: { issuerUrl: `https://${HOSTILE.longEmail}/application/o/ica-hub/`, clientId: HOSTILE.script, label: 'Authentik', linkByEmail: false, adminGroup: '', memberGroup: '', secret: 'stored' },
    },
    signIn: { localLogin: false, managed: 'env', activeAdmins: 1, adminsWithOidc: 1 },
  }),
  'settingsPage:problems': (ctx) => settingsPage(ctx, {
    ...SETTINGS_UI, problems: ['oidc_invalid', 'oidc_undecryptable', 'oidc_unreachable', 'local_login_forced'], check: undefined,
    oidc: { ...SETTINGS_UI.oidc, active: false, hasLinks: false, switchesEnv: { linkByEmail: true, adminGroup: false, memberGroup: false }, fields: { ...SETTINGS_UI.oidc.fields, label: 'Authentik' } },
  }),
  'settingsPage:retype-secret': (ctx) => settingsPage(ctx, { ...SETTINGS_UI, oidc: { ...SETTINGS_UI.oidc, fields: { ...SETTINGS_UI.oidc.fields, secretTyped: true } } }),
  'settingsPage:unreadable-secret': (ctx) => settingsPage(ctx, {
    ...SETTINGS_UI, problems: ['oidc_undecryptable'], check: undefined,
    oidc: { ...SETTINGS_UI.oidc, active: false, fields: { ...SETTINGS_UI.oidc.fields, secret: 'unreadable' } },
  }),
  'settingsPage:groups-seen': (ctx) => settingsPage(ctx, {
    ...SETTINGS_UI,
    groupsSeen: {
      label: HOSTILE.script, known: true,
      configured: [{ name: 'ica-hub-admins', sent: true }, { name: `ica-hub-${HOSTILE.longEmail}`, sent: false }, { name: 'household', sent: false }],
    },
  }),
  'settingsPage:groups-unknown': (ctx) => settingsPage(ctx, { ...SETTINGS_UI, groupsSeen: { label: 'Authentik', known: false, configured: [{ name: 'ica-hub-admins' }] } }),
  'setupPage:group-start': (ctx) => setupPage({ ...ctx, user: undefined }, { step: 'code', groupStart: { label: HOSTILE.script }, oidcError: { code: 'setup_incomplete' } }),
  'settingsConfirmPage:remove': (ctx) => settingsConfirmPage(ctx),
  'errorPage:403': (ctx) => errorPage(ctx, { status: 403, code: 'forbidden' }),
  'errorPage:404': (ctx) => errorPage(ctx, { status: 404, code: 'not_found' }),
  'errorPage:410': (ctx) => errorPage(ctx, { status: 410, code: 'gone' }),
  'errorPage:413': (ctx) => errorPage(ctx, { status: 413, code: 'too_large' }),
  'errorPage:500': (ctx) => errorPage(ctx, { status: 500, code: 'internal' }),
};
