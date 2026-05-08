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
| `CORS_ORIGINS`  | Optional | Comma-separated extra origins (zorexium.io is always allowed) |
| `PAYPAL_CLIENT_ID` | Optional | PayPal client ID |
| `PAYPAL_SECRET` | Optional | PayPal secret |
| `PAYPAL_MODE`   | Optional | `sandbox` or `live` |
| `PAYPAL_WEBHOOK_ID` | Optional | PayPal webhook ID |
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
