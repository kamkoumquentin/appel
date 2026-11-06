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
    this.onRoomCreated = () => {};
    this.onRoomJoined = () => {};
    this.onParticipantJoined = () => {};
    this.onParticipantLeft = () => {};
    this.onRoomClosed = () => {};
    this.onRoomError = () => {};
    this.callManager.setRoomMessageHandler((message) => this.handleMessage(message));

    const handleSocketMessage = this.callManager.handleSocketMessage.bind(this.callManager);
    this.callManager.handleSocketMessage = (message) => {
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

  createRoom() {
    if (!this.canStartRoom()) return false;
    this.pendingAction = true;
    this.callManager.sendSignal({ type: "CREATE_ROOM" });
    return true;
  }

  joinRoom(code) {
    if (!this.canStartRoom()) return false;
    this.pendingAction = true;
    this.callManager.sendSignal({
      type: "JOIN_ROOM",
      code: String(code || "").trim().toUpperCase()
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

  leaveRoom() {
    if (!this.room) return false;
    const roomId = this.room.roomId;
    this.callManager.sendSignal({ type: "LEAVE_ROOM", roomId });
    this.room = null;
    this.meshManager.closeRoom();
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
        this.meshManager.startRoom(room, this.callManager.userId, {
          initiateOffers: message.type === "ROOM_JOINED"
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
      case "PARTICIPANT_LEFT":
        if (!this.isCurrentRoom(message.roomId)) return;
        this.meshManager.removeParticipant(message.participantId);
        this.room.participants = this.room.participants.filter(
          (participant) => participant.id !== message.participantId
        );
        this.onParticipantLeft(message.participantId, this.room);
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
      participants: Array.isArray(message.participants) ? message.participants : []
    };
  }

  isCurrentRoom(roomId) {
    return !!this.room && this.room.roomId === roomId;
  }

  errorMessage(code, fallback) {
    const messages = {
      ROOM_NOT_FOUND: "Salle introuvable. Vérifiez le code et réessayez.",
      ROOM_FULL: "Cette réunion est complète.",
      ALREADY_IN_ROOM: "Vous participez déjà à une réunion.",
      INVALID_CODE: "Le code de réunion est invalide. Il doit contenir 6 caractères.",
      CALL_ACTIVE: "Terminez l’appel en cours avant de rejoindre une réunion.",
      AUTH_REQUIRED: "Reconnectez-vous pour accéder aux réunions.",
      NOT_IN_ROOM: "Impossible d’établir la connexion avec ce participant."
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
