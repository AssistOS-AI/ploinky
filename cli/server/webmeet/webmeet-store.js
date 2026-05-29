(() => {
  const subscribers = new Set();

  const initialTheme = (() => {
    try { return localStorage.getItem('webmeet_theme') || 'light'; }
    catch (_) { return 'light'; }
  })();

  const state = {
    connected: false,
    joined: false,
    participants: [],
    queue: [],
    currentSpeaker: null,
    myEmail: '',
    handRaised: false,
    isMuted: true,
    cameraOn: false,
    isDeafened: false,
    selectedParticipant: null,
    screenOn: false,
    remoteMedia: {},
    theme: initialTheme,
  };

  function notify() {
    for (const fn of subscribers) {
      try { fn(state); } catch (err) { console.error('[WebMeetStore] subscriber error', err); }
    }
  }

  function getState() { return state; }

  function setState(patch) {
    Object.assign(state, patch);
    notify();
  }

  function update(updater) {
    if (typeof updater === 'function') {
      const next = updater({ ...state });
      if (next && typeof next === 'object') {
        Object.assign(state, next);
        notify();
      }
    }
  }

  function patchPath(path, value) {
    const keys = path.split('.');
    let target = state;
    for (let i = 0; i < keys.length - 1; i += 1) {
      const key = keys[i];
      if (!(key in target)) target[key] = {};
      target = target[key];
    }
    target[keys[keys.length - 1]] = value;
    notify();
  }

  function subscribe(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }

  window.WebMeetStore = {
    getState,
    setState,
    update,
    patchPath,
    subscribe
  };
})();
