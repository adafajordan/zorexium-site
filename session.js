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

  function normalizeFooterText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function escapeFooterHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function sanitizeFooterHref(value) {
    var raw = String(value || '').trim();
    if (!raw || raw === '#' || raw.indexOf('javascript:') === 0) return '';
    try {
      var url = new URL(raw, window.location.href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    } catch (e) {
      return '';
    }
    return raw;
  }

  function mergeFooterSections(target, incoming) {
    if (!incoming || !incoming.title || !Array.isArray(incoming.links) || incoming.links.length === 0) return;
    var match = target.find(function(section) { return section.title === incoming.title; });
    if (!match) {
      target.push({
        title: incoming.title,
        links: incoming.links.slice()
      });
      return;
    }
    incoming.links.forEach(function(link) {
      var exists = match.links.some(function(existing) {
        return existing.href === link.href || existing.label === link.label;
      });
      if (!exists) match.links.push(link);
    });
  }

  function addFooterLink(list, href, label) {
    var safeHref = sanitizeFooterHref(href);
    var safeLabel = normalizeFooterText(label);
    if (!safeHref || !safeLabel) return;
    var exists = list.some(function(item) {
      return item.href === safeHref || item.label === safeLabel;
    });
    if (!exists) {
      list.push({ href: safeHref, label: safeLabel });
    }
  }

  function getDropdownTitle(dropdown, fallback) {
    if (!dropdown) return fallback || '';
    var topLink = dropdown.querySelector(':scope > a[href]');
    if (topLink) return normalizeFooterText(topLink.textContent) || (fallback || '');
    var button = dropdown.querySelector(':scope > button');
    return normalizeFooterText(button && button.textContent) || (fallback || '');
  }

  function collectDropdownSections(dropdown, defaultTitle) {
    var sections = [];
    if (!dropdown) return sections;
    var menu = dropdown.querySelector(':scope > .nav-dropdown');
    if (!menu) return sections;

    if (menu.classList.contains('marketplace-mega-menu')) {
      var grouped = {};
      menu.querySelectorAll('a[href]').forEach(function(link) {
        var spans = link.querySelectorAll('span');
        var groupTitle = normalizeFooterText(spans[0] && spans[0].textContent) || defaultTitle;
        var linkLabel = normalizeFooterText(spans[1] && spans[1].textContent) || normalizeFooterText(link.textContent);
        var safeHref = sanitizeFooterHref(link.getAttribute('href'));
        if (!safeHref || !linkLabel) return;
        if (!grouped[groupTitle]) grouped[groupTitle] = [];
        addFooterLink(grouped[groupTitle], safeHref, linkLabel);
      });
      Object.keys(grouped).forEach(function(groupTitle) {
        sections.push({ title: groupTitle, links: grouped[groupTitle] });
      });
      return sections;
    }

    var currentSection = { title: defaultTitle, links: [] };
    Array.from(menu.children).forEach(function(child) {
      var directSectionTitle = normalizeFooterText((child.querySelector('p') || {}).textContent);
      var childLinks = child.matches('a[href]')
        ? [child]
        : Array.from(child.querySelectorAll('a[href]'));
      if (directSectionTitle && childLinks.length === 0) {
        if (currentSection.links.length) sections.push(currentSection);
        currentSection = { title: directSectionTitle, links: [] };
        return;
      }
      childLinks.forEach(function(link) {
        addFooterLink(currentSection.links, link.getAttribute('href'), link.textContent);
      });
    });
    if (currentSection.links.length) sections.push(currentSection);
    return sections;
  }

  function renderFooterLinkList(links) {
    if (!Array.isArray(links) || links.length === 0) return '';
    return '<ul class="space-y-2 text-sm text-gray-600">'
      + links.map(function(link) {
        return '<li><a class="hover:text-cyan-600 transition-colors" href="'
          + escapeFooterHtml(link.href) + '">'
          + escapeFooterHtml(link.label) + '</a></li>';
      }).join('')
      + '</ul>';
  }

  function renderSiteFooter() {
    var body = document.body;
    var topNav = document.querySelector('header nav');
    if (!body || !topNav) return;

    var quickLinks = [];
    Array.from(topNav.children).forEach(function(child) {
      if (child.tagName === 'A') {
        addFooterLink(quickLinks, child.getAttribute('href'), child.textContent);
        return;
      }
      if (child.classList && child.classList.contains('nav-dropdown-trigger')) {
        var topLink = child.querySelector(':scope > a[href]');
        if (topLink) addFooterLink(quickLinks, topLink.getAttribute('href'), topLink.textContent);
      }
    });
    var cartLink = document.getElementById('headerCartLink');
    if (cartLink) addFooterLink(quickLinks, cartLink.getAttribute('href'), 'Shopping Cart');

    var communitySections = [];
    collectDropdownSections(document.getElementById('communityHubDropdown'), 'Community Hub').forEach(function(section) {
      mergeFooterSections(communitySections, section);
    });

    var accountSections = [];
    collectDropdownSections(document.getElementById('headerAccountListsGuest'), 'Account & Lists').forEach(function(section) {
      mergeFooterSections(accountSections, section);
    });
    collectDropdownSections(document.getElementById('headerAccountSection'), 'Account & Lists').forEach(function(section) {
      mergeFooterSections(accountSections, section);
    });

    var marketplaceSections = collectDropdownSections(
      document.getElementById('marketplaceDropdown'),
      getDropdownTitle(document.getElementById('marketplaceDropdown'), 'Marketplace')
    );

    if (quickLinks.length === 0 && communitySections.length === 0 && accountSections.length === 0 && marketplaceSections.length === 0) return;

    var footerHtml = ''
      + '<footer id="sitewideFooter" class="bg-gray-50 border-t border-gray-200 mt-auto">'
      + '  <div class="max-w-7xl mx-auto px-6 sm:px-8 lg:px-10 py-10">'
      + '    <div class="grid gap-10 xl:grid-cols-[minmax(0,1.1fr),minmax(0,1.9fr)]">'
      + '      <div>'
      + '        <div class="flex items-center gap-3 mb-4">'
      + '          <div class="text-cyan-400 text-3xl"><i class="fas fa-microchip"></i></div>'
      + '          <div><span class="text-cyan-400 font-bold text-2xl tracking-wide leading-none">ZOREXIUM</span></div>'
      + '        </div>'
      + '        <p class="text-sm text-gray-500 leading-6 max-w-md">Browse the marketplace, explore community resources, and manage your seller account from one place.</p>'
      + '        <div class="mt-5">'
      + '          <p class="text-xs font-semibold uppercase tracking-[0.22em] text-cyan-600 mb-3">Quick Links</p>'
      +            renderFooterLinkList(quickLinks)
      + '        </div>'
      + '      </div>'
      + '      <div class="grid gap-8 md:grid-cols-2">'
      + accountSections.map(function(section) {
          return '<div>'
            + '<p class="text-xs font-semibold uppercase tracking-[0.22em] text-cyan-600 mb-3">' + escapeFooterHtml(section.title) + '</p>'
            + renderFooterLinkList(section.links)
            + '</div>';
        }).join('')
      + communitySections.map(function(section) {
          return '<div>'
            + '<p class="text-xs font-semibold uppercase tracking-[0.22em] text-cyan-600 mb-3">' + escapeFooterHtml(section.title) + '</p>'
            + renderFooterLinkList(section.links)
            + '</div>';
        }).join('')
      + '      </div>'
      + '    </div>'
      + '    <div class="mt-10 pt-8 border-t border-gray-200">'
      + '      <p class="text-xs font-semibold uppercase tracking-[0.22em] text-cyan-600 mb-4">Marketplace</p>'
      + '      <div class="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">'
      + marketplaceSections.map(function(section) {
          return '<div>'
            + '<p class="text-sm font-semibold text-gray-900 mb-3">' + escapeFooterHtml(section.title) + '</p>'
            + renderFooterLinkList(section.links)
            + '</div>';
        }).join('')
      + '      </div>'
      + '    </div>'
      + '    <div class="mt-10 pt-6 border-t border-gray-200 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">'
      + '      <p class="text-sm text-gray-500">&copy; 2026 Zorexium. All rights reserved.</p>'
      + '      <p class="text-sm text-gray-500">Navigation mirrors the current site header for fast access across every page.</p>'
      + '    </div>'
      + '  </div>'
      + '</footer>';

    var existingFooter = document.getElementById('sitewideFooter') || document.querySelector('footer');
    if (existingFooter) {
      existingFooter.outerHTML = footerHtml;
      return;
    }

    var footerContainer = document.createElement('div');
    footerContainer.innerHTML = footerHtml;
    var footerEl = footerContainer.firstElementChild;
    if (!footerEl) return;

    var chatBubble = body.querySelector('.fixed.bottom-6.right-6.z-50');
    if (chatBubble && chatBubble.parentNode === body) {
      body.insertBefore(footerEl, chatBubble);
    } else {
      body.appendChild(footerEl);
    }
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
    document.addEventListener('DOMContentLoaded', function() {
      hideGuestHeaderDropdownArrows();
      renderSiteFooter();
    });
  } else {
    hideGuestHeaderDropdownArrows();
    renderSiteFooter();
  }
}());
