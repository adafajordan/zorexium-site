/* voice-search.js – shared voice search helper using the Web Speech API */
(function () {
  'use strict';

  /* Inject stylesheet for mic button hover and listening states */
  var style = document.createElement('style');
  style.textContent = [
    '[data-voice-for].voice-listening i { color: #06b6d4 !important; }',
    '[data-voice-for] { transition: opacity .15s; }',
    '[data-voice-for]:hover { opacity: .75; }',
    '.voice-search-err {',
    '  position:absolute; bottom:calc(100% + 4px); right:0;',
    '  background:#1f2937; color:#f9fafb; font-size:12px;',
    '  padding:5px 10px; border-radius:6px; white-space:nowrap;',
    '  z-index:999; pointer-events:none;',
    '  animation: vsErrFade 3s forwards;',
    '}',
    '@keyframes vsErrFade {',
    '  0%{opacity:1} 70%{opacity:1} 100%{opacity:0}',
    '}'
  ].join('\n');
  document.head.appendChild(style);

  var activeRecognition = null;

  /* Show a brief tooltip-style error near the mic button */
  function showError(btn, message) {
    if (!btn) return;
    var existing = btn.querySelector('.voice-search-err');
    if (existing) existing.remove();
    var tip = document.createElement('span');
    tip.className = 'voice-search-err';
    tip.textContent = message;
    /* Ensure the parent is positioned so the tooltip can use bottom:100% */
    var parent = btn.parentElement;
    if (parent && getComputedStyle(parent).position === 'static') {
      parent.style.position = 'relative';
    }
    btn.appendChild(tip);
    setTimeout(function () { if (tip.parentNode) tip.parentNode.removeChild(tip); }, 3200);
  }

  /**
   * startVoiceSearch(inputId, callback)
   *
   * Starts speech recognition and writes the transcript into the <input>
   * whose id is `inputId`.  After the result is received `callback(transcript)`
   * is called so the page can trigger its own filter/search logic.
   *
   * The mic button is identified by the attribute  data-voice-for="<inputId>"
   * and receives a spinning icon while listening.
   */
  window.startVoiceSearch = function (inputId, callback) {
    var SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    var btn = document.querySelector('[data-voice-for="' + inputId + '"]');

    if (!SpeechRecognition) {
      showError(btn, 'Voice search not supported in this browser');
      return;
    }

    /* Stop any ongoing session first */
    if (activeRecognition) {
      try { activeRecognition.stop(); } catch (e) { /* ignore */ }
      activeRecognition = null;
    }

    var recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    activeRecognition = recognition;

    var icon = btn ? btn.querySelector('i') : null;

    function setListening(on) {
      if (!btn) return;
      if (on) {
        btn.classList.add('voice-listening');
        if (icon) {
          icon.classList.remove('fa-microphone');
          icon.classList.add('fa-circle-notch', 'fa-spin');
        }
      } else {
        btn.classList.remove('voice-listening');
        if (icon) {
          icon.classList.remove('fa-circle-notch', 'fa-spin');
          icon.classList.add('fa-microphone');
        }
      }
    }

    setListening(true);

    recognition.onresult = function (event) {
      var transcript = event.results[0][0].transcript;
      var input = document.getElementById(inputId);
      if (input) {
        input.value = transcript;
        /* Dispatch an input event so pages relying on oninput pick it up */
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      setListening(false);
      activeRecognition = null;
      if (typeof callback === 'function') callback(transcript);
    };

    recognition.onerror = function (event) {
      setListening(false);
      activeRecognition = null;
      if (event.error === 'not-allowed') {
        showError(btn, 'Microphone access denied — check browser settings');
      } else if (event.error !== 'no-speech' && event.error !== 'aborted') {
        showError(btn, 'Voice search error: ' + event.error);
      }
    };

    recognition.onend = function () {
      setListening(false);
      activeRecognition = null;
    };

    try {
      recognition.start();
    } catch (e) {
      setListening(false);
      activeRecognition = null;
    }
  };
}());
