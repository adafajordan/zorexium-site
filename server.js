const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_your_key_here');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

// Initialize Firebase Admin SDK using environment variable
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  } catch (e) {
    console.error('Failed to initialize Firebase Admin SDK. Check that FIREBASE_SERVICE_ACCOUNT contains valid JSON:', e.message);
  }
}
const db = admin.apps.length ? admin.firestore() : null;

const app = express();
const PORT = process.env.PORT || 5000;
const BASE_URL = process.env.BASE_URL || 'http://localhost:5000';

// PayPal configuration
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || 'Af1A_XMOneJYaO9IJ0XtyQFwr8Bjrsgwg8tiSR2L-gv4DAsN7Y-KAxrKJCVQ8srs2tnh-vfyxQ24Bi7G';
const PAYPAL_SECRET = process.env.PAYPAL_SECRET || 'EA4TXBW1OKmFqyIjoRTiu-ufFNCRsny299SIXe_ncvHtUKjCxuL9f9-vQnQq-_6xqIzoBPnFfLCukZaO';
const PAYPAL_MODE = process.env.PAYPAL_MODE || 'live';
const PAYPAL_BASE_URL = PAYPAL_MODE === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

// Retrieve a short-lived PayPal access token using client credentials
async function getPayPalAccessToken() {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_SECRET) {
    throw new Error('PayPal credentials are not configured. Set PAYPAL_CLIENT_ID and PAYPAL_SECRET in your environment.');
  }
  const credentials = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString('base64');
  const response = await fetch(`${PAYPAL_BASE_URL}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error_description || 'Failed to obtain PayPal access token');
  }
  return data.access_token;
}

// ── Order / commission business-logic constants ───────────────────────────────
// 10% of item subtotal charged as a shipping fee (minimum base of $0.99)
const SHIPPING_RATE        = 0.10;
const SHIPPING_BASE_FEE    = 0.99;
// Sales tax rate applied to item subtotal (flat rate; production should calculate per-jurisdiction)
const TAX_RATE             = 0.08;
// Revenue split: 90% goes to the seller, 10% is retained as the platform fee
const SELLER_COMMISSION_RATE = 0.90;
const PLATFORM_FEE_RATE      = 0.10;

// Mock product database (replace with real database)
const products = {
  'item_gpu_rtx4090': { name: 'RTX 4090', price: 1599.99, sellerId: 'seller1', image: 'https://via.placeholder.com/400x300?text=RTX+4090', description: 'High-end RTX 4090 graphics card. Excellent condition.' },
  'item_cpu_ryzen9': { name: 'Ryzen 9 7950X', price: 699.99, sellerId: 'seller2', image: 'https://via.placeholder.com/400x300?text=Ryzen+9', description: '16-core Ryzen 9 processor. Perfect for gaming and streaming.' },
  'item_ram_32gb': { name: 'DDR5 32GB', price: 149.99, sellerId: 'seller3', image: 'https://via.placeholder.com/400x300?text=DDR5+RAM', description: '32GB DDR5 RAM module. High performance memory.' },
};

// File-based message storage for persistence across restarts
const MESSAGES_FILE = path.join(__dirname, 'messages_data.json');
const MAX_MESSAGES_FILE_SIZE = 10 * 1024 * 1024; // 10 MB limit

// File-based listings storage for persistence across restarts
const LISTINGS_FILE = path.join(__dirname, 'listings_data.json');
const MAX_LISTINGS_FILE_SIZE = 50 * 1024 * 1024; // 50 MB limit

function loadListings() {
  try {
    if (fs.existsSync(LISTINGS_FILE)) {
      const stat = fs.statSync(LISTINGS_FILE);
      if (stat.size > MAX_LISTINGS_FILE_SIZE) {
        console.error('Listings file exceeds size limit; starting with empty storage.');
        return [];
      }
      const parsed = JSON.parse(fs.readFileSync(LISTINGS_FILE, 'utf8'));
      if (!Array.isArray(parsed)) {
        console.error('Listings file has unexpected structure; starting with empty storage.');
        return [];
      }
      return parsed;
    }
  } catch (e) {
    console.error('Failed to load listings from file:', e.message);
  }
  return [];
}

function saveListings(data) {
  fs.writeFile(LISTINGS_FILE, JSON.stringify(data, null, 2), 'utf8', (err) => {
    if (err) console.error('Failed to save listings to file:', err.message);
  });
}

// Load persisted listings on startup
let listings = loadListings();

function loadMessages() {
  try {
    if (fs.existsSync(MESSAGES_FILE)) {
      const stat = fs.statSync(MESSAGES_FILE);
      if (stat.size > MAX_MESSAGES_FILE_SIZE) {
        console.error('Messages file exceeds size limit; starting with empty storage.');
        return {};
      }
      const parsed = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
      if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
        console.error('Messages file has unexpected structure; starting with empty storage.');
        return {};
      }
      return parsed;
    }
  } catch (e) {
    console.error('Failed to load messages from file:', e.message);
  }
  return {};
}

function saveMessages(data) {
  fs.writeFile(MESSAGES_FILE, JSON.stringify(data, null, 2), 'utf8', (err) => {
    if (err) console.error('Failed to save messages to file:', err.message);
  });
}

// Load persisted messages on startup
const messages = loadMessages();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('.')); // Serve static HTML files

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'Server is running', timestamp: new Date() });
});

// ===== STRIPE CONNECT ONBOARDING =====

// Onboard a new seller: create Express account and return onboarding URL
app.post('/onboard-seller', async (req, res) => {
  try {
    const account = await stripe.accounts.create({ type: 'express' });

    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      type: 'account_onboarding',
      refresh_url: `${BASE_URL}/sell-on-zorexium.html`,
      return_url: `${BASE_URL}/success.html?account_id=${account.id}`,
    });

    console.log('accountLink:', accountLink);

    res.json({
      accountId: account.id,
      url: accountLink.url,
    });
  } catch (error) {
    console.error('Stripe error in /onboard-seller:', error);
    res.status(500).json({ error: error.message });
  }
});

// Step 1: Create a Stripe Connect Account
app.post('/create-stripe-account', async (req, res) => {
  try {
    const { email, businessName, type = 'individual' } = req.body;

    if (!email || !businessName) {
      return res.status(400).json({ error: 'Email and business name required' });
    }

    const account = await stripe.accounts.create({
      type: type === 'business' ? 'express' : 'express',
      country: 'US',
      email: email,
      business_profile: {
        name: businessName,
        product_description: 'Tech Hardware Marketplace',
      },
    });

    res.json({
      accountId: account.id,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Step 2: Create Account Link for Onboarding
app.post('/create-account-link', async (req, res) => {
  try {
    const { accountId } = req.body;

    if (!accountId) {
      return res.status(400).json({ error: 'Account ID required' });
    }

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      type: 'account_onboarding',
      refresh_url: `${BASE_URL}/marketplace.html`,
      return_url: `${BASE_URL}/success.html?account_id=${accountId}`,
    });

    res.json({
      url: accountLink.url,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Step 3: Check Account Verification Status
app.get('/check-account-status/:accountId', async (req, res) => {
  try {
    const account = await stripe.accounts.retrieve(req.params.accountId);

    res.json({
      charges_enabled: account.charges_enabled,
      payouts_enabled: account.payouts_enabled,
      requirements: account.requirements,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== PAYMENT PROCESSING =====

// Create Checkout Session (SECURE: looks up price from database)
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { productId, quantity = 1, sellerStripeAccountId } = req.body;

    // SECURITY: Never trust frontend price
    const product = products[productId];
    if (!product) {
      return res.status(400).json({ error: 'Product not found' });
    }

    // Calculate split: 90% to seller, 10% to Zorexium
    const totalAmount = Math.round(product.price * quantity * 100);
    const zorexiumFee = Math.round(totalAmount * 0.10); // 10%
    const sellerAmount = totalAmount - zorexiumFee; // 90%

    // Create session with application fee (10% to platform)
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: product.name,
            },
            unit_amount: Math.round(product.price * 100),
          },
          quantity: quantity,
        },
      ],
      success_url: `${BASE_URL}/marketplace.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/marketplace.html`,
      payment_intent_data: {
        application_fee_amount: zorexiumFee,
        transfer_data: {
          destination: sellerStripeAccountId,
        },
      },
    });

    res.json({
      sessionId: session.id,
      url: session.url,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Verify Payment Session
app.get('/verify-payment/:sessionId', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(req.params.sessionId);

    res.json({
      status: session.payment_status,
      amount: session.amount_total / 100,
      currency: session.currency,
      customer_email: session.customer_email,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== UTILITY ENDPOINTS =====

// Get Product Info (for frontend reference, but NOT used for pricing)
app.get('/product/:productId', (req, res) => {
  const product = products[req.params.productId];
  if (!product) {
    return res.status(404).json({ error: 'Product not found' });
  }
  res.json(product);
});

// ===== MESSAGING SYSTEM =====

// Send a message to a seller
app.post('/send-message', (req, res) => {
  try {
    const { from, to, subject, body } = req.body;

    if (!from || !to || !subject || !body) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const messageId = `msg_${Date.now()}`;
    const conversationKey = [from, to].sort().join('_');

    if (!messages[conversationKey]) {
      messages[conversationKey] = [];
    }

    const message = {
      id: messageId,
      from,
      to,
      subject,
      body,
      timestamp: new Date().toISOString(),
      read: false,
    };

    messages[conversationKey].push(message);
    saveMessages(messages);

    res.json({
      success: true,
      messageId: messageId,
      message: message,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get messages between two users
app.get('/get-messages/:user1/:user2', (req, res) => {
  try {
    const { user1, user2 } = req.params;
    const conversationKey = [user1, user2].sort().join('_');

    const conversationMessages = messages[conversationKey] || [];

    res.json({
      messages: conversationMessages,
      conversationKey: conversationKey,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all conversations for a user
app.get('/get-conversations/:userId', (req, res) => {
  try {
    const { userId } = req.params;
    const userConversations = {};

    Object.keys(messages).forEach((key) => {
      if (key.includes(userId)) {
        const otherUser = key.replace(userId + '_', '').replace('_' + userId, '');
        userConversations[otherUser] = messages[key];
      }
    });

    res.json({ conversations: userConversations });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== MARKETPLACE LISTINGS =====

// Get all listings
app.get('/api/listings', (req, res) => {
  res.json({ listings });
});

// Create a new listing
app.post('/api/listings', (req, res) => {
  try {
    const listing = req.body;
    if (!listing || !listing.id || !listing.name || !listing.sellerUsername) {
      return res.status(400).json({ error: 'Missing required listing fields' });
    }
    // Remove any existing listing with same id (upsert)
    const idx = listings.findIndex(l => String(l.id) === String(listing.id));
    if (idx >= 0) {
      listings[idx] = listing;
    } else {
      listings.push(listing);
    }
    saveListings(listings);
    res.json({ success: true, listing });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update an existing listing
app.put('/api/listings/:id', (req, res) => {
  try {
    const id = req.params.id;
    const updates = req.body;
    const idx = listings.findIndex(l => String(l.id) === String(id));
    if (idx < 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }
    listings[idx] = { ...listings[idx], ...updates, id: listings[idx].id };
    saveListings(listings);
    res.json({ success: true, listing: listings[idx] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete a listing
app.delete('/api/listings/:id', (req, res) => {
  try {
    const id = req.params.id;
    const before = listings.length;
    listings = listings.filter(l => String(l.id) !== String(id));
    if (listings.length === before) {
      return res.status(404).json({ error: 'Listing not found' });
    }
    saveListings(listings);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== FIRESTORE PRODUCT ENDPOINTS =====

// Add a product to Firestore
app.post('/add-product', async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Firestore not configured' });
    }
    const product = req.body;
    if (!product || !product.name) {
      return res.status(400).json({ error: 'Missing required product fields' });
    }
    const docRef = await db.collection('products').add({ ...product, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ success: true, id: docRef.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all products from Firestore
app.get('/products', async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Firestore not configured' });
    }
    const snapshot = await db.collection('products').orderBy('createdAt', 'desc').get();
    const products = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ products });
  } catch (error) {
    const msg = error.code === 9 || (error.message && error.message.includes('index'))
      ? 'Firestore query failed. Ensure a composite index on "createdAt" exists, or visit the Firestore console to create it. Details: ' + error.message
      : error.message;
    res.status(500).json({ error: msg });
  }
});

// ===== PAYPAL ORDER PROCESSING =====

// POST /api/orders – Create a PayPal order with server-side price verification.
// The frontend sends only item IDs and quantities; prices are looked up server-side.
app.post('/api/orders', async (req, res) => {
  try {
    const { items, buyer, shippingMethod } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Cart items are required' });
    }

    // Verify prices server-side from the authoritative listings store
    const verifiedItems = [];
    for (const item of items) {
      const listing = listings.find(l => String(l.id) === String(item.id));
      if (!listing) {
        return res.status(400).json({ error: `Item not found: ${item.id}` });
      }
      const price = parseFloat(listing.price);
      if (!price || price <= 0) {
        return res.status(400).json({ error: `Invalid price for item: ${item.id}` });
      }
      verifiedItems.push({
        id:             listing.id,
        name:           listing.name,
        price:          price,
        sellerUsername: listing.sellerUsername || 'unknown',
        sellerName:     listing.sellerName || listing.sellerUsername || 'unknown',
        quantity:       Math.max(1, parseInt(item.quantity, 10) || 1),
      });
    }

    // Calculate totals server-side (never trust frontend values)
    const subtotal = verifiedItems.reduce((s, i) => s + i.price * i.quantity, 0);
    const shipping  = Math.max(0, Math.round(subtotal * SHIPPING_RATE - SHIPPING_BASE_FEE)) + SHIPPING_BASE_FEE;
    const tax       = subtotal * TAX_RATE;
    const total     = subtotal + shipping + tax;

    // Calculate per-seller commissions server-side
    const commissionMap = {};
    for (const item of verifiedItems) {
      const itemSubtotal   = item.price * item.quantity;
      const sellerEarnings = itemSubtotal * SELLER_COMMISSION_RATE;
      const platformFee    = itemSubtotal * PLATFORM_FEE_RATE;
      const seller = item.sellerUsername;
      if (!commissionMap[seller]) {
        commissionMap[seller] = {
          sellerUsername: seller,
          sellerName:     item.sellerName,
          subtotal:       0,
          sellerEarnings: 0,
          platformFee:    0,
          items:          [],
        };
      }
      commissionMap[seller].subtotal       += itemSubtotal;
      commissionMap[seller].sellerEarnings += sellerEarnings;
      commissionMap[seller].platformFee    += platformFee;
      commissionMap[seller].items.push({
        id:       item.id,
        name:     item.name,
        price:    item.price,
        quantity: item.quantity,
        subtotal: itemSubtotal,
      });
    }
    const commissions = Object.values(commissionMap);

    // Create the order in PayPal
    const accessToken = await getPayPalAccessToken();
    const ppResponse = await fetch(`${PAYPAL_BASE_URL}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        Authorization:   `Bearer ${accessToken}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          description: 'Zorexium Labs Order',
          amount: {
            currency_code: 'USD',
            value: total.toFixed(2),
            breakdown: {
              item_total: { currency_code: 'USD', value: subtotal.toFixed(2) },
              shipping:   { currency_code: 'USD', value: shipping.toFixed(2) },
              tax_total:  { currency_code: 'USD', value: tax.toFixed(2) },
            },
          },
          items: verifiedItems.map(item => ({
            name:        item.name.substring(0, 127),
            unit_amount: { currency_code: 'USD', value: item.price.toFixed(2) },
            quantity:    String(item.quantity),
            category:    'PHYSICAL_GOODS',
          })),
        }],
      }),
    });
    const ppOrder = await ppResponse.json();
    if (!ppResponse.ok) {
      console.error('PayPal order creation failed:', ppOrder);
      return res.status(502).json({ error: 'Failed to create PayPal order', details: ppOrder });
    }

    // Generate a unique internal order ID (crypto.randomUUID() is available in Node 18+)
    const internalOrderId = 'zrx_' + crypto.randomUUID().replace(/-/g, '');
    const orderData = {
      orderId:       internalOrderId,
      paypalOrderId: ppOrder.id,
      payerId:       null,
      status:        'pending',
      items:         verifiedItems,
      buyer:         buyer || {},
      totals:        { subtotal, shipping, tax, total },
      commissions,
      shippingMethod: shippingMethod || 'standard',
      createdAt:     admin.firestore.FieldValue.serverTimestamp(),
      capturedAt:    null,
      deliveredAt:   null,
    };

    if (!db) {
      return res.status(503).json({ error: 'Database not configured. Orders cannot be persisted or verified.' });
    }
    await db.collection('orders').doc(internalOrderId).set(orderData);

    res.json({ orderId: internalOrderId, paypalOrderId: ppOrder.id });
  } catch (error) {
    console.error('Error in POST /api/orders:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/orders/:orderId/capture – Verify and capture the PayPal payment on the backend.
// Called by the frontend after the buyer approves the payment in the PayPal popup.
app.post('/api/orders/:orderId/capture', async (req, res) => {
  try {
    const { orderId } = req.params;

    if (!db) {
      return res.status(503).json({ error: 'Database not configured. Cannot verify order.' });
    }

    // Retrieve the pending order – never trust the frontend for order details
    const doc = await db.collection('orders').doc(orderId).get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'Order not found' });
    }
    const orderData = doc.data();

    if (orderData.status !== 'pending') {
      return res.status(400).json({ error: 'Order has already been processed' });
    }

    // Capture the payment via PayPal – this is the authoritative verification step
    const accessToken = await getPayPalAccessToken();
    const captureResponse = await fetch(
      `${PAYPAL_BASE_URL}/v2/checkout/orders/${orderData.paypalOrderId}/capture`,
      {
        method: 'POST',
        headers: {
          Authorization:  `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );
    const captureData = await captureResponse.json();

    if (!captureResponse.ok || captureData.status !== 'COMPLETED') {
      console.error('PayPal capture failed:', captureData);
      return res.status(400).json({ error: 'Payment capture failed', details: captureData });
    }

    const payerId       = captureData.payer?.payer_id || null;
    const captureId     = captureData.purchase_units?.[0]?.payments?.captures?.[0]?.id || null;
    const capturedAtTs  = admin.firestore.FieldValue.serverTimestamp();

    // Mark order as completed in Firestore
    await db.collection('orders').doc(orderId).update({
      status:          'completed',
      payerId,
      paypalCaptureId: captureId,
      capturedAt:      capturedAtTs,
    });

    // Create payout records for each seller
    const batch = db.batch();
    (orderData.commissions || []).forEach((commission, idx) => {
      const payoutId  = `payout_${orderId}_${commission.sellerUsername}_${idx}`;
      const payoutRef = db.collection('payouts').doc(payoutId);
      batch.set(payoutRef, {
        payoutId,
        orderId,
        sellerUsername: commission.sellerUsername,
        sellerName:     commission.sellerName,
        amount:         commission.sellerEarnings,
        platformFee:    commission.platformFee,
        status:         'pending_delivery',
        createdAt:      capturedAtTs,
        paidAt:         null,
      });
    });
    await batch.commit();

    res.json({ success: true, orderId, status: 'completed' });
  } catch (error) {
    console.error('Error in POST /api/orders/:orderId/capture:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/orders/:orderId – Retrieve order details (shipping, totals, commission breakdown).
app.get('/api/orders/:orderId', async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not configured' });
    }
    const doc = await db.collection('orders').doc(req.params.orderId).get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'Order not found' });
    }
    res.json({ order: doc.data() });
  } catch (error) {
    console.error('Error in GET /api/orders/:orderId:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /webhook/paypal – Handle PayPal IPN/webhook events to keep order status in sync.
// To enable signature verification, set PAYPAL_WEBHOOK_ID in your environment.
// NOTE: Full cryptographic webhook verification requires access to the raw request body.
// This endpoint uses the JSON-parsed body (suitable for most integrations); if you need
// strict signature verification, configure a dedicated raw-body parser for this route.
app.post('/webhook/paypal', async (req, res) => {
  try {
    const webhookId = process.env.PAYPAL_WEBHOOK_ID;
    const event     = req.body;

    if (!event || !event.event_type) {
      return res.status(400).json({ error: 'Invalid webhook payload' });
    }

    // Optional: verify the webhook signature with PayPal when PAYPAL_WEBHOOK_ID is set
    if (webhookId && PAYPAL_CLIENT_ID && PAYPAL_SECRET) {
      const requiredHeaders = [
        'paypal-auth-algo', 'paypal-cert-url',
        'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time',
      ];
      const missingHeaders = requiredHeaders.filter(h => !req.headers[h]);
      if (missingHeaders.length > 0) {
        return res.status(400).json({ error: `Missing required webhook headers: ${missingHeaders.join(', ')}` });
      }

      const accessToken = await getPayPalAccessToken();
      const verifyResponse = await fetch(
        `${PAYPAL_BASE_URL}/v1/notifications/verify-webhook-signature`,
        {
          method: 'POST',
          headers: {
            Authorization:  `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            auth_algo:         req.headers['paypal-auth-algo'],
            cert_url:          req.headers['paypal-cert-url'],
            transmission_id:   req.headers['paypal-transmission-id'],
            transmission_sig:  req.headers['paypal-transmission-sig'],
            transmission_time: req.headers['paypal-transmission-time'],
            webhook_id:        webhookId,
            webhook_event:     event,
          }),
        }
      );
      const verification = await verifyResponse.json();
      if (verification.verification_status !== 'SUCCESS') {
        console.warn('PayPal webhook signature verification failed:', verification);
        return res.status(400).json({ error: 'Webhook signature verification failed' });
      }
    }

    const eventType = event.event_type;
    console.log('PayPal webhook received:', eventType);

    if (db) {
      if (eventType === 'PAYMENT.CAPTURE.COMPLETED') {
        // Sync completed status if not already captured via /capture endpoint
        const paypalOrderId = event.resource?.supplementary_data?.related_ids?.order_id;
        if (paypalOrderId) {
          const snapshot = await db.collection('orders')
            .where('paypalOrderId', '==', paypalOrderId)
            .limit(1)
            .get();
          if (!snapshot.empty) {
            const orderDoc = snapshot.docs[0];
            if (orderDoc.data().status === 'pending') {
              await orderDoc.ref.update({
                status:             'completed',
                webhookLastEvent:   eventType,
                updatedAt:          admin.firestore.FieldValue.serverTimestamp(),
              });
            }
          }
        }
      } else if (
        eventType === 'PAYMENT.CAPTURE.DENIED' ||
        eventType === 'PAYMENT.CAPTURE.REVERSED' ||
        eventType === 'PAYMENT.CAPTURE.REFUNDED'
      ) {
        const paypalOrderId = event.resource?.supplementary_data?.related_ids?.order_id;
        if (paypalOrderId) {
          const snapshot = await db.collection('orders')
            .where('paypalOrderId', '==', paypalOrderId)
            .limit(1)
            .get();
          if (!snapshot.empty) {
            await snapshot.docs[0].ref.update({
              status:           'failed',
              webhookLastEvent: eventType,
              updatedAt:        admin.firestore.FieldValue.serverTimestamp(),
            });
          }
        }
      }
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Error in POST /webhook/paypal:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Base URL: ${BASE_URL}`);
  console.log(`💚 Health check: ${BASE_URL}/health`);
  console.log(`💳 Stripe API Key: ${process.env.STRIPE_SECRET_KEY ? 'Configured' : 'NOT SET - Use default test key'}`);
});
