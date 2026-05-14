'use strict';

// SendGrid email setup
// Ensure SENDGRID_API_KEY is set as an environment variable (e.g. in Render dashboard).
// To install: npm install @sendgrid/mail
const sgMail = require('@sendgrid/mail');
const twilio = require('twilio');
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || '';
const SENDGRID_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'noreply@zorexium.io';
const ADMIN_NOTIFICATION_EMAIL = process.env.ADMIN_EMAIL || 'admin@zorexiumlabs.com';
const APP_BASE_URL = process.env.BASE_URL || 'https://zorexium.io';
const TEST_SMS_MESSAGE_TEMPLATE = 'Zorexium SMS test: your Twilio setup is working. Visit {{url}} to manage alerts.';
const MIN_E164_DIGITS = 8;
const MAX_E164_DIGITS = 15;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_SMS_FROM = process.env.TWILIO_SMS_FROM || '';
if (SENDGRID_API_KEY.startsWith('SG.')) {
  sgMail.setApiKey(SENDGRID_API_KEY); // API key sourced from environment — never hardcoded
} else {
  console.warn('⚠️  SENDGRID_API_KEY is missing or invalid. Email sends will be skipped.');
}
const twilioConfigured = TWILIO_ACCOUNT_SID.startsWith('AC') && !!TWILIO_AUTH_TOKEN && !!TWILIO_SMS_FROM;
const twilioClient = twilioConfigured
  ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
  : null;
if (!twilioConfigured) {
  console.warn('⚠️  Twilio SMS is not fully configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_SMS_FROM.');
}

// Utility function to send emails via SendGrid
async function sendEmail({ to, subject, text, html }) {
  if (!SENDGRID_API_KEY.startsWith('SG.')) {
    console.warn('Skipping email send because SENDGRID_API_KEY is not configured.', { to, subject });
    return { success: false, error: 'SENDGRID_API_KEY is not configured' };
  }
  try {
    await sgMail.send({
      to,                          // recipient address, e.g. 'user@example.com'
      from: SENDGRID_FROM_EMAIL, // must be a domain-authenticated sender in SendGrid
      subject,
      text,
      html,
    });
    return { success: true };
  } catch (error) {
    console.error('SendGrid error:', error);
    if (error.response && error.response.body) {
      console.error(error.response.body);
    }
    return { success: false, error: error.message };
  }
}

// Reusable utility to send SMS via Twilio.
// Use this utility in the same event paths where sendEventEmail/sendEventEmailSafe are called,
// so future notification flows can trigger both channels (email + SMS) in parallel.
async function sendSMS({ to, body }) {
  if (!twilioConfigured || !twilioClient) {
    console.warn('Skipping SMS send because Twilio environment variables are not configured.', { to });
    return { success: false, error: 'Twilio SMS is not configured' };
  }
  try {
    await twilioClient.messages.create({
      to,
      from: TWILIO_SMS_FROM,
      body,
    });
    return { success: true };
  } catch (error) {
    console.error('Twilio SMS error:', error);
    return { success: false, error: error.message };
  }
}
const express = require('express');
const app = express();
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { MongoClient, ObjectId, GridFSBucket } = require('mongodb');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const Stripe = require('stripe');

if (!globalThis.fetch) {
  globalThis.fetch = require('node-fetch');
}

// Keep parser headroom above legacy 25 MB so large multi-image listing payloads are accepted.
// 150 MB comfortably covers up to 10 images at 10 MB each when sent as base64 data URLs.
// Per-image validation below is still the enforced upload-size rule.
app.use(express.json({
  limit: '150mb',
  verify: function(req, _res, buf) {
    if (req.originalUrl === '/api/stripe/webhook') {
      req.rawBody = buf;
    }
  }
}));
// Only serve files from /public – never expose server.js, package.json, .env.example, etc.
app.use(express.static(path.join(__dirname, 'public')));

// Shared 10 MB per-image limit used by all image upload endpoints.
const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_POST_IMAGE_COUNT = 10;
// Max video size accepted by the multipart upload endpoint (100 MB).
const MAX_POST_VIDEO_SIZE_BYTES = 100 * 1024 * 1024;

// Multer instance for in-memory video uploads.
const videoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_POST_VIDEO_SIZE_BYTES },
  fileFilter: function(_req, file, cb) {
    if (file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed'));
    }
  }
});

// Backend origin used to build absolute video URLs returned to clients.
const BACKEND_BASE_URL = process.env.BACKEND_BASE_URL || 'https://zorexium-backend.onrender.com';
function normalizeAbsoluteUrl(urlValue) {
  if (typeof urlValue !== 'string') return '';
  var trimmed = urlValue.trim();
  if (!trimmed) return '';
  try {
    var parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.toString().replace(/\/+$/, '');
  } catch (_) {
    return '';
  }
}

function extractOrigin(urlValue) {
  var normalized = normalizeAbsoluteUrl(urlValue);
  if (!normalized) return '';
  try {
    return new URL(normalized).origin;
  } catch (_) {
    return '';
  }
}

function resolveAppUrl() {
  var defaultUrl = 'https://zorexium.io';
  var backendOrigins = new Set([
    extractOrigin(BACKEND_BASE_URL),
    extractOrigin(process.env.GOOGLE_REDIRECT_URI || '')
  ]);
  var fallbackCandidates = [
    normalizeAbsoluteUrl(APP_BASE_URL),
    defaultUrl
  ].filter(Boolean);
  var fallbackUrl = defaultUrl;
  for (var j = 0; j < fallbackCandidates.length; j += 1) {
    var fallbackOrigin = extractOrigin(fallbackCandidates[j]);
    if (!fallbackOrigin || !backendOrigins.has(fallbackOrigin)) {
      fallbackUrl = fallbackCandidates[j];
      break;
    }
  }
  var preferredCandidates = [
    process.env.FRONTEND_URL,
    process.env.APP_URL,
    APP_BASE_URL,
    defaultUrl
  ];
  var normalizedCandidates = preferredCandidates.map(normalizeAbsoluteUrl).filter(Boolean);
  for (var i = 0; i < normalizedCandidates.length; i += 1) {
    var candidateOrigin = extractOrigin(normalizedCandidates[i]);
    if (candidateOrigin && backendOrigins.has(candidateOrigin)) continue;
    return normalizedCandidates[i];
  }
  return fallbackUrl;
}

const APP_URL = resolveAppUrl();
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || '';
const GOOGLE_OAUTH_SCOPES = 'openid email profile';
const GOOGLE_OAUTH_COOKIE_MAX_AGE = 10 * 60;
const GOOGLE_OAUTH_STATE_TTL_MS = GOOGLE_OAUTH_COOKIE_MAX_AGE * 1000;
const GOOGLE_BRIDGE_TOKEN_MAX_AGE_MS = 5 * 60 * 1000;
const googleAuthBridgeTokens = new Map();
const googleOAuthStateStore = new Map();

// Parse and measure base64 data URL payload size in bytes so backend checks match real per-file size.
function getDataUrlPayloadBytes(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx === -1) return null;
  const payload = dataUrl.slice(commaIdx + 1).replace(/\s/g, '');
  if (!payload) return null;
  return Buffer.byteLength(payload, 'base64');
}

// MongoDB Connection
const MONGO_URI = process.env.MONGO_URI;
console.log('🔍 MONGO_URI exists:', !!MONGO_URI);

// JWT_SECRET must be set via environment variable in production.
// If missing, fall back to a hardcoded default and emit a warning – never ship without a real secret.
const DEFAULT_JWT_SECRET = 'your-secret-key-change-in-production';
const JWT_SECRET = process.env.JWT_SECRET || DEFAULT_JWT_SECRET;
if (JWT_SECRET === DEFAULT_JWT_SECRET) {
  console.warn('⚠️  JWT_SECRET is not set – using insecure default. Set JWT_SECRET env var before deploying to production.');
}

function makeAbsoluteUrl(path) {
  return APP_BASE_URL + (String(path || '').startsWith('/') ? path : '/' + String(path || ''));
}

async function sendEventEmail(to, subject, html, linkPath) {
  if (!to) return;
  const eventLink = makeAbsoluteUrl(linkPath || '/');
  const bodyHtml = html + `<p style="margin-top:16px;"><a href="${eventLink}">${eventLink}</a></p>`;
  await sendEmail({
    to,
    subject,
    text: `${subject}\n\n${eventLink}`,
    html: bodyHtml
  });
}

async function sendEventEmailSafe(to, subject, html, linkPath) {
  try {
    await sendEventEmail(to, subject, html, linkPath);
  } catch (mailErr) {
    console.error('Failed to send email:', subject, mailErr.message);
  }
}

async function sendAdminNotificationSafe(subject, html, linkPath) {
  const to = normalizeEmail(ADMIN_NOTIFICATION_EMAIL);
  if (!to) return;
  await sendEventEmailSafe(to, subject, html, linkPath || '/');
}

function isCommunityOrInnovationBoardType(value) {
  const boardType = String(value || '').trim().toLowerCase();
  if (!boardType) return false;
  const targetBoardTypes = new Set([
    'innovation',
    'general',
    'hardware',
    'gaming',
    'ai-ml',
    'programming',
    'cybersecurity',
    'networking',
    'software',
    'pc-building',
    'welcome',
    'announcements',
    'official-brand',
    'system-help'
  ]);
  return targetBoardTypes.has(boardType);
}

function getPostBoardLinkPath(boardType) {
  return String(boardType || '').trim().toLowerCase() === 'innovation'
    ? '/innovation-news.html'
    : '/community-hub.html';
}

function getOptionalAuthPayload(req) {
  const token = getTokenFromRequest(req);
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (_) {
    return null;
  }
}

async function notifyAdminPayoutPaidIfNeeded(payoutDoc, source) {
  if (!mongoConnected || !payoutDoc || !payoutDoc._id) return;
  if (String(payoutDoc.status || '').toLowerCase() !== 'paid') return;
  if (payoutDoc.adminPaidNotificationSentAt) return;
  const safeOrderId = escapeHtml(String(payoutDoc.orderId || 'N/A'));
  const safeSellerName = escapeHtml(String(payoutDoc.sellerName || payoutDoc.sellerUsername || 'Unknown seller'));
  const safeSellerId = escapeHtml(String(payoutDoc.sellerId || 'N/A'));
  const safeAmount = Number.isFinite(Number(payoutDoc.amount)) ? Number(payoutDoc.amount).toFixed(2) : '0.00';
  const safeCurrency = escapeHtml(String(payoutDoc.currency || 'USD').toUpperCase());
  const safeSource = escapeHtml(String(source || payoutDoc.triggerSource || 'system'));
  const paidAt = payoutDoc.paidAt ? new Date(payoutDoc.paidAt).toISOString() : new Date().toISOString();
  await sendAdminNotificationSafe(
    'Seller payout completed',
    `<p>A seller payout has been marked as <strong>paid</strong>.</p>`
      + `<p><strong>Order ID:</strong> ${safeOrderId}</p>`
      + `<p><strong>Seller:</strong> ${safeSellerName} (${safeSellerId})</p>`
      + `<p><strong>Payout amount:</strong> ${safeCurrency} ${safeAmount}</p>`
      + `<p><strong>Paid at:</strong> ${escapeHtml(paidAt)}</p>`
      + `<p><strong>Source:</strong> ${safeSource}</p>`,
    '/admin-payouts.html'
  );
  await db.collection('payouts').updateOne(
    { _id: payoutDoc._id, adminPaidNotificationSentAt: { $exists: false } },
    { $set: { adminPaidNotificationSentAt: new Date() } }
  );
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function getAppOrigin() {
  try {
    return new URL(APP_URL).origin;
  } catch (_) {
    return 'https://zorexium.io';
  }
}

function normalizePostLoginRedirectPath(value) {
  var fallback = '/index.html';
  if (typeof value !== 'string') return fallback;
  var raw = value.trim();
  if (!raw) return fallback;
  if (raw.startsWith('/') && !raw.startsWith('//')) return raw;
  try {
    var parsed = new URL(raw);
    if (parsed.origin === getAppOrigin()) {
      return parsed.pathname + parsed.search + parsed.hash;
    }
  } catch (_) {}
  return fallback;
}

function buildAppLoginUrl(extraParams) {
  var base = APP_URL.endsWith('/') ? APP_URL : APP_URL + '/';
  var url = new URL('login-register.html', base);
  if (extraParams && typeof extraParams === 'object') {
    Object.keys(extraParams).forEach(function(key) {
      var value = extraParams[key];
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    });
  }
  return url.toString();
}

function createGoogleOAuthState(returnToPath) {
  var now = Date.now();
  for (const [stateKey, stateEntry] of googleOAuthStateStore.entries()) {
    if (!stateEntry || stateEntry.expiresAt <= now) googleOAuthStateStore.delete(stateKey);
  }
  var state = crypto.randomBytes(24).toString('hex');
  googleOAuthStateStore.set(state, {
    returnToPath: normalizePostLoginRedirectPath(returnToPath),
    expiresAt: now + GOOGLE_OAUTH_STATE_TTL_MS
  });
  return state;
}

function consumeGoogleOAuthState(state) {
  if (typeof state !== 'string' || !/^[a-f0-9]{48}$/.test(state)) return null;
  var entry = googleOAuthStateStore.get(state);
  if (!entry) return null;
  googleOAuthStateStore.delete(state);
  if (!entry.expiresAt || entry.expiresAt <= Date.now()) return null;
  return entry;
}

function createGoogleBridgeToken(payload) {
  var now = Date.now();
  for (const [code, entry] of googleAuthBridgeTokens.entries()) {
    if (!entry || entry.expiresAt <= now) googleAuthBridgeTokens.delete(code);
  }
  var code = crypto.randomBytes(24).toString('hex');
  googleAuthBridgeTokens.set(code, {
    token: payload.token,
    user: payload.user,
    redirectTo: payload.redirectTo,
    expiresAt: now + GOOGLE_BRIDGE_TOKEN_MAX_AGE_MS
  });
  return code;
}

function consumeGoogleBridgeToken(code) {
  if (typeof code !== 'string' || !/^[a-f0-9]{48}$/.test(code)) return null;
  var entry = googleAuthBridgeTokens.get(code);
  if (!entry) return null;
  googleAuthBridgeTokens.delete(code);
  if (!entry.expiresAt || entry.expiresAt <= Date.now()) return null;
  return entry;
}

function decodeJwtPayload(token) {
  if (typeof token !== 'string') return null;
  var parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    var payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (payload.length % 4 !== 0) payload += '=';
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch (_) {
    return null;
  }
}

function isLikelyEmail(value) {
  if (typeof value !== 'string') return false;
  const email = value.trim();
  if (!email || email.length > 254 || email.includes(' ')) return false;
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@') || at === email.length - 1) return false;
  const domain = email.slice(at + 1);
  const dot = domain.indexOf('.');
  return dot > 0 && dot < (domain.length - 1);
}

function normalizePhoneE164(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed.startsWith('+')) return '';
  const digitsOnly = trimmed.slice(1);
  if (digitsOnly.length < MIN_E164_DIGITS || digitsOnly.length > MAX_E164_DIGITS) return '';
  if (!/^\d+$/.test(digitsOnly)) return '';
  return '+' + digitsOnly;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isBlogBoardType(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized === 'blog' || normalized === 'blogs' || normalized === 'blog-content' || normalized === 'blog-content-news';
}

async function notifyBlogSubscribersOfNewPost(post) {
  if (!mongoConnected || !post || !post._id || !isBlogBoardType(post.boardType)) return;
  const subscribers = await db.collection('blogSubscribers')
    .find({ status: 'active' })
    .project({ email: 1 })
    .toArray();
  if (!subscribers || subscribers.length === 0) return;

  const safeTitle = escapeHtml(post.title || 'New blog post');
  const excerpt = String(post.content || '').trim().slice(0, 240);
  const safeExcerpt = escapeHtml(excerpt.length < String(post.content || '').trim().length ? (excerpt + '…') : excerpt);
  const postPath = '/blog.html';

  for (const subscriber of subscribers) {
    const to = normalizeEmail(subscriber && subscriber.email ? subscriber.email : '');
    if (!to) continue;
    try {
      await sendEventEmailSafe(
        to,
        `New Zorexium Blog Post: ${post.title || 'New post'}`,
        `<p>Hello,</p><p>A new Zorexium blog post is now live:</p><p><strong>${safeTitle}</strong></p>${safeExcerpt ? `<p>${safeExcerpt}</p>` : ''}<p>Visit the blog to read the full post.</p>`,
        postPath
      );
      await db.collection('blogSubscribers').updateOne(
        { email: to },
        { $set: { lastNotifiedAt: new Date(), lastNotifiedPostId: String(post._id) } }
      );
    } catch (notifyError) {
      console.error('Failed to notify blog subscriber:', to, notifyError.message);
    }
  }
}

function getEffectiveListingPrice(product) {
  if (!product || typeof product !== 'object') return NaN;
  const salePrice = Number(product.salePrice);
  if (Number.isFinite(salePrice) && salePrice > 0) return salePrice;
  const basePrice = Number(product.price);
  return Number.isFinite(basePrice) ? basePrice : NaN;
}

async function notifyPriceChangeSubscribers(product, previousPrice, nextPrice) {
  if (!mongoConnected) return;
  const productId = product && product._id ? String(product._id) : '';
  if (!productId) return;
  const fromPrice = Number(previousPrice);
  const toPrice = Number(nextPrice);
  if (!Number.isFinite(fromPrice) || !Number.isFinite(toPrice) || fromPrice === toPrice) return;
  const docs = await db.collection('userPriceAlerts').find({ 'alerts.productId': productId }).toArray();
  if (!docs || docs.length === 0) return;
  const safeProductName = escapeHtml(product && product.name ? product.name : 'Product');
  const safeFrom = fromPrice.toFixed(2);
  const safeTo = toPrice.toFixed(2);
  const productPath = '/product-detail.html?id=' + encodeURIComponent(productId);

  for (const doc of docs) {
    const userId = String(doc && doc.userId ? doc.userId : '');
    if (!userId) continue;
    const alerts = Array.isArray(doc.alerts) ? doc.alerts : [];
    let changed = false;
    let shouldNotify = false;
    const nextAlerts = alerts.map(function(alert) {
      if (String(alert && alert.productId ? alert.productId : '') !== productId) return alert;
      const nextAlert = { ...alert };
      nextAlert.currentPrice = toPrice;
      nextAlert.lastPrice = fromPrice;
      const target = Number(nextAlert.targetPrice);
      nextAlert.triggered = Number.isFinite(target) ? toPrice <= target : false;
      const alreadyNotifiedAtPrice = Number(nextAlert.lastNotifiedPrice) === toPrice;
      if (!alreadyNotifiedAtPrice) {
        nextAlert.lastNotifiedPrice = toPrice;
        nextAlert.lastNotifiedAt = new Date();
        shouldNotify = true;
      }
      changed = true;
      return nextAlert;
    });
    if (changed) {
      await db.collection('userPriceAlerts').updateOne(
        { _id: doc._id },
        { $set: { alerts: nextAlerts, updatedAt: new Date() } }
      );
    }
    if (!shouldNotify) continue;
    await maybeSendPreferenceNotificationEmail(
      userId,
      'price_drop_alerts',
      `Price changed for ${product && product.name ? product.name : 'your tracked product'}`,
      `<p>The price for <strong>${safeProductName}</strong> changed.</p><p>Previous price: <strong>$${safeFrom}</strong><br>New price: <strong>$${safeTo}</strong></p>`,
      productPath
    );
  }
}

function getRequestClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function buildDeviceFingerprint(req) {
  const userAgent = String(req.headers['user-agent'] || '').slice(0, 300);
  const acceptLanguage = String(req.headers['accept-language'] || '').slice(0, 100);
  const ip = getRequestClientIp(req);
  const raw = `${userAgent}|${acceptLanguage}|${ip}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

async function getUserEmailNotificationSettings(userId) {
  const defaults = {
    order_confirmation: true,
    shipping_updates: true,
    return_refund_status: true,
    price_drop_alerts: false,
    weekly_deals_digest: false,
    back_in_stock_alerts: false,
    community_replies: true,
    security_alerts: true,
    newsletter: false,
    login_notifications: true
  };
  const doc = await db.collection('userEmailNotificationSettings').findOne({ userId: String(userId) });
  return { ...defaults, ...(doc && doc.settings ? doc.settings : {}) };
}

async function isEmailAlertEnabled(userId, categoryKey) {
  const settings = await getUserEmailNotificationSettings(userId);
  return settings[categoryKey] !== false;
}

async function maybeSendPreferenceNotificationEmail(userId, categoryKey, subject, html, linkPath) {
  if (!userId) return;
  try {
    const enabled = await isEmailAlertEnabled(userId, categoryKey);
    if (!enabled) return;
    const user = await db.collection('users').findOne({ _id: new ObjectId(userId) }, { projection: { email: 1 } });
    const to = user && user.email ? normalizeEmail(user.email) : '';
    if (!to) return;
    await sendEventEmailSafe(to, subject, html, linkPath);
  } catch (error) {
    console.error('Failed preference email send for category', categoryKey, error.message);
  }
}
// Future SMS notification wiring:
// add a maybeSendPreferenceNotificationSMS companion and call it wherever maybeSendPreferenceNotificationEmail is used
// (checkout confirmations, seller events, security alerts, support/feedback acknowledgements) to keep channel behavior aligned.
let db;
let mongoClient;
let videoBucket;
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
    videoBucket = new GridFSBucket(db, { bucketName: 'communityVideos' });
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
var AUTH_COOKIE_SAME_SITE = isProduction ? 'None' : 'Lax';
var AUTH_COOKIE_SECURE = isProduction;

function setAuthCookies(res, token, email, username, userId) {
  // For split frontend/backend deployments, production cookies must be
  // SameSite=None; Secure so browsers allow cross-origin credential requests.
  var userPayload = JSON.stringify({ email: email, username: username || email, userId: userId || '' });
  res.setHeader('Set-Cookie', [
    buildCookieHeader('authToken', token, {
      httpOnly: true,
      maxAge: COOKIE_MAX_AGE,
      sameSite: AUTH_COOKIE_SAME_SITE,
      secure: AUTH_COOKIE_SECURE
    }),
    buildCookieHeader('_zrx_user', userPayload, {
      httpOnly: false,
      maxAge: COOKIE_MAX_AGE,
      sameSite: AUTH_COOKIE_SAME_SITE,
      secure: AUTH_COOKIE_SECURE
    })
  ]);
}

function clearAuthCookies(res) {
  res.setHeader('Set-Cookie', [
    buildCookieHeader('authToken', '', { httpOnly: true, maxAge: 0, sameSite: AUTH_COOKIE_SAME_SITE, secure: AUTH_COOKIE_SECURE }),
    buildCookieHeader('_zrx_user', '', { httpOnly: false, maxAge: 0, sameSite: AUTH_COOKIE_SAME_SITE, secure: AUTH_COOKIE_SECURE })
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

var videoUploadRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many video uploads, please try again later.' }
});

// ── CORS Middleware ────────────────────────────────────────────────────────────

// ── Seller Tier Constants ──────────────────────────────────────────────────────
const STARTER_LISTING_LIMIT = 25;
const VALID_SELLER_TIERS = ['starter', 'pro', 'brand'];

// Only allow credentialed requests from explicitly trusted frontend origins.
// Required for GitHub Pages/custom-domain frontend -> Render backend requests.
var REQUIRED_FRONTEND_ORIGINS = ['https://zorexium.io', 'https://www.zorexium.io'];
var ALLOWED_ORIGINS = Array.from(new Set(
  REQUIRED_FRONTEND_ORIGINS.concat(
    (process.env.CORS_ORIGINS || '').split(',').map(function(o) { return o.trim(); }).filter(Boolean)
  )
));

app.use(function(req, res, next) {
  var origin = req.headers.origin;
  res.append('Vary', 'Origin');
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
function getTokenFromRequest(req) {
  // Accept either "Authorization: Bearer <token>" or a raw JWT token value
  // (some clients store JWT in localStorage and attach it directly).
  var authHeader = req.headers.authorization;
  var token = '';
  if (typeof authHeader === 'string' && authHeader.trim()) {
    var authValue = authHeader.trim();
    var bearerMatch = authValue.match(/^Bearer\s+([A-Za-z0-9._-]+)$/i);
    var jwtPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
    if (bearerMatch && jwtPattern.test(bearerMatch[1])) {
      token = bearerMatch[1];
    } else if (jwtPattern.test(authValue)) {
      token = authValue;
    }
  }
  if (!token) {
    var cookies = parseCookies(req.headers.cookie);
    token = cookies['authToken'];
  }
  return token;
}

function verifyToken(req, res, next) {
  // Primary auth path: Authorization header (JWT). Cookie is fallback.
  var token = getTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    req.userEmail = decoded.email;
    req.isAdmin = decoded.isAdmin === true;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// Middleware: require admin role (must follow verifyToken)
function requireAdmin(req, res, next) {
  if (!req.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// ── Health check endpoint ────────────────────────────────────────────────────────
app.get('/health', function(req, res) {
  res.status(200).json({ status: 'ok', mongoConnected, mongoUri: MONGO_URI ? 'set' : 'NOT SET' });
});

function getPayPalBankOnboardingUrlFromEnv() {
  return 'https://www.paypal.com/myaccount/money/banks/new';
}

// ── Config endpoint ────────────────────────────────────────────────────────────
app.get('/api/config', function(req, res) {
  res.json({
    paypalClientId: process.env.PAYPAL_CLIENT_ID || null,
    paypalBankOnboardingUrl: getPayPalBankOnboardingUrlFromEnv(),
    stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || null,
    stripeProSellerPriceId: process.env.STRIPE_PRO_SELLER_PRICE_ID || null,
    googleClientId: GOOGLE_CLIENT_ID || null
  });
});

// ── USER AUTHENTICATION ────────────────────────────────────────────────────────

function ensureGoogleClientConfigured() {
  return !!GOOGLE_CLIENT_ID;
}

function ensureGoogleOAuthRedirectConfigured() {
  return !!GOOGLE_CLIENT_ID && !!GOOGLE_CLIENT_SECRET && !!GOOGLE_REDIRECT_URI;
}

function redirectGoogleAuthError(res, reason) {
  // OAuth callbacks happen on the backend domain, but users should always land back on the website login UI.
  return res.redirect(buildAppLoginUrl({ google_error: reason || 'oauth_failed', tab: 'login' }));
}

async function getGoogleProfileFromIdToken(idToken) {
  if (!idToken || typeof idToken !== 'string') return { valid: false, reason: 'missing_id_token' };
  try {
    const tokenInfoRes = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
    if (!tokenInfoRes.ok) return { valid: false, reason: 'invalid_id_token' };
    const claims = await tokenInfoRes.json();
    if (!claims || typeof claims !== 'object') return { valid: false, reason: 'invalid_id_token' };
    var issuer = String(claims.iss || '');
    var validIssuer = issuer === 'https://accounts.google.com' || issuer === 'accounts.google.com';
    if (!validIssuer) return { valid: false, reason: 'invalid_issuer' };
    var audience = claims.aud;
    var audienceOk = Array.isArray(audience)
      ? audience.indexOf(GOOGLE_CLIENT_ID) !== -1
      : audience === GOOGLE_CLIENT_ID;
    if (!audienceOk) return { valid: false, reason: 'invalid_audience' };
    var exp = Number(claims.exp || 0);
    if (!exp || (exp * 1000) <= Date.now()) return { valid: false, reason: 'expired_id_token' };
    if (!claims.sub) return { valid: false, reason: 'missing_subject' };
    return {
      valid: true,
      profile: {
        sub: String(claims.sub),
        email: normalizeEmail(claims.email),
        emailVerified: claims.email_verified === true || claims.email_verified === 'true',
        givenName: typeof claims.given_name === 'string' ? claims.given_name.trim() : '',
        familyName: typeof claims.family_name === 'string' ? claims.family_name.trim() : '',
        name: typeof claims.name === 'string' ? claims.name.trim() : '',
        picture: typeof claims.picture === 'string' ? claims.picture.trim() : ''
      }
    };
  } catch (error) {
    console.error('Google id_token verification error:', error && error.message ? error.message : error);
    return { valid: false, reason: 'invalid_id_token' };
  }
}

async function verifyGoogleAccessToken(accessToken) {
  if (!accessToken || typeof accessToken !== 'string') return { valid: false, reason: 'missing_access_token' };
  try {
    const tokenInfoRes = await fetch('https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=' + encodeURIComponent(accessToken));
    if (!tokenInfoRes.ok) return { valid: false, reason: 'invalid_access_token' };
    const tokenInfo = await tokenInfoRes.json();
    if (!tokenInfo || typeof tokenInfo !== 'object') return { valid: false, reason: 'invalid_access_token' };
    var audience = tokenInfo.aud || tokenInfo.issued_to || '';
    if (String(audience) !== GOOGLE_CLIENT_ID) return { valid: false, reason: 'invalid_audience' };
    var expiresIn = Number(tokenInfo.expires_in || 0);
    if (expiresIn <= 0) return { valid: false, reason: 'expired_access_token' };
    var profile = await getGoogleUserInfo(accessToken);
    if (!profile || !profile.sub || !profile.email) return { valid: false, reason: 'missing_profile_data' };
    return { valid: true, profile: profile };
  } catch (error) {
    console.error('Google access_token verification error:', error && error.message ? error.message : error);
    return { valid: false, reason: 'invalid_access_token' };
  }
}

function mergeGoogleProfile(primary, fallback) {
  return {
    sub: primary.sub || fallback.sub || '',
    email: primary.email || fallback.email || '',
    emailVerified: !!(primary.emailVerified || fallback.emailVerified),
    givenName: primary.givenName || fallback.givenName || '',
    familyName: primary.familyName || fallback.familyName || '',
    name: primary.name || fallback.name || '',
    picture: primary.picture || fallback.picture || ''
  };
}

function splitGoogleDisplayName(profile) {
  // Return existing split names if present; otherwise split a full display name from Google.
  if (!profile || profile.givenName || profile.familyName || !profile.name) {
    return {
      givenName: profile && profile.givenName ? profile.givenName : '',
      familyName: profile && profile.familyName ? profile.familyName : ''
    };
  }
  var parts = String(profile.name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { givenName: '', familyName: '' };
  return {
    givenName: parts.shift() || '',
    familyName: parts.join(' ')
  };
}

async function findOrCreateGoogleUser(profile) {
  const users = db.collection('users');
  let user = await users.findOne({ googleId: profile.sub });
  if (!user) {
    const byEmail = await users.findOne({ email: profile.email });
    if (byEmail && byEmail.googleId && byEmail.googleId !== profile.sub) {
      return { error: 'google_account_conflict' };
    }
    if (byEmail) {
      const nameParts = splitGoogleDisplayName(profile);
      const setFields = {
        googleId: profile.sub,
        googleEmailVerified: !!profile.emailVerified,
        updatedAt: new Date()
      };
      if (!byEmail.firstName && nameParts.givenName) setFields.firstName = nameParts.givenName;
      if (!byEmail.lastName && nameParts.familyName) setFields.lastName = nameParts.familyName;
      if (!byEmail.googlePicture && profile.picture) setFields.googlePicture = profile.picture;
      await users.updateOne({ _id: byEmail._id }, { $set: setFields });
      user = Object.assign({}, byEmail, setFields);
    }
  }

  if (!user) {
    const nameParts = splitGoogleDisplayName(profile);
    const generatedPassword = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
    const newUserDoc = {
      email: profile.email,
      password: generatedPassword,
      firstName: nameParts.givenName || '',
      lastName: nameParts.familyName || '',
      isAdmin: false,
      googleId: profile.sub,
      googleEmailVerified: !!profile.emailVerified,
      googlePicture: profile.picture || '',
      createdAt: new Date(),
      updatedAt: new Date(),
      lastLoginAt: new Date()
    };
    const created = await users.insertOne(newUserDoc);
    user = Object.assign({ _id: created.insertedId }, newUserDoc);
  }
  return { user: user };
}

async function finalizeGoogleLogin(req, res, user) {
  const users = db.collection('users');
  const token = jwt.sign(
    { userId: user._id.toString(), email: user.email, isAdmin: user.isAdmin === true },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  setAuthCookies(res, token, user.email, user.firstName || user.email, user._id.toString());
  const deviceFingerprint = buildDeviceFingerprint(req);
  const knownDeviceFingerprints = Array.isArray(user.knownDeviceFingerprints) ? user.knownDeviceFingerprints : [];
  const isNewDevice = !knownDeviceFingerprints.includes(deviceFingerprint);
  const updatedFingerprints = isNewDevice
    ? [deviceFingerprint].concat(knownDeviceFingerprints).slice(0, 20)
    : knownDeviceFingerprints;
  await users.updateOne(
    { _id: user._id },
    { $set: { knownDeviceFingerprints: updatedFingerprints, lastLoginAt: new Date(), updatedAt: new Date() } }
  );
  if (isNewDevice) {
    await maybeSendPreferenceNotificationEmail(
      user._id.toString(),
      'login_notifications',
      'New device sign-in detected',
      `<p>We detected a sign-in to your Zorexium account from a new device.</p><p>If this was you, no action is needed. If not, please review your security settings immediately.</p>`,
      '/marketplace-settings.html#panel-security'
    );
  }
  return {
    token: token,
    user: user
  };
}

async function getGoogleUserInfo(accessToken) {
  if (!accessToken) return null;
  try {
    const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: 'Bearer ' + accessToken }
    });
    if (!infoRes.ok) return null;
    const info = await infoRes.json();
    return {
      sub: info && info.sub ? String(info.sub) : '',
      email: normalizeEmail(info && info.email),
      emailVerified: info && (info.email_verified === true || info.email_verified === 'true'),
      givenName: typeof (info && info.given_name) === 'string' ? info.given_name.trim() : '',
      familyName: typeof (info && info.family_name) === 'string' ? info.family_name.trim() : '',
      name: typeof (info && info.name) === 'string' ? info.name.trim() : '',
      picture: typeof (info && info.picture) === 'string' ? info.picture.trim() : ''
    };
  } catch (_) {
    return null;
  }
}

async function getGoogleProfileFromCredentialPayload(payload) {
  if (!payload || typeof payload !== 'object') return { valid: false, reason: 'missing_google_token' };
  var idToken = typeof payload.credential === 'string' ? payload.credential.trim() : '';
  if (!idToken) idToken = typeof payload.idToken === 'string' ? payload.idToken.trim() : '';
  var accessToken = typeof payload.accessToken === 'string' ? payload.accessToken.trim() : '';
  var verified = null;
  if (idToken) {
    verified = await getGoogleProfileFromIdToken(idToken);
  } else if (accessToken) {
    verified = await verifyGoogleAccessToken(accessToken);
  } else {
    return { valid: false, reason: 'missing_google_token' };
  }
  if (!verified.valid) return verified;
  var profile = verified.profile;
  if (isGoogleProfileIncomplete(profile) && accessToken) {
    var userInfo = await getGoogleUserInfo(accessToken);
    if (userInfo) profile = mergeGoogleProfile(profile, userInfo);
  }
  if (!profile.sub || !profile.email) return { valid: false, reason: 'missing_profile_data' };
  return {
    valid: true,
    profile: profile
  };
}

function isGoogleProfileIncomplete(profile) {
  if (!profile || typeof profile !== 'object') return true;
  if (!profile.email) return true;
  if (!profile.givenName) return true;
  if (!profile.familyName) return true;
  if (!profile.picture) return true;
  return false;
}

app.get('/api/auth/google', authRateLimit, function(req, res) {
  if (!ensureGoogleOAuthRedirectConfigured()) {
    return res.status(503).json({ error: 'Google sign-in is not configured' });
  }
  var returnToPath = normalizePostLoginRedirectPath(req.query.returnTo);
  var state = createGoogleOAuthState(returnToPath);
  var authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', GOOGLE_REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', GOOGLE_OAUTH_SCOPES);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('prompt', 'select_account');
  res.redirect(authUrl.toString());
});

app.get('/api/auth/google/callback', authRateLimit, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  if (!ensureGoogleOAuthRedirectConfigured()) return redirectGoogleAuthError(res, 'provider_not_configured');

  var oauthError = typeof req.query.error === 'string' ? req.query.error : '';
  if (oauthError) {
    var reason = oauthError === 'access_denied' ? 'cancelled' : 'provider_rejected';
    return redirectGoogleAuthError(res, reason);
  }

  var providedState = typeof req.query.state === 'string' ? req.query.state : '';
  if (!providedState) return redirectGoogleAuthError(res, 'invalid_state');
  var oauthStateEntry = consumeGoogleOAuthState(providedState);
  if (!oauthStateEntry) return redirectGoogleAuthError(res, 'invalid_state');

  var authCode = typeof req.query.code === 'string' ? req.query.code : '';
  if (!authCode) return redirectGoogleAuthError(res, 'missing_code');

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: authCode,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code'
      }).toString()
    });

    if (!tokenRes.ok) return redirectGoogleAuthError(res, 'token_exchange_failed');
    const tokenData = await tokenRes.json();
    if (!tokenData || !tokenData.id_token) return redirectGoogleAuthError(res, 'invalid_token_response');

    var profileResult = await getGoogleProfileFromCredentialPayload({
      idToken: tokenData.id_token,
      accessToken: tokenData.access_token
    });
    if (!profileResult.valid) return redirectGoogleAuthError(res, profileResult.reason);
    var profile = profileResult.profile;
    var userResult = await findOrCreateGoogleUser(profile);
    if (userResult.error) return redirectGoogleAuthError(res, userResult.error);
    var loginResult = await finalizeGoogleLogin(req, res, userResult.user);

    var returnToPath = normalizePostLoginRedirectPath(oauthStateEntry.returnToPath);
    var bridgeCode = createGoogleBridgeToken({
      token: loginResult.token,
      user: {
        email: userResult.user.email,
        firstName: userResult.user.firstName || '',
        lastName: userResult.user.lastName || '',
        picture: userResult.user.googlePicture || profile.picture || ''
      },
      redirectTo: returnToPath
    });
    // Redirect back to the frontend login page so it can exchange the short bridge code for localStorage auth state.
    res.redirect(buildAppLoginUrl({ google: 'success', code: bridgeCode }));
  } catch (error) {
    console.error('Google callback error:', error);
    return redirectGoogleAuthError(res, 'oauth_failed');
  }
});

app.get('/api/auth/google/session', authRateLimit, function(req, res) {
  var code = typeof req.query.code === 'string' ? req.query.code : '';
  var session = consumeGoogleBridgeToken(code);
  if (!session) return res.status(400).json({ error: 'Invalid or expired Google session code' });
  res.json({
    token: session.token,
    user: session.user,
    redirectTo: normalizePostLoginRedirectPath(session.redirectTo)
  });
});

app.post('/api/auth/google/token', authRateLimit, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  if (!ensureGoogleClientConfigured()) return res.status(503).json({ error: 'Google sign-in is not configured' });
  try {
    var profileResult = await getGoogleProfileFromCredentialPayload(req.body || {});
    if (!profileResult.valid) {
      return res.status(401).json({ error: profileResult.reason || 'invalid_google_token' });
    }
    var profile = profileResult.profile;
    var userResult = await findOrCreateGoogleUser(profile);
    if (userResult.error) {
      if (userResult.error === 'google_account_conflict') return res.status(409).json({ error: userResult.error });
      return res.status(400).json({ error: userResult.error });
    }
    var loginResult = await finalizeGoogleLogin(req, res, userResult.user);
    var returnToPath = normalizePostLoginRedirectPath(req.body && req.body.returnTo);
    return res.json({
      message: 'Google sign-in successful',
      token: loginResult.token,
      user: {
        email: userResult.user.email,
        firstName: userResult.user.firstName || '',
        lastName: userResult.user.lastName || '',
        picture: userResult.user.googlePicture || profile.picture || ''
      },
      redirectTo: returnToPath
    });
  } catch (error) {
    console.error('Google token login error:', error);
    return res.status(500).json({ error: 'google_auth_failed' });
  }
});

app.post('/api/auth/register', authRateLimit, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  
  try {
    const { email, password, firstName, lastName } = req.body;
    const normalizedEmail = normalizeEmail(email);
    
    if (!normalizedEmail || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    
    const existingUser = await db.collection('users').findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(400).json({ error: 'User already exists' });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    
    const result = await db.collection('users').insertOne({
      email: normalizedEmail,
      password: hashedPassword,
      firstName: firstName || '',
      lastName: lastName || '',
      isAdmin: false,
      createdAt: new Date()
    });

    const token = jwt.sign(
      { userId: result.insertedId.toString(), email: normalizedEmail, isAdmin: false },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    setAuthCookies(res, token, normalizedEmail, firstName || normalizedEmail, result.insertedId.toString());
    res.json({ message: 'User created successfully', userId: result.insertedId, token, user: { email: normalizedEmail, firstName: firstName || '' } });
    // Send welcome email asynchronously so registration flow is never blocked by email provider delays.
    sendEventEmailSafe(
      normalizedEmail,
      'Welcome to Zorexium',
      `<p>Welcome to Zorexium${firstName ? ', ' + firstName : ''}!</p><p>Your account is ready. Visit your account page to get started.</p>`,
      '/account-details.html'
    );
    sendAdminNotificationSafe(
      'New website user signup',
      `<p>A new user account was created.</p>`
        + `<p><strong>Email:</strong> ${escapeHtml(normalizedEmail)}</p>`
        + `<p><strong>Name:</strong> ${escapeHtml(((firstName || '') + ' ' + (lastName || '')).trim() || 'Not provided')}</p>`
        + `<p><strong>User ID:</strong> ${escapeHtml(String(result.insertedId))}</p>`,
      '/marketplace-settings.html'
    );
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/login', authRateLimit, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  
  try {
    const { email, password } = req.body;
    const normalizedEmail = normalizeEmail(email);
    
    if (!normalizedEmail || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    
    const user = await db.collection('users').findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    const token = jwt.sign(
      { userId: user._id.toString(), email: user.email, isAdmin: user.isAdmin === true },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    setAuthCookies(res, token, user.email, user.firstName || user.email, user._id.toString());
    // Detect first-time/new device sign-in and notify the user when login notifications are enabled.
    const deviceFingerprint = buildDeviceFingerprint(req);
    const knownDeviceFingerprints = Array.isArray(user.knownDeviceFingerprints) ? user.knownDeviceFingerprints : [];
    const isNewDevice = !knownDeviceFingerprints.includes(deviceFingerprint);
    const updatedFingerprints = isNewDevice
      ? [deviceFingerprint].concat(knownDeviceFingerprints).slice(0, 20)
      : knownDeviceFingerprints;
    await db.collection('users').updateOne(
      { _id: user._id },
      { $set: { knownDeviceFingerprints: updatedFingerprints, lastLoginAt: new Date(), updatedAt: new Date() } }
    );
    if (isNewDevice) {
      await maybeSendPreferenceNotificationEmail(
        user._id.toString(),
        'login_notifications',
        'New device sign-in detected',
        `<p>We detected a sign-in to your Zorexium account from a new device.</p><p>If this was you, no action is needed. If not, please review your security settings immediately.</p>`,
        '/marketplace-settings.html#panel-security'
      );
    }
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

// ── ONE-TIME CODE (OTC) LOGIN ─────────────────────────────────────────────────

// POST /api/auth/otc-request – generate and email a one-time login code
app.post('/api/auth/otc-request', authRateLimit, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  const { email } = req.body;
  if (!email || typeof email !== 'string' || email.length > 254) {
    return res.status(400).json({ error: 'Valid email is required' });
  }
  const normalizedEmail = email.trim().toLowerCase();
  try {
    const user = await db.collection('users').findOne({ email: normalizedEmail });
    // Always respond with success to prevent email enumeration
    if (!user) {
      return res.json({ message: 'If that email is registered, a one-time code will be sent.' });
    }
    // Generate a 6-digit numeric OTC (valid for 30 minutes) using cryptographically secure random.
    // Each request issues a fresh single-use code.
    const otcCode = String(crypto.randomInt(100000, 1000000));
    const otcExpiry = new Date(Date.now() + 30 * 60 * 1000);
    await db.collection('users').updateOne(
      { _id: user._id },
      { $set: { otcCode, otcExpiry } }
    );
    try {
      await sendEventEmail(
        normalizedEmail,
        'Your Zorexium one-time sign-in code',
        `<p>Your one-time sign-in code is: <strong>${otcCode}</strong></p>
<p>This code expires in 30 minutes and can only be used once.</p>
<p>If you did not request this code, you can ignore this email.</p>`,
        '/login-register.html'
      );
    } catch (mailErr) {
      console.error('Failed to send OTC email:', mailErr.message);
    }
    res.json({ message: 'If that email is registered, a one-time code will be sent.' });
  } catch (error) {
    console.error('Error in otc-request:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/auth/otc-login – verify OTC and issue JWT
app.post('/api/auth/otc-login', authRateLimit, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  const { email, code } = req.body;
  if (!email || !code) {
    return res.status(400).json({ error: 'email and code are required' });
  }
  const normalizedEmail = (typeof email === 'string' ? email : '').trim().toLowerCase();
  try {
    const user = await db.collection('users').findOne({
      email: normalizedEmail,
      otcCode: String(code).trim(),
      otcExpiry: { $gt: new Date() }
    });
    if (!user) {
      return res.status(401).json({ error: 'Invalid or expired code' });
    }
    // Clear the OTC after successful use
    await db.collection('users').updateOne(
      { _id: user._id },
      { $unset: { otcCode: '', otcExpiry: '' } }
    );
    const token = jwt.sign(
      { userId: user._id.toString(), email: user.email, isAdmin: user.isAdmin === true },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    setAuthCookies(res, token, user.email, user.firstName || user.email, user._id.toString());
    const deviceFingerprint = buildDeviceFingerprint(req);
    const knownDeviceFingerprints = Array.isArray(user.knownDeviceFingerprints) ? user.knownDeviceFingerprints : [];
    const isNewDevice = !knownDeviceFingerprints.includes(deviceFingerprint);
    const updatedFingerprints = isNewDevice
      ? [deviceFingerprint].concat(knownDeviceFingerprints).slice(0, 20)
      : knownDeviceFingerprints;
    await db.collection('users').updateOne(
      { _id: user._id },
      { $set: { knownDeviceFingerprints: updatedFingerprints, lastLoginAt: new Date(), updatedAt: new Date() } }
    );
    if (isNewDevice) {
      await maybeSendPreferenceNotificationEmail(
        user._id.toString(),
        'login_notifications',
        'New device sign-in detected',
        `<p>We detected a sign-in to your Zorexium account from a new device.</p><p>If this was you, no action is needed. If not, please review your security settings immediately.</p>`,
        '/marketplace-settings.html#panel-security'
      );
    }
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
    console.error('Error in otc-login:', error);
    res.status(500).json({ error: error.message });
  }
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
app.post('/api/products', publicApiRateLimit, verifyToken, async function(req, res) {
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

    // Enforce Starter tier listing limit (max active listings)
    const seller = await db.collection('sellers').findOne({ userId: req.userId });
    if (seller && (seller.tier === 'starter' || !seller.tier)) {
      const activeCount = await db.collection('products').countDocuments({
        sellerId: req.userId,
        status: { $in: ['active', 'approved', 'pending'] }
      });
      if (activeCount >= STARTER_LISTING_LIMIT) {
        return res.status(403).json({
          error: `Starter tier sellers are limited to ${STARTER_LISTING_LIMIT} active listings. Upgrade to Pro to list unlimited products.`,
          code: 'LISTING_LIMIT_REACHED'
        });
      }
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

    // Enforce backend per-image size only (10 MB each) for listing uploads encoded as data URLs.
    const incomingImages = [];
    if (typeof image === 'string' && image) incomingImages.push(image);
    if (Array.isArray(images)) incomingImages.push(...images);
    for (const img of incomingImages) {
      if (typeof img !== 'string' || !img.startsWith('data:image/')) continue;
      const bytes = getDataUrlPayloadBytes(img);
      if (bytes === null) return res.status(400).json({ error: 'Invalid image data URL' });
      if (bytes > MAX_IMAGE_SIZE_BYTES) return res.status(400).json({ error: 'Image too large. Max: 10 MB per image.' });
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
    try {
      const sellerUser = await db.collection('users').findOne({ _id: new ObjectId(req.userId) }, { projection: { email: 1 } });
      const sellerEmail = normalizeEmail(sellerUser && sellerUser.email);
      if (sellerEmail) {
        await sendEventEmailSafe(
          sellerEmail,
          'Your product is now listed on Zorexium',
          `<p>Your item <strong>${product.name}</strong> has been listed successfully.</p><p>You can manage this listing any time from your seller dashboard.</p>`,
          '/product-detail.html?id=' + encodeURIComponent(String(result.insertedId))
        );
      }
      await sendAdminNotificationSafe(
        'New seller product upload',
        `<p>A seller uploaded a product listing.</p>`
          + `<p><strong>Product:</strong> ${escapeHtml(String(product.name || 'Untitled product'))}</p>`
          + `<p><strong>Category:</strong> ${escapeHtml(String(product.category || 'N/A'))}</p>`
          + `<p><strong>Price:</strong> $${escapeHtml(Number(product.price).toFixed(2))}</p>`
          + `<p><strong>Seller ID:</strong> ${escapeHtml(String(req.userId || 'N/A'))}</p>`
          + `<p><strong>Seller email:</strong> ${escapeHtml(String(sellerEmail || 'N/A'))}</p>`
          + `<p><strong>Listing ID:</strong> ${escapeHtml(String(result.insertedId))}</p>`,
        '/product-detail.html?id=' + encodeURIComponent(String(result.insertedId))
      );
    } catch (mailErr) {
      console.error('Failed to send product listed email:', mailErr.message);
    }
    res.status(201).json({ ...product, _id: result.insertedId });
  } catch (error) {
    console.error('Error creating product:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/products/seller/:sellerId – products by seller (public) ───────────
app.get('/api/products/seller/:sellerId', publicApiRateLimit, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  const { sellerId } = req.params;
  if (!sellerId || sellerId.length > 128) {
    return res.status(400).json({ error: 'Invalid sellerId' });
  }

  try {
    // Primary lookup by sellerId field.
    let products = await db.collection('products')
      .find({ sellerId })
      .toArray();

    // Fallback: if no products found by sellerId, try matching by sellerName/sellerUsername.
    // This surfaces listings created before sellerId was consistently populated.
    if (products.length === 0) {
      const sellerRecord = await db.collection('sellers').findOne(
        { userId: sellerId },
        { projection: { shopName: 1, sellerName: 1, sellerUsername: 1 } }
      );
      if (sellerRecord) {
        const nameClauses = [];
        if (sellerRecord.shopName) nameClauses.push({ sellerName: sellerRecord.shopName });
        if (sellerRecord.sellerName) nameClauses.push({ sellerName: sellerRecord.sellerName });
        if (sellerRecord.sellerUsername) nameClauses.push({ sellerUsername: sellerRecord.sellerUsername });
        if (nameClauses.length > 0) {
          products = await db.collection('products')
            .find({ $or: nameClauses })
            .toArray();
        }
      }
    }

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
    // Enforce backend per-image size only (10 MB each) for listing image updates.
    if (image !== undefined && typeof image === 'string' && image.startsWith('data:image/')) {
      const bytes = getDataUrlPayloadBytes(image);
      if (bytes === null) return res.status(400).json({ error: 'Invalid image data URL' });
      if (bytes > MAX_IMAGE_SIZE_BYTES) return res.status(400).json({ error: 'Image too large. Max: 10 MB per image.' });
    }
    if (image !== undefined) updates.image = image;
    if (images !== undefined) {
      const imagesArr = Array.isArray(images) ? images : [];
      for (const img of imagesArr) {
        if (typeof img !== 'string' || !img.startsWith('data:image/')) continue;
        const bytes = getDataUrlPayloadBytes(img);
        if (bytes === null) return res.status(400).json({ error: 'Invalid image data URL' });
        if (bytes > MAX_IMAGE_SIZE_BYTES) return res.status(400).json({ error: 'Image too large. Max: 10 MB per image.' });
      }
      updates.images = imagesArr;
    }
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

    const previousEffectivePrice = getEffectiveListingPrice(product);
    await db.collection('products').updateOne({ _id: objectId }, { $set: updates });
    const updated = await db.collection('products').findOne({ _id: objectId });
    const nextEffectivePrice = getEffectiveListingPrice(updated);
    try {
      await notifyPriceChangeSubscribers(updated, previousEffectivePrice, nextEffectivePrice);
    } catch (notifyErr) {
      console.error('Failed to notify price alert subscribers:', notifyErr.message);
    }
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
const PAYPAL_MODE = 'live';
const PAYPAL_API = 'https://api-m.paypal.com';

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_SECRET = process.env.PAYPAL_SECRET;
const PAYPAL_WEBHOOK_ID = process.env.PAYPAL_WEBHOOK_ID || '';
const PAYPAL_PRO_SELLER_PLAN_ID = process.env.PAYPAL_PRO_SELLER_PLAN_ID || null;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_PRO_SELLER_PRICE_ID = process.env.STRIPE_PRO_SELLER_PRICE_ID || '';
const STRIPE_SUCCESS_URL = process.env.STRIPE_SUCCESS_URL || '';
const STRIPE_CANCEL_URL = process.env.STRIPE_CANCEL_URL || '';
const STRIPE_CONNECT_REFRESH_URL = process.env.STRIPE_CONNECT_REFRESH_URL || '';
const STRIPE_CONNECT_RETURN_URL = process.env.STRIPE_CONNECT_RETURN_URL || '';
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
// Pro Seller monthly subscription price (USD) — $1/month
const PRO_SELLER_MONTHLY_PRICE_USD = '1.00';
// Standard shipping rate per item (USD) — $1.00 per item
const DEFAULT_SHIPPING_PER_ITEM_USD = 1.00;
const DEFAULT_SALES_TAX_RATE = 0.10;
const STARTER_SELLER_PAYOUT_RATE = 0.90;
const PRO_SELLER_PAYOUT_RATE = 0.95;
const STANDARD_SELLER_HOLD_DAYS = 5;
const PRO_SELLER_HOLD_DAYS = 2;
const PAYOUT_BRAND_NAME = process.env.PAYOUT_BRAND_NAME || 'Zorexium';
const MAX_ORDER_ID_LENGTH = 64;
const PAYOUT_BATCH_ORDER_ID_SLICE = 40;
const PAYOUT_BATCH_UUID_SLICE = 16;
const MAX_ORDER_EMAIL_DISPATCH_KEY_LENGTH = 100;
// Limit how many blocked payouts are retried per verification request to avoid long-running retries.
const MAX_BLOCKED_PAYOUT_RETRY_BATCH = 100;
const PAYOUT_VERIFICATION_CODE_LENGTH = 6;
const PAYOUT_VERIFICATION_CODE_EXPIRATION_MS = 15 * 60 * 1000;
const MAX_MANUAL_PAY_NOTE_LENGTH = 500;
const RETROACTIVE_LEGACY_ORDER_REPAIR_LIMIT = Math.max(1, Math.min(50, parseInt(process.env.RETROACTIVE_LEGACY_ORDER_REPAIR_LIMIT, 10) || 20));
const RETROACTIVE_LEGACY_ORDER_REPAIR_FORCE_EMAIL_RESEND = String(process.env.RETROACTIVE_LEGACY_ORDER_REPAIR_FORCE_EMAIL_RESEND || 'true').trim().toLowerCase() !== 'false';
const RETROACTIVE_LEGACY_ORDER_REPAIR_WINDOW_START_UTC = new Date('2026-05-13T00:00:00.000Z');
const RETROACTIVE_LEGACY_ORDER_REPAIR_WINDOW_END_UTC = new Date('2026-05-16T00:00:00.000Z');
// Historical write-off corrections for unrecoverable legacy earnings display mismatches.
// (Empty: the retroactive repair now patches items.sellerId so earnings are computed correctly.)
const SELLER_EARNINGS_WRITE_OFF_BY_SHOP = Object.freeze({});
const PAYPAL_BANK_ONBOARDING_URL = getPayPalBankOnboardingUrlFromEnv();
const PAYPAL_PAYOUT_SCOPE = 'https://uri.paypal.com/services/payments/payouts';
const envPayPalMode = String(process.env.PAYPAL_MODE || '').trim().toLowerCase();

if (envPayPalMode && envPayPalMode !== PAYPAL_MODE) {
  console.warn(`[PayPal] Ignoring PAYPAL_MODE=${process.env.PAYPAL_MODE}; runtime is locked to PAYPAL_MODE=${PAYPAL_MODE}.`);
}

function ensureStripeConfigured() {
  if (!stripe || !STRIPE_SECRET_KEY) {
    throw new Error('Stripe is not configured on the server');
  }
}

function getStripeCheckoutSuccessUrl(orderId) {
  const fallback = makeAbsoluteUrl('/payment-success.html?orderId=' + encodeURIComponent(String(orderId || '')) + '&session_id={CHECKOUT_SESSION_ID}');
  if (!STRIPE_SUCCESS_URL) return fallback;
  try {
    const url = new URL(STRIPE_SUCCESS_URL);
    if (!url.searchParams.has('orderId')) {
      url.searchParams.set('orderId', String(orderId || ''));
    }
    if (!url.searchParams.has('session_id')) {
      url.searchParams.set('session_id', '{CHECKOUT_SESSION_ID}');
    }
    return url.toString();
  } catch (_) {
    return fallback;
  }
}

function getStripeCheckoutCancelUrl() {
  if (!STRIPE_CANCEL_URL) return makeAbsoluteUrl('/checkout.html?cancelled=1');
  return STRIPE_CANCEL_URL;
}

function getStripeConnectRefreshUrl() {
  return STRIPE_CONNECT_REFRESH_URL || makeAbsoluteUrl('/seller-dashboard.html#payouts');
}

function getStripeConnectReturnUrl() {
  return STRIPE_CONNECT_RETURN_URL || makeAbsoluteUrl('/seller-dashboard.html#payouts');
}

function toStripeAmountCents(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  const normalized = Math.trunc((numeric + Number.EPSILON) * 100);
  return Math.max(0, normalized);
}

function normalizePayoutAccountId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.includes('@')) return normalizeEmail(raw);
  return raw.slice(0, 128);
}

function normalizeCountryCode(value) {
  const countryCode = String(value || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(countryCode) ? countryCode : '';
}

function normalizeSellerTier(value) {
  return String(value || '').trim().toLowerCase() === 'pro' ? 'pro' : 'starter';
}

function getSellerPayoutRateByTier(value) {
  return normalizeSellerTier(value) === 'pro'
    ? PRO_SELLER_PAYOUT_RATE
    : STARTER_SELLER_PAYOUT_RATE;
}

function getSellerHoldDaysByTier(value) {
  return normalizeSellerTier(value) === 'pro'
    ? PRO_SELLER_HOLD_DAYS
    : STANDARD_SELLER_HOLD_DAYS;
}

function addUtcDays(dateValue, dayCount) {
  const base = dateValue ? new Date(dateValue) : new Date();
  const next = new Date(base.getTime());
  next.setUTCDate(next.getUTCDate() + Math.max(0, parseInt(dayCount, 10) || 0));
  return next;
}

function parsePayPalScopes(rawScope) {
  return String(rawScope || '')
    .split(/\s+/)
    .map(function(scope) { return scope.trim(); })
    .filter(Boolean);
}

function hasPayPalPayoutScope(scopes) {
  const scopeSet = new Set(parsePayPalScopes(scopes));
  return scopeSet.has(PAYPAL_PAYOUT_SCOPE);
}

// fetchPayPalAccessToken() returns { token, apiUrl, scopes } where apiUrl is the
// PayPal API base URL that was used to authenticate.
async function fetchPayPalAccessToken() {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_SECRET) {
    throw new Error('PayPal credentials (PAYPAL_CLIENT_ID and/or PAYPAL_SECRET) are not configured on the server');
  }
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString('base64');
  const tokenRes = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  const tokenData = await tokenRes.json();
  const accessToken = tokenData && tokenData.access_token;

  if (!tokenRes.ok || !accessToken) {
    throw new Error(
      (tokenData && (tokenData.error_description || tokenData.error || tokenData.message)) ||
      'Failed to authenticate with PayPal'
    );
  }

  return {
    token: accessToken,
    apiUrl: PAYPAL_API,
    scopes: parsePayPalScopes(tokenData && tokenData.scope)
  };
}

function getPayPalWebhookHeaders(req) {
  return {
    transmissionId: String(req && req.headers ? (req.headers['paypal-transmission-id'] || '') : '').trim(),
    transmissionTime: String(req && req.headers ? (req.headers['paypal-transmission-time'] || '') : '').trim(),
    transmissionSig: String(req && req.headers ? (req.headers['paypal-transmission-sig'] || '') : '').trim(),
    authAlgo: String(req && req.headers ? (req.headers['paypal-auth-algo'] || '') : '').trim(),
    certUrl: String(req && req.headers ? (req.headers['paypal-cert-url'] || '') : '').trim()
  };
}

async function verifyPayPalWebhookSignature(webhookEvent, webhookHeaders) {
  if (!PAYPAL_WEBHOOK_ID) {
    throw new Error('PAYPAL_WEBHOOK_ID environment variable is required to verify PayPal webhooks');
  }
  const { token: accessToken, apiUrl: paypalApiUrl } = await fetchPayPalAccessToken();
  const verifyRes = await fetch(`${paypalApiUrl}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      auth_algo: webhookHeaders.authAlgo,
      cert_url: webhookHeaders.certUrl,
      transmission_id: webhookHeaders.transmissionId,
      transmission_sig: webhookHeaders.transmissionSig,
      transmission_time: webhookHeaders.transmissionTime,
      webhook_id: PAYPAL_WEBHOOK_ID,
      webhook_event: webhookEvent
    })
  });
  const verifyData = await verifyRes.json().catch(function() { return {}; });
  if (!verifyRes.ok) {
    const reason = verifyData && (verifyData.message || verifyData.error_description || verifyData.name);
    throw new Error(reason || 'Failed to verify PayPal webhook signature');
  }
  const verifyStatus = String(verifyData && verifyData.verification_status ? verifyData.verification_status : '').toUpperCase();
  return verifyStatus === 'SUCCESS';
}

function hasRequiredPayPalWebhookHeaders(webhookHeaders) {
  return !!(
    webhookHeaders &&
    webhookHeaders.transmissionId &&
    webhookHeaders.transmissionSig &&
    webhookHeaders.transmissionTime &&
    webhookHeaders.authAlgo &&
    webhookHeaders.certUrl
  );
}

function getPayPalPayoutWebhookIds(resource) {
  const payoutResource = resource || {};
  const payoutItem = payoutResource && payoutResource.payout_item ? payoutResource.payout_item : {};
  const senderItemId = String(payoutItem.sender_item_id || payoutResource.sender_item_id || '').trim();
  const batchId = String(payoutResource.payout_batch_id || payoutItem.payout_batch_id || '').trim();
  return { senderItemId, batchId };
}

function getOrderSellerInfos(order) {
  const items = Array.isArray(order && order.items) ? order.items : [];
  if (items.length === 0) return [];

  const sellerMap = new Map();
  items.forEach(function(item) {
    const sellerId = String(item && item.sellerId ? item.sellerId : '').trim();
    if (!sellerId) return;
    if (!sellerMap.has(sellerId)) {
      sellerMap.set(sellerId, {
        sellerId: sellerId,
        sellerUsername: String(item && item.sellerUsername ? item.sellerUsername : '').trim(),
        sellerName: String(item && (item.sellerName || item.sellerUsername) ? (item.sellerName || item.sellerUsername) : '').trim()
      });
    } else {
      // Keep the first seller metadata encountered for a sellerId.
      // Items should be normalized before checkout so seller metadata remains consistent across order lines.
    }
  });
  return Array.from(sellerMap.values());
}

function getOrderSellerInfo(order) {
  const sellerInfos = getOrderSellerInfos(order);
  if (sellerInfos.length === 0) {
    return { error: 'Seller ID missing on order item' };
  }
  if (sellerInfos.length > 1) {
    return { error: 'Order includes multiple sellers; specify a sellerId to target a single payout.' };
  }
  return sellerInfos[0];
}

function getSellerFinancials(order, sellerId) {
  const targetSellerId = String(sellerId || '').trim();
  if (!targetSellerId) {
    return { grossAmount: 0, payoutAmount: 0, platformFee: 0, sellerTier: 'starter', payoutRate: STARTER_SELLER_PAYOUT_RATE };
  }

  const sellerSummaries = Array.isArray(order && order.sellerSummaries) ? order.sellerSummaries : [];
  const sellerSummary = sellerSummaries.find(function(summary) {
    return String(summary && summary.sellerId ? summary.sellerId : '') === targetSellerId;
  });
  if (sellerSummary) {
    const sellerTier = normalizeSellerTier(sellerSummary.sellerTier || sellerSummary.tier || 'starter');
    const payoutRate = getSellerPayoutRateByTier(sellerTier);
    const summaryGross = parseFloat(sellerSummary.grossTotal);
    const grossAmount = Number.isFinite(summaryGross) ? Number(summaryGross.toFixed(2)) : 0;
    const summaryNet = parseFloat(sellerSummary.netTotal);
    const payoutAmount = Number.isFinite(summaryNet)
      ? parseFloat(summaryNet.toFixed(2))
      : parseFloat((grossAmount * payoutRate).toFixed(2));
    const summaryFee = parseFloat(sellerSummary.platformFee);
    const platformFee = Number.isFinite(summaryFee)
      ? parseFloat(summaryFee.toFixed(2))
      : parseFloat((grossAmount - payoutAmount).toFixed(2));
    return { grossAmount, payoutAmount, platformFee, sellerTier, payoutRate };
  }

  const sellerItems = (Array.isArray(order && order.items) ? order.items : []).filter(function(item) {
    return String(item && item.sellerId ? item.sellerId : '') === targetSellerId;
  });
  const sellerTier = sellerItems.some(function(item) {
    return normalizeSellerTier(item && item.sellerTier ? item.sellerTier : 'starter') === 'pro';
  }) ? 'pro' : 'starter';
  const payoutRate = getSellerPayoutRateByTier(sellerTier);
  const grossAmountRaw = sellerItems.reduce(function(sum, item) {
    const quantity = parseInt(item && item.quantity, 10);
    if (!Number.isFinite(quantity) || quantity <= 0) return sum;
    const unitPrice = parseFloat(item && item.price) || 0;
    return sum + (unitPrice * quantity);
  }, 0);
  const grossAmount = parseFloat(grossAmountRaw.toFixed(2));
  const payoutAmount = parseFloat((grossAmount * payoutRate).toFixed(2));
  const platformFee = parseFloat((grossAmount - payoutAmount).toFixed(2));
  return { grossAmount, payoutAmount, platformFee, sellerTier, payoutRate };
}

function getLinkedSellerPayoutDestination(order, sellerId) {
  const targetSellerId = String(sellerId || '').trim();
  const payoutAccountIds = new Set();
  let hasVerifiedDestination = false;
  (Array.isArray(order && order.items) ? order.items : []).forEach(function(item) {
    if (String(item && item.sellerId ? item.sellerId : '') !== targetSellerId) return;
    const payoutAccountId = normalizePayoutAccountId(item && item.sellerPayoutAccountId ? item.sellerPayoutAccountId : '');
    if (payoutAccountId) payoutAccountIds.add(payoutAccountId);
    const bankStatus = String(item && item.sellerPayoutBankStatus ? item.sellerPayoutBankStatus : '').toLowerCase();
    if (item && item.sellerPayoutVerified === true && (!bankStatus || bankStatus === 'connected')) hasVerifiedDestination = true;
  });
  // A shipment payout needs one unambiguous receiver per seller for the order.
  if (payoutAccountIds.size !== 1) return { accountId: '', verified: false };
  return { accountId: Array.from(payoutAccountIds)[0], verified: hasVerifiedDestination };
}

function generatePayoutVerificationCode() {
  let code = '';
  for (let i = 0; i < PAYOUT_VERIFICATION_CODE_LENGTH; i++) {
    code += String(crypto.randomInt(0, 10));
  }
  return code;
}

function hashPayoutVerificationCode(code) {
  return crypto.createHash('sha256').update(String(code || '')).digest('hex');
}

function sanitizeSellerForClient(seller) {
  if (!seller || typeof seller !== 'object') return seller;
  const safeSeller = { ...seller };
  delete safeSeller.payoutVerificationCodeHash;
  delete safeSeller.payoutVerificationCodeExpiresAt;
  delete safeSeller.payoutVerificationMethod;
  return safeSeller;
}

async function buildPayoutSnapshot(order, options) {
  const payoutMeta = options || {};
  const orderId = String(order && order.id ? order.id : '').trim();
  const targetSellerId = String(payoutMeta.sellerId || '').trim();
  const sellerInfos = getOrderSellerInfos(order);
  const sellerInfo = targetSellerId
    ? (sellerInfos.find(function(info) { return String(info && info.sellerId ? info.sellerId : '') === targetSellerId; }) || { sellerId: targetSellerId, sellerUsername: '', sellerName: '' })
    : getOrderSellerInfo(order);
  // Seller payouts are calculated from seller-eligible item totals only (not order-level shipping/tax).
  const sellerFinancials = getSellerFinancials(order, sellerInfo.sellerId);
  const grossAmount = sellerFinancials.grossAmount;
  const payoutAmount = sellerFinancials.payoutAmount;
  const platformFee = sellerFinancials.platformFee;
  const sellerTier = sellerFinancials.sellerTier || 'starter';
  const payoutRate = sellerFinancials.payoutRate || getSellerPayoutRateByTier(sellerTier);
  const payoutCurrency = /^[A-Z]{3}$/.test(String(order && order.currency ? order.currency : '').toUpperCase())
    ? String(order.currency).toUpperCase()
    : 'USD';
  const now = new Date();
  const shippedAt = order && order.shippedAt ? new Date(order.shippedAt) : null;
  const holdDays = getSellerHoldDaysByTier(sellerTier);
  const payoutReleaseAt = shippedAt ? addUtcDays(shippedAt, holdDays) : null;
  let seller = null;
  let linkedPayoutDestination = { accountId: '', verified: false };
  let receiverEmail = '';
  let receiverSource = '';
  let sellerPayoutAccountId = '';
  let hasCurrentVerifiedAccount = false;
  let hasLinkedVerifiedAccount = false;
  if (sellerInfo.sellerId) {
    linkedPayoutDestination = getLinkedSellerPayoutDestination(order, sellerInfo.sellerId);
    seller = await db.collection('sellers').findOne(
      { userId: sellerInfo.sellerId },
      { projection: { payoutAccountId: 1, stripeAccountId: 1, payoutVerified: 1, payoutProviderBankStatus: 1, userId: 1, shopName: 1 } }
    );
    sellerPayoutAccountId = normalizePayoutAccountId(
      seller && (seller.stripeAccountId || seller.payoutAccountId) ? (seller.stripeAccountId || seller.payoutAccountId) : ''
    );
    const providerBankStatus = String(seller && seller.payoutProviderBankStatus ? seller.payoutProviderBankStatus : '').toLowerCase();
    hasCurrentVerifiedAccount = !!(seller && seller.payoutVerified && (!providerBankStatus || providerBankStatus === 'connected'));
    hasLinkedVerifiedAccount = !!linkedPayoutDestination.verified;
    if (linkedPayoutDestination.accountId && hasLinkedVerifiedAccount) {
      // Prefer the payout destination captured on sold order items when it was verified.
      receiverEmail = linkedPayoutDestination.accountId;
      receiverSource = 'order_linked';
    } else if (sellerPayoutAccountId && hasCurrentVerifiedAccount) {
      // Fall back to the seller's currently verified payout destination.
      receiverEmail = sellerPayoutAccountId;
      receiverSource = 'seller_profile';
    } else if (sellerPayoutAccountId) {
      receiverEmail = sellerPayoutAccountId;
      receiverSource = 'seller_profile_unverified';
    } else if (linkedPayoutDestination.accountId) {
      receiverEmail = linkedPayoutDestination.accountId;
      receiverSource = 'order_linked_unverified';
    }
  }

  let status = 'pending_delivery';
  let blockedReason = '';
  if (String(order && order.shippingStatus ? order.shippingStatus : '').toLowerCase() === 'shipped') {
    if (!payoutReleaseAt) {
      status = 'pending_delivery';
      blockedReason = 'Shipment timestamp is missing. Please refresh this order and try again.';
    } else if (payoutReleaseAt.getTime() > now.getTime()) {
      status = 'pending_hold';
      blockedReason = `Payout is held for ${holdDays} day${holdDays === 1 ? '' : 's'} after shipment confirmation.`;
    }
    // Payout can proceed when we have a destination email and either:
    // 1) the seller's current payout account is verified, or
    // 2) the linked payout snapshot from the sold item was already verified.
    const receiverMatchesLinked = receiverEmail && receiverEmail === linkedPayoutDestination.accountId;
    const receiverMatchesCurrent = receiverEmail && receiverEmail === sellerPayoutAccountId;
    const hasVerifiedDestination = !!(
      receiverEmail &&
      (
        (receiverMatchesLinked && hasLinkedVerifiedAccount) ||
        (receiverMatchesCurrent && hasCurrentVerifiedAccount)
      )
    );
    if (status !== 'pending_hold' && !hasVerifiedDestination) {
      status = 'blocked_onboarding';
      blockedReason = 'Complete payout account setup to receive this payout.';
    } else if (status !== 'pending_hold') {
      status = 'ready_to_pay';
    }
  }

  const payoutBase = {
    orderId: orderId,
    sellerId: sellerInfo.sellerId || '',
    sellerUsername: sellerInfo.sellerUsername || '',
    sellerName: sellerInfo.sellerName || '',
    sellerTier: sellerTier,
    payoutRate: payoutRate,
    holdDays: holdDays,
    grossAmount: grossAmount,
    amount: payoutAmount,
    platformFee: platformFee,
    currency: payoutCurrency,
    items: Array.isArray(order && order.items) ? order.items : [],
    method: 'Stripe Connect Express',
    placedAt: order.createdAt || now,
    shippedAt: shippedAt,
    payoutReleaseAt: payoutReleaseAt,
    shippingStatus: String(order && order.shippingStatus ? order.shippingStatus : ''),
    triggerSource: payoutMeta.triggerSource || 'order_completed',
    payoutAccountId: receiverEmail || null,
    payoutAccountSource: receiverSource || null,
    linkedPayoutAccountId: linkedPayoutDestination.accountId || null,
    updatedAt: now
  };

  return {
    orderId,
    sellerInfo,
    seller,
    receiverEmail,
    payoutAmount,
    platformFee,
    sellerTier,
    payoutRate,
    holdDays,
    payoutReleaseAt,
    payoutCurrency,
    status,
    blockedReason,
    payoutBase
  };
}

function getOptionalCheckoutUser(req) {
  const authHeader = String(req && req.headers && req.headers.authorization ? req.headers.authorization : '').trim();
  if (!authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (_) {
    return null;
  }
}

function buildSellerOrderSummaries(order) {
  const sellerMap = new Map();
  (Array.isArray(order && order.items) ? order.items : []).forEach(function(item) {
    const sellerId = String(item && item.sellerId ? item.sellerId : '').trim();
    if (!sellerId) return;

    const quantity = parseInt(item && item.quantity, 10) || 1;
    const unitPrice = parseFloat(item && item.price) || 0;
    const grossTotal = parseFloat((unitPrice * quantity).toFixed(2));
    if (!sellerMap.has(sellerId)) {
      sellerMap.set(sellerId, {
        sellerId: sellerId,
        sellerName: String(item && item.sellerName ? item.sellerName : '').trim(),
        sellerUsername: String(item && item.sellerUsername ? item.sellerUsername : '').trim(),
        sellerTier: normalizeSellerTier(item && item.sellerTier ? item.sellerTier : 'starter'),
        itemCount: 0,
        grossTotal: 0,
        items: []
      });
    }

    const summary = sellerMap.get(sellerId);
    summary.itemCount += quantity;
    summary.grossTotal = parseFloat((summary.grossTotal + grossTotal).toFixed(2));
    summary.items.push({
      id: String(item && item.id ? item.id : ''),
      name: String(item && item.name ? item.name : 'Item'),
      quantity: quantity,
      unitPrice: unitPrice,
      lineTotal: grossTotal
    });
  });

  return Array.from(sellerMap.values()).map(function(summary) {
    const sellerTier = normalizeSellerTier(summary.sellerTier || 'starter');
    const payoutRate = getSellerPayoutRateByTier(sellerTier);
    const netTotal = parseFloat((summary.grossTotal * payoutRate).toFixed(2));
    const platformFee = parseFloat((summary.grossTotal - netTotal).toFixed(2));
    return {
      ...summary,
      sellerTier: sellerTier,
      payoutRate: payoutRate,
      platformFee: platformFee,
      netTotal: netTotal
    };
  });
}

function buildReceiptSnapshot(order, sellerSummaries) {
  const receiptId = String(
    order && order.receipt && order.receipt.receiptId
      ? order.receipt.receiptId
      : 'RCT-' + Date.now() + '-' + crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()
  ).slice(0, 64);
  const issuedAt = order && order.receipt && order.receipt.issuedAt
    ? new Date(order.receipt.issuedAt)
    : (order && order.completedAt ? new Date(order.completedAt) : new Date());
  const buyer = order && order.buyer ? order.buyer : {};
  const buyerAddress = buyer && buyer.address ? buyer.address : {};
  const summaries = Array.isArray(sellerSummaries) && sellerSummaries.length > 0
    ? sellerSummaries
    : buildSellerOrderSummaries(order);

  return {
    receiptId: receiptId,
    orderId: String(order && order.id ? order.id : ''),
    issuedAt: issuedAt,
    currency: String(order && order.currency ? order.currency : 'USD').toUpperCase(),
    status: String(order && order.status ? order.status : 'completed'),
    buyer: {
      name: [buyer.firstName, buyer.lastName].filter(Boolean).join(' ').trim(),
      email: normalizeEmail(order && (order.buyerEmail || (buyer && buyer.email)) || ''),
      address: {
        line1: String(buyerAddress.line1 || ''),
        line2: String(buyerAddress.line2 || ''),
        city: String(buyerAddress.city || ''),
        state: String(buyerAddress.state || ''),
        zip: String(buyerAddress.zip || ''),
        country: String(buyerAddress.country || '')
      }
    },
    items: (Array.isArray(order && order.items) ? order.items : []).map(function(item) {
      const quantity = Math.max(1, parseInt(item && item.quantity, 10) || 1);
      const unitPrice = parseFloat(item && item.price) || 0;
      return {
        id: String(item && item.id ? item.id : ''),
        name: String(item && item.name ? item.name : 'Item'),
        quantity: quantity,
        unitPrice: unitPrice,
        lineTotal: parseFloat((unitPrice * quantity).toFixed(2)),
        sellerId: String(item && item.sellerId ? item.sellerId : ''),
        sellerName: String(item && (item.sellerName || item.sellerUsername) ? (item.sellerName || item.sellerUsername) : '')
      };
    }),
    sellerSummaries: summaries,
    totals: {
      subtotal: parseFloat(order && order.subtotal) || 0,
      shipping: parseFloat(order && order.shipping) || 0,
      tax: parseFloat(order && order.tax) || 0,
      total: parseFloat(order && order.total) || 0
    }
  };
}

async function upsertOrderNotification(query, notificationDoc) {
  try {
    await db.collection('notifications').updateOne(
      query,
      {
        $setOnInsert: {
          ...notificationDoc,
          read: false,
          createdAt: new Date()
        }
      },
      { upsert: true }
    );
  } catch (notificationErr) {
    console.error('Failed to persist order notification:', notificationErr.message);
  }
}

async function claimOrderEmailDispatch(orderId, dispatchKey) {
  const normalizedOrderId = String(orderId || '').trim();
  const normalizedKey = String(dispatchKey || '').trim().replace(/[^A-Za-z0-9_-]/g, '_').slice(0, MAX_ORDER_EMAIL_DISPATCH_KEY_LENGTH);
  if (!normalizedOrderId || !normalizedKey) return false;
  const fieldPath = `emailDispatch.${normalizedKey}At`;
  const result = await db.collection('orders').updateOne(
    { id: normalizedOrderId, [fieldPath]: { $exists: false } },
    { $set: { [fieldPath]: new Date(), updatedAt: new Date() } }
  );
  return result.modifiedCount > 0;
}

async function processCompletedOrderAutomation(order, options) {
  const opts = options || {};
  const syncedOrder = await syncCompletedOrderRecords(order);
  const triggerSource = String(opts.triggerSource || 'order_completed');
  const forceEmailResend = opts.forceEmailResend === true;

  let payoutResult = null;
  let payoutResults = [];
  try {
    const payoutBatchResult = await sendStripeSellerPayoutsForOrder(syncedOrder, { triggerSource: triggerSource });
    payoutResult = payoutBatchResult;
    payoutResults = Array.isArray(payoutBatchResult && payoutBatchResult.results) ? payoutBatchResult.results : [];
    if (!payoutBatchResult.ok) {
      console.error('Automatic payout failed for order', syncedOrder.id, '-', payoutBatchResult.error);
    } else {
      for (const sellerPayout of payoutResults) {
        if (!sellerPayout.ok) {
          console.error('Automatic payout failed for order', syncedOrder.id, 'seller', sellerPayout.sellerId, '-', sellerPayout.error);
        } else if (sellerPayout.deferred) {
          console.log('Payout queued for order', syncedOrder.id, 'seller', sellerPayout.sellerId, '-', sellerPayout.reason);
        } else if (sellerPayout.alreadyPaid) {
          console.log('Automatic payout skipped (already paid) for order', syncedOrder.id, 'seller', sellerPayout.sellerId);
        } else {
          console.log('Automatic payout sent for order', syncedOrder.id, 'seller', sellerPayout.sellerId);
        }
      }
    }
  } catch (payoutErr) {
    console.error('Failed to process automatic payout:', payoutErr.message);
  }

  const sellerItemsMap = new Map();
  (Array.isArray(syncedOrder.items) ? syncedOrder.items : []).forEach(function(item) {
    const sellerId = item && item.sellerId ? String(item.sellerId) : '';
    if (!sellerId) return;
    if (!sellerItemsMap.has(sellerId)) sellerItemsMap.set(sellerId, []);
    sellerItemsMap.get(sellerId).push(item);
  });
  const payoutResultBySeller = new Map(payoutResults.map(function(result) {
    return [String(result && result.sellerId ? result.sellerId : ''), result];
  }));
  for (const sellerId of sellerItemsMap.keys()) {
    const currentSellerPayoutResult = payoutResultBySeller.get(String(sellerId)) || null;
    const payoutSent = !!(currentSellerPayoutResult && currentSellerPayoutResult.ok && !currentSellerPayoutResult.deferred && !currentSellerPayoutResult.processing);
    const payoutProcessing = !!(currentSellerPayoutResult && currentSellerPayoutResult.ok && !currentSellerPayoutResult.deferred && currentSellerPayoutResult.processing);
    await upsertOrderNotification(
      { userId: sellerId, type: 'payout_update', orderId: syncedOrder.id },
      {
        userId: sellerId,
        type: 'payout_update',
        orderId: syncedOrder.id,
        title: payoutSent ? 'Payout sent' : (payoutProcessing ? 'Payout processing' : 'Payout status updated'),
        body: payoutSent
          ? `Your payout for order ${syncedOrder.id} was sent.`
          : payoutProcessing
            ? `Your payout for order ${syncedOrder.id} is being processed via Stripe.`
          : `Order ${syncedOrder.id} payout is currently ${currentSellerPayoutResult && currentSellerPayoutResult.reason ? String(currentSellerPayoutResult.reason).toLowerCase() : 'pending review'}.`,
        linkUrl: '/seller-payouts.html'
      }
    );
  }

  const buyerEmail = normalizeEmail(syncedOrder.buyerEmail || (syncedOrder.buyer && syncedOrder.buyer.email) || '');
  if (buyerEmail) {
    const shouldSendBuyerEmail = forceEmailResend || await claimOrderEmailDispatch(syncedOrder.id, 'buyer_purchase_thanks');
    if (shouldSendBuyerEmail) {
      const buyerFirstName = escapeHtml(syncedOrder.buyer && syncedOrder.buyer.firstName ? syncedOrder.buyer.firstName : '');
      const safeOrderId = escapeHtml(syncedOrder.id);
      const safeReceiptId = escapeHtml(syncedOrder.receiptId || 'pending');
      await sendEventEmailSafe(
        buyerEmail,
        'Thank you for your purchase on Zorexium',
        `<p>Thanks for your order${buyerFirstName ? ', ' + buyerFirstName : ''}!</p><p>Your order <strong>${safeOrderId}</strong> has been confirmed.</p><p>Your receipt ID is <strong>${safeReceiptId}</strong>.</p>`,
        '/payment-success.html?orderId=' + encodeURIComponent(syncedOrder.id)
      );
    }
  }

  for (const [sellerId, sellerItems] of sellerItemsMap.entries()) {
    try {
      const shouldSendSellerEmail = forceEmailResend || await claimOrderEmailDispatch(syncedOrder.id, `seller_sale_${sellerId}`);
      if (!shouldSendSellerEmail) continue;
      const sellerUser = await db.collection('users').findOne({ _id: new ObjectId(sellerId) }, { projection: { email: 1, firstName: 1 } });
      const sellerEmail = normalizeEmail(sellerUser && sellerUser.email);
      if (!sellerEmail) continue;
      const firstItem = sellerItems[0] || {};
      const soldItemLink = firstItem.id
        ? '/product-detail.html?id=' + encodeURIComponent(String(firstItem.id))
        : '/seller-dashboard.html';
      await sendEventEmailSafe(
        sellerEmail,
        'Your product sold on Zorexium',
        `<p>Great news${sellerUser && sellerUser.firstName ? ', ' + escapeHtml(sellerUser.firstName) : ''}! Your listing just sold.</p><p>Order <strong>${escapeHtml(syncedOrder.id)}</strong> includes <strong>${sellerItems.length}</strong> item(s) from your shop.</p>`,
        soldItemLink
      );
    } catch (sellerMailErr) {
      console.error('Failed to send seller sold email:', sellerMailErr.message);
    }
  }

  try {
    const shouldSendAdminEmail = forceEmailResend || await claimOrderEmailDispatch(syncedOrder.id, 'admin_purchase_notice');
    if (shouldSendAdminEmail) {
      const buyer = syncedOrder && syncedOrder.buyer ? syncedOrder.buyer : {};
      const buyerName = [buyer.firstName || '', buyer.lastName || ''].join(' ').trim();
      const safeBuyerName = escapeHtml(buyerName || 'Unknown buyer');
      const safeBuyerEmail = escapeHtml(normalizeEmail(syncedOrder.buyerEmail || buyer.email || '') || 'Not provided');
      const safeOrderId = escapeHtml(syncedOrder.id || '');
      const sellerSummary = Array.from(sellerItemsMap.entries()).map(function(entry) {
        const sellerId = entry[0];
        const items = entry[1] || [];
        const first = items[0] || {};
        const sellerName = escapeHtml(first.sellerName || first.sellerUsername || sellerId);
        return '<li>' + sellerName + ' (' + items.length + ' item' + (items.length === 1 ? '' : 's') + ')</li>';
      }).join('');
      const productsSummary = (Array.isArray(syncedOrder.items) ? syncedOrder.items : []).map(function(item) {
        const itemName = escapeHtml(item && item.name ? item.name : 'Item');
        const qty = parseInt(item && item.quantity, 10) || 1;
        const price = Number(item && item.price);
        const itemPrice = Number.isFinite(price) ? '$' + price.toFixed(2) : 'N/A';
        const sellerName = escapeHtml(item && (item.sellerName || item.sellerUsername || item.sellerId) ? (item.sellerName || item.sellerUsername || item.sellerId) : 'Unknown seller');
        return '<li><strong>' + itemName + '</strong> — Qty: ' + qty + ' — Price: ' + itemPrice + ' — Seller: ' + sellerName + '</li>';
      }).join('');
      await sendEventEmailSafe(
        ADMIN_NOTIFICATION_EMAIL,
        'New purchase completed on Zorexium',
        '<p>A purchase was completed on checkout.</p>'
          + '<p><strong>Order ID:</strong> ' + safeOrderId + '<br>'
          + '<strong>Buyer:</strong> ' + safeBuyerName + '<br>'
          + '<strong>Buyer Email:</strong> ' + safeBuyerEmail + '<br>'
          + '<strong>Total:</strong> $' + Number(syncedOrder.total || 0).toFixed(2) + '</p>'
          + '<p><strong>Sellers in order:</strong></p><ul>' + (sellerSummary || '<li>No seller info</li>') + '</ul>'
          + '<p><strong>Products:</strong></p><ul>' + (productsSummary || '<li>No product details</li>') + '</ul>',
        '/order-history.html'
      );
    }
  } catch (adminMailErr) {
    console.error('Failed to send admin purchase email:', adminMailErr.message);
  }

  return { order: syncedOrder, payoutResult, payoutResults };
}

async function reserveInventoryForOrder(order) {
  const reservations = [];
  const items = Array.isArray(order && order.items) ? order.items : [];
  const now = new Date();

  for (const item of items) {
    const productId = String(item && item.id ? item.id : '').trim();
    if (!ObjectId.isValid(productId)) continue;
    const quantityRequested = Math.max(1, parseInt(item && item.quantity, 10) || 1);

    // Reserve stock atomically at capture time so concurrent checkouts cannot oversell this listing.
    const reserveResult = await db.collection('products').updateOne(
      { _id: new ObjectId(productId), status: 'active', quantity: { $gte: quantityRequested } },
      { $inc: { quantity: -quantityRequested }, $set: { updatedAt: now } }
    );
    if (reserveResult.modifiedCount === 0) {
      const productSnapshot = await db.collection('products').findOne(
        { _id: new ObjectId(productId) },
        { projection: { quantity: 1, status: 1 } }
      );
      const availableQuantity = Math.max(0, parseInt(productSnapshot && productSnapshot.quantity, 10) || 0);
      const rawProductName = String(item && item.name ? item.name : 'A product');
      const safeProductName = rawProductName.length > 100 ? (rawProductName.slice(0, 100) + '…') : rawProductName;
      if (!productSnapshot) {
        throw new Error(`"${safeProductName}" is no longer available.`);
      }
      throw new Error(`"${safeProductName}" is no longer available in the requested quantity (requested: ${quantityRequested}, available: ${availableQuantity}).`);
    }

    reservations.push({ productId: productId, quantity: quantityRequested });
  }

  return reservations;
}

async function releaseInventoryReservations(reservations) {
  const rollbackItems = Array.isArray(reservations) ? reservations : [];
  if (rollbackItems.length === 0) return;

  const now = new Date();
  for (const reservation of rollbackItems) {
    const productId = String(reservation && reservation.productId ? reservation.productId : '').trim();
    if (!ObjectId.isValid(productId)) continue;
    const quantityToRestore = Math.max(1, parseInt(reservation && reservation.quantity, 10) || 1);
    const restoreResult = await db.collection('products').updateOne(
      { _id: new ObjectId(productId) },
      { $inc: { quantity: quantityToRestore }, $set: { updatedAt: now } }
    );
    if (restoreResult.modifiedCount === 0) {
      console.warn(`Inventory rollback skipped because product ${productId} was not found`);
    }
  }
}

async function syncCompletedOrderRecords(order) {
  const now = new Date();
  const completedAt = order && order.completedAt ? new Date(order.completedAt) : now;
  const sellerSummaries = buildSellerOrderSummaries(order);
  const receipt = buildReceiptSnapshot({ ...order, completedAt: completedAt }, sellerSummaries);
  const inventoryAlreadyReserved = Boolean(order && order.inventoryReserved);
  let buyerUser = null;

  // Persist a reusable receipt so buyer-facing pages always have a durable, itemized record to render.
  await db.collection('receipts').updateOne(
    { orderId: order.id },
    {
      $setOnInsert: { createdAt: now },
      $set: {
        ...receipt,
        updatedAt: now
      }
    },
    { upsert: true }
  );

  const inventoryItems = Array.isArray(order && order.items) ? order.items : [];
  for (const item of inventoryItems) {
    const productId = String(item && item.id ? item.id : '').trim();
    if (!ObjectId.isValid(productId)) continue;
    const quantitySold = parseInt(item && item.quantity, 10) || 1;
    const inventoryResult = await db.collection('inventoryAdjustments').updateOne(
      { orderId: order.id, productId: productId },
      {
        $setOnInsert: {
          orderId: order.id,
          productId: productId,
          sellerId: String(item && item.sellerId ? item.sellerId : ''),
          quantitySold: quantitySold,
          createdAt: now
        },
        $set: { updatedAt: now }
      },
      { upsert: true }
    );
    if (inventoryResult.upsertedCount > 0) {
      if (inventoryAlreadyReserved) {
        // Capture already reserved inventory earlier; only enforce inactive state when sold out.
        const reservedProduct = await db.collection('products').findOne(
          { _id: new ObjectId(productId) },
          { projection: { quantity: 1, status: 1 } }
        );
        const reservedQuantity = Math.max(0, parseInt(reservedProduct && reservedProduct.quantity, 10) || 0);
        const reservedStatus = reservedProduct && reservedProduct.status != null
          ? String(reservedProduct.status).toLowerCase()
          : null;
        if (reservedProduct && reservedQuantity === 0 && reservedStatus === 'active') {
          // Business rule: once inventory reaches zero after a completed purchase, hide the listing.
          await db.collection('products').updateOne(
            { _id: new ObjectId(productId) },
            { $set: { status: 'inactive', updatedAt: now } }
          );
        }
      } else {
        const product = await db.collection('products').findOne(
          { _id: new ObjectId(productId) },
          { projection: { quantity: 1 } }
        );
        if (product) {
          const currentQuantity = Math.max(0, parseInt(product.quantity, 10) || 0);
          const nextQuantity = Math.max(0, currentQuantity - quantitySold);
          const productUpdateFields = { quantity: nextQuantity, updatedAt: now };
          if (nextQuantity === 0) {
            // Business rule: automatically deactivate a listing once all inventory is sold.
            // This prevents new purchases and hides the item from marketplace search results.
            productUpdateFields.status = 'inactive';
          }
          await db.collection('products').updateOne(
            { _id: new ObjectId(productId) },
            { $set: productUpdateFields }
          );
        }
      }
    }
  }

  if (order && order.userId && ObjectId.isValid(order.userId)) {
    buyerUser = await db.collection('users').findOne(
      { _id: new ObjectId(order.userId) },
      { projection: { _id: 1, email: 1, firstName: 1, lastName: 1, firstPurchaseAt: 1 } }
    );
  }
  if (!buyerUser) {
    const buyerEmail = normalizeEmail(order && (order.buyerEmail || (order.buyer && order.buyer.email)) || '');
    if (buyerEmail) {
      buyerUser = await db.collection('users').findOne(
        { email: buyerEmail },
        { projection: { _id: 1, email: 1, firstName: 1, lastName: 1, firstPurchaseAt: 1 } }
      );
    }
  }

  if (buyerUser && buyerUser._id) {
    const buyerOrderSummary = {
      orderId: order.id,
      receiptId: receipt.receiptId,
      total: parseFloat(order && order.total) || 0,
      status: String(order && order.status ? order.status : 'completed'),
      itemCount: (Array.isArray(order && order.items) ? order.items : []).reduce(function(sum, item) {
        return sum + (Math.max(1, parseInt(item && item.quantity, 10) || 1));
      }, 0),
      purchasedAt: completedAt
    };
    await db.collection('users').updateOne(
      { _id: buyerUser._id, purchaseOrderIds: { $ne: order.id } },
      {
        $inc: {
          totalPurchases: 1,
          totalSpent: parseFloat(order && order.total) || 0
        },
        $min: { firstPurchaseAt: completedAt },
        $set: {
          lastPurchaseAt: completedAt,
          updatedAt: now
        },
        $push: {
          purchaseOrderIds: { $each: [order.id], $position: 0, $slice: 25 },
          recentPurchases: { $each: [buyerOrderSummary], $position: 0, $slice: 10 }
        }
      }
    );
    await upsertOrderNotification(
      { userId: String(buyerUser._id), type: 'order_completed', orderId: order.id },
      {
        userId: String(buyerUser._id),
        type: 'order_completed',
        orderId: order.id,
        title: 'Order confirmed',
        body: `Order ${order.id} was paid successfully. Your receipt is ready.`,
        linkUrl: '/payment-success.html?orderId=' + encodeURIComponent(order.id),
        receiptId: receipt.receiptId
      }
    );
  }

  for (const sellerSummary of sellerSummaries) {
    await db.collection('sellerSales').updateOne(
      { orderId: order.id, sellerId: sellerSummary.sellerId },
      {
        $setOnInsert: {
          orderId: order.id,
          sellerId: sellerSummary.sellerId,
          createdAt: now
        },
        $set: {
          sellerName: sellerSummary.sellerName,
          sellerUsername: sellerSummary.sellerUsername,
          buyerEmail: normalizeEmail(order && (order.buyerEmail || (order.buyer && order.buyer.email)) || ''),
          buyerName: [order && order.buyer ? order.buyer.firstName : '', order && order.buyer ? order.buyer.lastName : ''].filter(Boolean).join(' ').trim(),
          receiptId: receipt.receiptId,
          itemCount: sellerSummary.itemCount,
          grossTotal: sellerSummary.grossTotal,
          platformFee: sellerSummary.platformFee,
          netTotal: sellerSummary.netTotal,
          items: sellerSummary.items,
          status: String(order && order.status ? order.status : 'completed'),
          soldAt: completedAt,
          updatedAt: now
        }
      },
      { upsert: true }
    );

    await db.collection('sellers').updateOne(
      { userId: sellerSummary.sellerId, saleOrderIds: { $ne: order.id } },
      {
        $inc: {
          totalSales: 1,
          totalRevenue: sellerSummary.grossTotal,
          totalItemsSold: sellerSummary.itemCount
        },
        $min: { firstSaleAt: completedAt },
        $set: {
          lastSaleAt: completedAt,
          updatedAt: now
        },
        $push: {
          saleOrderIds: { $each: [order.id], $position: 0, $slice: 50 },
          recentSales: {
            $each: [{
              orderId: order.id,
              receiptId: receipt.receiptId,
              buyerEmail: normalizeEmail(order && (order.buyerEmail || (order.buyer && order.buyer.email)) || ''),
              itemCount: sellerSummary.itemCount,
              grossTotal: sellerSummary.grossTotal,
              netTotal: sellerSummary.netTotal,
              soldAt: completedAt
            }],
            $position: 0,
            $slice: 10
          }
        }
      }
    );

    await upsertOrderNotification(
      { userId: sellerSummary.sellerId, type: 'sale_completed', orderId: order.id },
      {
        userId: sellerSummary.sellerId,
        type: 'sale_completed',
        orderId: order.id,
        title: 'New sale recorded',
        body: `Order ${order.id} includes ${sellerSummary.itemCount} item(s) from your shop.`,
        linkUrl: '/seller-dashboard.html#orders',
        sellerRevenue: sellerSummary.grossTotal
      }
    );
  }

  const orderUpdates = {
    sellerSummaries: sellerSummaries,
    receipt: receipt,
    receiptId: receipt.receiptId,
    postPurchaseSyncAt: now,
    updatedAt: now
  };
  if (buyerUser && buyerUser._id) {
    orderUpdates.userId = String(buyerUser._id);
  }

  await db.collection('orders').updateOne(
    { id: order.id },
    { $set: orderUpdates }
  );

  return { ...order, ...orderUpdates };
}

async function sendStripeSellerPayout(order, options) {
  const payoutMeta = options || {};
  const snapshot = await buildPayoutSnapshot(order, payoutMeta);
  const orderId = snapshot.orderId;
  if (!snapshot.orderId) {
    return { ok: false, error: 'Order ID is required for payout processing' };
  }
  const pb = snapshot.payoutBase;
  await db.collection('payouts').updateOne(
    { orderId: orderId, sellerId: pb.sellerId },
    {
      $setOnInsert: {
        orderId: orderId,
        sellerId: pb.sellerId,
        sellerUsername: pb.sellerUsername,
        sellerName: pb.sellerName,
        method: pb.method,
        placedAt: pb.placedAt,
        createdAt: new Date()
      },
      $set: {
        grossAmount: pb.grossAmount,
        amount: pb.amount,
        platformFee: pb.platformFee,
        currency: pb.currency,
        items: pb.items,
        shippingStatus: pb.shippingStatus,
        shippedAt: pb.shippedAt,
        triggerSource: pb.triggerSource,
        payoutAccountId: pb.payoutAccountId,
        payoutAccountSource: pb.payoutAccountSource,
        linkedPayoutAccountId: pb.linkedPayoutAccountId,
        updatedAt: pb.updatedAt,
        status: snapshot.status,
        onboardingRequired: snapshot.status === 'blocked_onboarding',
        error: snapshot.status === 'blocked_onboarding' ? snapshot.blockedReason : null
      }
    },
    { upsert: true }
  );

  const payoutDocQuery = { orderId: orderId, sellerId: pb.sellerId };
  const payoutDocScoped = await db.collection('payouts').findOne(payoutDocQuery);
  if (payoutDocScoped && payoutDocScoped.status === 'paid') {
    return { ok: true, alreadyPaid: true, payout: payoutDocScoped, sellerId: pb.sellerId };
  }
  if (snapshot.status === 'pending_delivery') {
    return { ok: true, deferred: true, reason: 'Order is not yet marked as shipped' };
  }
  if (snapshot.status === 'pending_hold') {
    return { ok: true, deferred: true, reason: snapshot.blockedReason || 'Payout is in the post-shipment hold window' };
  }
  if (snapshot.status === 'blocked_onboarding') {
    return { ok: true, deferred: true, reason: snapshot.blockedReason };
  }

  if (!stripe || !STRIPE_SECRET_KEY) {
    const reason = 'Stripe is not configured on the server';
    await db.collection('payouts').updateOne(
      payoutDocQuery,
      { $set: { status: 'failed', error: reason, onboardingRequired: false, updatedAt: new Date() } }
    );
    return { ok: false, error: reason };
  }

  if (!snapshot.sellerInfo.sellerId) {
    const reason = snapshot.sellerInfo.error || 'Seller ID missing on order item';
    await db.collection('payouts').updateOne(
      payoutDocQuery,
      { $set: { status: 'failed', error: reason, onboardingRequired: false, updatedAt: new Date() } }
    );
    return { ok: false, error: reason };
  }

  if (!(snapshot.payoutAmount > 0)) {
    const reason = 'Calculated payout amount must be greater than 0';
    await db.collection('payouts').updateOne(
      payoutDocQuery,
      { $set: { status: 'failed', error: reason, onboardingRequired: false, updatedAt: new Date() } }
    );
    return { ok: false, error: reason };
  }
  if (!snapshot.receiverEmail) {
    const reason = 'Seller payout destination is missing';
    await db.collection('payouts').updateOne(
      payoutDocQuery,
      { $set: { status: 'failed', error: reason, onboardingRequired: true, updatedAt: new Date() } }
    );
    return { ok: false, error: reason };
  }
  if (!/^acct_[A-Za-z0-9]+$/.test(String(snapshot.receiverEmail || '').trim())) {
    const reason = 'Seller payout destination must be a Stripe Connect account ID';
    await db.collection('payouts').updateOne(
      payoutDocQuery,
      { $set: { status: 'failed', error: reason, onboardingRequired: true, updatedAt: new Date() } }
    );
    return { ok: false, error: reason };
  }

  await db.collection('payouts').updateOne(
    payoutDocQuery,
    { $set: { status: 'processing', onboardingRequired: false, lastAttemptAt: new Date(), updatedAt: new Date(), error: null } }
  );

  try {
    const transfer = await stripe.transfers.create({
      amount: toStripeAmountCents(snapshot.payoutAmount),
      currency: String(snapshot.payoutCurrency || 'USD').toLowerCase(),
      destination: String(snapshot.receiverEmail),
      metadata: {
        orderId: orderId,
        sellerId: String(snapshot.sellerInfo && snapshot.sellerInfo.sellerId ? snapshot.sellerInfo.sellerId : ''),
        triggerSource: String(payoutMeta.triggerSource || '')
      }
    });
    const payoutUpdates = {
      payoutAccountId: snapshot.receiverEmail,
      stripeTransferId: String(transfer && transfer.id ? transfer.id : ''),
      stripeTransferResponse: transfer,
      updatedAt: new Date(),
      onboardingRequired: false,
      error: null,
      status: 'paid',
      paidAt: new Date()
    };
    await db.collection('payouts').updateOne(
      payoutDocQuery,
      {
        $set: payoutUpdates
      }
    );
    const paidPayout = await db.collection('payouts').findOne(payoutDocQuery);
    await notifyAdminPayoutPaidIfNeeded(paidPayout, 'stripe_transfer');
    return { ok: true, payout: transfer, processing: false, sellerId: pb.sellerId };
  } catch (error) {
    await db.collection('payouts').updateOne(
      payoutDocQuery,
      { $set: { status: 'failed', error: error.message, onboardingRequired: false, updatedAt: new Date() } }
    );
    return { ok: false, error: error.message, sellerId: pb.sellerId };
  }
}

async function sendStripeSellerPayoutsForOrder(order, options) {
  const payoutMeta = options || {};
  const sellers = getOrderSellerInfos(order);
  if (!sellers.length) {
    return { ok: false, error: 'Seller ID missing on order item', results: [] };
  }
  const results = [];
  for (const seller of sellers) {
    const result = await sendStripeSellerPayout(order, {
      ...payoutMeta,
      sellerId: seller.sellerId
    });
    results.push({ sellerId: seller.sellerId, ...result });
  }
  const failed = results.find(function(result) { return !result.ok; });
  if (failed) {
    // Partial successes are preserved in `results` so callers/admin tooling can see
    // which sellers were paid and which sellers still require retry/remediation.
    return { ok: false, error: failed.error || 'One or more seller payouts failed', results: results };
  }
  const allDeferred = results.length > 0 && results.every(function(result) { return result.deferred; });
  const anyProcessing = results.some(function(result) { return result.processing; });
  const anyAlreadyPaid = results.some(function(result) { return result.alreadyPaid; });
  return {
    ok: true,
    deferred: allDeferred,
    processing: anyProcessing,
    alreadyPaid: anyAlreadyPaid,
    reason: allDeferred ? 'All seller payouts are currently deferred' : '',
    results: results
  };
}

async function sendPayPalSellerPayout(order, options) {
  return sendStripeSellerPayout(order, options);
}

async function retryEligibleBlockedPayoutsForSeller(sellerId, triggerSource) {
  const payouts = await db.collection('payouts')
    .find({ sellerId: String(sellerId), status: 'blocked_onboarding' })
    .sort({ createdAt: 1 })
    .limit(MAX_BLOCKED_PAYOUT_RETRY_BATCH)
    .toArray();
  const summary = { scanned: payouts.length, attempted: 0, sent: 0, processing: 0, failed: 0, deferred: 0 };
  for (const payout of payouts) {
    const orderId = String(payout && payout.orderId ? payout.orderId : '').trim();
    if (!orderId) continue;
    const order = await db.collection('orders').findOne({ id: orderId });
    if (!order || String(order.status || '').toLowerCase() !== 'completed') continue;
    if (String(order.shippingStatus || '').toLowerCase() !== 'shipped') continue;
    summary.attempted++;
    try {
      const result = await sendStripeSellerPayout(order, {
        triggerSource: triggerSource || 'onboarding_verified',
        sellerId: String(sellerId || '')
      });
      if (!result.ok) summary.failed++;
      else if (result.deferred) summary.deferred++;
      else if (result.processing) summary.processing++;
      else summary.sent++;
    } catch (err) {
      console.error('Failed to retry payout for order', orderId, ':', err);
      summary.failed++;
    }
  }
  return summary;
}

// ── PRO SELLER SUBSCRIPTION PLAN ─────────────────────────────────────────────
function getStripeProSellerPriceId() {
  const value = String(STRIPE_PRO_SELLER_PRICE_ID || '').trim();
  return /^price_[A-Za-z0-9]+$/.test(value) ? value : null;
}

function getStripeProSellerCheckoutLineItems() {
  const configuredPriceId = getStripeProSellerPriceId();
  if (configuredPriceId) {
    return [{ price: configuredPriceId, quantity: 1 }];
  }
  return [{
    price_data: {
      currency: 'usd',
      unit_amount: toStripeAmountCents(PRO_SELLER_MONTHLY_PRICE_USD),
      recurring: { interval: 'month' },
      product_data: { name: PAYOUT_BRAND_NAME + ' Pro Seller Subscription' }
    },
    quantity: 1
  }];
}

async function verifyStripeProSellerSubscription(subscriptionId) {
  ensureStripeConfigured();
  const id = String(subscriptionId || '').trim();
  if (!/^sub_[A-Za-z0-9]+$/.test(id)) {
    throw new Error('subscriptionId is required');
  }
  const subscription = await stripe.subscriptions.retrieve(id);
  const status = String(subscription && subscription.status ? subscription.status : '').toLowerCase();
  if (!['active', 'trialing'].includes(status)) {
    throw new Error('Stripe subscription could not be verified. Please try again.');
  }
  return subscription;
}

// GET /api/sellers/pro-plan – return Stripe price ID for Pro Seller
app.get('/api/sellers/pro-plan', async function(req, res) {
  try {
    const priceId = getStripeProSellerPriceId();
    res.json({
      planId: priceId,
      provider: 'stripe',
      monthlyPriceUsd: PRO_SELLER_MONTHLY_PRICE_USD,
      fallbackCheckoutPriceData: !priceId
    });
  } catch (err) {
    console.error('Error fetching pro seller plan:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stripe/pro-subscription/session – create a Stripe Checkout session for Pro Seller subscription
app.post('/api/stripe/pro-subscription/session', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  try {
    ensureStripeConfigured();
    const seller = await db.collection('sellers').findOne({ userId: req.userId }, { projection: { userId: 1, tier: 1 } });
    const mode = String(req.body && req.body.mode ? req.body.mode : 'signup').trim().toLowerCase();
    if (seller && seller.tier === 'pro' && mode === 'upgrade') {
      return res.status(409).json({ error: 'Already on Pro tier' });
    }
    const successBase = mode === 'upgrade'
      ? makeAbsoluteUrl('/seller-dashboard.html?tierUpgrade=success')
      : makeAbsoluteUrl('/seller-signup.html?proCheckout=success');
    const cancelBase = mode === 'upgrade'
      ? makeAbsoluteUrl('/seller-dashboard.html?tierUpgrade=cancelled')
      : makeAbsoluteUrl('/seller-signup.html?proCheckout=cancelled');
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: getStripeProSellerCheckoutLineItems(),
      success_url: successBase + '&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: cancelBase,
      metadata: {
        userId: String(req.userId),
        flow: mode === 'upgrade' ? 'pro_upgrade' : 'pro_signup'
      }
    });
    res.json({ sessionId: session.id, checkoutUrl: session.url });
  } catch (error) {
    console.error('Error creating Stripe Pro subscription session:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/stripe/pro-subscription/verify – verify completed Stripe Checkout subscription session
app.get('/api/stripe/pro-subscription/verify', publicApiRateLimit, verifyToken, async function(req, res) {
  try {
    ensureStripeConfigured();
    const sessionId = String(req.query && req.query.session_id ? req.query.session_id : '').trim();
    if (!/^cs_[A-Za-z0-9]+$/.test(sessionId)) return res.status(400).json({ error: 'Invalid Stripe session_id' });
    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['subscription'] });
    const sessionUserId = String(session && session.metadata && session.metadata.userId ? session.metadata.userId : '');
    if (sessionUserId && sessionUserId !== String(req.userId)) {
      return res.status(403).json({ error: 'Session does not belong to the authenticated user' });
    }
    if (String(session && session.payment_status ? session.payment_status : '').toLowerCase() !== 'paid') {
      return res.status(409).json({ error: 'Subscription payment is not completed yet' });
    }
    const sessionSubscription = session && session.subscription
      ? (typeof session.subscription === 'string' ? session.subscription : session.subscription.id)
      : '';
    const subscription = await verifyStripeProSellerSubscription(sessionSubscription);
    res.json({
      success: true,
      sessionId: session.id,
      subscriptionId: sessionSubscription,
      status: subscription.status
    });
  } catch (error) {
    console.error('Error verifying Stripe Pro subscription session:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/sellers/subscription/confirm – verify Stripe subscription and create Pro Seller profile
app.post('/api/sellers/subscription/confirm', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  try {
    const existing = await db.collection('sellers').findOne({ userId: req.userId });
    if (existing) return res.status(400).json({ error: 'Seller profile already exists' });

    const { subscriptionId, accountType, shopName, shopDescription, businessEmail, phoneNumber,
      businessAddress, businessCity, businessState, businessZip,
      personalName, personalEmail, shippingAddress, shippingCity, shippingState, shippingZip } = req.body;

    if (!subscriptionId || typeof subscriptionId !== 'string' || subscriptionId.length > 128) {
      return res.status(400).json({ error: 'subscriptionId is required' });
    }
    if (!accountType || !shopName) {
      return res.status(400).json({ error: 'accountType and shopName are required' });
    }

    const subscription = await verifyStripeProSellerSubscription(subscriptionId);

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
      tier: 'pro',
      proSubscriptionId: subscriptionId,
      proSubscriptionStatus: String(subscription && subscription.status ? subscription.status : 'active'),
      proSubscriptionProvider: 'stripe',
      createdAt: new Date()
    };

    const result = await db.collection('sellers').insertOne(seller);

    await db.collection('users').updateOne(
      { _id: new ObjectId(req.userId) },
      { $set: { isSeller: true, updatedAt: new Date() } }
    );

    try {
      const user = await db.collection('users').findOne({ _id: new ObjectId(req.userId) }, { projection: { email: 1, firstName: 1 } });
      const to = normalizeEmail(user && user.email);
      if (to) {
        await sendEventEmailSafe(
          to,
          'Welcome to Zorexium Sellers',
          `<p>Welcome${user && user.firstName ? ', ' + user.firstName : ''}! Your seller profile is now active.</p><p>Thanks for joining the Zorexium seller community.</p>`,
          '/seller-dashboard.html'
        );
        await sendEventEmailSafe(
          to,
          'Thanks for purchasing Pro Seller status',
          `<p>Your Pro Seller subscription is active.</p><p>Pro Seller fees: <strong>10%</strong> platform fee per sale and <strong>$1/month</strong> subscription.</p>`,
          '/seller-dashboard.html#tier'
        );
      }
      await sendAdminNotificationSafe(
        'New seller signup',
        `<p>A user signed up to become a seller.</p>`
          + `<p><strong>Tier:</strong> pro</p>`
          + `<p><strong>Shop name:</strong> ${escapeHtml(String(seller.shopName || 'N/A'))}</p>`
          + `<p><strong>Account type:</strong> ${escapeHtml(String(seller.accountType || 'N/A'))}</p>`
          + `<p><strong>User ID:</strong> ${escapeHtml(String(req.userId || 'N/A'))}</p>`
          + `<p><strong>User email:</strong> ${escapeHtml(String(to || 'N/A'))}</p>`
          + `<p><strong>Subscription ID:</strong> ${escapeHtml(String(subscriptionId))}</p>`,
        '/seller-dashboard.html'
      );
    } catch (mailErr) {
      console.error('Failed to send Pro seller signup emails:', mailErr.message);
    }

    res.status(201).json({ ...seller, _id: result.insertedId });
  } catch (error) {
    console.error('Error confirming Pro Seller subscription:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── CREATE ORDER (No auth required - guest checkout) ────────────────────────────────────────
app.post('/api/orders', publicApiRateLimit, async function(req, res) {
  try {
    if (!mongoConnected) {
      return res.status(503).json({ error: 'Database temporarily unavailable. Please try again in a moment.' });
    }
    ensureStripeConfigured();

    const { items, buyer, shippingMethod } = req.body;
    const checkoutUser = getOptionalCheckoutUser(req);
    
    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'No items in order' });
    }
    if (!buyer || !buyer.address || !buyer.firstName || !buyer.lastName || !buyer.email) {
      return res.status(400).json({ error: 'Buyer details are required' });
    }
    if (!buyer.address.line1 || !buyer.address.city || !buyer.address.state || !buyer.address.zip) {
      return res.status(400).json({ error: 'Complete shipping address is required' });
    }
    // Validate ZIP: accept 5-digit (e.g. 12345) or ZIP+4 (e.g. 12345-6789)
    if (!/^\d{5}(-\d{4})?$/.test(String(buyer.address.zip).trim())) {
      return res.status(400).json({ error: 'Invalid ZIP code format. Use 5-digit (12345) or ZIP+4 (12345-6789).' });
    }
    const countryCode = normalizeCountryCode(buyer.address.country);
    if (!countryCode) {
      return res.status(400).json({ error: 'Please select a valid 2-letter shipping country code' });
    }
    
    // Resolve products so orders retain seller/product references for transactional emails and seller analytics.
    const rawProductIds = items.map(function(item) { return item && item.id ? String(item.id) : ''; }).filter(Boolean);
    const objectIds = rawProductIds
      .filter(function(id) { return ObjectId.isValid(id); })
      .map(function(id) { return new ObjectId(id); });
    const products = objectIds.length > 0
      ? await db.collection('products').find({ _id: { $in: objectIds } }).toArray()
      : [];
    const productById = new Map(products.map(function(product) { return [String(product._id), product]; }));
    const sellerIds = Array.from(new Set(products.map(function(product) {
      return String(product && product.sellerId ? product.sellerId : '').trim();
    }).filter(Boolean)));
    const sellerPayoutProfiles = sellerIds.length > 0
      ? await db.collection('sellers')
          .find(
            { userId: { $in: sellerIds } },
            { projection: { userId: 1, payoutAccountId: 1, stripeAccountId: 1, payoutVerified: 1, payoutOnboardingStatus: 1, payoutProviderBankStatus: 1, tier: 1 } }
          )
          .toArray()
      : [];
    const sellerPayoutByUserId = new Map(sellerPayoutProfiles.map(function(profile) {
      return [String(profile && profile.userId ? profile.userId : ''), profile];
    }));
    const normalizedOrderItems = [];
    const orderItems = [];
    let subtotal = 0;
    items.forEach(function(item) {
      const itemId = item && item.id ? String(item.id) : '';
      const product = productById.get(itemId) || null;
      if (!product) {
        throw new Error('One or more products in your cart are unavailable. Please refresh and try again.');
      }
      // Enforce product active status
      if (product.status && product.status !== 'active') {
        throw new Error(`"${String(product.name || 'A product').slice(0, 100)}" is no longer available.`);
      }
      const quantity = Math.max(1, Math.min(99, parseInt(item && item.quantity, 10) || 1));
      // Enforce inventory quantity
      const availableQty = parseInt(product.quantity, 10);
      if (!isNaN(availableQty)) {
        if (availableQty <= 0) {
          throw new Error(`"${String(product.name || 'A product').slice(0, 100)}" is out of stock.`);
        }
        if (quantity > availableQty) {
          throw new Error(`Only ${availableQty} unit(s) of "${String(product.name || 'A product').slice(0, 100)}" are available.`);
        }
      }
      const unitPrice = Number(product && product.price);
      if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
        throw new Error('One or more products have invalid pricing. Please refresh and try again.');
      }
      const lineSubtotal = parseFloat((unitPrice * quantity).toFixed(2));
      subtotal += lineSubtotal;
      const productSellerId = String(product && product.sellerId ? product.sellerId : '');
      const itemSellerId = String(item && item.sellerId ? item.sellerId : '');
      const sellerId = productSellerId || itemSellerId;
      const sellerPayoutProfile = sellerPayoutByUserId.get(sellerId) || null;
      const sellerTier = normalizeSellerTier(sellerPayoutProfile && sellerPayoutProfile.tier ? sellerPayoutProfile.tier : 'starter');
      normalizedOrderItems.push({
        id: itemId,
        name: String(product && product.name ? product.name : (item && item.name ? item.name : 'Item')).slice(0, 200),
        price: unitPrice,
        quantity: quantity,
        image: product && product.image ? String(product.image) : '',
        sellerId: sellerId,
        sellerName: String(product && (product.sellerName || product.sellerUsername) ? (product.sellerName || product.sellerUsername) : (item && item.sellerName ? item.sellerName : '')),
        sellerUsername: String(product && product.sellerUsername ? product.sellerUsername : ''),
        sellerPayoutAccountId: normalizePayoutAccountId(
          sellerPayoutProfile && (sellerPayoutProfile.stripeAccountId || sellerPayoutProfile.payoutAccountId)
            ? (sellerPayoutProfile.stripeAccountId || sellerPayoutProfile.payoutAccountId)
            : ''
        ),
        sellerPayoutVerified: !!(sellerPayoutProfile && sellerPayoutProfile.payoutVerified),
        sellerPayoutOnboardingStatus: String(sellerPayoutProfile && sellerPayoutProfile.payoutOnboardingStatus ? sellerPayoutProfile.payoutOnboardingStatus : ''),
        sellerPayoutBankStatus: String(sellerPayoutProfile && sellerPayoutProfile.payoutProviderBankStatus ? sellerPayoutProfile.payoutProviderBankStatus : ''),
        sellerTier: sellerTier,
        productLink: itemId ? makeAbsoluteUrl('/product-detail.html?id=' + encodeURIComponent(itemId)) : makeAbsoluteUrl('/marketplace.html')
      });
      orderItems.push({
        name: String(product && product.name ? product.name : (item && item.name ? item.name : 'Item')).slice(0, 127),
        quantity: String(quantity),
        unit_amount: {
          currency_code: 'USD',
          value: unitPrice.toFixed(2)
        }
      });
    });
    subtotal = parseFloat(subtotal.toFixed(2));
    let firstOrderFreeShippingApplied = false;
    if (checkoutUser && checkoutUser.userId) {
      const existingCompletedOrders = await db.collection('orders').countDocuments({
        status: 'completed',
        $or: [{ userId: String(checkoutUser.userId) }, { buyerEmail: normalizeEmail(buyer && buyer.email) }]
      }, { limit: 1 });
      firstOrderFreeShippingApplied = existingCompletedOrders === 0;
    }
    const shipping = firstOrderFreeShippingApplied
      ? 0
      : parseFloat((normalizedOrderItems.length * DEFAULT_SHIPPING_PER_ITEM_USD).toFixed(2));
    const tax = parseFloat((subtotal * DEFAULT_SALES_TAX_RATE).toFixed(2));
    const total = parseFloat((subtotal + shipping + tax).toFixed(2));
    if (!(total > 0)) {
      return res.status(400).json({ error: 'Order total must be greater than $0.00' });
    }

    const orderId = 'ORD-' + Date.now() + '-' + crypto.randomBytes(6).toString('hex').toUpperCase();
    const checkoutLineItems = normalizedOrderItems.map(function(item) {
      const quantity = Math.max(1, parseInt(item && item.quantity, 10) || 1);
      let imageUrl = '';
      if (item && item.image) {
        try {
          const parsedImageUrl = new URL(String(item.image));
          if (parsedImageUrl.protocol === 'http:' || parsedImageUrl.protocol === 'https:') {
            imageUrl = parsedImageUrl.toString();
          }
        } catch (_) {}
      }
      return {
        quantity: quantity,
        price_data: {
          currency: 'usd',
          unit_amount: toStripeAmountCents(Number(item && item.price)),
          product_data: {
            name: String(item && item.name ? item.name : 'Item').slice(0, 200),
            images: imageUrl ? [imageUrl] : undefined
          }
        }
      };
    });
    if (shipping > 0) {
      checkoutLineItems.push({
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: toStripeAmountCents(shipping),
          product_data: { name: 'Shipping' }
        }
      });
    }
    if (tax > 0) {
      checkoutLineItems.push({
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: toStripeAmountCents(tax),
          product_data: { name: 'Sales Tax' }
        }
      });
    }
    const normalizedBuyerEmail = normalizeEmail(buyer && buyer.email);
    if (!normalizedBuyerEmail || !isLikelyEmail(normalizedBuyerEmail)) {
      return res.status(400).json({ error: 'A valid buyer email is required' });
    }
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'payment',
      ui_mode: 'embedded_page',
      line_items: checkoutLineItems,
      return_url: getStripeCheckoutSuccessUrl(orderId),
      customer_email: normalizedBuyerEmail,
      metadata: { orderId: orderId },
      client_reference_id: orderId
    });

    const orderDocument = {
      id: orderId,
      stripeCheckoutSessionId: checkoutSession.id,
      paymentProvider: 'stripe',
      items: normalizedOrderItems,
      buyer: {
        ...buyer,
        address: {
          ...(buyer && buyer.address ? buyer.address : {}),
          country: countryCode
        }
      },
      buyerEmail: normalizeEmail(buyer && buyer.email),
      shippingMethod,
      subtotal,
      shipping,
      firstOrderFreeShippingApplied,
      tax,
      total,
      currency: 'USD',
      status: 'pending',
      createdAt: new Date()
    };
    if (checkoutUser && checkoutUser.userId) {
      orderDocument.userId = String(checkoutUser.userId);
    }
    await db.collection('pendingOrders').insertOne(orderDocument);
    
    res.json({
      orderId,
      clientSecret: checkoutSession.client_secret,
      stripeSessionId: checkoutSession.id,
      totals: { subtotal, shipping, tax, total, currency: 'USD' },
      firstOrderFreeShippingApplied
    });
  } catch (error) {
    console.error('Order creation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── CAPTURE ORDER (No auth required - guest checkout) ────────────────────────────────────────
app.post('/api/orders/:orderId/capture', publicApiRateLimit, async function(req, res) {
  let reservedInventory = [];
  let captureCommitted = false;
  let paymentCaptured = false;
  try {
    if (!mongoConnected) {
      return res.status(503).json({ error: 'Database temporarily unavailable. Please try again in a moment.' });
    }
    if (!PAYPAL_CLIENT_ID || !PAYPAL_SECRET) {
      return res.status(503).json({ error: 'PayPal credentials (PAYPAL_CLIENT_ID and/or PAYPAL_SECRET) are not configured on the server' });
    }

    const { orderId } = req.params;
    // Look up the order in pendingOrders first (pre-capture), then fall back to orders
    // (in case capture is being retried after the order was already persisted as completed).
    let order = await db.collection('pendingOrders').findOne({ id: orderId });
    const fromPendingOrders = !!order;
    if (!order) {
      order = await db.collection('orders').findOne({ id: orderId });
    }
    
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Idempotency: if already captured and stored as completed, return success immediately
    if (!fromPendingOrders && order.status === 'completed') {
      return res.json({
        orderId,
        paypalCaptureId: order.paypalCaptureId || null,
        status: 'completed',
        receiptId: order.receiptId || null
      });
    }

    // Reserve stock before capture so only inventory-backed purchases can complete.
    reservedInventory = await reserveInventoryForOrder(order);
    
    const { token: accessToken, apiUrl: paypalApiUrl } = await fetchPayPalAccessToken();
    const captureResponse = await fetch(`${paypalApiUrl}/v2/checkout/orders/${order.paypalOrderId}/capture`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });
    
    const captureData = await captureResponse.json();
    
    if (!captureResponse.ok) {
      console.error('Capture error:', captureData);
      throw new Error(captureData.message || 'Payment capture failed');
    }
    paymentCaptured = true;

    const completedOrderDoc = {
      ...order,
      status: 'completed',
      paypalCaptureId: captureData.id,
      completedAt: new Date(),
      inventoryReserved: true
    };
    // Remove the MongoDB _id so the orders collection generates a fresh one for this document.
    delete completedOrderDoc._id;

    if (fromPendingOrders) {
      // First-time capture: insert as a completed order and remove the pending record
      await db.collection('orders').insertOne(completedOrderDoc);
      await db.collection('pendingOrders').deleteOne({ id: orderId });
    } else {
      // Retry capture path: update the existing orders document
      await db.collection('orders').updateOne(
        { id: orderId },
        {
          $set: {
            status: 'completed',
            paypalCaptureId: captureData.id,
            completedAt: new Date(),
            inventoryReserved: true
          }
        }
      );
    }
    captureCommitted = true;

    // Synchronize post-purchase records, payout state, and transactional emails.
    const completedOrder = await db.collection('orders').findOne({ id: orderId });
    const completionResult = await processCompletedOrderAutomation(
      completedOrder || {
        ...order,
        status: 'completed',
        paypalCaptureId: captureData.id,
        completedAt: new Date()
      },
      { triggerSource: 'capture' }
    );
    const syncedOrder = completionResult.order;

    res.json({
      orderId,
      paypalCaptureId: captureData.id,
      status: 'completed',
      receiptId: syncedOrder.receiptId || null
    });
  } catch (error) {
    if (!paymentCaptured && !captureCommitted && reservedInventory.length > 0) {
      try {
        // Roll back reserved stock when capture does not complete so inventory remains accurate.
        await releaseInventoryReservations(reservedInventory);
      } catch (rollbackError) {
        console.error('Failed to roll back reserved inventory:', rollbackError.message);
      }
    }
    console.error('Capture error:', error);
    res.status(500).json({ error: error.message });
  }
});

async function completeStripeCheckoutOrder(orderId, checkoutSession, options) {
  const opts = options || {};
  const shouldRunAutomation = opts.runAutomation !== false;
  if (!orderId) return { ok: false, error: 'Missing orderId' };
  let reservedInventory = [];
  let committed = false;
  try {
    let order = await db.collection('pendingOrders').findOne({ id: orderId });
    const fromPendingOrders = !!order;
    if (!order) {
      order = await db.collection('orders').findOne({ id: orderId });
      if (order && String(order.status || '').toLowerCase() === 'completed') {
        if (!shouldRunAutomation) return { ok: true, alreadyCompleted: true, order: order };
        const completionResult = await processCompletedOrderAutomation(order, {
          triggerSource: String(opts.triggerSource || 'stripe_completion_reconcile'),
          forceEmailResend: opts.forceEmailResend === true
        });
        return { ok: true, alreadyCompleted: true, order: completionResult.order, payoutResult: completionResult.payoutResult };
      }
    }
    if (!order) return { ok: false, error: 'Order not found' };

    reservedInventory = await reserveInventoryForOrder(order);
    const completedOrderDoc = {
      ...order,
      status: 'completed',
      paymentProvider: 'stripe',
      stripeCheckoutSessionId: String(checkoutSession && checkoutSession.id ? checkoutSession.id : (order.stripeCheckoutSessionId || '')),
      stripePaymentIntentId: String(checkoutSession && checkoutSession.payment_intent ? checkoutSession.payment_intent : ''),
      completedAt: new Date(),
      inventoryReserved: true
    };
    delete completedOrderDoc._id;

    if (fromPendingOrders) {
      await db.collection('orders').insertOne(completedOrderDoc);
      await db.collection('pendingOrders').deleteOne({ id: orderId });
    } else {
      await db.collection('orders').updateOne(
        { id: orderId },
        {
          $set: {
            status: 'completed',
            paymentProvider: 'stripe',
            stripeCheckoutSessionId: completedOrderDoc.stripeCheckoutSessionId,
            stripePaymentIntentId: completedOrderDoc.stripePaymentIntentId,
            completedAt: completedOrderDoc.completedAt,
            inventoryReserved: true
          }
        }
      );
    }
    committed = true;
    const finalizedOrder = await db.collection('orders').findOne({ id: orderId });
    const syncedOrder = await syncCompletedOrderRecords(finalizedOrder || completedOrderDoc);
    if (!shouldRunAutomation) {
      return { ok: true, order: syncedOrder || finalizedOrder || completedOrderDoc };
    }
    const completionResult = await processCompletedOrderAutomation(
      syncedOrder || finalizedOrder || completedOrderDoc,
      {
        triggerSource: String(opts.triggerSource || 'stripe_webhook'),
        forceEmailResend: opts.forceEmailResend === true
      }
    );
    return { ok: true, order: completionResult.order, payoutResult: completionResult.payoutResult };
  } catch (error) {
    if (!committed && reservedInventory.length > 0) {
      try {
        await releaseInventoryReservations(reservedInventory);
      } catch (rollbackError) {
        console.error('Failed to roll back Stripe inventory reservations:', rollbackError.message);
      }
    }
    return { ok: false, error: error.message || 'Stripe order completion failed' };
  }
}

// v3: expands legacy repair to include paid-but-pending Stripe sessions from the May 14, 2026 purchase window.
const RETROACTIVE_LEGACY_ORDER_REPAIR_MIGRATION_KEY = 'retroactive_legacy_order_repair_v3';

async function findLegacyOrdersForRepair(limit) {
  const cappedLimit = Math.max(1, Math.min(50, parseInt(limit, 10) || 10));
  const sellerUserIds = new Set();
  const adafaUsers = await db.collection('users').find(
    {
      $or: [
        { email: { $regex: /^adafa(\+[^@]+)?@.+/i } },
        { firstName: { $regex: /^adafa$/i } },
        { username: { $regex: /^adafa$/i } }
      ]
    },
    { projection: { _id: 1 } }
  ).toArray();
  adafaUsers.forEach(function(user) {
    if (user && user._id) sellerUserIds.add(String(user._id));
  });

  const adafaSellers = await db.collection('sellers').find(
    {
      $or: [
        { userId: { $in: Array.from(sellerUserIds) } },
        { shopName: { $regex: /adafa/i } },
        { sellerName: { $regex: /^adafa$/i } },
        { sellerUsername: { $regex: /^adafa$/i } }
      ]
    },
    { projection: { userId: 1 } }
  ).toArray();
  adafaSellers.forEach(function(seller) {
    if (seller && seller.userId) sellerUserIds.add(String(seller.userId));
  });

  const sellerClauses = [
    { 'items.sellerName': { $regex: /adafa/i } },
    { 'items.sellerUsername': { $regex: /adafa/i } }
  ];
  if (sellerUserIds.size > 0) {
    sellerClauses.push({ 'items.sellerId': { $in: Array.from(sellerUserIds) } });
  }

  const buyerClauses = [
    { buyerEmail: { $regex: /^steve(\+[^@]+)?@.+/i } },
    { 'buyer.email': { $regex: /^steve(\+[^@]+)?@.+/i } },
    { 'buyer.firstName': { $regex: /^steve$/i } },
    { 'buyer.username': { $regex: /^steve$/i } }
  ];

  const inWindowClause = {
    $or: [
      { createdAt: { $gte: RETROACTIVE_LEGACY_ORDER_REPAIR_WINDOW_START_UTC, $lt: RETROACTIVE_LEGACY_ORDER_REPAIR_WINDOW_END_UTC } },
      { completedAt: { $gte: RETROACTIVE_LEGACY_ORDER_REPAIR_WINDOW_START_UTC, $lt: RETROACTIVE_LEGACY_ORDER_REPAIR_WINDOW_END_UTC } },
      { updatedAt: { $gte: RETROACTIVE_LEGACY_ORDER_REPAIR_WINDOW_START_UTC, $lt: RETROACTIVE_LEGACY_ORDER_REPAIR_WINDOW_END_UTC } }
    ]
  };
  const sharedMatchClauses = [{ $or: buyerClauses }, { $or: sellerClauses }];

  const completedOrders = await db.collection('orders')
    .find({
      status: 'completed',
      $and: sharedMatchClauses.concat([inWindowClause])
    })
    .sort({ completedAt: 1, createdAt: 1 })
    .limit(cappedLimit)
    .toArray();

  const pendingOrders = await db.collection('pendingOrders')
    .find({
      paymentProvider: 'stripe',
      stripeCheckoutSessionId: { $exists: true, $ne: '' },
      $and: sharedMatchClauses.concat([inWindowClause])
    })
    .sort({ createdAt: 1 })
    .limit(cappedLimit)
    .toArray();

  if (completedOrders.length === 0 && pendingOrders.length === 0) {
    const fallbackCompletedOrders = await db.collection('orders')
      .find({
        status: 'completed',
        $and: sharedMatchClauses
      })
      .sort({ completedAt: 1, createdAt: 1 })
      .limit(cappedLimit)
      .toArray();
    return { completedOrders: fallbackCompletedOrders, pendingOrders: [], sellerUserIds };
  }

  return { completedOrders, pendingOrders, sellerUserIds };
}

async function getPaidStripeCheckoutSessionForRepair(order) {
  const orderId = String(order && order.id ? order.id : '').trim();
  const stripeCheckoutSessionId = String(order && order.stripeCheckoutSessionId ? order.stripeCheckoutSessionId : '').trim();
  if (!orderId || !stripeCheckoutSessionId || !stripe || !STRIPE_SECRET_KEY) return null;
  try {
    const session = await stripe.checkout.sessions.retrieve(stripeCheckoutSessionId);
    if (!session || !session.id) return null;
    const mappedOrderId = String(
      (session && session.metadata && session.metadata.orderId)
        || (session && session.client_reference_id)
        || ''
    ).trim();
    if (mappedOrderId && mappedOrderId !== orderId) return null;
    const paymentStatus = String(session && session.payment_status ? session.payment_status : '').toLowerCase();
    const checkoutStatus = String(session && session.status ? session.status : '').toLowerCase();
    const isPaid = paymentStatus === 'paid' || paymentStatus === 'no_payment_required' || checkoutStatus === 'complete';
    return isPaid ? session : null;
  } catch (error) {
    console.error('Failed to retrieve Stripe Checkout session for legacy repair:', error && error.message ? error.message : error);
    return null;
  }
}

async function getPaidStripeCheckoutSessionForOrder(order, explicitSessionId) {
  const orderId = String(order && order.id ? order.id : '').trim();
  const sessionId = String(explicitSessionId || (order && order.stripeCheckoutSessionId ? order.stripeCheckoutSessionId : '')).trim();
  if (!orderId || !sessionId || !stripe || !STRIPE_SECRET_KEY) return null;
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (!session || !session.id) return null;
    const mappedOrderId = String(
      (session && session.metadata && session.metadata.orderId)
        || (session && session.client_reference_id)
        || ''
    ).trim();
    if (mappedOrderId && mappedOrderId !== orderId) return null;
    const paymentStatus = String(session && session.payment_status ? session.payment_status : '').toLowerCase();
    const checkoutStatus = String(session && session.status ? session.status : '').toLowerCase();
    const isPaid = paymentStatus === 'paid' || paymentStatus === 'no_payment_required' || checkoutStatus === 'complete';
    return isPaid ? session : null;
  } catch (error) {
    console.error('Failed to retrieve Stripe Checkout session:', error && error.message ? error.message : error);
    return null;
  }
}

async function repairCompletedLegacyOrders(options) {
  const opts = options || {};
  const forceEmailResend = opts.forceEmailResend === true;
  const { completedOrders, pendingOrders, sellerUserIds } = await findLegacyOrdersForRepair(opts.limit);
  const matchedOrders = completedOrders.concat(pendingOrders);

  // Pick the first discovered adafa userId as the canonical sellerId to stamp on untagged items.
  const primaryAdafaUserId = sellerUserIds.size > 0 ? Array.from(sellerUserIds)[0] : '';
  const adafaNamePattern = /adafa/i;

  const repairedOrderIds = [];
  const now = new Date();
  const pendingOrderIds = new Set((Array.isArray(pendingOrders) ? pendingOrders : []).map(function(doc) {
    return String(doc && doc.id ? doc.id : '');
  }));
  for (const order of matchedOrders) {
    let orderToProcess = order;

    // Patch items.sellerId on items that identify as adafa by name but are missing a valid sellerId.
    // Without this, buildSellerOrderSummaries skips them and /api/orders/sold returns nothing.
    if (primaryAdafaUserId && Array.isArray(order.items)) {
      let itemsPatched = false;
      const patchedItems = order.items.map(function(item) {
        if (!item) return item;
        // Only stamp the adafa userId when the item has no sellerId at all.
        // If a sellerId is already present (even a different one), leave it unchanged.
        const hasSellerId = !!item.sellerId;
        const nameMatchesAdafa = (
          adafaNamePattern.test(String(item.sellerName || '')) ||
          adafaNamePattern.test(String(item.sellerUsername || ''))
        );
        if (!hasSellerId && nameMatchesAdafa) {
          itemsPatched = true;
          return { ...item, sellerId: primaryAdafaUserId };
        }
        return item;
      });
      if (itemsPatched) {
        const sourceCollection = pendingOrderIds.has(String(order && order.id ? order.id : ''))
          ? 'pendingOrders'
          : 'orders';
        await db.collection(sourceCollection).updateOne(
          { id: order.id },
          { $set: { items: patchedItems, updatedAt: now } }
        );
        orderToProcess = { ...order, items: patchedItems };
      }
    }

    let repaired = null;
    const isAlreadyCompleted = String(orderToProcess && orderToProcess.status ? orderToProcess.status : '').toLowerCase() === 'completed';
    if (isAlreadyCompleted) {
      repaired = await processCompletedOrderAutomation(orderToProcess, {
        triggerSource: 'retroactive_steve_adafa_repair',
        forceEmailResend: forceEmailResend
      });
    } else {
      const paidSession = await getPaidStripeCheckoutSessionForRepair(orderToProcess);
      if (!paidSession) continue;
      const completion = await completeStripeCheckoutOrder(orderToProcess.id, paidSession, {
        triggerSource: 'retroactive_steve_adafa_repair',
        forceEmailResend: forceEmailResend
      });
      if (!completion.ok) continue;
      repaired = { order: completion.order, payoutResult: completion.payoutResult };
    }

    if (!repaired || !repaired.order) continue;
    await db.collection('orders').updateOne(
      { id: String(repaired.order.id || order.id) },
      {
        $set: {
          retroactiveRepair: {
            key: RETROACTIVE_LEGACY_ORDER_REPAIR_MIGRATION_KEY,
            repairedAt: new Date(),
            triggerSource: 'retroactive_legacy_order_repair'
          },
          updatedAt: new Date()
        }
      }
    );
    repairedOrderIds.push({
      orderId: String(repaired.order && repaired.order.id ? repaired.order.id : ''),
      receiptId: repaired && repaired.order ? String(repaired.order.receiptId || '') : '',
      payoutStatus: repaired && repaired.payoutResult
        ? (
          repaired.payoutResult.ok
            ? (repaired.payoutResult.deferred ? 'deferred' : (repaired.payoutResult.processing ? 'processing' : 'paid'))
            : 'failed'
        )
        : 'pending'
    });
  }
  return {
    matchedCount: matchedOrders.length,
    repairedCount: repairedOrderIds.length,
    repairedOrders: repairedOrderIds
  };
}

async function runRetroactiveLegacyOrderRepairMigration() {
  if (!mongoConnected) return;
  try {
    const existing = await db.collection('appMigrations').findOne({ key: RETROACTIVE_LEGACY_ORDER_REPAIR_MIGRATION_KEY });
    if (existing && existing.appliedAt) return;
    const repairSummary = await repairCompletedLegacyOrders({
      limit: RETROACTIVE_LEGACY_ORDER_REPAIR_LIMIT,
      forceEmailResend: RETROACTIVE_LEGACY_ORDER_REPAIR_FORCE_EMAIL_RESEND
    });
    await db.collection('appMigrations').updateOne(
      { key: RETROACTIVE_LEGACY_ORDER_REPAIR_MIGRATION_KEY },
      {
        $set: {
          key: RETROACTIVE_LEGACY_ORDER_REPAIR_MIGRATION_KEY,
          appliedAt: new Date(),
          summary: repairSummary
        }
      },
      { upsert: true }
    );
    console.log(`✅ Retroactive legacy order repair complete: ${repairSummary.repairedCount} order(s) repaired`);
  } catch (error) {
    console.error('⚠️  Retroactive legacy order repair failed:', error.message);
  }
}

// POST /api/stripe/webhook – verify Stripe webhook signatures and finalize completed checkout sessions
app.post('/api/stripe/webhook', publicApiRateLimit, async function(req, res) {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'Stripe webhook is not configured on the server' });
  }
  const signature = req.headers['stripe-signature'];
  if (!signature || !req.rawBody) {
    return res.status(400).json({ error: 'Missing Stripe webhook signature payload' });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, signature, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err && err.message ? err.message : err);
    return res.status(400).json({ error: 'Invalid Stripe webhook signature' });
  }

  try {
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data && event.data.object ? event.data.object : {};
      const orderId = String(
        (session && session.metadata && session.metadata.orderId)
          || (session && session.client_reference_id)
          || ''
      ).trim();
      if (orderId) {
        const completion = await completeStripeCheckoutOrder(orderId, session);
        if (!completion.ok) {
          console.error('Stripe checkout completion failed:', completion.error);
          return res.status(500).json({ error: 'Failed to finalize Stripe checkout order' });
        }
      }
    }

    if (event.type === 'account.updated') {
      const account = event.data && event.data.object ? event.data.object : null;
      if (account && account.id) {
        const requirementsDue = Array.isArray(account.requirements && account.requirements.currently_due)
          ? account.requirements.currently_due
          : [];
        const isConnected = !!(account.payouts_enabled && account.charges_enabled);
        await db.collection('sellers').updateMany(
          { stripeAccountId: String(account.id) },
          {
            $set: {
              payoutProvider: 'stripe',
              payoutProviderDestinationType: 'stripe_connect_express',
              payoutAccountId: String(account.id),
              payoutVerified: isConnected,
              payoutOnboardingStatus: isConnected ? 'connected' : 'pending_provider',
              payoutProviderBankStatus: isConnected ? 'connected' : 'pending_provider',
              stripeChargesEnabled: !!account.charges_enabled,
              stripePayoutsEnabled: !!account.payouts_enabled,
              stripeDetailsSubmitted: !!account.details_submitted,
              stripeRequirementsDue: requirementsDue,
              updatedAt: new Date()
            }
          }
        );
      }
    }
  } catch (error) {
    console.error('Stripe webhook processing error:', error);
  }

  res.json({ received: true });
});

// POST /api/admin/orders/repair-legacy – rerun the retroactive legacy order repair flow
app.post('/api/admin/orders/repair-legacy', publicApiRateLimit, verifyToken, requireAdmin, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const dryRun = req.body && req.body.dryRun === true;
    const limit = Math.max(1, Math.min(50, parseInt(req.body && req.body.limit, 10) || 20));
    const forceEmailResend = req.body && req.body.forceEmailResend === true;
    if (dryRun) {
      const legacyMatches = await findLegacyOrdersForRepair(limit);
      const matchedOrders = (legacyMatches.completedOrders || []).concat(legacyMatches.pendingOrders || []);
      return res.json({
        dryRun: true,
        matchedCount: matchedOrders.length,
        orders: matchedOrders.map(function(order) {
          return {
            orderId: String(order && order.id ? order.id : ''),
            status: String(order && order.status ? order.status : ''),
            shippingStatus: String(order && order.shippingStatus ? order.shippingStatus : ''),
            completedAt: order && order.completedAt ? order.completedAt : null,
            buyerEmail: normalizeEmail(order && order.buyerEmail ? order.buyerEmail : '')
          };
        })
      });
    }
    const repairSummary = await repairCompletedLegacyOrders({ limit: limit, forceEmailResend: forceEmailResend });
    res.json({ success: true, ...repairSummary });
  } catch (error) {
    console.error('Error repairing legacy orders:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── GET USER ORDERS ────────────────────────────────────────────────────────────
// Returns only orders that belong to the authenticated user.
// Admins may pass ?all=true to retrieve all orders for support/admin use.
app.get('/api/orders', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  
  try {
    let query;
    if (req.isAdmin && req.query.all === 'true') {
      // Admin-only: return all orders when explicitly requested
      query = {};
    } else {
      // Scope to the authenticated user's finalized purchases only.
      query = { status: 'completed', $or: [{ userId: req.userId }, { buyerEmail: req.userEmail }] };
    }
    const orders = await db.collection('orders').find(query).sort({ createdAt: -1 }).toArray();
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
    const sellerProfile = await db.collection('sellers').findOne(
      { userId: req.userId },
      { projection: { shopName: 1 } }
    );
    const orders = await db.collection('orders')
      // Only return finalized completed orders for buyer purchase history/account views.
      .find({ status: 'completed', $or: [{ userId: req.userId }, { buyerEmail: req.userEmail }] })
      .sort({ createdAt: -1 })
      .toArray();
    res.json(orders);
  } catch (error) {
    console.error('Error fetching user orders:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/orders/digital – completed digital orders for current user (auth required)
app.get('/api/orders/digital', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const orders = await db.collection('orders')
      .find({ status: 'completed', $or: [{ userId: req.userId }, { buyerEmail: req.userEmail }] })
      .sort({ createdAt: -1 })
      .toArray();
    const digitalOrders = (Array.isArray(orders) ? orders : []).filter(function(order) {
      if (String(order && order.type ? order.type : '').toLowerCase() === 'digital') return true;
      return (Array.isArray(order && order.items ? order.items : [])).some(function(item) {
        return item && (item.digital === true || String(item.type || '').toLowerCase() === 'digital');
      });
    });
    res.json(digitalOrders);
  } catch (error) {
    console.error('Error fetching digital orders:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/orders/subscriptions – completed subscription orders for current user (auth required)
app.get('/api/orders/subscriptions', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const orders = await db.collection('orders')
      .find({ status: 'completed', $or: [{ userId: req.userId }, { buyerEmail: req.userEmail }] })
      .sort({ createdAt: -1 })
      .toArray();
    const subscriptionOrders = (Array.isArray(orders) ? orders : []).filter(function(order) {
      return String(order && order.type ? order.type : '').toLowerCase() === 'subscription' || !!(order && order.subscriptionId);
    });
    res.json(subscriptionOrders);
  } catch (error) {
    console.error('Error fetching subscription orders:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/orders/trade-ins – trade-in history for current user (auth required)
app.get('/api/orders/trade-ins', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const tradeIns = await db.collection('tradeIns')
      .find({ userId: req.userId })
      .sort({ submittedAt: -1, createdAt: -1 })
      .toArray();
    if (tradeIns && tradeIns.length > 0) {
      return res.json(tradeIns);
    }
    const userPrefs = await db.collection('userPreferences').findOne(
      { userId: req.userId },
      { projection: { tradeIns: 1 } }
    );
    const fallbackTradeIns = Array.isArray(userPrefs && userPrefs.tradeIns ? userPrefs.tradeIns : [])
      ? userPrefs.tradeIns
      : [];
    res.json(fallbackTradeIns);
  } catch (error) {
    console.error('Error fetching trade-in orders:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/orders/sold – get completed orders that include the current seller's products.
app.get('/api/orders/sold', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const sellerProfile = await db.collection('sellers').findOne(
      { userId: req.userId },
      { projection: { shopName: 1 } }
    );

    // Primary query: orders where an item carries the authenticated user's sellerId.
    const primaryOrders = await db.collection('orders')
      // Seller dashboards and payout summaries should only include finalized completed sales.
      .find({ status: 'completed', 'items.sellerId': req.userId })
      .sort({ createdAt: -1 })
      .toArray();

    // Fallback: check sellerSales records for any order IDs not already captured above.
    // This surfaces legacy orders whose items.sellerId was not yet patched.
    const primaryOrderIds = new Set(primaryOrders.map(function(o) { return String(o.id || ''); }));
    const saleDocs = await db.collection('sellerSales')
      .find({ sellerId: req.userId }, { projection: { orderId: 1 } })
      .toArray();
    const missingOrderIds = saleDocs
      .map(function(s) { return String(s.orderId || ''); })
      .filter(function(id) { return id && !primaryOrderIds.has(id); });
    let fallbackOrders = [];
    if (missingOrderIds.length > 0) {
      fallbackOrders = await db.collection('orders')
        .find({ status: 'completed', id: { $in: missingOrderIds } })
        .sort({ createdAt: -1 })
        .toArray();
    }

    const orders = primaryOrders.concat(fallbackOrders);

    const sellerOrders = orders.map(function(order) {
      const sellerSummaries = Array.isArray(order.sellerSummaries) && order.sellerSummaries.length > 0
        ? order.sellerSummaries
        : buildSellerOrderSummaries(order);
      const sellerSummary = sellerSummaries.find(function(summary) {
        return String(summary && summary.sellerId ? summary.sellerId : '') === String(req.userId);
      }) || null;
      const sellerItems = (Array.isArray(order.items) ? order.items : []).filter(function(item) {
        return String(item && item.sellerId ? item.sellerId : '') === String(req.userId);
      });
      const sellerFinancialsFallback = sellerSummary ? null : getSellerFinancials(order, req.userId);
      return {
        ...order,
        sellerItems: sellerItems,
        sellerItemCount: sellerSummary ? sellerSummary.itemCount : sellerItems.reduce(function(sum, item) {
          return sum + (Math.max(1, parseInt(item && item.quantity, 10) || 1));
        }, 0),
        sellerGrossTotal: sellerSummary ? sellerSummary.grossTotal : sellerItems.reduce(function(sum, item) {
          const quantity = Math.max(1, parseInt(item && item.quantity, 10) || 1);
          const unitPrice = parseFloat(item && item.price) || 0;
          return sum + parseFloat((unitPrice * quantity).toFixed(2));
        }, 0),
        sellerNetTotal: sellerSummary ? sellerSummary.netTotal : (sellerFinancialsFallback ? sellerFinancialsFallback.payoutAmount : 0),
        sellerTier: sellerSummary
          ? normalizeSellerTier(sellerSummary.sellerTier || sellerSummary.tier || 'starter')
          : normalizeSellerTier(sellerFinancialsFallback && sellerFinancialsFallback.sellerTier ? sellerFinancialsFallback.sellerTier : (sellerItems[0] && sellerItems[0].sellerTier ? sellerItems[0].sellerTier : 'starter')),
        buyerDisplayName: [order && order.buyer ? order.buyer.firstName : '', order && order.buyer ? order.buyer.lastName : ''].filter(Boolean).join(' ').trim()
          || normalizeEmail(order && order.buyerEmail ? order.buyerEmail : '')
          || '—'
      };
    });
    const writeOffAmount = Number(
      SELLER_EARNINGS_WRITE_OFF_BY_SHOP[String(sellerProfile && sellerProfile.shopName ? sellerProfile.shopName : '').trim().toLowerCase()] || 0
    );
    if (Number.isFinite(writeOffAmount) && writeOffAmount > 0) {
      let remainingWriteOff = parseFloat(writeOffAmount.toFixed(2));
      for (let i = 0; i < sellerOrders.length && remainingWriteOff > 0; i += 1) {
        const currentNet = Number(sellerOrders[i].sellerNetTotal);
        if (!Number.isFinite(currentNet) || currentNet <= 0) continue;
        const applied = Math.min(currentNet, remainingWriteOff);
        sellerOrders[i].sellerNetTotal = parseFloat((currentNet - applied).toFixed(2));
        sellerOrders[i].sellerWriteOffApplied = parseFloat(applied.toFixed(2));
        remainingWriteOff = parseFloat((remainingWriteOff - applied).toFixed(2));
      }
    }
    res.json(sellerOrders);
  } catch (error) {
    console.error('Error fetching seller orders:', error);
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

// ── MARK ORDER AS SHIPPED (seller only) ────────────────────────────────────────
// Sellers call this once they have dispatched the package. It updates the order
// shipping status and sends an in-transit email to the buyer.
app.post('/api/orders/:orderId/ship', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  const { orderId } = req.params;
  if (!orderId || orderId.length > 64) {
    return res.status(400).json({ error: 'Invalid orderId' });
  }

  try {
    const order = await db.collection('orders').findOne({ id: orderId });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'completed') {
      return res.status(400).json({ error: 'Only completed orders can be marked as shipped' });
    }
    if (order.shippingStatus === 'shipped') {
      return res.status(409).json({ error: 'Order has already been marked as shipped' });
    }

    // Verify the caller is a seller for at least one item in this order
    const sellerItems = (Array.isArray(order.items) ? order.items : []).filter(function(item) {
      return String(item && item.sellerId ? item.sellerId : '') === String(req.userId);
    });
    if (sellerItems.length === 0) {
      return res.status(403).json({ error: 'You are not the seller for this order' });
    }

    const now = new Date();
    await db.collection('orders').updateOne(
      { id: orderId },
      { $set: { shippingStatus: 'shipped', shippedAt: now, updatedAt: now } }
    );

    // Notify the buyer by email that their order is in transit
    const buyerEmail = normalizeEmail(order.buyerEmail || (order.buyer && order.buyer.email) || '');
    if (buyerEmail) {
      const buyerFirstName = escapeHtml(order.buyer && order.buyer.firstName ? order.buyer.firstName : '');
      const safeOrderId = escapeHtml(orderId);
      await sendEventEmailSafe(
        buyerEmail,
        'Your Zorexium order is on its way!',
        `<p>Good news${buyerFirstName ? ', ' + buyerFirstName : ''}!</p>` +
        `<p>Your order <strong>${safeOrderId}</strong> has been shipped and is on its way to you.</p>` +
        `<p>The seller has confirmed that your package is in transit. Please allow a few business days for delivery.</p>`,
        '/track-your-order.html?order=' + encodeURIComponent(orderId)
      );
    }

    let payoutResult = null;
    try {
      const refreshedOrder = await db.collection('orders').findOne({ id: orderId });
      payoutResult = await sendStripeSellerPayout(
        refreshedOrder || { ...order, shippingStatus: 'shipped', shippedAt: now },
        { triggerSource: 'shipment_verified', sellerId: String(req.userId || '') }
      );
      if (!payoutResult.ok) {
        console.error('Failed to process shipment-triggered payout for order', orderId, '-', payoutResult.error);
      }
    } catch (payoutErr) {
      console.error('Shipment payout processing error for order', orderId, '-', payoutErr.message);
    }

    res.json({
      success: true,
      orderId,
      shippingStatus: 'shipped',
      shippedAt: now,
      payoutStatus: payoutResult && payoutResult.ok
        ? (
          payoutResult.deferred
            ? (
              String(payoutResult.reason || '').toLowerCase().includes('not yet marked as shipped')
                ? 'pending_delivery'
                : (String(payoutResult.reason || '').toLowerCase().includes('held for') ? 'pending_hold' : 'blocked_onboarding')
            )
            : (payoutResult.processing ? 'processing' : 'paid')
        )
        : 'failed'
    });
  } catch (error) {
    console.error('Error marking order as shipped:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── GET SINGLE ORDER BY ORDER ID (public, order ID is unguessable) ─────────────
app.get('/api/orders/:orderId', publicApiRateLimit, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  const { orderId } = req.params;
  if (!orderId || orderId.length > 64) {
    return res.status(400).json({ error: 'Invalid orderId' });
  }

  try {
    const order = await db.collection('orders').findOne({ id: orderId });
    if (!order) {
      const pendingOrder = await db.collection('pendingOrders').findOne({ id: orderId });
      if (!pendingOrder) return res.status(404).json({ error: 'Order not found' });
      return res.json(pendingOrder);
    }
    // Return order without internal MongoDB _id, keeping buyer info for confirmation display
    res.json(order);
  } catch (error) {
    console.error('Error fetching order:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/orders/:orderId/reconcile-stripe – finalize a pending Stripe order by checking Stripe directly
app.post('/api/orders/:orderId/reconcile-stripe', publicApiRateLimit, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  if (!stripe || !STRIPE_SECRET_KEY) return res.status(503).json({ error: 'Stripe is not configured on the server' });
  const orderId = String(req.params && req.params.orderId ? req.params.orderId : '').trim();
  if (!orderId || orderId.length > MAX_ORDER_ID_LENGTH) {
    return res.status(400).json({ error: `Invalid orderId (max ${MAX_ORDER_ID_LENGTH} characters)` });
  }
  const sessionId = String(req.body && req.body.sessionId ? req.body.sessionId : '').trim();
  if (sessionId && !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) {
    return res.status(400).json({ error: 'Invalid Stripe sessionId' });
  }
  try {
    let order = await db.collection('pendingOrders').findOne({ id: orderId });
    if (!order) order = await db.collection('orders').findOne({ id: orderId });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (String(order.status || '').toLowerCase() === 'completed') {
      return res.json({ success: true, orderId: orderId, status: 'completed', alreadyCompleted: true });
    }
    const paidSession = await getPaidStripeCheckoutSessionForOrder(order, sessionId);
    if (!paidSession) {
      return res.status(409).json({ error: 'Stripe checkout session is not paid yet' });
    }
    const completion = await completeStripeCheckoutOrder(orderId, paidSession, { triggerSource: 'stripe_reconcile_endpoint' });
    if (!completion.ok) {
      return res.status(500).json({ error: completion.error || 'Failed to reconcile Stripe order' });
    }
    const finalizedOrder = completion.order || await db.collection('orders').findOne({ id: orderId });
    res.json({
      success: true,
      orderId: orderId,
      status: finalizedOrder && finalizedOrder.status ? finalizedOrder.status : 'completed',
      receiptId: finalizedOrder && finalizedOrder.receiptId ? finalizedOrder.receiptId : null
    });
  } catch (error) {
    console.error('Error reconciling Stripe order:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/admin/orders/reconcile-stripe – admin reconciliation for a specific Stripe order/session
app.post('/api/admin/orders/reconcile-stripe', publicApiRateLimit, verifyToken, requireAdmin, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  if (!stripe || !STRIPE_SECRET_KEY) return res.status(503).json({ error: 'Stripe is not configured on the server' });
  let orderId = String(req.body && req.body.orderId ? req.body.orderId : '').trim();
  const sessionId = String(req.body && req.body.sessionId ? req.body.sessionId : '').trim();
  const forceEmailResend = req.body && req.body.forceEmailResend === true;
  if (!orderId && !sessionId) {
    return res.status(400).json({ error: 'orderId or sessionId is required' });
  }
  if (sessionId && !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) {
    return res.status(400).json({ error: 'Invalid Stripe sessionId' });
  }
  try {
    let paidSession = null;
    if (sessionId) {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      if (session && session.id) {
        const mappedOrderId = String(
          (session && session.metadata && session.metadata.orderId)
            || (session && session.client_reference_id)
            || ''
        ).trim();
        if (mappedOrderId) orderId = mappedOrderId;
        const paymentStatus = String(session && session.payment_status ? session.payment_status : '').toLowerCase();
        const checkoutStatus = String(session && session.status ? session.status : '').toLowerCase();
        if (paymentStatus === 'paid' || paymentStatus === 'no_payment_required' || checkoutStatus === 'complete') {
          paidSession = session;
        }
      }
    }
    if (!orderId || orderId.length > MAX_ORDER_ID_LENGTH) {
      return res.status(400).json({ error: `Invalid orderId (max ${MAX_ORDER_ID_LENGTH} characters)` });
    }
    let order = await db.collection('pendingOrders').findOne({ id: orderId });
    if (!order) order = await db.collection('orders').findOne({ id: orderId });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (String(order.status || '').toLowerCase() === 'completed') {
      const automation = await processCompletedOrderAutomation(order, {
        triggerSource: 'admin_reconcile_stripe',
        forceEmailResend: forceEmailResend
      });
      return res.json({
        success: true,
        orderId: orderId,
        alreadyCompleted: true,
        receiptId: automation && automation.order && automation.order.receiptId ? automation.order.receiptId : null
      });
    }
    if (!paidSession) {
      paidSession = await getPaidStripeCheckoutSessionForOrder(order, sessionId);
    }
    if (!paidSession) {
      return res.status(409).json({ error: 'Stripe checkout session is not paid yet' });
    }
    const completion = await completeStripeCheckoutOrder(orderId, paidSession, {
      triggerSource: 'admin_reconcile_stripe',
      forceEmailResend: forceEmailResend
    });
    if (!completion.ok) {
      return res.status(500).json({ error: completion.error || 'Failed to reconcile Stripe order' });
    }
    res.json({
      success: true,
      orderId: orderId,
      status: completion.order && completion.order.status ? completion.order.status : 'completed',
      receiptId: completion.order && completion.order.receiptId ? completion.order.receiptId : null
    });
  } catch (error) {
    console.error('Error running admin Stripe order reconciliation:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── RETURNS ────────────────────────────────────────────────────────────────────

// POST /api/returns – submit a new return request (auth required)
app.post('/api/returns', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  const { orderId, reason, details, source } = req.body;
  if (!orderId || typeof orderId !== 'string' || orderId.length > 64) {
    return res.status(400).json({ error: 'Valid orderId is required' });
  }
  const validReasons = ['defective', 'not_as_described', 'wrong_item', 'not_received', 'changed_mind', 'other'];
  if (!reason || !validReasons.includes(reason)) {
    return res.status(400).json({ error: 'A valid return reason is required' });
  }
  if (details && (typeof details !== 'string' || details.length > 2000)) {
    return res.status(400).json({ error: 'Details must be a string under 2000 characters' });
  }
  try {
    const order = await db.collection('orders').findOne({
      id: orderId,
      $or: [{ userId: req.userId }, { buyerEmail: req.userEmail }]
    });
    if (!order) return res.status(404).json({ error: 'Order not found or does not belong to you' });
    if (order.status !== 'completed') {
      return res.status(400).json({ error: 'Only completed orders can have returns initiated' });
    }
    // Prevent duplicate open returns for the same order
    const existing = await db.collection('returns').findOne({ orderId, userId: req.userId, status: { $in: ['open', 'pending', 'approved'] } });
    if (existing) {
      return res.status(409).json({ error: 'A return request for this order is already open' });
    }
    const returnId = 'RET-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const returnDoc = {
      returnId,
      orderId,
      userId: req.userId,
      buyerEmail: normalizeEmail(order.buyerEmail || req.userEmail || ''),
      reason,
      details: String(details || '').slice(0, 2000),
      status: 'open',
      createdAt: new Date(),
      updatedAt: new Date(),
      orderTotal: order.total || null,
      items: Array.isArray(order.items) ? order.items.map(function(i) { return { name: i.name || 'Item', quantity: i.quantity || 1 }; }) : []
    };
    await db.collection('returns').insertOne(returnDoc);
    try {
      const sourceLabelMap = {
        'returns-history': 'Returns History',
        'marketplace-settings': 'Marketplace Settings'
      };
      const sourceLabel = sourceLabelMap[String(source || '').trim()] || 'Return request form';
      const itemsSummary = returnDoc.items.map(function(item) {
        return `${item.name || 'Item'} x${parseInt(item.quantity, 10) || 1}`;
      }).join(', ') || 'No items listed';
      await sendEmail({
        to: ADMIN_NOTIFICATION_EMAIL,
        subject: 'New return request submitted on Zorexium',
        text:
          'A new return request was submitted.\n'
          + `Submitted from: ${sourceLabel}\n`
          + `Return ID: ${returnId}\n`
          + `Order ID: ${orderId}\n`
          + `Buyer Email: ${returnDoc.buyerEmail || 'Not provided'}\n`
          + `Reason: ${reason}\n`
          + `Details: ${returnDoc.details || 'None provided'}\n`
          + `Items: ${itemsSummary}\n`
          + `Order Total: ${returnDoc.orderTotal == null ? 'N/A' : '$' + Number(returnDoc.orderTotal).toFixed(2)}`
      });
    } catch (mailError) {
      console.error('Failed to send admin return email:', mailError.message);
    }
    res.status(201).json({ success: true, returnId, status: 'open' });
  } catch (error) {
    console.error('Error creating return:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/returns/my – get current user's return requests (auth required)
app.get('/api/returns/my', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const returns = await db.collection('returns')
      .find({ $or: [{ userId: req.userId }, { buyerEmail: req.userEmail }] })
      .sort({ createdAt: -1 })
      .toArray();
    res.json(returns);
  } catch (error) {
    console.error('Error fetching returns:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── COMMUNITY POSTS ────────────────────────────────────────────────────────────

// POST /api/posts/upload-video – upload a video file for use in a community post (auth required).
// Accepts multipart/form-data with a single field named "video".
// The file is stored in MongoDB GridFS and an absolute URL is returned.
app.post('/api/posts/upload-video', videoUploadRateLimit, verifyToken, function(req, res) {
  if (!mongoConnected || !videoBucket) return res.status(503).json({ error: 'Database unavailable' });

  videoUpload.single('video')(req, res, async function(err) {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'Video too large. Max: 100 MB.' });
      }
      return res.status(400).json({ error: err.message || 'Video upload failed' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No video file provided' });
    }

    try {
      const uploadStream = videoBucket.openUploadStream(req.file.originalname || 'video', {
        contentType: req.file.mimetype
      });
      uploadStream.end(req.file.buffer);

      await new Promise(function(resolve, reject) {
        uploadStream.on('finish', resolve);
        uploadStream.on('error', reject);
      });

      const videoUrl = BACKEND_BASE_URL + '/api/media/video/' + uploadStream.id.toString();
      res.status(201).json({ videoUrl: videoUrl });
    } catch (error) {
      console.error('Error storing video in GridFS:', error);
      res.status(500).json({ error: 'Failed to store video' });
    }
  });
});

// GET /api/media/video/:id – stream a community video from GridFS with HTTP range support.
app.get('/api/media/video/:id', async function(req, res) {
  if (!mongoConnected || !videoBucket) return res.status(503).json({ error: 'Database unavailable' });

  let fileId;
  try {
    fileId = new ObjectId(req.params.id);
  } catch (_) {
    return res.status(400).json({ error: 'Invalid video ID' });
  }

  try {
    const files = await videoBucket.find({ _id: fileId }).toArray();
    if (!files.length) return res.status(404).json({ error: 'Video not found' });

    const file = files[0];
    const fileSize = file.length;
    const contentType = file.contentType || 'video/mp4';
    const rangeHeader = req.headers.range;

    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      if (start >= fileSize || end >= fileSize || start > end) {
        res.set('Content-Range', 'bytes */' + fileSize);
        return res.status(416).end();
      }
      const chunkSize = end - start + 1;
      res.writeHead(206, {
        'Content-Range': 'bytes ' + start + '-' + end + '/' + fileSize,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400'
      });
      const downloadStream = videoBucket.openDownloadStream(fileId, { start: start, end: end + 1 });
      downloadStream.on('error', function(streamErr) {
        console.error('Error reading video stream (range):', streamErr);
        if (!res.writableEnded) res.end();
      });
      downloadStream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=86400'
      });
      const downloadStream = videoBucket.openDownloadStream(fileId);
      downloadStream.on('error', function(streamErr) {
        console.error('Error reading video stream:', streamErr);
        if (!res.writableEnded) res.end();
      });
      downloadStream.pipe(res);
    }
  } catch (error) {
    console.error('Error streaming video:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Error streaming video' });
  }
});

// POST /api/posts – create a post (auth required)
app.post('/api/posts', verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  const { title, content, boardType, imageUrl, imageUrls, videoUrl } = req.body;
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
  const normalizedImageUrls = [];
  if (imageUrls !== undefined && imageUrls !== null) {
    if (!Array.isArray(imageUrls)) {
      return res.status(400).json({ error: 'Invalid imageUrls' });
    }
    if (imageUrls.length > MAX_POST_IMAGE_COUNT) {
      return res.status(400).json({ error: `You can upload up to ${MAX_POST_IMAGE_COUNT} images per post` });
    }
    for (const rawImageValue of imageUrls) {
      if (typeof rawImageValue !== 'string') {
        return res.status(400).json({ error: 'Invalid imageUrls item' });
      }
      const imageValue = rawImageValue.trim();
      if (!imageValue) {
        return res.status(400).json({ error: 'Invalid imageUrls item' });
      }
      if (imageValue.startsWith('data:image/')) {
        const imageBytes = getDataUrlPayloadBytes(imageValue);
        if (!imageBytes) {
          return res.status(400).json({ error: 'Invalid image data URL' });
        }
        if (imageBytes > MAX_IMAGE_SIZE_BYTES) {
          return res.status(400).json({ error: 'Image too large. Max: 10 MB per image.' });
        }
        normalizedImageUrls.push(imageValue);
        continue;
      }
      if (imageValue.length > 2000) {
        return res.status(400).json({ error: 'Invalid imageUrl' });
      }
      try {
        const parsed = new URL(imageValue);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return res.status(400).json({ error: 'imageUrl must use http or https protocol' });
        }
      } catch (_) {
        return res.status(400).json({ error: 'imageUrl is not a valid URL' });
      }
      normalizedImageUrls.push(imageValue);
    }
  }
  if (imageUrl !== undefined && imageUrl !== null && imageUrl !== '') {
    if (typeof imageUrl !== 'string' || imageUrl.length > 2000) {
      return res.status(400).json({ error: 'Invalid imageUrl' });
    }
    const trimmedImageUrl = imageUrl.trim();
    try {
      const parsed = new URL(trimmedImageUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return res.status(400).json({ error: 'imageUrl must use http or https protocol' });
      }
    } catch (_) {
      return res.status(400).json({ error: 'imageUrl is not a valid URL' });
    }
    if (!normalizedImageUrls.includes(trimmedImageUrl)) {
      normalizedImageUrls.push(trimmedImageUrl);
    }
  }
  if (normalizedImageUrls.length > MAX_POST_IMAGE_COUNT) {
    return res.status(400).json({ error: `You can upload up to ${MAX_POST_IMAGE_COUNT} images per post` });
  }

  let normalizedVideoUrl = '';
  if (videoUrl !== undefined && videoUrl !== null && videoUrl !== '') {
    if (typeof videoUrl !== 'string') {
      return res.status(400).json({ error: 'Invalid videoUrl' });
    }
    normalizedVideoUrl = videoUrl.trim();
    if (!normalizedVideoUrl) {
      return res.status(400).json({ error: 'Invalid videoUrl' });
    }
    if (normalizedVideoUrl.length > 2000) {
      return res.status(400).json({ error: 'Invalid videoUrl' });
    }
    try {
      const parsed = new URL(normalizedVideoUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return res.status(400).json({ error: 'videoUrl must use http or https protocol' });
      }
    } catch (_) {
      return res.status(400).json({ error: 'videoUrl is not a valid URL' });
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
    if (normalizedImageUrls.length > 0) {
      post.imageUrls = normalizedImageUrls;
      post.imageUrl = normalizedImageUrls[0];
    }
    if (normalizedVideoUrl) {
      post.videoUrl = normalizedVideoUrl;
    }
    const result = await db.collection('posts').insertOne(post);
    const createdPost = { ...post, _id: result.insertedId };
    if (isBlogBoardType(createdPost.boardType)) {
      await notifyBlogSubscribersOfNewPost(createdPost);
    }
    if (isCommunityOrInnovationBoardType(createdPost.boardType)) {
      await sendAdminNotificationSafe(
        'New community/innovation post',
        `<p>A new post was published.</p>`
          + `<p><strong>Board:</strong> ${escapeHtml(String(createdPost.boardType || 'general'))}</p>`
          + `<p><strong>Title:</strong> ${escapeHtml(String(createdPost.title || 'Untitled'))}</p>`
          + `<p><strong>Author:</strong> ${escapeHtml(String(createdPost.username || createdPost.email || 'Unknown'))}</p>`
          + `<p><strong>Author email:</strong> ${escapeHtml(String(createdPost.email || 'N/A'))}</p>`
          + `<p><strong>Post ID:</strong> ${escapeHtml(String(result.insertedId))}</p>`,
        getPostBoardLinkPath(createdPost.boardType)
      );
    }
    res.status(201).json(createdPost);
  } catch (error) {
    console.error('Error creating post:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/blog/subscribe – subscribe to blog digest and send confirmation email
app.post('/api/blog/subscribe', publicApiRateLimit, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  const rawEmail = req.body && req.body.email;
  const email = normalizeEmail(rawEmail);
  if (!isLikelyEmail(email)) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }

  try {
    const now = new Date();
    await db.collection('blogSubscribers').updateOne(
      { email },
      {
        $set: { email, status: 'active', updatedAt: now, source: 'blog.html' },
        $setOnInsert: { subscribedAt: now }
      },
      { upsert: true }
    );

    const confirmation = await sendEmail({
      to: email,
      subject: 'You’re subscribed to the Zorexium Weekly Digest',
      text:
        'Thanks for subscribing to the Zorexium Weekly Digest.\n\n'
        + `You will receive notifications whenever a new blog post is published.\n\n`
        + `Visit: ${makeAbsoluteUrl('/blog.html')}`,
      html:
        '<p>Thanks for subscribing to the <strong>Zorexium Weekly Digest</strong>.</p>'
        + '<p>You will receive notifications whenever a new blog post is published.</p>'
        + `<p><a href="${makeAbsoluteUrl('/blog.html')}">Visit the blog</a></p>`
    });

    if (!confirmation.success) {
      return res.status(500).json({ error: 'Subscription saved, but confirmation email failed to send. Please try again.' });
    }
    await sendAdminNotificationSafe(
      'New blog email notification signup',
      `<p>A user subscribed to blog email notifications.</p><p><strong>Email:</strong> ${escapeHtml(email)}</p><p><strong>Source:</strong> blog.html</p>`,
      '/blog.html'
    );

    return res.json({ success: true, message: 'Subscribed successfully. Please check your inbox for confirmation.' });
  } catch (error) {
    console.error('Error subscribing to blog digest:', error);
    return res.status(500).json({ error: 'Failed to subscribe.' });
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
app.post('/api/posts/:postId/replies', publicApiRateLimit, verifyToken, async function(req, res) {
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
    try {
      const post = await db.collection('posts').findOne({ _id: objectId }, { projection: { userId: 1, title: 1, boardType: 1 } });
      if (post && post.userId && post.userId !== req.userId) {
        await maybeSendPreferenceNotificationEmail(
          String(post.userId),
          'community_replies',
          'New reply to your community post',
          `<p>${escapeHtml(username)} replied to your post: <strong>${escapeHtml(post.title || 'Untitled post')}</strong>.</p>`,
          '/community-hub.html'
        );
      }
      if (post && isCommunityOrInnovationBoardType(post.boardType)) {
        await sendAdminNotificationSafe(
          'New community/innovation reply',
          `<p>A reply was posted.</p>`
            + `<p><strong>Board:</strong> ${escapeHtml(String(post.boardType || 'general'))}</p>`
            + `<p><strong>Post title:</strong> ${escapeHtml(String(post.title || 'Untitled'))}</p>`
            + `<p><strong>Reply author:</strong> ${escapeHtml(String(username || req.userEmail || 'Unknown'))}</p>`
            + `<p><strong>Reply author email:</strong> ${escapeHtml(String(req.userEmail || 'N/A'))}</p>`
            + `<p><strong>Reply preview:</strong> ${escapeHtml(String(content).slice(0, 240))}</p>`,
          getPostBoardLinkPath(post.boardType)
        );
      }
    } catch (mailErr) {
      console.error('Failed to send community reply email:', mailErr.message);
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

  // Enforce 10 MB max based on decoded bytes (not raw string length).
  const profileImageBytes = getDataUrlPayloadBytes(profileImage);
  if (profileImageBytes === null) {
    return res.status(400).json({ error: 'Invalid image data URL' });
  }
  if (profileImageBytes > MAX_IMAGE_SIZE_BYTES) {
    return res.status(400).json({ error: 'Image too large. Max: 10 MB per image.' });
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

  const { firstName, lastName, phone, coverImage } = req.body;
  const updates = { updatedAt: new Date() };
  if (firstName !== undefined) updates.firstName = String(firstName).slice(0, 100);
  if (lastName !== undefined) updates.lastName = String(lastName).slice(0, 100);
  if (phone !== undefined) updates.phone = String(phone).slice(0, 30);
  if (coverImage !== undefined) {
    if (typeof coverImage !== 'string' || !coverImage.startsWith('data:image/')) {
      return res.status(400).json({ error: 'coverImage must be a base64 data URL (data:image/...)' });
    }
    // Enforce 10 MB max based on decoded bytes (not raw string length).
    const coverImageBytes = getDataUrlPayloadBytes(coverImage);
    if (coverImageBytes === null) {
      return res.status(400).json({ error: 'Invalid image data URL' });
    }
    if (coverImageBytes > MAX_IMAGE_SIZE_BYTES) {
      return res.status(400).json({ error: 'Image too large. Max: 10 MB per image.' });
    }
    updates.coverImage = coverImage;
  }

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
  var token = getTokenFromRequest(req);
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
  var token = getTokenFromRequest(req);
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
    await maybeSendPreferenceNotificationEmail(
      req.userId,
      'security_alerts',
      'Your password was changed',
      '<p>Your Zorexium account password was just changed.</p><p>If this was not you, please secure your account immediately.</p>',
      '/marketplace-settings.html#panel-security'
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
app.post('/api/sellers', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  try {
    const existing = await db.collection('sellers').findOne({ userId: req.userId });
    if (existing) return res.status(400).json({ error: 'Seller profile already exists' });

    const {
      accountType, shopName, shopDescription, businessEmail, phoneNumber,
      businessAddress, businessCity, businessState, businessZip,
      personalName, personalEmail, shippingAddress, shippingCity, shippingState, shippingZip,
      tier
    } = req.body;

    if (!accountType || !shopName) {
      return res.status(400).json({ error: 'accountType and shopName are required' });
    }

    const resolvedTier = (tier && VALID_SELLER_TIERS.includes(String(tier).toLowerCase())) ? String(tier).toLowerCase() : 'starter';

    // Pro tier requires payment via /api/sellers/subscription/confirm
    if (resolvedTier === 'pro') {
      return res.status(400).json({ error: 'Pro Seller registration requires a Stripe subscription. Please use the subscription signup flow.' });
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
      tier: resolvedTier,
      createdAt: new Date()
    };

    const result = await db.collection('sellers').insertOne(seller);

    // Mark user as seller
    await db.collection('users').updateOne(
      { _id: new ObjectId(req.userId) },
      { $set: { isSeller: true, updatedAt: new Date() } }
    );

    try {
      const user = await db.collection('users').findOne({ _id: new ObjectId(req.userId) }, { projection: { email: 1, firstName: 1 } });
      const to = normalizeEmail(user && user.email);
      if (to) {
        await sendEventEmailSafe(
          to,
          'Welcome to Zorexium Sellers',
          `<p>Welcome aboard${user && user.firstName ? ', ' + user.firstName : ''}! Your seller profile is now active.</p><p>You can start listing items and managing sales from your seller dashboard.</p>`,
          '/seller-dashboard.html'
        );
      }
      await sendAdminNotificationSafe(
        'New seller signup',
        `<p>A user signed up to become a seller.</p>`
          + `<p><strong>Tier:</strong> starter</p>`
          + `<p><strong>Shop name:</strong> ${escapeHtml(String(seller.shopName || 'N/A'))}</p>`
          + `<p><strong>Account type:</strong> ${escapeHtml(String(seller.accountType || 'N/A'))}</p>`
          + `<p><strong>User ID:</strong> ${escapeHtml(String(req.userId || 'N/A'))}</p>`
          + `<p><strong>User email:</strong> ${escapeHtml(String(to || 'N/A'))}</p>`,
        '/seller-dashboard.html'
      );
    } catch (mailErr) {
      console.error('Failed to send seller welcome email:', mailErr.message);
    }

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
    res.json(sanitizeSellerForClient(seller));
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
    'shippingState', 'shippingZip', 'tier',
    'logoUrl', 'bannerUrl', 'contactEmail', 'returnPolicy'
  ];
  const updates = { updatedAt: new Date() };
  const stringFields = [
    'shopName', 'shopDescription', 'businessEmail', 'phoneNumber',
    'businessAddress', 'businessCity', 'businessState', 'businessZip',
    'personalName', 'personalEmail', 'shippingAddress', 'shippingCity',
    'shippingState', 'shippingZip',
    'logoUrl', 'bannerUrl', 'contactEmail', 'returnPolicy'
  ];
  for (const field of stringFields) {
    if (req.body[field] !== undefined) updates[field] = String(req.body[field]).slice(0, 2000);
  }
  if (req.body.showContactEmail !== undefined) {
    updates.showContactEmail = Boolean(req.body.showContactEmail);
  }
  if (req.body.tier !== undefined) {
    const newTier = String(req.body.tier).toLowerCase();
    if (VALID_SELLER_TIERS.includes(newTier)) updates.tier = newTier;
  }
  // Allow sellers to dismiss the downgrade notification
  if (req.body.proTierDowngraded === false) {
    updates.proTierDowngraded = false;
  }

  try {
    const result = await db.collection('sellers').updateOne(
      { userId: req.userId },
      { $set: updates }
    );
    if (result.matchedCount === 0) return res.status(404).json({ error: 'Seller profile not found' });
    const updated = await db.collection('sellers').findOne({ userId: req.userId });
    res.json(sanitizeSellerForClient(updated));
  } catch (error) {
    console.error('Error updating seller profile:', error);
    res.status(500).json({ error: error.message });
  }
});

async function getOrCreateStripeConnectAccountForSeller(userId) {
  ensureStripeConfigured();
  const seller = await db.collection('sellers').findOne({ userId: userId });
  if (!seller) return { error: 'Seller profile not found' };

  let accountId = String(seller && seller.stripeAccountId ? seller.stripeAccountId : '').trim();
  if (accountId) {
    return { seller: seller, accountId: accountId, created: false };
  }

  const user = await db.collection('users').findOne({ _id: new ObjectId(userId) }, { projection: { email: 1 } });
  const account = await stripe.accounts.create({
    type: 'express',
    email: normalizeEmail((seller && seller.businessEmail) || (seller && seller.personalEmail) || (user && user.email) || '')
  });
  accountId = String(account && account.id ? account.id : '').trim();
  if (!accountId) return { error: 'Failed to create Stripe Connect account' };

  await db.collection('sellers').updateOne(
    { userId: userId },
    {
      $set: {
        payoutProvider: 'stripe',
        payoutProviderDestinationType: 'stripe_connect_express',
        payoutAccountId: accountId,
        stripeAccountId: accountId,
        payoutVerified: false,
        payoutOnboardingStatus: 'pending_provider',
        payoutProviderBankStatus: 'pending_provider',
        stripeChargesEnabled: false,
        stripePayoutsEnabled: false,
        stripeDetailsSubmitted: false,
        stripeRequirementsDue: [],
        updatedAt: new Date()
      }
    }
  );
  return { seller: seller, accountId: accountId, created: true };
}

async function getStripeConnectStatusForSeller(userId) {
  ensureStripeConfigured();
  const seller = await db.collection('sellers').findOne({ userId: userId });
  if (!seller) return { error: 'Seller profile not found' };
  const accountId = String(seller && seller.stripeAccountId ? seller.stripeAccountId : '').trim();
  if (!accountId) {
    return {
      accountId: null,
      connected: false,
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
      requirementsDue: []
    };
  }

  const account = await stripe.accounts.retrieve(accountId);
  const requirementsDue = Array.isArray(account.requirements && account.requirements.currently_due)
    ? account.requirements.currently_due
    : [];
  const connected = !!(account.payouts_enabled && account.charges_enabled);
  const now = new Date();
  await db.collection('sellers').updateOne(
    { userId: userId },
    {
      $set: {
        payoutProvider: 'stripe',
        payoutProviderDestinationType: 'stripe_connect_express',
        payoutAccountId: accountId,
        stripeAccountId: accountId,
        payoutVerified: connected,
        payoutOnboardingStatus: connected ? 'connected' : 'pending_provider',
        payoutProviderBankStatus: connected ? 'connected' : 'pending_provider',
        stripeChargesEnabled: !!account.charges_enabled,
        stripePayoutsEnabled: !!account.payouts_enabled,
        stripeDetailsSubmitted: !!account.details_submitted,
        stripeRequirementsDue: requirementsDue,
        stripeRequirementsDisabledReason: String(account.requirements && account.requirements.disabled_reason ? account.requirements.disabled_reason : ''),
        updatedAt: now,
        ...(connected ? { payoutOnboardingCompletedAt: now } : {})
      }
    }
  );
  return {
    accountId: accountId,
    connected: connected,
    chargesEnabled: !!account.charges_enabled,
    payoutsEnabled: !!account.payouts_enabled,
    detailsSubmitted: !!account.details_submitted,
    requirementsDue: requirementsDue
  };
}

// POST /api/stripe/connect/account – create or reuse the seller's Stripe Connect Express account
app.post('/api/stripe/connect/account', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const result = await getOrCreateStripeConnectAccountForSeller(req.userId);
    if (result.error) return res.status(404).json({ error: result.error });
    res.json({ success: true, accountId: result.accountId, created: result.created });
  } catch (error) {
    console.error('Error creating Stripe Connect account:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/stripe/connect/onboarding-link – create a Stripe-hosted onboarding/account update link
app.post('/api/stripe/connect/onboarding-link', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const result = await getOrCreateStripeConnectAccountForSeller(req.userId);
    if (result.error) return res.status(404).json({ error: result.error });
    const accountLink = await stripe.accountLinks.create({
      account: result.accountId,
      refresh_url: getStripeConnectRefreshUrl(),
      return_url: getStripeConnectReturnUrl(),
      type: 'account_onboarding'
    });
    await db.collection('sellers').updateOne(
      { userId: req.userId },
      {
        $set: {
          payoutOnboardingStatus: 'pending_provider',
          payoutProviderBankStatus: 'pending_provider',
          payoutProviderBankOnboardingUrl: accountLink.url,
          payoutProviderBankOnboardingStartedAt: new Date(),
          updatedAt: new Date()
        }
      }
    );
    res.json({ success: true, accountId: result.accountId, url: accountLink.url });
  } catch (error) {
    console.error('Error creating Stripe onboarding link:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/stripe/connect/status – fetch latest Stripe account status for seller payouts
app.get('/api/stripe/connect/status', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const status = await getStripeConnectStatusForSeller(req.userId);
    if (status.error) return res.status(404).json({ error: status.error });
    res.json(status);
  } catch (error) {
    console.error('Error fetching Stripe Connect status:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/stripe/connect/dashboard-link – create an Express dashboard login link
app.get('/api/stripe/connect/dashboard-link', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const result = await getOrCreateStripeConnectAccountForSeller(req.userId);
    if (result.error) return res.status(404).json({ error: result.error });
    const link = await stripe.accounts.createLoginLink(result.accountId);
    res.json({ url: link.url });
  } catch (error) {
    console.error('Error creating Stripe dashboard login link:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/sellers/me/payout-account/start – begin payout account onboarding (auth required)
app.post('/api/sellers/me/payout-account/start', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const result = await getOrCreateStripeConnectAccountForSeller(req.userId);
    if (result.error) return res.status(404).json({ error: result.error });
    const accountLink = await stripe.accountLinks.create({
      account: result.accountId,
      refresh_url: getStripeConnectRefreshUrl(),
      return_url: getStripeConnectReturnUrl(),
      type: 'account_onboarding'
    });
    const now = new Date();
    await db.collection('sellers').updateOne(
      { userId: req.userId },
      {
        $set: {
          payoutProvider: 'stripe',
          payoutProviderDestinationType: 'stripe_connect_express',
          payoutAccountId: result.accountId,
          stripeAccountId: result.accountId,
          payoutProviderBankStatus: 'pending_provider',
          payoutProviderBankOnboardingUrl: accountLink.url,
          payoutProviderBankOnboardingStartedAt: now,
          payoutVerified: false,
          payoutOnboardingStatus: 'pending_provider',
          payoutOnboardingStartedAt: now,
          updatedAt: now
        },
        $unset: {
          payoutVerificationCodeHash: '',
          payoutVerificationCodeExpiresAt: '',
          payoutVerificationMethod: '',
          payoutProviderBankLinkedAt: ''
        }
      }
    );

    res.json({
      success: true,
      payoutAccountId: result.accountId,
      provider: 'stripe',
      providerBankStatus: 'pending_provider',
      onboardingStatus: 'pending_provider',
      onboardingUrl: accountLink.url
    });
  } catch (error) {
    console.error('Error starting payout onboarding:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/sellers/me/payout-account/bank-linked – refresh Stripe Connect onboarding status (auth required)
app.post('/api/sellers/me/payout-account/bank-linked', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  try {
    const status = await getStripeConnectStatusForSeller(req.userId);
    if (status.error) return res.status(404).json({ error: status.error });
    res.json({
      success: true,
      payoutAccountId: status.accountId || null,
      provider: 'stripe',
      providerBankStatus: status.connected ? 'connected' : 'pending_provider',
      onboardingStatus: status.connected ? 'connected' : 'pending_provider'
    });
  } catch (error) {
    console.error('Error refreshing payout account status:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/sellers/me/payout-account/verify – complete payout account onboarding (auth required)
app.post('/api/sellers/me/payout-account/verify', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  try {
    const status = await getStripeConnectStatusForSeller(req.userId);
    if (status.error) return res.status(404).json({ error: status.error });
    if (!status.connected) {
      return res.status(409).json({ error: 'Complete Stripe Connect onboarding first.' });
    }
    const updatedSeller = await db.collection('sellers').findOne({ userId: req.userId }, { projection: { payoutAccountId: 1, stripeAccountId: 1 } });
    const retrySummary = await retryEligibleBlockedPayoutsForSeller(req.userId, 'onboarding_verified');
    res.json({
      success: true,
      payoutAccountId: updatedSeller && (updatedSeller.stripeAccountId || updatedSeller.payoutAccountId) ? (updatedSeller.stripeAccountId || updatedSeller.payoutAccountId) : null,
      provider: 'stripe',
      providerBankStatus: 'connected',
      payoutVerified: true,
      onboardingStatus: 'connected',
      retrySummary: retrySummary
    });
  } catch (error) {
    console.error('Error verifying payout account:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/sellers/assign-starter-tier – assign 'starter' tier to all sellers without a tier (auth required)
app.post('/api/sellers/assign-starter-tier', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const result = await db.collection('sellers').updateMany(
      { tier: { $exists: false } },
      { $set: { tier: 'starter', updatedAt: new Date() } }
    );
    res.json({ updated: result.modifiedCount, message: `Assigned starter tier to ${result.modifiedCount} sellers.` });
  } catch (error) {
    console.error('Error assigning starter tier:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/sellers/upgrade-to-pro – upgrade existing seller to Pro tier via Stripe subscription (auth required)
app.post('/api/sellers/upgrade-to-pro', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const seller = await db.collection('sellers').findOne({ userId: req.userId });
    if (!seller) return res.status(404).json({ error: 'Seller profile not found' });
    if (seller.tier === 'pro') return res.status(400).json({ error: 'Already on Pro tier' });

    const { subscriptionId } = req.body;
    if (!subscriptionId || typeof subscriptionId !== 'string' || subscriptionId.length > 128) {
      return res.status(400).json({ error: 'subscriptionId is required' });
    }

    const subscription = await verifyStripeProSellerSubscription(subscriptionId);

    await db.collection('sellers').updateOne(
      { userId: req.userId },
      { $set: { tier: 'pro', proSubscriptionId: subscriptionId, proSubscriptionStatus: String(subscription && subscription.status ? subscription.status : 'active'),
                proSubscriptionProvider: 'stripe',
                proTierDowngraded: false, updatedAt: new Date() } }
    );
    const updated = await db.collection('sellers').findOne({ userId: req.userId });
    try {
      const user = await db.collection('users').findOne({ _id: new ObjectId(req.userId) }, { projection: { email: 1 } });
      const to = normalizeEmail(user && user.email);
      if (to) {
        await sendEventEmailSafe(
          to,
          'Thanks for upgrading to Pro Seller',
          `<p>Your Pro Seller upgrade is complete.</p><p>Your new fee structure is now active: <strong>10%</strong> platform fee plus <strong>$1/month</strong> subscription.</p>`,
          '/seller-dashboard.html#tier'
        );
      }
    } catch (mailErr) {
      console.error('Failed to send Pro upgrade email:', mailErr.message);
    }
    res.json(updated);
  } catch (error) {
    console.error('Error upgrading seller to Pro:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/sellers/downgrade-to-starter – downgrade existing seller to Starter tier (auth required)
app.post('/api/sellers/downgrade-to-starter', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const seller = await db.collection('sellers').findOne({ userId: req.userId });
    if (!seller) return res.status(404).json({ error: 'Seller profile not found' });
    if (seller.tier === 'starter') return res.status(400).json({ error: 'Already on Starter tier' });

    await db.collection('sellers').updateOne(
      { userId: req.userId },
      { $set: { tier: 'starter', proTierDowngraded: true, proTierDowngradedAt: new Date(), updatedAt: new Date() },
        $unset: { proSubscriptionId: '', proSubscriptionStatus: '', proSubscriptionProvider: '' } }
    );
    const updated = await db.collection('sellers').findOne({ userId: req.userId });
    const user = await db.collection('users').findOne({ _id: new ObjectId(req.userId) }, { projection: { email: 1 } });
    await sendAdminNotificationSafe(
      'Pro seller subscription cancelled',
      `<p>A seller downgraded from Pro to Starter.</p>`
        + `<p><strong>Shop name:</strong> ${escapeHtml(String((updated && updated.shopName) || 'N/A'))}</p>`
        + `<p><strong>User ID:</strong> ${escapeHtml(String(req.userId || 'N/A'))}</p>`
        + `<p><strong>User email:</strong> ${escapeHtml(String(normalizeEmail(user && user.email) || 'N/A'))}</p>`,
      '/seller-dashboard.html#tier'
    );
    res.json(updated);
  } catch (error) {
    console.error('Error downgrading seller to Starter:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/sellers/recover-missing – recover orphaned seller records (auth required)
app.post('/api/sellers/recover-missing', verifyToken, async function(req, res) {
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
        tier: 'starter',
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
app.get('/api/sellers/user/:userId', publicApiRateLimit, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  const { userId } = req.params;
  if (!userId || userId.length > 128) {
    return res.status(400).json({ error: 'Invalid userId' });
  }

  try {
    const seller = await db.collection('sellers').findOne({ userId });
    if (!seller) return res.status(404).json({ error: 'Seller not found' });
    const completedSalesCount = await db.collection('orders').countDocuments({
      status: 'completed',
      'items.sellerId': userId
    });

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

    res.json({ ...seller, totalSales: completedSalesCount, profileImage });
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
      // Enforce 10 MB max based on decoded bytes (not raw string length).
      const fileBytes = getDataUrlPayloadBytes(f.data);
      if (fileBytes === null) {
        return res.status(400).json({ error: 'Invalid image data URL' });
      }
      if (fileBytes > MAX_IMAGE_SIZE_BYTES) {
        return res.status(400).json({ error: 'Image too large. Max: 10 MB per image.' });
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

// POST /api/payout – trigger/retry payout for a completed order (auth required)
app.post('/api/payout', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  const orderId = String((req.body && req.body.orderId) || '').trim();
  if (!orderId || orderId.length > MAX_ORDER_ID_LENGTH) {
    return res.status(400).json({ error: `Order ID is required and must not exceed ${MAX_ORDER_ID_LENGTH} characters` });
  }

  try {
    const order = await db.collection('orders').findOne({ id: orderId });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'completed') {
      return res.status(400).json({ error: 'Payouts can only be sent for completed orders' });
    }
    if (String(order.shippingStatus || '').toLowerCase() !== 'shipped') {
      return res.status(400).json({ error: 'Payouts become eligible only after the seller marks the order as shipped' });
    }

    const sellerInfos = getOrderSellerInfos(order);
    if (!sellerInfos.length) {
      return res.status(400).json({ error: 'Order does not include a seller payout target' });
    }
    const sellerOwnedOrder = sellerInfos.some(function(info) {
      return String(info && info.sellerId ? info.sellerId : '') === String(req.userId);
    });
    if (!sellerOwnedOrder) {
      return res.status(403).json({ error: 'Forbidden: you can only trigger payouts for your own seller items in this order' });
    }
    const seller = await db.collection('sellers').findOne(
      { userId: req.userId },
      { projection: { payoutVerified: 1, payoutProviderBankStatus: 1 } }
    );
    const bankStatus = String(seller && seller.payoutProviderBankStatus ? seller.payoutProviderBankStatus : '').toLowerCase();
    if (!seller || !seller.payoutVerified || (bankStatus && bankStatus !== 'connected')) {
      return res.status(409).json({ error: 'Complete and verify your Stripe payout onboarding before pushing payouts' });
    }

    const payoutResult = await sendStripeSellerPayout(order, { triggerSource: 'api', sellerId: req.userId });
    if (!payoutResult.ok) {
      console.error('Manual payout trigger failed for order', orderId, '-', payoutResult.error);
      return res.status(502).json({ error: payoutResult.error || 'Payout failed' });
    }
    if (payoutResult.deferred) {
      return res.status(409).json({ error: payoutResult.reason || 'Payout account setup is incomplete' });
    }

    const payout = await db.collection('payouts').findOne({ orderId: order.id, sellerId: req.userId });
    res.json({
      success: true,
      alreadyPaid: !!payoutResult.alreadyPaid,
      orderId: order.id,
      payout: payout || null
    });
  } catch (error) {
    console.error('Error triggering payout:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/payouts – get payouts for the current seller (auth required)
// Admins may pass ?all=true to retrieve all payouts for admin management.
app.get('/api/payouts', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  try {
    let query;
    if (req.isAdmin && req.query.all === 'true') {
      // Admin: return all payouts
      query = {};
    } else {
      // Look up the seller profile to get sellerUsername for matching legacy payouts
      const seller = await db.collection('sellers').findOne({ userId: req.userId }, { projection: { shopName: 1 } });
      const sellerUsername = seller ? (seller.shopName || '') : '';

      // Return only payouts for this seller (by sellerId or shopName fallback for legacy payouts)
      query = {
        $or: [
          { sellerId: req.userId },
          ...(sellerUsername ? [{ sellerUsername: sellerUsername }] : [])
        ]
      };
    }
    const payouts = await db.collection('payouts').find(query).sort({ createdAt: -1 }).toArray();
    res.json(payouts);
  } catch (error) {
    console.error('Error fetching payouts:', error);
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/payouts/:id – update payout status (auth required)
// Sellers may only update their own payouts; admins may update any payout.
app.put('/api/payouts/:id', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  let objectId;
  try {
    objectId = new ObjectId(req.params.id);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid payout ID' });
  }

  const { status, note } = req.body;
  // Admins can also mark payouts as manually paid when the PayPal Payouts API is unavailable.
  const validStatuses = ['pending_delivery', 'pending_hold', 'blocked_onboarding', 'ready_to_pay'];
  const adminOnlyStatuses = ['paid'];
  const allValidStatuses = req.isAdmin ? validStatuses.concat(adminOnlyStatuses) : validStatuses;
  if (!status || !allValidStatuses.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${allValidStatuses.join(', ')}` });
  }

  try {
    const payout = await db.collection('payouts').findOne({ _id: objectId });
    if (!payout) return res.status(404).json({ error: 'Payout not found' });

    // Ownership check: only the payout's seller or an admin may update
    if (!req.isAdmin && payout.sellerId !== req.userId) {
      return res.status(403).json({ error: 'Forbidden: you do not own this payout' });
    }

    if (status === 'ready_to_pay') {
      const order = await db.collection('orders').findOne({ id: String(payout.orderId || '') });
      if (!order || String(order.status || '').toLowerCase() !== 'completed') {
        return res.status(409).json({ error: 'Payout order is not in a completed state' });
      }
      if (String(order.shippingStatus || '').toLowerCase() !== 'shipped') {
        return res.status(409).json({ error: 'Seller must mark the order as shipped before payout can be marked ready' });
      }
    }

    const updates = { status, updatedAt: new Date() };
    if (status === 'ready_to_pay') updates.deliveredAt = new Date();
    if (status === 'paid') {
      updates.paidAt = new Date();
      updates.manuallyPaid = true;
      updates.error = null;
      if (note && typeof note === 'string') updates.manualPayNote = note.slice(0, MAX_MANUAL_PAY_NOTE_LENGTH);
    }

    await db.collection('payouts').updateOne({ _id: objectId }, { $set: updates });
    const updated = await db.collection('payouts').findOne({ _id: objectId });
    if (status === 'paid') {
      await notifyAdminPayoutPaidIfNeeded(updated, req.isAdmin ? 'manual_admin_update' : 'manual_seller_update');
    }
    if (status === 'ready_to_pay' && payout.sellerId) {
      try {
        const sellerUser = await db.collection('users').findOne({ _id: new ObjectId(payout.sellerId) }, { projection: { email: 1 } });
        const sellerEmail = normalizeEmail(sellerUser && sellerUser.email);
        if (sellerEmail) {
          await sendEventEmailSafe(
            sellerEmail,
            'Order received — invite your buyer to leave a review',
            `<p>An order tied to your listing was marked as received.</p><p>Now is a great time to encourage a buyer review to build trust in your store.</p>`,
            '/manage-reviews.html'
          );
        }
      } catch (mailErr) {
        console.error('Failed to send order received email to seller:', mailErr.message);
      }
    }
    res.json(updated);
  } catch (error) {
    console.error('Error updating payout:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/payouts/:id/send – send/retry payout for an existing payout row (auth required)
app.post('/api/payouts/:id/send', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });

  let objectId;
  try {
    objectId = new ObjectId(req.params.id);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid payout ID' });
  }

  try {
    const payout = await db.collection('payouts').findOne({ _id: objectId });
    if (!payout) return res.status(404).json({ error: 'Payout not found' });
    if (!req.isAdmin && String(payout.sellerId || '') !== String(req.userId || '')) {
      return res.status(403).json({ error: 'Forbidden: you do not own this payout' });
    }
    if (String(payout.status || '').toLowerCase() === 'paid') {
      return res.status(409).json({ error: 'Payout has already been sent' });
    }

    const orderId = String(payout.orderId || '').trim();
    if (!orderId) return res.status(400).json({ error: 'Payout order ID is missing' });
    const order = await db.collection('orders').findOne({ id: orderId });
    if (!order) return res.status(404).json({ error: 'Order not found for payout' });
    const seller = await db.collection('sellers').findOne(
      { userId: String(payout.sellerId || req.userId || '') },
      { projection: { payoutVerified: 1, payoutProviderBankStatus: 1 } }
    );
    const bankStatus = String(seller && seller.payoutProviderBankStatus ? seller.payoutProviderBankStatus : '').toLowerCase();
    if (!seller || !seller.payoutVerified || (bankStatus && bankStatus !== 'connected')) {
      return res.status(409).json({ error: 'Seller payout bank onboarding is incomplete or unverified' });
    }
    if (String(order.status || '').toLowerCase() !== 'completed') {
      return res.status(409).json({ error: 'Payouts can only be sent for completed orders' });
    }
    if (String(order.shippingStatus || '').toLowerCase() !== 'shipped') {
      return res.status(409).json({ error: 'Payouts become eligible after the seller marks the order as shipped' });
    }

    const payoutResult = await sendStripeSellerPayout(order, {
      triggerSource: req.isAdmin ? 'admin_manual' : 'api',
      sellerId: String(payout.sellerId || req.userId || '')
    });
    if (!payoutResult.ok) {
      return res.status(502).json({ error: payoutResult.error || 'Failed to send payout' });
    }
    if (payoutResult.deferred) {
      return res.status(409).json({ error: payoutResult.reason || 'Payout is currently not eligible' });
    }

    const updated = await db.collection('payouts').findOne({ _id: objectId });
    res.json({ success: true, payout: updated || null, processing: !!payoutResult.processing });
  } catch (error) {
    console.error('Error sending payout from payout row:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/paypal/webhook – verify and process PayPal asynchronous events
app.post('/api/paypal/webhook', publicApiRateLimit, async function(req, res) {
  const event = req.body;
  if (!event || typeof event !== 'object') {
    return res.status(400).json({ error: 'Invalid webhook payload' });
  }

  try {
    const webhookHeaders = getPayPalWebhookHeaders(req);
    if (!hasRequiredPayPalWebhookHeaders(webhookHeaders)) {
      return res.status(400).json({ error: 'Missing PayPal webhook signature headers' });
    }
    const verified = await verifyPayPalWebhookSignature(event, webhookHeaders);
    if (!verified) return res.status(400).json({ error: 'Invalid PayPal webhook signature' });

    const eventType = String(event && event.event_type ? event.event_type : '');
    const resource = event && event.resource ? event.resource : {};
    const now = new Date();

    if (eventType.startsWith('PAYMENT.PAYOUTS-ITEM.')) {
      const payoutIds = getPayPalPayoutWebhookIds(resource);
      const senderItemId = payoutIds.senderItemId;
      const batchId = payoutIds.batchId;

      const itemUpdate = {
        paypalLastWebhookEvent: {
          eventType: eventType,
          eventId: String(event && event.id ? event.id : ''),
          receivedAt: now,
          resource: resource
        },
        paypalTransactionStatus: String(resource && resource.transaction_status ? resource.transaction_status : '').toUpperCase() || null,
        updatedAt: now
      };
      const itemStatus = eventType.slice('PAYMENT.PAYOUTS-ITEM.'.length).toUpperCase();
      if (itemStatus === 'SUCCEEDED') {
        itemUpdate.status = 'paid';
        itemUpdate.paidAt = now;
        itemUpdate.error = null;
      } else if (itemStatus === 'PENDING') {
        itemUpdate.status = 'processing';
      } else {
        itemUpdate.status = 'failed';
        itemUpdate.error = String(
          resource && resource.errors && resource.errors.name
            ? resource.errors.name
            : ('Payout item failed with status: ' + itemStatus)
        );
      }

      const itemQuery = senderItemId
        ? { orderId: senderItemId }
        : (batchId ? { paypalPayoutBatchId: batchId } : null);
      if (itemQuery) {
        await db.collection('payouts').updateMany(itemQuery, { $set: itemUpdate });
        if (itemStatus === 'SUCCEEDED') {
          const paidRows = await db.collection('payouts').find({ ...itemQuery, status: 'paid' }).toArray();
          for (const payoutDoc of paidRows) {
            await notifyAdminPayoutPaidIfNeeded(payoutDoc, 'paypal_webhook_item');
          }
        }
      }
    } else if (eventType.startsWith('PAYMENT.PAYOUTSBATCH.')) {
      const batchId = String(resource && resource.payout_batch_id ? resource.payout_batch_id : '').trim();
      if (batchId) {
        const batchStatus = eventType.slice('PAYMENT.PAYOUTSBATCH.'.length).toUpperCase();
        const batchUpdate = {
          paypalLastWebhookEvent: {
            eventType: eventType,
            eventId: String(event && event.id ? event.id : ''),
            receivedAt: now,
            resource: resource
          },
          paypalBatchStatus: batchStatus,
          updatedAt: now
        };
        if (batchStatus === 'SUCCESS') {
          batchUpdate.status = 'paid';
          batchUpdate.paidAt = now;
          batchUpdate.error = null;
        } else if (batchStatus === 'PENDING' || batchStatus === 'PROCESSING') {
          batchUpdate.status = 'processing';
        } else {
          batchUpdate.status = 'failed';
          batchUpdate.error = `PayPal payout batch status: ${batchStatus}`;
        }
        await db.collection('payouts').updateMany({ paypalPayoutBatchId: batchId }, { $set: batchUpdate });
        if (batchStatus === 'SUCCESS') {
          const paidRows = await db.collection('payouts').find({ paypalPayoutBatchId: batchId, status: 'paid' }).toArray();
          for (const payoutDoc of paidRows) {
            await notifyAdminPayoutPaidIfNeeded(payoutDoc, 'paypal_webhook_batch');
          }
        }
      }
    }

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('PayPal webhook processing error:', error);
    res.status(400).json({ error: error.message });
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
    // Send reset link by email (or log to console in dev when SMTP is not configured)
    const baseUrl = process.env.BASE_URL || 'https://zorexium.io';
    const resetLink = `${baseUrl}/login-register.html?reset=${encodeURIComponent(resetToken)}`;
    try {
      await sendEventEmail(
        normalizedEmail,
        'Reset your Zorexium password',
        `<p>Hello,</p>
<p>Click the link below to reset your password. This link expires in 1 hour.</p>
<p><a href="${resetLink}">${resetLink}</a></p>
<p>If you did not request a password reset, you can ignore this email.</p>`,
        '/login-register.html?reset=' + encodeURIComponent(resetToken)
      );
    } catch (mailErr) {
      console.error('Failed to send password reset email:', mailErr.message);
    }
    res.json({ message: 'If that email is registered, a reset link will be sent.' });
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

// GET /api/reviews/mine – get current user's product reviews (auth required)
app.get('/api/reviews/mine', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const reviews = await db.collection('reviews')
      .find({ reviewerId: req.userId })
      .sort({ createdAt: -1 })
      .toArray();
    res.json(reviews);
  } catch (error) {
    console.error('Error fetching own reviews:', error);
    res.status(500).json({ error: error.message });
  }
});

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

// DELETE /api/reviews/:id – delete a product review (auth required)
app.delete('/api/reviews/:id', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  let objectId;
  try { objectId = new ObjectId(req.params.id); } catch (e) {
    return res.status(400).json({ error: 'Invalid review ID' });
  }
  try {
    const review = await db.collection('reviews').findOne({ _id: objectId });
    if (!review) return res.status(404).json({ error: 'Review not found' });
    if (review.reviewerId !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    await db.collection('reviews').deleteOne({ _id: objectId });
    res.json({ message: 'Review deleted' });
  } catch (error) {
    console.error('Error deleting review:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── SELLER REVIEWS ────────────────────────────────────────────────────────────

// GET /api/seller-reviews/mine – get current user's seller reviews (auth required)
app.get('/api/seller-reviews/mine', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const reviews = await db.collection('sellerReviews')
      .find({ reviewerId: req.userId })
      .sort({ createdAt: -1 })
      .toArray();
    res.json(reviews);
  } catch (error) {
    console.error('Error fetching own seller reviews:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/seller-reviews?sellerId=xxx – get reviews for a seller (public)
app.get('/api/seller-reviews', publicApiRateLimit, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  const { sellerId } = req.query;
  if (!sellerId) return res.status(400).json({ error: 'sellerId is required' });
  try {
    const reviews = await db.collection('sellerReviews')
      .find({ sellerId: String(sellerId) })
      .sort({ createdAt: -1 })
      .toArray();
    res.json(reviews);
  } catch (error) {
    console.error('Error fetching seller reviews:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/seller-reviews – submit a seller review (auth required)
app.post('/api/seller-reviews', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  const { sellerId, rating, title, body } = req.body;
  if (!sellerId || !rating || !body) {
    return res.status(400).json({ error: 'sellerId, rating, and body are required' });
  }
  const numRating = Number(rating);
  if (!Number.isInteger(numRating) || numRating < 1 || numRating > 5) {
    return res.status(400).json({ error: 'rating must be an integer between 1 and 5' });
  }
  if (typeof body !== 'string' || body.trim().length < 3 || body.length > 5000) {
    return res.status(400).json({ error: 'Review body must be between 3 and 5000 characters' });
  }
  // Prevent reviewing yourself
  if (String(sellerId) === req.userId) {
    return res.status(400).json({ error: 'You cannot review yourself' });
  }
  try {
    const existing = await db.collection('sellerReviews').findOne({ sellerId: String(sellerId), reviewerId: req.userId });
    if (existing) return res.status(409).json({ error: 'You have already reviewed this seller' });

    let sellerName = '';
    try {
      const seller = await db.collection('sellers').findOne({ userId: String(sellerId) });
      if (seller) sellerName = seller.shopName || '';
    } catch (_) {}

    let reviewerName = req.userEmail;
    try {
      const userDoc = await db.collection('users').findOne({ _id: new ObjectId(req.userId) });
      if (userDoc) {
        const fullName = ((userDoc.firstName || '') + ' ' + (userDoc.lastName || '')).trim();
        reviewerName = fullName || userDoc.email || req.userEmail;
      }
    } catch (_) {}

    const review = {
      sellerId: String(sellerId),
      sellerName,
      reviewerId: req.userId,
      reviewerEmail: req.userEmail,
      reviewerName,
      rating: numRating,
      title: title ? String(title).trim().slice(0, 200) : '',
      body: body.trim(),
      createdAt: new Date()
    };

    const result = await db.collection('sellerReviews').insertOne(review);

    // Update seller's review stats
    try {
      const allReviews = await db.collection('sellerReviews').find({ sellerId: String(sellerId) }).toArray();
      const avgRating = allReviews.reduce(function(sum, r) { return sum + r.rating; }, 0) / allReviews.length;
      await db.collection('sellers').updateOne(
        { userId: String(sellerId) },
        { $set: { sellerReviewRating: Math.round(avgRating * 10) / 10, sellerReviewCount: allReviews.length, updatedAt: new Date() } }
      );
    } catch (_) {}

    res.status(201).json({ ...review, _id: result.insertedId });
  } catch (error) {
    console.error('Error submitting seller review:', error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/seller-reviews/:id – delete a seller review (auth required)
app.delete('/api/seller-reviews/:id', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  let objectId;
  try { objectId = new ObjectId(req.params.id); } catch (e) {
    return res.status(400).json({ error: 'Invalid review ID' });
  }
  try {
    const review = await db.collection('sellerReviews').findOne({ _id: objectId });
    if (!review) return res.status(404).json({ error: 'Review not found' });
    if (review.reviewerId !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    await db.collection('sellerReviews').deleteOne({ _id: objectId });
    res.json({ message: 'Review deleted' });
  } catch (error) {
    console.error('Error deleting seller review:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── LIST ITEMS ────────────────────────────────────────────────────────────────

// POST /api/lists/:id/items – add an item to a list (auth required)
app.post('/api/lists/:id/items', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  let objectId;
  try { objectId = new ObjectId(req.params.id); } catch (e) {
    return res.status(400).json({ error: 'Invalid list ID' });
  }
  const { productId, productName, price, image } = req.body;
  if (!productId) return res.status(400).json({ error: 'productId is required' });
  try {
    const list = await db.collection('lists').findOne({ _id: objectId });
    if (!list) return res.status(404).json({ error: 'List not found' });
    if (list.userId !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    const items = list.items || [];
    if (items.some(function(i) { return i.productId === String(productId); })) {
      return res.status(409).json({ error: 'Item already in list' });
    }
    if (items.length >= 100) return res.status(400).json({ error: 'List item limit reached (100)' });
    const newItem = {
      itemId: crypto.randomUUID(),
      productId: String(productId).slice(0, 100),
      productName: productName ? String(productName).trim().slice(0, 200) : '',
      price: price != null ? parseFloat(price) || 0 : 0,
      image: image && /^https?:\/\//i.test(image) ? image.slice(0, 2000) : '',
      addedAt: new Date()
    };
    items.push(newItem);
    await db.collection('lists').updateOne({ _id: objectId }, { $set: { items, updatedAt: new Date() } });
    res.status(201).json(newItem);
  } catch (error) {
    console.error('Error adding item to list:', error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/lists/:id/items/:itemId – remove an item from a list (auth required)
app.delete('/api/lists/:id/items/:itemId', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  let objectId;
  try { objectId = new ObjectId(req.params.id); } catch (e) {
    return res.status(400).json({ error: 'Invalid list ID' });
  }
  try {
    const list = await db.collection('lists').findOne({ _id: objectId });
    if (!list) return res.status(404).json({ error: 'List not found' });
    if (list.userId !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    const items = (list.items || []).filter(function(i) { return i.itemId !== req.params.itemId; });
    await db.collection('lists').updateOne({ _id: objectId }, { $set: { items, updatedAt: new Date() } });
    res.json({ message: 'Item removed' });
  } catch (error) {
    console.error('Error removing item from list:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── FOLLOWS ───────────────────────────────────────────────────────────────────

// GET /api/follows – get follow info for current user (auth required)
app.get('/api/follows', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const followingCount = await db.collection('follows').countDocuments({ followerId: req.userId });
    const followersCount = await db.collection('follows').countDocuments({ followeeId: req.userId });
    res.json({ followingCount, followersCount });
  } catch (error) {
    console.error('Error fetching follows:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/follows/status/:userId – check if current user follows userId (auth required)
app.get('/api/follows/status/:userId', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  const targetUserId = req.params.userId;
  try {
    const doc = await db.collection('follows').findOne({ followerId: req.userId, followeeId: targetUserId });
    const followersCount = await db.collection('follows').countDocuments({ followeeId: targetUserId });
    res.json({ isFollowing: !!doc, followersCount });
  } catch (error) {
    console.error('Error checking follow status:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/follows/:userId – follow a user (auth required)
app.post('/api/follows/:userId', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  const targetUserId = req.params.userId;
  if (targetUserId === req.userId) return res.status(400).json({ error: 'You cannot follow yourself' });
  try {
    const existing = await db.collection('follows').findOne({ followerId: req.userId, followeeId: targetUserId });
    if (existing) return res.status(409).json({ error: 'Already following' });
    await db.collection('follows').insertOne({
      followerId: req.userId,
      followeeId: targetUserId,
      createdAt: new Date()
    });
    const followersCount = await db.collection('follows').countDocuments({ followeeId: targetUserId });
    res.status(201).json({ message: 'Following', followersCount });
  } catch (error) {
    console.error('Error following user:', error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/follows/:userId – unfollow a user (auth required)
app.delete('/api/follows/:userId', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  const targetUserId = req.params.userId;
  try {
    await db.collection('follows').deleteOne({ followerId: req.userId, followeeId: targetUserId });
    const followersCount = await db.collection('follows').countDocuments({ followeeId: targetUserId });
    res.json({ message: 'Unfollowed', followersCount });
  } catch (error) {
    console.error('Error unfollowing user:', error);
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

// ── EMAIL NOTIFICATION PREFERENCES ────────────────────────────────────────────
const VALID_EMAIL_NOTIFICATION_CATEGORIES = new Set([
  'order_confirmation',
  'shipping_updates',
  'return_refund_status',
  'price_drop_alerts',
  'weekly_deals_digest',
  'back_in_stock_alerts',
  'community_replies',
  'security_alerts',
  'newsletter',
  'login_notifications'
]);

app.get('/api/user/email-notifications', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const settings = await getUserEmailNotificationSettings(req.userId);
    res.json({ settings });
  } catch (error) {
    console.error('Error loading email notification settings:', error);
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/user/email-notifications/:category', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  const category = String(req.params.category || '').trim();
  if (!VALID_EMAIL_NOTIFICATION_CATEGORIES.has(category)) {
    return res.status(400).json({ error: 'Invalid notification category' });
  }
  const enabled = req.body && req.body.enabled === true;
  try {
    await db.collection('userEmailNotificationSettings').updateOne(
      { userId: req.userId },
      { $set: { userId: req.userId, [`settings.${category}`]: enabled, updatedAt: new Date() } },
      { upsert: true }
    );
    if (enabled) {
      const user = await db.collection('users').findOne({ _id: new ObjectId(req.userId) }, { projection: { email: 1 } });
      const to = normalizeEmail(user && user.email);
      if (to) {
        await sendEventEmailSafe(
          to,
          'Email alert enabled on your Zorexium account',
          `<p>You successfully enabled the <strong>${category.replace(/_/g, ' ')}</strong> email alert category.</p><p>We'll email you when matching events occur.</p>`,
          '/email-notifications.html'
        );
      }
      await sendAdminNotificationSafe(
        'User opted into email notifications',
        `<p>A user enabled an email notification category.</p>`
          + `<p><strong>User ID:</strong> ${escapeHtml(String(req.userId || 'N/A'))}</p>`
          + `<p><strong>User email:</strong> ${escapeHtml(String(to || 'N/A'))}</p>`
          + `<p><strong>Category:</strong> ${escapeHtml(category)}</p>`,
        '/email-notifications.html'
      );
    }
    res.json({ category, enabled });
  } catch (error) {
    console.error('Error saving email notification setting:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── SUPPORT / FEEDBACK SUBMISSIONS ────────────────────────────────────────────
app.post('/api/support', publicApiRateLimit, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  const category = String((req.body && req.body.category) || '').trim();
  const subject = String((req.body && req.body.subject) || '').trim().slice(0, 200);
  const description = String((req.body && req.body.description) || '').trim().slice(0, 5000);
  const priority = String((req.body && req.body.priority) || 'normal').trim().slice(0, 20);
  const email = normalizeEmail(req.body && req.body.email);
  if (!category || !subject || description.length < 10 || !email) {
    return res.status(400).json({ error: 'category, subject, description, and email are required' });
  }

  const authPayload = getOptionalAuthPayload(req);
  const now = new Date();
  const supportId = 'SUP-' + now.getTime().toString(36).toUpperCase() + '-' + crypto.randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
  const supportRecord = {
    supportId: supportId,
    userId: authPayload && authPayload.userId ? String(authPayload.userId) : null,
    email: email,
    category: category.slice(0, 100),
    subject: subject,
    description: description,
    priority: priority,
    source: String((req.body && req.body.source) || 'contact-support').slice(0, 100),
    status: 'completed',
    createdAt: now,
    updatedAt: now
  };
  await db.collection('supportSubmissions').insertOne(supportRecord);

  const supportPageLink = '/contact-support.html';
  await sendEventEmailSafe(
    ADMIN_NOTIFICATION_EMAIL,
    'New support request submitted',
    `<p><strong>Support ID:</strong> ${escapeHtml(supportId)}</p><p><strong>Category:</strong> ${escapeHtml(category)}</p><p><strong>Priority:</strong> ${escapeHtml(priority)}</p><p><strong>From:</strong> ${escapeHtml(email)}</p><p><strong>User ID:</strong> ${escapeHtml(String((authPayload && authPayload.userId) || 'Guest'))}</p><p><strong>Subject:</strong> ${escapeHtml(subject)}</p><p><strong>Description:</strong><br>${escapeHtml(description).replace(/\n/g, '<br>')}</p>`,
    supportPageLink
  );
  await sendEventEmailSafe(
    email,
    'We received your support request',
    `<p>Thanks for contacting Zorexium Support.</p><p>We received your request and will respond swiftly.</p><p><strong>Support ID:</strong> ${escapeHtml(supportId)}</p><p><strong>Subject:</strong> ${escapeHtml(subject)}</p>`,
    '/contact-support.html'
  );
  res.json({ message: 'Support request submitted successfully', supportId: supportId });
});

app.get('/api/support/my', publicApiRateLimit, verifyToken, async function(req, res) {
  if (!mongoConnected) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const user = await db.collection('users').findOne(
      { _id: new ObjectId(req.userId) },
      { projection: { email: 1 } }
    );
    const normalizedEmail = normalizeEmail(user && user.email);
    const query = normalizedEmail
      ? { $or: [{ userId: req.userId }, { email: normalizedEmail }] }
      : { userId: req.userId };
    const tickets = await db.collection('supportSubmissions')
      .find(query)
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();
    res.json(tickets.map(function(ticket) {
      return {
        supportId: String(ticket.supportId || ''),
        category: String(ticket.category || ''),
        subject: String(ticket.subject || ''),
        priority: String(ticket.priority || 'normal'),
        status: String(ticket.status || 'completed'),
        createdAt: ticket.createdAt || null
      };
    }));
  } catch (error) {
    console.error('Error fetching support submissions:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/feedback', publicApiRateLimit, async function(req, res) {
  const purpose = String((req.body && req.body.purpose) || '').trim().slice(0, 200);
  const comments = String((req.body && req.body.comments) || '').trim().slice(0, 5000);
  const email = normalizeEmail(req.body && req.body.email);
  const satisfaction = String((req.body && req.body.satisfaction) || '').trim().slice(0, 50);
  const includeScreenshot = !!(req.body && req.body.includeScreenshot);
  if (!purpose || !comments || !email) {
    return res.status(400).json({ error: 'purpose, comments, and email are required' });
  }

  await sendEventEmailSafe(
    ADMIN_NOTIFICATION_EMAIL,
    'New feedback submission',
    `<p><strong>Purpose:</strong> ${escapeHtml(purpose)}</p><p><strong>From:</strong> ${escapeHtml(email)}</p><p><strong>Satisfaction:</strong> ${escapeHtml(satisfaction || 'Not selected')}</p><p><strong>Include screenshot:</strong> ${includeScreenshot ? 'Yes' : 'No'}</p><p><strong>Comments:</strong><br>${escapeHtml(comments).replace(/\n/g, '<br>')}</p>`,
    '/feedback.html'
  );
  await sendEventEmailSafe(
    email,
    'We received your feedback',
    '<p>Thanks for sharing your feedback with Zorexium.</p><p>Our team has received it and will follow up swiftly when needed.</p>',
    '/feedback.html'
  );
  res.json({ message: 'Feedback submitted successfully' });
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
    if (isCommunityOrInnovationBoardType(post.boardType)) {
      await sendAdminNotificationSafe(
        'New community/innovation reply',
        `<p>A nested reply was posted.</p>`
          + `<p><strong>Board:</strong> ${escapeHtml(String(post.boardType || 'general'))}</p>`
          + `<p><strong>Post title:</strong> ${escapeHtml(String(post.title || 'Untitled'))}</p>`
          + `<p><strong>Reply author:</strong> ${escapeHtml(String(username || req.userEmail || 'Unknown'))}</p>`
          + `<p><strong>Reply author email:</strong> ${escapeHtml(String(req.userEmail || 'N/A'))}</p>`
          + `<p><strong>Reply preview:</strong> ${escapeHtml(String(content).slice(0, 240))}</p>`,
        getPostBoardLinkPath(post.boardType)
      );
    }
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
  const { productId, productName, productUrl, targetPrice } = req.body;
  const normalizedProductId = productId ? String(productId).trim().slice(0, 100) : '';
  const normalizedProductName = String(productName || productUrl || '').trim().slice(0, 200);
  if (!normalizedProductName || !targetPrice) {
    return res.status(400).json({ error: 'productName (or productUrl) and targetPrice are required' });
  }
  const parsed = parseFloat(targetPrice);
  if (isNaN(parsed) || parsed <= 0) return res.status(400).json({ error: 'targetPrice must be a positive number' });
  let currentPrice = null;
  if (normalizedProductId && ObjectId.isValid(normalizedProductId)) {
    try {
      const product = await db.collection('products').findOne({ _id: new ObjectId(normalizedProductId) }, { projection: { price: 1, salePrice: 1 } });
      const effective = getEffectiveListingPrice(product);
      if (Number.isFinite(effective)) currentPrice = effective;
    } catch (_) {}
  }
  const alert = {
    id: require('crypto').randomUUID(),
    productId: normalizedProductId,
    productName: normalizedProductName,
    productUrl: String(productUrl || '').trim().slice(0, 500),
    targetPrice: parsed,
    currentPrice: Number.isFinite(currentPrice) ? currentPrice : null,
    createdAt: new Date(),
    triggered: false
  };
  try {
    const doc = await db.collection('userPriceAlerts').findOne({ userId: req.userId });
    const alerts = (doc && doc.alerts) || [];
    if (alerts.length >= 50) return res.status(400).json({ error: 'Price alert limit reached (50)' });
    if (normalizedProductId && alerts.some(function(existing) { return String(existing.productId || '') === normalizedProductId; })) {
      return res.status(409).json({ error: 'You already have a price alert for this product' });
    }
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

// POST /api/listing-reports – submit a product listing report (public)
app.post('/api/listing-reports', publicApiRateLimit, async function(req, res) {
  const {
    productId,
    productName,
    reporterName,
    reporterEmail,
    reason,
    details
  } = req.body || {};
  const safeProductId = String(productId || '').trim().slice(0, 100);
  const safeProductName = String(productName || '').trim().slice(0, 200);
  const safeReporterName = String(reporterName || '').trim().slice(0, 120);
  const safeReporterEmail = normalizeEmail(reporterEmail || '');
  const safeReason = String(reason || '').trim().slice(0, 120);
  const safeDetails = String(details || '').trim().slice(0, 3000);
  if (!safeProductId || !safeProductName) {
    return res.status(400).json({ error: 'productId and productName are required' });
  }
  if (!safeReporterEmail || !isLikelyEmail(safeReporterEmail)) {
    return res.status(400).json({ error: 'A valid reporter email is required' });
  }
  if (!safeReason || !safeDetails) {
    return res.status(400).json({ error: 'reason and details are required' });
  }
  try {
    await sendEventEmailSafe(
      ADMIN_NOTIFICATION_EMAIL,
      'Product listing report submitted',
      '<p>A user submitted a listing report.</p>'
        + '<p><strong>Product:</strong> ' + escapeHtml(safeProductName) + '<br>'
        + '<strong>Product ID:</strong> ' + escapeHtml(safeProductId) + '<br>'
        + '<strong>Reason:</strong> ' + escapeHtml(safeReason) + '</p>'
        + '<p><strong>Reporter:</strong> ' + escapeHtml(safeReporterName || 'Not provided') + '<br>'
        + '<strong>Email:</strong> ' + escapeHtml(safeReporterEmail) + '</p>'
        + '<p><strong>Details:</strong><br>' + escapeHtml(safeDetails).replace(/\n/g, '<br>') + '</p>',
      '/product-detail.html?id=' + encodeURIComponent(safeProductId)
    );
    res.status(201).json({ message: 'Report submitted' });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to submit report' });
  }
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
        tier: 'starter',
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
async function assignStarterTierToExistingSellers() {
  if (!mongoConnected) return;
  try {
    const result = await db.collection('sellers').updateMany(
      { tier: { $exists: false } },
      { $set: { tier: 'starter', updatedAt: new Date() } }
    );
    if (result.modifiedCount > 0) {
      console.log(`✅ Seller tier migration: ${result.modifiedCount} seller(s) assigned to starter tier`);
    }
  } catch (err) {
    console.error('⚠️  Seller tier migration error:', err.message);
  }
}

async function downgradeProSellersToStarter() {
  if (!mongoConnected) return;
  try {
    const result = await db.collection('sellers').updateMany(
      { tier: 'pro' },
      { $set: { tier: 'starter', updatedAt: new Date(), proTierDowngraded: true, proTierDowngradedAt: new Date() } }
    );
    if (result.modifiedCount > 0) {
      console.log(`✅ Pro Seller downgrade migration: ${result.modifiedCount} seller(s) downgraded from pro to starter`);
    }
  } catch (err) {
    console.error('⚠️  Pro Seller downgrade migration error:', err.message);
  }
}

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

async function ensureOperationalIndexes() {
  if (!mongoConnected) return;
  try {
    await db.collection('payouts').createIndex(
      { orderId: 1, sellerId: 1 },
      { name: 'orderId_sellerId_idx' }
    );
  } catch (err) {
    console.error('⚠️  Failed to ensure operational indexes:', err.message);
  }
}

// ── SendGrid test route ───────────────────────────────────────────────────────
// POST /api/send-test-email  { "email": "recipient@example.com" }
// Use this route to verify your SendGrid integration is working on Render.
app.post('/api/send-test-email', publicApiRateLimit, async function(req, res) {
  const { email } = req.body || {};
  // Use a simple linear check instead of a backtracking regex to avoid ReDoS.
  const atIdx = typeof email === 'string' ? email.indexOf('@') : -1;
  const domainPart = atIdx > 0 ? email.slice(atIdx + 1) : '';
  const dotIdx = domainPart.lastIndexOf('.');
  if (!email || atIdx < 1 || !domainPart || dotIdx < 1 || dotIdx === domainPart.length - 1 || email.length > 254) {
    return res.status(400).json({ error: 'A valid recipient email address is required.' });
  }
  const result = await sendEmail({
    to: email,
    subject: 'Hello from Zorexium!',
    text: 'This is a test email sent via SendGrid from your Zorexium backend.',
    html: '<p>This is a <strong>test email</strong> sent via SendGrid from your Zorexium backend.</p>',
  });
  if (result.success) {
    return res.json({ message: 'Email sent successfully!' });
  }
  return res.status(500).json({ error: 'Failed to send email.', detail: result.error });
});

// ── Twilio test route ──────────────────────────────────────────────────────────
// POST /api/test-sms  { "phone": "+15555555555" }
// This route validates E.164 format and sends a test text through the shared sendSMS utility.
app.post('/api/test-sms', publicApiRateLimit, async function(req, res) {
  const phone = normalizePhoneE164(req.body && req.body.phone);
  if (!phone) {
    return res.status(400).json({ error: 'A valid phone number in E.164 format is required (example: +15555555555).' });
  }

  const result = await sendSMS({
    to: phone,
    body: TEST_SMS_MESSAGE_TEMPLATE.replace('{{url}}', makeAbsoluteUrl('/email-notifications.html')),
  });
  if (result.success) {
    return res.json({ success: true, message: 'SMS sent successfully.' });
  }
  return res.status(500).json({ success: false, error: 'Failed to send SMS.', detail: result.error });
});

async function start() {
  console.log('🚀 Starting server...');
  try {
    const connected = await connectDB();
    if (connected) {
      console.log('✅ Database connected — starting HTTP server');
      await recoverMissingSellers();
      await assignStarterTierToExistingSellers();
      await downgradeProSellersToStarter();
      await ensureOperationalIndexes();
      await runRetroactiveLegacyOrderRepairMigration();
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
