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
      sameSite: 'Lax',
      secure: isProduction
    }),
    buildCookieHeader('_zrx_user', userPayload, {
      httpOnly: false,
      maxAge: COOKIE_MAX_AGE,
      sameSite: 'Lax',
      secure: isProduction
    })
  ]);
}

function clearAuthCookies(res) {
  res.setHeader('Set-Cookie', [
    buildCookieHeader('authToken', '', { httpOnly: true, maxAge: 0, sameSite: 'Lax', secure: isProduction }),
    buildCookieHeader('_zrx_user', '', { httpOnly: false, maxAge: 0, sameSite: 'Lax', secure: isProduction })
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

var publicApiRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

// ── CORS Middleware ────────────────────────────────────────────────────────────
// Only allow credentialed requests from explicitly trusted origins.
var ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',').map(function(o) { return o.trim(); }).filter(Boolean);
// Always allow the production frontend and backend origins
ALLOWED_ORIGINS.push('https://zorexiumlabs.com');
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

app.get('/api/products', publicApiRateLimit, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  
  try {
    const query = {};
    const brand = req.query.brand;
    if (brand) {
      // Escape all special regex characters before building the pattern
      const escapedBrand = brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const brandRe = new RegExp(escapedBrand, 'i');
      query.$or = [
        { brand: brandRe },
        { sellerName: brandRe },
        { name: brandRe }
      ];
    }
    // By default only return active products; pass ?all=true to override (e.g. for admin/seller views)
    if (req.query.all !== 'true') {
      query.status = 'active';
    }
    const products = await db.collection('products').find(query).toArray();
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
    const {
      name, price, category, description, image, condition, specifications, sellerName, sellerUsername,
      brand, model, productType, subcategory, tags, attributes, variations,
      images, sku, gtin, salePrice, originalPrice, quantity, minQty, maxQty,
      lowStockThreshold, trackInventory, shipping, shortDescription, features,
      videoUrl, documents, compliance, status
    } = req.body;

    if (!name || price === undefined || price === null || !category) {
      return res.status(400).json({ error: 'name, price, and category are required' });
    }

    const parsedPrice = parseFloat(price);
    if (isNaN(parsedPrice) || parsedPrice < 0) {
      return res.status(400).json({ error: 'price must be a non-negative number' });
    }

    // Validate status if provided; allow draft on POST
    const validStatuses = ['pending', 'active', 'approved', 'rejected', 'sold', 'draft'];
    const resolvedStatus = (status && validStatuses.includes(status)) ? status : 'pending';

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

    const parsedSalePrice = (salePrice != null && salePrice !== '') ? parseFloat(salePrice) : null;
    const parsedOriginalPrice = (originalPrice != null && originalPrice !== '') ? parseFloat(originalPrice) : null;

    const product = {
      name,
      price: parsedPrice,
      salePrice: (!isNaN(parsedSalePrice) && parsedSalePrice !== null) ? parsedSalePrice : null,
      originalPrice: (!isNaN(parsedOriginalPrice) && parsedOriginalPrice !== null) ? parsedOriginalPrice : null,
      category,
      subcategory: subcategory || '',
      description: description || '',
      shortDescription: shortDescription || '',
      image: image || (Array.isArray(images) && images.length ? images[0] : ''),
      images: Array.isArray(images) ? images : (image ? [image] : []),
      condition: condition || 'new',
      specifications: specifications || {},
      brand: brand || '',
      model: model || '',
      productType: productType || '',
      tags: tags || '',
      attributes: Array.isArray(attributes) ? attributes : [],
      variations: Array.isArray(variations) ? variations : [],
      sku: sku || '',
      gtin: gtin || '',
      quantity: parseInt(quantity) || 0,
      minQty: parseInt(minQty) || 1,
      maxQty: maxQty != null ? parseInt(maxQty) : null,
      lowStockThreshold: lowStockThreshold != null ? parseInt(lowStockThreshold) : null,
      trackInventory: trackInventory === true || trackInventory === 'true',
      shipping: shipping || {},
      features: Array.isArray(features) ? features : [],
      videoUrl: videoUrl || '',
      documents: Array.isArray(documents) ? documents : [],
      compliance: compliance || {},
      rating: null,
      reviewCount: 0,
      sellerId: req.userId,
      sellerName: resolvedSellerName || null,
      sellerUsername: resolvedSellerUsername || null,
      status: resolvedStatus,
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

    const {
      name, price, category, description, image, condition, specifications, status,
      brand, model, productType, subcategory, tags, attributes, variations,
      images, sku, gtin, salePrice, originalPrice, quantity, minQty, maxQty,
      lowStockThreshold, trackInventory, shipping, shortDescription, features,
      videoUrl, documents, compliance
    } = req.body;

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (price !== undefined) {
      const parsedPrice = parseFloat(price);
      if (isNaN(parsedPrice) || parsedPrice < 0) {
        return res.status(400).json({ error: 'price must be a non-negative number' });
      }
      updates.price = parsedPrice;
    }
    if (salePrice !== undefined) updates.salePrice = salePrice != null ? parseFloat(salePrice) : null;
    if (originalPrice !== undefined) updates.originalPrice = originalPrice != null ? parseFloat(originalPrice) : null;
    if (category !== undefined) updates.category = category;
    if (subcategory !== undefined) updates.subcategory = subcategory;
    if (description !== undefined) updates.description = description;
    if (shortDescription !== undefined) updates.shortDescription = shortDescription;
    if (image !== undefined) updates.image = image;
    if (images !== undefined) updates.images = Array.isArray(images) ? images : [];
    if (condition !== undefined) updates.condition = condition;
    if (specifications !== undefined) updates.specifications = specifications;
    if (brand !== undefined) updates.brand = brand;
    if (model !== undefined) updates.model = model;
    if (productType !== undefined) updates.productType = productType;
    if (tags !== undefined) updates.tags = tags;
    if (attributes !== undefined) updates.attributes = Array.isArray(attributes) ? attributes : [];
    if (variations !== undefined) updates.variations = Array.isArray(variations) ? variations : [];
    if (sku !== undefined) updates.sku = sku;
    if (gtin !== undefined) updates.gtin = gtin;
    if (quantity !== undefined) updates.quantity = parseInt(quantity) || 0;
    if (minQty !== undefined) updates.minQty = parseInt(minQty) || 1;
    if (maxQty !== undefined) updates.maxQty = maxQty != null ? parseInt(maxQty) : null;
    if (lowStockThreshold !== undefined) updates.lowStockThreshold = lowStockThreshold != null ? parseInt(lowStockThreshold) : null;
    if (trackInventory !== undefined) updates.trackInventory = trackInventory === true || trackInventory === 'true';
    if (shipping !== undefined) updates.shipping = shipping;
    if (features !== undefined) updates.features = Array.isArray(features) ? features : [];
    if (videoUrl !== undefined) updates.videoUrl = videoUrl;
    if (documents !== undefined) updates.documents = Array.isArray(documents) ? documents : [];
    if (compliance !== undefined) updates.compliance = compliance;
    if (status !== undefined) {
      const validStatuses = ['pending', 'active', 'approved', 'rejected', 'sold', 'draft'];
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

// ── PATCH /api/products/:id/status – list or unlist a product (auth required, owner only) ─────
app.patch('/api/products/:id/status', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  try {
    let objectId;
    try {
      objectId = new ObjectId(req.params.id);
    } catch {
      return res.status(400).json({ error: 'Invalid product ID' });
    }

    const product = await db.collection('products').findOne({ _id: objectId });
    if (!product) return res.status(404).json({ error: 'Product not found' });
    if (product.sellerId !== req.userId) return res.status(403).json({ error: 'Forbidden: you do not own this product' });

    const { status } = req.body;
    if (!status || !['active', 'draft'].includes(status)) {
      return res.status(400).json({ error: 'status must be "active" or "draft"' });
    }

    await db.collection('products').updateOne({ _id: objectId }, { $set: { status, updatedAt: new Date() } });
    const updated = await db.collection('products').findOne({ _id: objectId });
    res.json(updated);
  } catch (error) {
    console.error('Error updating product status:', error);
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
    
    const shipping = items.length * 10.99;
    const tax = subtotal * 0.10;
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

// GET /api/orders/my – get orders for the currently logged-in user (auth required)
// Must be defined before /api/orders/:orderId to avoid Express capturing 'my' as a param
app.get('/api/orders/my', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const orders = await db.collection('orders')
      .find({ $or: [{ userId: req.userId }, { buyerEmail: req.userEmail }] })
      .sort({ createdAt: -1 })
      .toArray();
    res.json(orders);
  } catch (error) {
    console.error('Error fetching user orders:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/orders/guest – look up a guest order by orderId + email (public)
app.get('/api/orders/guest', publicApiRateLimit, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  const { orderId, email } = req.query;
  if (!orderId || !email) {
    return res.status(400).json({ error: 'orderId and email are required' });
  }
  if (typeof orderId !== 'string' || orderId.length > 64) {
    return res.status(400).json({ error: 'Invalid orderId' });
  }
  if (typeof email !== 'string' || email.length > 254) {
    return res.status(400).json({ error: 'Invalid email' });
  }
  // Normalize email and use exact equality to avoid ReDoS risk
  const normalizedEmail = email.trim().toLowerCase();
  try {
    const order = await db.collection('orders').findOne({
      $or: [{ id: orderId }, { orderId: orderId }],
      buyerEmail: normalizedEmail
    });
    if (!order) return res.status(404).json({ error: 'Order not found. Please check the order ID and email address.' });
    res.json(order);
  } catch (error) {
    console.error('Error fetching guest order:', error);
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
  const resolvedBoardType = (boardType && typeof boardType === 'string' && boardType.trim()) ? boardType.trim() : 'general';
  if (!title || !content) {
    return res.status(400).json({ error: 'title and content are required' });
  }
  if (typeof title !== 'string' || title.length < 1 || title.length > 200) {
    return res.status(400).json({ error: 'Invalid title' });
  }
  if (typeof content !== 'string' || content.length < 1 || content.length > 5000) {
    return res.status(400).json({ error: 'Invalid content' });
  }
  if (resolvedBoardType.length > 64) {
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
      boardType: resolvedBoardType,
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

// GET /api/posts – fetch posts, optionally filtered by boardType (public)
app.get('/api/posts', async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  const { boardType } = req.query;
  if (boardType !== undefined && (typeof boardType !== 'string' || boardType.length > 64)) {
    return res.status(400).json({ error: 'Invalid boardType' });
  }

  try {
    const query = boardType ? { boardType: { $eq: String(boardType) } } : {};
    const posts = await db.collection('posts')
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();

    // Collect all unique userIds from posts and their replies
    const userIdSet = new Set();
    for (const post of posts) {
      if (post.userId) userIdSet.add(post.userId);
      for (const reply of (post.replies || [])) {
        if (reply.userId) userIdSet.add(reply.userId);
        for (const sr of (reply.subreplies || [])) {
          if (sr.userId) userIdSet.add(sr.userId);
        }
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
          profileImage: (reply.userId && profileImageMap[reply.userId]) || null,
          subreplies: (reply.subreplies || []).map(sr => ({
            ...sr,
            username: (sr.userId && usernameMap[sr.userId]) || sr.username || sr.email,
            profileImage: (sr.userId && profileImageMap[sr.userId]) || null
          }))
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
      replyId: require('crypto').randomUUID(),
      userId: req.userId,
      email: req.userEmail,
      username,
      content,
      createdAt: new Date(),
      likes: [],
      subreplies: []
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

// GET /api/user/is-seller – check if the current user has a seller profile (auth required)
app.get('/api/user/is-seller', verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const seller = await db.collection('sellers').findOne({ userId: req.userId });
    res.json({ isSeller: !!seller });
  } catch (error) {
    console.error('Error checking seller status:', error);
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
    'shippingState', 'shippingZip', 'payoutAccountId', 'payoutVerified'
  ];
  const updates = { updatedAt: new Date() };
  const stringFields = [
    'shopName', 'shopDescription', 'businessEmail', 'phoneNumber',
    'businessAddress', 'businessCity', 'businessState', 'businessZip',
    'personalName', 'personalEmail', 'shippingAddress', 'shippingCity',
    'shippingState', 'shippingZip', 'payoutAccountId'
  ];
  for (const field of stringFields) {
    if (req.body[field] !== undefined) updates[field] = String(req.body[field]).slice(0, 2000);
  }
  if (req.body.payoutVerified !== undefined) {
    updates.payoutVerified = Boolean(req.body.payoutVerified);
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

// POST /api/sellers/recover-missing – recover orphaned seller records (auth required)
app.post('/api/sellers/recover-missing', verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const products = await db.collection('products').find({}, { projection: { sellerId: 1 } }).toArray();
    const sellerIds = [...new Set(products.map(function(p) { return p.sellerId; }).filter(Boolean))];

    // Batch fetch existing seller records and users
    const existingSellers = await db.collection('sellers').find({ userId: { $in: sellerIds } }, { projection: { userId: 1 } }).toArray();
    const existingSellerIds = new Set(existingSellers.map(function(s) { return s.userId; }));
    const missingSellerIds = sellerIds.filter(function(id) { return !existingSellerIds.has(id); });

    let recovered = 0;
    for (const sellerId of missingSellerIds) {
      let user = null;
      try {
        user = await db.collection('users').findOne({ _id: new ObjectId(sellerId) });
      } catch (_) {}

      if (!user) continue;

      await db.collection('sellers').insertOne({
        userId: sellerId,
        accountType: 'individual',
        shopName: resolveSellerName(user),
        shopDescription: 'Shop',
        joinDate: new Date(),
        rating: 5,
        totalSales: 0,
        isVerified: false,
        createdAt: new Date()
      });

      await db.collection('users').updateOne(
        { _id: new ObjectId(sellerId) },
        { $set: { isSeller: true, updatedAt: new Date() } }
      );

      recovered++;
    }

    console.log(`✅ Seller recovery: recovered ${recovered} seller record(s) from ${sellerIds.length} unique seller ID(s)`);
    res.json({ message: `Recovered ${recovered} seller records` });
  } catch (error) {
    console.error('Error recovering seller records:', error);
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

    // Include the user's profile picture from the users collection (sellers collection doesn't store it)
    let profileImage = seller.profileImage || null;
    if (!profileImage) {
      try {
        const user = await db.collection('users').findOne(
          { _id: new ObjectId(userId) },
          { projection: { profileImage: 1 } }
        );
        profileImage = (user && user.profileImage) || null;
      } catch (userLookupError) {
        console.error('Error fetching user profileImage for seller:', userLookupError);
      }
    }

    res.json({ ...seller, profileImage });
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
app.post('/api/messages', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  const { toUserId, subject, body } = req.body;
  if (!toUserId || !body) {
    return res.status(400).json({ error: 'toUserId and body are required' });
  }
  if (subject !== undefined && subject !== null && (typeof subject !== 'string' || subject.length > 200)) {
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
      subject: subject ? subject.trim() : '',
      body: body.trim(),
      read: false,
      createdAt: new Date()
    };

    const result = await db.collection('messages').insertOne(message);
    // Create an in-site notification for the recipient
    try {
      await db.collection('notifications').insertOne({
        userId: String(toUserId),
        type: 'new_message',
        title: 'New message from ' + fromDisplayName,
        body: (message.subject ? message.subject + ': ' : '') + message.body.slice(0, 100),
        fromUserId: req.userId,
        fromDisplayName,
        read: false,
        createdAt: new Date()
      });
    } catch (_) {}
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

// ── LISTS (Build Lists & Wish Lists) ──────────────────────────────────────────

// GET /api/lists – get all lists for the current user (auth required)
app.get('/api/lists', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  const type = req.query.type; // optional: 'build' or 'wish'
  try {
    const query = { userId: req.userId };
    // Use explicit literals to prevent any user-controlled value from reaching the query
    if (type === 'build') query.type = 'build';
    else if (type === 'wish') query.type = 'wish';
    const lists = await db.collection('lists').find(query).sort({ createdAt: -1 }).toArray();
    res.json(lists);
  } catch (error) {
    console.error('Error fetching lists:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/lists – create a new list (auth required)
app.post('/api/lists', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  const { name, type } = req.body;
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (name.trim().length > 100) {
    return res.status(400).json({ error: 'name must be 100 characters or fewer' });
  }
  if (!type || (type !== 'build' && type !== 'wish')) {
    return res.status(400).json({ error: "type must be 'build' or 'wish'" });
  }
  try {
    const list = {
      userId: req.userId,
      name: name.trim(),
      type,
      items: [],
      createdAt: new Date(),
      updatedAt: new Date()
    };
    const result = await db.collection('lists').insertOne(list);
    res.status(201).json({ ...list, _id: result.insertedId });
  } catch (error) {
    console.error('Error creating list:', error);
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/lists/:id – update a list (auth required)
app.put('/api/lists/:id', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  let objectId;
  try { objectId = new ObjectId(req.params.id); } catch (e) {
    return res.status(400).json({ error: 'Invalid list ID' });
  }
  try {
    const list = await db.collection('lists').findOne({ _id: objectId });
    if (!list) return res.status(404).json({ error: 'List not found' });
    if (list.userId !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    const updates = { updatedAt: new Date() };
    if (req.body.name && typeof req.body.name === 'string') updates.name = req.body.name.trim().slice(0, 100);
    if (Array.isArray(req.body.items)) updates.items = req.body.items;
    await db.collection('lists').updateOne({ _id: objectId }, { $set: updates });
    const updated = await db.collection('lists').findOne({ _id: objectId });
    res.json(updated);
  } catch (error) {
    console.error('Error updating list:', error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/lists/:id – delete a list (auth required)
app.delete('/api/lists/:id', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  let objectId;
  try { objectId = new ObjectId(req.params.id); } catch (e) {
    return res.status(400).json({ error: 'Invalid list ID' });
  }
  try {
    const list = await db.collection('lists').findOne({ _id: objectId });
    if (!list) return res.status(404).json({ error: 'List not found' });
    if (list.userId !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    await db.collection('lists').deleteOne({ _id: objectId });
    res.json({ message: 'List deleted' });
  } catch (error) {
    console.error('Error deleting list:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── PASSWORD RESET ────────────────────────────────────────────────────────────

// POST /api/auth/forgot-password – verify email exists and issue a reset token
app.post('/api/auth/forgot-password', authRateLimit, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  const { email } = req.body;
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'email is required' });
  }
  if (email.length > 254) {
    return res.status(400).json({ error: 'Invalid email' });
  }
  // Normalize email and use exact equality to avoid ReDoS risk
  const normalizedEmail = email.trim().toLowerCase();
  try {
    const user = await db.collection('users').findOne({ email: normalizedEmail });
    // Always respond with success to prevent email enumeration
    if (!user) {
      return res.json({ message: 'If that email is registered, a reset link will be sent.' });
    }
    // Generate a reset token (valid for 1 hour)
    const resetToken = require('crypto').randomBytes(32).toString('hex');
    const resetExpiry = new Date(Date.now() + 3600000);
    await db.collection('users').updateOne(
      { _id: user._id },
      { $set: { passwordResetToken: resetToken, passwordResetExpiry: resetExpiry } }
    );
    // In production, send an email with the reset link. For now, return token in dev mode.
    const isDev = process.env.NODE_ENV !== 'production';
    res.json({
      message: 'If that email is registered, a reset link will be sent.',
      ...(isDev && { devResetToken: resetToken })
    });
  } catch (error) {
    console.error('Error in forgot-password:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/auth/reset-password – reset password using a token
app.post('/api/auth/reset-password', authRateLimit, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  const { token, newPassword } = req.body;
  if (!token || !newPassword) {
    return res.status(400).json({ error: 'token and newPassword are required' });
  }
  if (typeof newPassword !== 'string' || newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  try {
    const user = await db.collection('users').findOne({
      passwordResetToken: token,
      passwordResetExpiry: { $gt: new Date() }
    });
    if (!user) return res.status(400).json({ error: 'Invalid or expired reset token' });
    const hashed = await bcrypt.hash(newPassword, 10);
    await db.collection('users').updateOne(
      { _id: user._id },
      { $set: { password: hashed, updatedAt: new Date() }, $unset: { passwordResetToken: '', passwordResetExpiry: '' } }
    );
    res.json({ message: 'Password reset successfully. You may now log in.' });
  } catch (error) {
    console.error('Error in reset-password:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── REVIEWS ───────────────────────────────────────────────────────────────────

// GET /api/reviews?productId=xxx – get reviews for a product (public)
app.get('/api/reviews', publicApiRateLimit, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  const { productId } = req.query;
  if (!productId) return res.status(400).json({ error: 'productId is required' });
  try {
    const reviews = await db.collection('reviews')
      .find({ productId: String(productId) })
      .sort({ createdAt: -1 })
      .toArray();
    res.json(reviews);
  } catch (error) {
    console.error('Error fetching reviews:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/reviews – submit a review (auth required)
app.post('/api/reviews', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  const { productId, rating, title, body } = req.body;
  if (!productId || !rating || !body) {
    return res.status(400).json({ error: 'productId, rating, and body are required' });
  }
  const numRating = Number(rating);
  if (!Number.isInteger(numRating) || numRating < 1 || numRating > 5) {
    return res.status(400).json({ error: 'rating must be an integer between 1 and 5' });
  }
  if (typeof body !== 'string' || body.trim().length < 3 || body.length > 5000) {
    return res.status(400).json({ error: 'Review body must be between 3 and 5000 characters' });
  }

  try {
    // Check if user already reviewed this product
    const existing = await db.collection('reviews').findOne({ productId: String(productId), reviewerId: req.userId });
    if (existing) {
      return res.status(409).json({ error: 'You have already reviewed this product' });
    }

    // Get product to find sellerId
    let product = null;
    try { product = await db.collection('products').findOne({ _id: new ObjectId(productId) }); } catch (_) {}

    // Get reviewer display name
    let reviewerName = req.userEmail;
    try {
      const userDoc = await db.collection('users').findOne({ _id: new ObjectId(req.userId) });
      if (userDoc) {
        const fullName = ((userDoc.firstName || '') + ' ' + (userDoc.lastName || '')).trim();
        reviewerName = fullName || userDoc.email || req.userEmail;
      }
    } catch (_) {}

    const review = {
      productId: String(productId),
      reviewerId: req.userId,
      reviewerEmail: req.userEmail,
      reviewerName,
      rating: numRating,
      title: title ? String(title).trim().slice(0, 200) : '',
      body: body.trim(),
      createdAt: new Date()
    };

    const result = await db.collection('reviews').insertOne(review);

    // Update product rating
    const allProductReviews = await db.collection('reviews').find({ productId: String(productId) }).toArray();
    const avgRating = allProductReviews.reduce(function(sum, r) { return sum + r.rating; }, 0) / allProductReviews.length;
    try {
      await db.collection('products').updateOne(
        { _id: new ObjectId(productId) },
        { $set: { rating: Math.round(avgRating * 10) / 10, reviewCount: allProductReviews.length, updatedAt: new Date() } }
      );
    } catch (_) {}

    // Update seller rating
    if (product && product.sellerId) {
      try {
        const sellerProductIds = (await db.collection('products').find({ sellerId: product.sellerId }, { projection: { _id: 1 } }).toArray()).map(function(p) { return String(p._id); });
        const sellerReviews = await db.collection('reviews').find({ productId: { $in: sellerProductIds } }).toArray();
        if (sellerReviews.length > 0) {
          const sellerAvgRating = sellerReviews.reduce(function(sum, r) { return sum + r.rating; }, 0) / sellerReviews.length;
          await db.collection('sellers').updateOne(
            { userId: product.sellerId },
            { $set: { rating: Math.round(sellerAvgRating * 10) / 10, updatedAt: new Date() } }
          );
        }
      } catch (_) {}

      // Notify seller of new review
      try {
        await db.collection('notifications').insertOne({
          userId: product.sellerId,
          type: 'new_review',
          title: 'New ' + numRating + '-star review',
          body: reviewerName + ' reviewed your product: ' + (product.name || productId),
          productId: String(productId),
          read: false,
          createdAt: new Date()
        });
      } catch (_) {}
    }

    res.status(201).json({ ...review, _id: result.insertedId });
  } catch (error) {
    console.error('Error submitting review:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── NOTIFICATIONS ─────────────────────────────────────────────────────────────

// GET /api/notifications – get notifications for current user (auth required)
app.get('/api/notifications', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const notifications = await db.collection('notifications')
      .find({ userId: req.userId })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();
    res.json(notifications);
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/notifications/read-all – mark all notifications as read (auth required)
app.put('/api/notifications/read-all', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  try {
    await db.collection('notifications').updateMany({ userId: req.userId, read: false }, { $set: { read: true } });
    res.json({ message: 'All notifications marked as read' });
  } catch (error) {
    console.error('Error marking all notifications as read:', error);
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/notifications/:id/read – mark a notification as read (auth required)
app.put('/api/notifications/:id/read', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  let objectId;
  try { objectId = new ObjectId(req.params.id); } catch (e) {
    return res.status(400).json({ error: 'Invalid notification ID' });
  }
  try {
    const notification = await db.collection('notifications').findOne({ _id: objectId });
    if (!notification) return res.status(404).json({ error: 'Notification not found' });
    if (notification.userId !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    await db.collection('notifications').updateOne({ _id: objectId }, { $set: { read: true } });
    res.json({ message: 'Marked as read' });
  } catch (error) {
    console.error('Error marking notification as read:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── REPLY INTERACTIONS ────────────────────────────────────────────────────────

// POST /api/posts/:postId/replies/:replyId/like – toggle like on a reply (auth required)
app.post('/api/posts/:postId/replies/:replyId/like', verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  let objectId;
  try { objectId = new ObjectId(req.params.postId); } catch (e) {
    return res.status(400).json({ error: 'Invalid postId' });
  }
  const { replyId } = req.params;
  try {
    const post = await db.collection('posts').findOne({ _id: objectId });
    if (!post) return res.status(404).json({ error: 'Post not found' });
    const replies = post.replies || [];
    const replyIdx = replies.findIndex(function(r) { return r.replyId === replyId; });
    if (replyIdx === -1) return res.status(404).json({ error: 'Reply not found' });
    const reply = replies[replyIdx];
    const likes = reply.likes || [];
    const hasLiked = likes.includes(req.userId);
    if (hasLiked) {
      await db.collection('posts').updateOne(
        { _id: objectId },
        { $pull: { [`replies.${replyIdx}.likes`]: req.userId } }
      );
      return res.json({ likeCount: likes.length - 1, liked: false });
    } else {
      await db.collection('posts').updateOne(
        { _id: objectId },
        { $push: { [`replies.${replyIdx}.likes`]: req.userId } }
      );
      return res.json({ likeCount: likes.length + 1, liked: true });
    }
  } catch (error) {
    console.error('Error toggling reply like:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/posts/:postId/replies/:replyId/replies – add a nested reply (auth required)
app.post('/api/posts/:postId/replies/:replyId/replies', verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  let objectId;
  try { objectId = new ObjectId(req.params.postId); } catch (e) {
    return res.status(400).json({ error: 'Invalid postId' });
  }
  const { replyId } = req.params;
  const { content } = req.body;
  if (!content || typeof content !== 'string' || content.length < 1 || content.length > 2000) {
    return res.status(400).json({ error: 'Valid content is required' });
  }
  try {
    const post = await db.collection('posts').findOne({ _id: objectId });
    if (!post) return res.status(404).json({ error: 'Post not found' });
    const replies = post.replies || [];
    const replyIdx = replies.findIndex(function(r) { return r.replyId === replyId; });
    if (replyIdx === -1) return res.status(404).json({ error: 'Reply not found' });
    let username = req.userEmail;
    try {
      const userDoc = await db.collection('users').findOne({ _id: new ObjectId(req.userId) });
      if (userDoc) {
        const fullName = ((userDoc.firstName || '') + ' ' + (userDoc.lastName || '')).trim();
        username = fullName || userDoc.email || req.userEmail;
      }
    } catch (_) {}
    const nestedReply = {
      replyId: require('crypto').randomUUID(),
      userId: req.userId,
      email: req.userEmail,
      username,
      content,
      createdAt: new Date(),
      likes: []
    };
    await db.collection('posts').updateOne(
      { _id: objectId },
      { $push: { [`replies.${replyIdx}.subreplies`]: nestedReply } }
    );
    res.status(201).json(nestedReply);
  } catch (error) {
    console.error('Error adding nested reply:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── USER ADDRESSES ────────────────────────────────────────────────────────────

// GET /api/user/addresses – list saved addresses (auth required)
app.get('/api/user/addresses', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const doc = await db.collection('userAddresses').findOne({ userId: req.userId });
    res.json((doc && doc.addresses) || []);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// POST /api/user/addresses – add an address (auth required)
app.post('/api/user/addresses', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  const { label, name, line1, line2, city, state, zip, country, phone, isDefault } = req.body;
  if (!name || !line1 || !city || !state || !zip) {
    return res.status(400).json({ error: 'name, line1, city, state, and zip are required' });
  }
  const address = {
    id: require('crypto').randomUUID(),
    label: label || 'Home',
    name: String(name).trim().slice(0, 100),
    line1: String(line1).trim().slice(0, 200),
    line2: line2 ? String(line2).trim().slice(0, 200) : '',
    city: String(city).trim().slice(0, 100),
    state: String(state).trim().slice(0, 100),
    zip: String(zip).trim().slice(0, 20),
    country: country ? String(country).trim().slice(0, 100) : 'US',
    phone: phone ? String(phone).trim().slice(0, 30) : '',
    isDefault: !!isDefault,
    createdAt: new Date()
  };
  try {
    const doc = await db.collection('userAddresses').findOne({ userId: req.userId });
    const addresses = (doc && doc.addresses) || [];
    if (address.isDefault) {
      addresses.forEach(function(a) { a.isDefault = false; });
    }
    addresses.push(address);
    await db.collection('userAddresses').updateOne(
      { userId: req.userId },
      { $set: { userId: req.userId, addresses, updatedAt: new Date() } },
      { upsert: true }
    );
    res.status(201).json(address);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// PUT /api/user/addresses/:id – update an address (auth required)
app.put('/api/user/addresses/:id', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  const addrId = req.params.id;
  try {
    const doc = await db.collection('userAddresses').findOne({ userId: req.userId });
    if (!doc) return res.status(404).json({ error: 'No addresses found' });
    const addresses = doc.addresses || [];
    const idx = addresses.findIndex(function(a) { return a.id === addrId; });
    if (idx === -1) return res.status(404).json({ error: 'Address not found' });
    const { label, name, line1, line2, city, state, zip, country, phone, isDefault } = req.body;
    if (name) addresses[idx].name = String(name).trim().slice(0, 100);
    if (line1) addresses[idx].line1 = String(line1).trim().slice(0, 200);
    if (line2 !== undefined) addresses[idx].line2 = line2 ? String(line2).trim().slice(0, 200) : '';
    if (city) addresses[idx].city = String(city).trim().slice(0, 100);
    if (state) addresses[idx].state = String(state).trim().slice(0, 100);
    if (zip) addresses[idx].zip = String(zip).trim().slice(0, 20);
    if (country) addresses[idx].country = String(country).trim().slice(0, 100);
    if (phone !== undefined) addresses[idx].phone = phone ? String(phone).trim().slice(0, 30) : '';
    if (label) addresses[idx].label = String(label).trim().slice(0, 50);
    if (isDefault) {
      addresses.forEach(function(a) { a.isDefault = false; });
      addresses[idx].isDefault = true;
    }
    await db.collection('userAddresses').updateOne(
      { userId: req.userId },
      { $set: { addresses, updatedAt: new Date() } }
    );
    res.json(addresses[idx]);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// DELETE /api/user/addresses/:id – delete an address (auth required)
app.delete('/api/user/addresses/:id', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  const addrId = req.params.id;
  try {
    const doc = await db.collection('userAddresses').findOne({ userId: req.userId });
    if (!doc) return res.status(404).json({ error: 'Address not found' });
    const addresses = (doc.addresses || []).filter(function(a) { return a.id !== addrId; });
    await db.collection('userAddresses').updateOne(
      { userId: req.userId },
      { $set: { addresses, updatedAt: new Date() } }
    );
    res.json({ message: 'Address deleted' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ── USER GALLERY ──────────────────────────────────────────────────────────────

// GET /api/user/gallery – get gallery items (auth required)
app.get('/api/user/gallery', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const doc = await db.collection('userGallery').findOne({ userId: req.userId });
    res.json((doc && doc.items) || []);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// POST /api/user/gallery – add a gallery item (auth required)
app.post('/api/user/gallery', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  const { url, caption } = req.body;
  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'A valid image URL is required' });
  }
  const item = {
    id: require('crypto').randomUUID(),
    url: url.slice(0, 2000),
    caption: caption ? String(caption).trim().slice(0, 200) : '',
    createdAt: new Date()
  };
  try {
    const doc = await db.collection('userGallery').findOne({ userId: req.userId });
    const items = (doc && doc.items) || [];
    if (items.length >= 50) return res.status(400).json({ error: 'Gallery limit reached (50 items)' });
    items.push(item);
    await db.collection('userGallery').updateOne(
      { userId: req.userId },
      { $set: { userId: req.userId, items, updatedAt: new Date() } },
      { upsert: true }
    );
    res.status(201).json(item);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// DELETE /api/user/gallery/:id – delete a gallery item (auth required)
app.delete('/api/user/gallery/:id', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const doc = await db.collection('userGallery').findOne({ userId: req.userId });
    if (!doc) return res.status(404).json({ error: 'Item not found' });
    const items = (doc.items || []).filter(function(i) { return i.id !== req.params.id; });
    await db.collection('userGallery').updateOne(
      { userId: req.userId },
      { $set: { items, updatedAt: new Date() } }
    );
    res.json({ message: 'Item deleted' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ── GIFT CARDS ────────────────────────────────────────────────────────────────

// GET /api/user/gift-cards – list gift cards applied to account (auth required)
app.get('/api/user/gift-cards', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const cards = await db.collection('giftCards').find({ redeemedBy: req.userId }).toArray();
    res.json(cards);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// POST /api/user/gift-cards/redeem – redeem a gift card code (auth required)
app.post('/api/user/gift-cards/redeem', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  const { code } = req.body;
  if (!code || typeof code !== 'string') return res.status(400).json({ error: 'Gift card code is required' });
  const cleanCode = code.trim().toUpperCase().slice(0, 50);
  try {
    const card = await db.collection('giftCards').findOne({ code: cleanCode });
    if (!card) return res.status(404).json({ error: 'Gift card code not found' });
    if (card.redeemedBy) return res.status(409).json({ error: 'This gift card has already been redeemed' });
    if (card.expiresAt && new Date(card.expiresAt) < new Date()) {
      return res.status(410).json({ error: 'This gift card has expired' });
    }
    await db.collection('giftCards').updateOne(
      { code: cleanCode },
      { $set: { redeemedBy: req.userId, redeemedAt: new Date() } }
    );
    res.json({ message: 'Gift card redeemed successfully', balance: card.balance, currency: card.currency || 'USD' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ── TEXT ALERTS ───────────────────────────────────────────────────────────────

// POST /api/user/text-alerts – sign up for text alerts (auth required)
app.post('/api/user/text-alerts', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  const { phone, enabled } = req.body;
  if (enabled && (!phone || typeof phone !== 'string')) {
    return res.status(400).json({ error: 'Phone number is required to enable text alerts' });
  }
  const phoneClean = phone ? String(phone).replace(/[^\d\+\-\(\)\s]/g, '').trim().slice(0, 30) : '';
  try {
    await db.collection('userTextAlerts').updateOne(
      { userId: req.userId },
      { $set: { userId: req.userId, phone: phoneClean, enabled: !!enabled, updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ message: enabled ? 'Text alerts enabled' : 'Text alerts disabled', phone: phoneClean });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// GET /api/user/text-alerts – get text alert settings (auth required)
app.get('/api/user/text-alerts', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const doc = await db.collection('userTextAlerts').findOne({ userId: req.userId });
    res.json(doc || { phone: '', enabled: false });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ── PRICE ALERTS ──────────────────────────────────────────────────────────────

// GET /api/user/price-alerts – list price alerts (auth required)
app.get('/api/user/price-alerts', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const doc = await db.collection('userPriceAlerts').findOne({ userId: req.userId });
    res.json((doc && doc.alerts) || []);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// POST /api/user/price-alerts – add a price alert (auth required)
app.post('/api/user/price-alerts', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  const { productId, productName, targetPrice } = req.body;
  if (!productId || !productName || !targetPrice) {
    return res.status(400).json({ error: 'productId, productName, and targetPrice are required' });
  }
  const parsed = parseFloat(targetPrice);
  if (isNaN(parsed) || parsed <= 0) return res.status(400).json({ error: 'targetPrice must be a positive number' });
  const alert = {
    id: require('crypto').randomUUID(),
    productId: String(productId).slice(0, 100),
    productName: String(productName).trim().slice(0, 200),
    targetPrice: parsed,
    createdAt: new Date(),
    triggered: false
  };
  try {
    const doc = await db.collection('userPriceAlerts').findOne({ userId: req.userId });
    const alerts = (doc && doc.alerts) || [];
    if (alerts.length >= 50) return res.status(400).json({ error: 'Price alert limit reached (50)' });
    alerts.push(alert);
    await db.collection('userPriceAlerts').updateOne(
      { userId: req.userId },
      { $set: { userId: req.userId, alerts, updatedAt: new Date() } },
      { upsert: true }
    );
    res.status(201).json(alert);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// DELETE /api/user/price-alerts/:id – remove a price alert (auth required)
app.delete('/api/user/price-alerts/:id', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const doc = await db.collection('userPriceAlerts').findOne({ userId: req.userId });
    if (!doc) return res.status(404).json({ error: 'Alert not found' });
    const alerts = (doc.alerts || []).filter(function(a) { return a.id !== req.params.id; });
    await db.collection('userPriceAlerts').updateOne(
      { userId: req.userId },
      { $set: { alerts, updatedAt: new Date() } }
    );
    res.json({ message: 'Price alert removed' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ── ERROR HANDLER ──────────────────────────────────────────────────────────────
app.use(function(err, req, res, next) {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 5000;

// Recover missing seller records by inspecting product sellerId values
function resolveSellerName(user) {
  return ((user.firstName || '') + ' ' + (user.lastName || '')).trim()
    || user.email
    || 'My Shop';
}

// Known seller IDs that should always be restored as business accounts
const BUSINESS_SELLER_IDS = new Set([
  '69e28ba63d419ba71f5a1d7d' // Steve – original business seller, registered 4/17
]);

async function recoverMissingSellers() {
  if (!mongoConnected) return;
  try {
    const products = await db.collection('products').find({}, { projection: { sellerId: 1 } }).toArray();
    const sellerIds = [...new Set(products.map(function(p) { return p.sellerId; }).filter(Boolean))];

    // Batch fetch existing seller records
    const existingSellers = await db.collection('sellers').find({ userId: { $in: sellerIds } }, { projection: { userId: 1 } }).toArray();
    const existingSellerIds = new Set(existingSellers.map(function(s) { return s.userId; }));
    const missingSellerIds = sellerIds.filter(function(id) { return !existingSellerIds.has(id); });

    let recovered = 0;
    for (const sellerId of missingSellerIds) {
      let user = null;
      try {
        user = await db.collection('users').findOne({ _id: new ObjectId(sellerId) });
      } catch (_) {}

      if (!user) continue;

      const accountType = BUSINESS_SELLER_IDS.has(sellerId) ? 'business' : 'individual';

      await db.collection('sellers').insertOne({
        userId: sellerId,
        accountType,
        shopName: resolveSellerName(user),
        shopDescription: 'Shop',
        joinDate: new Date(),
        rating: 5,
        totalSales: 0,
        isVerified: false,
        createdAt: new Date()
      });

      await db.collection('users').updateOne(
        { _id: new ObjectId(sellerId) },
        { $set: { isSeller: true, updatedAt: new Date() } }
      );

      recovered++;
    }

    if (recovered > 0) {
      console.log(`✅ Seller recovery: recovered ${recovered} seller record(s) from ${sellerIds.length} unique seller ID(s)`);
    } else {
      console.log(`ℹ️  Seller recovery: all ${sellerIds.length} seller(s) already have records`);
    }

    // Ensure known business sellers have the correct accountType even if already recovered
    for (const sellerId of BUSINESS_SELLER_IDS) {
      try {
        const existing = await db.collection('sellers').findOne({ userId: sellerId });
        if (existing && existing.accountType !== 'business') {
          await db.collection('sellers').updateOne(
            { userId: sellerId },
            { $set: { accountType: 'business', updatedAt: new Date() } }
          );
          console.log(`✅ Restored business accountType for seller ${sellerId}`);
        }
      } catch (err) {
        console.error(`⚠️  Could not verify business accountType for seller ${sellerId}:`, err.message);
      }
    }
  } catch (err) {
    console.error('⚠️  Seller recovery error:', err.message);
  }
}

// Start server and connect to MongoDB
async function activateAllProducts() {
  if (!mongoConnected) return;
  try {
    const result = await db.collection('products').updateMany(
      { status: { $nin: ['active', 'sold'] } },
      { $set: { status: 'active', updatedAt: new Date() } }
    );
    if (result.modifiedCount > 0) {
      console.log(`✅ Product activation migration: ${result.modifiedCount} product(s) set to active`);
    } else {
      console.log('ℹ️  Product activation migration: all products already active (or sold)');
    }
  } catch (err) {
    console.error('⚠️  Product activation migration error:', err.message);
  }
}

async function start() {
  console.log('🚀 Starting server...');
  try {
    const connected = await connectDB();
    if (connected) {
      console.log('✅ Database connected — starting HTTP server');
      await recoverMissingSellers();
      await activateAllProducts();
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
