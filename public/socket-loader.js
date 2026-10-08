/* socket-loader.js – loads the socket.io client from the backend, then the app.
 *
 * The socket.io client lives on the backend, usually a different origin.
 * Pulling it in with document.write makes it a parser-blocking cross-site
 * script, which Chrome may refuse to fetch on a slow connection – and a
 * Render free-tier cold start looks exactly like one. Load it explicitly.
 *
 * A sleeping Render service answers with an error until it has booted (up to
 * a minute or so), so a single failed attempt is not "server down". Keep
 * retrying for a while and tell the user we are waking it up; start the app
 * either once the client arrived or after giving up – the app itself reports
 * a missing server.
 *
 * Usage: <script src="/socket-loader.js" data-app="/admin.js"></script>
 */
(function () {
  var RETRY_MS = 5000;
  var GIVE_UP_MS = 120000;

  var appSrc = document.currentScript && document.currentScript.getAttribute('data-app');
  var base = (window.BACKEND_URL || '') + '/socket.io/socket.io.js';
  var started = Date.now();
  var attempt = 0;
  var label = document.getElementById('conn-label');
  var dot = document.getElementById('conn-dot');
  var initialLabel = label && label.textContent;
  var initialDot = dot && dot.className;

  function setStatus(text, dotClass) {
    if (label) label.textContent = text;
    if (dot) dot.className = dotClass;
  }

  function load() {
    attempt += 1;
    var loader = document.createElement('script');
    // Bust the cache so a failed response is not replayed on retry.
    loader.src = attempt === 1 ? base : base + '?retry=' + attempt;
    loader.onload = function () {
      if (attempt > 1) setStatus(initialLabel, initialDot);
      start();
    };
    loader.onerror = function () {
      loader.remove();
      var elapsed = Date.now() - started;
      if (elapsed >= GIVE_UP_MS) { start(); return; }
      setStatus('Budzenie serwera… (' + Math.round(elapsed / 1000) + ' s)', 'dot yellow');
      setTimeout(load, RETRY_MS);
    };
    document.head.appendChild(loader);
  }

  function start() {
    if (!appSrc) return;
    var app = document.createElement('script');
    app.src = appSrc;
    document.head.appendChild(app);
  }

  load();
}());
