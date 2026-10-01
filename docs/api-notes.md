# ICA API notes

What is known about ICA's private APIs, from the Phase 0 spike and the live hub (`/admin/ica` and
`/admin/ica/diagnostics`). Last updated 2026-09-30. Shapes are keys and types only; no values, no personal data.

## Decisions

| Question | Decision / status |
| --- | --- |
| Can the hub get ICA **app** tokens via BankID? | **Yes.** The BankID relay through the ICA app's DCR + PKCE client worked on the first try (2026-09-29). |
| Web vs app endpoint coverage | Web bearer: `shopping-list` and `shoppinglistarticlesearch` only. App bearer: every `sverige/digx/mobile/*` product probed (lists, stores, offers, bonus, products). Purchase history: www cookie session only. The hub needs both sessions. |
| Purchase history | Requires a fresh web BankID login (`loginState` 2). At `loginState` 1 it answers an empty 403. `loginState` 2 lasted between about 32 min and 3 h 49 min in the live runs, and an app BankID login drops it at once (see Session lifetime). Receipt headers only: no line items. |
| Shopping list identity | Web and app list ids are different id spaces (web: UUID, app: integer + `offlineId`). Compare households by `householdId`, never by list id. |
| Handla login, cart, slots | _Pending_ (Phase 4) — spikes not run yet. Phase 2 ships only the anonymous store search and online prices. |
| Second account and shared list | _Pending_ — not run yet. |
| App token lifetime | Access token 15 min, capped at connect + 4 h during the first window; after the first refresh past that window it lasts 30 days. The token is opaque (not a JWT). |
| ICA person id | `customerId` in `/api/user/information` is per person, not per household. |

## Login (BankID QR relay)

### Web flow (www.ica.se)

Verified live 2026-09-29 through the server-side relay (client `ica.se`, `prompt=login`,
`redirect_uri=https://www.ica.se/logga-in/sso/callback`): authorize → `icase-bankid-qr` start → `/wait` polling →
`/launch` → form1 → redirect chain → www.ica.se sets `thSessionId`.

- The `/wait` response carries an **autostart token**: the "Open BankID on this device" link works on a phone.
- The `thSessionId` cookie is issued with an expiry about **89 days** out.
- `GET www.ica.se/api/user/information` (keys include `accessToken`, `loginState`) answers 200 with `loginState` 2
  right after the scan.

### App flow (ICA app client)

Verified live 2026-09-29: the BankID relay through the ICA app's dynamic client registration + PKCE client
(`redirect_uri=icacurity://app`) worked on the first try, with a desktop Chrome user agent.

- Token response: `access_token` with `expires_in` **900** s, plus a `refresh_token`.
- The hub refreshes before use when less than 60 s is left, and an upkeep refreshes every connected app session about every 10 minutes, like the ICA app (`ICA_HUB_APP_UPKEEP=on-demand` turns the upkeep off).
- Access-token lifetime: 15 min (`expires_in` 900). During the first window each refresh is capped at connect + 4 h;
  after the first refresh past that window, the new access token lasts **30 days**.
- The app access token is **opaque** (45 characters, not a JWT): it carries no claims, so the hub cannot read an
  identity from it.

## Session lifetime

### Web `loginState` decay

`loginState` on `/api/user/information` drops from 2 ("fresh" BankID) to 1 some time after the scan, while the cookie
session itself stays valid:

| Time after the web BankID scan | `loginState` | Purchase history |
| --- | --- | --- |
| right after | 2 | 200 |
| +15.5 min | 2 | 200 |
| about +26 min (a later capture) | 1 | **403**, empty body |
| after a new web BankID login | 2 | 200 |

At `loginState` 1, `www.ica.se/api/cpa/purchases/historical/me/*` answers 403 with an empty body; a fresh web BankID
login restores `loginState` 2 and 200.

Session facts (live, 2026-09-30):

- Web `loginState` **2** is needed for `/api/cpa`. At `loginState` 1 the endpoint answers an **empty 403**.
- The elevation decays on its own, somewhere between about **32 min and 3 h 49 min** after the web BankID scan in
  the timed live runs (the "+26 min" row above was only approximately timed), so plan on about 30 minutes. An **app BankID login drops it at once** (to 1), so connect app access
  first and do the web BankID login last.
- Timing trap: a diagnostics run a few seconds before the BankID scan completed still shows 403. Compare the log
  time with the web session's connect time.
- The app access token lasts **15 min**, capped at **connect + 4 h** inside the first window. After the first
  refresh past that window it lasts **30 days**.
- `customerId` (a number in `/api/user/information`) is **per person**, not per household.
- The app access token is **opaque**: no JWT, no claims.

Reconnecting the web session does not disturb the app session: the two flows use separate cookie jars and tokens.

## Endpoint matrix

Verified 2026-09-29 from `/admin/ica/diagnostics`. Gateway = `https://apimgw-pub.ica.se/sverige/digx/`.

| Endpoint | Web bearer | App bearer | Top-level shape (keys) |
| --- | --- | --- | --- |
| gateway `shopping-list/v1/api/list/all` | **200** | not probed | list objects with a UUID `id` and `householdId` |
| gateway `shoppinglistarticlesearch/v1/search?query=<text>` | **200** | not probed | `documents` (see Element shapes) |
| gateway `mobile/shoppinglistservice/v1/shoppinglists` | 403 (900908) | **200** | list objects with an integer `id` and `offlineId`, each with rows |
| gateway `mobile/storeservice/v1/favorites` | 403 (900908) | **200** | `favoriteStores`, `visitedStores` |
| gateway `mobile/storeservice/v1/stores/{id}` | 403 (900908) | **200** | includes `openingHours` (see Element shapes) |
| gateway `mobile/offerservice/v1/offersdiscounts/{storeId}` | 403 (900908) | **200** | `offers` (85 in the capture), `discounts` (empty) |
| gateway `mobile/bonusservice/v1/bonus/current` | 403 (900908) | **200** | includes `vouchers`, `accountBalance` (see Element shapes) |
| gateway `mobile/productservice/v1/product/{ean}` | 403 (900908) | **200** | not recorded |
| www `/api/user/information` | cookie session: **200** | — | includes `accessToken`, `loginState`, `customerId` (see Element shapes) |
| www `/api/cpa/purchases/historical/me/monthsummaries` | cookie session: 200 at `loginState` 2, 403 at 1 | — | `monthSummaries` (see Element shapes) |
| www `/api/cpa/purchases/historical/me/byyearmonth/<yyyy-mm>` | cookie session: 200 at `loginState` 2, 403 at 1 | — | transaction headers, no line items (see Element shapes) |

"Not recorded" means the live run captured the status but no key list was written down; `/admin/ica/diagnostics`
shows each response's keys and value types (never values) and is the place to capture them.

**The 900908 pattern:** with the web bearer, every `sverige/digx/mobile/*` call answers HTTP 403 with the WSO2 API
manager code `900908` "Resource forbidden". The web bearer is valid for the web API products but is not subscribed
to the mobile ones; the app bearer is.

## Shopping lists

- Web API (`shopping-list/v1/api/list/all`, web bearer): list ids are **UUIDs**, and each list carries `householdId`.
- App API (`mobile/shoppinglistservice/v1/shoppinglists`, app bearer): list ids are **integers**, plus `offlineId`.
- The two id spaces differ, so the same list cannot be matched by id across them. Household comparison uses
  `householdId`.
- Whether a list shared with a second account shows up with the same `householdId` there: _pending_ (second account
  not run yet).

## Stores

App bearer: `mobile/storeservice/v1/favorites` (keys `favoriteStores`, `visitedStores`) and
`mobile/storeservice/v1/stores/{id}` both answer 200. The web bearer gets 403 900908.

## Offers

App bearer: `mobile/offerservice/v1/offersdiscounts/{storeId}` answers 200 with `offers` (85 in the capture) and an
empty `discounts`. The store id comes from the favourites call.

## Products

App bearer: `mobile/productservice/v1/product/{ean}` answers 200. The web bearer gets 403 900908.

## Bonus

App bearer: `mobile/bonusservice/v1/bonus/current` answers 200. The web bearer gets 403 900908.

## Article search

Web bearer: `shoppinglistarticlesearch/v1/search?query=<text>` answers 200.

## Purchase history

Cookie session on www.ica.se: `monthsummaries` and `byyearmonth/<yyyy-mm>` answer 200 only while `loginState` is 2;
at `loginState` 1 they answer 403 with an empty body (see Session lifetime). No app endpoint for receipts is known yet.

- **No line items** at this endpoint: a transaction is a flat receipt header (store, date, value, discounts). The
  array key holding the transactions was not captured; the hub accepts `transactions` or a bare array.
- The channel key is spelled **`transactionChanel`** (sic, one n).
- Transactions carry no customer field; the only person id is `customerId` in `/api/user/information`.

## Element shapes (live capture 2026-09-30)

Captured from `/admin/ica/diagnostics` on the live hub (reviewed clean: keys and types only, no values). First
element of each array unless noted. Copied verbatim from the capture.

**List row, web** (`shopping-list/v1/api/list/all`, `[0].rows[0]`):

```
object{id: string, text: string, isStriked: boolean, order: number, quantity: null, article: object{id: number, name: null, ean: null, group: object{id: number, name: null}, extendedGroup: object{id: number, name: null}}, recipe: null, recipes: array[0], offer: null, created: string, createdBy: string, updated: string, updatedBy: string, shoppingListRowId: number, multiple: number, rowType: null, ingredientGroup: number, hasOverridingComment: null, status: null, storeId: null, segment: null}
```

**List row, mobile** (`mobile/shoppinglistservice/v1/shoppinglists`, `shoppingLists[0].rows[0]`):

```
object{id: number, productName: string, sourceId: number, isStrikedOver: boolean, recipes: array[0], internalOrder: number, articleGroupId: number, articleGroupIdExtended: number, latestChange: string, offlineId: string}
```

The captured row had no quantity. Rows written with `quantity` and `unit` return them on the next read (verified with
the list write tools, 2026-09-30).

**Article search** (`shoppinglistarticlesearch/v1/search`, `documents[0]`; the capture log truncated it at 500
characters):

```
object{_id: string, id: number, name: string, pluralName: string, alternativeSpelling: string, productEan: string, storeArticleGroupId: number, expandedArticleGroupName: string, expandedArticleGroupId: number, articleGroupName: string, articleGroupId: number, status: number, latestChange: string, maxiFormatCategoryId: string, maxiFormatCategoryName: string, kvantumFormatCategoryId: string, kvantumFormatCategoryName: string, supermarketFormatCategoryId: string, supermarketFormatCategoryName: stri… (truncated at 500)
```

**Store detail, opening hours** (`mobile/storeservice/v1/stores/{id}`):

```
openingHours.today: string; regularHours[0] / specialHours[0]: object{title: string, hours: string}
```

**Offer `parsedMechanics`** (`mobile/offerservice/v1/offersdiscounts/{storeId}`, `offers[0].parsedMechanics`):

```
object{type: string, quantity: number, unitSign: string, value1: string, value2: string, value3: string, value4: string}
```

**Offer `category`** (`offers[0].category`):

```
object{articleGroupName: string, articleGroupId: number, expandedArticleGroupName: string, expandedArticleGroupId: number}
```

**Bonus `vouchers.used`** (`mobile/bonusservice/v1/bonus/current`, `vouchers.used[0]`; `vouchers.active[0]` was
absent, so its shape is unknown):

```
object{title: string, subTitle: string, description: string, redeemedDate: string, voucherCode: string, voucherType: string, sender: string, voucherAmount: number}
```

**Bonus `groupedBalances`** (`accountBalance.groupedBalances[0]`):

```
object{balanceCode: number, balanceDescription: string, pointValue: number, voucherValue: number, detailedBalances: array[4] of object{balanceDescription: string, pointValue: number, voucherValue: number, sender: string}}
```

**Purchase `monthSummaries`** (`/api/cpa/purchases/historical/me/monthsummaries`, `monthSummaries[0]`, at
`loginState` 2):

```
object{year: number, month: number, amount: number, amountSaved: number}
```

**Transaction header** (`/api/cpa/purchases/historical/me/byyearmonth/<yyyy-mm>`, the first transaction of the latest
month; the name of the array key holding it was not captured):

```
object{transactionId: string, transactionDate: string, storeId: number, storeMarketingName: string, storeCity: string, transactionChanel: string (sic, one n), transactionValue: number, totalDiscount: number, discountValue: number}
```

The first item of the first transaction was **absent**: flat receipt headers, **no line items at the purchase
endpoint**. Note the spelling **`transactionChanel`** (sic).

**User information** (`www.ica.se/api/user/information`):

```
object{loginState: number, customerId: number, customerCardType: null, gaId: string, cookieConsent: string, cookieConsentToken: string, firstName: string, accessToken: string, tokenExpires: string, retailMedia: string}
```

`customerId` is the only person id, and it is per person (two household members' hashes differ).

**App access token:** opaque (45 chars), not a JWT; no claims.

## Handla (Ocado) public

Verified 2026-09-29 with `HANDLA_ZIP=11122` (default) against `spike/06-handla-public.ts`. All calls are anonymous — no cookies, no auth headers, no BankID needed.

**Store search** — `GET https://handla.ica.se/api/store/v1?zip=<zip>&customerType=B2C` → **HTTP 200**.
Response shape is **not** a bare array as the original spike brief assumed; it's an object:
```
{ combinedHomePickupDelivery, forHomeDelivery: Store[], forPickupDelivery: Store[], offline: Store[], validZipCode, zipCode }
```
For zip 11122 (central Stockholm): `forHomeDelivery` had 63 stores, `forPickupDelivery` 23, `offline` 0. Each `Store` has `id`, `storeOwnerId`, `name`, `city`, `street`, `zipCode`, `storeFormat` (e.g. `kvantum`, `supermarket`), `deliveryMethods`, `customerTypes`, `accountId` (the id `handlaprivatkund.ica.se/stores/<accountId>` expects), `retailerSiteId`, `storeProfileId`, `slug`. The script now reads `sj.forHomeDelivery[0].accountId` (falling back to `forPickupDelivery[0]`) instead of `sj[0].accountId`.

**Anonymous product search** — `GET https://handlaprivatkund.ica.se/stores/<accountId>/api/webproductpagews/v6/product-pages/search?q=mjölk&tag=web&maxPageSize=10&includeAdditionalPageInfo=false&maxProductsToDecorate=10` (headers: `Referer`/`Origin` set to the store base URL) → **HTTP 200** on the first attempt (no 202-retry needed this run). Response shape matches the brief:
```
{ productGroups: [{ type: "personalized"|..., decoratedProducts: [{ productId (uuid), retailerProductId, type, name, brand, packSizeDescription, countryOfOrigin, price: {amount, currency}, unitPrice: {...}, available, isVerifiedPurchase, quantityInBasket, maxQuantityReached, image, imageConfig, ... }] }], metadata, missedPromotions }
```
`taxCodesDisplayNames` matched the redaction regex (`code`) and came back `<redacted>` in the saved fixture — harmless, just means that field's real value isn't captured in `spike/out`.

~~Handla product search may answer 202 while preparing; the client polls up to ~7 s.~~ Corrected 2026-10-01: the
long-lasting 202s seen live were AWS WAF challenges, not "preparing" (see **Handla: AWS WAF** below). A plain 202
without a WAF header has not been seen live since; the client retries one only briefly (0.5 s, then 1 s).

### Handla: AWS WAF (measured live 2026-10-01)

Measured from the production egress IP. Shapes and headers only.

- `handlaprivatkund.ica.se` product search sits behind **CloudFront + AWS WAF**. A rate rule trips after about **7
  searches within about 15 s**. From then on, for many minutes (the window is still being measured), every request
  from that IP is refused. The anonymous store search (`handla.ica.se/api/store/v1`) was refused from the same IP while
  the rule was tripped.
- **Browser-looking request** (Chrome UA, `Referer`, `Origin`, `Accept-Language` — what the hub sends): **HTTP 202**,
  `x-amzn-waf-action: challenge`, `server: CloudFront`, `x-cache: Error from cloudfront`, empty body, no `set-cookie`.
  This is a WAF **CHALLENGE**: there is no JS to run and no token to get, so polling never clears it (and likely keeps
  the rule tripped).
- **Plain request**: **HTTP 403**, `server: CloudFront`, an HTML body saying "Request blocked", no `x-amzn-waf-*`
  header. This is a WAF **BLOCK**.
- `server: CloudFront` and `x-cache: Error from cloudfront` are **not** WAF markers on their own: CloudFront sets them
  on any error answer it passes on, including the origin's own 4xx (an unknown store, say).

Not measured, so treated as assumptions:

- **Burst rule or per-minute rule?** "About 7 in about 15 s" cannot tell a short burst rule from a per-minute (or
  per-5-minute) rate rule that happens to trip at that pace. The hub's default of **8 request starts per rolling
  minute** (plus 2.5 s between starts) is a conservative guess that stays under both readings until the window is
  measured.
- **One rule for both hosts.** The hub keeps one breaker, one queue and one window for `handlaprivatkund.ica.se` and
  `handla.ica.se` together, on the assumption that one per-IP rule (or a shared WAF web ACL) covers both. That the
  store search was refused while product search was tripped fits this, but was not measured separately.

What the hub does (src/ica/handla-api.ts, src/ica/handla-guard.ts):

- A WAF stop is a response with an `x-amzn-waf-action` header (any status), or a 403 with any `x-amzn-waf-*` header
  or whose body (at most 16 kB read) contains "Request blocked". It is `IcaUnavailable('blocked')` at once, never
  polled. Any other 403 is the origin's refusal (`IcaRejected` 403) and never opens the breaker.
- A process-wide circuit breaker then refuses every uncached Handla call for a cooldown (10 min, doubled after each
  probe that is stopped again, up to 60 min) without contacting Handla; after it, exactly one probe request goes
  through.
- All Handla requests from the process go through one queue: at least 2.5 s between starts and at most 8 starts per
  rolling 60 s, at most 10 waiting; a call that would wait more than 20 s is refused at once with the seconds left. A
  plain 202's two short retries rejoin the queue like any request.
- Successful answers (the projected tool views only, with `asOf`) are cached in memory (search 15 min, store search
  24 h, 500 entries); cache hits never count toward the window.

**Store home page** — `GET https://handlaprivatkund.ica.se/stores/<accountId>/` → **HTTP 200**. The anonymous page **does** already embed a CSRF token (`"csrf":{"token":"..."}` present in the HTML — `csrf token present (anonymous): true`), and the page also matched the WAF/challenge heuristic (`waf challenge: true`) — the regex `/awswaf|challenge/i` matched somewhere in the HTML (likely boilerplate WAF/bot-protection script tags rather than an active interactive challenge, since the request still returned a normal 200 page body with product data reachable). Worth re-checking with the real network trace in Task 0.9 to see whether this is just static WAF JS or an actual blocking challenge under different conditions (e.g. higher request rate).

No CSRF token was required to be sent by us to get 200s on GET requests in this run; whether it's required for mutating (cart) requests is out of scope for Task 0.8 (anonymous, read-only calls only).

## Handla login

_Pending: run `pnpm spike spike/08-handla-http.ts` (needs `HANDLA_STORE_ID` from spike/06, plus either `HANDLA_LOGIN_START_URL` from the HAR — Task 0.9 — or a saved `spike/out/handla-jar-A.json`; BankID scan on first run) and fill in with the decision (BankID relay over HTTP vs. cookie-paste), cookie names and lifetimes._

## Handla cart

_Pending: run `HANDLA_TEST_PRODUCT_ID=<id> pnpm spike spike/08-handla-http.ts` (same prerequisites as Handla login, plus a `productId` from `spike/out/handla-search-redacted.json`) and, only if cart calls come back WAF-blocked, `pnpm spike spike/09-handla-cookie-paste.ts` (needs `spike/out/handla-cookie-A.txt`, pasted from DevTools). Fill in with the cart shape and the apply-quantity semantics (absolute vs. delta)._

## Handla slots

_Pending: run `pnpm spike spike/10-handla-slots.ts` (same prerequisites as Handla login) and, only if Task 0.9 clears it, again with `HANDLA_TRY_RESERVE=1 HANDLA_RESERVE_BODY=<json>`. Fill in with the slot list shape (dates, times, prices, availability) and the final decision: keep or drop `handla_reserve_slot`._

## Verified with Claude (2026-09-30)

Phase 2 milestone (Task 2.11): commit `20ffa0c` deployed to the live hub. The owner re-added the Claude connector so it picked up the new tool list, then ran the read-only prompts from the Claude app. He reported that all of them worked. No personal data is recorded here.

| Prompt | Tool | Result |
|---|---|---|
| "Which ICA tools do you have?" | (tool list) | pass: seven tools after the connector was re-added |
| "What's on our shopping list?" | `get_shopping_list` | pass |
| "Which ICA shopping lists do we have?" | `list_shopping_lists` | pass |
| "What's on offer at our store with kyckling?" | `get_store_offers` | pass |
| "Which are my favourite ICA stores and when do they close today?" | `get_favorite_stores` | pass |
| "How much bonus do I have?" | `get_bonus` | pass |
| "Look up EAN 7310865004703" | `lookup_product` | pass |

Still unconfirmed after this check:
- ~~Whether mobile list rows carry `quantity`/`unit`.~~ Resolved 2026-09-30: they round-trip (see List writes below).
- The exact wording of multibuy deal text when `condition` is absent.
- The shape of `vouchers.active`.
- What ICA answers for an unknown/expired DCR client_id — check at 2.22. (The hub reuses the stored app client on reconnect and registers a new one after any failed app login that used it, except a BankID timeout.)
- ~~2.22 LIVE: is `customerId` (a number in `/api/user/information`) per person or per household?~~ Resolved
  2026-09-30: per person (see Household member onboarding below). Compare two household members' hashes: after each partner's own web BankID login, compare `ica_account.web_subject_hash` of the two hub users (hashes only, never the id). If they are equal, the same-person check (Task 2.20) cannot tell partners of one household apart. (The app access token is opaque, 45 chars, so only the web side is checked; web and app ids are not cross-checked. Existing accounts get their hash backfilled on the next successful web check, and a refused login is audited as `ica.identity_refused` with its kind only.)

These are re-checked in Task 2.22.

## List writes verified with Claude (2026-09-30)

Deployed commit `386b1f7`, with `ICA_HUB_LIST_WRITES` limited to the owner's account for the test and switched off afterwards. The tests ran only on throwaway lists named explicitly (`ZZ hub test`, `ZZ hub test 2`). The household list was never touched.

| Step | Tool | Result |
|---|---|---|
| Create a list | `create_shopping_list` | pass. The list appeared in the ICA app, so the create request shape is verified. |
| Add "Mjölk" and "Ägg" (6 st) | `add_list_items` | pass. The re-read list returned Ägg with quantity 6 and unit st, so the `quantity`/`unit` keys round-trip through ICA. |
| Check off Mjölk | `check_list_items` | pass |
| Uncheck Mjölk | `uncheck_list_items` | pass |
| Remove Ägg | `remove_list_items` | pass. Claude asked for confirmation first, and only Ägg was removed. |

With writes switched off, the gate refused a write tool before any ICA call (`ToolInputError`, 0 ms).

Purchase history worked live (`get_purchases` returned ok) while the web session was elevated.

## Household member onboarding verified (2026-09-30)

- **Account creation.** The partner signed in with Authentik and was created automatically through the group mapping (`user.provisioned {role: member}`, then `auth.login {method: oidc}`). No invite was needed, and no password is set.
- **Separate ICA accounts.** Each household member links their own `ica_account` row: 2 rows, 2 distinct links.
- **`customerId` is per person, not per household.** The two accounts' `web_subject_hash` values differ, so the same-person check can tell household members apart.
- **Write gate refuses a user who is not allowed.** With `ICA_HUB_LIST_WRITES` limited to one email, the partner's `check_list_items` was refused (`ToolInputError`) before any ICA call.
- **Purchase history works live.** It works on the partner's freshly elevated web session (`login_state` 2).
