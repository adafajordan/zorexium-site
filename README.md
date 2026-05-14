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
| `SMTP_HOST`     | Optional | SMTP host for email delivery (password reset, OTC login) |
| `SMTP_PORT`     | Optional | SMTP port (default: 587) |
| `SMTP_SECURE`   | Optional | `true` for port 465, `false` otherwise |
| `SMTP_USER`     | Optional | SMTP username/email |
| `SMTP_PASS`     | Optional | SMTP password |
| `SMTP_FROM`     | Optional | From address, e.g. `Zorexium <noreply@zorexium.io>` |

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
- Seller payout share is subtotal-only: Starter receives 90%, Pro receives 95% (shipping and tax stay with the platform).
- Pro Seller tier checkout uses Stripe subscription checkout and verifies completion server-side.

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
