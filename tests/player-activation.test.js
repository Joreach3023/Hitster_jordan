const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const APP_JS_PATH = path.join(__dirname, '..', 'app.js');
const APP_SOURCE = fs.readFileSync(APP_JS_PATH, 'utf8');

async function flush() {
  await new Promise(resolve => setTimeout(resolve, 0));
}

async function runScenario({ activationShouldFail = false, playClicks = 1, deviceResponses = [] }) {
  const dom = new JSDOM(
    `<!DOCTYPE html><body>
      <div id="status"></div>
      <button id="loginBtn"></button>
      <button id="playBtn"></button>
      <button id="pauseBtn"></button>
      <button id="revealBtn"></button>
      <button id="nextBtn"></button>
      <div id="timer"></div>
      <div id="reveal" hidden>
        <span id="title"></span>
        <span id="year"></span>
      </div>
    </body>`,
    {
      url: 'https://local.test/?token=test-token&t=spotify:track:TESTURI'
    }
  );

  const { window } = dom;
  const { document } = window;

  const activeIntervals = new Set();
  const wrappedSetInterval = (fn, ms) => {
    const id = setInterval(fn, ms);
    activeIntervals.add(id);
    return id;
  };
  const wrappedClearInterval = id => {
    activeIntervals.delete(id);
    clearInterval(id);
  };

  const fetchCalls = [];
  const deviceResponsesQueue = Array.isArray(deviceResponses) ? deviceResponses.slice() : [];
  const fetchStub = async (url, options = {}) => {
    fetchCalls.push({ url, options });
    if (url === 'https://api.spotify.com/v1/me/player/devices') {
      const payload = deviceResponsesQueue.length ? deviceResponsesQueue.shift() : {};
      return {
        ok: true,
        json: async () => payload,
      };
    }
    return {
      ok: true,
      json: async () => ({}),
    };
  };

  let activateCalls = 0;
  const consoleStub = {
    log: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  class MockPlayer {
    constructor(opts) {
      this.opts = opts;
      this.listeners = {};
    }
    addListener(event, cb) {
      this.listeners[event] = cb;
    }
    connect() {
      if (this.listeners.ready) {
        this.listeners.ready({ device_id: 'device123' });
      }
      return Promise.resolve(true);
    }
    activateElement() {
      activateCalls += 1;
      if (activationShouldFail) {
        return Promise.reject(new Error('Activation blocked'));
      }
      return Promise.resolve();
    }
  }

  window.Spotify = { Player: MockPlayer };

  const context = {
    window,
    document,
    location: window.location,
    URLSearchParams: window.URLSearchParams,
    fetch: fetchStub,
    console: consoleStub,
    setTimeout,
    clearTimeout,
    setInterval: wrappedSetInterval,
    clearInterval: wrappedClearInterval,
    Spotify: window.Spotify,
  };
  context.self = window;
  context.global = window;
  context.navigator = window.navigator;
  window.fetch = fetchStub;
  window.setInterval = wrappedSetInterval;
  window.clearInterval = wrappedClearInterval;
  window.console = consoleStub;

  vm.runInNewContext(APP_SOURCE, context, { filename: 'app.js' });

  if (typeof window.onSpotifyWebPlaybackSDKReady === 'function') {
    window.onSpotifyWebPlaybackSDKReady();
  }

  await flush();

  const playBtn = document.getElementById('playBtn');

  for (let i = 0; i < playClicks; i += 1) {
    playBtn.click();
    await flush();
    await flush();
  }

  const statusText = document.getElementById('status').textContent;
  const timerText = document.getElementById('timer').textContent;
  const pauseDisabled = document.getElementById('pauseBtn').disabled;

  activeIntervals.forEach(id => clearInterval(id));

  return {
    activateCalls,
    fetchCalls,
    statusText,
    timerText,
    pauseDisabled,
  };
}

(async () => {
  const success = await runScenario({ activationShouldFail: false, playClicks: 2 });
  assert.strictEqual(success.activateCalls, 1, 'activateElement should be invoked once for repeated plays');
  assert.strictEqual(success.fetchCalls.length, 5, 'should avoid redundant device transfers after the first play');
  assert.strictEqual(success.fetchCalls[0].url, 'https://api.spotify.com/v1/me/player/devices');
  assert.strictEqual(success.fetchCalls[1].url, 'https://api.spotify.com/v1/me/player');
  assert.strictEqual(success.fetchCalls[2].url, 'https://api.spotify.com/v1/me/player/play?device_id=device123');
  assert.strictEqual(success.fetchCalls[3].url, 'https://api.spotify.com/v1/me/player/devices');
  assert.strictEqual(success.fetchCalls[4].url, 'https://api.spotify.com/v1/me/player/play?device_id=device123');
  assert.strictEqual(success.statusText, 'Playing...');
  assert.strictEqual(success.timerText, '30');
  assert.strictEqual(success.pauseDisabled, false, 'pause button should be enabled after successful playback');

  const failure = await runScenario({ activationShouldFail: true, playClicks: 1 });
  assert.strictEqual(failure.activateCalls, 1, 'activateElement should be attempted once');
  assert.strictEqual(failure.fetchCalls.length, 1, 'only device discovery should be attempted when activation fails');
  assert.strictEqual(failure.fetchCalls[0].url, 'https://api.spotify.com/v1/me/player/devices');
  assert.strictEqual(failure.statusText, 'Tap allow audio to enable playback on this device.');
  assert.strictEqual(failure.pauseDisabled, true, 'pause button should remain disabled when activation fails');

  const remote = await runScenario({
    activationShouldFail: false,
    playClicks: 1,
    deviceResponses: [{ devices: [{ id: 'speaker123', is_active: true }] }],
  });
  assert.strictEqual(remote.activateCalls, 0, 'activateElement should not run when using a remote device');
  assert.strictEqual(remote.fetchCalls.length, 2, 'remote playback should avoid SDK transfer calls');
  assert.strictEqual(remote.fetchCalls[0].url, 'https://api.spotify.com/v1/me/player/devices');
  assert.strictEqual(remote.fetchCalls[1].url, 'https://api.spotify.com/v1/me/player/play?device_id=speaker123');
  assert.strictEqual(remote.statusText, 'Playing...');
  assert.strictEqual(remote.pauseDisabled, false, 'pause button should be enabled for remote playback');

  console.log('All tests passed');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
