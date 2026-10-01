# Changelog

All notable changes to ica-mcp (the `ica-hub` package) are listed here. Versions follow [semantic versioning](https://semver.org/).

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
