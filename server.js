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
// Returns public configuration values that the frontend needs at runtime.
// Sensitive credentials (e.g. PayPal secret) are never exposed here.
app.get('/api/config', function(req, res) {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  if (!clientId) {
    return res.status(500).json({ error: 'PAYPAL_CLIENT_ID environment variable is not set.' });
  }
  res.json({ paypalClientId: clientId });
});

// ── Orders endpoint stubs (placeholder for future implementation) ──────────────
app.post('/api/orders', function(req, res) {
  res.status(501).json({ error: 'Not implemented' });
});

app.post('/api/orders/:orderId/capture', function(req, res) {
  res.status(501).json({ error: 'Not implemented' });
});

// ── Error handler ──────────────────────────────────────────────────────────────
app.use(function(err, req, res, next) {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', function() {
  console.log('Server running on port ' + PORT);
});
