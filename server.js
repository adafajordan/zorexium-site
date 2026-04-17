'use strict';

const express = require('express');
const app = express();
const path = require('path');

if (!globalThis.fetch) {
  globalThis.fetch = require('node-fetch');
}

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── CORS Middleware ────────────────────────────────────────────────────────────
app.use(function(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ── Health check endpoint (REQUIRED for Render) ────────────────────────────────
app.get('/health', function(req, res) {
  res.status(200).json({ status: 'ok' });
});

// ── Config endpoint ────────────────────────────────────────────────────────────
app.get('/api/config', function(req, res) {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  if (!clientId) {
    return res.status(500).json({ error: 'PAYPAL_CLIENT_ID environment variable is not set.' });
  }
  res.json({ paypalClientId: clientId });
});

// ── PayPal Configuration ───────────────────────────────────────────────────────
const PAYPAL_MODE = process.env.PAYPAL_MODE || 'sandbox';
const PAYPAL_API = PAYPAL_MODE === 'sandbox' 
  ? 'https://api-m.sandbox.paypal.com'
  : 'https://api-m.paypal.com';

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_SECRET = process.env.PAYPAL_SECRET;

// In-memory order storage (use database in production)
let orders = {};

// ── Create Order endpoint ──────────────────────────────────────────────────────
app.post('/api/orders', async function(req, res) {
  try {
    const { items, buyer, shippingMethod } = req.body;
    
    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'No items in order' });
    }
    
    // Mock item prices for testing (in production, look up from database)
    const mockPrices = {
      'gpu-1': 299.99,
      'cpu-1': 199.99,
      'ram-1': 99.99
    };
    
    // Calculate totals
    let subtotal = 0;
    const orderItems = items.map(item => {
      const price = mockPrices[item.id] || 50.00;
      const itemTotal = price * item.quantity;
      subtotal += itemTotal;
      return {
        name: `Product ${item.id}`,
        quantity: String(item.quantity),
        unit_amount: {
          currency_code: 'USD',
          value: price.toFixed(2)
        }
      };
    });
    
    const shipping = Math.max(0, Math.round(subtotal * 0.10 - 0.99)) + 0.99;
    const tax = subtotal * 0.08;
    const total = (subtotal + shipping + tax).toFixed(2);
    
    // Create PayPal order
    const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString('base64');
    const paypalResponse = await fetch(`${PAYPAL_API}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          amount: {
            currency_code: 'USD',
            value: total,
            breakdown: {
              item_total: {
                currency_code: 'USD',
                value: subtotal.toFixed(2)
              },
              shipping: {
                currency_code: 'USD',
                value: shipping.toFixed(2)
              },
              tax_total: {
                currency_code: 'USD',
                value: tax.toFixed(2)
              }
            }
          },
          items: orderItems,
          shipping: {
            name: {
              full_name: `${buyer.firstName} ${buyer.lastName}`
            },
            address: {
              address_line_1: buyer.address.line1,
              address_line_2: buyer.address.line2 || '',
              admin_area_2: buyer.address.city,
              admin_area_1: buyer.address.state,
              postal_code: buyer.address.zip,
              country_code: buyer.address.country
            }
          }
        }]
      })
    });
    
    const paypalOrder = await paypalResponse.json();
    
    if (!paypalResponse.ok) {
      console.error('PayPal error:', paypalOrder);
      throw new Error(paypalOrder.message || 'PayPal order creation failed');
    }
    
    // Store order locally
    const orderId = 'ORD-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    orders[orderId] = {
      id: orderId,
      paypalOrderId: paypalOrder.id,
      items,
      buyer,
      shippingMethod,
      subtotal,
      shipping,
      tax,
      total,
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    
    res.json({
      orderId,
      paypalOrderId: paypalOrder.id
    });
  } catch (error) {
    console.error('Order creation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── Capture Order endpoint ─────────────────────────────────────────────────────
app.post('/api/orders/:orderId/capture', async function(req, res) {
  try {
    const { orderId } = req.params;
    
    if (!orders[orderId]) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    const order = orders[orderId];
    const paypalOrderId = order.paypalOrderId;
    
    // Capture payment on PayPal
    const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString('base64');
    const captureResponse = await fetch(`${PAYPAL_API}/v2/checkout/orders/${paypalOrderId}/capture`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      }
    });
    
    const captureData = await captureResponse.json();
    
    if (!captureResponse.ok) {
      console.error('Capture error:', captureData);
      throw new Error(captureData.message || 'Payment capture failed');
    }
    
    // Update order status
    order.status = 'completed';
    order.paypalCaptureId = captureData.id;
    order.completedAt = new Date().toISOString();
    
    res.json({
      orderId,
      paypalCaptureId: captureData.id,
      status: 'completed'
    });
  } catch (error) {
    console.error('Capture error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── Error handler ───────────────────────────────���──────────────────────────────
app.use(function(err, req, res, next) {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', function() {
  console.log('Server running on port ' + PORT);
});
