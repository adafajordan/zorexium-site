(function(){
  if (localStorage.getItem('cookieConsent')) return;

  const banner = document.createElement('div');
  banner.id = 'cookieConsentBanner';
  banner.style.position = 'fixed';
  banner.style.left = '0';
  banner.style.right = '0';
  banner.style.bottom = '18px';
  banner.style.zIndex = '9999';
  banner.style.display = 'flex';
  banner.style.justifyContent = 'center';
  banner.innerHTML = `
    <div style="max-width:980px;background:#0f172a;border:1px solid rgba(66,153,225,0.06);padding:14px 18px;border-radius:8px;display:flex;gap:12px;align-items:center;box-shadow:0 8px 30px rgba(2,6,23,0.6);">
      <div style="flex:1;color:#e2e8f0;font-family:Inter,Segoe UI,Arial;font-size:14px;">We use cookies to improve your experience. Accept or Reject cookies — your choice will be remembered.</div>
      <div style="display:flex;gap:8px">
        <button id="cookieAccept" style="background:#65a30d;color:#fff;padding:8px 12px;border-radius:6px;border:none;font-weight:600;">Accept</button>
        <button id="cookieReject" style="background:transparent;color:#cbd5e1;padding:8px 12px;border-radius:6px;border:1px solid rgba(203,213,225,0.06);">Reject</button>
      </div>
    </div>
  `;

  document.addEventListener('DOMContentLoaded', function(){
    document.body.appendChild(banner);
    document.getElementById('cookieAccept').addEventListener('click', function(){
      localStorage.setItem('cookieConsent','accepted');
      banner.remove();
    });
    document.getElementById('cookieReject').addEventListener('click', function(){
      localStorage.setItem('cookieConsent','rejected');
      banner.remove();
    });
  });
})();
