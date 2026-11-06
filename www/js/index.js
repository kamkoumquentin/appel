/**
 * ============================================================================
 * index.js - Contrôleur UI & Orchestration de l'Application KamSoft
 * ============================================================================
 * Ce script gère l'affichage, les interactions utilisateur et pilote le SDK CallManager.
 */

let callManager = null;
let roomManager = null;
let meshManager = null;
let callTimerInterval = null;
let callStartTime = null;
let currentAudioMode = "EARPIECE"; // EARPIECE | SPEAKER | BLUETOOTH
let remoteVideoPlayPromise = null;
let requestRemoteVideoPlay = null;

// Initialisation au démarrage
if (window.cordova) {
  document.addEventListener("deviceready", initApp, false);
} else {
  if (document.readyState === "complete" || document.readyState === "interactive") {
    setTimeout(initApp, 50);
  } else {
    document.addEventListener("DOMContentLoaded", initApp, false);
  }
}

// ── FONCTION CENTRALE DE DÉTECTION DE L'ÉTAT PHYSIQUE DE L'ÉCRAN ─────────────
let dernierEtatEcranSurveille = null;
function verifierEtatEcranPhysique(origine = "manuel") {
  if (!callManager) return;
  if (window.cordova?.plugins?.backgroundMode?.isScreenOff) {
    window.cordova.plugins.backgroundMode.isScreenOff((isOff) => {
      const nouvelEtat = isOff ? "SCREEN_OFF" : "SCREEN_ON";
      if (nouvelEtat !== dernierEtatEcranSurveille) {
        dernierEtatEcranSurveille = nouvelEtat;
        console.log(`📱 [CAPTEUR MATÉRIEL (${origine})] Transition écran détectée : ${nouvelEtat} (isOff=${isOff})`);
        callManager.setScreenState(nouvelEtat);
      }
    });
  }
}

// ── GESTION DU MAINTIEN DE L'ÉCRAN ALLUMÉ (cordova-plugin-insomnia) ──────────
function activerKeepAwake() {
  if (window.plugins && window.plugins.insomnia) {
    window.plugins.insomnia.keepAwake(
      () => console.log("☀️ [Insomnia] keepAwake actif (écran maintenu allumé)"),
      (err) => console.warn("⚠️ [Insomnia] Erreur keepAwake :", err)
    );
  }
}

function desactiverKeepAwake() {
  if (window.plugins && window.plugins.insomnia) {
    window.plugins.insomnia.allowSleepAgain(
      () => console.log("🌙 [Insomnia] allowSleepAgain actif (mise en veille autorisée)"),
      (err) => console.warn("⚠️ [Insomnia] Erreur allowSleepAgain :", err)
    );
  }
}

document.addEventListener("resume", () => {
  console.log("📱 Application réactivée (resume / 1er plan)");
  activerKeepAwake();
  if (callManager) {
    callManager.connectWebSocket();
    callManager.setAppState(true);
    callManager.verifyFullScreenIntentPermission();
    dernierEtatEcranSurveille = "SCREEN_ON";
    callManager.setScreenState("SCREEN_ON");

    // ── GARANTIE INTERFACE 2 ACTIVE LORS DU RÉVEIL DE VEILLE ─────────────────
    // Si un appel entrant est en cours de sonnerie, forcer l'affichage de l'Interface 2
    if (callManager.callState === "RINGING") {
      const activeView1 = document.getElementById("interface-1");
      const isInterface1Active = activeView1 && activeView1.classList.contains("active");
      if (!isInterface1Active) {
        console.log("🌙 [Rattrapage Resume] Affichage garanti de l'Interface 2 active");
        showIncomingCallUI(callManager.currentCallerId || callManager.targetUserId);
      }
    }
  }
}, false);

document.addEventListener("pause", () => {
  console.log("📱 Application mise en arrière-plan (pause)");
  desactiverKeepAwake();
  if (callManager) {
    callManager.setAppState(false);
    // Lors de la mise en veille/verrouillage de l'écran, le système met quelques
    // centaines de millisecondes à couper le rétroéclairage (isInteractive passe à false).
    // On effectue des vérifications échelonnées pour capturer immédiatement l'état SCREEN_OFF.
    verifierEtatEcranPhysique("pause_immediate");
    setTimeout(() => verifierEtatEcranPhysique("pause_delay_300ms"), 300);
    setTimeout(() => verifierEtatEcranPhysique("pause_delay_800ms"), 800);
    setTimeout(() => verifierEtatEcranPhysique("pause_delay_1500ms"), 1500);
  }
}, false);

document.addEventListener("visibilitychange", () => {
  const isVisible = document.visibilityState === "visible";
  if (isVisible) {
    activerKeepAwake();
  } else {
    desactiverKeepAwake();
  }
  if (callManager) {
    console.log(`📱 Visibilité document changée : ${isVisible ? "visible" : "caché"}`);
    callManager.setAppState(isVisible);
    if (isVisible) {
      dernierEtatEcranSurveille = "SCREEN_ON";
      callManager.setScreenState("SCREEN_ON");

      // ── GARANTIE INTERFACE 2 ACTIVE SUR VISIBILITÉ ─────────────────────────
      if (callManager.callState === "RINGING") {
        const activeView1 = document.getElementById("interface-1");
        const isInterface1Active = activeView1 && activeView1.classList.contains("active");
        if (!isInterface1Active) {
          console.log("🌙 [Rattrapage Visibility] Affichage garanti de l'Interface 2 active");
          showIncomingCallUI(callManager.currentCallerId || callManager.targetUserId);
        }
      }
    } else {
      setTimeout(() => verifierEtatEcranPhysique("visibility_hidden_300ms"), 300);
      setTimeout(() => verifierEtatEcranPhysique("visibility_hidden_800ms"), 800);
    }
  }
}, false);

// Sécurité supplémentaire lors de la fermeture ou déchargement de la page
window.addEventListener("pagehide", desactiverKeepAwake, false);
window.addEventListener("beforeunload", desactiverKeepAwake, false);

// ── SURVEILLANCE CONTINUE EN ARRIÈRE-PLAN ───────────────────────────────────
setInterval(() => {
  verifierEtatEcranPhysique("interval");
}, 1000);

/* ==========================================================================
   1. DÉMARRAGE DE L'APPLICATION
   ========================================================================== */

async function initApp() {
  console.log("🚀 Initialisation de l'application KamSoft...");
  activerKeepAwake();

  // Demande des permissions préalables (si sur Cordova)
  await checkNativePermissions();

  // Création de l'instance CallManager
  callManager = new CallManager({
    serverUrl: window.APP_CONFIG.serverUrl,
    iceServers: window.APP_CONFIG.iceServers,

    onRegistered: (myId) => {
      const idElem = document.getElementById("my-id-display");
      if (idElem) idElem.innerText = myId;
      updateStatus("En ligne");
    },

    onStatusChange: (status) => {
      updateStatus(status);
    },

    onIncomingCall: ({ callId, callerId, callerName, hasVideo, isAppVisible }) => {
      if (roomManager?.isActive) {
        callManager.rejectCall(callId, "room_active");
        roomManager.onRoomError({ message: "Un appel entrant a été refusé pendant la réunion." });
        return;
      }
      // Si on est déjà en cours d'acceptation ou en communication, NE PAS afficher l'écran d'appel entrant
      if (callManager && (callManager.callState === "ACCEPTING" || callManager.callState === "CONNECTED")) {
        return;
      }
      const activeView = document.getElementById("interface-1");
      if (activeView && activeView.classList.contains("active")) {
        return;
      }
      showIncomingCallUI(callerName || callerId);
    },

    onCallAccepted: ({ callId, targetId }) => {
      hideIncomingCallUI();
      showActiveCallUI(targetId);
      startCallTimer();
    },

    onCallConnected: ({ callId, targetId, stream }) => {
      updateStatus("En communication");
    },

    onCallEnded: ({ callId, reason }) => {
      stopCallTimer();
      hideIncomingCallUI();
      hideActiveCallUI();
      resetMediaUI();
      updateStatus("En ligne");
      // ── FIX : réinitialiser le mode audio pour le prochain appel
      currentAudioMode = "EARPIECE";
    },

  
    onRemoteStream: (stream) => {
  const callId = callManager?.currentCallId || "n/a";
  console.log("[WEBRTC_VIDEO_DIAG] display remote-stream", {
    callId,
    direction: "receive/display",
    tracks: stream.getTracks().map((track) => ({
      kind: track.kind,
      id: track.id,
      enabled: track.enabled,
      muted: track.muted,
      readyState: track.readyState
    }))
  });

  const remoteAudio = document.getElementById("remoteAudio");
  const remoteVideo = document.getElementById("remoteVideo");
  const avatarContainer = document.getElementById("avatar-container");
  const callContainer = document.querySelector("#interface-1 .app-container");

  const logRemoteVideoState = (event) => {
    console.log("[WEBRTC_VIDEO_DIAG] display remoteVideo", {
      callId,
      direction: "receive/display",
      event,
      readyState: remoteVideo?.readyState ?? null,
      videoWidth: remoteVideo?.videoWidth ?? null,
      videoHeight: remoteVideo?.videoHeight ?? null,
      paused: remoteVideo?.paused ?? null,
      hasSrcObject: !!remoteVideo?.srcObject
    });
  };

  // Audio
  if (remoteAudio) {
    if (remoteAudio.srcObject !== stream) {
      remoteAudio.srcObject = stream;
    }
    remoteAudio.play().catch((e) => console.warn("Erreur remoteAudio play :", e));
  }

  // Fonction pour tenter de jouer la vidéo
  requestRemoteVideoPlay = () => {
    if (!remoteVideo || remoteVideo.srcObject !== stream) return;

    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack || videoTrack.readyState !== "live") return;

    // On ne bloque plus sur muted
    if (remoteVideo.paused) {
      logRemoteVideoState("before-play");
      remoteVideoPlayPromise = remoteVideo.play()
        .then(() => logRemoteVideoState("play-resolved"))
        .catch((error) => {
          console.warn("[WEBRTC_VIDEO_DIAG] display remoteVideo play-rejected", {
            callId,
            name: error.name,
            message: error.message
          });
        })
        .finally(() => {
          remoteVideoPlayPromise = null;
        });
    }
  };

  // Mise à jour de l'affichage
  const updateRemoteVideo = () => {
    const videoTrack = stream.getVideoTracks()[0];
    // CORRECTION IMPORTANTE : on n'exige plus !videoTrack.muted
    const hasVideoTrack = !!videoTrack && videoTrack.readyState === "live";

    if (remoteVideo) {
      if (remoteVideo.srcObject !== stream) {
        remoteVideo.srcObject = stream;
      }
      remoteVideo.muted = true; // important pour éviter l'écho
      remoteVideo.style.display = hasVideoTrack ? "block" : "none";
      logRemoteVideoState(hasVideoTrack ? "video-visible" : "video-hidden");
    }

    if (avatarContainer) {
      avatarContainer.style.display = hasVideoTrack ? "none" : "flex";
    }
    if (callContainer) {
      callContainer.classList.toggle("video-call-active", hasVideoTrack);
    }
  };

  // Écoute des changements de piste
  const videoTrack = stream.getVideoTracks()[0];
  if (videoTrack) {
    videoTrack.onmute = () => {
      console.log("[WEBRTC_VIDEO_DIAG] remote track muted");
      updateRemoteVideo();
    };
    videoTrack.onunmute = () => {
      console.log("[WEBRTC_VIDEO_DIAG] remote track unmuted");
      updateRemoteVideo();
      // On force le play après un petit délai (certaines WebView ont besoin)
      setTimeout(() => requestRemoteVideoPlay?.(), 150);
    };
  }

  // Première mise à jour
  updateRemoteVideo();

  if (remoteVideo) {
    remoteVideo.onloadedmetadata = () => {
      logRemoteVideoState("loadedmetadata");
      requestRemoteVideoPlay?.();
    };
    remoteVideo.onloadeddata = () => {
      logRemoteVideoState("loadeddata");
      requestRemoteVideoPlay?.();
    };
    remoteVideo.oncanplay = () => {
      logRemoteVideoState("canplay");
      requestRemoteVideoPlay?.();
    };
    remoteVideo.onplaying = () => logRemoteVideoState("playing");
    remoteVideo.onerror = () => {
      console.error("[WEBRTC_VIDEO_DIAG] display remoteVideo error", {
        callId,
        mediaError: remoteVideo.error
      });
    };

    // Tentative immédiate + plusieurs retries
    requestRemoteVideoPlay();
    setTimeout(() => requestRemoteVideoPlay?.(), 300);
    setTimeout(() => requestRemoteVideoPlay?.(), 800);
  }
},


 onLocalStream: (stream) => {
  console.log("📹 Flux local mis à jour", {
    tracks: stream.getTracks().map(t => ({
      kind: t.kind,
      enabled: t.enabled,
      muted: t.muted,
      readyState: t.readyState
    }))
  });

  const localVideo = document.getElementById("localVideo");
  const videoTrack = stream.getVideoTracks()[0];
  const hasVideoTrack = !!videoTrack && videoTrack.enabled && videoTrack.readyState === "live";

  if (localVideo) {
    localVideo.srcObject = hasVideoTrack ? stream : null;
    localVideo.style.display = hasVideoTrack ? "block" : "none";
    localVideo.muted = true; // toujours muted pour la vidéo locale
    localVideo.playsInline = true;

    const btnSwitch = document.getElementById("btn-switch-camera");
    if (btnSwitch) {
      btnSwitch.style.display = hasVideoTrack ? "block" : "none";
    }
  }
},



    onError: (err) => {
      console.error("❌ Erreur CallManager :", err);
      alert(err.message || "Une erreur est survenue.");
    }
  });

  meshManager = new MeshManager(callManager, {
    iceServers: window.APP_CONFIG.iceServers,
    onLocalStream: renderRoomLocalStream,
    onRemoteStream: renderRoomRemoteStream,
    onPeerClosed: removeRoomVideoTile,
    onMediaError: afficherRoomMediaError,
    onMediaStateChange: updateRoomMediaButtons
  });
  roomManager = new RoomManager(callManager, meshManager);
  roomManager.onRoomCreated = afficherSalle;
  roomManager.onRoomJoined = afficherSalle;
  roomManager.onParticipantJoined = (_participant, room) => afficherSalle(room);
  roomManager.onParticipantLeft = (_participantId, room) => afficherSalle(room);
  roomManager.onRoomClosed = ({ reason }) => {
    afficherSalle(null);
    afficherErreurSalle(
      reason === "host_left" || reason === "disconnected"
        ? "L’hôte a quitté la réunion. La salle est fermée."
        : "La réunion est terminée."
    );
  };
  roomManager.onRoomError = ({ message }) => {
    if (roomManager.room) afficherRoomMediaError(message);
    else afficherErreurSalle(message);
  };

  // Démarrer CallManager
  const myId = await callManager.init();
  const idDisplay = document.getElementById("my-id-display");
  if (idDisplay) idDisplay.innerText = myId;
}

/* ==========================================================================
   2. DEMANDE DE PERMISSIONS ANDROID RUNTIME
   ========================================================================== */

async function checkNativePermissions() {
  if (window.cordova?.plugins?.permissions) {
    const permissions = window.cordova.plugins.permissions;
    const required = [
      permissions.RECORD_AUDIO || "android.permission.RECORD_AUDIO",
      permissions.MODIFY_AUDIO_SETTINGS || "android.permission.MODIFY_AUDIO_SETTINGS",
      permissions.POST_NOTIFICATIONS || "android.permission.POST_NOTIFICATIONS",
      permissions.BLUETOOTH_CONNECT || "android.permission.BLUETOOTH_CONNECT"
    ];

    return new Promise((resolve) => {
      permissions.requestPermissions(required, () => {
        console.log("✅ Permissions Android accordées");
        resolve();
      }, (err) => {
        console.warn("⚠️ Avertissement permissions :", err);
        resolve();
      });
    });
  }

  // ── LACUNE 7 FIX : Demande d'autorisation Notification API Web ────────────
  // Uniquement pour le mode navigateur (pas Cordova). Permet d'afficher une
  // notification système native quand l'app est en arrière-plan dans le browser.
  await requestWebNotificationPermission();
  // ──────────────────────────────────────────────────────────────────────
}

function createRoom() {
  if (!roomManager) return;
  afficherErreurSalle("");
  roomManager.createRoom();
}

function joinRoom() {
  if (!roomManager) return;
  const codeInput = document.getElementById("room-code-input");
  roomManager.joinRoom(codeInput ? codeInput.value : "");
}

function leaveRoom() {
  if (!roomManager || !roomManager.leaveRoom()) return;
  afficherSalle(null);
  afficherErreurSalle("");
}

async function copyRoomCode() {
  const codeElement = document.getElementById("room-code-display");
  const code = codeElement ? codeElement.textContent : "";
  if (!code) return;

  try {
    await navigator.clipboard.writeText(code);
  } catch (error) {
    console.warn("Impossible de copier le code de réunion :", error);
    window.prompt("Copiez le code de la réunion :", code);
  }
}

function afficherSalle(room) {
  const lobby = document.getElementById("room-lobby");
  const panel = document.getElementById("room-panel");
  const codeElement = document.getElementById("room-code-display");
  const participantsList = document.getElementById("room-participants");
  const videoGrid = document.getElementById("room-video-grid");

  if (!lobby || !panel || !codeElement || !participantsList) return;

  lobby.hidden = !!room;
  panel.hidden = !room;
  if (!room) {
    codeElement.textContent = "";
    participantsList.replaceChildren();
    videoGrid?.replaceChildren();
    afficherRoomMediaError("");
    return;
  }

  codeElement.textContent = room.code;
  participantsList.replaceChildren();
  room.participants.forEach((participant) => {
    const item = document.createElement("li");
    const hostLabel = participant.role === "host" ? " (hôte)" : "";
    item.textContent = `${participant.displayName || participant.id}${hostLabel}`;
    participantsList.appendChild(item);
  });

  if (videoGrid) {
    const participantIds = new Set(room.participants.map((participant) => participant.id));
    for (const participant of room.participants) {
      ensureRoomVideoTile(
        participant.id,
        participant.displayName || participant.id,
        participant.id === callManager?.userId
      );
    }
    for (const tile of Array.from(videoGrid.children)) {
      if (!participantIds.has(tile.dataset.participantId)) tile.remove();
    }
  }
  afficherErreurSalle("");
}

function ensureRoomVideoTile(participantId, displayName, isLocal = false) {
  const grid = document.getElementById("room-video-grid");
  if (!grid) return null;
  let tile = Array.from(grid.children).find((element) => element.dataset.participantId === participantId);
  if (tile) {
    const name = tile.querySelector(".room-video-name");
    if (name) name.textContent = isLocal ? `${displayName} (vous)` : displayName;
    return tile;
  }

  tile = document.createElement("article");
  tile.className = "room-video-tile";
  tile.dataset.participantId = participantId;

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.muted = isLocal;
  video.hidden = true;

  const placeholder = document.createElement("div");
  placeholder.className = "room-video-placeholder";
  placeholder.textContent = "Caméra désactivée";

  const name = document.createElement("span");
  name.className = "room-video-name";
  name.textContent = isLocal ? `${displayName} (vous)` : displayName;

  tile.append(video, placeholder, name);
  grid.appendChild(tile);
  return tile;
}

function renderRoomLocalStream(stream) {
  if (!callManager?.userId) return;
  const participant = roomManager?.room?.participants.find((item) => item.id === callManager.userId);
  const tile = ensureRoomVideoTile(
    callManager.userId,
    participant?.displayName || callManager.userId,
    true
  );
  if (!tile) return;
  const video = tile.querySelector("video");
  const placeholder = tile.querySelector(".room-video-placeholder");
  video.srcObject = stream;
  video.hidden = !stream;
  placeholder.hidden = !!stream;
}

function renderRoomRemoteStream(participantId, stream) {
  const participant = roomManager?.room?.participants.find((item) => item.id === participantId);
  const tile = ensureRoomVideoTile(
    participantId,
    participant?.displayName || participantId
  );
  if (!tile) return;
  const video = tile.querySelector("video");
  video.srcObject = stream;
  video.hidden = false;
  tile.querySelector(".room-video-placeholder").hidden = true;
  video.play().catch((error) => console.warn("[UI] Lecture de la vidéo de réunion impossible :", error));
}

function removeRoomVideoTile(participantId) {
  const grid = document.getElementById("room-video-grid");
  const tile = grid && Array.from(grid.children).find(
    (element) => element.dataset.participantId === participantId
  );
  if (tile) tile.remove();
}

function afficherRoomMediaError(message) {
  const errorElement = document.getElementById("room-media-message");
  if (!errorElement) return;
  errorElement.textContent = message;
  errorElement.hidden = !message;
}

function updateRoomMediaButtons(state) {
  const micButton = document.getElementById("btn-room-mic");
  const cameraButton = document.getElementById("btn-room-camera");
  if (micButton) {
    micButton.disabled = !state.audio.available;
    micButton.textContent = state.audio.available && state.audio.enabled ? "Couper le micro" : "Activer le micro";
  }
  if (cameraButton) {
    cameraButton.disabled = !state.video.available;
    cameraButton.textContent = state.video.available && state.video.enabled ? "Couper la caméra" : "Activer la caméra";
  }
}

function toggleRoomMicrophone() {
  meshManager?.toggleAudio();
}

function toggleRoomCamera() {
  meshManager?.toggleVideo();
}

function afficherErreurSalle(message) {
  const errorElement = document.getElementById("room-error");
  if (!errorElement) return;
  errorElement.textContent = message;
  errorElement.hidden = !message;
}

/* ==========================================================================
   3. ACTIONS UTILISATEUR (UI TRIGGERS)
   ========================================================================== */

/* --------------------------------------------------------------------------
   LACUNE 7 FIX — Permission Notification API Web (mode navigateur)
   Appelée au démarrage si Cordova n'est pas disponible.
   Permet d'afficher des notifications système natives dans le navigateur
   quand l'application est en arrière-plan ou l'écran est verrouillé (desktop).
   -------------------------------------------------------------------------- */
async function requestWebNotificationPermission() {
  if (window.cordova) return; // Cordova gère ses propres notifications push
  if (typeof Notification === "undefined") return;
  if (Notification.permission === "granted") {
    console.log("🔔 Notification API Web : permission déjà accordée");
    return;
  }
  if (Notification.permission === "denied") {
    console.warn("⚠️ Notification API Web : permission refusée par l'utilisateur");
    return;
  }
  try {
    const result = await Notification.requestPermission();
    console.log(`🔔 Notification API Web : réponse utilisateur = "${result}"`);
  } catch (e) {
    console.warn("⚠️ Notification API Web : erreur demande permission", e);
  }
}

/* ==========================================================================
   4. ACTIONS UTILISATEUR (UI TRIGGERS)
   ========================================================================== */

async function makeCall(withVideo = false) {
  if (roomManager?.isActive) {
    afficherErreurSalle("Quittez la réunion avant de passer un appel.");
    return;
  }
  const targetInput = document.getElementById("target-id-input");
  const targetId = targetInput ? targetInput.value.trim() : "";

  if (!targetId) {
    alert("Veuillez saisir l'ID du destinataire.");
    return;
  }

  try {
    showActiveCallUI(targetId);
    updateStatus(`${withVideo ? "Appel vidéo" : "Appel"} de ${targetId}...`);
    await callManager.startCall(targetId, { video: withVideo });
  } catch (err) {
    console.error("Erreur lancement appel :", err);
    hideActiveCallUI();
    alert(err.message || "Impossible de lancer l'appel.");
  }
}

function acceptCall(source = "ui") {
  if (roomManager?.isActive) {
    callManager?.rejectCall(callManager.currentCallId, "room_active");
    afficherErreurSalle("Quittez la réunion avant d’accepter un appel.");
    return;
  }
  hideIncomingCallUI();
  if (callManager) {
    showActiveCallUI(callManager.targetUserId || callManager.currentCallerId);
    callManager.acceptCall(callManager.currentCallId, source);
  }
}

// Rendre disponible globalement pour effet.js (Swipe) et plugins natifs
window.acceptCall = acceptCall;
window.requestAcceptCall = (callId, source) => acceptCall(source);
window.acceptCallAction = (data) => {
  console.log("⚡ window.acceptCallAction déclenché", data);
  if (roomManager?.isActive) {
    callManager?.rejectCall(callManager.currentCallId || data?.callId, "room_active");
    afficherErreurSalle("Quittez la réunion avant d’accepter un appel.");
    return;
  }
  if (callManager) {
    callManager.handlePushNotification({
      ...(data || {}),
      actionCallback: "acceptCallAction",
      additionalData: {
        ...((data && data.additionalData) || {}),
        actionCallback: "acceptCallAction"
      }
    });
  } else {
    showActiveCallUI();
  }
};
window.rejectCallAction = (data) => {
  console.log("⚡ window.rejectCallAction déclenché", data);
  if (callManager) {
    callManager.handlePushNotification({
      ...(data || {}),
      actionCallback: "rejectCallAction",
      additionalData: {
        ...((data && data.additionalData) || {}),
        actionCallback: "rejectCallAction"
      }
    });
  }
};

function rejectCall() {
  hideIncomingCallUI();
  if (callManager) {
    callManager.rejectCall(callManager.currentCallId, "user_declined");
  }
}

function hangUp(notifyRemote = true) {
  hideActiveCallUI();
  hideIncomingCallUI();
  if (callManager) {
    callManager.hangUp(notifyRemote, "user_hangup");
  }
}

function disconnectWebSocket() {
  if (callManager && callManager.ws) {
    callManager.isManuallyDisconnected = true;
    callManager.ws.close();
    updateStatus("Serveur déconnecté");
  }
}

function copyMyId() {
  const idDisplay = document.getElementById("my-id-display");
  if (idDisplay && idDisplay.innerText) {
    navigator.clipboard.writeText(idDisplay.innerText).then(() => {
      alert("ID copié dans le presse-papiers !");
    }).catch(() => {
      alert("ID : " + idDisplay.innerText);
    });
  }
}

/* ==========================================================================
   4. CONTRÔLES EN COURS D'APPEL (MICRO, VIDÉO, BLUETOOTH)
   ========================================================================== */

function toggleMicrophone() {
  if (!callManager) return;
  const isMuted = callManager.toggleMute();
  const micIcon = document.getElementById("mic-icon");
  const micLabel = document.getElementById("mic-label");

  if (micIcon) {
    micIcon.className = isMuted ? "fa-solid fa-microphone-slash" : "fa-solid fa-microphone";
  }
  if (micLabel) {
    micLabel.innerText = isMuted ? "Activer le micro" : "Désactiver le micro";
  }
}

async function toggleVideo() {
  if (!callManager) return;
  let isVideoActive;
  try {
    isVideoActive = await callManager.toggleVideo();
  } catch (err) {
    alert(err.message || "Impossible d'activer la caméra.");
    return;
  }
  const videoIcon = document.getElementById("video-icon");
  const videoLabel = document.getElementById("video-label");
  const localVideo = document.getElementById("localVideo");
  const avatarContainer = document.getElementById("avatar-container");
  const btnSwitch = document.getElementById("btn-switch-camera");

  if (videoIcon) {
    videoIcon.className = isVideoActive ? "fa-solid fa-video" : "fa-solid fa-video-slash";
  }
  if (videoLabel) {
    videoLabel.innerText = isVideoActive ? "Couper vidéo" : "Vidéo";
  }
  if (localVideo) {
    localVideo.style.display = isVideoActive ? "block" : "none";
  }
  if (btnSwitch) {
    btnSwitch.style.display = isVideoActive ? "block" : "none";
  }
  if (avatarContainer && isVideoActive) {
    avatarContainer.style.display = "none";
  }
}

function switchCamera() {
  if (callManager) {
    callManager.switchCamera();
  }
}

function toggleBluetooth() {
  if (!callManager) return;
  const audioIcon = document.getElementById("audio-icon");
  const audioLabel = document.getElementById("audio-label");
  const audioBtn = document.getElementById("btn-toggle-audio");

  if (currentAudioMode === "EARPIECE") {
    currentAudioMode = "SPEAKER";
    callManager.setAudioOutput("SPEAKER");
    if (audioIcon) audioIcon.className = "fa-solid fa-volume-high";
    if (audioLabel) audioLabel.innerText = "Haut-parleur";
    if (audioBtn) audioBtn.classList.remove("active");
  } else if (currentAudioMode === "SPEAKER") {
    currentAudioMode = "BLUETOOTH";
    callManager.setAudioOutput("BLUETOOTH");
    if (audioIcon) audioIcon.className = "fa-brands fa-bluetooth-b";
    if (audioLabel) audioLabel.innerText = "Bluetooth";
    if (audioBtn) audioBtn.classList.add("active");
  } else {
    currentAudioMode = "EARPIECE";
    callManager.setAudioOutput("EARPIECE");
    if (audioIcon) audioIcon.className = "fa-solid fa-phone-volume";
    if (audioLabel) audioLabel.innerText = "Combiné";
    if (audioBtn) audioBtn.classList.remove("active");
  }
}

/* ==========================================================================
   5. GESTION DE L'AFFICHAGE & DES INTERFACES (MODALS & TIMERS)
   ========================================================================== */

function showIncomingCallUI(callerName) {
  // Masquer l'interface 1 si elle était ouverte pour éviter tout conflit visuel
  hideActiveCallUI();

  const incomingView = document.getElementById("interface-2");
  if (incomingView) {
    incomingView.classList.add("active");
  }

  // Réinitialiser la position du bouton de glissement pour éviter les décalages
  const acceptBtn = document.getElementById("swipeAcceptBtn");
  if (acceptBtn) {
    acceptBtn.style.transform = "translateY(0px)";
  }

  const nameElem = incomingView ? incomingView.querySelector(".contact-name") : null;
  const displayName = callerName || (callManager && (callManager.currentCallerId || callManager.targetUserId)) || "Correspondant";
  if (nameElem) nameElem.innerText = displayName;

  const avatarSpan = incomingView ? incomingView.querySelector(".avatar-container span") : null;
  if (avatarSpan) {
    avatarSpan.innerText = displayName.trim().charAt(0).toUpperCase();
  }

  if (window.demarrerVibration) {
    window.demarrerVibration();
  }
}

function hideIncomingCallUI() {
  const incomingView = document.getElementById("interface-2");
  if (incomingView) {
    incomingView.classList.remove("active");
  }
  if (window.arreterVibration) {
    window.arreterVibration();
  }
}

function showActiveCallUI(contactName) {
  hideIncomingCallUI();
  const activeView = document.getElementById("interface-1");
  if (activeView) {
    activeView.classList.add("active");
  }

  const nameElem = activeView ? activeView.querySelector(".contact-name") : null;
  const displayName = contactName || "En communication";
  if (nameElem) nameElem.innerText = displayName;

  const avatarSpan = activeView ? activeView.querySelector(".avatar-container span") : null;
  if (avatarSpan) {
    avatarSpan.innerText = displayName.trim().charAt(0).toUpperCase();
  }

  const btnHangup = document.getElementById("btn-hangup");
  if (btnHangup) btnHangup.disabled = false;
}

function hideActiveCallUI() {
  const activeView = document.getElementById("interface-1");
  if (activeView) {
    activeView.classList.remove("active");
  }

  const btnHangup = document.getElementById("btn-hangup");
  if (btnHangup) btnHangup.disabled = true;
}

function closeInterface() {
  hideActiveCallUI();
  hideIncomingCallUI();
}

function updateStatus(text) {
  const mainStatus = document.getElementById("status");
  const status1 = document.getElementById("status-1");
  const status2 = document.getElementById("status-2");

  if (mainStatus) mainStatus.innerText = text;
  if (status1) status1.innerText = text;
  if (status2) status2.innerText = text;
}

function startCallTimer() {
  stopCallTimer();
  callStartTime = Date.now();
  const timerElem = document.getElementById("timer");

  callTimerInterval = setInterval(() => {
    if (!timerElem || !callStartTime) return;
    const elapsedSeconds = Math.floor((Date.now() - callStartTime) / 1000);
    const hrs = String(Math.floor(elapsedSeconds / 3600)).padStart(2, "0");
    const mins = String(Math.floor((elapsedSeconds % 3600) / 60)).padStart(2, "0");
    const secs = String(elapsedSeconds % 60).padStart(2, "0");
    timerElem.innerText = `${hrs}:${mins}:${secs}`;
  }, 1000);
}

function stopCallTimer() {
  if (callTimerInterval) {
    clearInterval(callTimerInterval);
    callTimerInterval = null;
  }
  callStartTime = null;
  const timerElem = document.getElementById("timer");
  if (timerElem) timerElem.innerText = "00:00:00";
}

function resetMediaUI() {
  const remoteAudio = document.getElementById("remoteAudio");
  const remoteVideo = document.getElementById("remoteVideo");
  const localVideo = document.getElementById("localVideo");
  const avatarContainer = document.getElementById("avatar-container");
  const btnSwitch = document.getElementById("btn-switch-camera");
  const micIcon = document.getElementById("mic-icon");
  const micLabel = document.getElementById("mic-label");
  const videoIcon = document.getElementById("video-icon");
  const videoLabel = document.getElementById("video-label");
  const audioIcon = document.getElementById("audio-icon");
  const audioLabel = document.getElementById("audio-label");
  const audioBtn = document.getElementById("btn-toggle-audio");

  if (remoteAudio) {
    remoteAudio.pause();
    remoteAudio.srcObject = null;
  }
  if (remoteVideo) {
    remoteVideo.pause();
    remoteVideo.srcObject = null;
    remoteVideo.style.display = "none";
  }
  const callContainer = document.querySelector("#interface-1 .app-container");
  if (callContainer) callContainer.classList.remove("video-call-active");
  if (localVideo) {
    localVideo.srcObject = null;
    localVideo.style.display = "none";
  }
  if (avatarContainer) {
    avatarContainer.style.display = "flex";
  }
  if (btnSwitch) {
    btnSwitch.style.display = "none";
  }
  if (micIcon) micIcon.className = "fa-solid fa-microphone";
  if (micLabel) micLabel.innerText = "Désactiver le micro";
  if (videoIcon) videoIcon.className = "fa-solid fa-video";
  if (videoLabel) videoLabel.innerText = "Vidéo";

  currentAudioMode = "EARPIECE";
  if (audioIcon) audioIcon.className = "fa-brands fa-bluetooth-b";
  if (audioLabel) audioLabel.innerText = "Bluetooth";
  if (audioBtn) audioBtn.classList.remove("active");
}