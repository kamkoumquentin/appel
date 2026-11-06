class MeshManager {
  constructor(callManager, options = {}) {
    this.callManager = callManager;
    this.iceServers = options.iceServers || window.APP_CONFIG.iceServers;
    this.onLocalStream = options.onLocalStream || (() => {});
    this.onRemoteStream = options.onRemoteStream || (() => {});
    this.onPeerClosed = options.onPeerClosed || (() => {});
    this.onMediaError = options.onMediaError || (() => {});
    this.onMediaStateChange = options.onMediaStateChange || (() => {});
    this.peerConnections = new Map();
    this.pendingIceCandidates = new Map();
    this.remoteStreams = new Map();
    this.localStream = null;
    this.roomId = null;
    this.participantId = null;
    this.participantCount = 0;
  }

  async startRoom(room, participantId, { initiateOffers = false } = {}) {
    this.roomId = room.roomId;
    this.participantId = participantId;
    this.participantCount = room.participants.length;

    try {
      const crowded = this.participantCount >= 3;
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: {
          width: { ideal: 640 },
          height: { ideal: 360 },
          frameRate: crowded ? { ideal: 20, min: 15, max: 24 } : { ideal: 24, max: 30 }
        }
      });
      this.onLocalStream(this.localStream);
    } catch (error) {
      console.warn("[Mesh] Accès micro/caméra refusé :", error);
      this.localStream = null;
      this.onLocalStream(null);
      this.onMediaError("Accès au micro ou à la caméra refusé. Vous rejoignez la réunion sans audio ni vidéo.");
    }

    this.onMediaStateChange(this.getMediaState());
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

  async createOffer(participantId) {
    const pc = this.createPeerConnection(participantId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
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
      if (candidate) this.send("ROOM_ICE", participantId, candidate);
    };
    pc.ontrack = (event) => {
      let stream = this.remoteStreams.get(participantId);
      if (!stream) {
        stream = event.streams[0] || new MediaStream();
        this.remoteStreams.set(participantId, stream);
      }
      if (!stream.getTracks().includes(event.track)) stream.addTrack(event.track);
      this.onRemoteStream(participantId, stream);
    };
    pc.oniceconnectionstatechange = () => {
      console.log(`[Mesh] ICE ${this.participantId} -> ${participantId}: ${pc.iceConnectionState}`);
    };
    this.peerConnections.set(participantId, pc);
    return pc;
  }

  async handleSignal(message) {
    if (!this.roomId || message.roomId !== this.roomId || message.to !== this.participantId) return;
    const peerId = message.from;

    try {
      if (message.type === "ROOM_ICE") {
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

      const pc = this.createPeerConnection(peerId);
      await pc.setRemoteDescription(new RTCSessionDescription(message.payload));
      await this.flushIceCandidates(peerId, pc);
      if (message.type === "ROOM_OFFER") {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
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
    this.onLocalStream(null);
    this.onMediaStateChange(this.getMediaState());
  }

  toggleAudio() {
    return this.toggleTrack("audio");
  }

  toggleVideo() {
    return this.toggleTrack("video");
  }

  toggleTrack(kind) {
    const track = this.localStream?.getTracks().find((item) => item.kind === kind);
    if (!track) return null;
    track.enabled = !track.enabled;
    this.onMediaStateChange(this.getMediaState());
    return track.enabled;
  }

  getMediaState() {
    const trackState = (kind) => {
      const track = this.localStream?.getTracks().find((item) => item.kind === kind);
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
