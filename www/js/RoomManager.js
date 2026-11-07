class RoomManager {
  constructor(callManager, meshManager) {
    if (!callManager || typeof callManager.sendSignal !== "function" ||
        typeof callManager.setRoomMessageHandler !== "function") {
      throw new TypeError("RoomManager nécessite une instance CallManager active.");
    }
    if (!meshManager || typeof meshManager.startRoom !== "function") {
      throw new TypeError("RoomManager nécessite une instance MeshManager active.");
    }

    this.callManager = callManager;
    this.meshManager = meshManager;
    this.room = null;
    this.pendingAction = false;
    this.pendingMediaOptions = null;
    this.onRoomCreated = () => {};
    this.onRoomJoined = () => {};
    this.onParticipantJoined = () => {};
    this.onParticipantStateChange = () => {};
    this.onParticipantLeft = () => {};
    this.onHandRaised = () => {};
    this.onParticipantMuted = () => {};
    this.onParticipantKicked = () => {};
    this.onRoomLocked = () => {};
    this.onRoomClosed = () => {};
    this.onRoomError = () => {};
    this.onChatMessage = () => {};
    this.onChatError = () => {};
    this.callManager.setRoomMessageHandler((message) => this.handleMessage(message));

    const handleSocketMessage = this.callManager.handleSocketMessage.bind(this.callManager);
    this.callManager.handleSocketMessage = (message) => {
      if ([
        "CHAT",
        "PARTICIPANT_STATE",
        "PARTICIPANT_HAND",
        "PARTICIPANT_MUTED",
        "PARTICIPANT_KICKED",
        "ROOM_LOCKED"
      ].includes(message.type)) {
        this.handleMessage(message);
        return;
      }
      if (["ROOM_OFFER", "ROOM_ANSWER", "ROOM_ICE"].includes(message.type)) {
        this.meshManager.handleSignal(message);
        return;
      }
      handleSocketMessage(message);
    };
  }

  get isActive() {
    return !!this.room || this.pendingAction;
  }

  createRoom(displayName, mediaOptions = {}) {
    if (!this.canStartRoom()) return false;
    this.pendingAction = true;
    this.pendingMediaOptions = mediaOptions;
    this.callManager.sendSignal({
      type: "CREATE_ROOM",
      displayName,
      audio: mediaOptions.audio === true,
      video: mediaOptions.video === true
    });
    return true;
  }

  joinRoom(code, displayName, mediaOptions = {}) {
    if (!this.canStartRoom()) return false;
    this.pendingAction = true;
    this.pendingMediaOptions = mediaOptions;
    this.callManager.sendSignal({
      type: "JOIN_ROOM",
      code: String(code || "").trim().toUpperCase(),
      displayName,
      audio: mediaOptions.audio === true,
      video: mediaOptions.video === true
    });
    return true;
  }

  canStartRoom() {
    if (this.isActive) {
      this.onRoomError({ message: "Vous participez déjà à une réunion." });
      return false;
    }
    if (this.callManager.callState !== "IDLE") {
      this.onRoomError({ code: "CALL_ACTIVE", message: "Terminez l’appel en cours avant de rejoindre une réunion." });
      return false;
    }
    return true;
  }

  sendChatMessage(message) {
    if (!this.room) return false;
    if (typeof message === "string") {
      this.callManager.sendSignal({
        type: "CHAT_MESSAGE",
        roomId: this.room.roomId,
        text: message
      });
      return true;
    }

    if (!message || typeof message !== "object" ||
        !["text", "file", "voice"].includes(message.type)) {
      throw new TypeError("Le message chat doit être un texte ou un contenu text, file ou voice.");
    }

    this.callManager.sendSignal({
      type: "CHAT_MESSAGE",
      roomId: this.room.roomId,
      version: 2,
      clientMessageId: message.clientMessageId || crypto.randomUUID(),
      message
    });
    return true;
  }

  async uploadAttachment({ roomId, kind, blob, name, mimeType, durationMs }) {
    if (!this.room || roomId !== this.room.roomId) {
      throw new Error("Vous ne participez plus à cette réunion.");
    }
    if (!["file", "voice"].includes(kind)) {
      throw new TypeError("Le type de pièce jointe doit être file ou voice.");
    }
    if (!(blob instanceof Blob) || blob.size <= 0) {
      throw new TypeError("La pièce jointe est vide ou invalide.");
    }

    const userId = this.callManager.userId;
    const sessionToken = this.callManager.sessionToken;
    if (typeof userId !== "string" || !userId ||
        typeof sessionToken !== "string" || !sessionToken) {
      throw new Error("La session utilisateur est indisponible pour envoyer une pièce jointe.");
    }

    const resolvedMimeType = String(mimeType || blob.type || "").trim().toLowerCase();
    if (!resolvedMimeType) {
      throw new Error("Le type MIME de la pièce jointe est manquant.");
    }

    const httpBaseUrl = this.callManager.serverUrl
      .replace(/^wss:/i, "https:")
      .replace(/^ws:/i, "http:");
    const authUrl = new URL("/room-upload-auth", httpBaseUrl);
    const headers = {
      "Content-Type": "application/json",
      "X-User-Id": userId,
      "X-Session-Token": sessionToken
    };
    const authPayload = {
      roomId,
      type: kind,
      mimeType: resolvedMimeType,
      size: blob.size,
      ...(kind === "file" ? { name: name || blob.name || "fichier" } : {}),
      ...(kind === "voice" ? { durationMs } : {})
    };

    const readResponse = async (response) => {
      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        throw new Error(`Réponse invalide du serveur de pièces jointes (HTTP ${response.status}).`);
      }
      if (!response.ok) {
        const requestError = new Error(payload.message || `Échec de la requête de pièce jointe (HTTP ${response.status}).`);
        requestError.code = payload.code || "ATTACHMENT_REQUEST_FAILED";
        throw requestError;
      }
      return payload;
    };

    const authResponse = await fetch(authUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(authPayload)
    });
    const authorization = await readResponse(authResponse);
    if (typeof authorization.attachmentId !== "string" ||
        typeof authorization.uploadUrl !== "string") {
      throw new Error("La réponse d’autorisation de transfert est incomplète.");
    }

    const uploadUrl = new URL(authorization.uploadUrl, httpBaseUrl);
    const uploadResponse = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": resolvedMimeType,
        "X-User-Id": userId,
        "X-Session-Token": sessionToken
      },
      body: blob
    });
    await readResponse(uploadResponse);

    return {
      attachmentId: authorization.attachmentId,
      name: kind === "file" ? (name || blob.name || "fichier") : undefined,
      mimeType: resolvedMimeType,
      size: blob.size,
      durationMs: kind === "voice" ? durationMs : undefined
    };
  }

  async sendFileMessage(file) {
    if (!this.room) return false;
    const roomId = this.room.roomId;
    const attachment = await this.uploadAttachment({
      roomId,
      kind: "file",
      blob: file,
      name: file?.name,
      mimeType: file?.type
    });
    if (!this.sendChatMessage({ type: "file", ...attachment })) {
      throw new Error("La réunion s’est terminée avant l’envoi du message.");
    }
    return true;
  }

  async sendVoiceMessage(blob, durationMs) {
    if (!this.room) return false;
    const roomId = this.room.roomId;
    const attachment = await this.uploadAttachment({
      roomId,
      kind: "voice",
      blob,
      mimeType: blob?.type,
      durationMs
    });
    if (!this.sendChatMessage({ type: "voice", ...attachment })) {
      throw new Error("La réunion s’est terminée avant l’envoi du message vocal.");
    }
    return true;
  }

  leaveRoom() {
    if (!this.room) return false;
    const roomId = this.room.roomId;
    this.callManager.sendSignal({ type: "LEAVE_ROOM", roomId });
    this.room = null;
    this.meshManager.closeRoom();
    return true;
  }

  raiseHand(raised) {
    if (!this.room || typeof raised !== "boolean") return false;
    this.callManager.sendSignal({
      type: "RAISE_HAND",
      roomId: this.room.roomId,
      raised
    });
    return true;
  }

  muteAll() {
    if (!this.room) return false;
    this.callManager.sendSignal({ type: "MUTE_ALL", roomId: this.room.roomId });
    return true;
  }

  kickParticipant(targetId) {
    if (!this.room || typeof targetId !== "string" || !targetId) return false;
    this.callManager.sendSignal({
      type: "KICK_PARTICIPANT",
      roomId: this.room.roomId,
      targetId
    });
    return true;
  }

  lockRoom(locked) {
    if (!this.room || typeof locked !== "boolean") return false;
    this.callManager.sendSignal({
      type: "LOCK_ROOM",
      roomId: this.room.roomId,
      locked
    });
    return true;
  }

  handleMessage(message) {
    switch (message.type) {
      case "ROOM_CREATED":
      case "ROOM_JOINED": {
        this.pendingAction = false;
        this.room = this.roomFromMessage(message);
        const room = this.room;
        if (message.type === "ROOM_CREATED") this.onRoomCreated(room);
        else this.onRoomJoined(room);
        const mediaOptions = this.pendingMediaOptions || {};
        this.pendingMediaOptions = null;
        this.meshManager.startRoom(room, this.callManager.userId, {
          initiateOffers: message.type === "ROOM_JOINED",
          localStream: mediaOptions.localStream || null,
          mediaPrepared: mediaOptions.mediaPrepared === true,
          audioEnabled: mediaOptions.audio === true,
          videoEnabled: mediaOptions.video === true,
          audioDeviceId: mediaOptions.audioDeviceId,
          videoDeviceId: mediaOptions.videoDeviceId
        }).catch((error) => {
          console.error("[RoomManager] Démarrage média de la salle impossible :", error);
          this.onRoomError({ message: "Impossible de démarrer les médias de la réunion." });
        });
        break;
      }
      case "PARTICIPANT_JOINED":
        if (!this.isCurrentRoom(message.roomId)) return;
        this.room.participants = this.room.participants.filter(
          (participant) => participant.id !== message.participant.id
        );
        this.room.participants.push(message.participant);
        this.meshManager.updateParticipantCount(this.room.participants.length);
        this.onParticipantJoined(message.participant, this.room);
        break;
      case "PARTICIPANT_STATE": {
        if (!this.isCurrentRoom(message.roomId)) return;
        const participant = this.room.participants.find((item) => item.id === message.participantId);
        if (!participant) return;
        participant.audio = message.audio;
        participant.video = message.video;
        this.onParticipantStateChange(participant, this.room);
        break;
      }
      case "PARTICIPANT_HAND": {
        if (!this.isCurrentRoom(message.roomId) || typeof message.raised !== "boolean") return;
        const participant = this.room.participants.find((item) => item.id === message.participantId);
        if (!participant) return;
        participant.raised = message.raised;
        this.onHandRaised(participant, this.room);
        break;
      }
      case "PARTICIPANT_MUTED": {
        if (!this.isCurrentRoom(message.roomId)) return;
        const participant = this.room.participants.find((item) => item.id === message.participantId);
        if (!participant) return;
        participant.audio = false;
        if (participant.id === this.callManager.userId) {
          const audioTrack = this.meshManager.localStream?.getAudioTracks().find(
            (track) => track.readyState === "live"
          );
          if (audioTrack?.enabled) this.meshManager.toggleAudio();
        }
        this.onParticipantMuted(participant.id, this.room, participant);
        break;
      }
      case "PARTICIPANT_KICKED": {
        if (!this.isCurrentRoom(message.roomId)) return;
        const kickedRoom = this.room;
        const participant = kickedRoom.participants.find((item) => item.id === message.participantId);
        const isSelf = message.participantId === this.callManager.userId;
        if (isSelf) {
          this.room = null;
          this.meshManager.closeRoom();
        } else {
          this.meshManager.removeParticipant(message.participantId);
          kickedRoom.participants = kickedRoom.participants.filter(
            (item) => item.id !== message.participantId
          );
          this.meshManager.updateParticipantCount(kickedRoom.participants.length);
        }
        this.onParticipantKicked(message, kickedRoom, participant, isSelf);
        break;
      }
      case "ROOM_LOCKED": {
        if (!this.isCurrentRoom(message.roomId) || typeof message.locked !== "boolean") return;
        this.room.locked = message.locked;
        this.onRoomLocked(message.locked, this.room);
        break;
      }
      case "CHAT":
        if (!this.isCurrentRoom(message.roomId)) return;
        this.onChatMessage(message);
        break;
      case "PARTICIPANT_LEFT":
        if (!this.isCurrentRoom(message.roomId)) return;
        const departingParticipant = this.room.participants.find(
          (participant) => participant.id === message.participantId
        );
        const participantsBeforeDeparture = this.room.participants.slice();
        this.meshManager.removeParticipant(message.participantId);
        this.room.participants = this.room.participants.filter(
          (participant) => participant.id !== message.participantId
        );
        this.onParticipantLeft(
          message.participantId,
          this.room,
          departingParticipant,
          participantsBeforeDeparture
        );
        break;
      case "ROOM_CLOSED": {
        if (!this.isCurrentRoom(message.roomId)) return;
        const closedRoom = this.room;
        this.room = null;
        this.meshManager.closeRoom();
        this.onRoomClosed({ ...message, room: closedRoom });
        break;
      }
      case "ROOM_ERROR":
        if (message.requestType === "CHAT_MESSAGE") {
          this.onChatError({
            ...message,
            message: this.errorMessage(message.code, message.message)
          });
          break;
        }
        this.pendingAction = false;
        this.onRoomError({
          ...message,
          message: this.errorMessage(message.code, message.message)
        });
        break;
    }
  }

  roomFromMessage(message) {
    return {
      roomId: message.roomId,
      code: message.code,
      hostId: message.hostId,
      state: message.state,
      locked: message.locked === true,
      participants: Array.isArray(message.participants) ? message.participants : []
    };
  }

  isCurrentRoom(roomId) {
    return !!this.room && this.room.roomId === roomId;
  }

  static formatDisplayName(participant, participants = []) {
    const displayName = String(participant?.displayName || "Participant").trim() || "Participant";
    const matching = participants.filter((item) =>
      String(item.displayName || "Participant").trim().toLocaleLowerCase() === displayName.toLocaleLowerCase()
    );
    if (matching.length < 2) return displayName;

    const index = matching.findIndex((item) => item.id === participant.id);
    return index > 0 ? `${displayName} (${index + 1})` : displayName;
  }

  errorMessage(code, fallback) {
    const messages = {
      ROOM_NOT_FOUND: "Salle introuvable. Vérifiez le code et réessayez.",
      ROOM_LOCKED: "Cette réunion est verrouillée par l’hôte.",
      ROOM_FULL: "Cette réunion est complète.",
      ALREADY_IN_ROOM: "Vous participez déjà à une réunion.",
      STATE_RATE_LIMITED: "Trop de changements micro/caméra. Réessayez dans un instant.",
      INVALID_STATE: "L’état du micro ou de la caméra est invalide.",
      INVALID_CODE: "Le code de réunion est invalide. Il doit contenir 6 caractères.",
      CALL_ACTIVE: "Terminez l’appel en cours avant de rejoindre une réunion.",
      AUTH_REQUIRED: "Reconnectez-vous pour accéder aux réunions.",
      HOST_REQUIRED: "Seul l’hôte peut effectuer cette action.",
      INVALID_TARGET: "Le participant à expulser est invalide.",
      NOT_IN_ROOM: "Impossible d’établir la connexion avec ce participant.",
      CHAT_EMPTY: "Le message est vide. Saisissez un texte avant de l’envoyer.",
      CHAT_TOO_LONG: "Le message dépasse la limite de 500 caractères.",
      CHAT_RATE_LIMITED: "Vous envoyez des messages trop rapidement. Réessayez dans quelques secondes."
    };
    return messages[code] || fallback || "Une erreur est survenue pour cette réunion.";
  }
}

if (typeof window !== "undefined") {
  window.RoomManager = RoomManager;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = RoomManager;
}
