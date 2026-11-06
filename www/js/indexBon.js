document.addEventListener("deviceready", onDeviceReady, false);

/* =========================================================
   CONFIGURATION
========================================================= */

const SIGNALING_SERVER_URL = "wss://node-b44u.onrender.com";
const HTTP_SERVER_URL = "https://node-b44u.onrender.com";

const RECONNECT_DELAY = 5000;

let myId = null;
let ws = null;

let peerConnection = null;
let localStream = null;

let targetUserId = null;
let pendingOffer = null;
let pendingCandidates = []; // File d'attente pour stocker les candidats ICE reçus avant la connexion

let reconnectTimer = null;
let manuallyClosed = false;

let isMuted = false;
let isRestartingIce = false; // Empêche les boucles infinies de restart ICE

let interval = null; // Utilisé au niveau du minuteur 

const interfaceReceiver = document.getElementById("interface-2");
const interfaceSender = document.getElementById("interface-1");

/* =========================================================
   CONFIGURATION WEBRTC
========================================================= */

const rtcConfig = {
  iceServers: [
    {
      urls: "stun:stun.l.google.com:19302",
    },
  ],
};

/* =========================================================
   DEVICE READY
========================================================= */

async function onDeviceReady() {
  console.log("=================================");
  console.log("🚀 APPLICATION DÉMARRÉE");
  console.log("=================================");

  try {
    /* 1. Demande de permission microphone */
    await requestMicrophonePermission();

    /* 2. Génération / récupération de l'ID */
    initializeUserId();

    /* 3. Affichage de l'ID */
    const idElement = document.getElementById("my-id-display");
    if (idElement) {
      idElement.innerText = myId;
    }

    /* 4. Connexion au serveur */
    connectWebSocket();
  } catch (error) {
    console.error("❌ Erreur lors du démarrage :", error);
    updateStatus("Erreur au démarrage");
  }
}

/* =========================================================
   PERMISSION MICROPHONE
========================================================= */

function requestMicrophonePermission() {
  return new Promise((resolve) => {
    if (window.cordova && cordova.plugins && cordova.plugins.permissions) {
      const permissions = cordova.plugins.permissions;

      permissions.requestPermission(
        permissions.RECORD_AUDIO,
        function (status) {
          console.log("🎤 Permission microphone :", status);
          resolve();
        },
        function (error) {
          console.error("❌ Erreur permission microphone :", error);
          resolve();
        }
      );
    } else {
      console.log("ℹ️ Plugin permissions non disponible");
      resolve();
    }
  });
}

/* =========================================================
   INITIALISATION ID UTILISATEUR
========================================================= */

function initializeUserId() {
  myId = localStorage.getItem("app_user_id");

  if (!myId) {
    myId = "ID-" + Math.floor(100000 + Math.random() * 900000);
    localStorage.setItem("app_user_id", myId);
    console.log("🆕 Nouvel ID créé :", myId);
  } else {
    console.log("👤 ID utilisateur :", myId);
  }
}

/* =========================================================
   CONNEXION WEBSOCKET
========================================================= */

async function connectWebSocket() {
  if (
    ws &&
    (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
  ) {
    console.log("⚠️ Une connexion existe déjà.");
    return;
  }

  clearTimeout(reconnectTimer);
  updateStatus("Connexion au serveur...");

  console.log("🌐 Tentative de connexion :", SIGNALING_SERVER_URL);

  try {
    console.log("⏳ Vérification du serveur Render...");
    await fetch(HTTP_SERVER_URL, {
      method: "GET",
      cache: "no-cache",
    });
  } catch (error) {
    console.warn("⚠️ Le ping HTTP a échoué :", error);
  }

  createWebSocket();
}

/* =========================================================
   CRÉER LA WEBSOCKET
========================================================= */

function createWebSocket() {
  if (ws) {
    try {
      ws.close();
    } catch (error) {
      console.warn("Erreur fermeture ancienne WS :", error);
    }
    ws = null;
  }

  updateStatus("Ouverture de la connexion...");
  console.log("🔌 Création WebSocket...");

  try {
    ws = new WebSocket(SIGNALING_SERVER_URL);
  } catch (error) {
    console.error("❌ Impossible de créer WebSocket :", error);
    scheduleReconnect();
    return;
  }

  ws.onopen = function () {
    console.log("=================================");
    console.log("✅ WEBSOCKET CONNECTÉ");
    console.log("=================================");
    updateStatus("En ligne");

    sendSignal({
      type: "register-user",
      userId: myId,
    });
  };

  ws.onmessage = function (event) {
  let data;
  try {
    data = JSON.parse(event.data);
  } catch (error) {
    console.error("❌ Message JSON invalide :", event.data);
    return;
  }

  console.log("📦 Données reçues :", data);

  switch (data.type) {
    case "incoming-call":
      handleIncomingCall(data);
      break;

    case "call-answered":
      handleCallAnswered(data);
      startTimer();
      break;

    case "ice-candidate":
      handleNewICECandidate(data);
      break;

    case "call-refused":
      alert("L'appel a été refusé.");
      hangUp(false);
      break;

    case "call-end":
      console.log("📞 Signal de fin d'appel reçu.");
      hangUp(false);
      break;

    case "restart-offer":
      handleRestartOffer(data);
      break;

    // NOUVEAU : Gérer le destinataire hors ligne
    case "user-offline":
      updateStatus(`L'utilisateur ${data.targetId} n'est pas connecté au serveur.`);
      //hangUp(false); // Annule l'appel localement sans émettre de message de fin
      break;

    default:
      console.log("ℹ️ Type de message inconnu :", data.type);
  }
};
  ws.onerror = function (error) {
    console.error("❌ ERREUR WEBSOCKET", error);
    updateStatus("Erreur de connexion");
  };



  ws.onclose = function (event) {
    console.warn("⚠️ WEBSOCKET FERMÉ Code :", event.code);
    ws = null;

    if (!manuallyClosed) {
      updateStatus("Hors ligne");
      scheduleReconnect();
    }
  };
}

/* =========================================================
   RECONNEXION AUTOMATIQUE
========================================================= */

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  console.log("🔄 Reconnexion dans", RECONNECT_DELAY / 1000, "secondes...");
  updateStatus("Hors ligne - reconnexion...");

  reconnectTimer = setTimeout(function () {
    connectWebSocket();
  }, RECONNECT_DELAY);
}

/* =========================================================
   ENVOYER UN MESSAGE
========================================================= */

function sendSignal(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    console.log("📤 Envoi :", data);
    ws.send(JSON.stringify(data));
    return true;
  } else {
    console.warn("⚠️ WebSocket non connectée.");
    return false;
  }
}

/* =========================================================
   STATUT
========================================================= */

function updateStatus(message) {
  console.log("📡 STATUT :", message);
  const statusElement = document.getElementById("status");
  if (statusElement) {
    statusElement.innerText = message;
  }
}

/* =========================================================
   LANCER UN APPEL
========================================================= */
async function makeCall() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    alert("Vous n'êtes pas connecté au serveur.");
    return;
  }

  const input = document.getElementById("target-id-input");
  if (!input) return;

  const targetId = input.value.trim();
  if (!targetId) {
    alert("Saisissez un ID cible.");
    return;
  }

  if (targetId === myId) {
    alert("Vous ne pouvez pas vous appeler vous-même.");
    return;
  }

  // 1. Réinitialiser proprement toute ancienne connexion subsistante
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  pendingCandidates = [];
  pendingOffer = null;

  // 2. Définir l'ID du destinataire
  targetUserId = targetId;
  updateStatus("Préparation de l'appel...");

  try {
    await initMediaAndPeer();

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    const sent = sendSignal({
      type: "call-user",
      targetId: targetUserId,
      offer: offer,
    });

    if (!sent) {
      throw new Error("Impossible d'envoyer le signal au serveur.");
    }

    updateStatus("Appel en cours...");

    const callButton = document.getElementById("btn-call");
    if (callButton) callButton.disabled = true;

    const hangupButton = document.getElementById("btn-hangup");
    if (hangupButton) hangupButton.disabled = false;

    if (interfaceSender) {
      interfaceSender.classList.add("active");
    }
  } catch (error) {
    console.error("❌ Erreur lors du lancement de l'appel :", error);
    hangUp(false);
  }
}
// async function makeCall() {
//   if (!ws || ws.readyState !== WebSocket.OPEN) {
//     alert("Vous n'êtes pas connecté au serveur.");
//     return;
//   }

//   const input = document.getElementById("target-id-input");
//   if (!input) {
//     alert("Champ ID cible introuvable.");
//     return;
//   }

//   const targetId = input.value.trim();
//   if (!targetId) {
//     alert("Saisissez un ID cible.");
//     return;
//   }

//   if (targetId === myId) {
//     alert("Vous ne pouvez pas vous appeler.");
//     return;
//   }

//   targetUserId = targetId;
//   updateStatus("Préparation de l'appel...");

//     // Nettoyer toute ancienne connexion qui traînerait
//     if (peerConnection) {
//         peerConnection.close();
//         peerConnection = null;
//     }
  
//    pendingCandidates = [];
//    pendingOffer = null;

//   try {
//     await initMediaAndPeer();

//     const offer = await peerConnection.createOffer();
//     await peerConnection.setLocalDescription(offer);

//     const sent = sendSignal({
//       type: "call-user",
//       targetId: targetUserId,
//       offer: offer,
//     });

//     if (!sent) {
//       throw new Error("Impossible d'envoyer l'appel.");
//     }

//     updateStatus("Appel en cours...");

//     const callButton = document.getElementById("btn-call");
//     if (callButton) callButton.disabled = true;

//     const hangupButton = document.getElementById("btn-hangup");
//     if (hangupButton) hangupButton.disabled = false;

//     if (interfaceSender) {
//       interfaceSender.classList.add("active");
//     }
//   } catch (error) {
//     console.error("❌ Erreur appel :", error);
//     alert("Impossible de lancer l'appel : " + error.message);
//     hangUp(false);
//   }
// }

/* =========================================================
   INITIALISATION WEBRTC
========================================================= */

async function initMediaAndPeer() {
  console.log("🎤 Initialisation microphone...");

  localStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: false,
  });

  console.log("✅ Microphone obtenu");

  peerConnection = new RTCPeerConnection(rtcConfig);

  localStream.getTracks().forEach(function (track) {
    peerConnection.addTrack(track, localStream);
  });

  peerConnection.onicecandidate = function (event) {
    if (event.candidate && targetUserId) {
      sendSignal({
        type: "ice-candidate",
        targetId: targetUserId,
        candidate: event.candidate,
      });
    }
  };

  peerConnection.ontrack = function (event) {
    console.log("🔊 Flux distant reçu :", event.streams[0]);

    const remoteAudio =
      document.getElementById("remoteAudio") ||
      document.getElementById("remote-audio");

    if (remoteAudio) {
      remoteAudio.srcObject = event.streams[0];
      remoteAudio.volume = 1.0;

      const playPromise = remoteAudio.play();
      if (playPromise !== undefined) {
        playPromise.catch(function (error) {
          console.warn("Autoplay bloqué, ajout d'une interaction :", error);
        });
      }
    }
  };

  /*
   * GESTION DU RECOUVREMENT DE CONNEXION (RESTART ICE)
   */
  peerConnection.onconnectionstatechange = function () {
    console.log("🔗 WebRTC state :", peerConnection.connectionState);
    console.log("🔗 WebRTC state :", peerConnection.iceConnectionState);


    const state = peerConnection.connectionState;

    if ((state === "failed" || state === "disconnected") && !isRestartingIce) {
      console.warn("⚠️ Perte de connexion réseau. Tentative de reconnexion WebRTC (Restart ICE)...");
      restartIceSession();
    }

    switch (state) {
      case "connected":
        isRestartingIce = false;
        updateStatus("Appel connecté");
        break;

      case "disconnected":
        updateStatus("Réseau instable - Reconnexion...");
        break;

      case "failed":
        updateStatus("Échec réseau - Tentative de relance...");
        break;

      case "closed":
        updateStatus("Appel terminé");
        break;

      default:
        updateStatus("Statut de connexion : " + state);
    }
  };
}

/* =========================================================
   REDÉMARRAGE DE LA SESSION ICE EN CAS DE COUPURE
========================================================= */

async function restartIceSession() {
  if (!peerConnection || !targetUserId) return;

  try {
    isRestartingIce = true;
    console.log("🔄 Lancement de restartIce()...");

     // 1. Demande native au navigateur de relancer la recherche de routes réseau
    peerConnection.restartIce();

    // 2. Création d'une nouvelle offre ICE
    const offer = await peerConnection.createOffer({ iceRestart: true });
    await peerConnection.setLocalDescription(offer);

    // 3. Transmission de la nouvelle offre au distant
    sendSignal({
      type: "restart-offer", // Ou "restart-offer" selon la prise en compte du serveur
      targetId: targetUserId,
      offer: offer,
      isRestart: true
    });

    if (!sent) {
      console.warn("⚠️ Impossible d'envoyer le signal de relance ICE (WebSocket hors ligne).");
      isRestartingIce = false;
    }

  } catch (error) {
    console.error("❌ Échec de la relance ICE :", error);
    isRestartingIce = false;
  }
}

/* =========================================================
   TRAITEMENT DE LA RENÉGOCIATION PAR LE DESTINATAIRE
========================================================= */

async function handleRestartOffer(data) {
  if (!peerConnection) return;

  try {
    console.log("🔄 Offre de reconnexion reçue, traitement...");
    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
    await processPendingCandidates();

    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    sendSignal({
      type: "answer-call",
      targetId: targetUserId,
      answer: answer
    });
  } catch (e) {
    console.error("❌ Erreur traitement de l'offre de reconnexion :", e);
  }
}

/* =========================================================
   APPEL ENTRANT
========================================================= */

function handleIncomingCall(data) {
  console.log("📞 Appel entrant :", data);

  // Nettoyage préventif
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  pendingCandidates = [];

  targetUserId = data.from || data.userId || data.callerId;
  pendingOffer = data.offer;

  updateStatus("Appel entrant...");

  if (interfaceReceiver) {
    interfaceReceiver.classList.add("active");
  }
}

// function handleIncomingCall(data) {
//   console.log("📞 Appel entrant :", data);

//   targetUserId = data.from || data.userId || data.callerId;
//   pendingOffer = data.offer;

//   updateStatus("Appel entrant...");

//   if (interfaceReceiver) {
//     interfaceReceiver.classList.add("active");
//   }
// }

/* =========================================================
   ACCEPTER UN APPEL
========================================================= */

async function acceptCall() {
  if (!pendingOffer) return alert("Aucun appel en attente.");

  try {
    updateStatus("Connexion à l'appel...");

    if (!targetUserId && pendingOffer.callerId) {
      targetUserId = pendingOffer.callerId;
    }

    await initMediaAndPeer();

    await peerConnection.setRemoteDescription(
      new RTCSessionDescription(pendingOffer)
    );

    await processPendingCandidates();

    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    sendSignal({
      type: "answer-call",
      targetId: targetUserId,
      answer: answer,
    });
    startTimer();

    if (interfaceReceiver) {
      interfaceReceiver.classList.remove("active");
    }

    if (interfaceSender) {
      interfaceSender.classList.add("active");
    }

    pendingOffer = null;
    updateStatus("Appel connecté...");
  } catch (error) {
    console.error("Erreur acceptation :", error);
    hangUp(false);
  }
}

/* =========================================================
   REFUSER UN APPEL
========================================================= */

function rejectCall() {
  console.log("📵 Appel refusé");

  if (interfaceReceiver) {
    interfaceReceiver.classList.remove("active");
  }

  if (targetUserId) {
    sendSignal({
      type: "call-refused",
      targetId: targetUserId,
    });
  }

  pendingOffer = null;
  targetUserId = null;
  updateStatus("En ligne");
}

/* =========================================================
   APPEL ACCEPTÉ PAR LE DESTINATAIRE
========================================================= */

async function handleCallAnswered(data) {
  console.log("📞 Appel accepté :", data);

  try {
    if (!peerConnection) {
      console.error("PeerConnection inexistante.");
      return;
    }

    await peerConnection.setRemoteDescription(
      new RTCSessionDescription(data.answer)
    );

    await processPendingCandidates();
    updateStatus("Appel connecté...");
  } catch (error) {
    console.error("❌ Erreur réponse WebRTC :", error);
  }
}

/* =========================================================
   ICE CANDIDATE
========================================================= */

async function handleNewICECandidate(data) {
  console.log("🧊 ICE candidate reçu");

  if (!data.candidate) return;

  if (!peerConnection || !peerConnection.remoteDescription) {
    console.log("⏳ Connection WebRTC non prête. Candidat stocké en attente.");
    pendingCandidates.push(data.candidate);
    return;
  }

  try {
    await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
    console.log("✅ ICE candidate ajouté");
  } catch (error) {
    console.error("❌ Erreur ICE :", error);
  }
}

async function processPendingCandidates() {
  if (pendingCandidates.length > 0) {
    console.log(`🧊 Traitement de ${pendingCandidates.length} candidats ICE en attente...`);
    for (const candidate of pendingCandidates) {
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        console.log("✅ Candidat ICE en attente appliqué avec succès");
      } catch (error) {
        console.error("❌ Erreur d'application du candidat ICE :", error);
      }
    }
    pendingCandidates = [];
  }
}

/* =========================================================
   RACCROCHER
========================================================= */

function hangUp(sendSignalToPeer = true) {
  console.log("📴 Fin de l'appel");

  // Si on est à l'origine du raccrochage, on prévient le correspondant distant
  if (sendSignalToPeer && targetUserId) {
    sendSignal({
      type: "call-end",
      targetId: targetUserId,
    });
  }

  if (localStream) {
    localStream.getTracks().forEach(function (track) {
      track.stop();
    });
    localStream = null;
  }

  if (peerConnection) {
    try {
      peerConnection.close();
    } catch (error) {
      console.warn("Erreur fermeture PeerConnection :", error);
    }
    peerConnection = null;
  }

  stopTimer();

  pendingOffer = null;
  targetUserId = null;
  pendingCandidates = [];
  isRestartingIce = false;

  const callButton = document.getElementById("btn-call");
  if (callButton) callButton.disabled = false;

  const hangupButton = document.getElementById("btn-hangup");
  if (hangupButton) hangupButton.disabled = true;

  closeInterface();
  updateStatus("En ligne");
}

/* =========================================================
   FERMER PROPREMENT LA CONNEXION
========================================================= */

function disconnectWebSocket() {
  manuallyClosed = true;

  clearTimeout(reconnectTimer);

  if (ws) {
    try {
      ws.close();
      alert("⚠️ WebSocket fermé.");
    } catch (error) {
      console.warn(error);
    }
    ws = null;
  }

  updateStatus("Hors ligne");
}

/* =========================================================
   GESTION DU MINUTEUR
========================================================= */

function startTimer() {
  let secondes = 0;
  if (interval) return;

  interval = setInterval(() => {
    secondes++;
    const heures = Math.floor(secondes / 3600);
    const minutes = Math.floor((secondes % 3600) / 60);
    const secs = secondes % 60;

    const temps =
      String(heures).padStart(2, "0") + ":" +
      String(minutes).padStart(2, "0") + ":" +
      String(secs).padStart(2, "0");

    const timerElement = document.getElementById("timer");
    if (timerElement) {
      timerElement.textContent = temps;
    }
  }, 1000);
}

function stopTimer() {
  clearInterval(interval);
  interval = null;
  const timerElement = document.getElementById("timer");
  if (timerElement) {
    timerElement.textContent = "00:00:00";
  }
}

/* =========================================================
   FERMER LES INTERFACES
========================================================= */

function closeInterface() {
  if (interfaceReceiver && interfaceReceiver.classList.contains("active")) {
    interfaceReceiver.classList.remove("active");
  }

  if (interfaceSender && interfaceSender.classList.contains("active")) {
    interfaceSender.classList.remove("active");
  }
}

/* =========================================================
   COUPER / ACTIVER LE MICRO
========================================================= */

function toggleMicrophone() {
  if (!localStream) {
    console.warn("Aucun flux local trouvé pour couper le micro.");
    return;
  }

  const audioTrack = localStream.getAudioTracks()[0];
  if (!audioTrack) {
    console.warn("Aucune piste audio trouvée.");
    return;
  }

  isMuted = !isMuted;
  audioTrack.enabled = !isMuted;

  const micBtn = document.getElementById("btn-toggle-mic");
  const micIcon = document.getElementById("mic-icon");
  const micLabel = document.getElementById("mic-label");

  if (isMuted) {
    if (micIcon) micIcon.className = "fa-solid fa-microphone-slash";
    if (micLabel) micLabel.textContent = "Activer le micro";
    if (micBtn) micBtn.classList.add("active-mute");
  } else {
    if (micIcon) micIcon.className = "fa-solid fa-microphone";
    if (micLabel) micLabel.textContent = "Désactiver le micro";
    if (micBtn) micBtn.classList.remove("active-mute");
  }
}

/* =========================================================
   EXPOSER LES FONCTIONS AU HTML
========================================================= */

window.makeCall = makeCall;
window.acceptCall = acceptCall;
window.rejectCall = rejectCall;
window.hangUp = hangUp;
window.connectWebSocket = connectWebSocket;
window.disconnectWebSocket = disconnectWebSocket;
window.toggleMicrophone = toggleMicrophone;