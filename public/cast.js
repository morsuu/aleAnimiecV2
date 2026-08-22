/* cast.js – Google Cast (Chromecast) support for the viewer page.
 *
 * Deliberately self-contained and defensive: the SDK only exists in Chrome and
 * Edge, the script is fetched from an external host, and neither is something
 * the page may depend on. Every entry point checks that the framework is really
 * there, so a viewer without Cast simply never sees the button.
 *
 * The admin never casts – the server takes its timeline from the admin's own
 * player, and a receiver's laggy position would drag the whole room with it.
 */
'use strict';

window.CastPlayer = (function () {

  const SDK_URL = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';

  function create(hooks) {
    const on = hooks || {};
    let context = null;
    let remotePlayer = null;
    let remoteController = null;
    let loadedKey = null;      // media currently on the receiver

    function framework() {
      return (window.cast && window.cast.framework) ? window.cast.framework : null;
    }

    function session() {
      const fw = framework();
      if (!fw) return null;
      try { return fw.CastContext.getInstance().getCurrentSession(); } catch (_) { return null; }
    }

    function connected() {
      return !!session() && !!remotePlayer && remotePlayer.isConnected;
    }

    function deviceName() {
      const s = session();
      try { return (s && s.getCastDevice && s.getCastDevice().friendlyName) || 'Chromecast'; } catch (_) { return 'Chromecast'; }
    }

    // ── Setup ────────────────────────────────────────────────────────────────

    function init() {
      const fw = framework();
      if (!fw || !window.chrome || !window.chrome.cast) return;

      try {
        fw.CastContext.getInstance().setOptions({
          receiverApplicationId: window.chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
          autoJoinPolicy: window.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
        });

        remotePlayer = new fw.RemotePlayer();
        remoteController = new fw.RemotePlayerController(remotePlayer);

        remoteController.addEventListener(
          fw.RemotePlayerEventType.IS_CONNECTED_CHANGED,
          () => {
            if (remotePlayer.isConnected) {
              if (on.onConnected) on.onConnected(deviceName());
            } else {
              loadedKey = null;
              if (on.onDisconnected) on.onDisconnected();
            }
          }
        );

        fw.CastContext.getInstance().addEventListener(
          fw.CastContextEventType.CAST_STATE_CHANGED,
          (e) => {
            const available = e.castState !== 'NO_DEVICES_AVAILABLE';
            if (on.onAvailabilityChange) on.onAvailabilityChange(available);
          }
        );

        const state = fw.CastContext.getInstance().getCastState();
        if (on.onAvailabilityChange) on.onAvailabilityChange(state !== 'NO_DEVICES_AVAILABLE');
        context = fw.CastContext.getInstance();
      } catch (_) {
        // A broken SDK must not take the page down with it.
      }
    }

    /** Pull in the sender SDK; it calls back through a global. */
    function load() {
      if (window.__castLoaderStarted) return;
      window.__castLoaderStarted = true;

      const previous = window.__onGCastApiAvailable;
      window.__onGCastApiAvailable = function (isAvailable) {
        if (typeof previous === 'function') { try { previous(isAvailable); } catch (_) {} }
        if (isAvailable) init();
      };

      const s = document.createElement('script');
      s.src = SDK_URL;
      s.async = true;
      s.onerror = function () {
        // No Cast in this browser (or the script is blocked) – stay quiet.
        if (on.onAvailabilityChange) on.onAvailabilityChange(false);
      };
      document.head.appendChild(s);
    }

    // ── Control ──────────────────────────────────────────────────────────────

    function requestSession() {
      if (!context) return Promise.reject(new Error('Cast niedostępny'));
      return context.requestSession();
    }

    function stop() {
      const s = session();
      if (s) { try { s.endSession(true); } catch (_) {} }
    }

    /**
     * Put media on the receiver.
     * @param {{url:string, contentType:string, title:string,
     *          subtitleUrl:string|null, startTime:number, playing:boolean}} media
     */
    function loadMedia(media) {
      const s = session();
      if (!s || !window.chrome || !window.chrome.cast) return Promise.reject(new Error('Brak sesji'));

      const cc = window.chrome.cast;
      const info = new cc.media.MediaInfo(media.url, media.contentType || 'video/mp4');
      info.streamType = cc.media.StreamType.BUFFERED;

      const meta = new cc.media.GenericMediaMetadata();
      meta.title = media.title || 'aleAnimiec';
      info.metadata = meta;

      if (media.subtitleUrl) {
        const track = new cc.media.Track(1, cc.media.TrackType.TEXT);
        track.trackContentId = media.subtitleUrl;
        track.trackContentType = 'text/vtt';
        track.subtype = cc.media.TextTrackType.SUBTITLES;
        track.name = 'Napisy';
        track.language = 'pl';
        info.tracks = [track];
      }

      const request = new cc.media.LoadRequest(info);
      request.currentTime = Math.max(0, media.startTime || 0);
      request.autoplay = !!media.playing;
      if (media.subtitleUrl) request.activeTrackIds = [1];

      loadedKey = media.key || media.url;
      return s.loadMedia(request);
    }

    /** Key of what the receiver is currently showing, so we don't reload it. */
    function currentKey() { return loadedKey; }

    function currentTime() {
      return remotePlayer && remotePlayer.isConnected ? (remotePlayer.currentTime || 0) : 0;
    }

    function isPaused() {
      return !remotePlayer || !!remotePlayer.isPaused;
    }

    function seek(seconds) {
      if (!remotePlayer || !remoteController || !remotePlayer.isConnected) return;
      remotePlayer.currentTime = Math.max(0, seconds);
      try { remoteController.seek(); } catch (_) {}
    }

    function play() {
      if (!remotePlayer || !remoteController || !remotePlayer.isConnected) return;
      if (remotePlayer.isPaused) { try { remoteController.playOrPause(); } catch (_) {} }
    }

    function pause() {
      if (!remotePlayer || !remoteController || !remotePlayer.isConnected) return;
      if (!remotePlayer.isPaused) { try { remoteController.playOrPause(); } catch (_) {} }
    }

    return {
      load,
      requestSession,
      stop,
      loadMedia,
      currentKey,
      currentTime,
      isPaused,
      seek,
      play,
      pause,
      isConnected: connected,
      deviceName,
    };
  }

  return { create };
}());
