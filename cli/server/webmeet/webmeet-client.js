(() => {
  const TAB_ID = (() => {
    try {
      let v = sessionStorage.getItem('vc_tab');
      if (!v) {
        v = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2);
        sessionStorage.setItem('vc_tab', v);
      }
      return v;
    } catch (_) {
      return String(Math.random()).slice(2);
    }
  })();

  const store = window.WebMeetStore;
  let uiElements;
  let es = null;
  let pingTimer = null;
  let textarea;
  let chatList;
  let sendBtn;
  let emailInput;
  let connectBtn;
  let participantsPanel;
  let sidePanel;
  let sidePanelContent;
  let sidePanelTitle;
  let sidePanelClose;
  let sidePanelResizer;
  let chatContainer;
  let chatArea;
  let broadcasting = false;

  const EMAIL_KEY = 'webmeet_saved_email';

  function getStoredEmail() {
    try { return localStorage.getItem(EMAIL_KEY) || localStorage.getItem('vc_email') || ''; }
    catch (_) { return ''; }
  }

  function storeEmail(val) {
    try {
      localStorage.setItem(EMAIL_KEY, val || '');
      localStorage.setItem('vc_email', val || '');
    } catch (_) {}
  }

  function setLiveTargets(targets) {
    try {
      window.webMeetWebRTC?.setLiveTargets?.(Array.isArray(targets) ? targets : []);
    } catch (err) {
      console.error('[WebMeet] Failed to update live targets', err);
    }
  }

  async function unmuteForSpeaking() {
    if (!window.WebMeetMedia?.setMuted || !store?.getState) return;
    if (store.getState().isMuted === false) return;
    try {
      await window.WebMeetMedia.setMuted(false);
    } catch (err) {
      console.error('[WebMeet] Unmute failed', err);
      window.WebMeetUI?.showBanner?.('Cannot access microphone', 'err');
    }
  }

  async function muteForIdle() {
    if (!window.WebMeetMedia?.setMuted || !store?.getState) return;
    if (store.getState().isMuted === true) return;
    try {
      await window.WebMeetMedia.setMuted(true);
    } catch (err) {
      console.error('[WebMeet] Mute failed', err);
    }
  }

  function beginSpeaking(targets, { notify = true } = {}) {
    setLiveTargets(Array.isArray(targets) ? targets : []);
    broadcasting = true;
    store?.setState?.({ handRaised: false });
    unmuteForSpeaking();
    if (notify) {
      window.WebMeetUI?.showBanner?.("It's your turn to speak", 'ok');
    }
  }

  function finishSpeaking() {
    if (broadcasting) {
      setLiveTargets([]);
    }
    broadcasting = false;
    muteForIdle();
  }

  function autoResize() {
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(140, textarea.scrollHeight)}px`;
  }

  function stripAnsi(input) {
    try {
      return (input || '').replace(/\u001b\[[0-9;]*m/g, '');
    } catch (_) {
      return input;
    }
  }

  function formatTime(ts) {
    const d = ts ? new Date(ts) : new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function linkify(text) {
    const frag = document.createDocumentFragment();
    const urlRe = /(https?:\/\/[^\s]+)/g;
    let lastIndex = 0;
    let match;
    while ((match = urlRe.exec(text)) !== null) {
      const before = text.slice(lastIndex, match.index);
      if (before) frag.appendChild(document.createTextNode(before));
      const url = match[0];
      const a = document.createElement('a');
      a.href = url;
      a.textContent = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      frag.appendChild(a);
      lastIndex = match.index + url.length;
    }
    const rest = text.slice(lastIndex);
    if (rest) frag.appendChild(document.createTextNode(rest));
    return frag;
  }

  function openSidePanel(content, title = 'Full Message') {
    if (!sidePanel || !sidePanelContent || !sidePanelTitle || !chatContainer) return;
    sidePanelTitle.textContent = title;
    sidePanelContent.textContent = content;
    sidePanel.style.display = 'flex';
    chatContainer.classList.add('side-panel-open');
  }

  function closeSidePanel() {
    if (!sidePanel || !chatContainer) return;
    sidePanel.style.display = 'none';
    chatContainer.classList.remove('side-panel-open');
  }

  function createMessageBubble(msg, isSelf) {
    const wrapper = document.createElement('div');
    wrapper.className = `wa-message ${isSelf ? 'out' : 'in'}`;

    const bubble = document.createElement('div');
    bubble.className = 'wa-message-bubble';
    if (msg?.from === 'moderator') wrapper.classList.add('moderator');
    if (msg?.command) wrapper.classList.add('command');
    if (msg?.state === 'forbidden') {
      wrapper.classList.add('forbidden');
      bubble.classList.add('is-forbidden');
    }
    if (msg?.state === 'moderated') {
      bubble.classList.add('moderated');
    }
    bubble.innerHTML = '<div class="wa-message-author"></div><div class="wa-message-text"></div><span class="wa-message-time"></span>';

    bubble.querySelector('.wa-message-author').textContent = msg.from || 'system';
    bubble.querySelector('.wa-message-time').textContent = formatTime(msg.ts);

    const textDiv = bubble.querySelector('.wa-message-text');
    const cleanText = stripAnsi(msg.text || '');
    if (cleanText.length > 600) {
      const preview = `${cleanText.slice(0, 600)}…`;
      textDiv.textContent = '';
      textDiv.appendChild(linkify(preview));
      const more = document.createElement('div');
      more.className = 'wa-message-more';
      more.textContent = 'View more';
      more.addEventListener('click', () => openSidePanel(cleanText));
      bubble.appendChild(more);
    } else {
      textDiv.appendChild(linkify(cleanText));
    }

    wrapper.appendChild(bubble);
    return wrapper;
  }

  function renderChatMessage(msg) {
    if (!chatList) return;
    const isSelf = msg.from === store.getState().myEmail || msg.tabId === TAB_ID;
    const bubble = createMessageBubble(msg, isSelf);
    chatList.appendChild(bubble);
    chatList.scrollTop = chatList.scrollHeight;
  }

  async function postAction(payload) {
    const body = { ...payload, tabId: TAB_ID };
    try {
      const res = await fetch('action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    } catch (err) {
      console.error('[WebMeet] action failed', err);
      return { ok: false, error: err.message };
    }
  }

  function sendTextMessage(text) {
    const trimmed = (text || '').trim();
    if (!trimmed) return;
    renderChatMessage({ from: store.getState().myEmail || 'me', text: trimmed, ts: Date.now(), tabId: TAB_ID });
    postAction({ type: 'chat', text: trimmed, from: store.getState().myEmail || TAB_ID });
  }

  function handleSendClick(e) {
    e.preventDefault();
    const value = textarea.value;
    textarea.value = '';
    autoResize();
    sendTextMessage(value);
  }

  function handleTextareaKeydown(e) {
    if (!store.getState().joined) {
      if (e.key === 'Enter') e.preventDefault();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const value = textarea.value;
      textarea.value = '';
      autoResize();
      sendTextMessage(value);
    }
  }

  function restoreEmail() {
    const saved = getStoredEmail();
    if (emailInput && saved && !emailInput.value) emailInput.value = saved;
    if (saved) store.setState({ myEmail: saved });
  }

  function handleJoin(email) {
    const trimmed = (email || '').trim();
    if (!trimmed || !/\S+@\S+\.\S+/.test(trimmed)) {
      window.WebMeetUI.showBanner('Enter a valid email to join', 'err');
      return;
    }
    storeEmail(trimmed);
    store.setState({ myEmail: trimmed });
    postAction({ type: 'hello', email: trimmed, name: trimmed }).then((res) => {
      if (res?.ok === false) {
        window.WebMeetUI.showBanner('Join failed, try again', 'err');
        return;
      }
      store.setState({ joined: true });
      window.WebMeetUI.showBanner('Joined meeting', 'ok');
      if (emailInput) emailInput.readOnly = true;
    });
  }

  function handleConnectToggle() {
    if (!store.getState().connected) {
      connectSSE();
    } else {
      disconnectSSE();
    }
  }

  function handleParticipantSelect(id) {
    const current = store.getState().selectedParticipant;
    const next = current && current === id ? null : id;
    window.WebMeetMedia.selectParticipant(next || null);
  }

  function applyStateToInputs(state) {
    if (textarea) {
      textarea.disabled = !(state.connected && state.joined);
      textarea.placeholder = state.connected
        ? (state.joined ? 'Type a message' : 'Enter email to join the meeting')
        : 'Press Connect to start';
    }
    if (sendBtn) sendBtn.disabled = !(state.connected && state.joined);
    if (emailInput) emailInput.readOnly = state.joined;
    if (connectBtn) {
      connectBtn.title = state.connected ? 'Disconnect' : 'Connect';
      connectBtn.classList.toggle('danger', state.connected);
      connectBtn.classList.toggle('active', state.connected);
    }
  }

  function handleStoreUpdate(state) {
    WebMeetUI.render({ ...state, tabId: TAB_ID });
    applyStateToInputs(state);
    if (state.queue && state.handRaised && !state.queue.includes(state.myEmail)) {
      store.setState({ handRaised: false });
    }
  }

  function handleParticipantsToggle(isOpen) {
    if (!participantsPanel) return;
    if (isOpen) participantsPanel.classList.add('show');
    else participantsPanel.classList.remove('show');
  }

  function onSignal(from, payload) {
    window.WebMeetWebRTC?.onSignal(from, payload);
  }

  function handleSseMessage(type, data) {
    switch (type) {
      case 'init': {
        const { participants = [], queue = [], currentSpeaker = null, history = [] } = data;
        const initTargets = Array.isArray(data.targets) ? data.targets : null;
        const fallbackTargets = Array.isArray(data.liveTargets) ? data.liveTargets : null;
        const selectedTargets = initTargets ?? fallbackTargets;
        store.setState({ participants, queue, currentSpeaker });
        const state = store.getState();
        const isSelf = currentSpeaker === TAB_ID || (!!state.myEmail && currentSpeaker === state.myEmail);
        if (isSelf) {
          beginSpeaking(selectedTargets, { notify: false });
        } else {
          finishSpeaking();
        }
        history.forEach(renderChatMessage);
        break;
      }
      case 'participant_join': {
        const participant = data.participant;
        if (!participant) break;
        store.update((state) => {
          if (state.participants.find(p => p.tabId === participant.tabId)) return state;
          return { participants: [...state.participants, participant] };
        });
        break;
      }
      case 'participant_leave': {
        const { tabId } = data;
        if (!tabId) break;
        window.WebMeetMedia?.handlePeerClosed?.(tabId);
        store.update((state) => ({ participants: state.participants.filter(p => p.tabId !== tabId) }));
        break;
      }
      case 'queue': {
        store.setState({ queue: data.queue || [] });
        break;
      }
      case 'current_speaker': {
        const { tabId = null, email = null } = data || {};
        const targets = Array.isArray(data?.targets) ? data.targets : null;
        const prevState = store.getState();
        const prevSpeaker = prevState.currentSpeaker;
        const prevEmail = prevState.myEmail;
        const next = tabId || email || null;
        store.setState({ currentSpeaker: next });
        const state = store.getState();
        const isSelf = next === TAB_ID || (!!state.myEmail && next === state.myEmail);
        if (isSelf) {
          beginSpeaking(targets, { notify: false });
        } else {
          const wasSelf = prevSpeaker === TAB_ID || (!!prevEmail && prevSpeaker === prevEmail);
          if (wasSelf || broadcasting) finishSpeaking();
          else {
            broadcasting = false;
            muteForIdle();
          }
        }
        break;
      }
      case 'start_speaking': {
        const targets = Array.isArray(data?.targets) ? data.targets : [];
        if (store.getState().currentSpeaker === TAB_ID) {
          beginSpeaking(targets, { notify: true });
        }
        break;
      }
      case 'chat':
      case 'chat_private': {
        if (data.command === 'speak') {
          const state = store.getState();
          const wasSelf = state.currentSpeaker === TAB_ID || (!!state.myEmail && state.currentSpeaker === state.myEmail);
          const isSelf = data.who === state.myEmail || data.who === TAB_ID;
          const nextSpeaker = isSelf ? TAB_ID : (data.who || null);
          store.setState({
            currentSpeaker: nextSpeaker,
            queue: data.waiting || []
          });
          if (isSelf) {
            const targets = Array.isArray(data?.targets) ? data.targets : null;
            beginSpeaking(targets, { notify: true });
          } else {
            if (wasSelf || broadcasting) finishSpeaking();
            else {
              broadcasting = false;
              muteForIdle();
            }
          }
        }
        renderChatMessage(data);
        break;
      }
      case 'signal': {
        onSignal(data.from, data.payload);
        break;
      }
      default:
        break;
    }
  }

  function connectSSE() {
    if (es) return;
    es = new EventSource(`events?tabId=${encodeURIComponent(TAB_ID)}`);
    es.addEventListener('open', async () => {
      store.setState({ connected: true });
      WebMeetUI.showBanner('Connected', 'ok');
      window.webMeetDemo?.setConnected?.(true);
      window.webMeetDemo?.stopDemo?.();
      if (chatList) chatList.innerHTML = '';
      const saved = getStoredEmail();
      if (saved) {
        handleJoin(saved);
      }
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        postAction({ type: 'ping' }).then((res) => {
          if (res?.ok === false) handleDisconnect();
        });
      }, 30000);
    });

    es.addEventListener('message', (ev) => {
      if (!ev.data) return;
      let payload;
      try { payload = JSON.parse(ev.data); } catch (_) { return; }
      if (!payload?.event) return;
      handleSseMessage(payload.event, payload.data || {});
    });

    const attach = (event) => {
      es.addEventListener(event, (ev) => {
        if (!ev.data) return;
        let data;
        try { data = JSON.parse(ev.data); } catch (_) { data = {}; }
        handleSseMessage(event, data || {});
      });
    };

    ['init', 'participant_join', 'participant_leave', 'queue', 'current_speaker', 'chat', 'chat_private', 'signal', 'start_speaking']
      .forEach(attach);

    es.onerror = (err) => {
      console.error('[WebMeet] SSE error', err);
      handleDisconnect();
    };
  }

  function handleDisconnect() {
    store.setState({ connected: false, joined: false, participants: [], queue: [], currentSpeaker: null, isMuted: true, cameraOn: false, handRaised: false, selectedParticipant: null });
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
    WebMeetUI.showBanner('Disconnected', 'err');
    window.webMeetDemo?.setConnected?.(false);
    window.webMeetDemo?.startDemo?.();
    finishSpeaking();
    window.WebMeetWebRTC?.stopMic();
    if (window.WebMeetMedia?.setCamera) {
      window.WebMeetMedia.setCamera(false).catch(() => {});
    }
    if (window.WebMeetMedia?.setScreenShare) {
      window.WebMeetMedia.setScreenShare(false).catch(() => {});
    }
  }

  function disconnectSSE() {
    if (es) {
      try { es.close(); } catch (_) {}
    }
    es = null;
    handleDisconnect();
  }

  function initDomRefs() {
    chatList = document.getElementById('chatList');
    textarea = document.getElementById('cmd');
    sendBtn = document.getElementById('send');
    emailInput = document.getElementById('vc_email_input');
    connectBtn = document.getElementById('vc_connect_btn');
    participantsPanel = document.getElementById('participantsPanel');
    sidePanel = document.getElementById('sidePanel');
    sidePanelContent = document.getElementById('sidePanelContent');
    sidePanelTitle = document.querySelector('.wa-side-panel-title');
    sidePanelClose = document.getElementById('sidePanelClose');
    sidePanelResizer = document.getElementById('sidePanelResizer');
    chatContainer = document.getElementById('chatContainer');
    chatArea = document.getElementById('chatArea');
  }

  function initEvents() {
    if (textarea) {
      textarea.addEventListener('input', autoResize);
      textarea.addEventListener('keydown', handleTextareaKeydown);
    }
    if (sendBtn) sendBtn.addEventListener('click', handleSendClick);
    if (emailInput) {
      emailInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleJoin(emailInput.value);
        }
      });
    }
    if (connectBtn) connectBtn.addEventListener('click', handleConnectToggle);
    if (sidePanelClose) sidePanelClose.addEventListener('click', closeSidePanel);
    if (sidePanelResizer && sidePanel && chatContainer) {
      let dragging = false;
      let startX = 0;
      let startWidth = 0;
      sidePanelResizer.addEventListener('pointerdown', (e) => {
        dragging = true;
        startX = e.clientX;
        startWidth = sidePanel.getBoundingClientRect().width;
        sidePanelResizer.setPointerCapture(e.pointerId);
      });
      window.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const contWidth = chatContainer.getBoundingClientRect().width;
        const pct = ((startWidth - dx) / contWidth) * 100;
        const clamped = Math.min(80, Math.max(20, pct));
        sidePanel.style.flex = `0 0 ${clamped}%`;
        sidePanel.style.width = `${clamped}%`;
      });
      window.addEventListener('pointerup', (e) => {
        if (!dragging) return;
        dragging = false;
        try { sidePanelResizer.releasePointerCapture(e.pointerId); } catch (_) {}
      });
    }
  }

  async function handleButtonBindings() {
    const { themeSelect, muteBtn, cameraBtn, screenBtn, deafenBtn, micBtn } = uiElements;
    if (themeSelect) themeSelect.addEventListener('change', () => {
      const value = themeSelect.value || 'light';
      store.setState({ theme: value });
      try { localStorage.setItem('webmeet_theme', value); } catch (_) {}
    });
    if (muteBtn) muteBtn.addEventListener('click', () => {
      window.WebMeetMedia.setMuted(!store.getState().isMuted).catch((err) => {
        console.error('Mute toggle failed', err);
        WebMeetUI.showBanner('Cannot access microphone', 'err');
      });
    });
    if (cameraBtn) cameraBtn.addEventListener('click', () => {
      window.WebMeetMedia.setCamera(!store.getState().cameraOn).catch((err) => {
        console.error('Camera toggle failed', err);
        WebMeetUI.showBanner('Cannot access camera', 'err');
      });
    });
    if (screenBtn) screenBtn.addEventListener('click', () => {
      window.WebMeetMedia.setScreenShare(!store.getState().screenOn).catch((err) => {
        console.error('Screen share toggle failed', err);
        WebMeetUI.showBanner('Cannot share screen', 'err');
      });
    });
    if (deafenBtn) deafenBtn.addEventListener('click', () => window.WebMeetMedia.setDeafened(!store.getState().isDeafened));
    if (micBtn) micBtn.addEventListener('click', () => {
      const raised = !store.getState().handRaised;
      store.setState({ handRaised: raised });
      postAction({ from: store.getState().myEmail || TAB_ID, to: 'moderator', command: raised ? 'wantToSpeak' : 'endSpeak', text: '' });
    });
  }

  window.addEventListener('DOMContentLoaded', () => {
    initDomRefs();
    if (window.webMeetDemo) {
      window.webMeetDemo.init(chatList);
      window.webMeetDemo.setConnected(false);
      window.webMeetDemo.startDemo();
    }
    uiElements = WebMeetUI.init({
      participantSelect: handleParticipantSelect,
      participantsToggle: handleParticipantsToggle
    });
    WebMeetMedia.init({ store, ui: WebMeetUI, tabId: TAB_ID });
    textarea && autoResize();
    initEvents();
    handleButtonBindings();
    restoreEmail();
    store.subscribe(handleStoreUpdate);
    handleStoreUpdate(store.getState());
    connectSSE();
  });

  window.WebMeetClient = {
    postAction,
    connect: connectSSE,
    disconnect: disconnectSSE
  };

  window.webMeetClient = window.WebMeetClient;
})();
