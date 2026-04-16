'use strict';

const express = require('express');
const app = express();

if (!globalThis.fetch) {
  globalThis.fetch = require('node-fetch');
}

// Firebase init
const firebase = require('firebase/app');
...
const PAYPAL_MODE = process.env.PAYPAL_MODE || 'sandbox';
// Other existing code continues...
