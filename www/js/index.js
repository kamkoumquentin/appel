/**
 * ============================================================================
 * index.js - Contrôleur UI & Orchestration de l'Application KamSoft
 * ============================================================================
 * Ce script gère l'affichage, les interactions utilisateur et pilote le SDK CallManager.
 */

let callManager = null;
let roomManager = null;
let meshManager = null;
let appInitialized = false;
let authenticationMode = "login";
const recipientDisplayNames = new Map();
let roomChatRoomId = null;
let roomChatUnreadCount = 0;
const roomChatPendingMessages = new Map();
const roomChatObjectUrls = new Set();
const roomAudioAnalyzers = new Map();
const ROOM_SPEAKER_THRESHOLD = 0.035;
const ROOM_SPEAKER_HYSTERESIS = 1.35;
const ROOM_SPEAKER_HOLD_MS = 350;
const ROOM_AUDIO_SAMPLE_INTERVAL_MS = 120;
let roomAudioContext = null;
let roomAudioSampleTimer = null;
let roomActiveSpeakerId = null;
let roomActiveSpeakerLastHeardAt = 0;
let roomLayoutMode = "gallery";
let roomChatPendingFile = null;
let roomChatPreviewUrl = null;
let roomVoiceRecorder = null;
let roomVoiceStream = null;
let roomVoiceChunks = [];
let roomVoiceStartedAt = 0;
let roomVoiceTimer = null;
let roomVoiceCancelled = false;
let roomVoiceStarting = false;
let roomChatUploadPending = false;
let roomSidePanelMode = null;
let roomCodeCopyTimer = null;
const roomToastTimers = new Set();
let roomEmptyStateTimer = null;
let pendingRoomAction = null;
let roomPreviewStream = null;
let roomPreviewPromise = Promise.resolve();
let roomPreviewGeneration = 0;
let roomParticipationPending = false;
let preMeetingAudioEnabled = true;
let preMeetingVideoEnabled = true;
let callTimerInterval = null;
let callStartTime = null;
const roomVideoTracks = new WeakSet();
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

function normalizePhoneNumber(value) {
  return String(value || "").replace(/[\s().-]/g, "");
}

function showAuthenticationError(message) {
  const error = document.getElementById("auth-error");
  if (!error) return;
  error.textContent = message || "";
  error.hidden = !message;
}

function setAuthenticationMode(mode) {
  authenticationMode = mode;
  const registering = mode === "register";
  document.getElementById("auth-title").textContent = registering ? "Créer un compte KamSoft" : "Connexion à KamSoft";
  document.getElementById("auth-name-label").hidden = !registering;
  document.getElementById("auth-name").hidden = !registering;
  document.getElementById("auth-name").required = registering;
  document.getElementById("auth-pin").autocomplete = registering ? "new-password" : "current-password";
  document.getElementById("auth-submit").textContent = registering ? "Créer mon compte" : "Se connecter";
  document.getElementById("auth-mode-toggle").textContent = registering ? "J’ai déjà un compte" : "Créer un compte";
  showAuthenticationError("");
}

function toggleAuthenticationMode() {
  setAuthenticationMode(authenticationMode === "login" ? "register" : "login");
}

async function authenticationRequest(path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${window.APP_CONFIG.httpServerUrl}${path}`, {
    method: body ? "POST" : "GET",
    headers,
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    const invalidResponseError = new Error(`Réponse invalide du serveur (HTTP ${response.status}).`);
    invalidResponseError.status = response.status;
    throw invalidResponseError;
  }
  if (!response.ok) {
    const error = new Error(payload.message || `Requête refusée (HTTP ${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function restoreAuthentication() {
  const token = localStorage.getItem("app_jwt_token");
  if (!token) {
    document.getElementById("auth-panel").hidden = false;
    document.getElementById("app-content").hidden = true;
    return null;
  }
  try {
    const result = await authenticationRequest("/me", null, token);
    localStorage.setItem("app_user_id", result.user.phone);
    localStorage.setItem("app_user_name", result.user.name);
    return result.user;
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      localStorage.removeItem("app_jwt_token");
      localStorage.removeItem("app_user_id");
      localStorage.removeItem("app_user_name");
      document.getElementById("auth-panel").hidden = false;
      document.getElementById("app-content").hidden = true;
      showAuthenticationError("Votre session a expiré. Connectez-vous à nouveau.");
      return null;
    }
    const phone = localStorage.getItem("app_user_id");
    const name = localStorage.getItem("app_user_name");
    if (!phone) {
      document.getElementById("auth-panel").hidden = false;
      document.getElementById("app-content").hidden = true;
      showAuthenticationError("Connexion au serveur impossible. Réessayez lorsque le réseau sera disponible.");
      return null;
    }
    console.warn("[Auth] Validation de la session impossible hors ligne :", error);
    return { phone, name: name || "" };
  }
}

async function submitAuthentication(event) {
  event.preventDefault();
  const phone = normalizePhoneNumber(document.getElementById("auth-phone").value);
  const pin = document.getElementById("auth-pin").value;
  const name = document.getElementById("auth-name").value.trim();
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
    showAuthenticationError("Saisissez un numéro au format international, par exemple +33612345678.");
    return;
  }
  if (!/^\d{4,12}$/.test(pin)) {
    showAuthenticationError("Le PIN doit contenir de 4 à 12 chiffres.");
    return;
  }
  if (authenticationMode === "register" && (!name || name.length > 60)) {
    showAuthenticationError("Saisissez un nom de 1 à 60 caractères.");
    return;
  }

  const button = document.getElementById("auth-submit");
  button.disabled = true;
  showAuthenticationError("");
  try {
    const endpoint = authenticationMode === "register" ? "/register" : "/login";
    const result = await authenticationRequest(endpoint, {
      phone,
      pin,
      ...(authenticationMode === "register" ? { name } : {})
    });
    localStorage.setItem("app_jwt_token", result.token);
    localStorage.setItem("app_user_id", result.user.phone);
    localStorage.setItem("app_user_name", result.user.name);
    document.getElementById("auth-panel").hidden = true;
    document.getElementById("app-content").hidden = false;
    await initApp();
  } catch (error) {
    showAuthenticationError(error.message || "Impossible de se connecter.");
  } finally {
    button.disabled = false;
  }
}

async function lookupRecipient() {
  const input = document.getElementById("target-id-input");
  const label = document.getElementById("recipient-name");
  const phone = normalizePhoneNumber(input?.value);
  if (!label) return null;
  label.textContent = "";
  if (!/^\+[1-9]\d{7,14}$/.test(phone) || !callManager?.jwtToken) return null;
  try {
    const result = await authenticationRequest(`/users/${encodeURIComponent(phone)}`, null, callManager.jwtToken);
    recipientDisplayNames.set(phone, result.user.name);
    label.textContent = result.user.name;
    return result.user.name;
  } catch (error) {
    if (error.status !== 404) console.warn("[Auth] Recherche du correspondant impossible :", error);
    recipientDisplayNames.delete(phone);
    return null;
  }
}

function logout() {
  if (roomManager?.room) roomManager.leaveRoom();
  if (callManager?.callState !== "IDLE") callManager.hangUp(true, "logout");
  if (callManager?.ws) {
    callManager.isManuallyDisconnected = true;
    callManager.ws.close();
  }
  for (const key of ["app_jwt_token", "app_user_id", "app_user_name", "app_session_token"]) {
    localStorage.removeItem(key);
  }
  window.location.reload();
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
window.addEventListener("beforeunload", (event) => {
  if (!roomManager?.room || window.cordova?.platformId === "android") return;
  event.preventDefault();
  event.returnValue = "";
}, false);

// ── SURVEILLANCE CONTINUE EN ARRIÈRE-PLAN ───────────────────────────────────
setInterval(() => {
  verifierEtatEcranPhysique("interval");
}, 1000);

/* ==========================================================================
   1. DÉMARRAGE DE L'APPLICATION
   ========================================================================== */

async function initApp() {
  if (appInitialized) return;
  const account = await restoreAuthentication();
  if (!account) return;
  appInitialized = true;
  document.getElementById("auth-panel").hidden = true;
  document.getElementById("app-content").hidden = false;
  document.getElementById("my-id-display").textContent = account.phone;
  document.getElementById("my-name-display").textContent = account.name;
  console.log("🚀 Initialisation de l'application KamSoft...");
  activerKeepAwake();
  initializeRoomDisplayName();
  initializeRoomLayoutMode();

  // Demande des permissions préalables (si sur Cordova)
  await checkNativePermissions();

  // Création de l'instance CallManager
  callManager = new CallManager({
    serverUrl: window.APP_CONFIG.serverUrl,
    iceServers: window.APP_CONFIG.iceServers,
    userId: account.phone,
    accountName: account.name,
    jwtToken: localStorage.getItem("app_jwt_token"),

    onRegistered: (myId) => {
      const idElem = document.getElementById("my-id-display");
      if (idElem) idElem.innerText = myId;
      updateStatus("En ligne");
    },

    onStatusChange: (status) => {
      updateStatus(status);
    },

    onIncomingCall: ({ callId, callerId, callerName, hasVideo, isAppVisible }) => {
      if (callerName && callerId) recipientDisplayNames.set(callerId, callerName);
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
      showActiveCallUI(recipientDisplayNames.get(targetId) || targetId);
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
    onPeerStateChange: updateRoomPeerState,
    onMediaError: afficherRoomMediaError,
    onMediaStateChange: updateRoomMediaButtons
  });
  roomManager = new RoomManager(callManager, meshManager);
  roomManager.onRoomCreated = afficherSalle;
  roomManager.onRoomJoined = afficherSalle;
  roomManager.onChatMessage = afficherChatMessage;
  roomManager.onChatError = afficherChatError;
  roomManager.onParticipantJoined = (participant, room) => {
    afficherSalle(room);
    afficherRoomNotification(
      `${RoomManager.formatDisplayName(participant, room.participants)} a rejoint la réunion.`
    );
  };
  roomManager.onParticipantStateChange = (_participant, room) => {
    afficherSalle(room);
    sampleRoomAudioLevels();
  };
  roomManager.onHandRaised = (participant, room) => {
    afficherSalle(room);
    afficherRoomNotification(
      `${RoomManager.formatDisplayName(participant, room.participants)} ${participant.raised ? "a levé la main." : "a baissé la main."}`
    );
  };
  roomManager.onParticipantMuted = (participantId, room) => {
    afficherSalle(room);
    if (participantId === callManager?.userId) {
      afficherRoomNotification("L’hôte a coupé votre micro.");
    }
  };
  roomManager.onParticipantKicked = (message, room, participant, isSelf) => {
    if (isSelf) {
      afficherSalle(null);
      afficherErreurSalle("Vous avez été expulsé de la réunion.");
      return;
    }
    afficherSalle(room);
    afficherRoomNotification(
      `${participant
        ? RoomManager.formatDisplayName(participant, [...room.participants, participant])
        : "Un participant"} a été expulsé de la réunion.`
    );
  };
  roomManager.onRoomLocked = (locked, room) => {
    afficherSalle(room);
    afficherRoomNotification(locked ? "La salle est verrouillée." : "La salle est déverrouillée.");
  };
  roomManager.onParticipantLeft = (participantId, room, participant, participantsBeforeDeparture) => {
    afficherSalle(room);
    afficherRoomNotification(
      `${participant
        ? RoomManager.formatDisplayName(participant, participantsBeforeDeparture || room.participants)
        : "Un participant"} a quitté la réunion.`
    );
  };
  roomManager.onRoomClosed = ({ reason }) => {
    afficherSalle(null);
    afficherErreurSalle(
      reason === "host_left" || reason === "disconnected"
        ? "L’hôte a quitté la réunion. La salle est fermée."
        : "La réunion est terminée."
    );
  };
  roomManager.onRoomError = ({ message }) => {
    setRoomParticipationLoading(false);
    if (!document.getElementById("room-prejoin")?.hidden) afficherPreMeetingError(message);
    else if (roomManager.room) afficherRoomMediaError(message);
    else afficherErreurSalle(message);
  };

  document.getElementById("room-display-name")?.addEventListener("input", saveRoomDisplayName);
  document.addEventListener("keydown", handleRoomKeyboardShortcuts);
  document.getElementById("room-chat-input")?.addEventListener("input", () => {
    updateRoomChatCounter();
    afficherChatError({ message: "" });
  });
  document.getElementById("room-chat-input")?.addEventListener("keydown", onRoomChatInputKeydown);
  document.getElementById("room-chat-input")?.addEventListener("focus", focusRoomChatInput);
  document.getElementById("room-chat-messages")?.addEventListener("scroll", updateRoomChatScrollButton);
  document.getElementById("room-chat-file")?.addEventListener("change", onRoomFileSelected);
  document.addEventListener("pointerdown", resumeRoomAudioContext, { passive: true });
  window.addEventListener("resize", updateRoomVisualViewport);
  window.visualViewport?.addEventListener("resize", updateRoomVisualViewport);
  window.visualViewport?.addEventListener("scroll", updateRoomVisualViewport);
  document.getElementById("room-audio-device")?.addEventListener("change", () => {
    roomPreviewPromise = refreshRoomPreview();
  });
  document.getElementById("room-video-device")?.addEventListener("change", () => {
    roomPreviewPromise = refreshRoomPreview();
  });

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
  if (!roomManager.canStartRoom()) return;
  afficherErreurSalle("");
  openRoomPreMeeting({ type: "create" });
}

function joinRoom() {
  if (!roomManager) return;
  if (!roomManager.canStartRoom()) return;
  const codeInput = document.getElementById("room-code-input");
  openRoomPreMeeting({ type: "join", code: codeInput ? codeInput.value : "" });
}

function initializeRoomDisplayName() {
  const input = document.getElementById("room-display-name");
  if (!input) return;
  try {
    input.value = localStorage.getItem("room_display_name") || "";
  } catch (error) {
    console.warn("[Room] Lecture du nom mémorisé impossible :", error);
  }
}

function saveRoomDisplayName() {
  const input = document.getElementById("room-display-name");
  if (!input) return;
  try {
    localStorage.setItem("room_display_name", input.value);
  } catch (error) {
    console.warn("[Room] Mémorisation du nom impossible :", error);
  }
}

function openRoomPreMeeting(action) {
  pendingRoomAction = action;
  preMeetingAudioEnabled = true;
  preMeetingVideoEnabled = true;
  document.getElementById("room-lobby").hidden = true;
  document.getElementById("room-prejoin").hidden = false;
  afficherPreMeetingError("");
  updatePreMeetingButtons();
  roomPreviewPromise = refreshRoomPreview();
}

async function refreshRoomPreview() {
  const generation = ++roomPreviewGeneration;
  if (roomPreviewStream) roomPreviewStream.getTracks().forEach((track) => track.stop());
  roomPreviewStream = null;

  const video = document.getElementById("room-preview-video");
  video.srcObject = null;
  video.hidden = true;
  document.getElementById("room-preview-placeholder").hidden = false;

  const devices = await populateRoomDeviceLists();
  if (generation !== roomPreviewGeneration) return;
  if (!preMeetingAudioEnabled && !preMeetingVideoEnabled) {
    afficherPreMeetingError("Vous participerez sans micro ni caméra.");
    return;
  }

  const audioId = document.getElementById("room-audio-device").value;
  const videoId = document.getElementById("room-video-device").value;
  const audio = preMeetingAudioEnabled
    ? (audioId ? { deviceId: { exact: audioId } } : true)
    : false;
  const videoConstraints = preMeetingVideoEnabled
    ? {
        ...(videoId ? { deviceId: { exact: videoId } } : {}),
        width: { ideal: 640 },
        height: { ideal: 360 },
        frameRate: { ideal: 24, max: 30 }
      }
    : false;

  let stream;
  let combinedError = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio, video: videoConstraints });
  } catch (error) {
    combinedError = error;
    const fallbackTracks = [];
    if (preMeetingAudioEnabled) {
      try {
        const audioOnly = await navigator.mediaDevices.getUserMedia({ audio, video: false });
        fallbackTracks.push(...audioOnly.getAudioTracks());
        audioOnly.getVideoTracks().forEach((track) => track.stop());
      } catch (audioError) {
        console.warn("[Room] Capture audio seule impossible :", audioError);
      }
    }
    if (preMeetingVideoEnabled) {
      try {
        const videoOnly = await navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraints });
        fallbackTracks.push(...videoOnly.getVideoTracks());
        videoOnly.getAudioTracks().forEach((track) => track.stop());
      } catch (videoError) {
        console.warn("[Room] Capture vidéo seule impossible :", videoError);
      }
    }
    if (fallbackTracks.length) stream = new MediaStream(fallbackTracks);
  }

  if (generation !== roomPreviewGeneration) {
    stream?.getTracks().forEach((track) => track.stop());
    return;
  }
  if (!stream) {
    console.warn("[Room] Capture combinée et captures de secours impossibles :", combinedError);
    const unavailableMessage = preMeetingAudioEnabled && preMeetingVideoEnabled
      ? "Microphone et caméra indisponibles."
      : preMeetingAudioEnabled
        ? "Accès au microphone refusé."
        : "Accès à la caméra refusé.";
    afficherPreMeetingError(
      `${unavailableMessage} Vous pouvez participer sans média et réessayer avant de rejoindre.`
    );
    updatePreMeetingButtons();
    return;
  }

  roomPreviewStream = stream;
  for (const track of stream.getTracks()) {
    track.enabled = track.kind === "audio" ? preMeetingAudioEnabled : preMeetingVideoEnabled;
  }
  video.srcObject = stream;
  video.hidden = stream.getVideoTracks().length === 0 || !preMeetingVideoEnabled;
  document.getElementById("room-preview-placeholder").hidden = !video.hidden;
  await populateRoomDeviceLists(audioId, videoId);
  const missingMedia = [];
  if (preMeetingAudioEnabled && !stream.getAudioTracks().length) missingMedia.push("microphone");
  if (preMeetingVideoEnabled && !stream.getVideoTracks().length) missingMedia.push("caméra");
  afficherPreMeetingError(missingMedia.length
    ? `${missingMedia.join(" et ")} indisponible${missingMedia.length > 1 ? "s" : ""}. Vous pourrez réessayer avant ou pendant la réunion.`
    : "");
  updatePreMeetingButtons();
}

async function populateRoomDeviceLists(selectedAudioId, selectedVideoId) {
  const audioSelect = document.getElementById("room-audio-device");
  const videoSelect = document.getElementById("room-video-device");
  const currentAudioId = selectedAudioId || audioSelect.value;
  const currentVideoId = selectedVideoId || videoSelect.value;
  let audioDevices = [];
  let videoDevices = [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    audioDevices = devices.filter((device) => device.kind === "audioinput");
    videoDevices = devices.filter((device) => device.kind === "videoinput");
  } catch (error) {
    console.warn("[Room] Énumération des périphériques impossible :", error);
  }
  populateRoomDeviceSelect(audioSelect, audioDevices, currentAudioId, "Microphone par défaut");
  populateRoomDeviceSelect(videoSelect, videoDevices, currentVideoId, "Caméra par défaut");
  return { audioId: currentAudioId, videoId: currentVideoId };
}

function populateRoomDeviceSelect(select, devices, selectedId, defaultLabel) {
  select.replaceChildren();
  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = defaultLabel;
  select.appendChild(defaultOption);
  for (const device of devices) {
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.textContent = device.label || `${defaultLabel} ${select.options.length}`;
    select.appendChild(option);
  }
  if (selectedId && devices.some((device) => device.deviceId === selectedId)) {
    select.value = selectedId;
  }
}

function togglePreMeetingMicrophone() {
  const track = roomPreviewStream?.getAudioTracks()[0];
  if (track && track.readyState === "live") {
    preMeetingAudioEnabled = !track.enabled;
    track.enabled = preMeetingAudioEnabled;
  } else {
    preMeetingAudioEnabled = true;
    roomPreviewPromise = refreshRoomPreview();
  }
  updatePreMeetingButtons();
}

function togglePreMeetingCamera() {
  const track = roomPreviewStream?.getVideoTracks()[0];
  if (track && track.readyState === "live") {
    preMeetingVideoEnabled = !track.enabled;
    track.enabled = preMeetingVideoEnabled;
  } else {
    preMeetingVideoEnabled = true;
    roomPreviewPromise = refreshRoomPreview();
  }
  const video = document.getElementById("room-preview-video");
  video.hidden = !track || track.readyState !== "live" || !preMeetingVideoEnabled;
  document.getElementById("room-preview-placeholder").hidden = !video.hidden;
  updatePreMeetingButtons();
}

function updatePreMeetingButtons() {
  const mic = document.getElementById("btn-prejoin-mic");
  const camera = document.getElementById("btn-prejoin-camera");
  const hasAudio = roomPreviewStream?.getAudioTracks().some((track) => track.readyState === "live");
  const hasVideo = roomPreviewStream?.getVideoTracks().some((track) => track.readyState === "live");
  const micEnabled = !!hasAudio && preMeetingAudioEnabled;
  const cameraEnabled = !!hasVideo && preMeetingVideoEnabled;
  mic.classList.toggle("is-muted", !micEnabled);
  mic.setAttribute("aria-label", hasAudio
    ? (micEnabled ? "Couper le micro" : "Activer le micro")
    : "Réessayer le micro");
  mic.title = hasAudio
    ? (micEnabled ? "Couper le micro" : "Activer le micro")
    : "Réessayer le micro";
  mic.setAttribute("aria-pressed", String(!!hasAudio && preMeetingAudioEnabled));
  camera.classList.toggle("is-muted", !cameraEnabled);
  camera.setAttribute("aria-label", hasVideo
    ? (cameraEnabled ? "Couper la caméra" : "Activer la caméra")
    : "Réessayer la caméra");
  camera.title = hasVideo
    ? (cameraEnabled ? "Couper la caméra" : "Activer la caméra")
    : "Réessayer la caméra";
  camera.setAttribute("aria-pressed", String(!!hasVideo && preMeetingVideoEnabled));
}

async function participateRoom() {
  const nameInput = document.getElementById("room-display-name");
  const displayName = nameInput.value.trim();
  if (displayName.length < 1 || displayName.length > 30) {
    afficherPreMeetingError("Votre nom doit contenir entre 1 et 30 caractères.");
    return;
  }
  if (!pendingRoomAction || roomParticipationPending) return;
  roomParticipationPending = true;
  setRoomParticipationLoading(true);
  try {
    let awaitedPreview;
    do {
      awaitedPreview = roomPreviewPromise;
      await awaitedPreview;
    } while (awaitedPreview !== roomPreviewPromise);
  } catch (error) {
    setRoomParticipationLoading(false);
    afficherPreMeetingError("Impossible de préparer les médias. Vous pouvez réessayer ou participer sans caméra ni micro.");
    console.warn("[Room] Préparation des médias impossible :", error);
    return;
  }
  if (!pendingRoomAction) {
    setRoomParticipationLoading(false);
    return;
  }
  saveRoomDisplayName();

  const mediaOptions = {
    localStream: roomPreviewStream,
    mediaPrepared: true,
    audio: !!roomPreviewStream?.getAudioTracks().some((track) => track.enabled && preMeetingAudioEnabled),
    video: !!roomPreviewStream?.getVideoTracks().some((track) => track.enabled && preMeetingVideoEnabled),
    audioDeviceId: document.getElementById("room-audio-device").value,
    videoDeviceId: document.getElementById("room-video-device").value
  };
  afficherPreMeetingError("");
  const started = pendingRoomAction.type === "create"
    ? roomManager.createRoom(displayName, mediaOptions)
    : roomManager.joinRoom(pendingRoomAction.code, displayName, mediaOptions);
  if (!started) setRoomParticipationLoading(false);
}

function setRoomParticipationLoading(loading) {
  roomParticipationPending = loading;
  const button = document.getElementById("btn-participate-room");
  const label = document.getElementById("btn-participate-room-label");
  if (!button || !label) return;
  button.disabled = loading;
  button.setAttribute("aria-busy", String(loading));
  label.textContent = loading ? "Connexion à la réunion…" : "Participer";
}

function cancelRoomPreMeeting() {
  roomPreviewGeneration += 1;
  if (roomPreviewStream) roomPreviewStream.getTracks().forEach((track) => track.stop());
  roomPreviewStream = null;
  document.getElementById("room-preview-video").srcObject = null;
  document.getElementById("room-prejoin").hidden = true;
  document.getElementById("room-lobby").hidden = false;
  pendingRoomAction = null;
  setRoomParticipationLoading(false);
}

function afficherPreMeetingError(message) {
  const element = document.getElementById("room-prejoin-error");
  element.textContent = message;
  element.hidden = !message;
}

function afficherRoomNotification(message) {
  const element = document.getElementById("room-notification");
  if (!element) return;
  if (!message) {
    for (const timer of roomToastTimers) clearTimeout(timer);
    roomToastTimers.clear();
    element.replaceChildren();
    return;
  }
  while (element.children.length >= 3) {
    const oldest = element.firstElementChild;
    const timer = oldest && Number(oldest.dataset.timerId);
    if (timer) {
      clearTimeout(timer);
      roomToastTimers.delete(timer);
    }
    oldest?.remove();
  }
  const toast = document.createElement("div");
  toast.className = "room-toast";
  toast.textContent = message;
  element.appendChild(toast);
  const timer = window.setTimeout(() => {
    toast.remove();
    roomToastTimers.delete(timer);
  }, 4000);
  toast.dataset.timerId = String(timer);
  roomToastTimers.add(timer);
}

function afficherRoomToastError(message) {
  const element = document.getElementById("room-notification");
  if (!element || !message) return;
  afficherRoomNotification(message);
  element.lastElementChild?.classList.add("room-toast-error");
}

function toggleRoomChat() {
  setRoomSidePanel("chat");
}

function toggleRoomParticipants() {
  setRoomSidePanel("participants");
}

function initializeRoomLayoutMode() {
  let storedMode = "gallery";
  try {
    const savedMode = localStorage.getItem("room_layout_mode");
    if (savedMode === "speaker" || savedMode === "gallery") storedMode = savedMode;
  } catch (error) {
    console.warn("[UI] Préférence de disposition non accessible :", error);
  }
  setRoomLayoutMode(storedMode, false);
}

function toggleRoomLayoutMode() {
  setRoomLayoutMode(roomLayoutMode === "gallery" ? "speaker" : "gallery");
}

function setRoomLayoutMode(mode, persist = true) {
  if (mode !== "gallery" && mode !== "speaker") {
    throw new TypeError("Le mode de disposition doit être gallery ou speaker.");
  }
  roomLayoutMode = mode;
  const grid = document.getElementById("room-video-grid");
  if (grid) {
    grid.classList.toggle("room-layout-gallery", mode === "gallery");
    grid.classList.toggle("room-layout-speaker", mode === "speaker");
  }
  const button = document.getElementById("btn-room-layout");
  if (button) {
    const nextMode = mode === "gallery" ? "speaker" : "gallery";
    const label = nextMode === "speaker" ? "Passer à la vue orateur" : "Passer à la vue grille";
    button.dataset.mode = mode;
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-pressed", String(mode === "speaker"));
    button.title = `${label} (L)`;
  }
  updateRoomSpeakerLayout();
  if (!persist) return;
  try {
    localStorage.setItem("room_layout_mode", mode);
  } catch (error) {
    console.warn("[UI] Préférence de disposition non enregistrée :", error);
    afficherRoomToastError("Le mode d’affichage ne pourra pas être mémorisé.");
  }
}

function updateRoomSpeakerLayout() {
  const grid = document.getElementById("room-video-grid");
  if (!grid) return;
  grid.classList.toggle("room-layout-gallery", roomLayoutMode === "gallery");
  grid.classList.toggle("room-layout-speaker", roomLayoutMode === "speaker");
  const tiles = Array.from(grid.children).filter((tile) =>
    tile.classList.contains("room-video-tile")
  );
  const speakerId = roomManager?.room?.participants.some(
    (participant) => participant.id === roomActiveSpeakerId
  ) ? roomActiveSpeakerId : callManager?.userId;
  for (const tile of tiles) {
    tile.classList.toggle(
      "is-main-speaker",
      roomLayoutMode === "speaker" && tile.dataset.participantId === speakerId
    );
  }
}

function setRoomSidePanel(mode) {
  if (!roomManager?.room) return;
  const panel = document.getElementById("room-side-panel");
  const chatPanel = document.getElementById("room-chat-panel");
  const participantsPanel = document.getElementById("room-participants-panel");
  const title = document.getElementById("room-side-panel-title");
  if (!panel || !chatPanel || !participantsPanel || !title) return;

  const nextMode = roomSidePanelMode === mode ? null : mode;
  roomSidePanelMode = nextMode;
  panel.classList.toggle("is-open", !!nextMode);
  panel.setAttribute("aria-hidden", String(!nextMode));
  panel.inert = !nextMode;
  document.body.classList.toggle("room-side-panel-open", !!nextMode);
  if (nextMode) updateRoomVisualViewport();
  chatPanel.hidden = nextMode !== "chat";
  participantsPanel.hidden = nextMode !== "participants";
  title.textContent = nextMode === "participants" ? "Participants" : "Chat";

  const chatButton = document.getElementById("btn-room-chat");
  const participantsButton = document.getElementById("btn-room-participants");
  if (chatButton) {
    const expanded = nextMode === "chat";
    chatButton.setAttribute("aria-expanded", String(expanded));
    chatButton.setAttribute("aria-label", expanded ? "Fermer le chat" : "Ouvrir le chat");
    chatButton.title = expanded ? "Fermer le chat (C)" : "Ouvrir le chat (C)";
  }
  if (participantsButton) {
    const expanded = nextMode === "participants";
    participantsButton.setAttribute("aria-expanded", String(expanded));
    participantsButton.setAttribute("aria-label", expanded ? "Fermer les participants" : "Afficher les participants");
    participantsButton.title = expanded ? "Fermer les participants (P)" : "Afficher les participants (P)";
  }

  if (nextMode === "chat") {
    roomChatUnreadCount = 0;
    updateRoomChatUnreadBadge();
    document.getElementById("room-chat-input")?.focus();
  }
}

function closeRoomSidePanel() {
  if (!roomManager?.room || !roomSidePanelMode) return;
  const closedMode = roomSidePanelMode;
  roomSidePanelMode = null;
  const panel = document.getElementById("room-side-panel");
  const chatPanel = document.getElementById("room-chat-panel");
  const participantsPanel = document.getElementById("room-participants-panel");
  const chatButton = document.getElementById("btn-room-chat");
  const participantsButton = document.getElementById("btn-room-participants");
  if (panel) {
    panel.classList.remove("is-open");
    panel.setAttribute("aria-hidden", "true");
    panel.inert = true;
  }
  document.body.classList.remove("room-side-panel-open");
  if (chatPanel) chatPanel.hidden = true;
  if (participantsPanel) participantsPanel.hidden = true;
  if (chatButton) {
    chatButton.setAttribute("aria-expanded", "false");
    chatButton.setAttribute("aria-label", "Ouvrir le chat");
    chatButton.title = "Ouvrir le chat (C)";
  }
  if (participantsButton) {
    participantsButton.setAttribute("aria-expanded", "false");
    participantsButton.setAttribute("aria-label", "Afficher les participants");
    participantsButton.title = "Afficher les participants (P)";
  }
  (closedMode === "chat" ? chatButton : participantsButton)?.focus();
}

function handleRoomKeyboardShortcuts(event) {
  if (event.key === "Escape" && !document.getElementById("room-image-viewer")?.hidden) {
    closeRoomImageViewer();
    return;
  }
  if (event.key === "Escape" && roomSidePanelMode) {
    closeRoomSidePanel();
    return;
  }
  if (!roomManager?.room || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (window.matchMedia?.("(max-width: 700px)").matches) return;
  if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable='true']")) return;
  switch (event.key.toLowerCase()) {
    case "m":
      event.preventDefault();
      toggleRoomMicrophone();
      break;
    case "v":
      event.preventDefault();
      toggleRoomCamera();
      break;
    case "c":
      event.preventDefault();
      toggleRoomChat();
      break;
    case "p":
      event.preventDefault();
      toggleRoomParticipants();
      break;
    case "l":
      event.preventDefault();
      toggleRoomLayoutMode();
      break;
  }
}

function updateRoomVisualViewport() {
  const panel = document.getElementById("room-side-panel");
  if (!panel || !document.body.classList.contains("in-meeting")) return;
  const viewport = window.visualViewport;
  const height = viewport && viewport.height > 0 ? viewport.height : window.innerHeight;
  const top = viewport ? viewport.offsetTop : 0;
  panel.style.setProperty("--room-visual-viewport-height", `${height}px`);
  panel.style.setProperty("--room-visual-viewport-top", `${top}px`);
}

function focusRoomChatInput() {
  updateRoomVisualViewport();
  const input = document.getElementById("room-chat-input");
  if (!input) return;
  window.setTimeout(() => {
    if (roomSidePanelMode !== "chat" || document.activeElement !== input) return;
    updateRoomVisualViewport();
    input.scrollIntoView({
      block: "nearest",
      behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"
    });
  }, 150);
}

function updateRoomChatUnreadBadge() {
  const badge = document.getElementById("room-chat-unread");
  if (!badge) return;
  badge.textContent = roomChatUnreadCount > 99 ? "99+" : String(roomChatUnreadCount);
  badge.hidden = roomChatUnreadCount === 0;
}

function resetRoomChat() {
  roomChatUnreadCount = 0;
  roomChatPendingMessages.clear();
  cancelRoomVoiceRecording();
  setRoomChatUploadPending(false);
  cancelRoomFilePreview();
  closeRoomImageViewer();
  for (const objectUrl of roomChatObjectUrls) URL.revokeObjectURL(objectUrl);
  roomChatObjectUrls.clear();
  roomSidePanelMode = null;
  const panel = document.getElementById("room-side-panel");
  const chatPanel = document.getElementById("room-chat-panel");
  const participantsPanel = document.getElementById("room-participants-panel");
  const button = document.getElementById("btn-room-chat");
  const participantsButton = document.getElementById("btn-room-participants");
  const messages = document.getElementById("room-chat-messages");
  const input = document.getElementById("room-chat-input");
  const fileInput = document.getElementById("room-chat-file");
  const error = document.getElementById("room-chat-error");
  const newMessagesButton = document.getElementById("room-chat-new-messages");
  if (panel) {
    panel.classList.remove("is-open");
    panel.setAttribute("aria-hidden", "true");
    panel.inert = true;
  }
  document.body.classList.remove("room-side-panel-open");
  if (chatPanel) chatPanel.hidden = true;
  if (participantsPanel) participantsPanel.hidden = true;
  if (button) {
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-label", "Ouvrir le chat");
    button.title = "Ouvrir le chat (C)";
  }
  if (participantsButton) {
    participantsButton.setAttribute("aria-expanded", "false");
    participantsButton.setAttribute("aria-label", "Afficher les participants");
    participantsButton.title = "Afficher les participants";
  }
  if (messages) messages.replaceChildren();
  if (newMessagesButton) newMessagesButton.hidden = true;
  if (input) input.value = "";
  if (fileInput) fileInput.value = "";
  if (error) {
    error.textContent = "";
    error.hidden = true;
  }
  updateRoomChatUnreadBadge();
  updateRoomChatCounter();
}

function updateRoomChatCounter() {
  const input = document.getElementById("room-chat-input");
  const counter = document.getElementById("room-chat-counter");
  if (!input || !counter) return;
  counter.textContent = `${input.value.length} / 500`;
  counter.classList.toggle("is-warning", input.value.length > 450);
}

function afficherChatMessage(message) {
  const messages = document.getElementById("room-chat-messages");
  if (!messages || !roomManager?.room || message.roomId !== roomManager.room.roomId) return;

  const nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 48;
  const row = document.createElement("article");
  const ownMessage = message.from === callManager?.userId;
  row.className = `room-chat-message${ownMessage ? " is-own" : ""}`;
  row.dataset.authorId = typeof message.from === "string" ? message.from : "";

  const meta = document.createElement("div");
  meta.className = "room-chat-message-meta";
  const author = document.createElement("strong");
  const knownParticipant = roomManager.room.participants.find((item) => item.id === message.from);
  const authorParticipant = knownParticipant || {
    id: message.from,
    displayName: typeof message.displayName === "string" ? message.displayName : "Participant"
  };
  author.textContent = RoomManager.formatDisplayName(authorParticipant, roomManager.room.participants);
  const time = document.createElement("time");
  const sentAt = new Date(message.sentAt);
  const validTime = !Number.isNaN(sentAt.getTime());
  time.textContent = validTime
    ? sentAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "";
  meta.append(author);

  const text = document.createElement("p");
  text.className = "room-chat-message-text";
  text.textContent = typeof message.text === "string" ? message.text : "";
  const previous = messages.lastElementChild;
  const previousTime = previous && Number(previous.dataset.sentAt);
  const sentAtMs = validTime ? sentAt.getTime() : 0;
  const sameAuthor = previous && previous.dataset.authorId === row.dataset.authorId;
  const needsSeparator = validTime && (!previousTime
    || sentAt.toDateString() !== new Date(previousTime).toDateString()
    || sentAtMs - previousTime >= 5 * 60 * 1000);
  if (needsSeparator) {
    const separator = document.createElement("div");
    separator.className = "room-chat-time-separator";
    separator.textContent = sentAt.toLocaleString([], {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit"
    });
    messages.appendChild(separator);
  }
  if (sameAuthor && !needsSeparator) row.classList.add("is-grouped");
  if (validTime) row.dataset.sentAt = String(sentAtMs);
  row.append(meta);

  const content = message.message && typeof message.message === "object"
    ? message.message
    : null;
  if (content?.type === "file") {
    const fileContent = document.createElement("div");
    fileContent.className = "room-chat-file";
    const fileIcon = document.createElement("span");
    fileIcon.className = "room-chat-file-icon";
    fileIcon.setAttribute("aria-hidden", "true");
    fileIcon.textContent = getRoomFileIcon(content.mimeType);
    const details = document.createElement("div");
    details.className = "room-chat-file-details";
    const fileName = document.createElement("strong");
    fileName.className = "room-chat-file-name";
    fileName.textContent = typeof content.name === "string" ? content.name : "Fichier joint";
    fileName.title = fileName.textContent;
    const fileSize = document.createElement("span");
    fileSize.className = "room-chat-file-size";
    fileSize.textContent = formatRoomAttachmentSize(content.size);
    details.append(fileName, fileSize);
    fileContent.append(fileIcon, details);

    if (typeof content.mimeType === "string" && content.mimeType.startsWith("image/")) {
      const previewLink = document.createElement("a");
      previewLink.className = "room-chat-image-link";
      previewLink.target = "_blank";
      previewLink.rel = "noopener noreferrer";
      previewLink.setAttribute("aria-label", `Afficher l’image ${fileName.textContent}`);
      previewLink.title = fileName.textContent;
      const preview = document.createElement("img");
      preview.className = "room-chat-image-preview";
      preview.alt = fileName.textContent;
      previewLink.appendChild(preview);
      fileContent.appendChild(previewLink);
      loadRoomAttachment(content.attachmentId, message.roomId).then((objectUrl) => {
        preview.src = objectUrl;
        previewLink.href = objectUrl;
        previewLink.addEventListener("click", (event) => {
          event.preventDefault();
          openRoomImageViewer(objectUrl, fileName.textContent);
        });
      }).catch((error) => {
        previewLink.remove();
        afficherChatError({ message: error.message });
      });
    }

    const downloadButton = document.createElement("button");
    downloadButton.className = "room-chat-download";
    downloadButton.type = "button";
    downloadButton.textContent = "Télécharger";
    downloadButton.addEventListener("click", () => downloadRoomAttachment(content));
    fileContent.appendChild(downloadButton);
    row.appendChild(fileContent);
  } else if (content?.type === "voice") {
    const voiceContent = document.createElement("div");
    voiceContent.className = "room-chat-voice";
    const audio = document.createElement("audio");
    audio.preload = "none";
    audio.hidden = true;
    audio.setAttribute("aria-label", "Message vocal");
    const playButton = document.createElement("button");
    playButton.className = "room-chat-voice-play";
    playButton.type = "button";
    playButton.textContent = "▶";
    playButton.setAttribute("aria-label", "Lire le message vocal");
    const progress = document.createElement("input");
    progress.className = "room-chat-voice-progress";
    progress.type = "range";
    progress.min = "0";
    progress.max = "1000";
    progress.value = "0";
    progress.setAttribute("aria-label", "Progression du message vocal");
    const duration = document.createElement("time");
    duration.className = "room-chat-voice-duration";
    duration.textContent = `00:00 / ${formatRoomVoiceDuration(content.durationMs)}`;
    const loading = document.createElement("span");
    loading.className = "room-chat-attachment-status";
    loading.textContent = "Chargement du message vocal…";
    voiceContent.append(playButton, progress, duration, loading, audio);
    row.appendChild(voiceContent);
    loadRoomAttachment(content.attachmentId, message.roomId).then((objectUrl) => {
      audio.src = objectUrl;
      loading.remove();
      const renderProgress = () => {
        const total = Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration
          : (Number(content.durationMs) || 0) / 1000;
        progress.value = total ? String(Math.round((audio.currentTime / total) * 1000)) : "0";
        duration.textContent = `${formatRoomVoiceDuration(audio.currentTime * 1000)} / ${formatRoomVoiceDuration(total * 1000)}`;
      };
      audio.addEventListener("timeupdate", renderProgress);
      audio.addEventListener("loadedmetadata", renderProgress);
      audio.addEventListener("ended", () => {
        playButton.textContent = "▶";
        playButton.setAttribute("aria-label", "Lire le message vocal");
        audio.currentTime = 0;
        renderProgress();
      });
      playButton.addEventListener("click", async () => {
        if (audio.paused) {
          try {
            await audio.play();
            playButton.textContent = "Ⅱ";
            playButton.setAttribute("aria-label", "Mettre en pause le message vocal");
          } catch (error) {
            afficherChatError({ message: "Impossible de lire ce message vocal." });
          }
        } else {
          audio.pause();
          playButton.textContent = "▶";
          playButton.setAttribute("aria-label", "Lire le message vocal");
        }
      });
      progress.addEventListener("input", () => {
        const total = Number.isFinite(audio.duration) ? audio.duration : (Number(content.durationMs) || 0) / 1000;
        if (total > 0) audio.currentTime = (Number(progress.value) / 1000) * total;
      });
    }).catch((error) => {
      loading.textContent = "Impossible de charger le message vocal.";
      afficherChatError({ message: error.message });
    });
  } else {
    text.textContent = content?.type === "text" && typeof content.text === "string"
      ? content.text
      : typeof message.text === "string" ? message.text : "";
    row.appendChild(text);
  }
  if (validTime) {
    const footerTime = document.createElement("time");
    footerTime.className = "room-chat-message-time";
    footerTime.dateTime = sentAt.toISOString();
    footerTime.textContent = time.textContent;
    row.appendChild(footerTime);
  }

  messages.appendChild(row);

  const newMessagesButton = document.getElementById("room-chat-new-messages");
  if (nearBottom) {
    messages.scrollTop = messages.scrollHeight;
    if (newMessagesButton) newMessagesButton.hidden = true;
  } else if (newMessagesButton) {
    newMessagesButton.hidden = false;
  }
  if (message.from === callManager?.userId) {
    const pendingText = roomChatPendingMessages.get(message.clientMessageId);
    if (pendingText !== undefined) {
      roomChatPendingMessages.delete(message.clientMessageId);
      const input = document.getElementById("room-chat-input");
      if (input && input.value === pendingText) {
        input.value = "";
        updateRoomChatCounter();
      }
    }
  } else if (roomSidePanelMode !== "chat") {
    roomChatUnreadCount += 1;
    updateRoomChatUnreadBadge();
  }
}

function formatRoomAttachmentSize(size) {
  if (!Number.isSafeInteger(size) || size < 0) return "Taille inconnue";
  if (size < 1024) return `${size} o`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} Ko`;
  return `${(size / (1024 * 1024)).toFixed(1)} Mo`;
}

function formatRoomVoiceDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return "00:00";
  const totalSeconds = Math.floor(durationMs / 1000);
  return `${String(Math.floor(totalSeconds / 60)).padStart(2, "0")}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function getRoomFileIcon(mimeType) {
  if (typeof mimeType !== "string") return "FILE";
  if (mimeType.startsWith("image/")) return "▧";
  if (mimeType === "application/pdf") return "PDF";
  return "FILE";
}

function openRoomImageViewer(objectUrl, altText) {
  const viewer = document.getElementById("room-image-viewer");
  const image = document.getElementById("room-image-viewer-image");
  if (!viewer || !image) return;
  image.src = objectUrl;
  image.alt = altText || "Image agrandie";
  viewer.hidden = false;
  document.getElementById("room-image-viewer-close")?.focus();
}

function closeRoomImageViewer(event) {
  if (event && event.target !== event.currentTarget &&
      !event.target.closest(".room-image-viewer-close")) return;
  const viewer = document.getElementById("room-image-viewer");
  const image = document.getElementById("room-image-viewer-image");
  if (viewer) viewer.hidden = true;
  if (image) image.removeAttribute("src");
}

function getRoomAttachmentUrl(attachmentId) {
  if (typeof attachmentId !== "string" || !attachmentId) {
    throw new Error("Identifiant de pièce jointe invalide.");
  }
  if (!callManager?.serverUrl || !callManager.userId || !callManager.sessionToken) {
    throw new Error("La session utilisateur est indisponible pour accéder à cette pièce jointe.");
  }
  const httpBaseUrl = callManager.serverUrl
    .replace(/^wss:/i, "https:")
    .replace(/^ws:/i, "http:");
  return new URL(`/room-attachment/${encodeURIComponent(attachmentId)}`, httpBaseUrl);
}

async function loadRoomAttachment(attachmentId, expectedRoomId = roomManager?.room?.roomId) {
  const response = await fetch(getRoomAttachmentUrl(attachmentId), {
    method: "GET",
    headers: {
      "X-User-Id": callManager.userId,
      "X-Session-Token": callManager.sessionToken
    }
  });
  if (!response.ok) {
    let message = `Impossible de charger la pièce jointe (HTTP ${response.status}).`;
    try {
      const payload = await response.json();
      if (payload.message) message = payload.message;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    throw new Error(message);
  }
  const blob = await response.blob();
  if (expectedRoomId && roomManager?.room?.roomId !== expectedRoomId) {
    throw new Error("Vous avez quitté la réunion avant le chargement de la pièce jointe.");
  }
  const objectUrl = URL.createObjectURL(blob);
  roomChatObjectUrls.add(objectUrl);
  return objectUrl;
}

async function downloadRoomAttachment(attachment) {
  try {
    const objectUrl = await loadRoomAttachment(attachment.attachmentId, roomManager?.room?.roomId);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = typeof attachment.name === "string" ? attachment.name : "piece-jointe";
    document.body.appendChild(link);
    link.click();
    link.remove();
  } catch (error) {
    afficherChatError({ message: error.message || "Le téléchargement a échoué." });
  }
}

function afficherChatError(message) {
  const error = document.getElementById("room-chat-error");
  if (!error) return;
  let text = message?.message || "";
  const code = message?.code;
  if (text || code) roomChatPendingMessages.clear();
  if (code === "FILE_TOO_LARGE") text = "Fichier trop lourd. La taille maximale est de 10 Mio.";
  else if (code === "INVALID_MIME") text = "Type de fichier non autorisé.";
  else if (code === "VOICE_TOO_LONG") text = "La durée maximale d’un message vocal est de 120 secondes.";
  else if (code === "VOICE_TOO_SHORT") text = "Durée trop courte. Enregistrez au moins une seconde.";
  else if (code === "UPLOAD_FAILED") text = "Échec de l’upload. Réessayez.";
  else if (code === "NETWORK_UNAVAILABLE") text = "Réseau indisponible. Vérifiez votre connexion.";
  else if (code === "CHAT_EMPTY") text = text || "Le message ne peut pas être vide.";
  else if (code === "CHAT_TOO_LONG") text = text || "Le message ne peut pas dépasser 500 caractères.";
  else if (!navigator.onLine && text) text = "Réseau indisponible. Vérifiez votre connexion.";
  else if (/failed to fetch|networkerror|network request failed/i.test(text)) {
    text = "Réseau indisponible. Vérifiez votre connexion.";
  }
  if (text) {
    error.textContent = text;
    error.hidden = false;
  } else {
    error.hidden = true;
  }
}

function updateRoomChatScrollButton() {
  const messages = document.getElementById("room-chat-messages");
  const button = document.getElementById("room-chat-new-messages");
  if (!messages || !button) return;
  if (messages.scrollHeight - messages.scrollTop - messages.clientHeight < 48) {
    button.hidden = true;
  }
}

function scrollRoomChatToLatest() {
  const messages = document.getElementById("room-chat-messages");
  if (messages) messages.scrollTo({ top: messages.scrollHeight, behavior: "smooth" });
  const button = document.getElementById("room-chat-new-messages");
  if (button) button.hidden = true;
}

function sendRoomChatMessage() {
  if (roomChatUploadPending) return;
  if (roomChatPendingFile) {
    sendPendingRoomFile();
    return;
  }
  const input = document.getElementById("room-chat-input");
  if (!input) return;
  const clientMessageId = crypto.randomUUID();
  const sentText = input.value;
  if (!roomManager?.sendChatMessage({
    type: "text",
    text: sentText,
    clientMessageId
  })) return;
  if (roomChatPendingMessages.size >= 20) {
    roomChatPendingMessages.delete(roomChatPendingMessages.keys().next().value);
  }
  roomChatPendingMessages.set(clientMessageId, sentText);
  afficherChatError({ message: "" });
}

async function sendPendingRoomFile() {
  if (!roomChatPendingFile || !roomManager?.room || roomChatUploadPending) return;
  const file = roomChatPendingFile;
  setRoomChatUploadPending(true, file.type.startsWith("audio/") ? "Envoi du message vocal…" : "Envoi du fichier…");
  afficherChatError({ message: "" });
  try {
    if (file.type.startsWith("audio/")) {
      await sendSelectedRoomAudio(file);
    } else {
      await roomManager.sendFileMessage(file);
    }
    cancelRoomFilePreview();
  } catch (error) {
    afficherChatError({ code: getRoomChatErrorCode(error), message: error.message || "Échec de l’upload. Réessayez." });
  } finally {
    setRoomChatUploadPending(false);
  }
}

function getRoomChatErrorCode(error) {
  if (error?.code === "FILE_TOO_LARGE" || error?.code === "INVALID_MIME" ||
      error?.code === "VOICE_TOO_LONG" || error?.code === "VOICE_TOO_SHORT") return error.code;
  if (!navigator.onLine || error instanceof TypeError ||
      /failed to fetch|networkerror|network request failed/i.test(error?.message || "")) {
    return "NETWORK_UNAVAILABLE";
  }
  return "UPLOAD_FAILED";
}

function setRoomChatUploadPending(pending, message = "Envoi en cours…") {
  roomChatUploadPending = pending;
  for (const id of ["btn-room-chat-attach", "btn-room-voice-record", "btn-room-chat-send", "btn-room-chat-file-cancel"]) {
    const button = document.getElementById(id);
    if (button) button.disabled = pending;
  }
  const input = document.getElementById("room-chat-input");
  if (input) input.disabled = pending;
  const progress = document.getElementById("room-chat-upload-progress");
  const label = document.getElementById("room-chat-upload-label");
  if (progress) progress.hidden = !pending;
  if (label && pending) label.textContent = message;
}

function onRoomFileSelected(event) {
  const input = event.currentTarget;
  const file = input.files?.[0];
  if (!file) return;
  input.value = "";
  if (!roomManager?.room) {
    afficherChatError({ message: "Vous ne participez plus à cette réunion." });
    return;
  }
  if (file.size <= 0) {
    afficherChatError({ message: "Le fichier est vide." });
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    afficherChatError({ code: "FILE_TOO_LARGE" });
    return;
  }

  const fileTypes = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
  const voiceTypes = new Set(["audio/webm", "audio/ogg", "audio/mp4"]);
  if (!fileTypes.has(file.type) && !voiceTypes.has(file.type)) {
    afficherChatError({ code: "INVALID_MIME" });
    return;
  }

  cancelRoomFilePreview();
  roomChatPendingFile = file;
  const preview = document.getElementById("room-chat-file-preview");
  const previewContent = document.getElementById("room-chat-file-preview-content");
  const sendButton = document.getElementById("btn-room-chat-send");
  if (preview && previewContent) {
    preview.hidden = false;
    previewContent.replaceChildren();
    const icon = document.createElement("span");
    icon.className = "room-chat-file-icon";
    icon.textContent = getRoomFileIcon(file.type);
    const details = document.createElement("span");
    details.className = "room-chat-file-preview-details";
    const name = document.createElement("strong");
    name.className = "room-chat-file-name";
    name.textContent = file.name;
    name.title = file.name;
    const size = document.createElement("span");
    size.className = "room-chat-file-size";
    size.textContent = formatRoomAttachmentSize(file.size);
    details.append(name, size);
    previewContent.append(icon, details);
    if (file.type.startsWith("image/")) {
      roomChatPreviewUrl = URL.createObjectURL(file);
      const image = document.createElement("img");
      image.className = "room-chat-file-preview-image";
      image.src = roomChatPreviewUrl;
      image.alt = `Aperçu de ${file.name}`;
      previewContent.appendChild(image);
    }
  }
  if (sendButton) sendButton.textContent = file.type.startsWith("audio/") ? "Envoyer le vocal" : "Envoyer le fichier";
  afficherChatError({ message: "" });
}

function cancelRoomFilePreview() {
  if (roomChatPreviewUrl) URL.revokeObjectURL(roomChatPreviewUrl);
  roomChatPreviewUrl = null;
  roomChatPendingFile = null;
  const preview = document.getElementById("room-chat-file-preview");
  const previewContent = document.getElementById("room-chat-file-preview-content");
  const input = document.getElementById("room-chat-file");
  const sendButton = document.getElementById("btn-room-chat-send");
  if (preview) preview.hidden = true;
  if (previewContent) previewContent.replaceChildren();
  if (input) input.value = "";
  if (sendButton) sendButton.textContent = "Envoyer";
}

function sendSelectedRoomAudio(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const audio = new Audio();
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      URL.revokeObjectURL(objectUrl);
      if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
        reject(new Error("La durée du fichier audio n’a pas pu être déterminée."));
        return;
      }
      const durationMs = Math.round(audio.duration * 1000);
      if (durationMs < 1000) {
        reject(Object.assign(new Error("Durée trop courte. Enregistrez au moins une seconde."), { code: "VOICE_TOO_SHORT" }));
        return;
      }
      if (durationMs > 120000) {
        reject(Object.assign(new Error("Un message vocal ne peut pas dépasser 120 secondes."), { code: "VOICE_TOO_LONG" }));
        return;
      }
      if (!roomManager?.sendVoiceMessage) {
        reject(new Error("Le gestionnaire de réunion n’est pas disponible."));
        return;
      }
      roomManager.sendVoiceMessage(file, durationMs).then(resolve, reject);
    };
    audio.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Impossible de lire les métadonnées de ce fichier audio."));
    };
    audio.src = objectUrl;
  });
}

function toggleRoomVoiceRecording() {
  if (roomVoiceRecorder && roomVoiceRecorder.state === "recording") {
    stopRoomVoiceRecording();
  } else {
    startRoomVoiceRecording();
  }
}

async function startRoomVoiceRecording() {
  if (roomVoiceRecorder || roomVoiceStarting || roomChatUploadPending) return;
  if (roomChatPendingFile) {
    afficherChatError({ message: "Envoyez ou annulez la pièce jointe avant d’enregistrer un message vocal." });
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    afficherChatError({ message: "L’enregistrement audio n’est pas disponible sur cet appareil ou navigateur." });
    return;
  }

  const recordingRoomId = roomManager?.room?.roomId;
  if (!recordingRoomId) {
    afficherChatError({ message: "Vous ne participez plus à cette réunion." });
    return;
  }
  roomVoiceStarting = true;
  const recordButton = document.getElementById("btn-room-voice-record");
  if (recordButton) recordButton.disabled = true;
  try {
    roomVoiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (roomManager?.room?.roomId !== recordingRoomId) {
      releaseRoomVoiceRecording();
      return;
    }
    const supportedTypes = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
    const mimeType = supportedTypes.find((type) => MediaRecorder.isTypeSupported?.(type));
    roomVoiceRecorder = mimeType
      ? new MediaRecorder(roomVoiceStream, { mimeType })
      : new MediaRecorder(roomVoiceStream);
    roomVoiceChunks = [];
    roomVoiceCancelled = false;
    roomVoiceStartedAt = Date.now();
    roomVoiceRecorder.ondataavailable = (event) => {
      if (event.data?.size) roomVoiceChunks.push(event.data);
    };
    roomVoiceRecorder.onerror = (event) => {
      afficherChatError({ message: event.error?.message || "L’enregistrement audio a échoué." });
      cancelRoomVoiceRecording();
    };
    roomVoiceRecorder.onstop = async () => {
      const recorder = roomVoiceRecorder;
      const cancelled = roomVoiceCancelled;
      const durationMs = Math.min(Date.now() - roomVoiceStartedAt, 120000);
      const mimeType = recorder?.mimeType?.split(";")[0] || "audio/webm";
      const blob = new Blob(roomVoiceChunks, { type: mimeType });
      releaseRoomVoiceRecording();
      if (cancelled) return;
      if (durationMs < 1000) {
        afficherChatError({ code: "VOICE_TOO_SHORT" });
        return;
      }
      if (!blob.size) {
        afficherChatError({ message: "Aucun son n’a été enregistré." });
        return;
      }
      setRoomChatUploadPending(true, "Envoi du message vocal…");
      try {
        await roomManager.sendVoiceMessage(blob, durationMs);
        afficherChatError({ message: "" });
      } catch (error) {
        afficherChatError({ code: getRoomChatErrorCode(error), message: error.message || "Échec de l’upload. Réessayez." });
      } finally {
        setRoomChatUploadPending(false);
      }
    };
    roomVoiceRecorder.start();
    roomVoiceStarting = false;
    updateRoomVoiceRecordingUI(true);
    roomVoiceTimer = window.setInterval(() => {
      const elapsed = Date.now() - roomVoiceStartedAt;
      const duration = document.getElementById("room-voice-duration");
      if (duration) duration.textContent = formatRoomVoiceDuration(Math.min(elapsed, 120000));
      if (elapsed >= 120000) {
        afficherChatError({ message: "Durée maximale atteinte." });
        afficherRoomToastError("Durée maximale atteinte.");
        navigator.vibrate?.(100);
        stopRoomVoiceRecording();
      }
    }, 250);
  } catch (error) {
    releaseRoomVoiceRecording();
    afficherChatError({ message: ["NotAllowedError", "PermissionDeniedError"].includes(error.name)
      ? "L’accès au microphone a été refusé."
      : error.message || "Impossible de démarrer l’enregistrement." });
  }
}

function stopRoomVoiceRecording() {
  if (roomVoiceRecorder?.state === "recording") roomVoiceRecorder.stop();
}

function cancelRoomVoiceRecording() {
  if (!roomVoiceRecorder) {
    updateRoomVoiceRecordingUI(false);
    return;
  }
  roomVoiceCancelled = true;
  if (roomVoiceRecorder.state === "recording") {
    roomVoiceRecorder.stop();
  } else {
    releaseRoomVoiceRecording();
  }
}

function releaseRoomVoiceRecording() {
  if (roomVoiceTimer !== null) window.clearInterval(roomVoiceTimer);
  roomVoiceTimer = null;
  roomVoiceStream?.getTracks().forEach((track) => track.stop());
  roomVoiceStream = null;
  roomVoiceRecorder = null;
  roomVoiceChunks = [];
  roomVoiceStartedAt = 0;
  roomVoiceCancelled = false;
  roomVoiceStarting = false;
  updateRoomVoiceRecordingUI(false);
}

function updateRoomVoiceRecordingUI(recording) {
  const indicator = document.getElementById("room-voice-recording");
  const duration = document.getElementById("room-voice-duration");
  const button = document.getElementById("btn-room-voice-record");
  const fileButton = document.getElementById("btn-room-chat-attach");
  const cancelButton = document.getElementById("btn-room-voice-cancel");
  if (indicator) indicator.hidden = !recording;
  if (duration && !recording) duration.textContent = "00:00";
  if (button) {
    button.classList.toggle("is-recording", recording);
    button.disabled = roomChatUploadPending;
    button.setAttribute("aria-label", recording ? "Arrêter l’enregistrement" : "Enregistrer un message vocal");
    button.title = recording ? "Arrêter l’enregistrement" : "Enregistrer un message vocal";
  }
  if (fileButton) fileButton.disabled = recording || roomChatUploadPending;
  if (cancelButton) cancelButton.disabled = !recording;
}

function onRoomChatInputKeydown(event) {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendRoomChatMessage();
  }
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
    const feedback = document.getElementById("room-copy-feedback");
    if (feedback) {
      feedback.textContent = "Copié !";
      feedback.hidden = false;
      if (roomCodeCopyTimer) clearTimeout(roomCodeCopyTimer);
      roomCodeCopyTimer = setTimeout(() => {
        feedback.textContent = "";
        feedback.hidden = true;
        roomCodeCopyTimer = null;
      }, 2000);
    }
  } catch (error) {
    console.warn("Impossible de copier le code de réunion :", error);
    window.prompt("Copiez le code de la réunion :", code);
  }
}

function afficherSalle(room) {
  const lobby = document.getElementById("room-lobby");
  const prejoin = document.getElementById("room-prejoin");
  const panel = document.getElementById("room-panel");
  const codeElement = document.getElementById("room-code-display");
  const participantsList = document.getElementById("room-participants");
  const videoGrid = document.getElementById("room-video-grid");

  if (!lobby || !panel || !codeElement || !participantsList) return;

  document.body.classList.toggle("in-meeting", !!room);
  lobby.hidden = !!room;
  prejoin.hidden = !!room;
  panel.hidden = !room;
  if (!room) {
    closeRoomAudioAnalysis();
    const sidePanel = document.getElementById("room-side-panel");
    sidePanel?.style.removeProperty("--room-visual-viewport-height");
    sidePanel?.style.removeProperty("--room-visual-viewport-top");
    document.body.classList.remove("room-side-panel-open");
    setRoomParticipationLoading(false);
    roomChatRoomId = null;
    resetRoomChat();
    codeElement.textContent = "";
    document.getElementById("room-lock-indicator").hidden = true;
    document.getElementById("room-host-controls").hidden = true;
    const handButton = document.getElementById("btn-room-hand");
    handButton?.setAttribute("aria-pressed", "false");
    handButton?.classList.remove("is-raised");
    if (handButton) {
      handButton.setAttribute("aria-label", "Lever la main");
      handButton.title = "Lever la main";
    }
    participantsList.replaceChildren();
    videoGrid?.replaceChildren();
    if (videoGrid) {
      videoGrid.dataset.count = "1";
      videoGrid.dataset.countCategory = "compact";
      for (const property of [
        "--room-gallery-columns",
        "--room-gallery-rows",
        "--room-gallery-mobile-columns",
        "--room-gallery-mobile-rows"
      ]) videoGrid.style.removeProperty(property);
    }
    updateRoomSpeakerLayout();
    afficherRoomMediaError("");
    afficherRoomNotification("");
    const emptyState = document.getElementById("room-empty-state");
    if (emptyState) {
      if (roomEmptyStateTimer) clearTimeout(roomEmptyStateTimer);
      roomEmptyStateTimer = null;
      emptyState.classList.remove("is-visible");
      emptyState.hidden = true;
    }
    return;
  }

  setRoomParticipationLoading(false);
  updateRoomVisualViewport();
  if (roomChatRoomId !== room.roomId) {
    resetRoomChat();
    roomChatRoomId = room.roomId;
  }
  roomPreviewStream = null;
  pendingRoomAction = null;
  codeElement.textContent = room.code;
  document.getElementById("room-lock-indicator").hidden = room.locked !== true;
  document.getElementById("room-host-controls").hidden = room.hostId !== callManager?.userId;
  const self = room.participants.find((participant) => participant.id === callManager?.userId);
  const handButton = document.getElementById("btn-room-hand");
  if (handButton) {
    const raised = self?.raised === true;
    handButton.classList.toggle("is-raised", raised);
    handButton.setAttribute("aria-pressed", String(raised));
    handButton.setAttribute("aria-label", raised ? "Baisser la main" : "Lever la main");
    handButton.title = raised ? "Baisser la main" : "Lever la main";
  }
  const lockButton = document.getElementById("btn-room-lock");
  if (lockButton) lockButton.textContent = room.locked ? "Déverrouiller la salle" : "Verrouiller la salle";
  updateRoomParticipantsList(room, participantsList);

  if (videoGrid) {
    const participantCount = room.participants.length;
    videoGrid.dataset.count = String(participantCount);
    updateRoomGalleryGeometry(videoGrid, participantCount);
    const participantIds = new Set(room.participants.map((participant) => participant.id));
    for (const participant of room.participants) {
      const tile = ensureRoomVideoTile(
        participant.id,
        RoomManager.formatDisplayName(participant, room.participants),
        participant.id === callManager?.userId
      );
      updateRoomTileState(participant);
      if (tile) ensureRoomAudioAnalyzer(participant.id, tile.querySelector("video")?.srcObject);
    }
    for (const tile of Array.from(videoGrid.children)) {
      if (!participantIds.has(tile.dataset.participantId)) {
        tile.classList.add("room-tile-leave");
        window.setTimeout(() => tile.remove(), 180);
      }
    }
  }
  const emptyState = document.getElementById("room-empty-state");
  if (emptyState) updateRoomEmptyState(emptyState, room.participants.length <= 1);
  updateRoomSpeakerLayout();
  afficherErreurSalle("");
}

function updateRoomGalleryGeometry(grid, count) {
  const participantCount = Math.max(1, count);
  if (participantCount <= 4) {
    grid.dataset.countCategory = "compact";
    for (const property of [
      "--room-gallery-columns",
      "--room-gallery-rows",
      "--room-gallery-mobile-columns",
      "--room-gallery-mobile-rows"
    ]) grid.style.removeProperty(property);
    return;
  }

  const category = participantCount <= 6 ? "medium" : "large";
  const columns = participantCount <= 6 ? 3 : Math.ceil(Math.sqrt(participantCount));
  const mobileColumns = participantCount <= 6 ? 2 : Math.min(3, Math.ceil(Math.sqrt(participantCount)));
  grid.dataset.countCategory = category;
  grid.style.setProperty("--room-gallery-columns", String(columns));
  grid.style.setProperty("--room-gallery-rows", String(Math.ceil(participantCount / columns)));
  grid.style.setProperty("--room-gallery-mobile-columns", String(mobileColumns));
  grid.style.setProperty("--room-gallery-mobile-rows", String(Math.ceil(participantCount / mobileColumns)));
}

function updateRoomParticipantsList(room, list) {
  const activeIds = new Set();
  for (const participant of room.participants) {
    activeIds.add(participant.id);
    let item = Array.from(list.children).find((entry) => entry.dataset.participantId === participant.id);
    if (!item) {
      item = document.createElement("li");
      item.dataset.participantId = participant.id;
      const identity = document.createElement("span");
      identity.className = "room-participant-identity";
      const name = document.createElement("strong");
      const role = document.createElement("span");
      role.className = "room-participant-role";
      identity.append(name, role);
      const media = document.createElement("span");
      media.className = "room-participant-media";
      const hand = document.createElement("span");
      hand.className = "room-participant-hand";
      hand.textContent = "✋";
      hand.title = "Main levée";
      hand.setAttribute("aria-label", "Main levée");
      hand.hidden = true;
      const actions = document.createElement("span");
      actions.className = "room-participant-actions";
      const kickButton = document.createElement("button");
      kickButton.className = "room-kick-button";
      kickButton.type = "button";
      kickButton.textContent = "Expulser";
      kickButton.addEventListener("click", () => {
        const name = item.querySelector(".room-participant-identity strong")?.textContent || "ce participant";
        if (window.confirm(`Expulser ${name} de la réunion ?`)) {
          roomManager?.kickParticipant(participant.id);
        }
      });
      actions.appendChild(kickButton);
      item.append(identity, hand, media, actions);
    }

    const displayName = RoomManager.formatDisplayName(participant, room.participants);
    const isLocal = participant.id === callManager?.userId;
    item.querySelector(".room-participant-identity strong").textContent = displayName;
    const role = item.querySelector(".room-participant-role");
    role.textContent = [
      participant.role === "host" ? "Hôte" : "",
      isLocal ? "(vous)" : ""
    ].filter(Boolean).join(" · ");
    role.hidden = !role.textContent;

    const media = item.querySelector(".room-participant-media");
    const audioMuted = participant.audio === false;
    const videoMuted = participant.video === false;
    if (media.dataset.audioMuted !== String(audioMuted)) {
      const icon = createRoomParticipantStateIcon("audio", audioMuted);
      if (media.firstElementChild) media.firstElementChild.replaceWith(icon);
      else media.appendChild(icon);
      media.dataset.audioMuted = String(audioMuted);
    }
    if (media.dataset.videoMuted !== String(videoMuted)) {
      const icon = createRoomParticipantStateIcon("video", videoMuted);
      if (media.children[1]) media.children[1].replaceWith(icon);
      else media.appendChild(icon);
      media.dataset.videoMuted = String(videoMuted);
    }
    item.classList.toggle("is-speaking", participant.id === roomActiveSpeakerId);
    item.querySelector(".room-participant-hand").hidden = participant.raised !== true;
    item.querySelector(".room-participant-actions button").hidden =
      room.hostId !== callManager?.userId || isLocal;
    item.setAttribute("aria-label", [
      displayName,
      participant.id === roomActiveSpeakerId ? "parle actuellement" : "",
      participant.raised === true ? "main levée" : ""
    ].filter(Boolean).join(", "));
    if (item.parentElement !== list) list.appendChild(item);
  }
  for (const item of Array.from(list.children)) {
    if (!activeIds.has(item.dataset.participantId)) item.remove();
  }
}

function updateRoomEmptyState(element, isAlone) {
  if (roomEmptyStateTimer) clearTimeout(roomEmptyStateTimer);
  roomEmptyStateTimer = null;
  if (isAlone) {
    element.hidden = false;
    requestAnimationFrame(() => element.classList.add("is-visible"));
    return;
  }
  element.classList.remove("is-visible");
  roomEmptyStateTimer = window.setTimeout(() => {
    element.hidden = true;
    roomEmptyStateTimer = null;
  }, 180);
}

function ensureRoomVideoTile(participantId, displayName, isLocal = false) {
  const grid = document.getElementById("room-video-grid");
  if (!grid) return null;
  let tile = Array.from(grid.children).find((element) => element.dataset.participantId === participantId);
  if (tile) {
    tile.dataset.local = String(isLocal);
    tile.style.setProperty("--room-avatar-color", roomAvatarColor(displayName));
    const name = tile.querySelector(".room-video-name");
    if (name) name.textContent = `${displayName}${isLocal ? " (vous)" : ""}`;
    const localBadge = tile.querySelector(".room-local-badge");
    if (localBadge) localBadge.hidden = !isLocal;
    return tile;
  }

  tile = document.createElement("article");
  tile.className = "room-video-tile room-tile-enter";
  tile.dataset.participantId = participantId;
  tile.dataset.local = String(isLocal);
  tile.style.setProperty("--room-avatar-color", roomAvatarColor(displayName));

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.muted = isLocal;
  video.hidden = true;

  const placeholder = document.createElement("div");
  placeholder.className = "room-video-placeholder";
  const avatar = document.createElement("span");
  avatar.className = "room-avatar-initial";
  avatar.textContent = displayName.trim().charAt(0).toUpperCase() || "?";
  const cameraMessage = document.createElement("span");
  cameraMessage.className = "room-camera-message";
  cameraMessage.textContent = "Caméra désactivée";
  placeholder.append(avatar, cameraMessage);

  const audioMuted = document.createElement("span");
  audioMuted.className = "room-audio-muted";
  audioMuted.setAttribute("aria-label", "Micro coupé");
  audioMuted.appendChild(createRoomMutedMicrophoneIcon());
  audioMuted.hidden = true;

  const videoMuted = createRoomParticipantStateIcon("video", true);
  videoMuted.classList.add("room-video-muted");
  videoMuted.hidden = true;

  const connectionStatus = document.createElement("span");
  connectionStatus.className = "room-video-status";
  connectionStatus.textContent = "Connexion…";
  connectionStatus.dataset.state = "connecting";
  connectionStatus.hidden = isLocal;

  const name = document.createElement("span");
  name.className = "room-video-name";
  name.textContent = `${displayName}${isLocal ? " (vous)" : ""}`;
  const localBadge = document.createElement("span");
  localBadge.className = "room-local-badge";
  localBadge.textContent = "Vous";
  localBadge.hidden = !isLocal;
  const handIndicator = document.createElement("span");
  handIndicator.className = "room-video-hand";
  handIndicator.textContent = "✋";
  handIndicator.setAttribute("aria-label", "Main levée");
  handIndicator.hidden = true;

  tile.append(video, placeholder, audioMuted, videoMuted, connectionStatus, handIndicator, localBadge, name);
  grid.appendChild(tile);
  requestAnimationFrame(() => tile.classList.remove("room-tile-enter"));
  return tile;
}

function roomAvatarColor(name) {
  let hash = 0;
  for (const character of String(name || "Participant")) {
    hash = (hash * 31 + character.codePointAt(0)) >>> 0;
  }
  return `hsl(${hash % 360} 58% 40%)`;
}

function createRoomMutedMicrophoneIcon() {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const definition of [
    ["rect", { x: "9", y: "2", width: "6", height: "12", rx: "3" }],
    ["path", { d: "M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" }],
    ["path", { d: "m4 4 16 16" }]
  ]) {
    const element = document.createElementNS(namespace, definition[0]);
    for (const [attribute, value] of Object.entries(definition[1])) element.setAttribute(attribute, value);
    svg.appendChild(element);
  }
  return svg;
}

function createRoomParticipantStateIcon(kind, isMuted) {
  const wrapper = document.createElement("span");
  wrapper.className = `room-participant-state${isMuted ? " is-muted" : ""}`;
  const label = kind === "audio"
    ? (isMuted ? "Micro coupé" : "Micro actif")
    : (isMuted ? "Caméra désactivée" : "Caméra active");
  wrapper.setAttribute("role", "img");
  wrapper.setAttribute("aria-label", label);
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(namespace, "path");
  path.setAttribute("d", kind === "audio"
    ? "M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3ZM5 10v1a7 7 0 0 0 14 0v-1M12 18v4m-4 0h8"
    : "M3 6h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Zm14 3 4-2v10l-4-2");
  svg.appendChild(path);
  if (isMuted) {
    const slash = document.createElementNS(namespace, "path");
    slash.setAttribute("d", "m4 4 16 16");
    svg.appendChild(slash);
  }
  wrapper.appendChild(svg);
  return wrapper;
}

function renderRoomLocalStream(stream) {
  if (!callManager?.userId) return;
  const participant = roomManager?.room?.participants.find((item) => item.id === callManager.userId);
  const tile = ensureRoomVideoTile(
    callManager.userId,
    participant
      ? RoomManager.formatDisplayName(participant, roomManager.room.participants)
      : callManager.userId,
    true
  );
  if (!tile) return;
  const video = tile.querySelector("video");
  video.srcObject = stream;
  ensureRoomAudioAnalyzer(callManager.userId, stream);
  if (participant) updateRoomTileState(participant);
}

function renderRoomRemoteStream(participantId, stream) {
  stream.getVideoTracks().forEach((track) => {
    if (roomVideoTracks.has(track)) return;
    roomVideoTracks.add(track);
    const update = () => updateRemoteVideoTile(participantId, stream);
    track.addEventListener("mute", update);
    track.addEventListener("unmute", update);
    track.addEventListener("ended", update);
  });

  const participant = roomManager?.room?.participants.find((item) => item.id === participantId);
  const tile = ensureRoomVideoTile(
    participantId,
    participant
      ? RoomManager.formatDisplayName(participant, roomManager.room.participants)
      : "Participant"
  );
  if (!tile) return;
  const video = tile.querySelector("video");
  video.autoplay = true;
  video.playsInline = true;
  video.srcObject = stream;
  ensureRoomAudioAnalyzer(participantId, stream);
  updateRemoteVideoTile(participantId, stream);
}

function ensureRoomAudioAnalyzer(participantId, stream) {
  const audioTracks = stream?.getAudioTracks?.().filter((track) => track.readyState === "live") || [];
  const current = roomAudioAnalyzers.get(participantId);
  const tracksMatch = current &&
    current.stream === stream &&
    current.audioTracks.length === audioTracks.length &&
    current.audioTracks.every((track, index) => track === audioTracks[index]);
  if (tracksMatch) return;

  removeRoomAudioAnalyzer(participantId, false);
  if (!stream || audioTracks.length === 0) return;

  const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextConstructor) return;
  try {
    if (!roomAudioContext || roomAudioContext.state === "closed") {
      roomAudioContext = new AudioContextConstructor();
    }
    const source = roomAudioContext.createMediaStreamSource(stream);
    const analyser = roomAudioContext.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.2;
    source.connect(analyser);
    roomAudioAnalyzers.set(participantId, {
      stream,
      audioTracks,
      source,
      analyser,
      samples: new Uint8Array(analyser.fftSize),
      level: 0
    });
    resumeRoomAudioContext();
    if (roomAudioSampleTimer === null) {
      roomAudioSampleTimer = window.setInterval(sampleRoomAudioLevels, ROOM_AUDIO_SAMPLE_INTERVAL_MS);
    }
  } catch (error) {
    console.warn(`[UI] Analyse audio de ${participantId} impossible :`, error);
    removeRoomAudioAnalyzer(participantId);
  }
}

function resumeRoomAudioContext() {
  if (roomAudioContext?.state !== "suspended") return;
  roomAudioContext.resume().catch((error) => {
    console.warn("[UI] Activation de l’analyse audio impossible :", error);
  });
}

function removeRoomAudioAnalyzer(participantId, updateSpeaker = true) {
  const record = roomAudioAnalyzers.get(participantId);
  if (record) {
    record.source.disconnect();
    record.analyser.disconnect();
    roomAudioAnalyzers.delete(participantId);
  }
  if (updateSpeaker && roomActiveSpeakerId === participantId) setRoomActiveSpeaker(null);
  if (roomAudioAnalyzers.size === 0 && roomAudioSampleTimer !== null) {
    window.clearInterval(roomAudioSampleTimer);
    roomAudioSampleTimer = null;
  }
}

function closeRoomAudioAnalysis() {
  for (const participantId of Array.from(roomAudioAnalyzers.keys())) {
    removeRoomAudioAnalyzer(participantId, false);
  }
  if (roomAudioSampleTimer !== null) window.clearInterval(roomAudioSampleTimer);
  roomAudioSampleTimer = null;
  setRoomActiveSpeaker(null);
  const context = roomAudioContext;
  roomAudioContext = null;
  if (context && context.state !== "closed") {
    context.close().catch((error) => {
      console.warn("[UI] Fermeture de l’analyse audio impossible :", error);
    });
  }
}

function roomAudioParticipantCanSpeak(participantId, record) {
  const participant = roomManager?.room?.participants.find((item) => item.id === participantId);
  if (!participant || participant.audio === false) return false;
  return record.audioTracks.some((track) =>
    track.readyState === "live" && track.enabled !== false && !track.muted
  );
}

function sampleRoomAudioLevels() {
  if (!roomAudioContext || roomAudioAnalyzers.size === 0) {
    return;
  }
  if (roomAudioContext.state !== "running") {
    if (roomActiveSpeakerId &&
        performance.now() - roomActiveSpeakerLastHeardAt >= ROOM_SPEAKER_HOLD_MS) {
      setRoomActiveSpeaker(null);
    }
    return;
  }

  let strongest = null;
  for (const [participantId, record] of roomAudioAnalyzers) {
    if (!roomAudioParticipantCanSpeak(participantId, record)) {
      record.level = 0;
      continue;
    }

    record.analyser.getByteTimeDomainData(record.samples);
    let sumSquares = 0;
    for (const sample of record.samples) {
      const amplitude = (sample - 128) / 128;
      sumSquares += amplitude * amplitude;
    }
    const measuredLevel = Math.sqrt(sumSquares / record.samples.length);
    record.level = record.level * 0.55 + measuredLevel * 0.45;
    if (!strongest || record.level > strongest.level) {
      strongest = { participantId, level: record.level };
    }
  }

  const now = performance.now();
  const active = roomActiveSpeakerId && roomAudioAnalyzers.get(roomActiveSpeakerId);
  if (roomActiveSpeakerId && !active) setRoomActiveSpeaker(null);
  if (roomActiveSpeakerId && active && !roomAudioParticipantCanSpeak(roomActiveSpeakerId, active)) {
    setRoomActiveSpeaker(null);
  }

  if (!roomActiveSpeakerId) {
    if (strongest && strongest.level >= ROOM_SPEAKER_THRESHOLD) {
      roomActiveSpeakerLastHeardAt = now;
      setRoomActiveSpeaker(strongest.participantId);
    }
    return;
  }

  const current = roomAudioAnalyzers.get(roomActiveSpeakerId);
  const currentLevel = current?.level || 0;
  if (currentLevel >= ROOM_SPEAKER_THRESHOLD * 0.65) {
    roomActiveSpeakerLastHeardAt = now;
  }

  if (strongest && strongest.participantId !== roomActiveSpeakerId &&
      strongest.level >= ROOM_SPEAKER_THRESHOLD &&
      (strongest.level > currentLevel * ROOM_SPEAKER_HYSTERESIS ||
       now - roomActiveSpeakerLastHeardAt >= ROOM_SPEAKER_HOLD_MS)) {
    roomActiveSpeakerLastHeardAt = now;
    setRoomActiveSpeaker(strongest.participantId);
  } else if (now - roomActiveSpeakerLastHeardAt >= ROOM_SPEAKER_HOLD_MS) {
    setRoomActiveSpeaker(null);
  }
}

function setRoomActiveSpeaker(participantId) {
  if (roomActiveSpeakerId === participantId) return;
  roomActiveSpeakerId = participantId;
  const tiles = document.querySelectorAll(".room-video-tile[data-participant-id]");
  for (const tile of tiles) {
    const speaking = tile.dataset.participantId === participantId;
    tile.classList.toggle("is-speaking", speaking);
    if (speaking) tile.setAttribute("aria-label", `${tile.querySelector(".room-video-name")?.textContent || "Participant"}, parle actuellement`);
    else tile.removeAttribute("aria-label");
  }
  const participants = document.querySelectorAll("#room-participants [data-participant-id]");
  for (const item of participants) {
    item.classList.toggle("is-speaking", item.dataset.participantId === participantId);
  }
  updateRoomSpeakerLayout();
}

function updateRemoteVideoTile(participantId, stream) {
  const tile = getRoomVideoTile(participantId);
  if (!tile) return;
  const video = tile.querySelector("video");
  video.autoplay = true;
  video.playsInline = true;
  const participant = roomManager?.room?.participants.find((item) => item.id === participantId);
  if (participant) updateRoomTileState(participant);
  video.play().catch((error) => {
    console.warn(`[UI] Lecture du média de réunion de ${participantId} impossible :`, error);
  });
}

function updateRoomTileState(participant) {
  const tile = getRoomVideoTile(participant.id);
  if (!tile) return;
  const handIndicator = tile.querySelector(".room-video-hand");
  if (handIndicator) handIndicator.hidden = participant.raised !== true;
  const mutedIndicator = tile.querySelector(".room-audio-muted");
  mutedIndicator.hidden = participant.audio !== false;
  const cameraMutedIndicator = tile.querySelector(".room-video-muted");
  if (cameraMutedIndicator) {
    cameraMutedIndicator.hidden = participant.video !== false;
    cameraMutedIndicator.setAttribute("aria-label", participant.video === false
      ? "Caméra désactivée"
      : "Caméra active");
  }

  const video = tile.querySelector("video");
  const stream = video.srcObject;
  const hasLiveVideo = !!stream && stream.getVideoTracks().some((track) => track.readyState === "live");
  const videoEnabled = participant.video !== false;
  video.hidden = !(videoEnabled && hasLiveVideo);
  tile.querySelector(".room-video-placeholder").hidden = videoEnabled && hasLiveVideo;
  tile.querySelector(".room-camera-message").textContent = videoEnabled
    ? "Caméra indisponible"
    : "Caméra désactivée";
  tile.querySelector(".room-avatar-initial").textContent =
    (participant.displayName || "Participant").trim().charAt(0).toUpperCase() || "?";
}

function updateRoomPeerState(participantId, state) {
  const tile = getRoomVideoTile(participantId);
  if (!tile) return;
  const status = tile.querySelector(".room-video-status");
  if (!status) return;

  if (state.connectionState === "failed" || state.iceConnectionState === "failed") {
    status.textContent = "Échec";
    status.dataset.state = "failed";
    status.hidden = false;
  } else if (["connecting", "disconnected"].includes(state.connectionState) ||
      ["new", "checking", "disconnected"].includes(state.iceConnectionState)) {
    status.textContent = "Connexion…";
    status.dataset.state = "connecting";
    status.hidden = false;
  } else {
    status.hidden = true;
  }
}

function getRoomVideoTile(participantId) {
  const grid = document.getElementById("room-video-grid");
  return grid && Array.from(grid.children).find(
    (element) => element.dataset.participantId === participantId
  );
}

function removeRoomVideoTile(participantId) {
  removeRoomAudioAnalyzer(participantId);
  if (roomActiveSpeakerId === participantId) setRoomActiveSpeaker(null);
  const tile = getRoomVideoTile(participantId);
  if (!tile) return;
  tile.classList.add("room-tile-leave");
  window.setTimeout(() => tile.remove(), 180);
}

function afficherRoomMediaError(message) {
  if (message) afficherRoomToastError(message);
}

function updateRoomMediaButtons(state) {
  const micButton = document.getElementById("btn-room-mic");
  const cameraButton = document.getElementById("btn-room-camera");
  if (micButton) {
    const enabled = state.audio.available && state.audio.enabled;
    micButton.disabled = !roomManager?.room;
    micButton.classList.toggle("is-muted", !enabled);
    micButton.setAttribute("aria-pressed", String(enabled));
    micButton.setAttribute("aria-label", enabled ? "Couper le micro" : "Activer le micro");
    micButton.title = enabled ? "Couper le micro (M)" : "Activer le micro (M)";
  }
  if (cameraButton) {
    const enabled = state.video.available && state.video.enabled;
    cameraButton.disabled = !roomManager?.room;
    cameraButton.classList.toggle("is-muted", !enabled);
    cameraButton.setAttribute("aria-pressed", String(enabled));
    cameraButton.setAttribute("aria-label", enabled ? "Couper la caméra" : "Activer la caméra");
    cameraButton.title = enabled ? "Couper la caméra (V)" : "Activer la caméra (V)";
  }
  const self = roomManager?.room?.participants.find(
    (participant) => participant.id === callManager?.userId
  );
  if (self) {
    self.audio = state.audio.available ? state.audio.enabled : false;
    self.video = state.video.available ? state.video.enabled : false;
    afficherSalle(roomManager.room);
  }
}

function toggleRoomMicrophone() {
  meshManager?.toggleAudio();
}

function toggleRoomHand() {
  const self = roomManager?.room?.participants.find(
    (participant) => participant.id === callManager?.userId
  );
  if (!self) return;
  roomManager.raiseHand(self.raised !== true);
}

function muteAllRoomParticipants() {
  if (roomManager?.room?.hostId !== callManager?.userId) return;
  roomManager.muteAll();
}

function toggleRoomLock() {
  const room = roomManager?.room;
  if (!room || room.hostId !== callManager?.userId) return;
  roomManager.lockRoom(room.locked !== true);
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
  const targetId = normalizePhoneNumber(targetInput?.value);

  if (!targetId) {
    alert("Veuillez saisir le numéro du destinataire.");
    return;
  }
  if (!/^\+[1-9]\d{7,14}$/.test(targetId)) {
    alert("Saisissez un numéro au format international, par exemple +33612345678.");
    return;
  }

  try {
    const recipientName = recipientDisplayNames.get(targetId) || await lookupRecipient();
    const displayTarget = recipientName || targetId;
    showActiveCallUI(displayTarget);
    updateStatus(`${withVideo ? "Appel vidéo" : "Appel"} de ${displayTarget}...`);
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
    const callerId = callManager.currentCallerId || callManager.targetUserId;
    showActiveCallUI(recipientDisplayNames.get(callerId) || callerId);
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