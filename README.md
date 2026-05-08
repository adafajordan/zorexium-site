# Zorexium Site (Frontend + API Server)

## Frontend/backend deployment notes (GitHub Pages + Render)

- Frontend origin(s) allowed by server CORS with `credentials: true`:
  - `https://zorexium.io`
  - `https://www.zorexium.io`
- Backend accepts JWT from `Authorization` header (`Bearer <token>` or raw token) and falls back to `authToken` cookie.
- For cookie-based auth across origins in production, auth cookies are set with:
  - `SameSite=None`
  - `Secure`
  - `HttpOnly` for `authToken`
- Frontend requests that rely on cookie auth must send `credentials: 'include'`.
- Liveness endpoint is available at `GET /health`.

