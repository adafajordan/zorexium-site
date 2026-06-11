(function(global) {
  var STORAGE_KEY = 'zrxAffiliateAttributionByProduct';
  var VISITOR_KEY = 'zrxAffiliateVisitorId';
  var ATTRIBUTION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
  var TRACKING_REFRESH_MS = 12 * 60 * 60 * 1000;

  function safeParse(value) {
    try {
      return JSON.parse(value);
    } catch (_) {
      return {};
    }
  }

  function normalizeId(value, maxLength) {
    var normalized = String(value || '').trim();
    if (!normalized) return '';
    return normalized.slice(0, maxLength || 128);
  }

  function getVisitorId() {
    try {
      var existing = normalizeId(localStorage.getItem(VISITOR_KEY), 128);
      if (existing) return existing;
      var created = 'affv_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem(VISITOR_KEY, created);
      return created;
    } catch (_) {
      return 'affv_guest';
    }
  }

  function readMap() {
    try {
      var parsed = safeParse(localStorage.getItem(STORAGE_KEY) || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function writeMap(map) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(map || {}));
    } catch (_) {}
  }

  function pruneExpired(map) {
    var nextMap = map || {};
    var now = Date.now();
    Object.keys(nextMap).forEach(function(productId) {
      var entry = nextMap[productId];
      var capturedAt = entry && entry.capturedAt ? new Date(entry.capturedAt).getTime() : 0;
      if (!capturedAt || (now - capturedAt) > ATTRIBUTION_MAX_AGE_MS) {
        delete nextMap[productId];
      }
    });
    return nextMap;
  }

  function getProductAttribution(productId) {
    var normalizedProductId = normalizeId(productId, 128);
    if (!normalizedProductId) return null;
    var map = pruneExpired(readMap());
    writeMap(map);
    return map[normalizedProductId] || null;
  }

  function setProductAttribution(entry) {
    var productId = normalizeId(entry && entry.productId, 128);
    var sellerId = normalizeId(entry && entry.sellerId, 128);
    if (!productId || !sellerId) return null;
    var map = pruneExpired(readMap());
    var stored = {
      productId: productId,
      sellerId: sellerId,
      clickId: normalizeId(entry && entry.clickId, 128),
      visitorId: normalizeId(entry && entry.visitorId, 128) || getVisitorId(),
      source: normalizeId(entry && entry.source, 64) || 'seller_product_link',
      capturedAt: entry && entry.capturedAt ? entry.capturedAt : new Date().toISOString(),
      lastTrackedAt: entry && entry.lastTrackedAt ? entry.lastTrackedAt : new Date().toISOString()
    };
    map[productId] = stored;
    writeMap(map);
    return stored;
  }

  function buildAffiliateFieldsForItem(item) {
    var productId = normalizeId(item && (item.id || item.productId), 128);
    if (!productId) return {};
    var attribution = getProductAttribution(productId);
    if (!attribution) return {};
    return {
      affiliateSellerId: attribution.sellerId,
      affiliateProductId: attribution.productId,
      affiliateVisitorId: attribution.visitorId || getVisitorId(),
      affiliateClickId: attribution.clickId || '',
      affiliateSource: attribution.source || 'seller_product_link'
    };
  }

  function enrichItems(items) {
    return (Array.isArray(items) ? items : []).map(function(item) {
      return Object.assign({}, item, buildAffiliateFieldsForItem(item));
    });
  }

  function captureVisit(options) {
    var opts = options || {};
    var productId = normalizeId(opts.productId, 128);
    var sellerId = normalizeId(opts.sellerId, 128);
    var backendUrl = String(opts.backendUrl || '').trim();
    if (!productId || !sellerId || !backendUrl) {
      return Promise.resolve(null);
    }
    var existing = getProductAttribution(productId);
    var now = Date.now();
    if (existing && existing.sellerId === sellerId) {
      var lastTrackedAt = existing.lastTrackedAt ? new Date(existing.lastTrackedAt).getTime() : 0;
      if (lastTrackedAt && (now - lastTrackedAt) < TRACKING_REFRESH_MS) {
        return Promise.resolve(existing);
      }
    }
    var visitorId = getVisitorId();
    return fetch(backendUrl + '/api/affiliates/visit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productId: productId,
        sellerId: sellerId,
        visitorId: visitorId
      })
    }).then(function(response) {
      return response.json().catch(function() { return {}; }).then(function(body) {
        if (!response.ok) {
          throw new Error(body && body.error ? body.error : 'Failed to track affiliate visit');
        }
        return body || {};
      });
    }).then(function(body) {
      return setProductAttribution({
        productId: productId,
        sellerId: sellerId,
        clickId: body.clickId || '',
        visitorId: visitorId,
        source: 'seller_product_link',
        capturedAt: new Date().toISOString(),
        lastTrackedAt: new Date().toISOString()
      });
    }).catch(function() {
      return setProductAttribution({
        productId: productId,
        sellerId: sellerId,
        clickId: existing && existing.clickId ? existing.clickId : '',
        visitorId: visitorId,
        source: 'seller_product_link',
        capturedAt: existing && existing.capturedAt ? existing.capturedAt : new Date().toISOString(),
        lastTrackedAt: new Date().toISOString()
      });
    });
  }

  global.ZrxAffiliate = {
    getVisitorId: getVisitorId,
    getProductAttribution: getProductAttribution,
    buildAffiliateFieldsForItem: buildAffiliateFieldsForItem,
    enrichItems: enrichItems,
    captureVisit: captureVisit
  };
})(window);
