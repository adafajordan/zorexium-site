'use strict';

const express = require('express');
const app = express();
const path = require('path');

if (!globalThis.fetch) {
  globalThis.fetch = require('node-fetch');
}

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── Config endpoint ───────────────────────────────────────────────────────────
// Returns public configuration values that the frontend needs at runtime.
// Sensitive credentials (e.g. PayPal secret) are never exposed here.
app.get('/api/config', function(req, res) {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  if (!clientId) {
    return res.status(500).json({ error: 'PAYPAL_CLIENT_ID environment variable is not set.' });
  }
  res.json({ paypalClientId: clientId });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, function() {
  console.log('Server running on port ' + PORT);
});
