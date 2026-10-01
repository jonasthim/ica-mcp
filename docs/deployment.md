# Deployment

ica-hub is a single Node.js process plus a persistent data directory (SQLite database +
WAL files). It terminates OAuth, MCP and the admin UI itself; TLS and public routing are
the reverse proxy's job. Every release (a `v*` tag on github.com/jonasthim/ica-mcp)
publishes two installable artefacts:

- a multi-arch Docker image, `ghcr.io/jonasthim/ica-mcp` (linux/amd64 and linux/arm64),
  tagged `<version>` (e.g. `0.2.0`), `<major>.<minor>` (e.g. `0.2`) and `latest`;
- a GitHub release with `install.sh`, the source tarball `ica-mcp-<version>.tar.gz` it
  installs, and `SHA256SUMS` covering both.

So there are three ways to deploy: the Docker image, the release installer on a Debian 13
host or LXC (bare systemd, no Docker), or the same installer run against a source tree you
copy over yourself ("from source"). Everything under Prerequisites, Reverse proxy
requirements, Secrets and Monitoring below applies to all of them.

The code, the systemd unit and the paths keep the name `ica-hub` (`/opt/ica-hub`,
`/etc/ica-hub`, `/var/lib/ica-hub`, `ica-hub.service`); only the repository, the release
files and the image are named `ica-mcp`.

## Docker image (quick path)

See [Docker (container)](#docker-container) below for the full steps. In short: copy
`compose.yaml`, put `ICA_HUB_URL`, `ICA_HUB_MASTER_KEY` and `ICA_HUB_AUTH_SECRET` in a
`.env` next to it, and `docker compose up -d`. The data lives in the `/data` volume.

**Pinning a version.** `latest` follows every release. To stay on one, set the image to
`ghcr.io/jonasthim/ica-mcp:0.2.0` (exactly that release) or `:0.2` (the newest 0.2.x
patch release). Upgrade by changing the tag, after reading the release notes.

## Release installer (Debian 13 host or LXC)

As root on a fresh Debian 13 host or container (for example one created with the Proxmox
community `debian` script):

```bash
curl -fsSL https://github.com/jonasthim/ica-mcp/releases/latest/download/install.sh | ICA_HUB_URL=https://ica.example.com bash
```

The installer:

1. resolves the version: `ICA_HUB_VERSION` if set (e.g. `ICA_HUB_VERSION=0.2.0`),
   otherwise the latest release, read from where GitHub's `releases/latest` link redirects
   to (no GitHub API call, so no API rate limit);
2. downloads `ica-mcp-<version>.tar.gz` and `SHA256SUMS` from
   `https://github.com/jonasthim/ica-mcp/releases/download/v<version>/`, checks the
   tarball's SHA-256 and aborts on a mismatch before touching anything;
3. replaces the source in `/opt/ica-hub` with the release (everything there except
   `node_modules` is removed first: nothing stateful lives there, the database is in
   `/var/lib/ica-hub` and the configuration in `/etc/ica-hub/env`), and writes the version
   to `/opt/ica-hub/VERSION`;
4. continues with the same steps as the source install below: apt dependencies, Node.js
   24, the `ica-hub` user, the build, `/etc/ica-hub/env` on the first run only, the
   systemd unit, and a `/healthz` check. It ends by printing the installed version.

It never asks anything (stdin is not read, so piping into `bash` is safe), and it never
overwrites an existing `/etc/ica-hub/env`. Set `ICA_HUB_REPO` to install from a fork
(`owner/repo`) or a mirror (a base URL with the same `releases/download/v<version>/`
layout).

**Verify first.** To read the installer and check it against the release's checksums
before running it as root:

```bash
curl -fsSLO https://github.com/jonasthim/ica-mcp/releases/latest/download/install.sh
curl -fsSLO https://github.com/jonasthim/ica-mcp/releases/latest/download/SHA256SUMS
sha256sum -c --ignore-missing SHA256SUMS   # expect: install.sh: OK
less install.sh
ICA_HUB_URL=https://ica.example.com bash install.sh
```

**Upgrade.** Back up the database first (see Backups), then re-run the installer with no
arguments: it installs the latest release, rebuilds and restarts the service. Pin or
roll forward to a specific release with `ICA_HUB_VERSION=<version>`. `cat
/opt/ica-hub/VERSION` shows what is installed.

```bash
curl -fsSL https://github.com/jonasthim/ica-mcp/releases/latest/download/install.sh | bash
```

Logs, backups and the env file work as described for the source install below.

## From source (bare systemd, Debian LXC)

The same installer, run against a source tree you copy to `/opt/ica-hub` yourself, for
example an unreleased commit or a local change. It builds and runs ica-hub as a plain
systemd service, no Docker involved. The installer uses the tree as it is when
`/opt/ica-hub/package.json` exists, there is no `/opt/ica-hub/VERSION` (a release install
writes one; the `rsync --delete` below removes it) and `ICA_HUB_VERSION` is not set.

1. Create the LXC (Proxmox community `debian` script or equivalent), then rsync the
   source tree into it at `/opt/ica-hub`, excluding build output and local state:

   ```bash
   rsync -av --delete \
     --exclude node_modules --exclude dist --exclude data \
     --exclude '.env*' --exclude spike/out --exclude .superpowers --exclude .git \
     ./ root@<lxc-host>:/opt/ica-hub/
   ```

2. On the LXC, as root: `ICA_HUB_URL=https://ica.example.com deploy/install.sh` (run
   from `/opt/ica-hub`). The script is idempotent: it installs apt dependencies
   (`ca-certificates curl build-essential python3` — the last two are the build-time
   fallback if better-sqlite3's prebuilt binary isn't available for the host), installs
   Node.js 24 via NodeSource if a new-enough Node isn't already present, creates the
   `ica-hub` system user/group and its directories (`/var/lib/ica-hub` for the database,
   `/etc/ica-hub` for config), builds the app as that user (`pnpm install --frozen-lockfile
   && pnpm build && pnpm prune --prod`), writes `/etc/ica-hub/env` on first run only (it
   never overwrites an existing one — generated secrets are reported by name, never by
   value), installs `deploy/ica-hub.service`, and starts (or restarts, on an upgrade) the
   service, waiting up to 20s for `/healthz` to come up before exiting.
3. If `ICA_HUB_URL` wasn't passed to the installer, it writes a placeholder into
   `/etc/ica-hub/env` that makes the service fail fast with a clear config error on
   startup — edit that file and set the real public origin, then `systemctl restart
   ica-hub`.
4. **Upgrade**: re-run the rsync in step 1 (it deletes files removed upstream, including
   a `VERSION` file from an earlier release install), then re-run `deploy/install.sh` —
   it rebuilds in place and restarts the service. To switch back to releases, run the
   release installer with `ICA_HUB_VERSION` set once. Database
   migrations run automatically on startup, same as the container. **Back up the
   database first** (see Backups below) — this release's migrations
   (`0003_roles-to-user`, `0004_phase1-5-users-audit-invites`) run automatically and
   atomically, but are not backward-compatible: `0004` drops the old
   `user_profile.role` column entirely, so an older build queries a column that no
   longer exists and cannot start against a migrated database. A rollback for this
   release therefore means restoring the backup together with the previous build, not
   just re-deploying old code onto the already-migrated database.
5. **Logs**: `journalctl -u ica-hub -f`.
6. **Backups**: take a consistent snapshot of the live database with SQLite's online
   backup (`apt install sqlite3` once), not by copying the database and WAL files while
   the service writes to them:

   ```bash
   sqlite3 /var/lib/ica-hub/ica-hub.db ".backup '/var/backups/ica-hub-$(date +%F).db'"
   ```

   See Backups below. Back up `ICA_HUB_MASTER_KEY` from `/etc/ica-hub/env` separately
   from that snapshot, same reasoning as the container case: neither is useful without
   the other.

## Prerequisites

- A public IPv4 A record pointing at the host, and a reverse proxy in front of it
  (Caddy, Traefik, nginx, …) that terminates TLS.
- The vhost for ica-hub must **not** have SSO/forward-auth in front of it. ica-hub does
  its own authentication (Better Auth OAuth for MCP clients, a login/consent flow for
  the admin UI) — an SSO layer in front would break the OAuth redirect/callback flow and
  the `/mcp` bearer-token flow, neither of which is a browser session a forward-auth
  proxy can intercept.
- `160.79.104.0/21` is **not** ICA's network range — it's Anthropic's outbound range for
  Claude's remote MCP connectors (see the connector docs at claude.com). Allowlisting it
  is optional, and only needed if a WAF or CrowdSec in front of ica-hub bans Claude's
  connector traffic while a household member is setting up the MCP connection (a
  misidentified brute-force pattern, a rate limit, etc.). It has nothing to do with ICA's
  own traffic.

## Reverse proxy requirements

- **Pass the `Host` header through unchanged, on every path.** ica-hub compares the
  inbound `Host` header against the host of `ICA_HUB_URL` and answers `421 Misdirected
  Request` if they don't match, on `/mcp`, `/auth/*` and `/.well-known/*`. `/admin/*`
  has no such check (it builds every URL from `ICA_HUB_URL`, never from the request),
  but forward `Host` unchanged there too: a proxy that rewrites it for one path usually
  rewrites it for all of them, which is a much harder failure to track down than a clean
  421. Don't rewrite `Host`, and don't put ica-hub behind a proxy that forwards a
  different host to the upstream (e.g. an internal service name) — the proxy must be a
  transparent passthrough for this header.
- **Set `TRUST_PROXY`.** ica-hub trusts `X-Forwarded-For` (via Express's `trust proxy`
  setting) only when `TRUST_PROXY` is set, and the admin login rate limiter keys clients
  by the request IP it resolves. Behind any reverse proxy, leave `TRUST_PROXY` unset and
  every client is keyed as the proxy's own IP — one bad login attempt from any user rate
  limits *everyone*. Set it to the exact number of proxy hops in front of ica-hub
  (usually `1`; `compose.yaml` defaults it to `1`).
  **Do not use `TRUST_PROXY=true`:** it trusts the leftmost `X-Forwarded-For` entry,
  which the client writes itself, so any client can pick its own IP and walk around the
  login rate limit. Count your hops (CDN/tunnel + reverse proxy = `2`) and set that
  number. Better Auth's own rate limiter uses the same resolved IP.
- **Invite links end up in access logs.** Proxy access logs record `/admin/invite/<token>` paths, and an unused token there can be redeemed. Rotate or trim those logs, and treat an invite link as spent once it has been accepted (revoke any link you no longer need).

## Secrets

Two secrets are required for a fresh deployment; the other two below are optional,
for automated installs that shouldn't wait on the admin UI. Generate each with
`openssl rand` and store them somewhere durable outside the container (password
manager, secrets vault, `.env` file kept out of the `/data` backup — see below).

| Variable | Purpose | Generate with |
| --- | --- | --- |
| `ICA_HUB_MASTER_KEY` | AES-256-GCM key that encrypts every ICA session/credential stored in the database. Losing it makes all stored sessions permanently undecryptable — the household will need to re-link ICA accounts. | `openssl rand -base64 32` |
| `ICA_HUB_AUTH_SECRET` | Better Auth's signing secret for OAuth sessions and JWTs (≥ 32 chars). Rotating it invalidates every issued token and admin session. | `openssl rand -base64 32` |
| `ICA_HUB_ADMIN_EMAIL` / `ICA_HUB_ADMIN_PASSWORD` | Optional. **First start only**: creates the first admin when the database has no users (automation, Docker). Ignored as soon as any user exists — it never recreates a removed or renamed admin. Remove both after the first start. | `openssl rand -base64 18` (password) |
| `ICA_HUB_SETUP_CODE` | Optional. A setup code you choose (12–64 letters/digits), accepted by first-run setup in addition to the one in the log. For automated installs. | — |

`ICA_HUB_MASTER_KEY` is **not** part of the `/data` volume — see Backups.

`DATABASE_PATH` is read from the environment (default `data/ica-hub.db`, relative to the
process's working directory). The container sets it via the `Dockerfile`
(`/data/ica-hub.db`) and `compose.yaml`'s volume mount; the bare-systemd installer sets
it in `/etc/ica-hub/env` (`/var/lib/ica-hub/ica-hub.db`).

### Trusted OAuth clients (optional)

`ICA_HUB_TRUSTED_CLIENT_IDS` is a comma-separated list of OAuth client ids whose consent
page skips the "unverified application" warning. Leave it empty unless you registered a
client by hand (dynamic client registration always shows the warning) and have manually
verified who runs it.

### Shopping-list writes (optional)

`ICA_HUB_LIST_WRITES` decides who may use the tools that change shopping lists (`add_list_items`,
`check_list_items`, `uncheck_list_items`, `remove_list_items`, `create_shopping_list`). They write to the
household's real, shared ICA lists.

| Value | Effect |
| --- | --- |
| `off` (default, also when unset or empty) | The write tools are not registered: Claude does not see them. The read tools work as before. |
| `all` | Every hub user with ICA app access can use them. |
| `owner@example.com,partner@example.com` | The tools are offered to everyone, but a call from a user whose **current** hub email (read from the database, any case) is not on the list is refused with "List editing is not enabled for your account yet." before any ICA call. |

Any other value stops the hub at start-up with a configuration error. Keep it `off` until the write requests have
been checked live, then allow one account first.

### App-token upkeep (optional)

`ICA_HUB_APP_UPKEEP` decides how ICA app tokens are kept fresh.

| Value | Effect |
| --- | --- |
| `interval` (default, also when unset or empty) | Like the ICA app, every connected app session is refreshed about every 10 minutes, whether anyone uses it or not (see ICA session metrics and alerts below). An unused connection never lapses. |
| `on-demand` | Nothing is scheduled: an app token is refreshed only when a tool call needs it (less than a minute left). An app session nobody uses can lapse and then needs **Connect app access** again. |

Any other value stops the hub at start-up with a configuration error. `on-demand` is the fallback if an app token
refresh turns out to end web purchase history (ICA's `loginState` dropping from 2 right after an upkeep refresh):
switching it is a restart, not a code change. With `on-demand`, `ica_hub_ica_app_upkeep_enabled` is 0 and the three
alert rules that assume the upkeep (`IcaHubAppTokenExpired`, `IcaHubAppTokenExpiresSoon`, `IcaHubAppRefreshStale`,
including their absent-gauge checks) stay quiet; an app session nobody uses is then expected to lapse, and shows as
unhealthy only once a tool call fails.

### ICA app DCR secret (optional)

`ICA_APP_DCR_CLIENT_SECRET` overrides the ICA app's dynamic-client-registration secret used by
the experimental "Connect app access" on `/admin/ica`. The built-in default is the public client
credential distributed in ICA's own app (also used by existing open-source ICA clients). It only
permits dynamic client registration; signing in still requires BankID. Set this only if ICA
rotates it.

### OIDC sign-in (optional, e.g. Authentik)

`OIDC_CLIENT_SECRET` is a secret like the three above: generate it at the IdP (not with `openssl rand`) and store it
the same way. `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` are all-or-nothing — see
[Single sign-on (OIDC)](#single-sign-on-oidc) below for the redirect URI, scopes, the full variable list, who can
sign in, and a worked Authentik example.

## First-run setup

While the `user` table is empty, every `/admin` page redirects to `/admin/setup`; the route answers 404 as soon as
any user exists.

The setup code is written to the log once, at warn level, at startup (while the `user` table is still empty) — and
again, as a fallback, on the first code check at `/admin/setup` if it hadn't already been logged:

```bash
journalctl -u ica-hub | grep 'setup code'
# or, for the Docker setup:
docker compose logs ica-hub | grep 'setup code'
```

It looks like `ABCD-EFGH-JKLM`. Restarting the service before setup finishes prints (and logs) a new code; the old
one stops working.

**If `LOG_LEVEL` is `error` or `silent`, the code never appears in the log** — that level filters it out before it's
written. Set `ICA_HUB_SETUP_CODE` (see Secrets above) instead, and use that value at `/admin/setup`.

**A setup session (started by entering the code) lasts 30 minutes.** After that the page shows "The setup session
expired" and the code must be entered again — nothing already saved (e.g. a tested single sign-on connection) is
lost, but the page has to be reloaded from `/admin/setup`.

After entering the setup code, there are two ways to create the first admin:

- **Password**: fill in an email, name and password. Hidden when password sign-in is off (`AUTH_LOCAL_LOGIN=false`,
  or a password-off setting left in Settings while single sign-on works) — that combination needs single sign-on instead, or
  the admin it created could never sign in again.
- **Single sign-on first**: enter your identity provider on the setup page, **Test connection**, save it, then
  **Continue with `<label>`**. Whichever account you sign in with becomes the admin — use your own account, not a
  shared or service one.

`/admin/setup` is rate-limited like the sign-in form: **10 attempts per IP per 15 minutes**, plus an overall cap
across every IP together, so the code can't be brute-forced by spreading attempts across many addresses. If that
overall cap is what's blocking you, your way in is the env bootstrap (`ICA_HUB_ADMIN_EMAIL` /
`ICA_HUB_ADMIN_PASSWORD`, which — as above — only ever act on an empty database), or simply restarting the service,
which clears both limits.

**Single sign-on first has a 2-minute claim window.** The first OIDC sign-in that carries a live setup session
becomes the admin. If the Authentik (or other IdP) sign-in fails partway through, wait 2 minutes before retrying, or
switch to the password path instead.

**With single sign-on and an admin group in the environment, no setup code is needed.** When `OIDC_ISSUER_URL`,
`OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` and `OIDC_ADMIN_GROUP` are set (and the provider loaded), `/admin/setup`
also shows **Continue with `<label>`** straight away. The first sign-in by a member of the admin group becomes the
admin and closes setup — the identity provider's admin group vouches for them. A member-group sign-in on the empty
database creates nobody ("ICA-MCP is not set up yet…"), because it would close setup with no admin. Of two admin-group
sign-ins at the same moment exactly one becomes the admin; the other account is created as a member and becomes admin
at its next sign-in. With a UI-managed connection this shortcut does not exist: use the setup code.

## Single sign-on (OIDC)

Optional. The normal way to set it up is the admin UI: **Settings → Single sign-on**. Enter the issuer, client ID
and secret from your identity provider, a button label, whether to link existing accounts by email, and the
optional admin and member groups, then **Test connection** and **Save**. A save takes effect immediately — no restart needed.

### The client secret

The secret field is write-only: Settings never shows it back to you, and leaving it blank on Save keeps whatever is
already stored. It's stored encrypted with `ICA_HUB_MASTER_KEY`. If that key ever changes, the stored secret can no
longer be decrypted — Settings shows this, and you re-enter the secret to fix it. After **Test connection**, retype
the secret before **Save**: it is never carried over from the test, and a blank field on Save keeps the previously
stored secret, not the one you just tested.

### Environment wins

Set `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` together (all or none) to manage the connection
from the environment instead — this makes the whole Single sign-on section on Settings read-only ("Managed by the
environment"). `OIDC_LINK_BY_EMAIL`, `OIDC_ADMIN_GROUP`, `OIDC_MEMBER_GROUP` and `AUTH_LOCAL_LOGIN` each do the
same for their own field, independently of each other and of whether the connection itself is in the environment. An environment
mistake still stops the service at startup, same as before. A problem with settings saved through the UI never
does that: single sign-on switches itself off instead, and a banner explains why — on Settings and on admins' Home
page.

### What Test connection checks

| Check | Required to save | What it means |
| --- | --- | --- |
| Uses HTTPS | Yes | The issuer URL is `https://` (or `http://` on localhost, for testing). |
| Discovery document found | Yes | `<issuer>/.well-known/openid-configuration` answers with JSON. |
| Issuer matches | Yes | The discovery document's own `issuer` matches the URL you entered. |
| Sign-in endpoints listed | Yes | The authorization, token and keys (JWKS) addresses are all present and all use HTTPS (or HTTP on localhost) — a plain-HTTP endpoint fails this check outright. |
| Signing keys available | Yes | The keys (JWKS) endpoint answers with at least one key. |
| Scopes openid, email and profile | Yes | The discovery document lists all three as supported scopes (not listing scopes at all only warns). |
| Sign-in page on the issuer's host | No — warning | The authorization endpoint is on the same origin as the issuer. Off-origin can still work, but ICA-MCP's pages only allow form posts to the issuer's origin, so a browser may block the redirect. |
| Sends email_verified | No — warning | The provider lists `email_verified` among its supported claims. |
| Groups scope (for the group mapping) | No — warning, checked only when an admin or member group is set | The `groups` scope is listed as supported. This is only a hint: Authentik lists `groups` even when no groups scope mapping is bound to the provider, so a pass does not prove the claim will arrive. A sign-in without it is refused as `groups_missing` and logged (see Group mapping). |

A failing required check blocks Save; a warning does not.

### The lockout guard

Saving sign-in settings is refused in these cases, in plain words:

- **Turning password sign-in off** needs single sign-on to be working, at least one admin already linked to it,
  and — unless "link existing accounts by email" is on — every admin already linked. Otherwise nobody, or not
  every admin, could get back in.
- **Removing single sign-on** needs password sign-in on, with at least one admin who has a password.
- **Changing the issuer, client ID or secret** needs password sign-in on first. A wrong value can't be verified
  before it's saved, so this rule keeps a bad connection from locking everyone out: turn password sign-in back on,
  change the values, verify with Test connection, then turn password sign-in off again once it's confirmed
  working.
- **Changing the issuer** while people are already linked to single sign-on unlinks everyone (the linked subjects
  belong to the old identity provider). If no admin has a password and linking by email is off, this save is
  refused outright — there would be nobody left who could sign in as admin. Otherwise you tick a box acknowledging
  the unlink.
- **An admin group you are not in** is refused ("You are not in that admin group…"): when your own last single
  sign-on is remembered (see Group mapping) and did not carry that group name, saving it would demote you, and
  every other admin not in it, at the next sign-in. If your groups are unknown (a password-only session, or after a restart) the name can't be checked; the
  save goes through and the page says so.
- A failed connection test, a provider that fails to load once saved, or an internal error also block the save. A
  setting managed by the environment can't be changed here at all, and once first-run setup has finished it can no
  longer save anything either (that path is only for creating the first admin).

### Redirect URI

Register this exact redirect URI at the IdP (strict match — no wildcard, no trailing slash):

```
https://<your ica-hub host>/auth/callback/upstream
```

**Older notes saying
`/auth/oauth2/callback/upstream` are wrong** for Better Auth 1.7 — the generic-OAuth plugin's callback route is
`/auth/callback/<providerId>` (ica-hub's provider id is `upstream`), not nested under `/oauth2`.

### Provider settings at the IdP

- **Client type:** confidential (a client secret is required).
- **Scopes:** `openid email profile`, plus `groups` when you set an admin or member group — ica-hub only asks for
  `groups` when one is configured, and the provider needs a groups scope mapping bound to send the claim.
- **Signing key:** RS256.
- **Claims:** the IdP must put `email` and `email_verified` in the ID token itself, not only behind the userinfo
  endpoint — in Authentik, turn on **"Include claims in id_token"** on the scope mapping.

### Variables (alternative to the Settings page)

Setting these in the environment instead of using the Settings page makes the connection — and, individually, each
switch below — read-only in the UI; see Environment wins above.

| Variable | Purpose | Default |
| --- | --- | --- |
| `OIDC_ISSUER_URL` | The issuer origin + path, e.g. Authentik's `https://auth.example.com/application/o/ica-hub/`. ica-hub appends `/.well-known/openid-configuration` itself — don't include it in the value. | required with OIDC |
| `OIDC_CLIENT_ID` | The client id from the IdP. | required with OIDC |
| `OIDC_CLIENT_SECRET` | The client secret from the IdP — a secret, same handling as the Secrets above. | required with OIDC |
| `OIDC_LABEL` | The button text ("Continue with `<OIDC_LABEL>`"), and how the method is named on the Profile page. | `Single sign-on` |
| `OIDC_LINK_BY_EMAIL` | Link an existing ica-hub user to their first OIDC sign-in when the IdP verifies the same email. | `true` |
| `OIDC_ADMIN_GROUP` | The `groups` claim value whose members are admins (see Group mapping). | unset |
| `OIDC_MEMBER_GROUP` | The `groups` claim value whose members are members (see Group mapping). | unset |
| `AUTH_LOCAL_LOGIN` | Password sign-in. `false` removes the password form, password invites and password-change everywhere, and requires OIDC to be configured. | `true` |

### Who can sign in

An OIDC sign-in needs `email_verified: true` in the token, and succeeds for exactly one of:

- **(a) an already-linked OIDC subject** — the account was created by a previous OIDC sign-in or invite acceptance;
- **(b) an invited email**, matched case-insensitively — the account is created on this sign-in with the role the
  invite carries;
- **(c) an existing ica-hub user with the same verified email**, on the *first* OIDC sign-in for that user, only
  when linking by email is on (the default);
- **(d) a member of the admin or member group** (when one is set) with no account yet — the account is created on
  this sign-in, as admin when the admin group is in the claim, otherwise as member, and audited as "Created from a
  group". If the email already belongs to an ica-hub user who could not be linked (linking by email off, an email the
  user set themselves, or already linked to another identity), the sign-in is refused instead: a second account with
  the same email is never created.

Anyone else sees: *"No ICA-MCP account for `<email>` — ask an admin for an invite."*

### Group mapping

Both groups are optional; with neither set, the `groups` claim is ignored and everything above works as it always
has. With either set, the `groups` claim decides:

- **Who gets an account without an invite** — rule (d) above.
- **Roles, at every single sign-on.** In the admin group → admin. Not in the admin group but in the member group →
  member (a demotion, audited as "Changed a role" with no actor). **The last active admin is never demoted**: they
  stay admin and the service logs a warning with the user id. The count and the change are one database
  transaction, so two admins signing in at the same moment can't both be demoted.
- **In neither group** (with a member group set) the single sign-on is refused: *"Your Authentik account is not in a
  group that may use ICA-MCP. Ask an admin."* Nothing is disabled or deleted, and password sign-in (if the account
  has a password and it is on) still works.
- **No `groups` claim at all** is refused with its own message — *"Authentik did not send any groups. The provider
  needs a groups scope mapping."* — and a warning is logged with the user id only. That is an identity-provider
  setup problem, not a membership one.
- **Invites** (with a member group set) are created with the role the groups give, not the role on the invite, so
  an invited admin who is only in the member group joins as a member. The Users page says so on the invite form and
  next to the role controls.
- **Only an admin group set** keeps the old promote-only behaviour: members of it become admin, and nobody is ever
  demoted or refused because of groups. **Only a member group set** gates sign-in and creates members, but demotes
  nobody (there is no admin group to be in).

**The identity provider's own access policy comes first.** Authentik checks the application's access bindings
before ica-hub ever sees the user, so the application must admit both groups: bind it to both `ica-hub-admins` and
`ica-hub-users`, or keep every admin in the member group too. Someone in a group the application is not bound to is
refused at Authentik ("not authorized to access this application"), and ica-hub gets no callback, no log line and no
refusal code.

Admins must be in the admin group, or they lose admin at their next sign-in. A group name that never appears in the
claim — a typo, or a name the provider's groups mapping filters out — silently matches nobody. To make that visible,
ica-hub remembers, in memory only, the group names of each admin's latest single sign-on (all of them, whatever
they are called, at most 50; never written to the database, the log or the audit log). Settings → Single sign-on
shows only the configured admin and member group names, each marked **Sent** or **Not sent** by your last sign-in —
never the other groups you are in. Saving an admin group you are known not to be in is refused (see The lockout
guard). Only while your groups are unknown (a password-only session, or after a restart) does a save go through with
a "could not be checked" warning.

**Migrating an existing install:** before your first Authentik sign-in with groups configured, change your ICA-MCP
email (Profile, or an admin on the Users page) to match your Authentik email exactly. Otherwise your old account is
not linked, and — because you are in a mapped group — the group rule creates a second, new account for you.

### Turning passwords off

Turn password sign-in off (Settings → Sign-in methods, or `AUTH_LOCAL_LOGIN=false` in the environment) only after
**every** admin has signed in with single sign-on at least once — once they have, their Profile page lists the
provider under Sign-in methods. With password sign-in off: the password form, password invites and the
password-change form disappear everywhere. The bootstrap admin (`ICA_HUB_ADMIN_EMAIL`/`ICA_HUB_ADMIN_PASSWORD`) is
still created on a genuinely empty database, so a fresh install stays reachable, and is skipped once any user
exists. Setting `AUTH_LOCAL_LOGIN=false` together with `OIDC_LINK_BY_EMAIL=false` on an empty database is refused
at startup — the bootstrap admin could never sign in — so keep one of the two on until the first single sign-on.

**Link-by-email trusts the IdP's `email_verified` completely.** With it on, anyone who can present a verified claim
for an existing user's email — including the admin's — signs in as that user the first time. The intended rollout:
link the existing admin once (sign in with single sign-on), then turn linking by email off, unless the IdP truly
verifies email and users cannot change it themselves. With Authentik, check that the email scope mapping's
`email_verified` reflects real verification rather than being hard-coded `true`.

**To change the issuer, client ID or secret later, password sign-in has to be on first** (see The lockout guard
above): turn it back on, make the change, confirm it works, then turn it off again.

### Worked example: Authentik

1. Create an **OAuth2/OpenID provider** and an **application**, both named e.g. `ica-hub`.
2. Provider: client type **confidential**; redirect URI `https://<your host>/auth/callback/upstream` (**strict**);
   scopes `openid email profile` (+ `groups` if you will use the group mapping); signing key **RS256**; subject mode
   **"based on the user's hashed ID"**; turn on **"Include claims in id_token"**. Give the email scope mapping a
   dedicated copy that returns `"email_verified": True` — the default mapping's value depends on Authentik's own
   verification state, see the pitfalls note below.
3. Application: bind access to a household group (or "all users" for a single-admin install). With the group
   mapping, the bindings must admit both `ica-hub-admins` and `ica-hub-users` (bind both, or keep every admin in
   `ica-hub-users` too): Authentik refuses anyone else before ica-hub sees them.
4. Groups (optional, for the group mapping): create the groups `ica-hub-admins` (admins) and `ica-hub-users`
   (everyone who may use ICA-MCP), and bind a **groups scope mapping** to the provider — without one, Authentik sends
   no `groups` claim at all, even though its discovery document lists it. Prefer a dedicated, filtered mapping over
   the shared unfiltered one: least privilege, ICA-MCP only learns about its own groups, not every group the person
   is in. Customization → Property Mappings → Scope Mapping, scope name `groups`, expression:

   ```python
   return {"groups": [g.name for g in user.ak_groups.all() if g.name.startswith("ica-hub-")]}
   ```

   A household admin in both groups then sends `["ica-hub-admins", "ica-hub-users"]`, a member
   `["ica-hub-users"]`. Keep the group names under the `ica-hub-` prefix, or the filter hides them (and a group
   name the claim never carries matches nobody).
5. In ICA-MCP: **Settings → Single sign-on**. Issuer `https://auth.example.com/application/o/ica-hub/` (the
   provider's "OpenID Configuration Issuer", trailing slash included), client ID and secret from the provider, then
   **Test connection**. Authentik's `authorization_endpoint` is `https://auth.example.com/application/o/authorize/` —
   another path on the *same origin* as the issuer, so it passes the "Sign-in page on the issuer's host" check (the
   page's CSP `form-action` allows the issuer's origin). Set **Admin group** `ica-hub-admins` and **Member group**
   `ica-hub-users` if you use them. Then **Save**, sign out, and **Continue with Authentik** (check your email matches
   first, see the migration note under Group mapping). Back on Settings, the page lists the groups your sign-in sent.
6. Invite other household members from the Users page; they accept with single sign-on or a password, depending on
   whether password sign-in is on — or, with the group mapping, just add them to `ica-hub-users` in Authentik: their
   first sign-in creates their account. Only turn password sign-in off once every admin has signed in with single
   sign-on (see Turning passwords off above).

   - **The Authentik user's email must equal the existing ICA-MCP account's email** (case does not matter). If it
     differs, the sign-in is not a link but an attempt to create a new user, which needs an invite — or, with the
     group mapping, **creates a second account**. Without a group the sign-in page answers *"No ICA-MCP account for
     `<email>` — ask an admin for an invite."* Set the Authentik user's email to the ICA-MCP account's email (or the
     other way round) before signing in.
   - **Authentik says "not authorized to access this application"** → the user is in no group bound to the
     application; ica-hub logs nothing in that case (the sign-in never reaches it). Bind the missing group (see
     step 3).
   - **If Authentik sends `email_verified: false` (or leaves it out of the ID token), every OIDC sign-in is
     refused** — linking, invite acceptance and returning users alike; the sign-in page says the Authentik account
     has no verified email address. Fix it in Authentik: check what the email scope mapping returns for
     `email_verified` (Customization → Property Mappings) and that **"Include claims in id_token"** is on; then
     either mark the users' emails as verified there, or — only if every email in that Authentik instance is
     admin-controlled, see the link-by-email warning above — use a custom email scope mapping that returns
     `"email_verified": True`.

### Deploy runbook for this release

For an existing install upgrading to this release (Phase 1.5: roles move to `user.role`, invites, audit log).
Commands assume the systemd layout (`/var/lib/ica-hub`); adapt the paths for Docker.

1. **Back up first**, with the service still running (an online backup is consistent):

   ```bash
   sqlite3 /var/lib/ica-hub/ica-hub.db ".backup '/var/backups/ica-hub-pre-1.5.db'"
   ```

2. **Read-only checks on the backup** (not the live database):
   `sqlite3 -readonly /var/backups/ica-hub-pre-1.5.db`, then:

   - `select role, count(*) from user group by role;` — expect only `admin`, `member`, `user` or NULL. There must
     be **no comma-separated values like `admin,user`**: migration `0003` turns any role other than `admin` and
     `member` into `member` (unless that user's old profile role was admin), so such a user would lose admin.
     Fix the value to `admin` in the live database before deploying.
   - `select client_id, user_id, created_at from oauth_consent;` — the existing Claude client **must have a consent
     row**. `/mcp` now checks the consent on every request, so without one it answers 401 after the deploy and
     Claude has to be reconnected (Settings → Connectors → ICA → Connect).
   - `select count(*) from user_profile where user_id not in (select id from user);` — **must be 0**. Migration
     `0003` deletes those orphaned profiles (and anything only they referenced is gone with them); if it is not 0,
     find out why before deploying.

3. **With OIDC configured**: confirm that Authentik's `authorization_endpoint` has the same origin as
   `OIDC_ISSUER_URL` — `curl -s "${OIDC_ISSUER_URL%/}/.well-known/openid-configuration" | jq -r .authorization_endpoint`.
   The sign-in page's CSP allows form posts only to the issuer's origin, so an IdP that sends the browser to another
   origin (e.g. an internal hostname) would have its redirect blocked.
4. **Deploy** (re-run the release installer, or rsync + `deploy/install.sh`; see above). Migrations run on start.
5. **After the deploy**: in a Claude chat, ask Claude to use the ICA `ping` tool — it must answer now. Check it
   again after Claude's next token refresh (access tokens are short-lived, so trying again the next day is enough):
   a refreshed token must keep working too. If `ping` fails with a 401 loop, reconnect Claude; if it still fails,
   restore the backup with the previous build (see Upgrade above).

### Deploy runbook for 1.6

For an existing install upgrading to this release (first-run setup, settings in the UI, the lockout guard, email
changes). Migration `0005` is purely additive — a new `app_setting` table and a nullable
`user_profile.email_self_changed_at` column — so it carries no data risk of its own, but back up anyway:

1. **Back up first**, same as above:

   ```bash
   sqlite3 /var/lib/ica-hub/ica-hub.db ".backup '/var/backups/ica-hub-pre-1.6.db'"
   ```

2. **Deploy** (the release installer, rsync + `deploy/install.sh`, or `docker compose pull && docker compose up -d`). Migrations run on
   start.
3. **After the deploy**: on an existing install (any user already exists), `/admin/setup` must answer 404 — confirm
   with `curl -o /dev/null -w '%{http_code}\n' https://<your host>/admin/setup`.
4. **Check the admin exists and can sign in**, then remove `ICA_HUB_ADMIN_EMAIL`/`ICA_HUB_ADMIN_PASSWORD` from the
   environment if they're still set — they only ever act on a genuinely empty database, so leaving them set on an
   existing install is harmless day to day, but see the rollback warning below.

**Never roll back to 1.5 while `ICA_HUB_ADMIN_*` is still set, if an admin has changed their email since the
upgrade.** The 1.5 build recreates the bootstrap admin from those two variables each time it starts (not just on
an empty database, as 1.6 does), so restoring it would recreate an admin at the old email address alongside — or
instead of — the one with the changed email. Remove `ICA_HUB_ADMIN_*` before any rollback, or avoid rolling back
once an email has changed.

Rollback otherwise (no admin email changed, or `ICA_HUB_ADMIN_*` already removed): the previous build runs on the
migrated database unchanged — it simply ignores the new `app_setting` table and the new column. Because 1.5 ignores
`app_setting`, any single sign-on configured through the UI (Settings, or first-run setup's "Set up single sign-on
first") is gone after the rollback: OIDC-only users can no longer sign in, and a password-off setting saved in the UI is
ignored, so password sign-in is back on unless `AUTH_LOCAL_LOGIN=false` is set.

## Users, invites and the audit log

### Invites

An admin invites a household member from the Users page with an email and a role. The invite link
(`/admin/invite/<token>`) is valid for **7 days** and is **single-use**; only its SHA-256 hash is stored in the
database, never the plaintext token. The plaintext link is shown to the admin only **once**, for 15 minutes after
it is made (long enough to copy it or let someone scan a QR code from the admin's phone) — after that,
**Renew link** makes a fresh link with a fresh 7-day expiry, and the old link stops working at once. Revoking a
pending invite has the same effect on the old link.

### Roles

Two roles: `admin` and `member`. An admin manages users, invites and the audit log; a member manages only their own
profile, sessions, connected apps and ICA link. **The last remaining admin cannot be demoted, disabled or
removed** — ica-hub refuses the change and the Users page explains why, so the household is never left with no
admin.
With the single sign-on group mapping (see Group mapping), roles also follow the identity provider's groups at every
single sign-on; a change you make on the Users page lasts until that person's next single sign-on.

### Changing an email

Admins change any user's email from the Users page (**Change email**). Everyone can change their own email from
Profile — the current password is asked for first, if the account has one. Neither path sends an email: the new
address works for sign-in from that point on.

A member's own change shows **"Email not confirmed"** on the Users page until an admin saves that address there
(even re-saving the same one confirms it) — until then, single sign-on cannot link to it by email. A change an
admin makes, whether for themselves or for someone else, is confirmed immediately.

Audit: `user.email_changed` records `from` and `to`. `settings.changed`'s `setting` value now also covers `oidc`,
`sign_in_methods` and `setup` (first-run setup); its `changes` list always holds field/key names only, never
values.

### Audit log

Every security-relevant action (sign-in and sign-in failures, session and app revocations, invites, role changes,
disabling/enabling/removing a user, ICA connect/disconnect, settings changes) is recorded with who did it, when,
from where and the outcome. It **never stores secrets or ICA data** — each action has its own allow-listed, capped
set of detail fields (e.g. an email, a role, a client name — never a password, token or ICA response body). Events
older than **365 days** are pruned daily. Admins see the full log, filterable by user/action/date, on the Activity
page; members see only their own events, on their Profile page.

A failed audit write never blocks the action it was recording — it is logged as `audit write failed` (warn) and the
request continues normally.

## Security headers

Every response carries a strict Content-Security-Policy plus a full set of security headers, set by ica-hub itself
— not the reverse proxy:

- `Content-Security-Policy: default-src 'self'; script-src 'self' 'nonce-<per-request>'; style-src 'self'; img-src
  'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'; object-src 'none'`
  — no inline script or style is ever allowed; every `<script>` carries the per-request nonce. The consent page and
  the sign-in page (while an OAuth authorize is pending, or showing a "Continue with `<IdP>`" button) extend
  `form-action` with the destination's origin, because Chromium enforces `form-action` on the redirect that follows
  a form POST, not only on the POST itself.
- `Strict-Transport-Security: max-age=31536000` — sent only when `ICA_HUB_URL` is `https://…` (never for a loopback
  `http://` dev instance).
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `Permissions-Policy: camera=(), microphone=(), geolocation=()`.
- `Cross-Origin-Opener-Policy: same-origin` everywhere except the pages of the OAuth connect flow
  (`/auth/oauth2/*`, `/auth/callback/*`, `/admin/login`, `/admin/login/oidc`, `/admin/consent`, `/admin/invite/*`),
  which send `unsafe-none`: claude.ai may run its web Connect in a popup and wait for the result through
  `window.opener`, which `same-origin` on any page of the flow would sever.

**At the reverse proxy: do not add or override `Content-Security-Policy`.** ica-hub's header carries a fresh nonce
on every request; a proxy-level CSP — even a well-meant, permissive one — either fights that nonce or replaces it
outright, breaking every page that has one. Likewise, don't strip or rewrite `Set-Cookie` attributes (`Secure`,
`HttpOnly`, `SameSite`); some proxies do this by default for compatibility with old clients, which would weaken the
session cookie.

**Only a narrow allow-list under `/auth` and `/.well-known` is public.** ica-hub answers 404 for anything under
those two paths that isn't the OAuth authorization-server/OIDC discovery documents, JWKS, the OAuth
authorize/token/register/userinfo/revoke/introspect/end-session endpoints, or the OIDC callback
(`/auth/callback/upstream`). Everything else Better Auth exposes — sign-in/up, the admin plugin, session and
account management, password change — is reachable only server-side, from the admin UI's own request handlers,
never directly over HTTP, so a future Better Auth upgrade that adds new endpoints is closed by default.

## Docker (container)

The image is `ghcr.io/jonasthim/ica-mcp`, for linux/amd64 and linux/arm64 (a Raspberry Pi
4 or 5 with a 64-bit OS runs it). `compose.yaml` uses `:latest`; pin a release as
described under Docker image (quick path). To build the image from a checkout instead,
uncomment `build: .` in `compose.yaml` and run `docker compose up -d --build`.

1. Copy `compose.yaml`, set the required environment variables (`ICA_HUB_URL`,
   `ICA_HUB_MASTER_KEY`, `ICA_HUB_AUTH_SECRET`, plus any optional ones you need) in a
   `.env` file next to it or in your process manager's secret store.
2. `docker compose up -d`.
   `compose.yaml` sets `stop_grace_period: 30s`: on SIGTERM ica-hub finishes in-flight requests and any ICA token
   refresh still running (ICA rotates the refresh token on every refresh; a refresh cut off before the new token is
   stored forces a BankID reconnect), which takes up to 20 s. Docker's default is 10 s, so with plain `docker run`
   pass `--stop-timeout 30` (and `docker stop -t 30` when stopping it by hand). The systemd unit sets
   `TimeoutStopSec=30` for the same reason.
3. Database migrations run automatically each time the container starts (`openDb` runs
   `drizzle-orm`'s migrator before the server listens) — there is no separate migrate
   step for a deploy.
4. Check `curl https://<ICA_HUB_URL>/healthz` —
   `{"ok":true,"version":"0.2.0","db":"ok","jwks":"ok"}` (with your release's version) means
   the app is up, the database is reachable and it can resolve its own JWKS. `jwks:
   "unreachable"` with `ok: true` is a warning, not an outage: some reverse-proxy/tunnel
   setups block a service from calling back into its own public hostname (hairpin NAT).
   It does not affect the app (/mcp verifies access tokens in process, against the keys in
   the database); if it doesn't clear on its own, allow hairpin traffic for
   `ICA_HUB_URL`'s host on the proxy.

## Monitoring

- `GET /healthz` — liveness/readiness, no auth, no host check (so a load balancer can
  probe it by IP). `ok: false` (HTTP 503) means the database check failed.
- `GET /metrics` — Prometheus text exposition format, unauthenticated. Served unless
  `METRICS_ENABLED=false`. It's not meant to be public: block it at the public edge (the
  reverse proxy, or the LXC's firewall for the bare-systemd setup) and scrape it
  internally, rather than disabling it, unless you have no scraper for it at all.
- Every `/mcp` request logs `mcp request finish` (info: `method`, `tool`, `status`, `ms`),
  preceded by `mcp request start` once the token is accepted. A refused request also logs
  `mcp request rejected` (warn) with a `reason` — `missing_token`, `invalid_token`,
  `revoked` (the app's access was revoked, or the user disabled/removed),
  `insufficient_scope` or `jwks_unavailable` (the signing keys could not be read: HTTP 500,
  with an error line) — plus `clientId`/`userId` when known. Tokens and tool arguments are
  never logged.
- `audit write failed` (warn) in the application log means one audit event could not be
  written to the database; the action it was recording still completed normally (audit
  writes never block the request) — see Users, invites and the audit log above.

### ICA session metrics and alerts

`/metrics` exposes, per ICA account: `ica_hub_ica_session_healthy` and
`ica_hub_ica_session_expires_timestamp_seconds` (`kind` = `web` | `app`), the app token's
`ica_hub_ica_app_last_refresh_timestamp_seconds` and `ica_hub_ica_app_window_end_timestamp_seconds`, and the web
session's `ica_hub_ica_web_login_state`, the purchase-history flag `ica_hub_ica_purchase_history_available` and
`ica_hub_ica_login_state_checked_timestamp_seconds`. All are read from the database at scrape time, so a
disconnected account's series disappear at once. Seconds left or elapsed are `x - time()` / `time() - x` in PromQL.
Two label-free series always exist: `ica_hub_ica_sessions{kind,health}` (counts per `app`/`web` and `ok`, `error`
or `reconnect`, zeros included) and `ica_hub_ica_app_upkeep_enabled`.

The `account` label is never an id: it is the first 12 hex digits of the SHA-256 of `ica-hub:` + ica-hub's own
random ICA-account uuid (the `account` field of log lines). To find the label of a logged account:
`printf 'ica-hub:%s' <uuid> | sha256sum | cut -c1-12`. No ICA id, user id, email or name is exported.

ICA's app access token lives 15 minutes and, during the first 4 hours after the BankID connect, is capped at
connect + 4 h; the first refresh after that returns a 30-day token. Like the ICA app, ica-hub refreshes every
connected app session about every 10 minutes (8–10 minutes after the last refresh, spread per session), whether
anyone uses it or not, and also on use when less than a minute is left; after a failed refresh it waits 2, 4, 8 …
minutes (at most an hour) before trying that session again. Sessions that need a BankID reconnect are left alone.
The upkeep goes through the same single-flight refresh as tool calls and never spends a user's ICA rate limit.
`ICA_HUB_APP_UPKEEP=on-demand` turns it off (see App-token upkeep above).
Purchase history needs a fresh web BankID login: it lapses on its own (observed: about 30 minutes to 4 hours) and
at once when app access is connected; the gauge shows the last value ICA reported, with its time.

Alert rules: `deploy/prometheus/ica-hub-alerts.yml` (session unhealthy for an hour, app token expired for half an
hour, a past-window app token not yet expired but expiring within 12 h, a healthy app session not refreshed for 45
minutes, web session ending within a week, metrics absent). A dead app session pages twice (unhealthy, and token
expired), not three times. Each rule also fires when the gauge it reads is missing although sessions exist, so an
empty result is never mistaken for health; the description says so only for that case. The three app-token rules
apply only while the upkeep runs (see App-token upkeep above). Check them with
`promtool check rules deploy/prometheus/ica-hub-alerts.yml` (expect `SUCCESS: 6 rules found`) and
`promtool test rules deploy/prometheus/ica-hub-alerts.test.yml`.

**The rules assume Prometheus scrapes ica-hub's own `/metrics`.** A node-exporter job on the same host does not
count: the `ica_hub_*` series come only from the app's port (`PORT`, default 3000). Add a scrape job for
`http://<host>:<PORT>/metrics` before loading the rules, and check that the series are visible in the datasource the
rules run against (Prometheus itself, or Thanos/Mimir if you evaluate there). Otherwise `IcaHubDown` fires within
minutes — about missing monitoring, not about ica-hub. The rules are plain PromQL, so they can also be imported into
Grafana-managed alerting instead of a Prometheus `rule_files:` entry.

## Debugging the admin UI

Admin requests (`/admin/...`) must go through the public **https** hostname. The admin
session cookie that Better Auth sets is `Secure`, so a client talking plain http never
sends it back: `curl http://127.0.0.1:3000/admin/login` followed by a request to
`/admin/ica` silently drops the cookie and you land on the login page again, with no
error. Use the https hostname instead, with a cookie jar:

```bash
curl -c jar -b jar -d 'email=…&password=…&oauth_query=' -H 'Origin: https://ica.example.com' \
  https://ica.example.com/admin/login
curl -b jar https://ica.example.com/admin/ica
```

This also works from inside the container or LXC (`curl https://<public host>/…`), as long
as the host can reach its own public hostname (see the hairpin note under Docker).
`/healthz` and `/metrics` have no session and can be curled over plain http locally.

## Backups

Back up the database on whatever schedule matches your tolerance for data loss — it holds
households, linked ICA sessions (encrypted), OAuth clients/tokens and admin accounts.

Don't copy `ica-hub.db` and its `-wal`/`-shm` files while the service is running: a copy
taken mid-write can be inconsistent. Take an online snapshot instead, either with the
`sqlite3` CLI (`.backup`) as shown for the systemd setup, or with `VACUUM INTO`, which
also works in the container (the image has no `sqlite3` CLI, but has better-sqlite3):

```bash
docker compose exec ica-hub node -e \
  "require('better-sqlite3')('/data/ica-hub.db').exec(\"VACUUM INTO '/data/backup-$(date +%F).db'\")"
```

Then move the snapshot off the host with your normal backup tooling. Stopping the
service first and copying the whole data directory is also safe.

**`ICA_HUB_MASTER_KEY` is not in `/data`** — it's an environment variable, sourced from
wherever you deployed it from (`.env`, compose override, secret store). Back it up
separately and keep it with the `/data` backup: a `/data` restore without the matching
master key cannot decrypt any stored ICA session, and a master key without a matching
`/data` backup decrypts nothing.

## Upgrade (Docker)

Back up first (see Backups). With `:latest`:

```bash
docker compose pull && docker compose up -d
```

With a pinned tag, change the tag in `compose.yaml` (e.g. `:0.2.0` to `:0.3.0`), then run
the same command. The release notes and CHANGELOG.md list what changed.

Migrations run automatically on the new container's start, before it starts accepting
requests. Roll back by pulling the previous image tag; if a migration in the new version
is not backward-compatible with the old code, check the release notes before rolling
back a running database.

**This release's migrations (`0003_roles-to-user`, `0004_phase1-5-users-audit-invites`)
run automatically and atomically, but are not backward-compatible**: `0004` drops the
old `user_profile.role` column entirely, so an older image queries a column that no
longer exists and cannot start against a migrated database. **Take a backup first** (see
Backups below) — a rollback for this release means restoring that backup together with
the previous image tag, not just pulling an older tag against the already-migrated
database.

## Upgrade (release installer)

Re-run the installer as root; with no `ICA_HUB_VERSION` it installs the latest release:

```bash
curl -fsSL https://github.com/jonasthim/ica-mcp/releases/latest/download/install.sh | bash
```

`/etc/ica-hub/env` is kept as it is; migrations run on the restarted service's start, as in
the container. Back up the database first, and read the release notes for migrations that
cannot be rolled back.

## Publishing a release (maintainer)

1. Set `version` in `package.json` and add a CHANGELOG.md entry, commit.
2. Tag and push: `git tag v<version> && git push origin v<version>`. The tag must equal
   `v` + the `package.json` version, or the release workflow stops.
3. `.github/workflows/release.yml` runs the CI gate (lint, typecheck, test, build, docker
   build), then pushes the multi-arch image to GHCR and creates the GitHub release with
   `ica-mcp-<version>.tar.gz`, `install.sh` and `SHA256SUMS` and generated notes.
4. **First release only:** GHCR creates the `ica-mcp` package as private. Once, as the
   repository owner, open the package on GitHub (profile, Packages, `ica-mcp`, Package
   settings) and change its visibility to **Public**, or `docker pull` fails for everyone
   else. Later releases keep that setting.
