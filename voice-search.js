/* voice-search.js – shared voice search helper using the Web Speech API */
(function () {
  'use strict';

  /* Inject a small stylesheet for the listening animation */
  var style = document.createElement('style');
  style.textContent = [
    '[data-voice-for].voice-listening i { color: #06b6d4 !important; }',
    '[data-voice-for] { transition: opacity .15s; }',
    '[data-voice-for]:hover { opacity: .75; }'
  ].join('\n');
  document.head.appendChild(style);

  var activeRecognition = null;

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

    if (!SpeechRecognition) {
      alert(
        'Voice search is not supported in your browser.\n' +
        'Please try Chrome or Microsoft Edge.'
      );
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

    /* Find the mic button that belongs to this input */
    var btn  = document.querySelector('[data-voice-for="' + inputId + '"]');
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
        alert(
          'Microphone access was denied.\n' +
          'Please allow microphone access in your browser settings to use voice search.'
        );
      } else if (event.error !== 'no-speech' && event.error !== 'aborted') {
        alert('Voice search error: ' + event.error);
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
