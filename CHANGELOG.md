# Changelog

All notable changes to ica-mcp (the `ica-hub` package) are listed here. Versions follow [semantic versioning](https://semver.org/).

## 0.2.2 — 2026-10-01

### Fixed
- Handla: an AWS WAF stop is no longer treated as "still preparing". Handla sits behind CloudFront + AWS WAF with a
  per-IP rate rule (about 7 searches in about 15 s trips it for many minutes). A WAF challenge (202 with
  `x-amzn-waf-action`) or a CloudFront 403 "Request blocked" is now reported at once as Handla's bot protection
  blocking price lookups, with the time left, instead of being polled for about 7 s (which likely kept the rule
  tripped). The `tool call` log line carries `reason: 'blocked'`.
- A plain 202 without a WAF header is retried only twice (0.5 s, then 1 s; `Retry-After` honoured up to 2 s).

### Added
- Handla circuit breaker, one per process: after a WAF stop every uncached Handla call fails at once for a cooldown (10 min,
  doubled per failed probe up to 60 min) without contacting Handla or spending the user's ICA budget; then exactly one
  probe goes through. `ICA_HUB_HANDLA_COOLDOWN_MINUTES`. Breaker changes are logged at warn.
- Handla pacing: one queue for the process, request starts at least 2.5 s apart, at most 10 waiting
  (`ICA_HUB_HANDLA_MIN_GAP_MS`).
- Handla cache: successful product searches for 15 min and store searches for 24 h, 500 entries
  (`ICA_HUB_HANDLA_CACHE_MINUTES`; 0 turns it off). A cache hit is served even while the breaker is open and still spends one ICA budget token.
- `get_session_status` reports `handla: { blocked, retryInMinutes? }`.

## 0.2.1 — 2026-10-01

### Fixed
- Handla product search: when Handla answers 202 ("still preparing"), the hub now polls for up to about 7 s
  (honouring `Retry-After`, capped at 3 s per wait) instead of giving up after one 0.5 s retry. Price comparisons
  across several stores failed on the second store.
- Logs: failed tool calls now carry the failure `reason` (e.g. `not-ready`, `rate-limited`, `server-error`) and the
  HTTP status in the `tool call` line, so an ICA or Handla refusal can be told apart afterwards. No ICA content is logged.

## 0.2.0

The first release. Published as a multi-arch Docker image (`ghcr.io/jonasthim/ica-mcp`, linux/amd64 and
linux/arm64) and as a source tarball with `install.sh` for Debian 13 hosts and LXCs.

- **MCP connector for Claude** with its own OAuth 2.1 authorization server (discovery, dynamic client registration,
  PKCE, refresh) and a consent page.
- **BankID connect**: links a household member's ICA account by relaying ICA's BankID QR login, for both the ICA web
  session and ICA app access. ICA sessions and tokens are stored encrypted.
- **Shopping lists**: read lists and items, and write to them (add, check off, un-check, remove, create a list),
  with writes behind `ICA_HUB_LIST_WRITES`.
- **Offers, stores and bonus**: this week's offers at a store, favourite stores with opening hours, Stammis bonus.
- **Products**: product lookup by barcode and ICA catalogue search.
- **Purchase history**: months with purchases and their totals, and one month's receipts.
- **Handla prices**: find stores that sell online for a postcode and search a store's online prices.
- **OIDC sign-in** (e.g. Authentik) with group-to-role mapping, configurable in the admin UI or the environment.
- **Admin UI**: mobile-first, with household users, invites and roles, connected apps, an audit log, ICA
  diagnostics and a lockout guard for single sign-on changes.
- **Monitoring and alerts**: `/healthz`, Prometheus `/metrics` including ICA session metrics, and example alert
  rules in `deploy/prometheus`.
