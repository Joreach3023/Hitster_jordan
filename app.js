// ------- Config -------
const API_BASE = 'https://hitster-jordan-oexi.vercel.app';
const TRACKS_JSON = './tracks.json';
const FULL_PLAYBACK_STORAGE_KEY = 'hitster_full_playback';
const TIMER_DURATION = 30;
const HOLD_THRESHOLD_MS = 650;
const SCAN_LOOP_INTERVAL = 150;
const SCANNER_INACTIVITY_MS = 30000;
const SCAN_READY_MESSAGE = 'Musique prête. Appuie sur Play pour lancer !';

// ------- State -------
let accessToken = null;
let deviceId = null;
let player = null;
let playerActivated = false;
let currentUri = null;
let countdown = TIMER_DURATION;
let timerHandle = null;
let tracksCache = null;
let tracksIndex = null;
let sdkReady = false;
let fullTrackMode = false;
let playbackQueue = Promise.resolve();
let audioCtx = null;
let flashClearTimeout = null;
let revealHoldTimer = null;
let revealHoldTriggered = false;
let holdActive = false;
let keyboardHoldActive = false;
let wakeLockSentinel = null;
let wakeLockRequested = false;
let vibeAnalyser = null;
let vibeDataArray = null;
let vibeAnimationHandle = null;
let vibeGainNode = null;
let vibeOscillator = null;
let vibeEnergyTarget = 0;
let vibeDisplayLevel = 0;
let vibeActive = false;
let lastMediaSessionUri = null;
let mediaSessionHandlersBound = false;
let playbackTransferred = false;
let lastPlaybackDeviceId = null;
const reduceMotionQuery =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;
let reduceMotionEnabled = reduceMotionQuery ? reduceMotionQuery.matches : false;

// ------- UI refs -------
const statusEl = document.getElementById('status');
const loginBtn = document.getElementById('loginBtn');
const playBtn = document.getElementById('playBtn');
const pauseBtn = document.getElementById('pauseBtn');
const revealBtn = document.getElementById('revealBtn');
const nextBtn = document.getElementById('nextBtn');
const timerEl = document.getElementById('timer');
const timerValueEl = document.getElementById('timerValue');
const timerHeartsEl = document.getElementById('timerHearts');
const timerHeartEls = [];

if (timerHeartsEl) {
  for (let i = 0; i < TIMER_DURATION; i += 1) {
    const heart = document.createElement('span');
    heart.className = 'timer__heart is-active';
    timerHeartsEl.appendChild(heart);
    timerHeartEls.push(heart);
  }
}
const revealBox = document.getElementById('reveal');
const titleEl = document.getElementById('title');
const yearEl = document.getElementById('year');
const fullTrackToggle = document.getElementById('fullTrackToggle');

const openScannerBtn = document.getElementById('openScannerBtn');
const closeScannerBtn = document.getElementById('closeScannerBtn');
const scannerPane = document.getElementById('scannerPane');
const qrVideo = document.getElementById('qrVideo');
const qrCanvas = document.getElementById('qrCanvas');
const scannerStatus = document.getElementById('scannerStatus');

let mediaStream = null;
let scanRunning = false;
let scanLoopHandle = null;
let scannerInactivityTimer = null;
let scannerStreamPromise = null;

// ------- Helpers -------
function setStatus(msg) {
  if (statusEl) {
    statusEl.textContent = msg;
  }
}

function enable(el, on = true) {
  if (el) {
    el.disabled = !on;
  }
}

function normalizeToUri(value) {
  if (!value) return null;
  const text = value.trim();
  if (text.startsWith('spotify:track:')) {
    return text;
  }
  const match = text.match(/^https?:\/\/open\.spotify\.com\/track\/([A-Za-z0-9]+)(?:\?.*)?$/i);
  if (match) {
    return `spotify:track:${match[1]}`;
  }
  return null;
}

function getUrlConstructor() {
  if (typeof window !== 'undefined' && window.URL) {
    return window.URL;
  }
  if (typeof URL !== 'undefined') {
    return URL;
  }
  return null;
}

function ensureAudioContext() {
  if (audioCtx) {
    return audioCtx;
  }
  const Ctor = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null;
  if (!Ctor) {
    return null;
  }
  audioCtx = new Ctor();
  return audioCtx;
}

async function fetchActiveSpotifyDevice() {
  if (!accessToken) {
    return null;
  }
  try {
    const res = await fetch('https://api.spotify.com/v1/me/player/devices', {
      headers: { Authorization: 'Bearer ' + accessToken }
    });
    if (!res || res.ok === false) {
      return null;
    }
    const payload = await res.json().catch(() => null);
    const devices = payload?.devices;
    if (!Array.isArray(devices)) {
      return null;
    }
    const active = devices.find(device => device && device.is_active);
    if (active && active.id) {
      return active;
    }
  } catch (err) {
    console.warn('Unable to query Spotify devices', err);
  }
  return null;
}

function playMicroSfx() {
  const ctx = ensureAudioContext();
  if (!ctx) {
    return;
  }
  if (typeof ctx.resume === 'function' && ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(220, now);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.035, now + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
  osc.connect(gain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.2);
}

function triggerFlash() {
  if (!document?.body) {
    return;
  }
  document.body.classList.add('haptic-flash');
  if (flashClearTimeout) {
    clearTimeout(flashClearTimeout);
  }
  flashClearTimeout = setTimeout(() => {
    document.body.classList.remove('haptic-flash');
    flashClearTimeout = null;
  }, 120);
}

function doHapticPulse() {
  try {
    if (navigator?.vibrate) {
      navigator.vibrate(15);
    }
  } catch (err) {
    // Ignore vibration errors
  }
  playMicroSfx();
  triggerFlash();
}

function startHapticFeedback() {
  stopHapticFeedback();
  doHapticPulse();
}

function stopHapticFeedback() {
  if (flashClearTimeout) {
    clearTimeout(flashClearTimeout);
    flashClearTimeout = null;
  }
  if (document?.body) {
    document.body.classList.remove('haptic-flash');
  }
}

function withViewTransition(callback) {
  if (typeof document !== 'undefined' && typeof document.startViewTransition === 'function') {
    try {
      const transition = document.startViewTransition(() => {
        callback();
      });
      return transition;
    } catch (err) {
      console.warn('View transition not available', err);
    }
  }
  callback();
  return null;
}

async function ensureWakeLock() {
  wakeLockRequested = true;
  if (typeof navigator === 'undefined' || !navigator.wakeLock || typeof navigator.wakeLock.request !== 'function') {
    return null;
  }
  if (wakeLockSentinel) {
    return wakeLockSentinel;
  }
  try {
    wakeLockSentinel = await navigator.wakeLock.request('screen');
    wakeLockSentinel.addEventListener('release', () => {
      wakeLockSentinel = null;
      if (wakeLockRequested && typeof document !== 'undefined' && document.visibilityState === 'visible') {
        ensureWakeLock().catch(() => {});
      }
    });
  } catch (err) {
    console.warn('Unable to acquire wake lock', err);
  }
  return wakeLockSentinel;
}

function releaseWakeLock() {
  wakeLockRequested = false;
  if (wakeLockSentinel) {
    wakeLockSentinel.release().catch(() => {});
    wakeLockSentinel = null;
  }
}

function ensureVibeAnalyser() {
  return false;
}

function pumpVibes() {
  if (document?.documentElement?.style) {
    document.documentElement.style.setProperty('--vibe-pulse', '0');
  }
  if (vibeAnimationHandle) {
    cancelAnimationFrame(vibeAnimationHandle);
    vibeAnimationHandle = null;
  }
}

function setVibeActive() {
  vibeActive = false;
  vibeEnergyTarget = 0;
  pumpVibes();
}

function updateVibeFromState() {
  vibeEnergyTarget = 0;
  pumpVibes();
}

function toggleScannerPane(show) {
  if (!scannerPane) {
    return;
  }
  withViewTransition(() => {
    scannerPane.hidden = !show;
  });
  if (document?.documentElement?.classList) {
    document.documentElement.classList.toggle('scanner-open', show);
  }
  if (!show) {
    stopScanner();
  }
}

function setScannerMessage(message) {
  if (scannerStatus) {
    scannerStatus.textContent = message;
  }
}

function setupMediaSessionHandlers() {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator) || mediaSessionHandlersBound) {
    return;
  }
  mediaSessionHandlersBound = true;
  const safeHandler = handler => {
    return () => {
      try {
        handler();
      } catch (err) {
        console.warn('MediaSession handler failed', err);
      }
    };
  };
  const actions = [
    ['play', () => playBtn?.click?.()],
    ['pause', () => player?.pause?.()],
    [
      'stop',
      () => {
        player?.pause?.();
        releaseWakeLock();
        setVibeActive(false);
      }
    ],
    ['nexttrack', () => nextBtn?.click?.()]
  ];
  actions.forEach(([action, handler]) => {
    try {
      navigator.mediaSession.setActionHandler(action, safeHandler(handler));
    } catch (err) {
      // Some browsers may not support every action; ignore.
    }
  });
}

async function applyMediaMetadata(uri, fallbackTrack) {
  if (!uri || typeof navigator === 'undefined' || !('mediaSession' in navigator)) {
    return;
  }
  setupMediaSessionHandlers();
  let title = fallbackTrack?.name || 'Hitster';
  let artist = Array.isArray(fallbackTrack?.artists)
    ? fallbackTrack.artists
        .map(artistMeta => artistMeta && artistMeta.name)
        .filter(Boolean)
        .join(', ')
    : '';
  let album = fallbackTrack?.album?.name || 'Hitster Session';

  try {
    const tracks = await loadTracks();
    const meta = tracks[uri];
    if (meta) {
      if (meta.title) {
        title = meta.title;
      }
      if (meta.year) {
        album = `Hitster ${meta.year}`;
        if (!artist) {
          artist = `Sortie ${meta.year}`;
        }
      }
    }
  } catch (err) {
    console.warn('Unable to enrich metadata from tracks.json', err);
  }

  try {
    if (typeof MediaMetadata === 'undefined') {
      lastMediaSessionUri = uri;
      return;
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title,
      artist: artist || 'Hitster Hidden Player',
      album,
      artwork: [
        { src: 'assets/icons/icon.svg', sizes: '192x192', type: 'image/svg+xml' },
        { src: 'assets/icons/icon.svg', sizes: '512x512', type: 'image/svg+xml' }
      ]
    });
    lastMediaSessionUri = uri;
  } catch (err) {
    console.warn('Unable to update media session metadata', err);
  }
}

function primeMediaSession(uri) {
  if (!uri) {
    return;
  }
  applyMediaMetadata(uri, null);
}

async function updateMediaSessionState(state) {
  if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
    if (!state) {
      navigator.mediaSession.playbackState = 'none';
    }
  }
  if (!state) {
    if (pauseBtn) {
      pauseBtn.disabled = true;
    }
    releaseWakeLock();
    updateVibeFromState(null);
    setVibeActive(false);
    return;
  }

  const uri = state?.track_window?.current_track?.uri || currentUri;
  if (uri && uri !== lastMediaSessionUri) {
    await applyMediaMetadata(uri, state?.track_window?.current_track || null);
  }

  if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
    try {
      navigator.mediaSession.playbackState = state.paused ? 'paused' : 'playing';
    } catch (err) {
      // Ignore playback state errors
    }
    if (typeof navigator.mediaSession.setPositionState === 'function') {
      try {
        navigator.mediaSession.setPositionState({
          duration: typeof state.duration === 'number' ? state.duration / 1000 : 0,
          playbackRate: state.playback_rate ?? 1,
          position: typeof state.position === 'number' ? state.position / 1000 : 0
        });
      } catch (err) {
        // Ignore position state errors
      }
    }
  }

  updateVibeFromState(state);
  if (pauseBtn) {
    pauseBtn.disabled = Boolean(state.paused);
  }
  if (state.paused) {
    stopCountdown({ reset: false });
    releaseWakeLock();
    setVibeActive(false);
  } else {
    if (!timerHandle && !fullTrackMode) {
      beginCountdown({ reset: false });
    }
    ensureWakeLock().catch(() => {});
    setVibeActive(true);
  }
}

if (reduceMotionQuery) {
  const handleReduceMotionChange = event => {
    reduceMotionEnabled = event.matches;
    if (reduceMotionEnabled) {
      setVibeActive(false);
    } else if (player && typeof player.getCurrentState === 'function') {
      player
        .getCurrentState()
        .then(state => {
          if (state && !state.paused) {
            setVibeActive(true);
          }
        })
        .catch(() => {});
    }
  };
  if (typeof reduceMotionQuery.addEventListener === 'function') {
    reduceMotionQuery.addEventListener('change', handleReduceMotionChange);
  } else if (typeof reduceMotionQuery.addListener === 'function') {
    reduceMotionQuery.addListener(handleReduceMotionChange);
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && wakeLockRequested && !wakeLockSentinel) {
      ensureWakeLock().catch(() => {});
    } else if (document.visibilityState === 'hidden') {
      releaseWakeLock();
      stopHapticFeedback();
    }
  });
}

async function loadTracks() {
  if (tracksCache) {
    return tracksCache;
  }
  try {
    const data = await fetch(TRACKS_JSON).then(r => r.json());
    tracksCache = data || {};
    tracksIndex = Object.keys(tracksCache);
  } catch (err) {
    console.error('Unable to load tracks.json', err);
    tracksCache = {};
    tracksIndex = [];
  }
  return tracksCache;
}

async function resolveFromId(id) {
  if (!id) return null;
  const needle = id.trim();
  const tracks = await loadTracks();

  if (tracks[needle]) {
    return needle;
  }

  for (const [uri, meta] of Object.entries(tracks)) {
    if (!meta) continue;
    if (meta.id === needle || meta.code === needle || meta.shortId === needle) {
      return uri;
    }
  }

  const numeric = parseInt(needle, 10);
  if (!Number.isNaN(numeric) && numeric > 0) {
    if (!tracksIndex) {
      tracksIndex = Object.keys(tracks);
    }
    if (numeric <= tracksIndex.length) {
      return tracksIndex[numeric - 1];
    }
  }

  if (/^0+\d+$/.test(needle)) {
    const stripped = needle.replace(/^0+/, '');
    const num = parseInt(stripped, 10);
    if (!Number.isNaN(num) && num > 0 && tracksIndex && num <= tracksIndex.length) {
      return tracksIndex[num - 1];
    }
  }

  return null;
}

async function pauseCurrentPlayback() {
  const targetDeviceId = lastPlaybackDeviceId || deviceId;

  if (targetDeviceId === deviceId && player && typeof player.pause === 'function') {
    try {
      await player.pause();
      return;
    } catch (err) {
      console.warn('Spotify SDK pause failed, falling back to Web API', err);
    }
  }

  if (targetDeviceId && accessToken) {
    const res = await fetch(`https://api.spotify.com/v1/me/player/pause?device_id=${targetDeviceId}`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + accessToken }
    });
    if (!res?.ok) {
      throw new Error('Pause Spotify impossible');
    }
    return;
  }

  if (player && typeof player.pause === 'function') {
    await player.pause();
    return;
  }

  throw new Error('Lecteur Spotify indisponible');
}

async function handlePauseRequest() {
  await pauseCurrentPlayback();
  stopCountdown({ reset: false });
  setStatus('Lecture en pause.');
  if (pauseBtn) {
    pauseBtn.disabled = true;
  }
  releaseWakeLock();
  setVibeActive(false);
}

function stopCountdown({ reset = true } = {}) {
  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
  }
  if (reset) {
    countdown = TIMER_DURATION;
  }
  syncTimerDisplay();
}

function beginCountdown({ reset = true } = {}) {
  stopCountdown({ reset: false });
  if (reset || !Number.isFinite(countdown) || countdown <= 0) {
    countdown = TIMER_DURATION;
  }
  if (fullTrackMode) {
    syncTimerDisplay();
    return;
  }
  timerHandle = setInterval(async () => {
    countdown -= 1;
    syncTimerDisplay();
    if (countdown <= 0) {
      clearInterval(timerHandle);
      timerHandle = null;
      syncTimerDisplay();
      try {
        await pauseCurrentPlayback();
      } catch (err) {
        console.error('Failed to pause after countdown', err);
      }
      setStatus('Stopped.');
      if (pauseBtn) {
        pauseBtn.disabled = true;
      }
      releaseWakeLock();
      setVibeActive(false);
    }
  }, 1000);
  syncTimerDisplay();
}

function syncTimerDisplay() {
  if (!timerEl) {
    return;
  }
  const displayValue = fullTrackMode ? '∞' : Math.max(0, countdown);
  if (timerValueEl) {
    timerValueEl.textContent = displayValue;
  } else {
    timerEl.textContent = displayValue;
  }
  if (timerHeartEls.length) {
    const activeCount = fullTrackMode
      ? TIMER_DURATION
      : Math.max(0, Math.min(TIMER_DURATION, countdown));
    timerHeartEls.forEach((heart, index) => {
      heart.classList.toggle('is-active', index < activeCount);
    });
  }
  timerEl.classList.toggle('is-counting', Boolean(timerHandle) && !fullTrackMode);
  timerEl.classList.toggle('timer--infinite', fullTrackMode);
}

function setFullTrackMode(enabled, { persist = false } = {}) {
  const desired = Boolean(enabled);
  fullTrackMode = desired;
  if (fullTrackToggle) {
    fullTrackToggle.checked = desired;
  }
  if (desired) {
    clearInterval(timerHandle);
    timerHandle = null;
    timerEl?.classList.remove('is-counting');
  } else if (!Number.isFinite(countdown) || countdown <= 0) {
    countdown = TIMER_DURATION;
  }
  syncTimerDisplay();
  if (persist) {
    try {
      localStorage.setItem(FULL_PLAYBACK_STORAGE_KEY, desired ? '1' : '0');
    } catch (err) {
      console.warn('Unable to persist playback mode', err);
    }
  }
}

function restoreFullTrackMode() {
  let preferred = fullTrackToggle ? fullTrackToggle.checked : false;
  try {
    const stored = localStorage.getItem(FULL_PLAYBACK_STORAGE_KEY);
    if (stored === '1') {
      preferred = true;
    } else if (stored === '0') {
      preferred = false;
    }
  } catch (err) {
    console.warn('Unable to read playback mode preference', err);
  }
  setFullTrackMode(preferred);
}

async function transferPlaybackToSdk({ force = false } = {}) {
  if (!accessToken || !deviceId) {
    throw new Error('Login and wait for player ready.');
  }
  if (playbackTransferred && !force) {
    return;
  }
  const res = await fetch('https://api.spotify.com/v1/me/player', {
    method: 'PUT',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ device_ids: [deviceId], play: false })
  });
  if (res && res.ok === false) {
    throw new Error('Transfert Spotify impossible (' + res.status + ')');
  }
  playbackTransferred = true;
}

async function startTrack(uri, targetDeviceId = deviceId) {
  if (!uri) {
    throw new Error('No track URI provided.');
  }
  const playbackDeviceId = targetDeviceId || deviceId;
  if (!playbackDeviceId) {
    throw new Error('No playback device available.');
  }
  const res = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${playbackDeviceId}`, {
    method: 'PUT',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ uris: [uri] })
  });
  if (res && res.ok === false) {
    let detail = '';
    try {
      const payload = await res.json();
      if (payload && payload.error && payload.error.message) {
        detail = `: ${payload.error.message}`;
      }
    } catch (_) {
      // ignore JSON parse errors
    }
    throw new Error('Lecture Spotify impossible' + detail);
  }
}

async function startAfterEnsureDevice() {
  if (!accessToken) {
    const err = new Error('Login and wait for player ready.');
    setStatus(err.message);
    throw err;
  }
  if (!currentUri) {
    const err = new Error('No track URI selected.');
    setStatus(err.message);
    throw err;
  }

  let activeDevice = null;
  try {
    activeDevice = await fetchActiveSpotifyDevice();
  } catch (err) {
    console.warn('Unable to determine active Spotify device', err);
  }

  let targetDeviceId = deviceId;
  let usingSdkDevice = Boolean(deviceId);
  if (activeDevice && activeDevice.id) {
    targetDeviceId = activeDevice.id;
    usingSdkDevice = activeDevice.id === deviceId;
  }

  if (!targetDeviceId) {
    const err = new Error('No Spotify playback device available.');
    setStatus(err.message);
    throw err;
  }

  try {
    if (usingSdkDevice) {
      if (player && typeof player.activateElement === 'function' && !playerActivated) {
        await player.activateElement();
        if (typeof player.setVolume === 'function') {
          await player.setVolume(0.9);
        }
        playerActivated = true;
      } else if (player && typeof player.setVolume === 'function') {
        await player.setVolume(0.9);
      }

      await transferPlaybackToSdk();
    } else {
      playbackTransferred = false;
    }

    await startTrack(currentUri, targetDeviceId);
    lastPlaybackDeviceId = targetDeviceId;
    setStatus('Playing...');
    if (pauseBtn) {
      pauseBtn.disabled = false;
    }
  } catch (error) {
    console.error('Playback failed', error);
    playbackTransferred = false;
    lastPlaybackDeviceId = null;
    if (pauseBtn) {
      pauseBtn.disabled = true;
    }
    if (error && error.message === 'Activation blocked') {
      setStatus('Tap allow audio to enable playback on this device.');
    } else {
      setStatus('Erreur de lecture: ' + (error?.message || error));
    }
    throw error;
  }
}

async function runPlaybackSequence() {
  try {
    await startAfterEnsureDevice();
    beginCountdown();
    primeMediaSession(currentUri);
    await ensureWakeLock();
    setVibeActive(true);
  } catch (err) {
    console.error('Play button failed', err);
    throw err;
  }
}

async function showReveal() {
  if (revealBox && revealBox.hidden) {
    withViewTransition(() => {
      revealBox.hidden = false;
    });
  }
  if (!currentUri) {
    titleEl.textContent = 'No track selected';
    yearEl.textContent = '';
    return;
  }
  const map = await loadTracks();
  const meta = map[currentUri] || null;
  if (meta) {
    titleEl.textContent = meta.title || 'Unknown track';
    yearEl.textContent = meta.year || '';
  } else {
    titleEl.textContent = 'Unknown track';
    yearEl.textContent = '';
  }
}

function normalizeToUriOrId(text) {
  try {
    if (!text) {
      return { type: 'raw', value: text };
    }
    // URLs first
    if (/^https?:\/\//i.test(text)) {
      const UrlCtor = getUrlConstructor();
      if (!UrlCtor) {
        return { type: 'raw', value: text };
      }
      const u = new UrlCtor(text);
      const t = u.searchParams.get('t');
      const id = u.searchParams.get('id');
      if (t) {
        const uri = normalizeToUri(t);
        if (uri) return { type: 'uri', value: uri };
      }
      if (id) {
        return { type: 'id', value: id };
      }
      const m = text.match(/^https?:\/\/open\.spotify\.com\/track\/([A-Za-z0-9]+)(?:\?.*)?$/);
      if (m) return { type: 'uri', value: `spotify:track:${m[1]}` };
      return { type: 'raw', value: text };
    }

    if (text.startsWith('spotify:track:')) {
      return { type: 'uri', value: text };
    }

    if (/^\d{1,4}$/.test(text)) {
      return { type: 'id', value: text };
    }

    return { type: 'raw', value: text };
  } catch (_) {
    return { type: 'raw', value: text };
  }
}

function prepareTrackForManualStart() {
  stopCountdown();
  Promise.resolve(player?.pause?.()).catch(() => {});
  releaseWakeLock();
  setVibeActive(false);
  setStatus(SCAN_READY_MESSAGE);
  if (scannerStatus) {
    scannerStatus.textContent = SCAN_READY_MESSAGE;
  }
}

async function playFromScan(parsed) {
  if (parsed.type === 'uri') {
    currentUri = parsed.value;
    primeMediaSession(currentUri);
    const UrlCtor = getUrlConstructor();
    if (UrlCtor) {
      const url = new UrlCtor(window.location.href);
      url.searchParams.delete('id');
      url.searchParams.set('t', parsed.value);
      if (typeof window !== 'undefined' && window.history && typeof window.history.replaceState === 'function') {
        window.history.replaceState(null, '', url.toString());
      }
    }
    prepareTrackForManualStart();
    return;
  }
  if (parsed.type === 'id') {
    const uri = await resolveFromId(parsed.value);
    if (uri) {
      currentUri = uri;
      primeMediaSession(currentUri);
      const UrlCtor = getUrlConstructor();
      if (UrlCtor) {
        const url = new UrlCtor(window.location.href);
        url.searchParams.delete('t');
        url.searchParams.set('id', parsed.value);
        if (typeof window !== 'undefined' && window.history && typeof window.history.replaceState === 'function') {
          window.history.replaceState(null, '', url.toString());
        }
      }
      prepareTrackForManualStart();
    } else {
      setStatus(`ID ${parsed.value} introuvable dans tracks.json`);
      if (scannerStatus) {
        scannerStatus.textContent = `ID ${parsed.value} introuvable.`;
      }
    }
    return;
  }
  setStatus('QR non reconnu.');
  if (scannerStatus) {
    scannerStatus.textContent = 'QR non reconnu.';
  }
}

function clearScannerInactivityTimer() {
  if (scannerInactivityTimer) {
    clearTimeout(scannerInactivityTimer);
    scannerInactivityTimer = null;
  }
}

function scheduleScannerInactivityStop() {
  clearScannerInactivityTimer();
  scannerInactivityTimer = setTimeout(() => {
    setScannerMessage('Scanner arrêté pour économiser la batterie.');
    stopScanner({ release: true });
    toggleScannerPane(false);
  }, SCANNER_INACTIVITY_MS);
}

function stopScanner({ release = false } = {}) {
  scanRunning = false;
  if (scanLoopHandle) {
    clearTimeout(scanLoopHandle);
    scanLoopHandle = null;
  }
  clearScannerInactivityTimer();
  if (qrVideo) {
    qrVideo.pause();
    if (release) {
      qrVideo.srcObject = null;
    }
  }
  if (mediaStream) {
    const videoTracks = mediaStream.getVideoTracks();
    videoTracks.forEach(track => {
      if (release) {
        try {
          track.stop();
        } catch (err) {
          // Ignore stop errors
        }
      } else {
        track.enabled = false;
      }
    });
    if (release) {
      mediaStream = null;
      scannerStreamPromise = null;
    }
  } else if (release) {
    scannerStreamPromise = null;
  }
}

function scanLoop() {
  if (!scanRunning || !qrVideo || !qrCanvas) {
    return;
  }
  const w = qrVideo.videoWidth;
  const h = qrVideo.videoHeight;
  if (!w || !h) {
    scanLoopHandle = setTimeout(scanLoop, SCAN_LOOP_INTERVAL);
    return;
  }
  qrCanvas.width = w;
  qrCanvas.height = h;
  const ctx = qrCanvas.getContext('2d');
  ctx.drawImage(qrVideo, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  if (typeof jsQR !== 'function') {
    setScannerMessage('Bibliothèque jsQR indisponible.');
    stopScanner();
    return;
  }
  const code = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
  if (code && code.data) {
    scanRunning = false;
    setScannerMessage('QR détecté !');
    stopScanner();
    const parsed = normalizeToUriOrId(code.data.trim());
    playFromScan(parsed);
    toggleScannerPane(false);
    return;
  }
  scanLoopHandle = setTimeout(scanLoop, SCAN_LOOP_INTERVAL);
}

function attemptSetupPlayer() {
  if (!sdkReady || !accessToken || player) {
    if (sdkReady && !accessToken) {
      setStatus('Spotify SDK loaded. Please login.');
    }
    return;
  }

  player = new Spotify.Player({
    name: 'Hitster Geek Player',
    getOAuthToken: cb => cb(accessToken),
    volume: 0.8
  });

  player.addListener('ready', ({ device_id }) => {
    deviceId = device_id;
    playbackTransferred = false;
    setStatus('Player ready. Device: ' + device_id);
  });

  player.addListener('not_ready', ({ device_id }) => {
    if (deviceId === device_id) {
      deviceId = null;
      playerActivated = false;
      playbackTransferred = false;
    }
    setStatus('Player not ready.');
  });

  player.addListener('initialization_error', ({ message }) => setStatus('Init error: ' + message));
  player.addListener('authentication_error', ({ message }) => setStatus('Auth error: ' + message));
  player.addListener('account_error', ({ message }) => setStatus('Account error: ' + message));
  player.addListener('player_state_changed', state => {
    if (!state) {
      updateMediaSessionState(null);
      return;
    }
    Promise.resolve(updateMediaSessionState(state)).catch(err => {
      console.error('Unable to update media session state', err);
    });
  });

  player.connect();
}

function applyAccessToken(token) {
  accessToken = token;
  playbackTransferred = false;
  try {
    localStorage.setItem('spotify_token', token);
  } catch (err) {
    console.warn('Unable to persist Spotify token', err);
  }
  enable(playBtn, true);
  enable(revealBtn, true);
  enable(nextBtn, true);
  setStatus('Authenticated with Spotify.');
  attemptSetupPlayer();
}

function restoreStoredToken() {
  try {
    const stored = localStorage.getItem('spotify_token');
    if (stored) {
      applyAccessToken(stored);
    }
  } catch (err) {
    console.warn('Unable to read stored Spotify token', err);
  }
}

// ------- Query params -------
const qs = new URLSearchParams(window.location.search);
const paramUri = qs.get('t');
const paramId = qs.get('id');
const paramAction = qs.get('action');
if (paramUri) {
  const normalized = normalizeToUri(paramUri) || paramUri;
  currentUri = normalized;
  primeMediaSession(currentUri);
}

if (paramId) {
  resolveFromId(paramId).then(uri => {
    if (uri) {
      currentUri = uri;
      primeMediaSession(currentUri);
    } else {
      setStatus(`ID ${paramId} introuvable dans tracks.json`);
    }
  });
}

if (paramAction === 'scanner') {
  window.addEventListener('load', () => {
    setTimeout(() => {
      openScannerBtn?.click?.();
    }, 150);
  });
  const UrlCtor = getUrlConstructor();
  if (UrlCtor) {
    const url = new UrlCtor(window.location.href);
    url.searchParams.delete('action');
    if (typeof window !== 'undefined' && window.history && typeof window.history.replaceState === 'function') {
      window.history.replaceState(null, '', url.toString());
    }
  }
}

// ------- Token bootstrap -------
restoreStoredToken();
restoreFullTrackMode();
const tokenFromHash = new URLSearchParams(window.location.search).get('token');
if (tokenFromHash) {
  applyAccessToken(tokenFromHash);
  const UrlCtor = getUrlConstructor();
  if (UrlCtor) {
    const url = new UrlCtor(window.location.href);
    url.searchParams.delete('token');
    if (typeof window !== 'undefined' && window.history && typeof window.history.replaceState === 'function') {
      window.history.replaceState(null, '', url.toString());
    }
  }
}

// ------- OAuth step 1: redirect to /api/login -------
loginBtn.addEventListener('click', () => {
  const ret = window.location.href;
  window.location.href = `${API_BASE}/api/login?redirect_uri=${encodeURIComponent(ret)}`;
});

// ------- Spotify SDK Ready -------
window.onSpotifyWebPlaybackSDKReady = () => {
  sdkReady = true;
  setStatus('Spotify SDK loaded.');
  attemptSetupPlayer();
};

// ------- Play button -------
playBtn.addEventListener('click', () => {
  playbackQueue = playbackQueue
    .catch(() => {})
    .then(() => runPlaybackSequence());
  playbackQueue.catch(() => {});
});

pauseBtn?.addEventListener('click', () => {
  Promise.resolve(handlePauseRequest()).catch(err => {
    console.error('Pause button failed', err);
    if (err && err.message) {
      setStatus('Pause impossible: ' + err.message);
    } else {
      setStatus('Pause impossible.');
    }
  });
});

fullTrackToggle?.addEventListener('change', () => {
  setFullTrackMode(fullTrackToggle.checked, { persist: true });
});

// ------- Reveal button (hold to reveal) -------
function beginRevealHold() {
  if (!revealBtn || holdActive || revealBtn.disabled) {
    return;
  }
  holdActive = true;
  revealHoldTriggered = false;
  startHapticFeedback();
  revealBtn.classList.add('is-holding');
  revealHoldTimer = setTimeout(() => {
    revealHoldTimer = null;
    revealHoldTriggered = true;
    Promise.resolve(showReveal())
      .catch(err => console.error('Reveal failed', err))
      .finally(() => finishRevealHold(true));
  }, HOLD_THRESHOLD_MS);
}

function finishRevealHold(triggered = false) {
  if (revealHoldTimer) {
    clearTimeout(revealHoldTimer);
    revealHoldTimer = null;
  }
  stopHapticFeedback();
  revealBtn?.classList.remove('is-holding');
  holdActive = false;
  if (!triggered) {
    revealHoldTriggered = false;
  }
}

function settlePointerHold() {
  const triggered = revealHoldTriggered;
  finishRevealHold(triggered);
  revealHoldTriggered = false;
  keyboardHoldActive = false;
}

function cancelKeyboardHold() {
  if (!keyboardHoldActive) {
    return;
  }
  const triggered = revealHoldTriggered;
  finishRevealHold(triggered);
  revealHoldTriggered = false;
  keyboardHoldActive = false;
}

if (revealBtn) {
  const pointerDownHandler = event => {
    if (revealBtn.disabled) {
      return;
    }
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    if (event.pointerType === 'touch') {
      event.preventDefault();
    }
    if (typeof revealBtn.setPointerCapture === 'function' && event.pointerId != null) {
      try {
        revealBtn.setPointerCapture(event.pointerId);
      } catch (err) {
        // Ignore pointer capture errors
      }
    }
    beginRevealHold();
  };

  revealBtn.addEventListener('pointerdown', pointerDownHandler, { passive: false });
  revealBtn.addEventListener('pointerup', settlePointerHold);
  revealBtn.addEventListener('pointerleave', settlePointerHold);
  revealBtn.addEventListener('pointercancel', settlePointerHold);

  revealBtn.addEventListener('keydown', event => {
    if (revealBtn.disabled) {
      return;
    }
    if (event.code !== 'Space' && event.code !== 'Enter') {
      return;
    }
    if (keyboardHoldActive) {
      return;
    }
    keyboardHoldActive = true;
    event.preventDefault();
    beginRevealHold();
  });

  revealBtn.addEventListener('keyup', event => {
    if (event.code !== 'Space' && event.code !== 'Enter') {
      return;
    }
    event.preventDefault();
    cancelKeyboardHold();
  });

  revealBtn.addEventListener('blur', () => {
    cancelKeyboardHold();
  });

  revealBtn.addEventListener('contextmenu', event => {
    event.preventDefault();
  });
}

// ------- Next button -------
nextBtn.addEventListener('click', () => {
  setStatus('Scan the next QR code!');
});

// ------- Scanner controls -------
async function requestScannerStream() {
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    throw new Error('mediaDevices.getUserMedia not available');
  }
  if (mediaStream && !mediaStream.active) {
    mediaStream = null;
    scannerStreamPromise = null;
  }
  if (mediaStream && mediaStream.active) {
    return mediaStream;
  }
  if (scannerStreamPromise) {
    return scannerStreamPromise;
  }
  const constraints = {
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1280 },
      height: { ideal: 720 }
    },
    audio: false
  };
  scannerStreamPromise = navigator.mediaDevices
    .getUserMedia(constraints)
    .then(stream => {
      mediaStream = stream;
      stream.getTracks().forEach(track => {
        track.addEventListener(
          'ended',
          () => {
            if (mediaStream === stream && track.readyState === 'ended') {
              mediaStream = null;
              scannerStreamPromise = null;
            }
          },
          { once: true }
        );
      });
      return stream;
    })
    .catch(err => {
      scannerStreamPromise = null;
      throw err;
    });
  return scannerStreamPromise;
}

openScannerBtn?.addEventListener('click', async () => {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setScannerMessage('Caméra indisponible sur cet appareil.');
    return;
  }
  if (typeof jsQR !== 'function') {
    setScannerMessage('Bibliothèque jsQR indisponible.');
    return;
  }
  toggleScannerPane(true);
  try {
    setScannerMessage('Ouverture de la caméra…');
    const stream = await requestScannerStream();
    stream.getVideoTracks().forEach(track => {
      track.enabled = true;
    });
    if (qrVideo) {
      qrVideo.srcObject = stream;
      await qrVideo.play();
    }
    scanRunning = true;
    scheduleScannerInactivityStop();
    setScannerMessage('Scanne un QR…');
    scanLoop();
  } catch (err) {
    console.error('Unable to open camera', err);
    setScannerMessage('Permission caméra refusée ou indisponible.');
    stopScanner({ release: true });
    toggleScannerPane(false);
  }
});

closeScannerBtn?.addEventListener('click', () => {
  stopScanner();
  toggleScannerPane(false);
  setScannerMessage('Caméra fermée');
});

if (typeof window !== 'undefined') {
  const releaseCamera = () => {
    stopScanner({ release: true });
  };
  window.addEventListener('pagehide', releaseCamera);
  window.addEventListener('beforeunload', releaseCamera);
}
