(function () {
  'use strict';

  var BACKEND_URL = 'https://zorexium-backend.onrender.com';
  var PLACEHOLDER = 'https://placehold.co/100x100/333/fff?text=U';

  function updateProfileImages(src) {
    var images = document.querySelectorAll('#userProfileImage');
    images.forEach(function (img) {
      img.src = src || PLACEHOLDER;
    });
  }

  function loadProfilePicture() {
    // Use ZrxSession.fetch if available (adds Authorization header for cross-domain auth)
    var fetchFn = (window.ZrxSession && window.ZrxSession.fetch) ? window.ZrxSession.fetch.bind(window.ZrxSession) : null;
    if (!fetchFn) {
      // Fallback: build Authorization header from localStorage token directly
      var token = null;
      try { token = localStorage.getItem('authToken'); } catch (e) {}
      var options = { credentials: 'include' };
      if (token) { options.headers = { 'Authorization': 'Bearer ' + token }; }
      fetch(BACKEND_URL + '/api/user/profile-picture', options)
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (data) { if (data && data.profileImage) updateProfileImages(data.profileImage); })
        .catch(function () {});
      return;
    }
    fetchFn(BACKEND_URL + '/api/user/profile-picture')
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (data && data.profileImage) {
          updateProfileImages(data.profileImage);
        }
      })
      .catch(function () {
        // Silently fall back to placeholder on network errors
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadProfilePicture);
  } else {
    loadProfilePicture();
  }

  // Expose a helper so account-details.html can call it after upload
  window.ZrxProfilePicture = {
    update: updateProfileImages,
    reload: loadProfilePicture
  };
}());
