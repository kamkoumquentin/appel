class RoomManager {
  constructor(callManager) {
    if (!callManager || typeof callManager.sendSignal !== "function" ||
        typeof callManager.setRoomMessageHandler !== "function") {
      throw new TypeError("RoomManager nécessite une instance CallManager active.");
    }

    this.callManager = callManager;
    this.room = null;
    this.onRoomCreated = () => {};
    this.onRoomJoined = () => {};
    this.onParticipantJoined = () => {};
    this.onParticipantLeft = () => {};
    this.onRoomClosed = () => {};
    this.onRoomError = () => {};
    this.callManager.setRoomMessageHandler((message) => this.handleMessage(message));
  }

  createRoom() {
    this.callManager.sendSignal({ type: "CREATE_ROOM" });
  }

  joinRoom(code) {
    this.callManager.sendSignal({
      type: "JOIN_ROOM",
      code: String(code || "").trim().toUpperCase()
    });
  }

  leaveRoom() {
    if (!this.room) return false;
    this.callManager.sendSignal({
      type: "LEAVE_ROOM",
      roomId: this.room.roomId
    });
    this.room = null;
    return true;
  }

  handleMessage(message) {
    switch (message.type) {
      case "ROOM_CREATED":
        this.room = this.roomFromMessage(message);
        this.onRoomCreated(this.room);
        break;
      case "ROOM_JOINED":
        this.room = this.roomFromMessage(message);
        this.onRoomJoined(this.room);
        break;
      case "PARTICIPANT_JOINED":
        if (!this.isCurrentRoom(message.roomId)) return;
        this.room.participants = this.room.participants.filter(
          (participant) => participant.id !== message.participant.id
        );
        this.room.participants.push(message.participant);
        this.onParticipantJoined(message.participant, this.room);
        break;
      case "PARTICIPANT_LEFT":
        if (!this.isCurrentRoom(message.roomId)) return;
        this.room.participants = this.room.participants.filter(
          (participant) => participant.id !== message.participantId
        );
        this.onParticipantLeft(message.participantId, this.room);
        break;
      case "ROOM_CLOSED": {
        if (!this.isCurrentRoom(message.roomId)) return;
        const closedRoom = this.room;
        this.room = null;
        this.onRoomClosed({ ...message, room: closedRoom });
        break;
      }
      case "ROOM_ERROR":
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
      INVALID_CODE: "Le code de réunion est invalide. Il doit contenir 6 caractères."
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
