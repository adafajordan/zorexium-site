# Zorexium Site

This repository is the static frontend for the Zorexium marketplace. GitHub Pages can publish the HTML, CSS, and browser-side JavaScript in this repo, but it cannot run the marketplace backend. Keep the API/backend deployed separately at `https://zorexium-backend.onrender.com` for authenticated flows, orders, seller tools, and other dynamic features.

## GitHub Pages deployment

- Set **Settings → Pages → Source** to deploy from the repository root.
- Keep the root `CNAME` file set to `zorexium.io`.
- In **Settings → Pages**, set the custom domain to `zorexium.io`.
- Configure DNS for `zorexium.io` to point at GitHub Pages, and add any `www` record/redirect you want at the DNS provider.
- After DNS validates, enable **Enforce HTTPS** in **Settings → Pages**. GitHub Pages manages that setting; it cannot be forced from this repository.

## Backend/API notes

- The frontend is currently configured to call `https://zorexium-backend.onrender.com`.
- If you later move the API to `https://api.zorexium.io`, update the frontend API URLs and backend CORS settings together before switching traffic.
