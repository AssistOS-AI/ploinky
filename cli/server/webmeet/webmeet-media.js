(() => {
  const remoteStreams = new Map(); // peerId -> { camera: MediaStream|null, screen: MediaStream|null }
  let store;
  let ui;
  let tabId = null;
  let localCameraTrack = null;
  let localCameraStream = null;
  let localScreenTrack = null;
  let localScreenStream = null;
  let previewPeer = 'self';
  let previewKind = 'none';
  let overlayPeer = null;

  function updateRemoteMedia(peerId, kind, active) {
    store.update((state) => {
      const media = { ...(state.remoteMedia || {}) };
      const entry = { ...(media[peerId] || {}) };
      if (active) entry[kind] = true;
      else delete entry[kind];
      if (Object.keys(entry).length === 0) delete media[peerId];
      else media[peerId] = entry;
      return { remoteMedia: media };
    });
  }

  function resolveRemoteEntry(peerId) {
    if (!remoteStreams.has(peerId)) {
      remoteStreams.set(peerId, { camera: null, screen: null });
    }
    return remoteStreams.get(peerId);
  }

  function setPreview(stream, kind, peerId) {
    previewPeer = peerId;
    previewKind = kind;
    ui.setVideoStream(stream || null);
    if (ui.elements.videoPreview) {
      ui.elements.videoPreview.dataset.kind = kind;
    }
    if (ui.elements.videoHint) {
      if (!stream) ui.elements.videoHint.textContent = 'Camera off';
      else if (kind === 'screen') ui.elements.videoHint.textContent = peerId === 'self' ? 'Screen share preview' : 'Viewing screen share';
      else ui.elements.videoHint.textContent = peerId === 'self' ? 'Camera preview' : 'Viewing participant';
    }
    if (ui.elements.videoTitle) {
      if (peerId === 'self') {
        ui.elements.videoTitle.textContent = kind === 'screen' ? 'Your screen' : 'You';
      } else if (peerId && peerId !== 'self') {
        const state = store.getState();
        const participant = state.participants.find((p) => p.tabId === peerId || p.email === peerId);
        ui.elements.videoTitle.textContent = participant ? (participant.name || participant.email || 'Participant') : 'Participant';
      } else {
        ui.elements.videoTitle.textContent = 'Preview';
      }
    }
  }

  function refreshPreview() {
    const state = store.getState();
    if (!ui) return;

    if (state.selectedParticipant) {
      const entry = resolveRemoteEntry(state.selectedParticipant);
      if (entry.screen) {
        setPreview(entry.screen, 'screen', state.selectedParticipant);
        return;
      }
      if (entry.camera) {
        setPreview(entry.camera, 'camera', state.selectedParticipant);
        return;
      }
      setPreview(null, 'none', state.selectedParticipant);
      return;
    }

    if (state.screenOn && localScreenStream) {
      setPreview(localScreenStream, 'screen', 'self');
    } else if (state.cameraOn && localCameraStream) {
      setPreview(localCameraStream, 'camera', 'self');
    } else {
      setPreview(null, 'none', 'self');
    }
  }

  async function ensureBaseStream() {
    if (!window.webMeetWebRTC) throw new Error('WebRTC module unavailable');
    return window.webMeetWebRTC.startMic?.() || window.webMeetWebRTC.ensureStream?.();
  }

  async function setMuted(nextMuted) {
    if (!window.webMeetWebRTC) return false;
    await ensureBaseStream();
    if (!nextMuted) {
      await window.webMeetWebRTC.goLive();
      window.webMeetWebRTC.resumeBroadcast();
    } else {
      window.webMeetWebRTC.pauseBroadcast();
    }
    store.setState({ isMuted: nextMuted });
    return !nextMuted;
  }

  function registerLocalTrack(track, kind) {
    if (!track) return;
    track.addEventListener('ended', () => {
      if (kind === 'camera') disableCamera().catch(() => {});
      if (kind === 'screen') disableScreenShare().catch(() => {});
    }, { once: true });
  }

  async function enableCamera() {
    if (!window.webMeetWebRTC) return;
    await ensureBaseStream();
    if (localCameraTrack && store.getState().cameraOn) return;
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    localCameraTrack = stream.getVideoTracks()[0];
    if (!localCameraTrack) return;
    localCameraStream = new MediaStream([localCameraTrack]);
    await window.webMeetWebRTC.enableCamera(localCameraTrack);
    store.setState({ cameraOn: true });
    if (tabId) updateRemoteMedia(tabId, 'camera', true);
    registerLocalTrack(localCameraTrack, 'camera');
    refreshPreview();
  }

  async function disableCamera() {
    if (!window.webMeetWebRTC) return;
    window.webMeetWebRTC.disableCamera?.();
    if (localCameraTrack) {
      try { localCameraTrack.stop(); } catch (_) {}
    }
    localCameraTrack = null;
    localCameraStream = null;
    store.setState({ cameraOn: false });
    if (tabId) updateRemoteMedia(tabId, 'camera', false);
    refreshPreview();
  }

  async function setCamera(on) {
    if (on) await enableCamera();
    else await disableCamera();
  }

  async function enableScreenShare() {
    if (!window.webMeetWebRTC) return;
    await ensureBaseStream();
    if (localScreenTrack && store.getState().screenOn) return;
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    localScreenTrack = stream.getVideoTracks()[0];
    if (!localScreenTrack) return;
    localScreenStream = new MediaStream([localScreenTrack]);
    await window.webMeetWebRTC.enableScreenShare?.(localScreenTrack);
    store.setState({ screenOn: true });
    if (tabId) updateRemoteMedia(tabId, 'screen', true);
    registerLocalTrack(localScreenTrack, 'screen');
    refreshPreview();
  }

  async function disableScreenShare() {
    if (!window.webMeetWebRTC) return;
    window.webMeetWebRTC.disableScreenShare?.();
    if (localScreenTrack) {
      try { localScreenTrack.stop(); } catch (_) {}
    }
    localScreenTrack = null;
    localScreenStream = null;
    store.setState({ screenOn: false });
    if (tabId) updateRemoteMedia(tabId, 'screen', false);
    hideScreenOverlay();
    refreshPreview();
  }

  async function setScreenShare(on) {
    if (on) {
      try {
        await enableScreenShare();
      } catch (err) {
        console.error('Screen share error', err);
        store.setState({ screenOn: false });
        throw err;
      }
    } else {
      await disableScreenShare();
    }
  }

  function setDeafened(deafened) {
    store.setState({ isDeafened: deafened });
    try { window.webMeetWebRTC?.muteAllRemoteAudio(deafened); } catch (_) {}
  }

  function determineStreamKind(stream) {
    const track = stream?.getVideoTracks?.()[0];
    if (!track) return 'camera';
    const settings = track.getSettings ? track.getSettings() : {};
    const label = track.label || '';
    if (settings.displaySurface || /screen|window|display|monitor/i.test(label)) return 'screen';
    return 'camera';
  }

  function registerRemoteCleanup(stream, peerId, kind) {
    stream?.getTracks?.().forEach((track) => {
      track.addEventListener('ended', () => {
        const entry = resolveRemoteEntry(peerId);
        entry[kind] = null;
        updateRemoteMedia(peerId, kind, false);
        if (overlayPeer === peerId && kind === 'screen') {
          hideScreenOverlay();
        }
        refreshPreview();
      }, { once: true });
    });
  }

  function handleRemoteStream(peerId, stream, suppliedKind) {
    if (!stream) return;
    if (!stream.getVideoTracks || stream.getVideoTracks().length === 0) return;
    const kind = suppliedKind || determineStreamKind(stream);
    const entry = resolveRemoteEntry(peerId);
    entry[kind] = stream;
    updateRemoteMedia(peerId, kind, true);
    registerRemoteCleanup(stream, peerId, kind);
    if (overlayPeer && overlayPeer === peerId && kind === 'screen') {
      showScreenOverlay(peerId);
    }
    refreshPreview();
  }

  function handlePeerClosed(peerId, opts = {}) {
    const entry = remoteStreams.get(peerId);
    if (entry) {
      if (entry.camera) updateRemoteMedia(peerId, 'camera', false);
      if (entry.screen) updateRemoteMedia(peerId, 'screen', false);
      remoteStreams.delete(peerId);
    }
    if (overlayPeer === peerId) hideScreenOverlay();
    if (!opts.skipPeerRemoval) {
      try { window.webMeetWebRTC?.removePeer?.(peerId); } catch (_) {}
      const audioEl = document.getElementById(`audio_${peerId}`);
      if (audioEl) {
        try { audioEl.srcObject = null; } catch (_) {}
        audioEl.remove();
      }
    }
    refreshPreview();
  }

  function selectParticipant(id) {
    store.setState({ selectedParticipant: id || null });
    refreshPreview();
  }

  function showScreenOverlay(peerId) {
    if (!ui?.elements?.screenOverlay || !ui.elements.screenOverlayVideo) return;
    let stream = null;
    let title = 'Screen share';
    if (peerId === 'self') {
      stream = localScreenStream;
      title = 'Your screen';
    } else if (peerId) {
      const entry = remoteStreams.get(peerId);
      stream = entry?.screen || entry?.camera || null;
      const state = store.getState();
      const participant = state.participants.find((p) => p.tabId === peerId || p.email === peerId);
      if (participant) title = participant.name || participant.email || 'Participant';
    }
    if (!stream) return;
    overlayPeer = peerId;
    ui.elements.screenOverlayVideo.srcObject = stream;
    if (ui.elements.screenOverlayTitle) ui.elements.screenOverlayTitle.textContent = title;
    ui.elements.screenOverlay.classList.add('show');
  }

  function hideScreenOverlay() {
    overlayPeer = null;
    if (ui?.elements?.screenOverlayVideo) {
      try { ui.elements.screenOverlayVideo.srcObject = null; } catch (_) {}
    }
    ui?.elements?.screenOverlay?.classList.remove('show');
  }

  function openPreviewOverlay() {
    const state = store.getState();
    if (previewKind !== 'screen') return;
    if (previewPeer === 'self') {
      if (state.screenOn) showScreenOverlay('self');
    } else if (previewPeer) {
      showScreenOverlay(previewPeer);
    }
  }

  function initMediaStreamWatchers() {
    store.subscribe(() => {
      refreshPreview();
    });
  }

  function init({ store: storeRef, ui: uiModule, tabId: id }) {
    store = storeRef;
    ui = uiModule;
    tabId = id || tabId;
    initMediaStreamWatchers();
    refreshPreview();
  }

  window.WebMeetMedia = {
    init,
    refreshPreview,
    setMuted,
    setCamera,
    setScreenShare,
    setDeafened,
    handleRemoteStream,
    handlePeerClosed,
    selectParticipant,
    showScreenOverlay,
    hideScreenOverlay,
    openPreviewOverlay
  };
})();
