'use strict';

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── Firebase Admin ────────────────────────────────────────────────────────────
let db = null;
try {
  const admin = require('firebase-admin');
  const raw   = process.env.FIREBASE_SERVICE_ACCOUNT || '{}';
  const sa    = JSON.parse(raw);
  if (sa.project_id) {
    admin.initializeApp({ credential: admin.credential.cert(sa) });
    db = admin.firestore();
  }
} catch (e) {
  console.warn('Firebase init skipped, using file-based storage:', e.message);
}

// ── File-based listings fallback ──────────────────────────────────────────────
const LISTINGS_FILE = path.join(__dirname, 'listings_data.json');

function readListings() {
  try {
    return JSON.parse(fs.readFileSync(LISTINGS_FILE, 'utf8')).listings || [];
  } catch {
    return [];
  }
}

function writeListings(listings) {
  fs.writeFileSync(LISTINGS_FILE, JSON.stringify({ listings }, null, 2));
}

// ── PayPal helpers ────────────────────────────────────────────────────────────
const PAYPAL_MODE = process.env.PAYPAL_MODE || 'sandbox';
const PAYPAL_BASE = PAYPAL_MODE === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

async function getPayPalToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret   = process.env.PAYPAL_SECRET;
  if (!clientId || !secret) throw new Error('PayPal credentials not configured');
  const res  = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method:  'POST',
    headers: {
      Authorization:  'Basic ' + Buffer.from(`${clientId}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Failed to obtain PayPal access token');
  return data.access_token;
}

// ── In-memory order store ─────────────────────────────────────────────────────
// Keyed by internal orderId; replaced by Firestore when DB is available.
const orders = new Map();

// ── GET /api/listings ─────────────────────────────────────────────────────────
app.get('/api/listings', async (req, res) => {
  try {
    if (db) {
      const snapshot  = await db.collection('listings').get();
      const listings  = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      return res.json({ listings });
    }
    return res.json({ listings: readListings() });
  } catch (e) {
    console.error('GET /api/listings:', e);
    return res.status(500).json({ error: 'Failed to fetch listings' });
  }
});

// ── POST /api/listings ────────────────────────────────────────────────────────
app.post('/api/listings', async (req, res) => {
  try {
    const listing = req.body;
    if (!listing || !listing.id) return res.status(400).json({ error: 'Listing id required' });
    if (db) {
      await db.collection('listings').doc(String(listing.id)).set(listing);
      return res.json({ ok: true });
    }
    const listings = readListings();
    const idx = listings.findIndex(l => String(l.id) === String(listing.id));
    if (idx >= 0) listings[idx] = listing; else listings.push(listing);
    writeListings(listings);
    return res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/listings:', e);
    return res.status(500).json({ error: 'Failed to save listing' });
  }
});

// ── DELETE /api/listings/:id ──────────────────────────────────────────────────
app.delete('/api/listings/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (db) {
      await db.collection('listings').doc(id).delete();
      return res.json({ ok: true });
    }
    writeListings(readListings().filter(l => String(l.id) !== id));
    return res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/listings/:id:', e);
    return res.status(500).json({ error: 'Failed to delete listing' });
  }
});

// ── POST /api/orders ──────────────────────────────────────────────────────────
app.post('/api/orders', async (req, res) => {
  try {
    const { items, buyer, shippingMethod } = req.body;
    if (!Array.isArray(items) || items.length === 0 || !buyer) {
      return res.status(400).json({ error: 'items and buyer are required' });
    }

    // Resolve authoritative prices from the listings store
    const allListings = db
      ? await db.collection('listings').get().then(s => s.docs.map(d => ({ id: d.id, ...d.data() })))
      : readListings();

    let subtotal = 0;
    const resolvedItems = [];
    for (const { id, quantity } of items) {
      const listing = allListings.find(l => String(l.id) === String(id));
      if (!listing) return res.status(400).json({ error: `Listing ${id} not found` });
      const qty   = Math.max(1, parseInt(quantity, 10) || 1);
      const price = parseFloat(listing.price);
      if (isNaN(price) || price <= 0) return res.status(400).json({ error: `Invalid price for listing ${id}` });
      subtotal += price * qty;
      resolvedItems.push({ ...listing, quantity: qty });
    }

    const shipping = Math.max(0, Math.round(subtotal * 0.10 - 0.99)) + 0.99;
    const tax      = subtotal * 0.08;
    const total    = subtotal + shipping + tax;

    // Create the PayPal order
    const token  = await getPayPalToken();
    const ppRes  = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        intent:         'CAPTURE',
        purchase_units: [{
          amount: {
            currency_code: 'USD',
            value:         total.toFixed(2),
            breakdown: {
              item_total: { currency_code: 'USD', value: subtotal.toFixed(2) },
              shipping:   { currency_code: 'USD', value: shipping.toFixed(2) },
              tax_total:  { currency_code: 'USD', value: tax.toFixed(2) },
            },
          },
          items: resolvedItems.map(item => ({
            name:        item.name,
            unit_amount: { currency_code: 'USD', value: parseFloat(item.price).toFixed(2) },
            quantity:    String(item.quantity),
          })),
        }],
      }),
    });

    const ppData = await ppRes.json();
    if (!ppRes.ok || !ppData.id) {
      console.error('PayPal create order error:', ppData);
      return res.status(502).json({ error: ppData.message || 'PayPal order creation failed' });
    }

    const orderId = crypto.randomUUID();
    const order = {
      orderId,
      paypalOrderId:  ppData.id,
      items:          resolvedItems,
      buyer,
      shippingMethod: shippingMethod || 'standard',
      subtotal,
      shipping,
      tax,
      total,
      status:    'pending',
      createdAt: new Date().toISOString(),
    };
    orders.set(orderId, order);
    if (db) await db.collection('orders').doc(orderId).set(order);

    return res.json({ orderId, paypalOrderId: ppData.id });
  } catch (e) {
    console.error('POST /api/orders:', e);
    return res.status(500).json({ error: e.message || 'Failed to create order' });
  }
});

// ── POST /api/orders/:id/capture ──────────────────────────────────────────────
app.post('/api/orders/:id/capture', async (req, res) => {
  try {
    const orderId = req.params.id;
    let order = orders.get(orderId);
    if (!order && db) {
      const doc = await db.collection('orders').doc(orderId).get();
      if (doc.exists) order = doc.data();
    }
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status === 'completed') return res.json({ ok: true, orderId });

    const token  = await getPayPalToken();
    const ppRes  = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${order.paypalOrderId}/capture`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });

    const ppData = await ppRes.json();
    if (!ppRes.ok || ppData.status !== 'COMPLETED') {
      console.error('PayPal capture error:', ppData);
      return res.status(502).json({ error: ppData.message || 'Payment capture failed' });
    }

    order.status     = 'completed';
    order.capturedAt = new Date().toISOString();
    orders.set(orderId, order);
    if (db) await db.collection('orders').doc(orderId).set(order);

    return res.json({ ok: true, orderId });
  } catch (e) {
    console.error('POST /api/orders/:id/capture:', e);
    return res.status(500).json({ error: e.message || 'Failed to capture order' });
  }
});

// ── POST /onboard-seller ──────────────────────────────────────────────────────
app.post('/onboard-seller', async (req, res) => {
  try {
    const Stripe = require('stripe');
    const key    = process.env.STRIPE_SECRET_KEY;
    if (!key) return res.status(500).json({ error: 'Stripe secret key not configured' });
    const stripe  = Stripe(key);
    const account = await stripe.accounts.create({ type: 'express' });
    const base    = process.env.BASE_URL || `http://localhost:${PORT}`;
    const link    = await stripe.accountLinks.create({
      account:     account.id,
      refresh_url: `${base}/seller-signup.html`,
      return_url:  `${base}/seller-dashboard.html`,
      type:        'account_onboarding',
    });
    return res.json({ url: link.url });
  } catch (e) {
    console.error('POST /onboard-seller:', e);
    return res.status(500).json({ error: e.message || 'Stripe onboarding failed' });
  }
});

// ── POST /send-message ────────────────────────────────────────────────────────
app.post('/send-message', async (req, res) => {
  try {
    const { from, to, subject, body } = req.body;
    if (db && from && to) {
      await db.collection('messages').add({
        from, to, subject, body,
        timestamp: new Date().toISOString(),
        read: false,
      });
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error('POST /send-message:', e);
    return res.status(500).json({ error: 'Failed to save message' });
  }
});

// ── Static file serving ───────────────────────────────────────────────────────
app.use(express.static(__dirname));

// Always return JSON for unmatched /api/* routes so clients never get an HTML 404
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.status(404).sendFile(path.join(__dirname, 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`Zorexium server running on port ${PORT}`));

