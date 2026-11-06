document.addEventListener("deviceready", onDeviceReady, false);
document.addEventListener("resume", onAppResume, false);

/* =========================================================
   CONFIGURATION
========================================================= */

const SIGNALING_SERVER_URL = "wss://serveur-appel.onrender.com";
const HTTP_SERVER_URL = "https://serveur-appel.onrender.com";

const RECONNECT_DELAY = 5000;

let myId = null;
let ws = null;
let signalQueue = []; // File d'attente pour les messages envoyés avant que la WebSocket soit prête

// NOUVEAU TOKEN
let myFcmToken = localStorage.getItem("app_fcm_token") || null;

let peerConnection = null;
let localStream = null;
let pendingIceCandidates = [];
let isMuted = false;

let targetUserId = null;
let pendingOffer = null;
let autoAcceptPendingCall = false; // Vrai si l'utilisateur a cliqué sur 'Accepter' depuis la notification

let reconnectTimer = null;
let manuallyClosed = false;

/* =========================================================
   GESTION DU CYCLE DE VIE (RESUME)
========================================================= */

function onAppResume() {
    console.log("📱 Application reprise depuis l'arrière-plan (RESUME)");
    // Si la WebSocket est fermée ou en erreur, reconnecter immédiatement
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.log("🔄 Reconnexion WebSocket immédiate suite à la reprise...");
        connectWebSocket();
    }
}

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

    // INITIALISATION DU FIREBASE COTE CLIENT
    if (typeof PushNotification !== "undefined") {
        // Initialisation du plugin Push
        const push = PushNotification.init({
            android: {
                sound: "true",
                vibrate: "true",
                clearBadge: "true",
                importance: 4
            },
            ios: {
                alert: "true",
                badge: "true",
                sound: "true"
            }
        });

        // Création du canal de notification (Android 8+)
        if (push.createChannel) {
            push.createChannel(
                function () { console.log("✅ Canal de notification 'default' configuré."); },
                function (e) { console.error("❌ Erreur configuration canal push :", e); },
                {
                    id: "default",
                    description: "Canal des appels entrants",
                    importance: 4,
                    vibration: true,
                    sound: "default"
                }
            );
        }

        // Écouteur pour récupérer le Token de l'appareil
        push.on('registration', function (data) {
            console.log("📲 DEVICE TOKEN FCM OBTENU :", data.registrationId);
            myFcmToken = data.registrationId;
            localStorage.setItem("app_fcm_token", data.registrationId);

            // Si la WebSocket est déjà connectée, envoyer immédiatement le token au serveur
            if (ws && ws.readyState === WebSocket.OPEN && myId) {
                console.log("📤 Envoi de la mise à jour du token FCM au serveur...");
                sendSignal({
                    type: "REGISTER",
                    id: myId,
                    fcmToken: myFcmToken
                });
            }
        });

        // Écouteur quand une notification est reçue
        push.on('notification', function (data) {
            console.log("🔔 Notification push reçue :", data.message, data);

            // S'assurer immédiatement que la WebSocket est connectée ou en cours de connexion
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                connectWebSocket();
            }

            const additionalData = data.additionalData || {};
            const caller = additionalData.appelant || additionalData.from || additionalData.callerId;

            if (additionalData.type === "APPEL" || caller) {
                if (caller) {
                    targetUserId = caller;
                }
                if (additionalData.offer) {
                    try {
                        pendingOffer = typeof additionalData.offer === "string" ? JSON.parse(additionalData.offer) : additionalData.offer;
                    } catch (e) {
                        pendingOffer = additionalData.offer;
                    }
                }

                // Gestion des boutons d'action de la notification (Accepter / Refuser)
                const actionCallback = additionalData.actionCallback;
                if (actionCallback === "acceptCallAction") {
                    console.log("📞 Action 'Accepter' déclenchée depuis la notification !");
                    if (pendingOffer) {
                        acceptCall();
                    } else {
                        autoAcceptPendingCall = true;
                    }
                } else if (actionCallback === "rejectCallAction") {
                    console.log("📵 Action 'Refuser' déclenchée depuis la notification !");
                    rejectCall();
                } else {
                    // Afficher l'interface de réception d'appel
                    const incomingInterface = document.getElementById("interface-2");
                    if (incomingInterface) {
                        incomingInterface.classList.add("active");
                    }
                    updateStatus("Appel entrant...");
                }
            }

            push.finish(function () {
                console.log('Traitement notification terminé');
            });
        });

        // Écouteur en cas d'erreur
        push.on('error', function (e) {
            console.error("❌ Erreur Push Notification :", e.message);
        });
    } else {
        console.warn("⚠️ Plugin PushNotification non disponible dans cet environnement.");
    }

    try {
        /*
         * 1. Demande de permission microphone, bluetooth et notifications
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
   PERMISSION MICROPHONE ET NOTIFICATIONS
========================================================= */

function requestMicrophonePermission() {
    return new Promise((resolve, reject) => {
        if (window.cordova && cordova.plugins && cordova.plugins.permissions) {
            const permissions = cordova.plugins.permissions;
            const neededPermissions = [permissions.RECORD_AUDIO];

            if (permissions.BLUETOOTH_CONNECT) {
                neededPermissions.push(permissions.BLUETOOTH_CONNECT);
            } else {
                neededPermissions.push("android.permission.BLUETOOTH_CONNECT");
            }

            // Permission pour les notifications push sur Android 13+ (API 33+)
            if (permissions.POST_NOTIFICATIONS) {
                neededPermissions.push(permissions.POST_NOTIFICATIONS);
            } else {
                neededPermissions.push("android.permission.POST_NOTIFICATIONS");
            }

            permissions.requestPermissions(
                neededPermissions,
                function (status) {
                    console.log("🎤 Permissions microphone, bluetooth et notifications :", status);
                    resolve();
                },
                function (error) {
                    console.error("❌ Erreur permissions :", error);
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
            type: "REGISTER",      // <-- Modifié pour correspondre à votre serveur
            id: myId,              // <-- Modifié pour correspondre à votre serveur
            fcmToken: myFcmToken   // <-- On envoie le vrai token dynamiquement
        });

        /* sendSignal({
           type: "register-user",
           userId: myId,
         });*/




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

        data = data.data || data.payload || data;
        console.log("📦 Données reçues :", data);

        switch (data.type) {
            case "incoming-call":
            case "call-incoming":
            case "incoming_call":
            case "CALLING":
                handleIncomingCall(data);
                break;

            case "call-answered":
            case "CALL_ACCEPTED":
                handleCallAnswered(data);
                break;

            case "ice-candidate":
            case "ICE_CANDIDATE":
                handleNewICECandidate(data);
                break;

            case "call-refused":
            case "CALL_REJECTED":
                alert("L'appel a été refusé.");
                hangUp(true);
                break;

            case "hang-up":
            case "CALL_ENDED":
                alert("L'autre participant a raccroché.");
                hangUp(true);
                break;

            case "BUSY":
            case "busy":
                alert(data.message || "Le correspondant est actuellement en appel.");
                hangUp(true);
                break;

            case "ERROR":
            case "error":
                console.error("❌ Erreur serveur :", data.message);
                alert(data.message || "Erreur de communication.");
                hangUp(true);
                break;

            case "REGISTERED":
            case "registered":
                console.log("✅ Enregistrement confirmé pour l'ID :", data.id);
                updateStatus("En ligne");
                flushSignalQueue();
                break;

            case "PONG":
            case "pong":
                break;

            default:
                console.warn("ℹ️ Type de message WebSocket inconnu :", data.type, data);
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
   ENVOYER UN MESSAGE ET VIDAGE DE FILE D'ATTENTE
========================================================= */

function sendSignal(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        console.log("📤 Envoi :", data);
        ws.send(JSON.stringify(data));
        return true;
    } else {
        console.warn("⚠️ WebSocket non connectée. Signal mis en file d'attente :", data.type);
        // On ne stocke pas les doublons identiques dans la file d'attente
        signalQueue.push(data);

        // Déclencher la connexion si elle est coupée
        if (!ws || ws.readyState === WebSocket.CLOSED) {
            connectWebSocket();
        }
        return false;
    }
}

function flushSignalQueue() {
    if (signalQueue.length > 0 && ws && ws.readyState === WebSocket.OPEN) {
        console.log(`📤 Vidage de la file d'attente (${signalQueue.length} signaux)...`);
        const queue = [...signalQueue];
        signalQueue = [];
        queue.forEach(function (data) {
            sendSignal(data);
        });
    }
}

/* =========================================================
   STATUT
========================================================= */

function updateStatus(message) {
    console.log("📡 STATUT :", message);

    const statusElements = document.querySelectorAll(".status-bar, #status");
    statusElements.forEach(function (statusElement) {
        statusElement.innerText = message;
    });
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

        const senderInterface = document.getElementById("interface-1");
        if (senderInterface) {
            senderInterface.classList.add("active");
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
     * Synchroniser l'état audio / Bluetooth
     */
    syncBluetoothState();

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
            remoteAudio.autoplay = true;
            remoteAudio.muted = false;
            remoteAudio.setAttribute("playsinline", "");

            remoteAudio.volume = 1.0;

            const playRemoteAudio = function () {
                remoteAudio.play().catch(function (error) {
                    console.warn("Lecture du flux distant impossible :", error);
                    updateStatus("Appel connecté, lecture audio bloquée");
                });
            };

            remoteAudio.addEventListener("loadedmetadata", playRemoteAudio, {
                once: true,
            });
            playRemoteAudio();
        }
    };

    //   peerConnection.ontrack = function (event) {
    //     console.log("🔊 Flux distant reçu");

    //     const remoteAudio = document.getElementById("remoteAudio");

    //     if (remoteAudio) {
    //       remoteAudio.srcObject = event.streams[0];

    //       remoteAudio.play().catch(function (error) {
    //         console.warn("Lecture audio bloquée :", error);
    //       });
    //     }
    //   };

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

    const offer = data.offer || data.sdp || data.description;
    const callerId = data.from || data.userId || data.callerId || data.senderId;

    if (!offer || !callerId) {
        console.error("❌ Appel entrant incomplet : offre ou expéditeur manquant.", data);
        updateStatus("Appel entrant invalide");
        return;
    }

    targetUserId = callerId;
    pendingOffer = offer;

    if (autoAcceptPendingCall) {
        autoAcceptPendingCall = false;
        console.log("🚀 Décrochage automatique de l'appel suite au clic 'Accepter' sur la notification...");
        acceptCall();
        return;
    }

    updateStatus("Appel entrant...");

    const incomingInterface = document.getElementById("interface-2");

    if (incomingInterface) {
        incomingInterface.classList.add("active");
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

        await setRemoteDescriptionAndFlushCandidates(pendingOffer);

        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);

        sendSignal({
            type: "answer-call",
            targetId: targetUserId,
            answer: answer,
        });

        const incomingInterface = document.getElementById("interface-2");

        if (incomingInterface) {
            incomingInterface.classList.remove("active");
        }

        const senderInterface = document.getElementById("interface-1");
        if (senderInterface) {
            senderInterface.classList.add("active");
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

    const incomingInterface = document.getElementById("interface-2");

    if (incomingInterface) {
        incomingInterface.classList.remove("active");
    }

    const senderInterface = document.getElementById("interface-1");
    if (senderInterface) {
        senderInterface.classList.remove("active");
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

        await setRemoteDescriptionAndFlushCandidates(data.answer);

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

    if (!data.candidate) {
        return;
    }

    if (!peerConnection || !peerConnection.remoteDescription) {
        pendingIceCandidates.push(data.candidate);
        return;
    }

    try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));

        console.log("✅ ICE candidate ajouté");
    } catch (error) {
        console.error("❌ Erreur ICE :", error);
    }
}

async function setRemoteDescriptionAndFlushCandidates(description) {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(description));

    const candidates = pendingIceCandidates;
    pendingIceCandidates = [];

    for (const candidate of candidates) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    }
}

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

    const micIcon = document.getElementById("mic-icon");
    const micLabel = document.getElementById("mic-label");

    if (micIcon) {
        micIcon.className = isMuted
            ? "fa-solid fa-microphone-slash"
            : "fa-solid fa-microphone";
    }

    if (micLabel) {
        micLabel.textContent = isMuted
            ? "Activer le micro"
            : "Désactiver le micro";
    }
}

/* =========================================================
   RACCROCHER
========================================================= */

function hangUp(fromRemote = false) {
    console.log("📴 Fin de l'appel");

    if (!fromRemote && targetUserId) {
        sendSignal({
            type: "hang-up",
            targetId: targetUserId
        });
    }

    // Vider la file d'attente des signaux
    signalQueue = [];

    /*
     * Arrêter microphone
     */
    if (localStream) {
        localStream.getTracks().forEach(function (track) {
            track.stop();
        });

        localStream = null;
    }

    pendingIceCandidates = [];
    isMuted = false;

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
    autoAcceptPendingCall = false;

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

    /*
     * Masquer modal
     */
    const incomingInterface = document.getElementById("interface-2");

    if (incomingInterface) {
        incomingInterface.classList.remove("active");
    }

    const senderInterface = document.getElementById("interface-1");
    if (senderInterface) {
        senderInterface.classList.remove("active");
    }

    /*
     * Réinitialiser le mode audio
     */
    currentAudioMode = "speaker";
    updateAudioButtonUI("speaker");
    if (window.AudioToggle && typeof window.AudioToggle.setAudioMode === "function") {
        try {
            window.AudioToggle.setAudioMode("normal");
        } catch (e) { }
    }

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
   EXPOSER LES FONCTIONS AU HTML
========================================================= */

window.makeCall = makeCall;

window.acceptCall = acceptCall;

window.rejectCall = rejectCall;

window.hangUp = hangUp;

window.toggleMicrophone = toggleMicrophone;

window.connectWebSocket = connectWebSocket;

window.disconnectWebSocket = disconnectWebSocket;

function closeInterface() {
    const incomingInterface = document.getElementById("interface-2");
    if (incomingInterface) {
        incomingInterface.classList.remove("active");
    }

    const senderInterface = document.getElementById("interface-1");
    if (senderInterface) {
        senderInterface.classList.remove("active");
    }
}

window.closeInterface = closeInterface;

function copyMyId() {
    if (!myId) return;
    if (navigator.clipboard) {
        navigator.clipboard.writeText(myId).then(() => {
            alert("ID copié !");
        }).catch(err => {
            console.error("Erreur de copie :", err);
        });
    } else {
        const textArea = document.createElement("textarea");
        textArea.value = myId;
        document.body.appendChild(textArea);
        textArea.select();
        try {
            document.execCommand('copy');
            alert("ID copié !");
        } catch (err) {
            console.error("Erreur de copie :", err);
        }
        document.body.removeChild(textArea);
    }
}

window.copyMyId = copyMyId;













// --- GESTION DU SWITCH MICROPHONE/HAUT-PARLEUR (LOGIQUE PURE JS) ---

let currentAudioMode = "speaker";

// 1. Synchronisation automatique de l'état Bluetooth
function syncBluetoothState() {
    if (window.AudioToggle && typeof window.AudioToggle.isBluetoothConnected === "function") {
        window.AudioToggle.isBluetoothConnected(
            function (connected) {
                console.log("🔍 Détection Bluetooth automatique :", connected ? "Actif/Connecté" : "Inactif");
                if (connected) {
                    applyAudioMode("bluetooth");
                } else {
                    applyAudioMode("speaker");
                }
            },
            function (err) {
                console.warn("⚠️ Impossible de vérifier le Bluetooth :", err);
            }
        );
    }
}

// 2. Écouteur d'événements Bluetooth en temps réel (connexion/déconnexion pendant l'appel)
window.addEventListener("bluetoothAudioChanged", function (event) {
    const isConnected = event.detail && event.detail.connected;
    console.log("🎧 Événement Bluetooth temps réel reçu :", isConnected ? "Connecté" : "Déconnecté");

    if (isConnected) {
        applyAudioMode("bluetooth");
    } else {
        if (currentAudioMode === "bluetooth") {
            applyAudioMode("speaker");
        }
    }
});

// 3. Application du mode audio
function applyAudioMode(mode) {
    currentAudioMode = mode;
    console.log("🔊 Bascule sortie audio vers :", mode);

    if (window.AudioToggle && typeof window.AudioToggle.setAudioMode === "function") {
        try {
            window.AudioToggle.setAudioMode(
                mode,
                function () {
                    console.log("✅ Sortie audio configurée :", mode);
                },
                function (err) {
                    console.warn("⚠️ AudioToggle notification :", err);
                }
            );
        } catch (err) {
            console.warn("⚠️ Erreur AudioToggle :", err);
        }
    }

    updateAudioButtonUI(mode);
}

// 4. Mise à jour de l'apparence du bouton
function updateAudioButtonUI(mode) {
    const audioIcon = document.getElementById("audio-icon");
    const audioLabel = document.getElementById("audio-label");
    const audioBtn = document.getElementById("btn-toggle-audio");

    if (!audioBtn) return;
    audioBtn.style.backgroundColor = "";

    const isBluetooth = (mode === "bluetooth");

    if (isBluetooth) {
        audioBtn.classList.add("active");
    } else {
        audioBtn.classList.remove("active");
    }

    if (audioIcon) audioIcon.className = "fa-brands fa-bluetooth-b";
    if (audioLabel) audioLabel.textContent = "Bluetooth";
}

// 5. Clic manuel de l'utilisateur
function toggleBluetooth() {
    console.log("🔘 Clic bouton Bluetooth (mode actuel :", currentAudioMode, ")");

    if (currentAudioMode === "bluetooth") {
        applyAudioMode("speaker");
    } else {
        applyAudioMode("bluetooth");
    }
}



// 7. Initialisation lors du démarrage d'un appel WebRTC
// Dans votre fonction initMediaAndPeer() ou makeCall() / acceptCall() :
syncBluetoothState();

// 8. Exposition globale
window.toggleBluetooth = toggleBluetooth;
window.syncBluetoothState = syncBluetoothState;
window.applyAudioMode = applyAudioMode;