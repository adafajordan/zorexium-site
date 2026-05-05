// Simple notification/modal utility for Zorexium
(function(){
  const BACKEND_URL = 'https://zorexium-backend.onrender.com';
  const container = document.createElement('div');
  container.id = 'zrx-notifications';
  container.style.position = 'fixed';
  container.style.right = '16px';
  container.style.bottom = '16px';
  container.style.zIndex = '9999';
  document.addEventListener('DOMContentLoaded', ()=> document.body.appendChild(container));

  function showNotification(message, type='info', timeout=3500) {
    const el = document.createElement('div');
    el.className = 'zrx-notification zrx-' + type;
    el.style.marginTop = '8px';
    el.style.background = type==='error' ? '#7f1d1d' : type==='success' ? '#064e3b' : '#111827';
    el.style.color = '#fff';
    el.style.padding = '10px 14px';
    el.style.borderRadius = '8px';
    el.style.boxShadow = '0 6px 18px rgba(0,0,0,0.4)';
    el.style.fontSize = '14px';
    el.textContent = message;
    container.appendChild(el);
    setTimeout(()=>{ el.style.opacity = '0'; setTimeout(()=>el.remove(),300); }, timeout);
  }

  function makeModal(htmlContent, onClose) {
    const overlay = document.createElement('div');
    overlay.style.position = 'fixed';
    overlay.style.left = '0'; overlay.style.top = '0'; overlay.style.right='0'; overlay.style.bottom='0';
    overlay.style.background = 'rgba(0,0,0,0.6)'; overlay.style.zIndex='10000';
    overlay.style.display='flex'; overlay.style.alignItems='center'; overlay.style.justifyContent='center';
    const box = document.createElement('div');
    box.style.background='#0b1220'; box.style.color='#e6eef6'; box.style.padding='20px'; box.style.borderRadius='12px'; box.style.minWidth='320px'; box.innerHTML = htmlContent;
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    return { overlay, box, close: ()=>{ overlay.remove(); onClose && onClose(); } };
  }

  function showConfirm(message, yesCb, noCb) {
    const { overlay, box, close } = makeModal(`
      <h3 style="margin:0 0 10px">Confirm</h3>
      <p style="margin:0 0 16px">${message}</p>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button id="zrx-no" style="padding:8px 12px;border-radius:6px">No</button>
        <button id="zrx-yes" style="padding:8px 12px;border-radius:6px;background:#10b981;color:#fff">Yes</button>
      </div>`);
    box.querySelector('#zrx-yes').addEventListener('click', ()=>{ close(); yesCb && yesCb(); });
    box.querySelector('#zrx-no').addEventListener('click', ()=>{ close(); noCb && noCb(); });
  }

  function showPrompt(title, fields, submitCb, cancelCb) {
    let inputsHtml = fields.map(f=>{
      return `<div style="margin-bottom:10px"><label style="display:block;margin-bottom:6px">${f.label}</label><input id="zrx-${f.id}" type="${f.type||'text'}" placeholder="${f.placeholder||''}" style="width:100%;padding:8px;border-radius:6px;border:1px solid #223"/></div>`;
    }).join('');
    const { overlay, box, close } = makeModal(`
      <h3 style="margin:0 0 10px">${title}</h3>
      <div>${inputsHtml}</div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button id="zrx-cancel" style="padding:8px 12px;border-radius:6px">Cancel</button>
        <button id="zrx-submit" style="padding:8px 12px;border-radius:6px;background:#06b6d4;color:#08273b">Submit</button>
      </div>`);
    box.querySelector('#zrx-submit').addEventListener('click', ()=>{
      const values = {};
      fields.forEach(f=> values[f.id] = box.querySelector('#zrx-'+f.id).value);
      close(); submitCb && submitCb(values);
    });
    box.querySelector('#zrx-cancel').addEventListener('click', ()=>{ close(); cancelCb && cancelCb(); });
  }

  // ── In-website notification bell ─────────────────────────────────────────────
  var notifPanelOpen = false;
  var notifData = [];
  var notifBadgeEl = null;
  var notifPanelEl = null;
  var notifBellWrapper = null;

  function getAuthToken() {
    return localStorage.getItem('authToken') || null;
  }

  function escHtml(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function timeAgo(dateStr) {
    var diff = Date.now() - new Date(dateStr).getTime();
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.floor(hrs / 24) + 'd ago';
  }

  function buildNotifPanel() {
    var unread = notifData.filter(function(n) { return !n.read; });
    var items = notifData.map(function(n) {
      var link = '';
      if (n.type === 'new_message') link = '<a href="messages.html" style="font-size:11px;color:#0891b2;white-space:nowrap;align-self:center;flex-shrink:0;">View</a>';
      else if (n.type === 'new_review' && n.productId) link = '<a href="product-detail.html?id=' + escHtml(n.productId) + '" style="font-size:11px;color:#0891b2;white-space:nowrap;align-self:center;flex-shrink:0;">View</a>';
      return '<div style="padding:10px 16px;border-bottom:1px solid #f3f4f6;background:' + (n.read ? '#fff' : '#ecfeff') + ';display:flex;gap:10px;align-items:flex-start;cursor:pointer;" data-notif-id="' + escHtml(String(n._id)) + '">'
        + '<div style="width:8px;height:8px;border-radius:50%;background:' + (n.read ? 'transparent' : '#06b6d4') + ';flex-shrink:0;margin-top:6px;"></div>'
        + '<div style="flex:1;min-width:0;">'
        + '<div style="font-weight:600;font-size:13px;color:#111827;margin-bottom:2px;">' + escHtml(n.title) + '</div>'
        + '<div style="font-size:12px;color:#6b7280;line-height:1.4;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;">' + escHtml(n.body) + '</div>'
        + '<div style="font-size:11px;color:#9ca3af;margin-top:3px;">' + timeAgo(n.createdAt) + '</div>'
        + '</div>' + link + '</div>';
    }).join('');
    return '<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #e5e7eb;">'
      + '<span style="font-weight:700;font-size:15px;color:#111827;">Notifications</span>'
      + (unread.length > 0 ? '<button id="zrx-notif-read-all" style="font-size:12px;color:#0891b2;background:none;border:none;cursor:pointer;padding:0;">Mark all read</button>' : '')
      + '</div>'
      + '<div style="max-height:340px;overflow-y:auto;">'
      + (notifData.length === 0 ? '<div style="padding:24px 16px;text-align:center;color:#9ca3af;font-size:13px;">No notifications yet</div>' : items)
      + '</div>'
      + '<div style="padding:10px 16px;border-top:1px solid #e5e7eb;text-align:center;">'
      + '<a href="messages.html" style="font-size:13px;color:#0891b2;text-decoration:none;">Go to Messages</a>'
      + '</div>';
  }

  function renderNotifPanel() {
    if (!notifPanelEl) return;
    notifPanelEl.innerHTML = buildNotifPanel();
    var readAllBtn = notifPanelEl.querySelector('#zrx-notif-read-all');
    if (readAllBtn) {
      readAllBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        var token = getAuthToken();
        if (!token) return;
        fetch(BACKEND_URL + '/api/notifications/read-all', {
          method: 'PUT', headers: { 'Authorization': 'Bearer ' + token }
        }).then(function() {
          notifData.forEach(function(n) { n.read = true; });
          renderNotifPanel(); updateBadge();
        }).catch(function() {});
      });
    }
    notifPanelEl.querySelectorAll('[data-notif-id]').forEach(function(el) {
      el.addEventListener('click', function(e) {
        if (e.target.tagName === 'A') return;
        var id = el.getAttribute('data-notif-id');
        var notif = notifData.find(function(n) { return String(n._id) === id; });
        if (notif && !notif.read) {
          var token = getAuthToken();
          if (token) {
            fetch(BACKEND_URL + '/api/notifications/' + id + '/read', {
              method: 'PUT', headers: { 'Authorization': 'Bearer ' + token }
            }).catch(function() {});
          }
          notif.read = true;
          renderNotifPanel(); updateBadge();
        }
      });
    });
  }

  function updateBadge() {
    if (!notifBadgeEl) return;
    var unreadCount = notifData.filter(function(n) { return !n.read; }).length;
    notifBadgeEl.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
    notifBadgeEl.style.display = unreadCount > 0 ? 'flex' : 'none';
  }

  function fetchNotifications() {
    var token = getAuthToken();
    if (!token) return;
    fetch(BACKEND_URL + '/api/notifications', {
      headers: { 'Authorization': 'Bearer ' + token }
    }).then(function(res) {
      if (res.ok) return res.json();
    }).then(function(data) {
      if (data) {
        notifData = data;
        updateBadge();
        if (notifPanelOpen) renderNotifPanel();
      }
    }).catch(function() {});
  }

  function injectNotificationBell() {
    if (document.getElementById('zrx-notif-bell')) return;
    var cartLink = document.getElementById('headerCartLink');
    if (!cartLink) return;

    var bellWrapper = document.createElement('div');
    bellWrapper.id = 'zrx-notif-bell';
    bellWrapper.style.cssText = 'position:relative;display:inline-flex;align-items:center;';

    var bellBtn = document.createElement('button');
    bellBtn.setAttribute('aria-label', 'Notifications');
    bellBtn.style.cssText = 'background:none;border:none;cursor:pointer;padding:8px 10px;color:#374151;display:flex;align-items:center;position:relative;';
    bellBtn.innerHTML = '<i class="fas fa-bell" style="font-size:22px;"></i>';

    var badge = document.createElement('span');
    badge.style.cssText = 'position:absolute;top:2px;right:4px;background:#ef4444;color:#fff;font-size:10px;border-radius:9999px;min-width:17px;height:17px;display:none;align-items:center;justify-content:center;font-weight:700;padding:0 3px;line-height:1;';
    badge.textContent = '0';
    notifBadgeEl = badge;
    bellBtn.appendChild(badge);

    var panel = document.createElement('div');
    panel.style.cssText = 'position:absolute;right:0;top:calc(100% + 4px);width:320px;background:#fff;border:1px solid #e5e7eb;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,0.12);z-index:10001;display:none;';
    notifPanelEl = panel;

    bellWrapper.appendChild(bellBtn);
    bellWrapper.appendChild(panel);
    notifBellWrapper = bellWrapper;

    cartLink.parentNode.insertBefore(bellWrapper, cartLink);

    bellBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      notifPanelOpen = !notifPanelOpen;
      panel.style.display = notifPanelOpen ? 'block' : 'none';
      if (notifPanelOpen) { renderNotifPanel(); fetchNotifications(); }
    });

    document.addEventListener('click', function(e) {
      if (notifBellWrapper && !notifBellWrapper.contains(e.target)) {
        notifPanelOpen = false;
        panel.style.display = 'none';
      }
    });
  }

  document.addEventListener('DOMContentLoaded', function() {
    injectNotificationBell();
    fetchNotifications();
    setInterval(fetchNotifications, 60000);
  });

  window.ZrxNotify = { showNotification, showConfirm, showPrompt };
})();
