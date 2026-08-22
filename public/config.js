/* config.js – deployment configuration */
// Backend (Render) URL used by the frontend deployed on Vercel.
// On localhost we talk to the server that served the page, so `npm start`
// works without editing this file.
(function () {
  var isLocal = location.hostname === 'localhost'
    || location.hostname === '127.0.0.1'
    || location.hostname === '[::1]';

  window.BACKEND_URL = isLocal ? '' : 'https://aleanimiecv2.onrender.com';
}());
