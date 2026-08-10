(() => {
  const body = document.body;
  const titleBar = document.getElementById('titleBar');
  const themeToggle = document.getElementById('themeToggle');
  const title = body.dataset.title || 'Dashboard';
  titleBar.textContent = title;

  function getTheme() {
    return localStorage.getItem('dashboard_theme') || 'light';
  }
  
  function setTheme(t) { 
    document.body.setAttribute('data-theme', t); 
    localStorage.setItem('dashboard_theme', t); 
  }
  
  themeToggle.onclick = () => { 
    const cur = getTheme(); 
    setTheme(cur === 'dark' ? 'light' : 'dark'); 
  };
  
  setTheme(getTheme());

  // External link to the Chat surface (open in new tab)
  try {
    const loc = window.location;
    const lnkChat = document.getElementById('lnkChat');
    if (lnkChat) lnkChat.href = `${loc.origin}/webchat/`;
  } catch(_) {}

  // Tab navigation
  const tabs = Array.from(document.querySelectorAll('.wa-header-tab'));
  const views = ['status', 'logs', 'agents', 'control'];

  const dashboardBasePath = (() => {
    const rawBase = String(body.dataset.base || '/dashboard').trim();
    const safeBase = rawBase.startsWith('/') && !rawBase.startsWith('//')
      ? rawBase
      : '/dashboard';
    return safeBase.replace(/\/+$/, '') || '/dashboard';
  })();

  function dashboardPath(path) {
    const suffix = String(path || '').replace(/^\/+/, '');
    return `${dashboardBasePath}/${suffix}`;
  }

  let adminControlPromise = null;
  function loadAdminControl() {
    if (!adminControlPromise) {
      adminControlPromise = fetch('/auth/token', {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
      }).then(async (res) => {
        const payload = await res.json().catch(() => ({}));
        const proof = payload && payload.adminControl;
        if (!res.ok || !proof || !proof.csrfToken || proof.origin !== window.location.origin) {
          throw new Error('Administrator control proof is unavailable.');
        }
        return proof;
      }).catch((error) => {
        adminControlPromise = null;
        throw error;
      });
    }
    return adminControlPromise;
  }
  
  function setTab(name) { 
    tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === name)); 
    views.forEach(v => {
      const view = document.getElementById('view-' + v);
      if (view) view.classList.toggle('active', v === name);
    });
  }
  
  tabs.forEach(t => t.addEventListener('click', () => setTab(t.dataset.tab)));

  // /run helper
  async function run(cmd) { 
    const adminControl = await loadAdminControl();
    const res = await fetch(dashboardPath('run'), { 
      method: 'POST', 
      headers: {
        'Content-Type': 'application/json',
        'X-Ploinky-CSRF-Token': adminControl.csrfToken,
      },
      credentials: 'include',
      keepalive: true,
      body: JSON.stringify({ cmd }) 
    }); 
    const j = await res.json().catch(() => ({ok: false})); 
    return j; 
  }

  // Status
  const statusOut = document.getElementById('statusOut');
  
  async function refreshStatus() { 
    statusOut.textContent = 'Loading...';
    const j = await run('status'); 
    statusOut.textContent = (j.stdout || j.stderr || '[no output]'); 
  }
  
  document.getElementById('refreshStatus').onclick = refreshStatus;
  refreshStatus();

  // Logs
  const logsOut = document.getElementById('logsOut');
  const logCount = document.getElementById('logCount');
  
  // The CLI accepts one exact integer between 1 and 10000 and rejects
  // fractions, signs, partial integers, and NaN. `parseInt` forwarded '12abc'
  // as 12 and an empty field as NaN, so validate strictly here and never send
  // a value the CLI is going to refuse.
  const MAX_LOG_LINES = 10000;
  const DEFAULT_LOG_LINES = 200;
  function exactLogLineCount(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return DEFAULT_LOG_LINES;
    if (!/^[1-9][0-9]*$/.test(text)) return null;
    const value = Number(text);
    return Number.isSafeInteger(value) && value >= 1 && value <= MAX_LOG_LINES ? value : null;
  }

  async function refreshLogs() {
    const n = exactLogLineCount(logCount.value);
    if (n === null) {
      logsOut.textContent = `Enter a whole number of lines between 1 and ${MAX_LOG_LINES}.`;
      return;
    }
    const j = await run(`logs last ${n}`);
    logsOut.textContent = j.stdout || j.stderr || '[no output]';
  }
  
  setInterval(refreshLogs, 1000);
  refreshLogs();

  // Agents
  const agentsList = document.getElementById('agentsList');

  // Parse active agents from status command output
  function parseActiveAgents(text) {
    const agents = [];
    const lines = (text || '').split('\n');

    lines.forEach(line => {
      // Look for patterns like "Agent: agentName (port: 12345)"
      const match = line.match(/Agent:\s*([A-Za-z0-9_.-]+)\s*\(port:\s*(\d+)\)/i);
      if (match) {
        agents.push({
          name: match[1],
          port: match[2],
          status: 'running'
        });
      }
    });

    return agents;
  }
  
  async function refreshAgents() {
    agentsList.innerHTML = '<div style="color: var(--wa-text-secondary);">Loading active agents...</div>';

    // Get active agents from status command
    const j = await run('status');
    const out = j.stdout || j.stderr || '';
    const agents = parseActiveAgents(out); 
    
    agentsList.innerHTML = ''; 
    
    if (!agents.length) { 
      const d = document.createElement('div'); 
      d.textContent = 'No agents found'; 
      d.style.color = 'var(--wa-text-secondary)';
      d.style.padding = '12px';
      d.style.textAlign = 'center';
      agentsList.appendChild(d); 
      return; 
    } 
    
    agents.forEach(agent => { 
      const item = document.createElement('div'); 
      item.className = 'wa-agent-item'; 
      
      const avatar = document.createElement('div');
      avatar.className = 'wa-agent-avatar';
      avatar.textContent = agent.name.charAt(0).toUpperCase();
      
      const info = document.createElement('div');
      info.className = 'wa-agent-info';
      
      const agentName = document.createElement('div');
      agentName.className = 'wa-agent-name';
      agentName.textContent = agent.name;
      
      const status = document.createElement('div');
      status.className = 'wa-agent-status';
      status.textContent = `Running on port ${agent.port}`;
      
      info.appendChild(agentName);
      info.appendChild(status);
      
      const actions = document.createElement('div');
      actions.className = 'wa-agent-actions';
      
      const btn = document.createElement('button');
      btn.className = 'wa-agent-btn';
      btn.textContent = 'Restart';
      btn.onclick = async () => {
        btn.disabled = true;
        btn.textContent = 'Restarting…';
        status.textContent = 'Restarting…';

        const r = await run(`restart ${agent.name}`);
        if (r.stdout) {
          status.textContent = `Running on port ${agent.port}`;
          btn.textContent = 'Restart';
          btn.disabled = false;
        } else {
          status.textContent = 'Check output';
          btn.textContent = 'Retry';
          btn.disabled = false;
        }
      };
      
      actions.appendChild(btn);
      item.appendChild(avatar);
      item.appendChild(info);
      item.appendChild(actions);
      agentsList.appendChild(item); 
    }); 
  }
  
  document.getElementById('refreshAgents').onclick = refreshAgents;
  refreshAgents();

  // Debug Popup
  const debugPopup = document.getElementById('debugPopup');
  const debugBtn = document.getElementById('debugBtn');
  const debugClose = document.getElementById('debugClose');
  const debugSend = document.getElementById('debugSend');
  const debugJson = document.getElementById('debugJson');
  const debugError = document.getElementById('debugError');
  const debugResponse = document.getElementById('debugResponse');
  const debugAgentName = document.getElementById('debugAgentName');
  const debugAgentPort = document.getElementById('debugAgentPort');

  // Store current active agents for debug
  let activeAgents = [];

  // Update active agents when refreshing
  const originalRefreshAgents = refreshAgents;
  refreshAgents = async function() {
    await originalRefreshAgents();
    // Re-parse to get the list for debug
    const j = await run('status');
    activeAgents = parseActiveAgents(j.stdout || '');
  };

  debugBtn.onclick = () => {
    debugPopup.style.display = 'block';
    debugError.textContent = '';
    debugResponse.style.display = 'none';
    debugResponse.textContent = '';

    // Pre-fill with first active agent if available
    if (activeAgents.length > 0) {
      debugAgentName.value = activeAgents[0].name;
      debugAgentPort.value = activeAgents[0].port;
    }
  };

  debugClose.onclick = () => {
    debugPopup.style.display = 'none';
  };

  debugSend.onclick = async () => {
    debugError.textContent = '';
    debugResponse.style.display = 'none';

    const agentName = debugAgentName.value.trim();
    const port = debugAgentPort.value || '';
    const jsonText = debugJson.value;

    if (!agentName) {
      debugError.textContent = 'Please enter an agent name';
      return;
    }

    // Validate JSON
    let jsonData;
    try {
      jsonData = JSON.parse(jsonText);
    } catch(e) {
      debugError.textContent = `Invalid JSON: ${e.message}`;
      return;
    }

    // Send to agent
    debugSend.disabled = true;
    debugSend.textContent = 'Sending...';

    try {
      // Use port if provided, otherwise let routing handle it
      const endpoint = port ? `http://localhost:${port}/mcp` : `/${agentName}/mcp`;

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'dashboard-debug',
          agent: agentName,
          ...jsonData
        })
      });

      const result = await response.text();

      debugResponse.style.display = 'block';
      debugResponse.textContent = `Response (${response.status}):\n${result}`;

      // Try to pretty print if it's JSON
      try {
        const parsed = JSON.parse(result);
        debugResponse.textContent = `Response (${response.status}):\n${JSON.stringify(parsed, null, 2)}`;
      } catch(e) {
        // Keep as plain text
      }

    } catch(error) {
      debugError.textContent = `Error: ${error.message}`;
      debugResponse.style.display = 'block';
      debugResponse.textContent = `Connection error: ${error.message}`;
    } finally {
      debugSend.disabled = false;
      debugSend.textContent = 'Send';
    }
  };

  // Control
  const ctrlOut = document.getElementById('ctrlOut');
  
  document.getElementById('restartBtn').onclick = async() => { 
    if (!confirm('Are you sure you want to restart the system?')) return;
    
    ctrlOut.textContent = 'Restarting system...'; 
    const r = await run('restart'); 
    ctrlOut.textContent = r.stdout || r.stderr || '[no output]'; 
  };
})();
