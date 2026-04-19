/**
 * ZrxSession – client-side session utility
 *
 * Authentication strategy (cross-domain compatible):
 * 1. After login, the JWT is stored in sessionStorage ('authToken') and user
 *    info in sessionStorage ('_zrx_user').  This works cross-domain.
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

  /** Returns the stored JWT token (sessionStorage first, then cookie fallback). */
  function getToken() {
    try {
      var t = sessionStorage.getItem('authToken');
      if (t) return t;
    } catch (e) {}
    return getCookie('authToken');
  }

  /** Returns the current user object {email, username} or null if not logged in. */
  function getUser() {
    // Check sessionStorage first (cross-domain JWT flow)
    try {
      var raw = sessionStorage.getItem('_zrx_user');
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
    // Check sessionStorage token first (cross-domain)
    try {
      if (sessionStorage.getItem('authToken')) return true;
    } catch (e) {}
    // Fall back to cookie-based check
    return getUser() !== null;
  }

  /**
   * Performs an authenticated fetch. Adds credentials:'include' and an
   * Authorization: Bearer header (from sessionStorage) so auth works
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
   * clears sessionStorage auth data, then invokes the optional callback.
   * @param {function} [callback]
   */
  function logout(callback) {
    try {
      sessionStorage.removeItem('authToken');
      sessionStorage.removeItem('_zrx_user');
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
}());
