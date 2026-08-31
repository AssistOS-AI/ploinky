(() => {
  'use strict';

  const launchPattern = /^[A-Za-z0-9_-]{32}$/;
  const raw = String(window.location.hash || '').replace(/^#/, '');
  let launch = '';
  try {
    const values = new URLSearchParams(raw);
    const keys = [...values.keys()];
    const candidate = values.get('launch') || '';
    if (keys.length === 1 && keys[0] === 'launch' && launchPattern.test(candidate)) {
      launch = candidate;
    }
  } catch (_) { }

  let stripped = false;
  try {
    window.history.replaceState(null, '', window.location.pathname || '/webtty/');
    stripped = true;
  } catch (_) { }
  if (!stripped) launch = '';

  let consumed = false;
  Object.defineProperty(window, '__ploinkyTakeWebttyLaunch', {
    configurable: true,
    enumerable: false,
    value() {
      if (consumed) return '';
      consumed = true;
      const value = launch;
      launch = '';
      try { delete window.__ploinkyTakeWebttyLaunch; } catch (_) { }
      return value;
    },
  });
})();
