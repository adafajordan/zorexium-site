# Zorexium Site (Frontend + API Server)

## Architecture

- **Frontend:** GitHub Pages (custom domain `zorexium.io`) — static HTML/CSS/JS files.
- **Backend:** Express/MongoDB API server deployed on Render (`https://zorexium-backend.onrender.com`).
- Frontend authenticates via JWT stored in `localStorage` (`authToken`) and sent as `Authorization: Bearer <token>` header through `ZrxSession.fetch()`.

---

## Required Environment Variables (Render Dashboard)

Set the following in your Render service's **Environment** tab:

| Variable        | Required | Description |
|-----------------|----------|-------------|
| `MONGO_URI`     | ✅ Yes   | MongoDB Atlas connection string |
| `JWT_SECRET`    | ✅ Yes   | Random secret ≥ 64 chars — generate with `openssl rand -hex 64` |
| `NODE_ENV`      | ✅ Yes   | Must be `production` to enable secure cookies and suppress dev token leak |
| `APP_URL`       | ✅ Yes   | Frontend URL (e.g. `https://zorexium.io`) used for OAuth return redirects |
| `FRONTEND_URL`  | Optional | Preferred frontend URL override for OAuth redirects (recommended to keep users off backend host) |
| `BACKEND_BASE_URL` | Optional | Backend base URL for absolute media links |
| `CORS_ORIGINS`  | Optional | Comma-separated extra origins (zorexium.io is always allowed) |
| `GOOGLE_CLIENT_ID` | Optional | Google OAuth web client ID (required for frontend-initiated Google sign-in) |
| `GOOGLE_CLIENT_SECRET` | Optional | Google OAuth client secret (only needed if keeping legacy backend redirect callback flow) |
| `GOOGLE_REDIRECT_URI` | Optional | Google callback URL for legacy backend redirect flow (e.g. `https://zorexium-backend.onrender.com/api/auth/google/callback`) |
| `STRIPE_SECRET_KEY` | ✅ Yes | Stripe secret key (`sk_...`) used by backend checkout/connect APIs |
| `STRIPE_PUBLISHABLE_KEY` | ✅ Yes | Stripe publishable key (`pk_...`) exposed via `/api/config` |
| `STRIPE_WEBHOOK_SECRET` | ✅ Yes | Stripe webhook signing secret (`whsec_...`) for `/api/stripe/webhook` |
| `STRIPE_PRO_SELLER_PRICE_ID` | Optional | Stripe recurring Price ID (`price_...`) for the $1/month Pro Seller subscription (server falls back to inline Stripe price data if omitted) |
| `STRIPE_SUCCESS_URL` | Optional | Checkout success redirect URL (orderId/session_id are appended automatically) |
| `STRIPE_CANCEL_URL` | Optional | Checkout cancel redirect URL |
| `STRIPE_CONNECT_REFRESH_URL` | Optional | Stripe Connect onboarding refresh URL |
| `STRIPE_CONNECT_RETURN_URL` | Optional | Stripe Connect onboarding return URL |
| `PAYPAL_CLIENT_ID` | Optional | Legacy PayPal client ID (kept for backward compatibility endpoints) |
| `PAYPAL_SECRET` | Optional | Legacy PayPal secret |
| `PAYPAL_MODE`   | Optional | Legacy PayPal mode |
| `PAYPAL_PRO_SELLER_PLAN_ID` | Optional | Legacy Pro plan ID |
| `PAYPAL_WEBHOOK_ID` | Optional | Legacy PayPal webhook ID |
| `SENDGRID_API_KEY` | Optional | SendGrid API key used for transactional email delivery |
| `SENDGRID_FROM_EMAIL` | Optional | Verified sender email used for outbound messages |
| `ADMIN_EMAIL` | Optional | Admin inbox used for operational notifications |
| `TWILIO_ACCOUNT_SID` | Optional | Twilio Account SID for SMS alerts |
| `TWILIO_AUTH_TOKEN` | Optional | Twilio auth token for SMS alerts |
| `TWILIO_SMS_FROM` | Optional | Twilio sender number (E.164 format) |

See `.env.example` for the full template.

---

## Google Sign-In Console Setup (frontend-initiated flow)

Google sign-in now starts on `https://zorexium.io` (frontend) and sends the Google token to backend `POST /api/auth/google/token` for verification + app session creation.

Repository code controls frontend UX routing, but the Google chooser/consent label is controlled by your Google Cloud OAuth settings.

In **Google Cloud Console → APIs & Services → OAuth consent screen**, set:

- **App name**: `Zorexium`
- **App logo**: upload your Zorexium logo
- **User support email**: your support inbox
- **Developer contact email**: your developer/admin inbox
- **App domain → Application home page**: `https://zorexium.io`
- **App domain → Authorized domains**: include `zorexium.io` (and `www.zorexium.io` if used)
- (Recommended) **Privacy Policy URL** and **Terms of Service URL** on your main domain

In **Credentials → OAuth 2.0 Client ID** (Web application), configure:

- **Authorized JavaScript origins**:
  - `https://zorexium.io`
  - `https://www.zorexium.io` (if used)
- (Optional/legacy) **Authorized redirect URI** for backend callback:
  - `https://zorexium-backend.onrender.com/api/auth/google/callback`

For normal sign-in UX, users remain on the frontend domain and are no longer expected to land on backend callback pages.

---

## Frontend/Backend Connectivity Notes

- CORS is configured to allow credentialed requests from `https://zorexium.io` and `https://www.zorexium.io` only.
- Add `https://adafajordan.github.io` to `CORS_ORIGINS` if you need to access via the raw GitHub Pages URL.
- JWT auth flow: all authenticated API calls use `ZrxSession.fetch()` which automatically appends `Authorization: Bearer <token>`.
- For cookie-based auth in production, cookies are set with `SameSite=None; Secure` — requires `NODE_ENV=production`.
- Liveness endpoint: `GET /health`.

---

## Payment Summary

- Buyer checkout uses Stripe Checkout with embedded UI (`ui_mode: embedded_page`) in `checkout.html`.
- Seller payout onboarding uses Stripe Connect Express.
- Seller payout release is delayed until shipment confirmation (`/api/orders/:orderId/ship`) plus hold time (Starter: 5 days, Pro: 2 days), then a Stripe transfer is created.
- Stripe transfers use `source_transaction` when a Stripe charge reference is available, and deferred retry metadata is recorded when the platform balance is temporarily insufficient.
- Internal payout lifecycle fields now distinguish transfer dispatch from downstream bank settlement (`payoutLifecycleStatus` vs `payoutBankSettlementStatus`).
- Automatic payout sweeps now re-check `pending_hold`, `ready_to_pay`, onboarding-blocked rows, and `paid` rows missing Stripe transfer evidence so eligible Stripe transfers are attempted continuously after hold windows expire.
- Seller payout share is subtotal-only: Starter receives 90%, Pro receives 95% (shipping and tax stay with the platform).
- Completed purchase automation now runs consistently for both PayPal capture and Stripe webhook flows: order sync, inventory sync/inactivation, payout readiness, and buyer/seller/admin purchase emails.
- A startup migration repairs the historical `steve` → `adafa` May 14, 2026 flow (including paid Stripe sessions left in `pendingOrders`), and admins can rerun legacy repair with `POST /api/admin/orders/repair-legacy`.
- Admins can review/rerun the retroactive adafa payout audit for product `gjnb` via `GET /api/admin/payouts/audit/adafa-gjnb` (use `?rerun=true` to force a fresh audit + transfer attempt).
- Pro Seller tier checkout uses Stripe subscription checkout and verifies completion server-side.

---

## Payout System Audit — Can Sellers Receive Scheduled Payments?

**Short answer: YES** — provided the three external prerequisites below are satisfied.

### What the code does (verified end-to-end)

| Step | What happens | Where |
|------|-------------|-------|
| 1. Customer pays | Stripe Checkout session completes; order written to `orders` collection with `status: 'completed'` | `server.js` Stripe webhook / `completeStripeCheckoutOrder` |
| 2. Seller ships | `POST /api/orders/:orderId/ship` sets `shippingStatus: 'shipped'` + `shippedAt`; immediately calls `sendStripeSellerPayout` to create a `pending_hold` payout row | `server.js:5101` |
| 3. Hold enforced | `buildPayoutSnapshot` computes `payoutReleaseAt = shippedAt + holdDays`; Starter = **5 days**, Pro = **2 days** | `server.js:2595-2596`, `getSellerHoldDaysByTier` |
| 4. Automatic sweep | `runAutomaticStripePayoutSweep` runs every **15 minutes**; picks up `pending_hold`, `ready_to_pay`, `blocked_onboarding` rows | `server.js:8993`, `setInterval` at startup |
| 5. Stripe transfer | When hold has expired and seller account is verified: `stripe.transfers.create({ destination: 'acct_...', source_transaction: 'ch_...' })` | `server.js:3510-3521` |
| 6. Result persisted | `stripeTransferId`, `paidAt`, `payoutLifecycleStatus: 'transfer_sent'`, and `payoutBankSettlementStatus` written to `payouts` collection | `server.js:3523-3538` |

### External prerequisites (cannot be fixed in code)

1. **`STRIPE_SECRET_KEY` is set** in the Render environment — without this, no transfers can be created.
2. **Seller has completed Stripe Connect onboarding** — their `stripeAccountId` (`acct_...`) must be saved on the seller profile and `payoutVerified: true`. If not, the payout row stays in `blocked_onboarding` and retries automatically each sweep.
3. **Platform Stripe balance is sufficient** — if `source_transaction` is not available, a transfer requires available platform balance. Insufficient balance defers the payout and retries every sweep.

### Adafa retroactive payout (product gjnb, ~$1.80)

The `releaseAdafaPendingPayoutsOnce` migration runs on every server startup until it finalizes with no errors:
- Scans the `users` and `sellers` collections for any adafa identity.
- Finds completed + shipped orders containing product `gjnb` (matched by `item.id`, `item.productId`, `item.productSlug`, or `item.slug`).
- Filters for payout amount between **$1.79 – $1.81 USD**.
- Bypasses the normal hold window (`forceReleaseHold: true`).
- Calls `sendStripeSellerPayout` to attempt a real Stripe transfer immediately.
- Audit results are stored in `runtimeMigrations` under key `audit_and_release_adafa_pending_payouts_2026_05_21_v5`.
- Admins can view results and force a re-run via `GET /api/admin/payouts/audit/adafa-gjnb?rerun=true`.

If no matching order is found, the migration finalizes and the standard automatic sweep takes over. Any future adafa order that ships will go through the normal payout flow with the hold bypassed automatically (amount + identity match detected at sweep time).

### Admin diagnostics

- **`GET /api/admin/payout-system-diagnostics`** — returns a machine-readable verdict, per-status payout counts, recent Stripe transfer IDs, sweep/config state, and the adafa audit status. The `verdict` field starts with `YES` when the system is healthy or `BLOCKED` when external prerequisites are unmet.
- **`admin-payouts.html`** — now includes a "Payout System Diagnostics" panel that renders the above in a human-readable form.
- **`GET /api/admin/payouts/audit/adafa-gjnb`** — raw JSON of the adafa retroactive audit migration record.

---

## Admin Access

To grant a user admin privileges, set `isAdmin: true` on their MongoDB user document:

```js
db.users.updateOne({ email: "admin@example.com" }, { $set: { isAdmin: true } })
```

The next time that user logs in, their JWT will include `isAdmin: true`, enabling admin-only endpoints.

---

## Security Notes

1. **Never commit secrets** — `stripe_backup_code.txt`, `.env`, etc. are blocked by `.gitignore`.
2. **Rotate secrets immediately** if they are ever committed to git history.
3. `JWT_SECRET` must be a strong random value in production.
4. Static files are served only from `/public` — `server.js`, `package.json`, and other source files are never exposed via HTTP.
