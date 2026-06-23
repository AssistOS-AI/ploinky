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
  const views = ['status', 'logs', 'transcripts', 'feedback', 'agents', 'control'];
  let transcriptListLoaded = false;
  let feedbackLoaded = false;

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
  
  function setTab(name) { 
    tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === name)); 
    views.forEach(v => {
      const view = document.getElementById('view-' + v);
      if (view) view.classList.toggle('active', v === name);
    });
    if (name === 'transcripts' && !transcriptListLoaded) {
      loadTranscripts();
    }
    if (name === 'feedback' && !feedbackLoaded) {
      loadFeedback();
    }
  }
  
  tabs.forEach(t => t.addEventListener('click', () => setTab(t.dataset.tab)));

  // /run helper
  async function run(cmd) { 
    const res = await fetch(dashboardPath('run'), { 
      method: 'POST', 
      headers: {'Content-Type': 'application/json'}, 
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
  
  async function refreshLogs() { 
    const n = Math.max(1, parseInt(logCount.value || '200', 10));
    const j = await run(`logs last ${n}`);
    logsOut.textContent = j.stdout || j.stderr || '[no output]'; 
  }
  
  setInterval(refreshLogs, 1000);
  refreshLogs();

  // Transcripts
  const transcriptList = document.getElementById('transcriptList');
  const transcriptDetail = document.getElementById('transcriptDetail');
  const transcriptRetentionMeta = document.getElementById('transcriptRetentionMeta');
  const refreshTranscriptsBtn = document.getElementById('refreshTranscripts');
  let activeConversationId = null;

  function formatDateTime(value) {
    if (!value) return 'n/a';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString();
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderTranscriptList(conversations) {
    transcriptList.innerHTML = '';
    if (!Array.isArray(conversations) || !conversations.length) {
      transcriptList.innerHTML = '<div class="wa-transcript-empty">No transcript conversations found.</div>';
      transcriptDetail.innerHTML = '<div class="wa-transcript-empty">Select a conversation.</div>';
      return;
    }
    conversations.forEach((conversation) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'wa-transcript-item';
      if (conversation.conversationId === activeConversationId) {
        button.classList.add('active');
      }
      button.innerHTML = `
        <div><strong>${escapeHtml(conversation.agentName || 'webchat')}</strong></div>
        <small>${escapeHtml(conversation.runtime || 'local')} · ${escapeHtml(conversation.authMode || 'session')}</small>
        <div class="wa-transcript-meta">${escapeHtml(formatDateTime(conversation.updatedAt))}</div>
        <div class="wa-transcript-meta">${conversation.messageCount || 0} messages</div>
      `;
      button.addEventListener('click', () => {
        activeConversationId = conversation.conversationId;
        loadTranscriptDetail(conversation.conversationId);
        renderTranscriptList(conversations);
      });
      transcriptList.appendChild(button);
    });
  }

  function renderTranscriptDetail(conversation) {
    if (!conversation) {
      transcriptDetail.innerHTML = '<div class="wa-transcript-empty">Select a conversation.</div>';
      return;
    }

    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    const header = document.createElement('div');
    header.className = 'wa-transcript-message';
    header.innerHTML = `
      <div class="wa-transcript-message-header">
        <span>${escapeHtml(conversation.agentName || 'webchat')}</span>
        <span>${escapeHtml(formatDateTime(conversation.updatedAt))}</span>
      </div>
      <div class="wa-transcript-meta">Created: ${escapeHtml(formatDateTime(conversation.createdAt))}</div>
      <div class="wa-transcript-meta">Messages: ${messages.length}</div>
      <div class="wa-transcript-meta">Retention: ${escapeHtml(String(conversation.retentionDays || '?'))} days</div>
    `;

    transcriptDetail.innerHTML = '';
    transcriptDetail.appendChild(header);

    if (!messages.length) {
      const empty = document.createElement('div');
      empty.className = 'wa-transcript-empty';
      empty.textContent = 'No messages stored for this conversation.';
      transcriptDetail.appendChild(empty);
      return;
    }

    messages.forEach((message) => {
      const item = document.createElement('div');
      item.className = 'wa-transcript-message';
      item.dataset.role = message.role || 'assistant';
      const metadata = message.metadata && typeof message.metadata === 'object' ? message.metadata : {};
      const attachments = Array.isArray(message.attachments) ? message.attachments : [];
      const attachmentLines = attachments.map((attachment) => {
        const fileName = attachment?.filename || attachment?.id || 'attachment';
        const mime = attachment?.mime ? ` · ${attachment.mime}` : '';
        return `<div>${escapeHtml(fileName)}${escapeHtml(mime)}</div>`;
      }).join('');
      const feedbackLabel = message.rating === 'up'
        ? '👍 positive'
        : message.rating === 'down'
          ? '👎 negative'
          : '';
      const pairLines = [
        metadata.turnId ? `Turn: ${escapeHtml(metadata.turnId)}` : '',
        metadata.promptMessageId ? `Prompt: ${escapeHtml(metadata.promptMessageId)}` : '',
        metadata.replyMessageId ? `Reply: ${escapeHtml(metadata.replyMessageId)}` : '',
        feedbackLabel ? `Feedback: ${escapeHtml(feedbackLabel)}` : ''
      ].filter(Boolean).map((line) => `<div class="wa-transcript-meta">${line}</div>`).join('');
      item.innerHTML = `
        <div class="wa-transcript-message-header">
          <span>${escapeHtml(message.role || 'assistant')}</span>
          <span>${escapeHtml(formatDateTime(message.createdAt))}</span>
        </div>
        ${pairLines}
        <pre class="wa-transcript-message-text">${escapeHtml(message.text || '')}</pre>
        ${attachmentLines ? `<div class="wa-transcript-attachments">${attachmentLines}</div>` : ''}
      `;
      transcriptDetail.appendChild(item);
    });
  }

  async function loadTranscriptDetail(conversationId) {
    if (!conversationId) {
      renderTranscriptDetail(null);
      return;
    }
    transcriptDetail.innerHTML = '<div class="wa-transcript-empty">Loading transcript…</div>';
    try {
      const response = await fetch(dashboardPath(`api/transcripts/${encodeURIComponent(conversationId)}`), {
        credentials: 'same-origin'
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) {
        throw new Error(payload.detail || payload.error || 'Failed to load transcript');
      }
      renderTranscriptDetail(payload.conversation);
    } catch (error) {
      transcriptDetail.innerHTML = `<div class="wa-transcript-empty">${escapeHtml(error.message || 'Failed to load transcript.')}</div>`;
    }
  }

  async function loadTranscripts() {
    transcriptListLoaded = true;
    transcriptList.innerHTML = '<div class="wa-transcript-empty">Loading…</div>';
    try {
      const response = await fetch(dashboardPath('api/transcripts?limit=100'), {
        credentials: 'same-origin'
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) {
        throw new Error(payload.detail || payload.error || 'Transcript access denied');
      }
      transcriptRetentionMeta.textContent = `Encrypted at rest · retention ${payload.retentionDays || '?'} days`;
      const conversations = Array.isArray(payload.conversations) ? payload.conversations : [];
      if (!activeConversationId && conversations.length) {
        activeConversationId = conversations[0].conversationId;
      } else if (activeConversationId && !conversations.some((item) => item.conversationId === activeConversationId)) {
        activeConversationId = conversations[0]?.conversationId || null;
      }
      renderTranscriptList(conversations);
      if (activeConversationId) {
        loadTranscriptDetail(activeConversationId);
      } else {
        renderTranscriptDetail(null);
      }
    } catch (error) {
      transcriptRetentionMeta.textContent = '';
      transcriptList.innerHTML = `<div class="wa-transcript-empty">${escapeHtml(error.message || 'Failed to load transcripts.')}</div>`;
      transcriptDetail.innerHTML = '<div class="wa-transcript-empty">Transcript viewer unavailable.</div>';
    }
  }

  refreshTranscriptsBtn.onclick = loadTranscripts;

  // Feedback
  const feedbackSummary = document.getElementById('feedbackSummary');
  const feedbackAgents = document.getElementById('feedbackAgents');
  const feedbackTurns = document.getElementById('feedbackTurns');
  const feedbackRetentionMeta = document.getElementById('feedbackRetentionMeta');
  const refreshFeedbackBtn = document.getElementById('refreshFeedback');
  const feedbackFilter = document.getElementById('feedbackFilter');

  function percentageLabel(value) {
    const numeric = Number(value) || 0;
    return `${(numeric * 100).toFixed(1)}%`;
  }

  function summarizeText(value, max = 280) {
    const safe = String(value || '').trim().replace(/\s+/g, ' ');
    if (!safe) {
      return '—';
    }
    if (safe.length <= max) {
      return safe;
    }
    return `${safe.slice(0, max - 1)}…`;
  }

  function renderFeedbackSummary(summary) {
    const metrics = [
      { label: 'Rated turns', value: summary?.ratedTurns ?? 0 },
      { label: 'Likes', value: summary?.positiveTurns ?? 0 },
      { label: 'Dislikes', value: summary?.negativeTurns ?? 0 },
      { label: 'Positive rate', value: percentageLabel(summary?.positiveRate) },
      { label: 'Conversations', value: summary?.conversations ?? 0 }
    ];
    feedbackSummary.innerHTML = metrics.map((metric) => `
      <div class="wa-feedback-metric">
        <div class="wa-feedback-metric-label">${escapeHtml(metric.label)}</div>
        <div class="wa-feedback-metric-value">${escapeHtml(metric.value)}</div>
      </div>
    `).join('');
  }

  function renderFeedbackAgents(agents) {
    feedbackAgents.innerHTML = '';
    if (!Array.isArray(agents) || !agents.length) {
      feedbackAgents.innerHTML = '<div class="wa-transcript-empty">No rated turns found.</div>';
      return;
    }
    agents.forEach((agent) => {
      const row = document.createElement('div');
      row.className = 'wa-feedback-agent-row';
      row.innerHTML = `
        <div>
          <div class="wa-feedback-agent-name">${escapeHtml(agent.agentName || 'webchat')}</div>
          <div class="wa-transcript-meta">${escapeHtml(String(agent.ratedTurns || 0))} rated turns</div>
        </div>
        <div class="wa-feedback-agent-stats">
          <div>👍 ${escapeHtml(String(agent.positiveTurns || 0))}</div>
          <div>👎 ${escapeHtml(String(agent.negativeTurns || 0))}</div>
          <div>${escapeHtml(percentageLabel(agent.positiveRate))} positive</div>
        </div>
      `;
      feedbackAgents.appendChild(row);
    });
  }

  function openTurnTranscript(conversationId) {
    if (!conversationId) {
      return;
    }
    activeConversationId = conversationId;
    transcriptListLoaded = false;
    setTab('transcripts');
    loadTranscripts();
  }

  function renderFeedbackTurns(turns) {
    feedbackTurns.innerHTML = '';
    if (!Array.isArray(turns) || !turns.length) {
      feedbackTurns.innerHTML = '<div class="wa-transcript-empty">No rated turns match this filter.</div>';
      return;
    }
    turns.forEach((turn) => {
      const item = document.createElement('div');
      item.className = 'wa-feedback-turn';
      item.innerHTML = `
        <div class="wa-feedback-turn-header">
          <span>${escapeHtml(turn.agentName || 'webchat')} · ${escapeHtml(formatDateTime(turn.createdAt))}</span>
          <span class="wa-feedback-badge" data-rating="${escapeHtml(turn.rating || '')}">
            ${turn.rating === 'up' ? '👍 Like' : '👎 Dislike'}
          </span>
        </div>
        <div class="wa-feedback-turn-label">User</div>
        <pre class="wa-feedback-turn-text">${escapeHtml(summarizeText(turn.userText))}</pre>
        <div class="wa-feedback-turn-label">Assistant</div>
        <pre class="wa-feedback-turn-text">${escapeHtml(summarizeText(turn.assistantText))}</pre>
        <div class="wa-transcript-meta">${turn.turnId ? `Turn: ${escapeHtml(turn.turnId)} · ` : ''}Conversation: ${escapeHtml(turn.conversationId || '')}</div>
        <button type="button" class="wa-agent-btn wa-feedback-open">Open transcript</button>
      `;
      const openBtn = item.querySelector('.wa-feedback-open');
      if (openBtn) {
        openBtn.addEventListener('click', () => openTurnTranscript(turn.conversationId));
      }
      feedbackTurns.appendChild(item);
    });
  }

  async function loadFeedback() {
    feedbackLoaded = true;
    feedbackSummary.innerHTML = '<div class="wa-feedback-metric"><div class="wa-feedback-metric-label">Feedback</div><div class="wa-feedback-metric-value">…</div></div>';
    feedbackAgents.innerHTML = '<div class="wa-transcript-empty">Loading…</div>';
    feedbackTurns.innerHTML = '<div class="wa-transcript-empty">Loading…</div>';
    try {
      const filter = feedbackFilter?.value || 'all';
      const url = dashboardPath(`api/feedback?limit=1000&rating=${encodeURIComponent(filter)}`);
      const response = await fetch(url, {
        credentials: 'same-origin'
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) {
        throw new Error(payload.detail || payload.error || 'Feedback access denied');
      }
      feedbackRetentionMeta.textContent = `Encrypted at rest · retention ${payload.retentionDays || '?'} days`;
      renderFeedbackSummary(payload.summary || {});
      renderFeedbackAgents(payload.agents || []);
      renderFeedbackTurns(payload.turns || []);
    } catch (error) {
      feedbackRetentionMeta.textContent = '';
      feedbackSummary.innerHTML = '<div class="wa-feedback-metric"><div class="wa-feedback-metric-label">Feedback</div><div class="wa-feedback-metric-value">!</div></div>';
      feedbackAgents.innerHTML = `<div class="wa-transcript-empty">${escapeHtml(error.message || 'Failed to load feedback.')}</div>`;
      feedbackTurns.innerHTML = '<div class="wa-transcript-empty">Feedback viewer unavailable.</div>';
    }
  }

  refreshFeedbackBtn.onclick = loadFeedback;
  if (feedbackFilter) {
    feedbackFilter.addEventListener('change', loadFeedback);
  }

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
