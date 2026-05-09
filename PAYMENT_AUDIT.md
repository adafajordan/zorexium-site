# Checkout Funds Flow Audit (where money goes)

Date: 2026-05-09  
Repository: `adafajordan/zorexium-site`

## Scope

This audit traces funds for purchases started from `checkout.html` only.

## 1) Which payment processor/account receives checkout money

- Checkout uses **PayPal** only:
  - Frontend loads PayPal SDK using `paypalClientId` from backend config (`checkout.html:521-540`, `server.js:425-428`).
  - Backend authenticates to PayPal with `PAYPAL_CLIENT_ID` + `PAYPAL_SECRET` (`server.js:1082-1083`, `server.js:1104-1123`).
- `POST /api/orders` creates a PayPal order at `/v2/checkout/orders` (`server.js:1502-1653`, especially `server.js:1585-1617`).
- In the `purchase_units` payload, there is **no explicit `payee` override** (`server.js:1593-1615`), so capture funds go to the merchant account behind the configured PayPal API credentials.

**Conclusion:** buyer payment is captured into the PayPal business account associated with `PAYPAL_CLIENT_ID`/`PAYPAL_SECRET` for the active `PAYPAL_MODE` (`sandbox` or `live`) (`server.js:1077-1083`).

## 2) Intermediary/routing logic after capture

After buyer approval:
- Frontend calls `POST /api/orders/:orderId/capture` (`checkout.html:854-888`).
- Backend captures via PayPal `/v2/checkout/orders/{paypalOrderId}/capture` (`server.js:1661-1691`).
- Order is marked completed (`server.js:1693-1702`).
- Then backend immediately attempts seller payout via `sendPayPalSellerPayout(order, { triggerSource: 'capture' })` (`server.js:1704-1716`).

`sendPayPalSellerPayout` routing logic:
- Computes payout as `order.total * (1 - PLATFORM_FEE_RATE)`; default fee 10% (`server.js:1090-1093`, `server.js:1155-1157`).
- Includes a guard that refuses payout when computed amount is not greater than 0 (`server.js:1219-1226`), which prevents accidental zero/negative payout sends.
- Looks up seller payout target from `sellers.payoutAccountId` and requires `payoutVerified === true` (`server.js:1228-1234`).
- Sends PayPal Payout to `receiver: payoutAccountId` (`server.js:1268-1274`, `server.js:1277-1285`).

**Conclusion:** flow is platform-collection first, then separate PayPal Payout to seller email account.

## 3) Where recipient account/destination is set

### Buyer payment destination (merchant account)
- Determined by backend env secrets:
  - `PAYPAL_CLIENT_ID`
  - `PAYPAL_SECRET`
  - `PAYPAL_MODE`
  (`server.js:1077-1083`, `README.md:21-24`).

### Seller payout destination
- Determined per seller in DB field `sellers.payoutAccountId` (email).
- Used as `receiver` in PayPal Payout call (`server.js:1232`, `server.js:1271`).
- `payoutVerified` gate controls whether payout is attempted (`server.js:1233-1240`).

### Where payout account is written from UI
- Seller dashboard saves payout account using:
  - `PUT /api/sellers/me` body `{ payoutAccountId: email, payoutVerified: true }`
  (`seller-dashboard.html:1265-1269`).
- Backend accepts and writes those fields (`server.js:2500-2524`).

## 4) End-to-end funds flow

1. Buyer clicks PayPal in `checkout.html` and frontend calls backend `/api/orders` (`checkout.html:792-847`).
2. Backend recalculates totals from product data, creates PayPal order, stores internal order with `paypalOrderId` (`server.js:1531-1653`).
3. Buyer approves in PayPal popup.
4. Frontend calls `/api/orders/:orderId/capture` (`checkout.html:854-888`).
5. Backend captures payment at PayPal and marks order completed (`server.js:1677-1702`).
6. Backend attempts PayPal Payout from platform PayPal account to seller payout email (`server.js:1704-1716`, `server.js:1148-1330`).
7. Buyer/seller emails are sent; frontend clears cart and redirects success (`server.js:1718-1757`, `checkout.html:873-884`).

## 5) Warnings / recommended follow-ups

1. **Cannot identify exact merchant email/account from repo alone.**  
   Code only references credentials via env vars; check deployment secrets and PayPal dashboard to confirm destination account (`README.md:11-24`, `server.js:1082-1083`).

2. **Critical: seller payout “verification” is self-asserted today.**  
   Frontend sets `payoutVerified: true`, and backend accepts it without PayPal ownership proof (`seller-dashboard.html:1268`, `server.js:2522-2524`).  
   Risk: a malicious seller account can point payouts to an arbitrary email and mark it verified.  
   Recommendation: prioritize server-side ownership verification (PayPal OAuth/onboarding or verification challenge) and prevent direct client control of `payoutVerified`.

3. **Payout failure does not block checkout success.**  
   Capture can succeed while payout fails; system logs failure and still returns completed order (`server.js:1704-1716`).  
   Recommendation: add operational alerting/retry workflow and admin monitoring for failed `payouts` records.

4. **No webhook reconciliation endpoint currently active.**  
   `PAYPAL_WEBHOOK_ID` is documented but webhook handling is not implemented (`README.md:25`).  
   Recommendation: add verified webhook processing for asynchronous payment/payout state reconciliation.
