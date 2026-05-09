# Post-purchase audit summary

## Added / fixed
- Added a backend post-purchase sync step in `server.js` that runs after a successful PayPal capture and persists:
  - buyer receipt data (`receipts` collection + `orders.receipt`)
  - buyer account stats (`users.totalPurchases`, `users.totalSpent`, recent purchases, purchase timestamps)
  - seller sales records (`sellerSales` collection)
  - seller analytics (`sellers.totalSales`, `sellers.totalRevenue`, `sellers.totalItemsSold`, recent sales, sale timestamps)
  - seller/buyer in-site notifications (`notifications` collection)
  - product inventory adjustments (`inventoryAdjustments` collection + `products.quantity`)
- Stored the authenticated buyer `userId` on checkout-created orders when available so buyer account data stays linked to the order.
- Added `GET /api/orders/sold` so seller dashboards can load only the orders that include that seller’s items.
- Updated seller dashboard order tables to use seller-specific sold-order data instead of the buyer order endpoint.
- Updated buyer-facing history/tracking pages to use the public order `id` consistently and added receipt links.
- Replaced placeholder purchase history/receipt content in `account-details.html` with live completed-order data.
- Added a persistent receipt section to `payment-success.html` with download/print actions.
- Extended the site notification bell to honor notification `linkUrl` values so order/sale/payout notifications can deep-link to the right page.

## Scope notes
- This change focuses on the reliable records and UI surfaces that should update immediately after a successful purchase capture.
- It does not add unrelated refund, return, shipment-carrier, or webhook workflows.
