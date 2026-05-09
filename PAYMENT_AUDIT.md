# Payment Acceptance Audit (Code-Level)

Date: 2026-05-09  
Repository: `adafajordan/zorexium-site`

## 1) Payment provider integrations found

### Active provider
- **PayPal only** (no active Stripe payment processing code found).

### Frontend PayPal usage
- `checkout.html` loads PayPal SDK from `/api/config` and runs order create/capture flow (`checkout.html:523-539`, `checkout.html:772-889`).
- `seller-signup.html` loads PayPal subscription SDK and captures `subscriptionID` for Pro signup (`seller-signup.html:625-730`, `seller-signup.html:829-857`).
- `seller-dashboard.html` and `listing-wizard.html` load PayPal subscription SDK for Pro upgrades (`seller-dashboard.html:1453-1537`, `listing-wizard.html:1757-1837`).

### Backend PayPal usage
- PayPal mode/API/env setup (`server.js:1077-1084`).
- Checkout order creation (`POST /api/orders`) and capture (`POST /api/orders/:orderId/capture`) (`server.js:1490-1717`).
- Pro subscription plan lookup/creation and verification (`server.js:1316-1391`, `server.js:1393-1487`, `server.js:2521-2573`).
- Seller payouts via PayPal Payouts API (`server.js:1124-1314`, `server.js:2870-2912`).

## 2) Why payments are currently failing (root causes)

## Confirmed code-level blockers
1. **Temporary forced-$1 override is active in production code**, not normal pricing:
   - Checkout is hardcoded to `$1.00` (`FORCED_TEST_CHECKOUT_TOTAL_USD`) in `/api/orders` (`server.js:1085-1091`, `server.js:1515-1549`).
   - Pro subscription plan creation is hardcoded to `$1.00` (`FORCED_TEST_PRO_SUBSCRIPTION_USD`) (`server.js:1089-1091`, `server.js:1344-1360`).
2. **Frontend-displayed totals do not match backend charge logic**:
   - Frontend calculates subtotal/shipping/tax from cart (`checkout.html:595-644`).
   - Backend charge ignores those totals and submits forced `$1.00` (`server.js:1515-1569`).
3. **Payment flow hard-depends on backend DB availability**:
   - `/api/orders` and `/api/orders/:orderId/capture` return `503` when MongoDB is unavailable (`server.js:1492-1494`, `server.js:1618-1620`).
4. **Payment flow hard-depends on PayPal credentials being present**:
   - Missing `PAYPAL_CLIENT_ID`/`PAYPAL_SECRET` causes `503` in create/capture/subscription endpoints (`server.js:1495-1497`, `server.js:1621-1623`, `server.js:1413-1415`, `server.js:2534-2536`).
5. **No PayPal webhook endpoint is implemented**:
   - `PAYPAL_WEBHOOK_ID` is documented, but webhook handler/verification route is absent (`README.md:26`, `README.md:55`; no webhook route in `server.js`).

## High-probability runtime rejection case
6. **Invalid country code can be sent to PayPal when user selects “Other”**:
   - Checkout uses `<option value="OTHER">Other</option>` (`checkout.html:425`),
   - Then forwards that value to PayPal `shipping.address.country_code` (`checkout.html:802`, `server.js:1578`),
   - PayPal expects a valid 2-letter ISO country code for `country_code`.

## 3) Required changes so payments can be accepted successfully

### Required code changes
1. Remove troubleshooting forced-$1 logic and restore dynamic pricing for checkout:
   - Replace forced constants usage in `/api/orders` with validated subtotal/shipping/tax calculation from trusted product data (`server.js:1515-1549`).
2. Remove forced-$1 Pro subscription plan creation logic:
   - Stop using `FORCED_TEST_PRO_SUBSCRIPTION_USD` and fallback `PAYPAL_PRO_SELLER_TEST_PLAN_ID` (`server.js:1089-1091`, `server.js:1318-1322`, `server.js:1358`).
3. Validate/normalize shipping country code before sending to PayPal:
   - Enforce ISO-3166-1 alpha-2 values only; block or map unsupported “OTHER” prior to PayPal create-order call (`checkout.html:417-425`, `server.js:1578`).
4. Keep buyer-visible totals and charged totals aligned:
   - Return server-computed totals in `/api/orders` response and render those on frontend if needed.
5. (Recommended) Add webhook endpoint for asynchronous PayPal events:
   - Handle subscription lifecycle/payment events and signature verification.

### Required deployment/configuration steps
1. In Render, set and verify:
   - `PAYPAL_MODE` (`sandbox` for testing, `live` for real charges),
   - matching `PAYPAL_CLIENT_ID` + `PAYPAL_SECRET`,
   - `PAYPAL_PRO_SELLER_PLAN_ID` for the **same mode**.
2. Ensure `MONGO_URI` is configured and healthy (order creation/capture requires DB).
3. Ensure PayPal merchant account is fully enabled for:
   - Checkout payments,
   - Subscriptions,
   - Payouts (used after capture).

## 4) What is triggered after successful payment

## A) Successful checkout purchase (PayPal order capture)

### Frontend side effects
- `onApprove` calls backend capture endpoint (`checkout.html:843-853`).
- On success:
  - clears cart (`checkout.html:863-871`),
  - redirects to success page (`checkout.html:872`).

### Backend side effects
When `POST /api/orders/:orderId/capture` succeeds (`server.js:1616-1717`):
1. Updates `orders` record to `status: completed` with `paypalCaptureId` (`server.js:1648-1657`).
2. Attempts automatic seller payout via PayPal Payouts API (`server.js:1659-1671`, `server.js:1124-1314`), writing/updated records in `payouts`.
3. Sends buyer purchase-confirmation email (`server.js:1673-1682`).
4. Sends seller “your product sold” email(s), grouped by seller (`server.js:1684-1710`).
5. Returns JSON success payload (`server.js:1712`).

## B) Successful Pro Seller subscription

### Seller signup page flow
- PayPal button success stores `proSubscriptionId` client-side (`seller-signup.html:672-677`).
- Actual backend activation happens only on form submit to `/api/sellers/subscription/confirm` (`seller-signup.html:849-857`).
- Backend verifies subscription with PayPal, inserts `sellers` document, updates `users.isSeller`, and sends seller onboarding/pro emails (`server.js:1393-1483`).

### Seller dashboard/listing wizard upgrade flow
- PayPal button success triggers `/api/sellers/upgrade-to-pro` (`seller-dashboard.html:1509-1516`, `listing-wizard.html:1809-1837`).
- Backend verifies subscription, updates seller `tier` and subscription fields, sends upgrade email (`server.js:2521-2569`).

## 5) Error handling and user/admin visibility

- Frontend surfaces PayPal SDK/init/create/capture errors via notifications/messages (`checkout.html:530-539`, `checkout.html:837-883`; similar in seller subscription pages).
- Backend logs PayPal API errors and returns error messages (`server.js:1587-1590`, `server.js:1643-1646`, `server.js:1713-1715`).
- Payout failures are persisted in `payouts` collection with status/error fields (`server.js:1177-1313`), but checkout still completes even if payout fails.

## 6) Bottom-line outcome

Payments can be accepted once:
1. forced troubleshooting charge overrides are removed,
2. PayPal live/sandbox credentials + plan IDs are correctly matched and configured,
3. DB availability is stable,
4. invalid shipping country values are prevented,
5. (recommended) webhook handling is added for robust asynchronous reconciliation.
