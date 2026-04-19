'use strict';

const express = require('express');
const app = express();
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { MongoClient, ObjectId } = require('mongodb');
const rateLimit = require('express-rate-limit');

if (!globalThis.fetch) {
  globalThis.fetch = require('node-fetch');
}

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// MongoDB Connection
const MONGO_URI = process.env.MONGO_URI;
console.log('🔍 MONGO_URI exists:', !!MONGO_URI);

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
let db;
let mongoClient;
let mongoConnected = false;

async function connectDB() {
  console.log('🔍 MONGO_URI is', MONGO_URI ? 'SET' : 'NOT SET');
  if (!MONGO_URI) {
    console.error('❌ MONGO_URI environment variable is NOT SET');
    return false;
  }

  try {
    console.log('📡 Attempting to connect to MongoDB...');
    mongoClient = new MongoClient(MONGO_URI, {
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 15000
    });
    await mongoClient.connect();
    db = mongoClient.db('zorexium');

    // Ping to verify connection
    console.log('🏓 Running ping test...');
    await db.admin().ping();

    mongoConnected = true;
    console.log('✅ MongoDB connected and ping successful');
    return true;
  } catch (error) {
    console.error('❌ MongoDB connection failed:');
    console.error('   name   :', error.name);
    console.error('   message:', error.message);
    if (error.code !== undefined) console.error('   code   :', error.code);
    if (error.errorLabels) console.error('   labels :', error.errorLabels);
    if (error.errInfo) console.error('   details:', JSON.stringify(error.errInfo));
    mongoConnected = false;
    return false;
  }
}

// ── Cookie helpers ────────────────────────────────────────────────────────────
function parseCookies(cookieHeader) {
  if (!cookieHeader) return {};
  return cookieHeader.split(';').reduce(function(cookies, cookie) {
    var parts = cookie.trim().split('=');
    var name = parts[0].trim();
    var value = parts.slice(1).join('=').trim();
    try { cookies[name] = decodeURIComponent(value); } catch (e) { cookies[name] = value; }
    return cookies;
  }, {});
}

function buildCookieHeader(name, value, options) {
  var str = name + '=' + encodeURIComponent(value);
  str += '; Path=' + (options.path || '/');
  if (options.maxAge !== undefined) str += '; Max-Age=' + options.maxAge;
  if (options.httpOnly) str += '; HttpOnly';
  if (options.sameSite) str += '; SameSite=' + options.sameSite;
  if (options.secure) str += '; Secure';
  return str;
}

var COOKIE_MAX_AGE = 7 * 24 * 60 * 60; // 7 days in seconds
var isProduction = process.env.NODE_ENV === 'production';

function setAuthCookies(res, token, email, username, userId) {
  var userPayload = JSON.stringify({ email: email, username: username || email, userId: userId || '' });
  res.setHeader('Set-Cookie', [
    buildCookieHeader('authToken', token, {
      httpOnly: true,
      maxAge: COOKIE_MAX_AGE,
      sameSite: 'Strict',
      secure: isProduction
    }),
    buildCookieHeader('_zrx_user', userPayload, {
      httpOnly: false,
      maxAge: COOKIE_MAX_AGE,
      sameSite: 'Strict',
      secure: isProduction
    })
  ]);
}

function clearAuthCookies(res) {
  res.setHeader('Set-Cookie', [
    buildCookieHeader('authToken', '', { httpOnly: true, maxAge: 0, sameSite: 'Strict', secure: isProduction }),
    buildCookieHeader('_zrx_user', '', { httpOnly: false, maxAge: 0, sameSite: 'Strict', secure: isProduction })
  ]);
}

// ── Rate Limiters ─────────────────────────────────────────────────────────────
var authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

var prefsRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

// ── CORS Middleware ────────────────────────────────────────────────────────────
// Only allow credentialed requests from explicitly trusted origins.
var ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',').map(function(o) { return o.trim(); }).filter(Boolean);
// Always allow the production backend origin itself
ALLOWED_ORIGINS.push('https://zorexium-backend.onrender.com');

app.use(function(req, res, next) {
  var origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.indexOf(origin) !== -1) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
  }
  // Unknown origins or same-origin requests: no CORS headers set
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ── JWT Middleware ────────────────────────────────────────────────────────────
function verifyToken(req, res, next) {
  // Accept token from Authorization header (Bearer) or HTTP-only cookie
  var token = req.headers.authorization && req.headers.authorization.split(' ')[1];
  if (!token) {
    var cookies = parseCookies(req.headers.cookie);
    token = cookies['authToken'];
  }
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    req.userEmail = decoded.email;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ── Health check endpoint ────────────────────────────────────────────────────────
app.get('/health', function(req, res) {
  res.status(200).json({ status: 'ok', mongoConnected, mongoUri: MONGO_URI ? 'set' : 'NOT SET' });
});

// ── Config endpoint ────────────────────────────────────────────────────────────
app.get('/api/config', function(req, res) {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  if (!clientId) {
    return res.status(500).json({ error: 'PAYPAL_CLIENT_ID environment variable is not set.' });
  }
  res.json({ paypalClientId: clientId });
});

// ── USER AUTHENTICATION ────────────────────────────────────────────────────────

app.post('/api/auth/register', authRateLimit, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  
  try {
    const { email, password, firstName, lastName } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    
    const existingUser = await db.collection('users').findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: 'User already exists' });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    
    const result = await db.collection('users').insertOne({
      email,
      password: hashedPassword,
      firstName: firstName || '',
      lastName: lastName || '',
      createdAt: new Date()
    });

    const token = jwt.sign(
      { userId: result.insertedId.toString(), email },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    setAuthCookies(res, token, email, firstName || email, result.insertedId.toString());
    res.json({ message: 'User created successfully', userId: result.insertedId, token, user: { email, firstName: firstName || '' } });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/login', authRateLimit, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    
    const user = await db.collection('users').findOne({ email });
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    const token = jwt.sign(
      { userId: user._id.toString(), email: user.email },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    setAuthCookies(res, token, user.email, user.firstName || user.email, user._id.toString());
    res.json({
      token,
      user: {
        id: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── SESSION MANAGEMENT ─────────────────────────────────────────────────────────

// GET /api/auth/session – verify current session and return user info
app.get('/api/auth/session', authRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const user = await db.collection('users').findOne(
      { _id: new ObjectId(req.userId) },
      { projection: { password: 0 } }
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ userId: req.userId, email: req.userEmail, firstName: user.firstName, lastName: user.lastName });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/auth/logout – clear auth cookies
app.post('/api/auth/logout', authRateLimit, function(req, res) {
  clearAuthCookies(res);
  res.json({ message: 'Logged out' });
});

// ── PRODUCTS ────────────────────────────────────────────────────────────────────

app.get('/api/products', async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  
  try {
    const products = await db.collection('products').find().toArray();
    res.json(products);
  } catch (error) {
    console.error('Error fetching products:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/products – create a product (auth required) ─────────────────────
app.post('/api/products', verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  try {
    const { name, price, category, description, image, condition, specifications, sellerName, sellerUsername } = req.body;

    if (!name || price === undefined || price === null || !category) {
      return res.status(400).json({ error: 'name, price, and category are required' });
    }

    const parsedPrice = parseFloat(price);
    if (isNaN(parsedPrice) || parsedPrice < 0) {
      return res.status(400).json({ error: 'price must be a non-negative number' });
    }

    // Resolve display name: use provided sellerName/sellerUsername or fall back to user's firstName from DB
    let resolvedSellerName = (typeof sellerName === 'string' && sellerName.trim()) ? sellerName.trim()
      : (typeof sellerUsername === 'string' && sellerUsername.trim()) ? sellerUsername.trim()
      : null;
    let resolvedSellerUsername = (typeof sellerUsername === 'string' && sellerUsername.trim()) ? sellerUsername.trim() : null;

    if (!resolvedSellerName) {
      try {
        const user = await db.collection('users').findOne(
          { _id: new ObjectId(req.userId) },
          { projection: { firstName: 1 } }
        );
        if (user && user.firstName) resolvedSellerName = user.firstName;
      } catch (lookupErr) {
        console.error('Could not look up user firstName for product attribution:', lookupErr.message);
      }
    }

    const product = {
      name,
      price: parsedPrice,
      category,
      description: description || '',
      image: image || '',
      condition: condition || 'used',
      specifications: specifications || {},
      sellerId: req.userId,
      sellerName: resolvedSellerName || null,
      sellerUsername: resolvedSellerUsername || null,
      status: 'pending',
      createdAt: new Date()
    };

    const result = await db.collection('products').insertOne(product);
    res.status(201).json({ ...product, _id: result.insertedId });
  } catch (error) {
    console.error('Error creating product:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/products/seller/:sellerId – products by seller (public) ───────────
app.get('/api/products/seller/:sellerId', async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  const { sellerId } = req.params;
  if (!sellerId || sellerId.length > 128) {
    return res.status(400).json({ error: 'Invalid sellerId' });
  }

  try {
    const products = await db.collection('products')
      .find({ sellerId })
      .toArray();
    res.json(products);
  } catch (error) {
    console.error('Error fetching seller products:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/products/:id', async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  
  try {
    const product = await db.collection('products').findOne({ 
      _id: new ObjectId(req.params.id) 
    });
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.json(product);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── PUT /api/products/:id – update a product (auth required, owner only) ───────
app.put('/api/products/:id', verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  try {
    let objectId;
    try {
      objectId = new ObjectId(req.params.id);
    } catch {
      return res.status(400).json({ error: 'Invalid product ID' });
    }

    const product = await db.collection('products').findOne({ _id: objectId });
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    if (product.sellerId !== req.userId) {
      return res.status(403).json({ error: 'Forbidden: you do not own this product' });
    }

    const { name, price, category, description, image, condition, specifications, status } = req.body;

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (price !== undefined) {
      const parsedPrice = parseFloat(price);
      if (isNaN(parsedPrice) || parsedPrice < 0) {
        return res.status(400).json({ error: 'price must be a non-negative number' });
      }
      updates.price = parsedPrice;
    }
    if (category !== undefined) updates.category = category;
    if (description !== undefined) updates.description = description;
    if (image !== undefined) updates.image = image;
    if (condition !== undefined) updates.condition = condition;
    if (specifications !== undefined) updates.specifications = specifications;
    if (status !== undefined) {
      const validStatuses = ['pending', 'active', 'approved', 'rejected', 'sold'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
      }
      updates.status = status;
    }
    updates.updatedAt = new Date();

    await db.collection('products').updateOne({ _id: objectId }, { $set: updates });
    const updated = await db.collection('products').findOne({ _id: objectId });
    res.json(updated);
  } catch (error) {
    console.error('Error updating product:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── DELETE /api/products/:id – delete a product (auth required, owner only) ─────
app.delete('/api/products/:id', verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  try {
    let objectId;
    try {
      objectId = new ObjectId(req.params.id);
    } catch (parseErr) {
      console.error('Invalid product ID format:', req.params.id, parseErr.message);
      return res.status(400).json({ error: 'Invalid product ID' });
    }

    const product = await db.collection('products').findOne({ _id: objectId });
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    if (product.sellerId !== req.userId) {
      return res.status(403).json({ error: 'Forbidden: you do not own this product' });
    }

    await db.collection('products').deleteOne({ _id: objectId });
    res.json({ message: 'Product deleted' });
  } catch (error) {
    console.error('Error deleting product:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── CART ────────────────────────────────────────────────────────────────────────

app.get('/api/cart', verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  
  try {
    let cart = await db.collection('carts').findOne({ userId: req.userId });
    if (!cart) {
      cart = { userId: req.userId, items: [] };
    }
    res.json(cart);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/cart', verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  
  try {
    const { items } = req.body;
    
    await db.collection('carts').updateOne(
      { userId: req.userId },
      { $set: { userId: req.userId, items, updatedAt: new Date() } },
      { upsert: true }
    );
    
    res.json({ message: 'Cart updated', items });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/cart', verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  
  try {
    await db.collection('carts').deleteOne({ userId: req.userId });
    res.json({ message: 'Cart cleared' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── PAYPAL CONFIGURATION ───────────────────────────────────────────────────────
const PAYPAL_MODE = process.env.PAYPAL_MODE || 'sandbox';
const PAYPAL_API = PAYPAL_MODE === 'sandbox' 
  ? 'https://api-m.sandbox.paypal.com'
  : 'https://api-m.paypal.com';

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_SECRET = process.env.PAYPAL_SECRET;

// ── CREATE ORDER (No auth required - guest checkout) ────────────────────────────────────────
app.post('/api/orders', async function(req, res) {
  try {
    if (!mongoConnected) {
      return res.status(503).json({ error: 'Database temporarily unavailable. Please try again in a moment.' });
    }

    const { items, buyer, shippingMethod } = req.body;
    
    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'No items in order' });
    }
    
    let subtotal = 0;
    const orderItems = items.map(item => {
      const itemTotal = item.price * item.quantity;
      subtotal += itemTotal;
      return {
        name: item.name || `Product ${item.id}`,
        quantity: String(item.quantity),
        unit_amount: {
          currency_code: 'USD',
          value: parseFloat(item.price).toFixed(2)
        }
      };
    });
    
    const shipping = Math.max(0, Math.round(subtotal * 0.10 - 0.99)) + 0.99;
    const tax = subtotal * 0.08;
    const total = (subtotal + shipping + tax).toFixed(2);
    
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
              item_total: { currency_code: 'USD', value: subtotal.toFixed(2) },
              shipping: { currency_code: 'USD', value: shipping.toFixed(2) },
              tax_total: { currency_code: 'USD', value: tax.toFixed(2) }
            }
          },
          items: orderItems,
          shipping: {
            name: { full_name: `${buyer.firstName} ${buyer.lastName}` },
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
    
    const orderId = 'ORD-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    await db.collection('orders').insertOne({
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
      createdAt: new Date()
    });
    
    res.json({ orderId, paypalOrderId: paypalOrder.id });
  } catch (error) {
    console.error('Order creation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── CAPTURE ORDER (No auth required - guest checkout) ────────────────────────────────────────
app.post('/api/orders/:orderId/capture', async function(req, res) {
  try {
    if (!mongoConnected) {
      return res.status(503).json({ error: 'Database temporarily unavailable. Please try again in a moment.' });
    }

    const { orderId } = req.params;
    const order = await db.collection('orders').findOne({ id: orderId });
    
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString('base64');
    const captureResponse = await fetch(`${PAYPAL_API}/v2/checkout/orders/${order.paypalOrderId}/capture`, {
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
    
    await db.collection('orders').updateOne(
      { id: orderId },
      {
        $set: {
          status: 'completed',
          paypalCaptureId: captureData.id,
          completedAt: new Date()
        }
      }
    );

    // Auto-create payout entry for this order
    try {
      const existingPayout = await db.collection('payouts').findOne({ orderId: order.id });
      if (!existingPayout) {
        const totalAmount = parseFloat(order.total) || 0;
        const platformFee = parseFloat((totalAmount * 0.1).toFixed(2));
        const payoutAmount = parseFloat((totalAmount * 0.9).toFixed(2));
        const firstItem = Array.isArray(order.items) && order.items[0] ? order.items[0] : {};
        await db.collection('payouts').insertOne({
          orderId: order.id,
          sellerUsername: firstItem.sellerUsername || '',
          sellerName: firstItem.sellerName || firstItem.sellerUsername || '',
          amount: payoutAmount,
          platformFee,
          status: 'pending_delivery',
          placedAt: order.createdAt || new Date(),
          createdAt: new Date()
        });
      }
    } catch (payoutErr) {
      console.error('Failed to create payout entry:', payoutErr.message);
    }

    res.json({ orderId, paypalCaptureId: captureData.id, status: 'completed' });
  } catch (error) {
    console.error('Capture error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── GET USER ORDERS ────────────────────────────────────────────────────────────
app.get('/api/orders', verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  
  try {
    const orders = await db.collection('orders').find({}).toArray();
    res.json(orders);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── GET SINGLE ORDER BY ORDER ID (public, order ID is unguessable) ─────────────
app.get('/api/orders/:orderId', async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  const { orderId } = req.params;
  if (!orderId || orderId.length > 64) {
    return res.status(400).json({ error: 'Invalid orderId' });
  }

  try {
    const order = await db.collection('orders').findOne({ id: orderId });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    // Return order without internal MongoDB _id, keeping buyer info for confirmation display
    res.json(order);
  } catch (error) {
    console.error('Error fetching order:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── COMMUNITY POSTS ────────────────────────────────────────────────────────────

// POST /api/posts – create a post (auth required)
app.post('/api/posts', verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  const { title, content, boardType, imageUrl } = req.body;
  if (!title || !content || !boardType) {
    return res.status(400).json({ error: 'title, content, and boardType are required' });
  }
  if (typeof title !== 'string' || title.length < 1 || title.length > 200) {
    return res.status(400).json({ error: 'Invalid title' });
  }
  if (typeof content !== 'string' || content.length < 1 || content.length > 5000) {
    return res.status(400).json({ error: 'Invalid content' });
  }
  if (typeof boardType !== 'string' || boardType.length > 64) {
    return res.status(400).json({ error: 'Invalid boardType' });
  }
  if (imageUrl !== undefined && imageUrl !== null && imageUrl !== '') {
    if (typeof imageUrl !== 'string' || imageUrl.length > 2000) {
      return res.status(400).json({ error: 'Invalid imageUrl' });
    }
    try {
      const parsed = new URL(imageUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return res.status(400).json({ error: 'imageUrl must use http or https protocol' });
      }
    } catch (_) {
      return res.status(400).json({ error: 'imageUrl is not a valid URL' });
    }
  }

  try {
    let username = req.userEmail;
    try {
      const userDoc = await db.collection('users').findOne({ _id: new ObjectId(req.userId) });
      if (userDoc) {
        const fullName = ((userDoc.firstName || '') + ' ' + (userDoc.lastName || '')).trim();
        username = fullName || userDoc.email || req.userEmail;
      }
    } catch (_) {}

    const post = {
      userId: req.userId,
      email: req.userEmail,
      username,
      title,
      content,
      boardType,
      createdAt: new Date(),
      replies: [],
      likes: []
    };
    if (imageUrl && typeof imageUrl === 'string' && imageUrl.length > 0) {
      post.imageUrl = imageUrl;
    }
    const result = await db.collection('posts').insertOne(post);
    res.status(201).json({ ...post, _id: result.insertedId });
  } catch (error) {
    console.error('Error creating post:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/posts – fetch posts by boardType (public)
app.get('/api/posts', async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  const { boardType } = req.query;
  if (!boardType || typeof boardType !== 'string' || boardType.length > 64) {
    return res.status(400).json({ error: 'boardType query parameter is required' });
  }

  try {
    const posts = await db.collection('posts')
      .find({ boardType })
      .sort({ createdAt: -1 })
      .toArray();

    // Collect all unique userIds from posts and their replies
    const userIdSet = new Set();
    for (const post of posts) {
      if (post.userId) userIdSet.add(post.userId);
      for (const reply of (post.replies || [])) {
        if (reply.userId) userIdSet.add(reply.userId);
      }
    }

    // Batch-fetch user documents and build userId -> displayName and profileImage maps
    const usernameMap = {};
    const profileImageMap = {};
    if (userIdSet.size > 0) {
      const userIds = Array.from(userIdSet).map(id => { try { return new ObjectId(id); } catch (_) { return null; } }).filter(Boolean);
      const users = await db.collection('users').find({ _id: { $in: userIds } }).toArray();
      for (const user of users) {
        const fullName = ((user.firstName || '') + ' ' + (user.lastName || '')).trim();
        usernameMap[user._id.toString()] = fullName || user.email;
        if (user.profileImage) profileImageMap[user._id.toString()] = user.profileImage;
      }
    }

    // Enrich posts with current display name and profile image
    const enriched = posts.map(post => {
      const displayName = (post.userId && usernameMap[post.userId]) || post.username || post.email;
      const profileImage = (post.userId && profileImageMap[post.userId]) || null;
      return {
        ...post,
        username: displayName,
        profileImage,
        replies: (post.replies || []).map(reply => ({
          ...reply,
          username: (reply.userId && usernameMap[reply.userId]) || reply.username || reply.email,
          profileImage: (reply.userId && profileImageMap[reply.userId]) || null
        }))
      };
    });

    res.json(enriched);
  } catch (error) {
    console.error('Error fetching posts:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/posts/:postId/replies – add a reply to a post (auth required)
app.post('/api/posts/:postId/replies', verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  const { postId } = req.params;
  const { content } = req.body;

  if (!content || typeof content !== 'string' || content.length < 1 || content.length > 2000) {
    return res.status(400).json({ error: 'Valid content is required' });
  }

  let objectId;
  try {
    objectId = new ObjectId(postId);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid postId' });
  }

  try {
    let username = req.userEmail;
    try {
      const userDoc = await db.collection('users').findOne({ _id: new ObjectId(req.userId) });
      if (userDoc) {
        const fullName = ((userDoc.firstName || '') + ' ' + (userDoc.lastName || '')).trim();
        username = fullName || userDoc.email || req.userEmail;
      }
    } catch (_) {}

    const reply = {
      userId: req.userId,
      email: req.userEmail,
      username,
      content,
      createdAt: new Date()
    };
    const result = await db.collection('posts').updateOne(
      { _id: objectId },
      { $push: { replies: reply } }
    );
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }
    res.status(201).json(reply);
  } catch (error) {
    console.error('Error adding reply:', error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/posts/:postId – delete a post (auth required, owner only)
app.delete('/api/posts/:postId', verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  const { postId } = req.params;

  let objectId;
  try {
    objectId = new ObjectId(postId);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid postId' });
  }

  try {
    const post = await db.collection('posts').findOne({ _id: objectId });
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }
    if (post.userId !== req.userId) {
      return res.status(403).json({ error: 'Not authorized to delete this post' });
    }
    await db.collection('posts').deleteOne({ _id: objectId });
    res.json({ message: 'Post deleted' });
  } catch (error) {
    console.error('Error deleting post:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/posts/:postId/like – toggle like on a post (auth required)
app.post('/api/posts/:postId/like', verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  const { postId } = req.params;

  let objectId;
  try {
    objectId = new ObjectId(postId);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid postId' });
  }

  try {
    const post = await db.collection('posts').findOne({ _id: objectId }, { projection: { likes: 1 } });
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }
    const likes = post.likes || [];
    const hasLiked = likes.includes(req.userId);
    if (hasLiked) {
      await db.collection('posts').updateOne({ _id: objectId }, { $pull: { likes: req.userId } });
      return res.json({ likeCount: likes.length - 1, liked: false });
    } else {
      await db.collection('posts').updateOne({ _id: objectId }, { $push: { likes: req.userId } });
      return res.json({ likeCount: likes.length + 1, liked: true });
    }
  } catch (error) {
    console.error('Error toggling like:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── PROFILE PICTURE ────────────────────────────────────────────────────────────

// PUT /api/user/profile-picture – save profile picture (auth required)
app.put('/api/user/profile-picture', verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  const { profileImage } = req.body;

  if (!profileImage || typeof profileImage !== 'string') {
    return res.status(400).json({ error: 'profileImage is required' });
  }

  // Accept only data URLs (base64-encoded images)
  if (!profileImage.startsWith('data:image/')) {
    return res.status(400).json({ error: 'profileImage must be a base64 data URL (data:image/...)' });
  }

  // Limit to ~5 MB (base64 ~6.7 MB raw limit)
  if (profileImage.length > 7 * 1024 * 1024) {
    return res.status(400).json({ error: 'Profile image is too large (max ~5 MB)' });
  }

  try {
    await db.collection('users').updateOne(
      { _id: new ObjectId(req.userId) },
      { $set: { profileImage, updatedAt: new Date() } }
    );
    res.json({ message: 'Profile picture updated', profileImage });
  } catch (error) {
    console.error('Error saving profile picture:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/user/profile-picture – retrieve profile picture (auth required)
app.get('/api/user/profile-picture', verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  try {
    const user = await db.collection('users').findOne(
      { _id: new ObjectId(req.userId) },
      { projection: { profileImage: 1 } }
    );
    res.json({ profileImage: (user && user.profileImage) || null });
  } catch (error) {
    console.error('Error fetching profile picture:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/user/info – retrieve display name and profile picture for a user by email or userId (auth required)
app.get('/api/user/info', verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  const { email, userId } = req.query;

  try {
    let user;
    if (userId) {
      // Validate userId is a plausible MongoDB ObjectId (24 hex chars)
      if (typeof userId !== 'string' || userId.length > 128) {
        return res.status(400).json({ error: 'Invalid userId' });
      }
      let query;
      try { query = { _id: new ObjectId(userId) }; } catch (_) { return res.json({ displayName: userId, profileImage: null }); }
      user = await db.collection('users').findOne(query, { projection: { firstName: 1, lastName: 1, profileImage: 1, email: 1 } });
      if (!user) return res.json({ displayName: userId, profileImage: null });
      const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ');
      return res.json({ displayName: fullName || user.email || userId, profileImage: user.profileImage || null });
    }

    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'email or userId query parameter is required' });
    }
    // Basic email format validation
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    user = await db.collection('users').findOne(
      { email },
      { projection: { firstName: 1, lastName: 1, profileImage: 1 } }
    );
    if (!user) {
      return res.json({ displayName: email, profileImage: null });
    }
    const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ');
    res.json({ displayName: fullName || email, profileImage: user.profileImage || null });
  } catch (error) {
    console.error('Error fetching user info:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/user/public-info – retrieve display name and profile picture for a user by email (no auth required)
app.get('/api/user/public-info', async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  const { email } = req.query;
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'email query parameter is required' });
  }
  // Basic email format validation
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  try {
    const user = await db.collection('users').findOne(
      { email },
      { projection: { firstName: 1, lastName: 1, profileImage: 1 } }
    );
    if (!user) {
      return res.json({ displayName: null, profileImage: null, userId: null });
    }
    const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ');
    res.json({ displayName: fullName || email, profileImage: user.profileImage || null, userId: user._id ? user._id.toString() : null });
  } catch (error) {
    console.error('Error fetching public user info:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── USER PROFILE ────────────────────────────────────────────────────────────────

// GET /api/user/profile – get current user's full profile (auth required)
app.get('/api/user/profile', verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  try {
    const user = await db.collection('users').findOne(
      { _id: new ObjectId(req.userId) },
      { projection: { password: 0 } }
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (error) {
    console.error('Error fetching user profile:', error);
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/user/profile – update current user's profile (auth required)
app.put('/api/user/profile', verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  const { firstName, lastName, phone } = req.body;
  const updates = { updatedAt: new Date() };
  if (firstName !== undefined) updates.firstName = String(firstName).slice(0, 100);
  if (lastName !== undefined) updates.lastName = String(lastName).slice(0, 100);
  if (phone !== undefined) updates.phone = String(phone).slice(0, 30);

  try {
    await db.collection('users').updateOne(
      { _id: new ObjectId(req.userId) },
      { $set: updates }
    );
    const updated = await db.collection('users').findOne(
      { _id: new ObjectId(req.userId) },
      { projection: { password: 0 } }
    );
    res.json(updated);
  } catch (error) {
    console.error('Error updating user profile:', error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/user/profile – delete current user's account (auth required)
app.delete('/api/user/profile', authRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  try {
    await db.collection('users').deleteOne({ _id: new ObjectId(req.userId) });
    await db.collection('sellers').deleteOne({ userId: req.userId });
    await db.collection('carts').deleteOne({ userId: req.userId });
    clearAuthCookies(res);
    res.json({ message: 'Account deleted' });
  } catch (error) {
    console.error('Error deleting account:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/user/preferences – get user preferences (auth optional, uses userId or sessionId)
app.get('/api/user/preferences', prefsRateLimit, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  var token = req.headers.authorization && req.headers.authorization.split(' ')[1];
  if (!token) { var c = parseCookies(req.headers.cookie); token = c['authToken']; }
  var userId = null;
  if (token) {
    try { var d = jwt.verify(token, JWT_SECRET); userId = d.userId; } catch (_) {}
  }
  if (!userId) return res.json({ cookieConsent: null });
  try {
    var prefs = await db.collection('userPreferences').findOne({ userId });
    res.json(prefs || { cookieConsent: null });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/user/preferences – save user preferences (auth optional)
app.post('/api/user/preferences', prefsRateLimit, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  var token = req.headers.authorization && req.headers.authorization.split(' ')[1];
  if (!token) { var c = parseCookies(req.headers.cookie); token = c['authToken']; }
  var userId = null;
  if (token) {
    try { var d = jwt.verify(token, JWT_SECRET); userId = d.userId; } catch (_) {}
  }
  const { cookieConsent } = req.body;
  if (userId) {
    try {
      await db.collection('userPreferences').updateOne(
        { userId },
        { $set: { userId, cookieConsent, updatedAt: new Date() } },
        { upsert: true }
      );
    } catch (_) {}
  }
  res.json({ cookieConsent });
});

// POST /api/auth/change-password – change current user's password (auth required)
app.post('/api/auth/change-password', authRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'currentPassword and newPassword are required' });
  }
  if (typeof newPassword !== 'string' || newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }

  try {
    const user = await db.collection('users').findOne({ _id: new ObjectId(req.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    const hashed = await bcrypt.hash(newPassword, 10);
    await db.collection('users').updateOne(
      { _id: new ObjectId(req.userId) },
      { $set: { password: hashed, updatedAt: new Date() } }
    );
    res.json({ message: 'Password updated' });
  } catch (error) {
    console.error('Error changing password:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── SELLERS ──────────────────────────────────────────────────────────────────────

// POST /api/sellers – create seller profile (auth required)
app.post('/api/sellers', verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  try {
    const existing = await db.collection('sellers').findOne({ userId: req.userId });
    if (existing) return res.status(400).json({ error: 'Seller profile already exists' });

    const {
      accountType, shopName, shopDescription, businessEmail, phoneNumber,
      businessAddress, businessCity, businessState, businessZip,
      personalName, personalEmail, shippingAddress, shippingCity, shippingState, shippingZip
    } = req.body;

    if (!accountType || !shopName) {
      return res.status(400).json({ error: 'accountType and shopName are required' });
    }

    const seller = {
      userId: req.userId,
      accountType: String(accountType).slice(0, 20),
      shopName: String(shopName).slice(0, 200),
      shopDescription: String(shopDescription || '').slice(0, 2000),
      businessEmail: String(businessEmail || '').slice(0, 200),
      phoneNumber: String(phoneNumber || '').slice(0, 30),
      businessAddress: String(businessAddress || '').slice(0, 200),
      businessCity: String(businessCity || '').slice(0, 100),
      businessState: String(businessState || '').slice(0, 100),
      businessZip: String(businessZip || '').slice(0, 20),
      personalName: String(personalName || '').slice(0, 200),
      personalEmail: String(personalEmail || '').slice(0, 200),
      shippingAddress: String(shippingAddress || '').slice(0, 200),
      shippingCity: String(shippingCity || '').slice(0, 100),
      shippingState: String(shippingState || '').slice(0, 100),
      shippingZip: String(shippingZip || '').slice(0, 20),
      joinDate: new Date(),
      rating: 5,
      totalSales: 0,
      isVerified: false,
      createdAt: new Date()
    };

    const result = await db.collection('sellers').insertOne(seller);

    // Mark user as seller
    await db.collection('users').updateOne(
      { _id: new ObjectId(req.userId) },
      { $set: { isSeller: true, updatedAt: new Date() } }
    );

    res.status(201).json({ ...seller, _id: result.insertedId });
  } catch (error) {
    console.error('Error creating seller:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/sellers/me – get current user's seller profile (auth required)
app.get('/api/sellers/me', verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  try {
    const seller = await db.collection('sellers').findOne({ userId: req.userId });
    if (!seller) return res.status(404).json({ error: 'Seller profile not found' });
    res.json(seller);
  } catch (error) {
    console.error('Error fetching seller profile:', error);
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/sellers/me – update current user's seller profile (auth required)
app.put('/api/sellers/me', verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  const allowedFields = [
    'shopName', 'shopDescription', 'businessEmail', 'phoneNumber',
    'businessAddress', 'businessCity', 'businessState', 'businessZip',
    'personalName', 'personalEmail', 'shippingAddress', 'shippingCity',
    'shippingState', 'shippingZip', 'stripeAccountId', 'stripeVerified'
  ];
  const updates = { updatedAt: new Date() };
  const stringFields = [
    'shopName', 'shopDescription', 'businessEmail', 'phoneNumber',
    'businessAddress', 'businessCity', 'businessState', 'businessZip',
    'personalName', 'personalEmail', 'shippingAddress', 'shippingCity',
    'shippingState', 'shippingZip', 'stripeAccountId'
  ];
  for (const field of stringFields) {
    if (req.body[field] !== undefined) updates[field] = String(req.body[field]).slice(0, 2000);
  }
  if (req.body.stripeVerified !== undefined) {
    updates.stripeVerified = Boolean(req.body.stripeVerified);
  }

  try {
    const result = await db.collection('sellers').updateOne(
      { userId: req.userId },
      { $set: updates }
    );
    if (result.matchedCount === 0) return res.status(404).json({ error: 'Seller profile not found' });
    const updated = await db.collection('sellers').findOne({ userId: req.userId });
    res.json(updated);
  } catch (error) {
    console.error('Error updating seller profile:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/sellers/user/:userId – get seller profile by userId (public)
app.get('/api/sellers/user/:userId', async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  const { userId } = req.params;
  if (!userId || userId.length > 128) {
    return res.status(400).json({ error: 'Invalid userId' });
  }

  try {
    const seller = await db.collection('sellers').findOne({ userId });
    if (!seller) return res.status(404).json({ error: 'Seller not found' });
    res.json(seller);
  } catch (error) {
    console.error('Error fetching seller by userId:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── MESSAGES ────────────────────────────────────────────────────────────────────

// GET /api/messages – get all conversations for current user (auth required)
app.get('/api/messages', verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  try {
    const messages = await db.collection('messages')
      .find({ $or: [{ fromUserId: req.userId }, { toUserId: req.userId }] })
      .sort({ createdAt: 1 })
      .toArray();
    res.json(messages);
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/messages – send a message (auth required)
app.post('/api/messages', verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  const { toUserId, subject, body } = req.body;
  if (!toUserId || !subject || !body) {
    return res.status(400).json({ error: 'toUserId, subject, and body are required' });
  }
  if (typeof subject !== 'string' || subject.length > 200) {
    return res.status(400).json({ error: 'Invalid subject' });
  }
  if (typeof body !== 'string' || body.length > 5000) {
    return res.status(400).json({ error: 'Invalid body' });
  }

  try {
    // Resolve sender display name
    let fromDisplayName = req.userEmail;
    try {
      const userDoc = await db.collection('users').findOne({ _id: new ObjectId(req.userId) });
      if (userDoc) {
        const fullName = ((userDoc.firstName || '') + ' ' + (userDoc.lastName || '')).trim();
        fromDisplayName = fullName || userDoc.email || req.userEmail;
      }
    } catch (_) {}

    const message = {
      fromUserId: req.userId,
      fromEmail: req.userEmail,
      fromDisplayName,
      toUserId: String(toUserId),
      subject: subject.trim(),
      body: body.trim(),
      read: false,
      createdAt: new Date()
    };

    const result = await db.collection('messages').insertOne(message);
    res.status(201).json({ ...message, _id: result.insertedId });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/messages/:id/read – mark message as read (auth required)
app.put('/api/messages/:id/read', verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  let objectId;
  try {
    objectId = new ObjectId(req.params.id);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid message ID' });
  }

  try {
    const msg = await db.collection('messages').findOne({ _id: objectId });
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    if (msg.toUserId !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    await db.collection('messages').updateOne({ _id: objectId }, { $set: { read: true } });
    res.json({ message: 'Marked as read' });
  } catch (error) {
    console.error('Error marking message as read:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── VERIFIED LABS ────────────────────────────────────────────────────────────────

// GET /api/labs – get all labs (public)
app.get('/api/labs', async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  try {
    const labs = await db.collection('labs').find().sort({ createdAt: -1 }).toArray();
    res.json(labs);
  } catch (error) {
    console.error('Error fetching labs:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/labs – create a lab (auth required)
app.post('/api/labs', verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  const { name, location, description, files } = req.body;

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'Lab name is required' });
  }
  if (name.length > 200) {
    return res.status(400).json({ error: 'Lab name is too long (max 200 characters)' });
  }

  const sanitizedFiles = [];
  if (Array.isArray(files)) {
    for (const f of files) {
      if (!f || typeof f.data !== 'string') continue;
      if (!f.data.startsWith('data:')) continue;
      if (f.data.length > 7 * 1024 * 1024) {
        return res.status(400).json({ error: 'One or more files are too large (max ~5 MB each, base64 limit ~7 MB)' });
      }
      sanitizedFiles.push({
        name: String(f.name || '').slice(0, 200),
        type: String(f.type || '').slice(0, 100),
        size: Number(f.size) || 0,
        data: f.data
      });
    }
  }

  try {
    const lab = {
      userId: req.userId,
      name: name.trim().slice(0, 200),
      location: String(location || '').trim().slice(0, 200),
      description: String(description || '').trim().slice(0, 2000),
      files: sanitizedFiles,
      createdAt: new Date()
    };
    const result = await db.collection('labs').insertOne(lab);
    res.status(201).json({ ...lab, _id: result.insertedId });
  } catch (error) {
    console.error('Error creating lab:', error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/labs/:id – delete a lab (auth required, owner only)
app.delete('/api/labs/:id', verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  let objectId;
  try {
    objectId = new ObjectId(req.params.id);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid lab ID' });
  }

  try {
    const lab = await db.collection('labs').findOne({ _id: objectId });
    if (!lab) return res.status(404).json({ error: 'Lab not found' });
    if (lab.userId !== req.userId) return res.status(403).json({ error: 'Forbidden: you do not own this lab' });
    await db.collection('labs').deleteOne({ _id: objectId });
    res.json({ message: 'Lab deleted' });
  } catch (error) {
    console.error('Error deleting lab:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── PAYOUTS ───────────────────────────────────────────────────────────────────────

// GET /api/payouts – get all payouts (auth required)
app.get('/api/payouts', verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  try {
    const payouts = await db.collection('payouts').find().sort({ createdAt: -1 }).toArray();
    res.json(payouts);
  } catch (error) {
    console.error('Error fetching payouts:', error);
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/payouts/:id – update payout status (auth required)
app.put('/api/payouts/:id', verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  let objectId;
  try {
    objectId = new ObjectId(req.params.id);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid payout ID' });
  }

  const { status } = req.body;
  const validStatuses = ['pending_delivery', 'ready_to_pay', 'paid'];
  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
  }

  try {
    const payout = await db.collection('payouts').findOne({ _id: objectId });
    if (!payout) return res.status(404).json({ error: 'Payout not found' });

    const updates = { status, updatedAt: new Date() };
    if (status === 'ready_to_pay') updates.deliveredAt = new Date();
    if (status === 'paid') updates.paidAt = new Date();

    await db.collection('payouts').updateOne({ _id: objectId }, { $set: updates });
    const updated = await db.collection('payouts').findOne({ _id: objectId });
    res.json(updated);
  } catch (error) {
    console.error('Error updating payout:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── Error handler ──────────────────────────────────────────────────────────────
app.use(function(err, req, res, next) {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 5000;

// Start server and connect to MongoDB
async function start() {
  console.log('🚀 Starting server...');
  try {
    const connected = await connectDB();
    if (connected) {
      console.log('✅ Database connected — starting HTTP server');
    } else {
      console.error('⚠️  Database NOT connected — starting HTTP server anyway (endpoints will return 503)');
    }
  } catch (err) {
    console.error('❌ Unexpected error during DB connection:', err);
  }

  app.listen(PORT, '0.0.0.0', function() {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📦 MongoDB connected: ${mongoConnected}`);
    console.log(`🔍 MONGO_URI set: ${!!MONGO_URI}`);
  });
}

start().catch(function(err) {
  console.error('❌ Fatal startup error:', err);
  process.exit(1);
});
