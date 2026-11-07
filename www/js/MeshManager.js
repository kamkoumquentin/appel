class MeshManager {
  constructor(callManager, options = {}) {
    this.callManager = callManager;
    this.iceServers = options.iceServers || window.APP_CONFIG.iceServers;
    this.onLocalStream = options.onLocalStream || (() => {});
    this.onRemoteStream = options.onRemoteStream || (() => {});
    this.onPeerClosed = options.onPeerClosed || (() => {});
    this.onPeerStateChange = options.onPeerStateChange || (() => {});
    this.onMediaError = options.onMediaError || (() => {});
    this.onMediaStateChange = options.onMediaStateChange || (() => {});
    this.peerConnections = new Map();
    this.pendingIceCandidates = new Map();
    this.remoteStreams = new Map();
    this.peerInitiators = new Map();
    this.pendingIceRestarts = new Set();
    this.pendingNegotiations = new Set();
    this.pendingTrackAcquisitions = new Map();
    this.recoveryInProgress = new Set();
    this.localStream = null;
    this.roomId = null;
    this.participantId = null;
    this.audioDeviceId = null;
    this.videoDeviceId = null;
    this.participantCount = 0;
    this.mediaReady = Promise.resolve();
    this.lastRoomStateSentAt = null;
    this.roomStateTimer = null;
    this.loggedIcePairs = new WeakMap();
  }

  async startRoom(room, participantId, {
    initiateOffers = false,
    localStream = null,
    mediaPrepared = false,
    audioEnabled = true,
    videoEnabled = true,
    audioDeviceId = null,
    videoDeviceId = null
  } = {}) {
    this.roomId = room.roomId;
    this.participantId = participantId;
    this.participantCount = room.participants.length;
    this.audioDeviceId = audioDeviceId;
    this.videoDeviceId = videoDeviceId;
    if (mediaPrepared) {
      this.localStream = localStream;
      for (const track of this.localStream?.getTracks() || []) {
        track.enabled = track.kind === "audio" ? audioEnabled : videoEnabled;
      }
      this.onLocalStream(this.localStream);
      this.mediaReady = Promise.resolve();
    } else {
      this.mediaReady = this.acquireLocalMedia(room);
      await this.mediaReady;
    }

    this.onMediaStateChange(this.getMediaState());
    this.sendRoomState();
    if (!initiateOffers) return;

    for (const participant of room.participants) {
      if (participant.id === participantId) continue;
      try {
        await this.createOffer(participant.id);
      } catch (error) {
        console.error(`[Mesh] Création de l’offre vers ${participant.id} échouée :`, error);
        this.onMediaError("La connexion média avec un participant n’a pas pu démarrer.");
      }
    }
  }

  async acquireLocalMedia(room) {
    try {
      const crowded = room.participants.length >= 3;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: {
          width: { ideal: 640 },
          height: { ideal: 360 },
          frameRate: crowded ? { ideal: 20, min: 15, max: 24 } : { ideal: 24, max: 30 }
        }
      });
      if (this.roomId !== room.roomId) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.localStream = stream;
      this.onLocalStream(stream);
    } catch (error) {
      if (this.roomId !== room.roomId) return;
      console.warn("[Mesh] Accès micro/caméra refusé :", error);
      this.localStream = null;
      this.onLocalStream(null);
      this.onMediaError("Accès au micro ou à la caméra refusé. Vous rejoignez la réunion sans audio ni vidéo.");
    }
  }

  async createOffer(participantId, options = {}) {
    this.peerInitiators.set(participantId, true);
    const pc = this.createPeerConnection(participantId);
    const offer = await pc.createOffer(options);
    await pc.setLocalDescription(offer);
    console.log(`[Mesh] ${this.participantId} -> ${participantId} offre envoyée${options.iceRestart ? " (ICE restart)" : ""}.`);
    this.send("ROOM_OFFER", participantId, pc.localDescription);
  }

  createPeerConnection(participantId) {
    const existing = this.peerConnections.get(participantId);
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const addedKinds = new Set();
    for (const track of this.localStream?.getTracks() || []) {
      pc.addTrack(track, this.localStream);
      addedKinds.add(track.kind);
    }
    for (const kind of ["audio", "video"]) {
      if (!addedKinds.has(kind)) pc.addTransceiver(kind, { direction: "recvonly" });
    }

    pc.onicecandidate = ({ candidate }) => {
      if (!candidate) return;
      console.log(`[Mesh] ${this.participantId} -> ${participantId} candidat ICE envoyé, type=${this.candidateType(candidate)}.`);
      this.send("ROOM_ICE", participantId, candidate);
    };
    pc.ontrack = (event) => {
      console.log(`[Mesh] piste reçue de ${participantId}, kind=${event.track.kind}, readyState=${event.track.readyState}.`);
      let stream = this.remoteStreams.get(participantId);
      if (!stream) {
        stream = event.streams[0] || new MediaStream();
        this.remoteStreams.set(participantId, stream);
      }
      if (!stream.getTracks().includes(event.track)) stream.addTrack(event.track);
      this.onRemoteStream(participantId, stream);
    };
    pc.oniceconnectionstatechange = () => {
      this.logPeerStates(participantId, pc);
      this.onPeerStateChange(participantId, this.peerState(pc));
      if (["connected", "completed"].includes(pc.iceConnectionState)) {
        this.logSelectedIceCandidatePair(participantId, pc);
      }
      if (pc.iceConnectionState === "failed") this.restartPeerIce(participantId, pc);
      if (["connected", "completed"].includes(pc.iceConnectionState)) {
        this.recoveryInProgress.delete(participantId);
        this.pendingIceRestarts.delete(participantId);
      }
    };
    pc.onconnectionstatechange = () => {
      this.logPeerStates(participantId, pc);
      this.onPeerStateChange(participantId, this.peerState(pc));
      if (pc.connectionState === "connected") this.recoveryInProgress.delete(participantId);
    };
    pc.onsignalingstatechange = () => {
      this.logPeerStates(participantId, pc);
      this.onPeerStateChange(participantId, this.peerState(pc));
      if (pc.signalingState === "stable") {
        this.sendPendingIceRestart(participantId, pc);
        this.sendPendingNegotiation(participantId, pc);
      }
    };
    this.peerConnections.set(participantId, pc);
    this.onPeerStateChange(participantId, this.peerState(pc));
    return pc;
  }

  async logSelectedIceCandidatePair(participantId, peerConnection) {
    try {
      const stats = await peerConnection.getStats();
      const reports = new Map();
      stats.forEach((report) => reports.set(report.id, report));
      let pair = null;
      stats.forEach((report) => {
        if (report.type === "transport" && report.selectedCandidatePairId) {
          pair = reports.get(report.selectedCandidatePairId) || pair;
        }
      });
      if (!pair) {
        stats.forEach((report) => {
          if (report.type === "candidate-pair" && report.state === "succeeded" &&
              (report.selected || report.nominated)) pair = report;
        });
      }
      if (!pair) return;
      const localType = reports.get(pair.localCandidateId)?.candidateType || "unknown";
      const remoteType = reports.get(pair.remoteCandidateId)?.candidateType || "unknown";
      const type = localType === "relay" || remoteType === "relay"
        ? "relay"
        : localType === "srflx" || remoteType === "srflx" ? "srflx" : "host";
      if (this.loggedIcePairs.get(peerConnection) === pair.id) return;
      this.loggedIcePairs.set(peerConnection, pair.id);
      console.log(`[Mesh] ICE candidate pair retenu avec ${participantId}: type=${type}, local=${localType}, remote=${remoteType}.`);
    } catch (error) {
      console.warn(`[Mesh] Lecture du candidat ICE retenu avec ${participantId} impossible :`, error);
    }
  }

  async handleSignal(message) {
    if (!this.roomId || message.roomId !== this.roomId || message.to !== this.participantId) return;
    const peerId = message.from;

    try {
      if (message.type === "ROOM_ICE") {
        console.log(`[Mesh] ${peerId} -> ${this.participantId} candidat ICE reçu, type=${this.candidateType(message.payload)}.`);
        const pc = this.peerConnections.get(peerId);
        if (!pc || !pc.remoteDescription) {
          const queue = this.pendingIceCandidates.get(peerId) || [];
          queue.push(message.payload);
          this.pendingIceCandidates.set(peerId, queue);
          return;
        }
        await pc.addIceCandidate(new RTCIceCandidate(message.payload));
        return;
      }

      if (message.type === "ROOM_OFFER") {
        console.log(`[Mesh] offre reçue de ${peerId}.`);
        await this.mediaReady;
        if (this.roomId !== message.roomId) return;
        this.peerInitiators.set(peerId, false);
      } else if (message.type === "ROOM_ANSWER") {
        console.log(`[Mesh] réponse reçue de ${peerId}.`);
      }

      const pc = this.createPeerConnection(peerId);
      await pc.setRemoteDescription(new RTCSessionDescription(message.payload));
      await this.flushIceCandidates(peerId, pc);
      if (message.type === "ROOM_OFFER") {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        console.log(`[Mesh] ${this.participantId} -> ${peerId} réponse envoyée.`);
        this.send("ROOM_ANSWER", peerId, pc.localDescription);
      }
    } catch (error) {
      console.error(`[Mesh] Traitement ${message.type} depuis ${peerId} échoué :`, error);
      this.onMediaError("La connexion média avec un participant a échoué.");
    }
  }

  async flushIceCandidates(peerId, pc) {
    const candidates = this.pendingIceCandidates.get(peerId) || [];
    this.pendingIceCandidates.delete(peerId);
    for (const candidate of candidates) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
  }

  candidateType(candidate) {
    const value = candidate?.candidate || "";
    const match = value.match(/\btyp\s+(host|srflx|prflx|relay)\b/i);
    return (match && match[1].toLowerCase()) || candidate?.type || "unknown";
  }

  peerState(pc) {
    return {
      connectionState: pc.connectionState,
      iceConnectionState: pc.iceConnectionState,
      signalingState: pc.signalingState
    };
  }

  logPeerStates(participantId, pc) {
    console.log(
      `[Mesh] ${this.participantId} <-> ${participantId} ` +
      `iceConnectionState=${pc.iceConnectionState} ` +
      `connectionState=${pc.connectionState} signalingState=${pc.signalingState}`
    );
  }

  restartPeerIce(participantId, pc) {
    if (this.recoveryInProgress.has(participantId)) return;
    this.recoveryInProgress.add(participantId);
    this.onMediaError(`Connexion avec ${participantId} en échec. Tentative de rétablissement en cours.`);

    if (typeof pc.restartIce !== "function") {
      this.recoveryInProgress.delete(participantId);
      this.onMediaError(`La connexion avec ${participantId} a échoué et le redémarrage ICE n’est pas disponible dans ce navigateur.`);
      return;
    }

    try {
      pc.restartIce();
    } catch (error) {
      this.recoveryInProgress.delete(participantId);
      console.error(`[Mesh] restartIce pour ${participantId} échoué :`, error);
      this.onMediaError(`Impossible de redémarrer la connexion avec ${participantId}.`);
      return;
    }

    if (!this.peerInitiators.get(participantId)) return;
    this.pendingIceRestarts.add(participantId);
    this.sendPendingIceRestart(participantId, pc);
  }

  async sendPendingIceRestart(participantId, pc) {
    if (!this.pendingIceRestarts.has(participantId) || pc.signalingState !== "stable") return;
    this.pendingIceRestarts.delete(participantId);
    try {
      await this.createOffer(participantId, { iceRestart: true });
    } catch (error) {
      console.error(`[Mesh] Offre ICE restart vers ${participantId} échouée :`, error);
      this.onMediaError(`Impossible de relancer la connexion avec ${participantId}.`);
    }
  }

  send(type, to, payload) {
    this.callManager.sendSignal({ type, roomId: this.roomId, to, payload });
  }

  async updateParticipantCount(count) {
    const crossedMeshThreshold = this.participantCount < 3 && count >= 3;
    this.participantCount = count;
    if (!crossedMeshThreshold) return;
    const videoTrack = this.localStream?.getVideoTracks()[0];
    if (!videoTrack || typeof videoTrack.applyConstraints !== "function") return;
    try {
      await videoTrack.applyConstraints({
        width: { ideal: 640 },
        height: { ideal: 360 },
        frameRate: { ideal: 20, min: 15, max: 24 }
      });
    } catch (error) {
      console.warn("[Mesh] Impossible d’ajuster la fréquence vidéo à trois participants :", error);
      this.onMediaError("La fréquence vidéo n’a pas pu être réduite pour la réunion.");
    }
  }

  removeParticipant(participantId) {
    const pc = this.peerConnections.get(participantId);
    if (pc) pc.close();
    this.peerConnections.delete(participantId);
    this.pendingIceCandidates.delete(participantId);
    this.pendingNegotiations.delete(participantId);
    this.peerInitiators.delete(participantId);
    this.pendingIceRestarts.delete(participantId);
    this.recoveryInProgress.delete(participantId);
    for (const track of this.remoteStreams.get(participantId)?.getTracks() || []) track.stop();
    this.remoteStreams.delete(participantId);
    this.onPeerClosed(participantId);
  }

  closeRoom() {
    for (const participantId of Array.from(this.peerConnections.keys())) {
      this.removeParticipant(participantId);
    }
    for (const track of this.localStream?.getTracks() || []) track.stop();
    this.localStream = null;
    this.roomId = null;
    this.participantId = null;
    this.participantCount = 0;
    this.pendingIceCandidates.clear();
    this.peerInitiators.clear();
    this.pendingIceRestarts.clear();
    this.pendingNegotiations.clear();
    this.pendingTrackAcquisitions.clear();
    this.recoveryInProgress.clear();
    if (this.roomStateTimer) clearTimeout(this.roomStateTimer);
    this.roomStateTimer = null;
    this.lastRoomStateSentAt = null;
    this.onLocalStream(null);
    this.onMediaStateChange(this.getMediaState());
  }

  toggleAudio() {
    return this.toggleTrack("audio");
  }

  toggleVideo() {
    return this.toggleTrack("video");
  }

  async toggleTrack(kind) {
    const track = this.localStream?.getTracks().find(
      (item) => item.kind === kind && item.readyState === "live"
    );
    if (!track) return this.acquireMissingTrack(kind);
    track.enabled = !track.enabled;
    this.onMediaStateChange(this.getMediaState());
    this.sendRoomState();
    return track.enabled;
  }

  async acquireMissingTrack(kind) {
    if (!this.roomId) return null;
    if (this.pendingTrackAcquisitions.has(kind)) return this.pendingTrackAcquisitions.get(kind);
    const roomId = this.roomId;

    const acquisition = (async () => {
      let captured;
      try {
        captured = await navigator.mediaDevices.getUserMedia({
          audio: kind === "audio"
            ? (this.audioDeviceId ? { deviceId: { exact: this.audioDeviceId } } : true)
            : false,
          video: kind === "video"
            ? {
                ...(this.videoDeviceId ? { deviceId: { exact: this.videoDeviceId } } : {}),
                width: { ideal: 640 },
                height: { ideal: 360 },
                frameRate: { ideal: 20, max: 24 }
              }
            : false
        });
      } catch (error) {
        console.warn(`[Mesh] Réactivation ${kind} impossible :`, error);
        this.onMediaError(kind === "audio"
          ? "Le micro reste inaccessible. Vérifiez la permission et réessayez."
          : "La caméra reste inaccessible. Vérifiez la permission et réessayez.");
        return null;
      }

      const track = kind === "audio" ? captured.getAudioTracks()[0] : captured.getVideoTracks()[0];
      if (!track || this.roomId !== roomId) {
        captured.getTracks().forEach((item) => item.stop());
        return null;
      }
      track.enabled = true;
      if (!this.localStream) this.localStream = new MediaStream();
      this.localStream.addTrack(track);
      for (const item of captured.getTracks()) {
        if (item !== track) item.stop();
      }
      this.onLocalStream(this.localStream);

      for (const [peerId, pc] of this.peerConnections) {
        pc.addTrack(track, this.localStream);
        this.pendingNegotiations.add(peerId);
        this.sendPendingNegotiation(peerId, pc);
      }
      this.onMediaStateChange(this.getMediaState());
      this.sendRoomState();
      return true;
    })();

    this.pendingTrackAcquisitions.set(kind, acquisition);
    try {
      return await acquisition;
    } finally {
      if (this.pendingTrackAcquisitions.get(kind) === acquisition) {
        this.pendingTrackAcquisitions.delete(kind);
      }
    }
  }

  async sendPendingNegotiation(participantId, pc) {
    if (!this.pendingNegotiations.has(participantId) || pc.signalingState !== "stable") return;
    this.pendingNegotiations.delete(participantId);
    try {
      await this.createOffer(participantId);
    } catch (error) {
      console.error(`[Mesh] Renégociation avec ${participantId} impossible :`, error);
      this.onMediaError(`Impossible d’activer le média avec ${participantId}.`);
    }
  }

  sendRoomState() {
    if (!this.roomId) return;
    const now = Date.now();
    const elapsed = this.lastRoomStateSentAt === null
      ? 100
      : now - this.lastRoomStateSentAt;
    if (elapsed < 100) {
      if (!this.roomStateTimer) {
        this.roomStateTimer = setTimeout(() => {
          this.roomStateTimer = null;
          this.sendRoomState();
        }, 100 - elapsed);
      }
      return;
    }

    this.lastRoomStateSentAt = now;
    const state = this.getMediaState();
    this.callManager.sendSignal({
      type: "ROOM_STATE",
      roomId: this.roomId,
      audio: state.audio.available && state.audio.enabled,
      video: state.video.available && state.video.enabled
    });
  }

  getMediaState() {
    const trackState = (kind) => {
      const track = this.localStream?.getTracks().find(
        (item) => item.kind === kind && item.readyState === "live"
      );
      return { available: !!track, enabled: !!track?.enabled };
    };
    return { audio: trackState("audio"), video: trackState("video") };
  }
}

if (typeof window !== "undefined") {
  window.MeshManager = MeshManager;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = MeshManager;
}
