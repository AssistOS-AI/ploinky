(() => {
  const elements = {};
  let onParticipantSelect = () => {};
  let onParticipantsToggle = () => {};

  function query(id) { return document.getElementById(id); }

  function init({ participantSelect, participantsToggle }) {
    onParticipantSelect = participantSelect || (() => {});
    onParticipantsToggle = participantsToggle || (() => {});

    Object.assign(elements, {
      body: document.body,
      statusText: query('statusText'),
      statusDot: document.querySelector('.wa-status-dot'),
      participantsToggle: query('participantsToggle'),
      participantsPanel: query('participantsPanel'),
      participantsList: query('vc_participants_list'),
      videoTitle: query('vc_video_title'),
      videoHint: query('vc_video_hint'),
      videoPreview: query('vc_video_preview'),
      videoShell: document.querySelector('.wa-video-shell'),
      themeSelect: query('themeSelect'),
      muteBtn: query('vc_mute_btn'),
      cameraBtn: query('vc_camera_btn'),
      screenBtn: query('vc_screen_btn'),
      deafenBtn: query('vc_deafen_btn'),
      micBtn: query('vc_mic_btn'),
      textarea: query('cmd'),
      sendBtn: query('send'),
      banner: query('connBanner'),
      bannerText: query('bannerText'),
      screenOverlay: query('screenOverlay'),
      screenOverlayVideo: query('screenOverlayVideo'),
      screenOverlayClose: query('screenOverlayClose'),
      screenOverlayTitle: query('screenOverlayTitle')
    });

    if (elements.participantsToggle) {
      elements.participantsToggle.addEventListener('click', () => {
        const isOpen = elements.participantsPanel?.classList.toggle('show');
        onParticipantsToggle(isOpen);
      });
    }

    if (elements.participantsList) {
      elements.participantsList.addEventListener('click', (e) => {
        const item = e.target.closest('[data-participant]');
        if (!item) return;
        onParticipantSelect(item.dataset.participant);
      });
    }

    if (elements.videoShell) {
      elements.videoShell.addEventListener('click', () => {
        window.WebMeetMedia?.openPreviewOverlay();
      });
    }

    if (elements.screenOverlayClose) {
      elements.screenOverlayClose.addEventListener('click', () => {
        window.WebMeetMedia?.hideScreenOverlay();
      });
    }

    if (elements.screenOverlay) {
      elements.screenOverlay.addEventListener('click', (e) => {
        if (e.target === elements.screenOverlay) {
          window.WebMeetMedia?.hideScreenOverlay();
        }
      });
    }

    return elements;
  }

  function renderStatus(state) {
    if (!elements.statusText || !elements.statusDot) return;
    if (!state.connected) {
      elements.statusText.textContent = 'offline';
      elements.statusDot.className = 'wa-status-dot offline';
      return;
    }

    elements.statusDot.className = 'wa-status-dot online';
    if (!state.joined) {
      elements.statusText.textContent = 'Connected — enter email to join';
      return;
    }

    if (state.currentSpeaker === state.myEmail || state.currentSpeaker === state.tabId) {
      elements.statusText.textContent = 'online — You are speaking';
    } else if (!state.currentSpeaker || state.currentSpeaker === 'none') {
      elements.statusText.textContent = 'online — Nobody is speaking';
    } else {
      const match = state.participants.find(p => p.email === state.currentSpeaker || p.tabId === state.currentSpeaker);
      const name = match ? (match.name || match.email || 'Guest') : state.currentSpeaker;
      elements.statusText.textContent = `online — ${name} is speaking`;
    }
  }

  function renderParticipants(state) {
    if (!elements.participantsList) return;
    const frag = document.createDocumentFragment();
    state.participants.forEach((p) => {
      const div = document.createElement('div');
      div.className = 'wa-participant-item';
      div.dataset.participant = p.tabId || p.email || '';
      const queueIcon = state.queue.includes(p.email || p.name || p.tabId) ? '<span class="wa-queue-icon">✋</span> ' : '';
      const isYou = (p.tabId === state.tabId || p.email === state.myEmail) ? ' (you)' : '';
      const speaking = (state.currentSpeaker === p.tabId || state.currentSpeaker === p.email)
        ? '<span class="wa-speaking-icon" title="Speaking">🔊</span>' : '';
      const media = state.remoteMedia?.[p.tabId] || state.remoteMedia?.[p.email] || {};
      const screenFlag = media.screen ? '<span class="wa-screen-flag" title="Sharing screen">🖥️</span>' : '';
      div.innerHTML = `<span class="wa-participant-name">${queueIcon}${p.name || p.email || 'Guest'}${isYou}</span><span class="wa-participant-icons">${speaking}${screenFlag}</span>`;
      if (state.selectedParticipant && (state.selectedParticipant === p.tabId || state.selectedParticipant === p.email)) {
        div.classList.add('active');
      }
      frag.appendChild(div);
    });
    elements.participantsList.replaceChildren(frag);
  }

  function renderButtons(state) {
    const toggle = (btn, active, title) => {
      if (!btn) return;
      btn.classList.toggle('active', !!active);
      if (title) btn.title = title;
    };

    const controlsDisabled = !(state.connected && state.joined);

    toggle(elements.micBtn, state.handRaised, state.handRaised ? 'Lower hand' : 'Raise hand');
    if (elements.micBtn) {
      elements.micBtn.disabled = controlsDisabled;
      elements.micBtn.setAttribute('aria-disabled', controlsDisabled ? 'true' : 'false');
    }

    toggle(elements.muteBtn, !state.isMuted, state.isMuted ? 'Unmute microphone' : 'Mute microphone');
    if (elements.muteBtn) {
      elements.muteBtn.disabled = controlsDisabled;
      elements.muteBtn.setAttribute('aria-disabled', controlsDisabled ? 'true' : 'false');
    }

    toggle(elements.cameraBtn, state.cameraOn, state.cameraOn ? 'Turn camera off' : 'Turn camera on');
    if (elements.cameraBtn) {
      elements.cameraBtn.disabled = controlsDisabled;
      elements.cameraBtn.setAttribute('aria-disabled', controlsDisabled ? 'true' : 'false');
    }

    toggle(elements.screenBtn, state.screenOn, state.screenOn ? 'Stop sharing screen' : 'Share screen');
    if (elements.screenBtn) {
      elements.screenBtn.disabled = controlsDisabled;
      elements.screenBtn.setAttribute('aria-disabled', controlsDisabled ? 'true' : 'false');
    }

    toggle(elements.deafenBtn, state.isDeafened, state.isDeafened ? 'Undeafen (hear others)' : 'Deafen (mute others)');
    if (elements.deafenBtn) {
      elements.deafenBtn.disabled = controlsDisabled;
      elements.deafenBtn.setAttribute('aria-disabled', controlsDisabled ? 'true' : 'false');
    }

    if (elements.themeSelect) {
      elements.themeSelect.value = state.theme || 'light';
    }
  }

  function renderVideo() {
    if (!elements.videoPreview) return;
    window.WebMeetMedia?.refreshPreview();
  }

  function renderBanner(state) {
    if (!elements.banner || !elements.bannerText) return;
    if (state.banner && state.banner.text) {
      elements.bannerText.textContent = state.banner.text;
      elements.banner.className = `wa-connection-banner show ${state.banner.type || ''}`.trim();
    } else {
      elements.banner.classList.remove('show');
      elements.banner.classList.remove('success');
      elements.banner.classList.remove('error');
    }
  }

  function render(state) {
    document.body.setAttribute('data-theme', state.theme || 'light');
    renderStatus(state);
    renderParticipants(state);
    renderButtons(state);
    renderVideo(state);
    renderBanner(state);
  }

  function setVideoStream(stream) {
    if (!elements.videoPreview) return;
    if (elements.videoPreview.srcObject !== stream) {
      elements.videoPreview.srcObject = stream || null;
    }
  }

  function showBanner(text, type) {
    if (!elements.banner || !elements.bannerText) return;
    elements.bannerText.textContent = text;
    elements.banner.className = 'wa-connection-banner show';
    if (type === 'ok') elements.banner.classList.add('success');
    else if (type === 'err') elements.banner.classList.add('error');
    setTimeout(() => {
      elements.banner?.classList.remove('show');
      elements.banner?.classList.remove('success');
      elements.banner?.classList.remove('error');
    }, 1200);
  }

  window.WebMeetUI = {
    init,
    render,
    setVideoStream,
    showBanner,
    elements
  };
})();
