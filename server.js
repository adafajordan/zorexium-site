const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_your_key_here');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 5000;
const BASE_URL = process.env.BASE_URL || 'http://localhost:5000';

// Mock product database (replace with real database)
const products = {
  'item_gpu_rtx4090': { name: 'RTX 4090', price: 1599.99, sellerId: 'seller1', image: 'https://via.placeholder.com/400x300?text=RTX+4090', description: 'High-end RTX 4090 graphics card. Excellent condition.' },
  'item_cpu_ryzen9': { name: 'Ryzen 9 7950X', price: 699.99, sellerId: 'seller2', image: 'https://via.placeholder.com/400x300?text=Ryzen+9', description: '16-core Ryzen 9 processor. Perfect for gaming and streaming.' },
  'item_ram_32gb': { name: 'DDR5 32GB', price: 149.99, sellerId: 'seller3', image: 'https://via.placeholder.com/400x300?text=DDR5+RAM', description: '32GB DDR5 RAM module. High performance memory.' },
};

// In-memory message storage (replace with database)
const messages = {};

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('.')); // Serve static HTML files

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'Server is running', timestamp: new Date() });
});

// ===== STRIPE CONNECT ONBOARDING =====

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

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Base URL: ${BASE_URL}`);
  console.log(`💚 Health check: ${BASE_URL}/health`);
  console.log(`💳 Stripe API Key: ${process.env.STRIPE_SECRET_KEY ? 'Configured' : 'NOT SET - Use default test key'}`);
});
