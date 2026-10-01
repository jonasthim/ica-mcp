# Connecting Claude

ica-hub is a remote MCP server with its own OAuth sign-in. You add it to Claude once, on claude.ai in a web
browser; the connector then also shows up in the Claude mobile and desktop apps on the same account.

Each household member connects with their own Claude account and their own ica-hub account (an admin creates it).

## 1. Add the connector (claude.ai, web)

1. Open claude.ai → **Settings** → **Connectors** → **Add custom connector**.
2. Name: anything, e.g. `ICA`. URL: `https://<your ica-hub host>/mcp` (for example `https://ica.example.com/mcp`).
   Leave the advanced OAuth client settings empty: Claude registers itself with ica-hub.
3. Click **Add**, then **Connect**. Claude sends you to ica-hub.

## 2. Sign in to ica-hub

The ica-hub **Sign in** page asks for the email and password of your ica-hub account (or shows a
**Continue with …** button if the admin set up single sign-on). This is ica-hub's own account, not your ICA or Claude
login.

## 3. Allow access

The **consent** page shows:

- the app asking for access (the name Claude registered with),
- the permissions (scopes) it asks for, typically `mcp` and `offline_access`,
- **"The access code will be sent to: …"**: the host that receives the authorization code. For Claude this is
  `claude.ai` (or `claude.com`). If it shows any other host, click **Deny**.
- a note that the app registered itself and has not been verified. That is expected for Claude unless your admin
  added its client id to `ICA_HUB_TRUSTED_CLIENT_IDS`.

Click **Allow**. You're sent back to claude.ai and the connector shows as connected.

Check it in a chat: ask Claude "Which ICA tools do you have?", or "Can ica-hub reach my ICA account?" (the
`get_session_status` tool). Before the ICA tools can do anything, connect your ICA account on ica-hub's **ICA
account** page (`/admin/ica`): **Connect with BankID**, then **Connect app access with BankID**.

## 4. Use it on mobile

Open the Claude app on iOS or Android with the same Claude account. The connector is already there; no second
sign-in is needed. If the app asks you to reconnect, it takes you through the same sign-in and consent pages.

## What you can ask

Ask in plain Swedish or English; Claude picks the tool. The tools, by group:

| Group | Tools | Notes |
| --- | --- | --- |
| Shopping lists, read | `list_shopping_lists`, `get_shopping_list` | The household's shared lists and their items. |
| Shopping lists, write | `add_list_items`, `check_list_items`, `uncheck_list_items`, `remove_list_items`, `create_shopping_list` | Only when the operator enables them with `ICA_HUB_LIST_WRITES` (`all`, or a comma-separated list of hub user emails); off by default. Claude asks before removing items. |
| Offers, stores, bonus, products | `get_store_offers`, `get_favorite_stores`, `get_bonus`, `lookup_product` | This week's offers, favourite stores with today's opening hours, your Stammis bonus, a product by barcode. |
| Catalogue search | `search_articles` | ICA's article names, as the ICA app suggests them. |
| Purchase history | `get_purchase_months`, `get_purchases` | Monthly totals and one month's receipts (date, store, total, discount; no line items). Needs a **fresh web BankID login**: plan on about 30 minutes after it. |
| Handla | `handla_find_stores`, `handla_search_products` | Stores that sell online for a postcode, and a store's online prices. No cart and no delivery slots. |
| Connection status | `get_session_status` | Whether ica-hub can reach your ICA account right now, and whether purchase history is available. |

Examples: "What's on our shopping list?", "Add milk and 6 eggs", "What's on offer with kyckling at our store?", "How
much bonus do I have?", "What did I spend at ICA in August?".

## When Claude says to reconnect

ica-hub keeps two ICA sessions for you: the **web** session (catalogue search, purchase history) and **app access**
(lists, stores, offers, bonus, products). When one needs you, Claude's answer names the button to press on
`https://<your ica-hub host>/admin/ica`:

| Claude says | Button on /admin/ica |
| --- | --- |
| "No ICA account is connected …" | **Connect with BankID**, then **Connect app access with BankID** |
| "The ICA web session has ended …" | **Reconnect with BankID** (web reconnect) |
| "ICA app access is not connected …" / "… has ended" | **Connect app access with BankID** / **Reconnect app access with BankID** |
| "ICA shows purchase history only for a while after a web BankID login …" | **Reconnect with BankID** for a fresh web BankID login, then ask again within about 30 minutes |
| "ICA refused purchase history although the session reports the right login level …" | **Reconnect with BankID** once; if it keeps happening, tell the hub operator |

Purchase history ends on its own, somewhere between about half an hour and a few hours after the web BankID login,
and at once when you connect app access with BankID. So when you need both, reconnect app access first and the web
session last.

Messages that say "try again" need no reconnect: ICA did not answer or is limiting requests, ica-hub's per-user limit
on ICA calls is used up (the message says for how many seconds), Handla is still preparing results, Handla's bot
protection is blocking price lookups for a while (the message says for about how many minutes; ICA lists, offers and
bonus still work), Handla lookups are paced to a few per minute (the message says when to try the rest; earlier
results are cached, and each Handla answer carries `asOf`, when Handla was asked), or ica-hub is restarting.

## Disconnecting Claude

On ica-hub's **Apps** page (`/admin/apps`, **Apps** in the navigation), **Connected apps** lists every app you
allowed, including Claude, with when it was first and last used. **Revoke** stops that app at once — Claude's next
request answers 401 and it has to ask for your permission again before it can use ica-hub for you.

**Sign out everywhere** (on your Profile page, under Sessions) ends every browser session for your account *and*
disconnects Claude in the same action, for the same reason: both are ways someone else could keep using your
account if a device is lost or a token leaks. Claude then asks for consent again the next time it's used.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Claude keeps going back to sign-in, or `/mcp` answers 401 in a loop | `ICA_HUB_URL` doesn't match the public URL Claude uses (other host, `http` vs `https`, a trailing slash or path) | Set `ICA_HUB_URL` to the exact public origin, e.g. `https://ica.example.com`, and restart. |
| Claude refuses to add the connector or says it can't connect | The `resource` in `https://<host>/.well-known/oauth-protected-resource/mcp` isn't exactly `https://<host>/mcp` (same cause as above), or the hostname has only an IPv6 (AAAA) record | Fix `ICA_HUB_URL`; make sure the hostname has an IPv4 A record. |
| The ica-hub sign-in page never loads, or you land on another login screen first | An SSO / forward-auth gate (Authentik, Authelia, Pangolin auth, …) in front of the ica-hub vhost | Turn authentication off for this vhost on the reverse proxy; ica-hub does its own. See `docs/deployment.md`. |
| "Sign-in failed" when you already had an old ica-hub session in that browser | A bug in releases before this one: sign-in with an existing or stale session cookie failed in production | Fixed in this release; upgrade. As a workaround on an old release, clear the cookies for the ica-hub host. |
| Claude doesn't list a tool that ica-hub has (e.g. after an ica-hub update) | Claude cached the tool list when the connector was added | Remove the connector in claude.ai and add it again. |
| "Too many sign-in attempts" | The admin login rate limit (10 attempts per 15 minutes, per IP and per email) | Wait 15 minutes. If everyone is limited at once, `TRUST_PROXY` is not set correctly (see `docs/deployment.md`). |
