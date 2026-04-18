'use strict';

const express = require('express');
const app = express();
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { MongoClient, ObjectId } = require('mongodb');

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

// ── CORS Middleware ────────────────────────────────────────────────────────────
app.use(function(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ── JWT Middleware ────────────────────────────────────────────────────────────
function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
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

app.post('/api/auth/register', async function(req, res) {
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

    res.json({ message: 'User created successfully', userId: result.insertedId, token });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/login', async function(req, res) {
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
    const { name, price, category, description, image, condition, specifications } = req.body;

    if (!name || price === undefined || price === null || !category) {
      return res.status(400).json({ error: 'name, price, and category are required' });
    }

    const parsedPrice = parseFloat(price);
    if (isNaN(parsedPrice) || parsedPrice < 0) {
      return res.status(400).json({ error: 'price must be a non-negative number' });
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

    // Batch-fetch user documents and build a userId -> displayName map
    const usernameMap = {};
    if (userIdSet.size > 0) {
      const userIds = Array.from(userIdSet).map(id => { try { return new ObjectId(id); } catch (_) { return null; } }).filter(Boolean);
      const users = await db.collection('users').find({ _id: { $in: userIds } }).toArray();
      for (const user of users) {
        const fullName = ((user.firstName || '') + ' ' + (user.lastName || '')).trim();
        usernameMap[user._id.toString()] = fullName || user.email;
      }
    }

    // Enrich posts with current display name
    const enriched = posts.map(post => {
      const displayName = (post.userId && usernameMap[post.userId]) || post.username || post.email;
      return {
        ...post,
        username: displayName,
        replies: (post.replies || []).map(reply => ({
          ...reply,
          username: (reply.userId && usernameMap[reply.userId]) || reply.username || reply.email
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
