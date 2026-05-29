(() => {
  // WebRTC Room Connection Module
  function identifyStreamKind(stream) {
    const track = stream?.getVideoTracks?.()[0];
    if (!track) return 'camera';
    const settings = track.getSettings ? track.getSettings() : {};
    const label = track.label || '';
    if (settings.displaySurface || /screen|window|display|monitor/i.test(label)) return 'screen';
    return 'camera';
  }

  const WebRTCRoom = {
    peers: new Map(),
    micStream: null,
    liveTargets: [],
    isPaused: false,
    originalAudioTrack: null,
    isBroadcasting: false,
    cameraTrack: null,
    cameraSenders: new Map(),
    screenTrack: null,
    screenSenders: new Map(),
    initiatedPeers: new Set(),

    async startMic() {
      if (this.micStream) return this.micStream;
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false
      });
      return this.micStream;
    },

    stopMic() {
      // Stop microphone stream
      if (this.micStream) {
        this.micStream.getTracks().forEach(track => {
          try {
            track.stop();
          } catch(_) {}
        });
        this.micStream = null;
      }

      // Close all peer connections
      for (const pc of this.peers.values()) {
        try {
          pc.close();
        } catch(_) {}
      }
      for (const peerId of this.peers.keys()) {
        try { window.WebMeetMedia?.handlePeerClosed(peerId); } catch (_) {}
      }
      this.peers.clear();
      this.initiatedPeers.clear();
      this.isBroadcasting = false;
      this.cameraSenders.clear();
      this.screenSenders.clear();
      if (this.cameraTrack) {
        try { this.cameraTrack.stop(); } catch(_) {}
      }
      this.cameraTrack = null;
      if (this.screenTrack) {
        try { this.screenTrack.stop(); } catch(_) {}
      }
      this.screenTrack = null;
      document.querySelectorAll('audio[id^="audio_"]').forEach((el) => {
        try { el.srcObject = null; } catch (_) {}
        el.remove();
      });
    },

    async goLive() {
      try {
        // Make sure microphone is started
        if (!this.micStream) {
          await this.startMic();
        }

        // Connect to all targets
        console.log('Going live, connecting to targets:', this.liveTargets);
        for (const targetId of (this.liveTargets || [])) {
          console.log('Connecting to peer:', targetId);
          await this.connectToPeer(targetId);
        }

        if (!this.liveTargets || this.liveTargets.length === 0) {
          console.log('No other participants to broadcast to');
        }
        this.isBroadcasting = true;
      } catch(e) {
        console.error('Error going live:', e);
        throw e;
      }
    },

    async connectToPeer(peerId) {
      if (this.peers.has(peerId)) {
        console.log('Already connected to peer:', peerId);
        return this.peers.get(peerId);
      }

      console.log('Creating new connection to peer:', peerId);

      const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      });

      this.peers.set(peerId, pc);
      this.initiatedPeers.add(peerId);

      // Add microphone tracks to the connection
      if (this.micStream) {
        console.log('Adding mic tracks to peer connection');
        this.micStream.getAudioTracks().forEach(track => {
          pc.addTrack(track, this.micStream);
        });
        if (this.cameraTrack) {
          try {
            const sender = pc.addTrack(this.cameraTrack, this.micStream);
            this.cameraSenders.set(peerId, sender);
          } catch (err) {
            console.warn('Failed to add camera track to peer', err);
          }
        }
      } else {
        console.warn('No microphone stream available for peer connection');
      }

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          console.log('Sending ICE candidate to:', peerId);
          if (window.webMeetClient) {
            window.webMeetClient.postAction({
              type: 'signal',
              target: peerId,
              payload: { type: 'ice', candidate: e.candidate }
            });
          }
        }
      };

      pc.ontrack = (e) => {
        console.log('Received remote track from:', peerId);
        this.attachRemoteStream(peerId, e.streams[0]);
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      console.log('Sending offer to:', peerId);
      if (window.webMeetClient) {
        await window.webMeetClient.postAction({
          type: 'signal',
          target: peerId,
          payload: { type: 'offer', sdp: pc.localDescription }
        });
      }

      return pc;
    },

    async onSignal(from, payload) {
      console.log('Received signal from:', from, 'type:', payload.type);

      let pc = this.peers.get(from);

      if (!pc) {
        console.log('Creating new peer connection for incoming signal from:', from);
        pc = new RTCPeerConnection({
          iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        });

        this.peers.set(from, pc);

        pc.onicecandidate = (e) => {
          if (e.candidate) {
            console.log('Sending ICE candidate back to:', from);
            if (window.webMeetClient) {
              window.webMeetClient.postAction({
                type: 'signal',
                target: from,
                payload: { type: 'ice', candidate: e.candidate }
              });
            }
          }
        };

        pc.ontrack = (e) => {
          console.log('Received remote audio track from:', from);
          this.attachRemoteStream(from, e.streams[0]);
        };

        if (this.micStream) {
          console.log('Adding mic tracks for incoming connection');
          this.micStream.getAudioTracks().forEach(track => {
            pc.addTrack(track, this.micStream);
          });
          if (this.cameraTrack) {
            try {
              const sender = pc.addTrack(this.cameraTrack, this.micStream);
              this.cameraSenders.set(from, sender);
            } catch (err) {
              console.warn('Failed to add camera track for incoming connection', err);
            }
          }
        }
      }

      if (payload.type === 'offer') {
        console.log('Processing offer from:', from);
        await pc.setRemoteDescription(payload.sdp);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        console.log('Sending answer to:', from);
        if (window.webMeetClient) {
          await window.webMeetClient.postAction({
            type: 'signal',
            target: from,
            payload: { type: 'answer', sdp: pc.localDescription }
          });
        }
      } else if (payload.type === 'answer') {
        console.log('Processing answer from:', from);
        await pc.setRemoteDescription(payload.sdp);
      } else if (payload.type === 'ice') {
        try {
          console.log('Adding ICE candidate from:', from);
          await pc.addIceCandidate(payload.candidate);
        } catch(e) {
          console.error('Error adding ICE candidate:', e);
        }
      }
    },

    attachRemoteStream(peerId, stream) {
      let audioElement = document.getElementById('audio_' + peerId);

      if (!audioElement) {
        audioElement = document.createElement('audio');
        audioElement.id = 'audio_' + peerId;
        audioElement.autoplay = true;
        audioElement.playsInline = true;
        audioElement.muted = window.WebMeetStore?.getState()?.isDeafened || false;
        document.body.appendChild(audioElement);
      }

      audioElement.srcObject = stream;
      if (stream?.getVideoTracks?.().length) {
        const kind = identifyStreamKind(stream);
        try { window.WebMeetMedia?.handleRemoteStream(peerId, stream, kind); } catch (_) {}
      }
    },

    setLiveTargets(targets) {
      this.liveTargets = Array.isArray(targets) ? targets : [];
      const desired = new Set(this.liveTargets);
      const toClose = [];
      for (const peerId of this.initiatedPeers) {
        if (!desired.has(peerId)) {
          toClose.push(peerId);
        }
      }
      toClose.forEach((peerId) => {
        this.removePeer(peerId);
        try { window.WebMeetMedia?.handlePeerClosed(peerId, { skipPeerRemoval: true }); } catch (_) {}
      });
      if (this.isBroadcasting && !this.isPaused) {
        this.goLive().catch(err => console.error('Failed to refresh WebRTC peers', err));
      }
    },

    removePeer(peerId) {
      const pc = this.peers.get(peerId);
      if (pc) {
        try { pc.close(); } catch(_) {}
        this.peers.delete(peerId);
      }
      this.initiatedPeers.delete(peerId);
      this.cameraSenders.delete(peerId);
      this.screenSenders.delete(peerId);
      const audioEl = document.getElementById('audio_' + peerId);
      if (audioEl) {
        try { audioEl.srcObject = null; } catch (_) {}
        audioEl.remove();
      }
    },

    muteAllRemoteAudio(muted) {
      document.querySelectorAll('audio').forEach(audio => {
        audio.muted = muted;
      });
    },

    pauseBroadcast() {
      if (!this.micStream || this.isPaused) return;

      // Save the original track
      const audioTracks = this.micStream.getAudioTracks();
      if (audioTracks.length > 0) {
        this.originalAudioTrack = audioTracks[0];
        // Mute the track
        this.originalAudioTrack.enabled = false;
        this.isPaused = true;
        this.isBroadcasting = false;
      }
    },

    resumeBroadcast() {
      if (!this.isPaused || !this.originalAudioTrack) return;

      // Unmute the track
      this.originalAudioTrack.enabled = true;
      this.isPaused = false;
      this.isBroadcasting = true;
    }
  };

  WebRTCRoom.enableCamera = async function enableCamera(track) {
    await this.startMic();
    if (this.cameraTrack) return;
    if (track) {
      this.cameraTrack = track;
    } else {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      this.cameraTrack = stream.getVideoTracks()[0];
    }
    if (!this.cameraTrack) return;
    if (this.micStream && !this.micStream.getTracks().includes(this.cameraTrack)) {
      this.micStream.addTrack(this.cameraTrack);
    }
    for (const [peerId, pc] of this.peers.entries()) {
      try {
        const sender = pc.addTrack(this.cameraTrack, this.micStream);
        this.cameraSenders.set(peerId, sender);
      } catch (err) {
        console.warn('enableCamera addTrack failed', err);
      }
    }
    if (this.isBroadcasting) {
      await this.goLive();
    }
  };

  WebRTCRoom.disableCamera = function disableCamera() {
    if (this.cameraTrack) {
      for (const sender of this.cameraSenders.values()) {
        try {
          if (sender?.track?.stop) sender.track.stop();
        } catch (_) {}
      }
      try { this.cameraTrack.stop(); } catch (_) {}
      if (this.micStream) {
        try { this.micStream.removeTrack(this.cameraTrack); } catch (_) {}
      }
    }
    for (const [peerId, pc] of this.peers.entries()) {
      const sender = this.cameraSenders.get(peerId);
      if (sender) {
        try { pc.removeTrack(sender); } catch (_) {}
      }
    }
    this.cameraSenders.clear();
    this.cameraTrack = null;
  };

  WebRTCRoom.enableScreenShare = async function enableScreenShare(track) {
    await this.startMic();
    if (this.screenTrack) return;
    if (track) {
      this.screenTrack = track;
    } else {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      this.screenTrack = stream.getVideoTracks()[0];
    }
    if (!this.screenTrack) return;
    if (this.micStream && !this.micStream.getTracks().includes(this.screenTrack)) {
      this.micStream.addTrack(this.screenTrack);
    }
    for (const [peerId, pc] of this.peers.entries()) {
      try {
        const sender = pc.addTrack(this.screenTrack, this.micStream);
        this.screenSenders.set(peerId, sender);
      } catch (err) {
        console.warn('enableScreenShare addTrack failed', err);
      }
    }
    if (this.isBroadcasting) {
      await this.goLive();
    }
  };

  WebRTCRoom.disableScreenShare = function disableScreenShare() {
    if (this.screenTrack) {
      for (const sender of this.screenSenders.values()) {
        try {
          if (sender?.track?.stop) sender.track.stop();
        } catch (_) {}
      }
      try { this.screenTrack.stop(); } catch (_) {}
      if (this.micStream) {
        try { this.micStream.removeTrack(this.screenTrack); } catch (_) {}
      }
    }
    for (const [peerId, pc] of this.peers.entries()) {
      const sender = this.screenSenders.get(peerId);
      if (sender) {
        try { pc.removeTrack(sender); } catch (_) {}
      }
    }
    this.screenSenders.clear();
    this.screenTrack = null;
  };

  // Export to global scope
  window.webMeetWebRTC = WebRTCRoom;
})();
