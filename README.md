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
| `BACKEND_BASE_URL` | Optional | Backend base URL for absolute media links |
| `CORS_ORIGINS`  | Optional | Comma-separated extra origins (zorexium.io is always allowed) |
| `GOOGLE_CLIENT_ID` | Optional | Google OAuth client ID (required only for Google sign-in) |
| `GOOGLE_CLIENT_SECRET` | Optional | Google OAuth client secret (required only for Google sign-in) |
| `GOOGLE_REDIRECT_URI` | Optional | Google callback URL (e.g. `https://zorexium-backend.onrender.com/api/auth/google/callback`) |
| `PAYPAL_CLIENT_ID` | Optional | PayPal client ID |
| `PAYPAL_SECRET` | Optional | PayPal secret |
| `PAYPAL_MODE`   | Optional | `sandbox` or `live` |
| `PAYPAL_PRO_SELLER_PLAN_ID` | Optional | Existing PayPal billing plan ID for Pro Seller subscriptions (must match `PAYPAL_MODE`) |
| `PAYPAL_WEBHOOK_ID` | Optional | PayPal webhook ID used by `/api/paypal/webhook` to verify webhook signatures |
| `SMTP_HOST`     | Optional | SMTP host for email delivery (password reset, OTC login) |
| `SMTP_PORT`     | Optional | SMTP port (default: 587) |
| `SMTP_SECURE`   | Optional | `true` for port 465, `false` otherwise |
| `SMTP_USER`     | Optional | SMTP username/email |
| `SMTP_PASS`     | Optional | SMTP password |
| `SMTP_FROM`     | Optional | From address, e.g. `Zorexium <noreply@zorexium.io>` |

See `.env.example` for the full template.

---

## Frontend/Backend Connectivity Notes

- CORS is configured to allow credentialed requests from `https://zorexium.io` and `https://www.zorexium.io` only.
- Add `https://adafajordan.github.io` to `CORS_ORIGINS` if you need to access via the raw GitHub Pages URL.
- JWT auth flow: all authenticated API calls use `ZrxSession.fetch()` which automatically appends `Authorization: Bearer <token>`.
- For cookie-based auth in production, cookies are set with `SameSite=None; Secure` — requires `NODE_ENV=production`.
- Liveness endpoint: `GET /health`.

---

## Payment Audit Summary

- Full detailed report: see [`PAYMENT_AUDIT.md`](./PAYMENT_AUDIT.md).

- **Configured provider:** PayPal only. `checkout.html`, seller signup, seller dashboard, and listing wizard all load the PayPal JavaScript SDK from `/api/config`, while `server.js` creates/captures PayPal orders and verifies PayPal subscriptions. There is no active Stripe payment code in this repository.
- **Current blockers for real payments:**
  1. `server.js` still contains temporary troubleshooting overrides that force checkout purchases and Pro Seller subscriptions to `$1.00`, so production pricing is not using real cart totals or the intended recurring amount.
  2. The checkout UI still calculates the cart total in the browser, but the backend currently sends PayPal a fixed `$1.00` amount. This means the buyer-facing total and the provider charge can diverge.
  3. Pro Seller subscriptions depend on a PayPal billing plan ID. The deployment environment must provide a plan ID that matches the current `PAYPAL_MODE`; otherwise `/api/sellers/pro-plan` can fail or create a fresh test plan instead of using the intended live subscription.
  4. Configure `PAYPAL_WEBHOOK_ID` and your PayPal webhook so asynchronous payout events can be signature-verified and reconciled by `/api/paypal/webhook`.
- **What to verify in Render before going live:** set `PAYPAL_MODE=live`, use the matching live `PAYPAL_CLIENT_ID`/`PAYPAL_SECRET`, configure the correct live `PAYPAL_PRO_SELLER_PLAN_ID`, and confirm the PayPal merchant account is fully enabled for live checkout, subscriptions, and payouts. The actual secret values/account readiness cannot be confirmed from this repository alone.
- **Recommended fixes before accepting real payments:** keep frontend totals aligned with backend charge amounts, configure PayPal webhooks for asynchronous state handling, and monitor server logs plus failed `orders`/`payouts` records for operational visibility.

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
