/**
 * ZrxSession – client-side session utility
 * Replaces all direct localStorage token usage with secure cookie-based auth.
 *
 * The authToken JWT lives in an HTTP-only cookie (server-set, not readable by JS).
 * A companion _zrx_user cookie (non-httpOnly) holds {email, username} for display.
 * All authenticated API requests use credentials:'include' so the HTTP-only
 * authToken cookie is forwarded automatically by the browser.
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
    var cookie = name + '=' + encodeURIComponent(value) + '; Path=/; SameSite=Strict';
    if (maxAge !== undefined) cookie += '; Max-Age=' + maxAge;
    document.cookie = cookie;
  }

  function deleteCookie(name) {
    document.cookie = name + '=; Path=/; Max-Age=0; SameSite=Strict';
  }

  /** Returns the current user object {email, username} or null if not logged in. */
  function getUser() {
    var raw = getCookie('_zrx_user');
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  /** Returns true if the user appears to be logged in (has a session cookie). */
  function isLoggedIn() {
    return getUser() !== null;
  }

  /**
   * Performs an authenticated fetch. Automatically adds credentials:'include'
   * so the HTTP-only authToken cookie is forwarded.
   * @param {string} url
   * @param {RequestInit} [options]
   */
  function authFetch(url, options) {
    options = Object.assign({}, options);
    options.credentials = 'include';
    return fetch(url, options);
  }

  /**
   * Logs the user out by calling the server logout endpoint (clears HTTP-only cookie)
   * then invokes the optional callback.
   * @param {function} [callback]
   */
  function logout(callback) {
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
    getCookie: getCookie,
    setCookie: setCookie,
    deleteCookie: deleteCookie,
    BACKEND_URL: BACKEND_URL
  };
}());
