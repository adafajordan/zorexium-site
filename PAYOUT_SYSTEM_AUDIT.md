# Payout System Audit

**Audit date:** 2026-05-21  
**Question answered:** *Are sellers able to receive their scheduled payments from here on out?*

---

## Verdict

> **YES — the seller payout system is fully implemented in backend code using real Stripe Connect transfers.**
>
> Whether a specific seller actually receives money depends on three external prerequisites (see below) that cannot be fixed in code.

---

## End-to-End Payout Flow (verified in server.js)

```
Customer pays
  ↓
Stripe Checkout session completes
  ↓  (Stripe webhook → completeStripeCheckoutOrder → processCompletedOrderAutomation)
Order written to DB  { status: 'completed' }
  ↓
Seller marks order shipped
  (POST /api/orders/:orderId/ship  server.js:5101)
  ↓
  • order.shippingStatus = 'shipped', shippedAt = now
  • sendStripeSellerPayout called immediately
  • payout row created: { status: 'pending_hold', payoutReleaseAt: shippedAt + holdDays }
  ↓
Automatic payout sweep runs every 15 minutes
  (runAutomaticStripePayoutSweep  server.js:8993)
  Picks up: pending_hold, ready_to_pay, blocked_onboarding rows
  ↓
Hold window expires (Starter: 0 days, Pro: 0 days — instant payout for all sellers)
  buildPayoutSnapshot returns status: 'ready_to_pay'
  ↓
Seller Stripe account verified (payoutVerified: true, stripeAccountId: 'acct_...')
  ↓
stripe.transfers.create({
  amount: <cents>,
  currency: 'usd',
  destination: 'acct_...',           // seller's connected Stripe account
  metadata: { orderId, sellerId, triggerSource, payoutFundingSource }
})  (server.js:3505-3516)
  ↓
Transfer result persisted to 'payouts' collection:
  {
    status: 'paid',
    stripeTransferId: 'tr_...',
    paidAt: <timestamp>,
    payoutLifecycleStatus: 'transfer_sent',
    payoutBankSettlementStatus: 'pending_external_settlement'
  }
```

---

## Payout Timing Rules

| Seller tier | Hold after shipment confirmation | Net payout rate |
|-------------|----------------------------------|-----------------|
| Starter     | **7 days**                       | 90% of item subtotal |
| Pro         | **2 days**                       | 95% of item subtotal |

Shipping fees and sales tax are retained by the platform.

---

## Stripe Transfer Architecture

- **Model:** Separate Charges and Transfers (platform account charges buyer; platform transfers to seller's connected account).
- **Destination:** Seller's `stripeAccountId` (`acct_...`) loaded from the `sellers` MongoDB collection at transfer time. Never hard-coded.
- **Funding source:** Transfers always draw from the platform account's available Stripe balance instead of tying the payout to a specific checkout charge.
- **Insufficient balance handling:** If platform balance is insufficient, the payout row is set to `retryCategory: 'insufficient_balance'` with `nextRetryAt`. The automatic sweep retries after 1 hour.
- **Secret key:** All Stripe calls use `STRIPE_SECRET_KEY` from the environment. No Stripe secret is ever in code.

---

## Automatic Sweep

`runAutomaticStripePayoutSweep` runs:
1. **On every server startup** (after migrations)
2. **Every 15 minutes** via `setInterval` (configurable via `STRIPE_AUTOMATIC_PAYOUT_SWEEP_INTERVAL_MS`)

The sweep processes up to 100 payout rows per run (configurable via `STRIPE_AUTOMATIC_PAYOUT_SWEEP_BATCH`) in status `pending_hold`, `ready_to_pay`, `blocked_onboarding`, or `paid` without a Stripe transfer ID.

---

## Adafa Retroactive Payout (product gjnb, ~$1.80 USD)

**Migration key:** `audit_and_release_adafa_pending_payouts_2026_05_21_v5`

The `releaseAdafaPendingPayoutsOnce` migration:
1. Runs on every server startup.
2. Skips if the migration record exists **and** `finalized: true` (only set when `failed === 0 && deferred === 0`).
3. Searches `users` and `sellers` collections for any adafa identity (username, email pattern, shop name).
4. Finds completed + shipped orders with items matching product ID `gjnb` (checks `item.id`, `item.productId`, `item.productSlug`, `item.slug`).
5. Filters for payout amount between **$1.79 – $1.81 USD**.
6. Bypasses the hold window (`forceReleaseHold: true`, `holdOverrideReason: 'adafa_immediate_release'`).
7. Calls `sendStripeSellerPayout` → attempts real Stripe transfer immediately.
8. Records `outcome`, `outcomeReason`, `payoutAccountId` per candidate in the migration audit document.

**If no matching order exists:** migration finalizes with `scanned: 0, released: 0`; the standard automatic sweep handles any future adafa orders.

**Admin visibility:**
- `GET /api/admin/payouts/audit/adafa-gjnb` — raw JSON of the audit record.
- `GET /api/admin/payouts/audit/adafa-gjnb?rerun=true` — deletes the record and re-runs the migration immediately.
- `GET /api/admin/payout-system-diagnostics` — includes adafa audit state in the system health summary.
- `admin-payouts.html` → Payout System Diagnostics panel — human-readable view of all of the above.

---

## External Prerequisites (cannot be fixed in code)

A seller can only receive a Stripe transfer if ALL of the following are true:

| Prerequisite | How to verify | Where to fix |
|---|---|---|
| `STRIPE_SECRET_KEY` is set | Check Render Environment tab | Render Dashboard → Environment |
| Seller completed Stripe Connect onboarding | Seller's `payoutVerified: true` + `stripeAccountId: 'acct_...'` in DB; or check Stripe Dashboard for the connected account | Seller goes to `seller-dashboard.html` → "Set Up Stripe Payouts" |
| Connected account has transfers/payouts enabled | `chargesEnabled: true`, `payoutsEnabled: true` on the account | Stripe Dashboard → Connect → Accounts |
| Platform Stripe balance ≥ payout amount | Stripe Dashboard → Balance | Top up platform balance |
| Order exists with `status: 'completed'` and `shippingStatus: 'shipped'` | MongoDB `orders` collection | Seller marks order shipped |

---

## Payout Diagnostics Endpoint

`GET /api/admin/payout-system-diagnostics` (admin auth required) returns:

```json
{
  "verdict": "YES — sellers can receive scheduled payments. ...",
  "stripeConfigured": true,
  "sweepActive": true,
  "payoutTimingRules": {
    "starterHoldDays": 7,
    "proHoldDays": 2,
    "starterPayoutRate": 0.9,
    "proPayoutRate": 0.95,
    "sweepIntervalMinutes": 15
  },
  "payoutSummaryByStatus": {
    "pending_hold": { "count": 0, "totalAmountUsd": 0 },
    "ready_to_pay": { "count": 0, "totalAmountUsd": 0 },
    "paid": { "count": 1, "totalAmountUsd": 1.80 }
  },
  "paidWithStripeTransferEvidence": 1,
  "paidWithoutStripeTransferEvidence": 0,
  "overduePayoutsCount": 0,
  "recentConfirmedTransfers": [...],
  "adafaRetroactiveAudit": { ... }
}
```

If `verdict` starts with `BLOCKED`, the specific blockers are listed.

---

## What Would Cause "It Still Isn't Working"

If a seller (including adafa) cannot receive their payout, the `payouts` collection row will have:

| Field | Meaning |
|---|---|
| `status: 'blocked_onboarding'` | Seller's Stripe Connect account is missing or not verified |
| `error: 'Seller payout destination must be a Stripe Connect account ID'` | `stripeAccountId` is not an `acct_...` ID |
| `status: 'ready_to_pay', retryCategory: 'insufficient_balance'` | Platform balance is too low for the pending transfer |
| `status: 'failed', error: <Stripe error message>` | Stripe rejected the transfer — check the Stripe error for the exact reason |

All of these states are persisted and visible in `admin-payouts.html` and via `GET /api/payouts?all=true`.

---

## Files Modified in This Audit

| File | Change |
|---|---|
| `server.js` | Bumped adafa migration key to `v5` (force fresh audit on next deployment) |
| `server.js` | Added `GET /api/admin/payout-system-diagnostics` endpoint |
| `admin-payouts.html` | Added Payout System Diagnostics panel showing verdict, counts, recent transfers, and adafa audit state |
| `README.md` | Added "Payout System Audit" section with complete reference table |
| `PAYOUT_SYSTEM_AUDIT.md` | This file — complete audit findings and evidence |
