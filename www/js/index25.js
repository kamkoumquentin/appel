document.addEventListener("deviceready", onDeviceReady, false);

// chat gpt
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

let reconnectTimer = null;
let manuallyClosed = false;

let isMuted = false;

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
    /*
     * 1. Demande de permission microphone
     */
    await requestMicrophonePermission();

    /*
     * 2. Génération / récupération de l'ID
     */
    initializeUserId();

    /*
     * 3. Affichage de l'ID
     */
    const idElement = document.getElementById("my-id-display");

    if (idElement) {
      idElement.innerText = myId;
    }

    /*
     * 4. Connexion au serveur
     */
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
        },
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
  /*
   * Empêcher plusieurs connexions simultanées
   */
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

  /*
   * Étape 1 :
   * Réveiller le serveur Render
   */
  try {
    console.log("⏳ Vérification du serveur Render...");

    const response = await fetch(HTTP_SERVER_URL, {
      method: "GET",
      cache: "no-cache",
    });

    console.log("🌐 Réponse HTTP :", response.status);
  } catch (error) {
    console.warn("⚠️ Le ping HTTP a échoué :", error);

    /*
     * On continue quand même.
     * Le serveur peut malgré tout accepter WebSocket.
     */
  }

  /*
   * Étape 2 :
   * Connexion WebSocket
   */
  createWebSocket();
}

/* =========================================================
   CRÉER LA WEBSOCKET
========================================================= */

function createWebSocket() {
  /*
   * Fermer une ancienne connexion
   */
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

  /* =====================================================
       WEBSOCKET OPEN
    ===================================================== */

  ws.onopen = function () {
    console.log("=================================");

    console.log("✅ WEBSOCKET CONNECTÉ");

    console.log("=================================");

    updateStatus("En ligne");

    /*
     * Enregistrer l'utilisateur
     */
    sendSignal({
      type: "register-user",
      userId: myId,
    });
  };

  /* =====================================================
       WEBSOCKET MESSAGE
    ===================================================== */

  ws.onmessage = function (event) {
    console.log("📩 Message serveur :", event.data);

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

        break;

      case "ice-candidate":
        handleNewICECandidate(data);

        break;

      case "call-refused":
        alert("L'appel a été refusé.");

        hangUp();

        break;

      default:
        console.log("ℹ️ Type de message inconnu :", data.type);
    }
  };

  /* =====================================================
       WEBSOCKET ERROR
    ===================================================== */

  ws.onerror = function (error) {
    console.error("=================================");
    console.error("❌ ERREUR WEBSOCKET");
    console.error(error);
    console.error("=================================");
    updateStatus("Erreur de connexion");
  };

  /* =====================================================
       WEBSOCKET CLOSE
    ===================================================== */

  ws.onclose = function (event) {
    console.warn("=================================");

    console.warn("⚠️ WEBSOCKET FERMÉ");

    console.warn("Code :", event.code);

    console.warn("Raison :", event.reason);

    console.warn("Fermeture normale :", event.wasClean);

    console.warn("=================================");

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

  //return;

  console.log(
    "🔄 Nouvelle tentative dans",
    RECONNECT_DELAY / 1000,
    "secondes...",
  );

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

  /*
   * Si ton HTML utilise un autre ID
   * tu peux ajouter ici :
   *
   * document.getElementById("connection-status")
   */
}

/* =========================================================
   LANCER UN APPEL
========================================================= */

async function makeCall() {
  /*
   * Vérifier WebSocket
   */
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    alert("Vous n'êtes pas connecté au serveur.");

    return;
  }

  /*
   * Récupérer ID cible
   */
  const input = document.getElementById("target-id-input");

  if (!input) {
    alert("Champ ID cible introuvable.");

    return;
  }

  const targetId = input.value.trim();

  if (!targetId) {
    alert("Saisissez un ID cible.");

    return;
  }

  if (targetId === myId) {
    alert("Vous ne pouvez pas vous appeler.");

    return;
  }

  targetUserId = targetId;

  updateStatus("Préparation de l'appel...");

  try {
    /*
     * Initialiser microphone + WebRTC
     */
    await initMediaAndPeer();

    /*
     * Créer l'offre
     */
    const offer = await peerConnection.createOffer();

    /*
     * Enregistrer l'offre localement
     */
    await peerConnection.setLocalDescription(offer);

    /*
     * Envoyer au serveur
     */
    const sent = sendSignal({
      type: "call-user",

      targetId: targetUserId,

      offer: offer,
    });

    if (!sent) {
      throw new Error("Impossible d'envoyer l'appel.");
    }

    updateStatus("Appel en cours...");

    /*
     * Désactiver bouton appel
     */
    const callButton = document.getElementById("btn-call");

    if (callButton) {
      callButton.disabled = true;
    }

    /*
     * Activer bouton raccrocher
     */
    const hangupButton = document.getElementById("btn-hangup");

    if (hangupButton) {
      hangupButton.disabled = false;
    }

    if (interfaceReceiver) {
      //interfaceReceiver.classList.add("hidden");
      interfaceSender.classList.add("active");
    }
  } catch (error) {
    console.error("❌ Erreur appel :", error);

    alert("Impossible de lancer l'appel : " + error.message);

    hangUp();
  }
}

/* =========================================================
   INITIALISATION WEBRTC
========================================================= */

async function initMediaAndPeer() {
  console.log("🎤 Initialisation microphone...");

  /*
   * Obtenir le microphone
   */
  localStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: false,
  });

  console.log("✅ Microphone obtenu");

  /*
   * Créer PeerConnection
   */
  peerConnection = new RTCPeerConnection(rtcConfig);

  /*
   * Ajouter les pistes audio
   */
  localStream.getTracks().forEach(function (track) {
    peerConnection.addTrack(track, localStream);
  });

  /*
   * ICE candidate
   */
  peerConnection.onicecandidate = function (event) {
    if (event.candidate && targetUserId) {
      sendSignal({
        type: "ice-candidate",

        targetId: targetUserId,

        candidate: event.candidate,
      });
    }
  };

  /*
   * Réception du flux distant
   */

  peerConnection.ontrack = function (event) {
    console.log("🔊 Flux distant reçu :", event.streams[0]);

    const remoteAudio =
      document.getElementById("remoteAudio") ||
      document.getElementById("remote-audio");

    if (remoteAudio) {
      remoteAudio.srcObject = event.streams[0];

      // Unmute et force le volume au maximum
      remoteAudio.volume = 1.0;

      // Tentative de lecture forcée avec promesse
      const playPromise = remoteAudio.play();
      if (playPromise !== undefined) {
        playPromise.catch(function (error) {
          console.warn("Autoplay bloqué, ajout d'une interaction :", error);
        });
      }
    }
  };

  /*
   * État de connexion
   */
  peerConnection.onconnectionstatechange = function () {
    console.log("🔗 WebRTC :", peerConnection.connectionState);

    switch (peerConnection.connectionState) {
      case "connected":
        updateStatus("Appel connecté");

        break;

      case "disconnected":
        updateStatus("Appel déconnecté");

        break;

      case "failed":
        updateStatus("Échec de l'appel");

        break;

      case "closed":
        updateStatus("Appel terminé");

        break;
      default:
        updateStatus(
          "Status de connectioon non defini : " +
            peerConnection.connectionState,
        );
    }
  };
}

/* =========================================================
   APPEL ENTRANT
========================================================= */

function handleIncomingCall(data) {
  console.log("📞 Appel entrant :", data);

  targetUserId = data.from || data.userId || data.callerId;

  pendingOffer = data.offer;

  updateStatus("Appel entrant...");

  /*
   * Afficher le modal
   */
  //const modal = document.getElementById("incoming-modal");

  if (interfaceReceiver) {
    interfaceReceiver.classList.add("active");
  }
}

/* =========================================================
   ACCEPTER UN APPEL
========================================================= */

async function acceptCall() {
  if (!pendingOffer) return alert("Aucun appel en attente.");

  try {
    updateStatus("Connexion à l'appel...");

    // Assurez-vous que l'ID distant est bien fixé avant initMediaAndPeer
    if (!targetUserId && pendingOffer.callerId) {
      targetUserId = pendingOffer.callerId;
    }

    await initMediaAndPeer();

    await peerConnection.setRemoteDescription(
      new RTCSessionDescription(pendingOffer),
    );

    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    sendSignal({
      type: "answer-call",
      targetId: targetUserId,
      answer: answer,
    });

    const modal = document.getElementById("incoming-modal");

    if (modal) {
      modal.classList.add("hidden");
    }

    pendingOffer = null;

    updateStatus("Appel connecté...");
  } catch (error) {
    console.error("Erreur acceptation :", error);
    hangUp();
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
      new RTCSessionDescription(data.answer),
    );

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

  if (!peerConnection || !data.candidate) {
    return;
  }

  try {
    await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));

    console.log("✅ ICE candidate ajouté");
  } catch (error) {
    console.error("❌ Erreur ICE :", error);
  }
}

/* =========================================================
   RACCROCHER
========================================================= */

function hangUp() {
  console.log("📴 Fin de l'appel");

  /*
   * Arrêter microphone
   */
  if (localStream) {
    localStream.getTracks().forEach(function (track) {
      track.stop();
    });

    localStream = null;
  }

  /*
   * Fermer PeerConnection
   */
  if (peerConnection) {
    try {
      peerConnection.close();
    } catch (error) {
      console.warn("Erreur fermeture PeerConnection :", error);
    }

    peerConnection = null;
  }

  /*
   * Réinitialiser
   */
  pendingOffer = null;

  targetUserId = null;

  /*
   * Réactiver bouton appel
   */
  const callButton = document.getElementById("btn-call");

  if (callButton) {
    callButton.disabled = false;
  }

  /*
   * Désactiver bouton raccrocher
   */
  const hangupButton = document.getElementById("btn-hangup");

  if (hangupButton) {
    hangupButton.disabled = true;
  }

  // fermer les interface si elles sont ouvertes
  closeInterface();

  updateStatus("En ligne");
}

/* =========================================================
   FERMER PROPREMENT LA CONNEXION
========================================================= */

function disconnectWebSocket() {
  manuallyClosed = true;

  clearTimeout(reconnectTimer);
  if (
    ws &&
    (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
  ) {
    alert("⚠️ Une connexion existe.");
  }

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
   Ferme les interface 1 & 2
========================================================= */
function closeInterface() {
  if (interfaceReceiver.classList.contains("active")) {
    interfaceReceiver.classList.remove("active");
  }

  if (interfaceSender.classList.contains("active")) {
    interfaceSender.classList.remove("active");
  }
}

/* =========================================================
   Couper le micro
========================================================= */

// function toggleMicrophone() {
//   if (!localStream) {
//     console.warn("Aucun flux local trouvé pour couper le micro.");
//     return;
//   }

//   const audioTrack = localStream.getAudioTracks()[0];
//   if (!audioTrack) {
//     console.warn("Aucune piste audio trouvée.");
//     return;
//   }

//   // Bascule l'état de la piste audio
//   isMuted = !isMuted;
//   audioTrack.enabled = !isMuted;

//   // Mise à jour visuelle du bouton
//   const micBtn = document.getElementById("btn-toggle-mic");
//   const micIcon = document.getElementById("mic-icon");
//   const micLabel = document.getElementById("mic-label");

//   if (isMuted) {
//     micIcon.className = "fa-solid fa-microphone-slash";
//     micLabel.textContent = "Activer le micro";
//     if (micBtn) micBtn.classList.add("active-mute"); // Style CSS optionnel
//   } else {
//     micIcon.className = "fa-solid fa-microphone";
//     micLabel.textContent = "Désactiver le micro";
//     if (micBtn) micBtn.classList.remove("active-mute");
//   }
// }

/* =========================================================
   EXPOSER LES FONCTIONS AU HTML
========================================================= */

window.makeCall = makeCall;

window.acceptCall = acceptCall;

window.rejectCall = rejectCall;

window.hangUp = hangUp;

window.connectWebSocket = connectWebSocket;
