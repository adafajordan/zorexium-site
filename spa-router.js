/**
 * Zorexium SPA Router
 *
 * Intercepts all internal link clicks and renders the target page's <main>
 * content inside #spaMain on index.html, keeping the header and sidebar
 * persistent throughout all navigation.
 *
 * Hash-based routing is used so the page never fully reloads when navigating
 * between views. The original URL is preserved in the hash fragment so that
 * the existing page scripts can still read window.location correctly.
 */
(function () {
    'use strict';

    // ── Configuration ──────────────────────────────────────────────────────────

    /** Page basenames handled by the SPA (rather than full page navigations). */
    var SPA_PAGES = [
        'marketplace.html',
        'product-detail.html',
        'checkout.html',
        'account-details.html',
        'messages.html',
        'shopping-cart.html',
        'seller-dashboard.html',
        'sell-on-zorexium.html',
        'seller-profile.html',
        'seller-signup.html',
        'listing-wizard.html',
        'marketplace-settings.html',
        'track-your-order.html',
        'deals-promotions.html',
        'faq.html',
        'contact-support.html',
        'community-hub.html',
        'general-discussion.html',
        'tech-discussions.html',
        'hardware-reviews.html',
        'innovation-news.html',
        'troubleshooting-support.html',
        'hardware-compatibility.html',
        'getting-started.html',
        'api-documentation.html',
        'verified-labs.html',
        'trusted-seller.html',
        'ai-ml-accelerators.html',
        'compute-graphics.html',
        'networking-data-flow.html',
        'storage-memory.html',
        'trading-floor.html',
        'admin-payouts.html',
        'seller-payouts.html',
        'payment-success.html',
        'success.html',
        'fulfillment-testing.html',
        'sell-hardware.html',
        'cookie-settings.html',
        'privacy-policy.html',
        'terms-of-service.html',
        'return-refund-policy.html',
        'sellers-guidelines.html',
        'community-guidelines.html',
        'trust-center.html',
        // New dedicated panel pages
        'help-center.html',
        'login-register.html',
        'signup-login.html',
        'about.html',
        'order-history.html',
        'returns-history.html',
        'wish-lists.html',
        'email-notifications.html',
        'build-lists.html',
        'build-showcase.html',
    ];

    /**
     * Script src filenames already included in index.html.
     * These are skipped when executing scripts from fetched pages to avoid
     * double-loading / re-running session/notification setup.
     */
    var SKIP_SRC = [
        'notifications.js',
        'session.js',
        'cookie-consent.js',
        'open-links-new-tab.js',
        'profile-picture.js',
        'spa-router.js',
    ];

    /**
     * Substrings that, when found in an inline <script>, identify it as the
     * shared header-wiring script present on every page.  That script modifies
     * document.body.innerHTML (the dokan sweep) and rewires elements that already
     * exist and are managed by index.html, so we skip it during SPA navigation.
     */
    var SKIP_INLINE_SIGNATURES = [
        'document.body.innerHTML = document.body.innerHTML',
        'doHeaderLogin',
    ];

    // ── State ──────────────────────────────────────────────────────────────────

    var spaMain = null;       // #spaMain element reference
    var homeHTML = '';        // Saved initial home content (restored on back-nav to /)
    var homeTitle = '';       // Original page title
    var currentHref = '';     // Currently displayed href

    // ── Public API ─────────────────────────────────────────────────────────────

    /**
     * window.ZrxSpa.navigate(url)
     *
     * Navigate to `url` inside the SPA panel.  Call this from page scripts
     * instead of `window.location.href = url` to keep the experience within
     * index.html.  Falls back to normal navigation for external / unknown pages.
     *
     * @param {string} url – absolute or relative URL to navigate to
     * @returns {boolean} true if navigation was handled by the SPA
     */
    window.ZrxSpa = {
        navigate: function (url) {
            try {
                var abs = resolveUrl(url);
                var basename = getBasename(abs);
                if (SPA_PAGES.indexOf(basename) !== -1) {
                    navigateTo(abs);
                    return true;
                }
            } catch (e) { /* ignore */ }
            // Fallback: normal browser navigation
            window.location.href = url;
            return false;
        },

        /** Return the basename of the view currently shown in #spaMain. */
        currentView: function () {
            return currentHref ? getBasename(currentHref) : '';
        },
    };

    // ── Helpers ────────────────────────────────────────────────────────────────

    function resolveUrl(url) {
        return new URL(url, window.location.href).href;
    }

    function getBasename(url) {
        try {
            var pathname = new URL(url).pathname;
            return pathname.split('/').pop() || '';
        } catch (e) {
            return url.split('/').pop().split('?')[0] || '';
        }
    }

    function isSpaPage(url) {
        try {
            var basename = getBasename(url);
            return SPA_PAGES.indexOf(basename) !== -1;
        } catch (e) {
            return false;
        }
    }

    function isSameOrigin(url) {
        try {
            return new URL(url).origin === window.location.origin;
        } catch (e) {
            return true; // relative URL → same origin
        }
    }

    // ── Initialisation ─────────────────────────────────────────────────────────

    function init() {
        spaMain = document.getElementById('spaMain');
        if (!spaMain) return;

        // Save the original home content so we can restore it on back-navigation.
        homeHTML = spaMain.innerHTML;
        homeTitle = document.title;

        // Intercept clicks (capture phase so we run before any other handler)
        document.addEventListener('click', onDocumentClick, true);

        // Handle browser Back / Forward
        window.addEventListener('popstate', onPopState);

        // If the page was opened with a hash that encodes a view URL, load it.
        handleInitialHash();
    }

    // ── Click interception ─────────────────────────────────────────────────────

    function onDocumentClick(e) {
        // Walk up from the click target to find the nearest <a> with href
        var link = e.target;
        while (link && link.tagName !== 'A') link = link.parentElement;
        if (!link || !link.href) return;

        var href = link.getAttribute('href') || '';

        // ── Home-page subcategory interception ─────────────────────────────────
        // When filterHomeProducts is available (home panel is shown) intercept
        // category/subcategory link clicks and filter the home grid in-place
        // instead of loading the full marketplace page.
        if (href.includes('marketplace.html?category=') &&
                typeof window.filterHomeProducts === 'function') {
            var params = new URLSearchParams(href.split('?')[1] || '');
            var categoryKey = params.get('category') || '';
            if (categoryKey) {
                var subKey = params.get('sub') || '';
                var subSpan = link.querySelector('span.text-xs');
                var subSpanText = subSpan ? subSpan.textContent.trim() : '';
                var label = (subSpanText || link.textContent.trim()) || categoryKey;
                e.preventDefault();
                e.stopImmediatePropagation();
                window.filterHomeProducts(categoryKey, subKey, label);
                document.querySelectorAll('.nav-dropdown-trigger').forEach(function (d) { d.classList.remove('active'); });
                return;
            }
        }

        // Skip: anchors, mailto, tel, javascript, empty
        if (!href || /^(#|mailto:|tel:|javascript:)/i.test(href.trim())) return;

        // Skip: links explicitly targeting a named frame (not _blank / _self / _top)
        // We still intercept _blank links to same-origin SPA pages because
        // open-links-new-tab.js sets target="_blank" on all internal links,
        // and we want those to stay inside the SPA panel.
        var target = link.getAttribute('target');
        if (target && target !== '_blank' && target !== '_self' && target !== '_top' && target !== '_parent') return;

        // Resolve to absolute
        var abs;
        try { abs = resolveUrl(href); } catch (e) { return; }

        // Same origin only
        if (!isSameOrigin(abs)) return;

        // Only intercept pages registered in SPA_PAGES
        if (!isSpaPage(abs)) return;

        e.preventDefault();
        e.stopImmediatePropagation();

        navigateTo(abs);
    }

    // ── Navigation ─────────────────────────────────────────────────────────────

    function navigateTo(href) {
        // Push the actual page URL so that window.location.search is correct
        // for any scripts in the fetched page that read URL parameters.
        // (On page refresh the standalone page will load – acceptable graceful degradation.)
        history.pushState({ spaHref: href }, '', href);
        loadView(href, true);
    }

    function onPopState(e) {
        if (e.state && e.state.spaHref) {
            loadView(e.state.spaHref, false);
        } else {
            // Back to home (index.html)
            restoreHome();
        }
    }

    function handleInitialHash() {
        // No-op: with pushState routing, there is no special hash to handle.
        // If the page loaded with a path like /marketplace.html, the server
        // delivers the standalone page; the SPA only activates on internal clicks.
    }

    function restoreHome() {
        if (spaMain) {
            spaMain.innerHTML = homeHTML;
            document.title = homeTitle;
            currentHref = '';
            // Re-run the home product loader if available
            if (typeof window._zrxHomeInit === 'function') {
                window._zrxHomeInit();
            }
        }
        // Restore the index.html URL
        var indexUrl = window.location.origin +
            window.location.pathname.replace(/\/[^/]+\.html.*$/, '/index.html');
        history.replaceState(null, homeTitle, indexUrl);
    }

    // ── View loading ───────────────────────────────────────────────────────────

    async function loadView(href, scrollToTop) {
        if (!spaMain) return;
        currentHref = href;

        // Show loading indicator
        spaMain.innerHTML =
            '<div class="flex flex-col items-center justify-center py-24 text-gray-400" id="_spaLoading">' +
            '  <i class="fas fa-spinner fa-spin text-5xl text-cyan-400 mb-6"></i>' +
            '  <span class="text-lg">Loading…</span>' +
            '</div>';

        try {
            var res = await fetch(href, { cache: 'no-store' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            var html = await res.text();

            var parser = new DOMParser();
            var doc = parser.parseFromString(html, 'text/html');

            // ── Inject <main> content ────────────────────────────────────────
            var mainEl = doc.querySelector('main');
            if (mainEl) {
                spaMain.innerHTML = mainEl.innerHTML;
            } else {
                // Fallback: strip header from body and use the rest
                var headerEl = doc.querySelector('header');
                if (headerEl) headerEl.remove();
                doc.querySelectorAll('body > script').forEach(function (s) { s.remove(); });
                spaMain.innerHTML = doc.body.innerHTML;
            }

            // Update page title
            var titleEl = doc.querySelector('title');
            if (titleEl) document.title = titleEl.textContent;

            // ── Execute page-specific scripts ────────────────────────────────
            var headerEl2 = doc.querySelector('header');
            var bodyScripts = Array.from(doc.body.querySelectorAll('script'));

            for (var i = 0; i < bodyScripts.length; i++) {
                var oldScript = bodyScripts[i];

                // Skip scripts that live inside the fetched page's <header>
                if (headerEl2 && headerEl2.contains(oldScript)) continue;

                if (oldScript.src) {
                    // External script – skip already-loaded ones; load others
                    var srcBase = oldScript.src.split('/').pop().split('?')[0];
                    if (SKIP_SRC.indexOf(srcBase) !== -1) continue;
                    await loadExternalScript(oldScript.src);
                    continue;
                }

                // Inline script
                var text = oldScript.textContent || '';
                if (!text.trim()) continue;

                // Skip the shared header-wiring / dokan-sweep script
                if (shouldSkipInlineScript(text)) continue;

                // Pre-process the script text
                text = processScriptText(text);

                // Inject and execute
                var newScript = document.createElement('script');
                newScript.textContent = text;
                document.body.appendChild(newScript);
            }

        } catch (err) {
            spaMain.innerHTML =
                '<div class="text-center py-16 text-gray-400">' +
                '  <i class="fas fa-exclamation-triangle text-5xl text-red-400 mb-4 block"></i>' +
                '  <p class="text-lg font-medium text-gray-600 mb-2">Failed to load this page</p>' +
                '  <p class="text-sm text-gray-400">Please check your connection and try again.</p>' +
                '  <button onclick="history.back()" ' +
                '    class="mt-6 px-6 py-2 bg-cyan-500 text-white rounded-md hover:bg-cyan-600 text-sm font-medium">' +
                '    &larr; Go Back' +
                '  </button>' +
                '</div>';
        }

        if (scrollToTop) {
            // Scroll the main panel (or the window) to the top
            var wrapper = spaMain.closest('.overflow-y-auto') || null;
            if (wrapper) {
                wrapper.scrollTop = 0;
            } else {
                window.scrollTo({ top: 0, behavior: 'smooth' });
            }
        }
    }

    // ── Script helpers ─────────────────────────────────────────────────────────

    function shouldSkipInlineScript(text) {
        return SKIP_INLINE_SIGNATURES.some(function (sig) {
            return text.indexOf(sig) !== -1;
        });
    }

    /**
     * Pre-process a page's inline script before injecting it into the SPA
     * document so that it works correctly inside index.html.
     *
     * Transformations applied:
     *   1. `const`/`let` → `var` so the same script can be re-injected on
     *      repeated visits without "identifier already declared" errors.
     *   2. `window.addEventListener('load', namedFn)` → deferred call.
     *   3. `window.addEventListener('load', function(){…})` → deferred call.
     */
    function processScriptText(text) {
        // 1. Convert top-level (and nested) const/let to var to prevent
        //    re-declaration errors when a view is navigated to more than once.
        //    Using `var` is safe here – the values are functionally equivalent
        //    for the read-after-assign patterns used in these page scripts.
        text = text.replace(/\b(const|let)\s+/g, 'var ');

        // 2. Named function reference: window.addEventListener('load', funcName)
        text = text.replace(
            /window\.addEventListener\s*\(\s*['"]load['"]\s*,\s*(\w+)\s*\)/g,
            function (match, fn) {
                return (
                    'setTimeout(function(){' +
                    'if(typeof ' + fn + '==="function"){' + fn + '();}' +
                    '},50)'
                );
            }
        );

        // 3. Anonymous function: window.addEventListener('load', function() { stmt(); })
        //    Handles the common single-statement pattern (no nested braces).
        text = text.replace(
            /window\.addEventListener\s*\(\s*['"]load['"]\s*,\s*(function\s*\([^)]*\)\s*\{[^}]*\})\s*\)/g,
            function (match, fn) {
                return 'setTimeout(' + fn + ', 50)';
            }
        );

        return text;
    }

    function loadExternalScript(src) {
        return new Promise(function (resolve) {
            // Avoid loading the same script twice
            var existing = document.querySelector('script[src="' + src + '"]');
            if (existing) { resolve(); return; }
            var script = document.createElement('script');
            script.src = src;
            script.onload = resolve;
            script.onerror = resolve;
            document.body.appendChild(script);
        });
    }

    // ── Bootstrap ──────────────────────────────────────────────────────────────

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
