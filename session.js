/**
 * ZrxSession – client-side session utility
 *
 * Authentication strategy (cross-domain compatible):
 * 1. After login, the JWT is stored in localStorage ('authToken') and user
 *    info in localStorage ('_zrx_user').  This persists across page navigations
 *    and browser sessions until explicitly cleared.
 * 2. authFetch() automatically adds an Authorization: Bearer header so the
 *    backend verifyToken middleware accepts the request regardless of cookies.
 * 3. Cookie-based auth is kept as a fallback for backward compatibility.
 */
(function () {
  'use strict';

  var BACKEND_URL = 'https://zorexium-backend.onrender.com';

  function getCookie(name) {
    var match = document.cookie.match(new RegExp('(?:^|;)\\s*' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=\\s*([^;]*)'));
    if (!match) return null;
    try { return decodeURIComponent(match[1]); } catch (e) { return match[1]; }
  }

  function setCookie(name, value, maxAge) {
    var cookie = name + '=' + encodeURIComponent(value) + '; Path=/; SameSite=Lax';
    if (maxAge !== undefined) cookie += '; Max-Age=' + maxAge;
    if (location.protocol === 'https:') cookie += '; Secure';
    document.cookie = cookie;
  }

  function deleteCookie(name) {
    var cookie = name + '=; Path=/; Max-Age=0; SameSite=Lax';
    if (location.protocol === 'https:') cookie += '; Secure';
    document.cookie = cookie;
  }

  /** Returns the stored JWT token (localStorage first, then cookie fallback). */
  function getToken() {
    try {
      var t = localStorage.getItem('authToken');
      if (t) return t;
    } catch (e) {}
    return getCookie('authToken');
  }

  /** Returns the current user object {email, username} or null if not logged in. */
  function getUser() {
    // Check localStorage first (for JWT-based auth flow)
    try {
      var raw = localStorage.getItem('_zrx_user');
      if (raw) {
        try { return JSON.parse(raw); } catch (e) {}
      }
    } catch (e) {}
    // Fall back to cookie (same-domain flow)
    var cookieRaw = getCookie('_zrx_user');
    if (!cookieRaw) return null;
    try { return JSON.parse(cookieRaw); } catch (e) { return null; }
  }

  /** Returns true if the user appears to be logged in. */
  function isLoggedIn() {
    // Check localStorage token first (for JWT-based auth)
    try {
      if (localStorage.getItem('authToken')) return true;
    } catch (e) {}
    // Fall back to cookie-based check
    return getUser() !== null;
  }

  function hideGuestHeaderDropdownArrows() {
    if (isLoggedIn()) return;
    ['marketplaceDropdown', 'communityHubDropdown'].forEach(function (id) {
      var dropdown = document.getElementById(id);
      if (!dropdown) return;
      var toggleBtn = dropdown.querySelector('button[onclick*="toggleDropdown"]');
      if (!toggleBtn) return;
      toggleBtn.style.display = 'none';
      toggleBtn.setAttribute('aria-hidden', 'true');
      toggleBtn.setAttribute('tabindex', '-1');
    });
  }

  /**
   * Performs an authenticated fetch. Adds credentials:'include' and an
   * Authorization: Bearer header (from localStorage) so auth works
   * cross-domain when cookies are not available.
   * @param {string} url
   * @param {RequestInit} [options]
   */
  function authFetch(url, options) {
    options = Object.assign({}, options);
    options.credentials = 'include';
    var token = getToken();
    if (token) {
      options.headers = Object.assign({}, options.headers, {
        'Authorization': 'Bearer ' + token
      });
    }
    return fetch(url, options);
  }

  /**
   * Logs the user out by calling the server logout endpoint (clears HTTP-only cookie),
   * clears localStorage auth data, then invokes the optional callback.
   * @param {function} [callback]
   */
  function logout(callback) {
    try {
      localStorage.removeItem('authToken');
      localStorage.removeItem('_zrx_user');
    } catch (e) {}
    fetch(BACKEND_URL + '/api/auth/logout', { method: 'POST', credentials: 'include' })
      .catch(function () {})
      .finally(function () {
        if (typeof callback === 'function') callback();
      });
  }

  window.ZrxSession = {
    getUser: getUser,
    isLoggedIn: isLoggedIn,
    fetch: authFetch,
    logout: logout,
    getToken: getToken,
    getCookie: getCookie,
    setCookie: setCookie,
    deleteCookie: deleteCookie,
    BACKEND_URL: BACKEND_URL
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', hideGuestHeaderDropdownArrows);
  } else {
    hideGuestHeaderDropdownArrows();
  }
}());
