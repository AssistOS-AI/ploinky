(() => {
  const body = document.body;
  const titleBar = document.getElementById('titleBar');
  const themeToggle = document.getElementById('themeToggle');
  const statusLabel = document.getElementById('statusLabel');
  const statusDot = document.getElementById('statusDot');
  const componentsList = document.getElementById('componentsList');
  const linksList = document.getElementById('linksList');

  const agentName = body.dataset.agent || 'Status';
  titleBar.textContent = agentName === 'Status' ? 'Public Ploinky Status' : `${agentName} Status`;

  const basePath = String(body.dataset.base || '').replace(/\/$/, '');
  const toEndpoint = (path) => {
    const suffix = String(path || '').replace(/^\/+/, '');
    return (basePath ? basePath : '') + '/' + suffix;
  };

  function getTheme() {
    return localStorage.getItem('status_theme') || 'light';
  }

  function setTheme(theme) {
    body.setAttribute('data-theme', theme);
    localStorage.setItem('status_theme', theme);
  }

  themeToggle.addEventListener('click', () => {
    setTheme(getTheme() === 'dark' ? 'light' : 'dark');
  });
  setTheme(getTheme());

  async function refreshStatus() {
    try {
      statusLabel.textContent = 'updating…';
      statusDot.style.background = '#ffb020';
      const res = await fetch(toEndpoint('data'));
      if (!res.ok) throw new Error('Request failed');
      const data = await res.json();
      statusLabel.textContent = 'online';
      statusDot.style.background = '#00a884';
      renderComponents(data.servers || {}, data.static || {}, data.agents || []);
      renderLinks(data.servers || {}, data.static || {});
    } catch (err) {
      statusLabel.textContent = 'error';
      statusDot.style.background = '#f15c6d';
      if (componentsList) componentsList.innerHTML = '<div class="ps-item">Failed to retrieve status</div>';
    }
  }



  function renderComponents(servers, staticInfo, agents) {
    if (!componentsList) return;
    const cards = [];

    // Add server components
    const entries = Object.entries(servers || {});
    entries.forEach(([key, info]) => {
      const name = info.displayName || key;
      const configured = Boolean(info.agent || info.command || info.port);
      const pillClass = configured ? '' : ' default';
      const label = configured ? 'service' : 'built-in';
      cards.push(`<div class="ps-item"><div class="ps-item-title">${name}<span class="ps-pill${pillClass}">${label}</span></div><div class="ps-item-status"></div></div>`);
    });

    // Add static agent if present
    if (staticInfo && staticInfo.agent) {
      const agentName = staticInfo.agent;
      const repoName = staticInfo.repo || 'unknown';
      cards.push(`<div class="ps-item"><div class="ps-item-title">Agent "${agentName}"<span class="ps-pill">static</span></div><div class="ps-item-status">from repo ${repoName}</div></div>`);
    }

    // Add enabled agents
    agents.forEach(info => {
      const name = info.agentName || info.container;
      const repo = info.repoName || 'unknown';
      // Skip if this is the static agent (already shown above)
      if (staticInfo && staticInfo.agent === name) return;
      cards.push(`<div class="ps-item"><div class="ps-item-title">Agent "${name}"</div><div class="ps-item-status">from repo ${repo}</div></div>`);
    });

    if (!cards.length) {
      componentsList.innerHTML = '<div class="ps-item">No components or agents active</div>';
      return;
    }
    componentsList.innerHTML = cards.join('');
  }

 function renderLinks(servers, staticInfo) {
    if (!linksList) return;
    const entries = [
      { label: 'Dashboard', href: '/dashboard', note: 'through router' },
      { label: 'WebChat', href: '/webchat', note: 'through router' }
    ];
    linksList.innerHTML = entries.map(entry => (
      `<a class="ps-link" href="${entry.href}" target="_blank" rel="noopener noreferrer">` +
        `<div class="ps-link-title">${entry.label}</div>` +
        `<div class="ps-link-note">${entry.note}</div>` +
      `</a>`
    )).join('');
  }


  setInterval(refreshStatus, 4000);
  refreshStatus();
})();
