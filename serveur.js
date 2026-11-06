const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// MODIFICATION RENDER : Utilisation du port dynamique
const PORT = process.env.PORT || 8080;

// ======================================================
// TOKENS & SESSIONS EN MEMOIRE & PERSISTANCE DISQUE
// ======================================================
const fcmTokens = new Map();
const TOKENS_CACHE_FILE = path.join(__dirname, "fcm_tokens_cache.json");

function chargerTokensFCM() {
    try {
        if (fs.existsSync(TOKENS_CACHE_FILE)) {
            const data = fs.readFileSync(TOKENS_CACHE_FILE, "utf-8");
            const parsed = JSON.parse(data);
            Object.entries(parsed).forEach(([id, token]) => {
                if (id && token) fcmTokens.set(String(id), String(token));
            });
            console.log(`💾 ${fcmTokens.size} tokens FCM chargés depuis le cache local (${TOKENS_CACHE_FILE})`);
        }
    } catch (e) {
        console.warn("⚠️ Impossible de charger fcm_tokens_cache.json :", e.message);
    }
}

function sauvegarderTokensFCM() {
    try {
        const obj = {};
        fcmTokens.forEach((token, id) => {
            obj[id] = token;
        });
        fs.writeFileSync(TOKENS_CACHE_FILE, JSON.stringify(obj, null, 2), "utf-8");
    } catch (e) {
        console.warn("⚠️ Impossible d'écrire dans fcm_tokens_cache.json :", e.message);
    }
}

chargerTokensFCM();

const utilisateurs = new Map();
const sessionTokens = new Map(); // identifiant -> jeton de session client
const userAppStates = new Map(); // identifiant -> isForeground (boolean)
const userScreenStates = new Map(); // identifiant -> "SCREEN_ON" | "SCREEN_OFF"
const appels = new Map();
const pendingOffers = new Map();
const MAX_PARTICIPANTS = 4;
const MAX_JOIN_ATTEMPTS_PER_CONNECTION = 10;
const ROOM_CODE_CHARACTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const rooms = new Map();
const roomCodes = new Map();

// MACHINE À ÉTATS SERVEUR & DÉDUPLICATION
// callSessions : callId -> { callId, from, to, state: "RINGING" | "ACCEPTING" | "CONNECTED" | "REJECTED" | "ENDED", offer, createdAt }
const callSessions = new Map();
// endedCalls : callId -> timestamp (TTL 60s pour empêcher le replay d'anciens appels)
const endedCalls = new Map();
// Seul agent IVR autorisé à recevoir une demande de conseiller (touche 1).
const IVR_AGENT_ID = "SERVICE-001";

function logCall(event, details = {}) {
    console.log(`[CALL] ${event} | callId=${details.callId || "n/a"} | from=${details.from || "n/a"} | to=${details.to || "n/a"} | state=${details.state || "n/a"} | info=${details.info || ""}`);
}

function normaliserHasVideo(value) {
    return value === true || value === "true";
}

function markCallEnded(callId) {
    if (!callId) return;
    endedCalls.set(String(callId), Date.now());
    const session = callSessions.get(String(callId));
    if (session) {
        session.state = "ENDED";
    }
}

function isCallEnded(callId) {
    if (!callId) return false;
    return endedCalls.has(String(callId));
}

// Nettoyage périodique (toutes les 30s) des appels terminés et sessions expirées (> 60s / 5min)
setInterval(() => {
    const now = Date.now();
    endedCalls.forEach((timestamp, callId) => {
        if (now - timestamp > 60000) {
            endedCalls.delete(callId);
        }
    });
    callSessions.forEach((session, callId) => {
        if (now - session.createdAt > 300000) { // 5 minutes max par session
            callSessions.delete(callId);
        }
    });
}, 30000);

// ======================================================
// INITIALISATION FIREBASE notification firebase
// ======================================================
const { initializeApp, cert } = require("firebase-admin/app");
const { getMessaging } = require("firebase-admin/messaging");
let messaging = null;

try {
    let serviceAccount = null;

    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        try {
            serviceAccount = typeof process.env.FIREBASE_SERVICE_ACCOUNT === "string"
                ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
                : process.env.FIREBASE_SERVICE_ACCOUNT;
            console.log("🔑 Clé Firebase chargée depuis FIREBASE_SERVICE_ACCOUNT");
        } catch (e) {
            console.error("❌ Erreur parsing FIREBASE_SERVICE_ACCOUNT JSON :", e.message);
        }
    } else if (process.env.FIREBASE_KEY) {
        try {
            serviceAccount = typeof process.env.FIREBASE_KEY === "string"
                ? JSON.parse(process.env.FIREBASE_KEY)
                : process.env.FIREBASE_KEY;
            console.log("🔑 Clé Firebase chargée depuis FIREBASE_KEY");
        } catch (e) {
            console.error("❌ Erreur parsing FIREBASE_KEY JSON :", e.message);
        }
    }

    if (!serviceAccount) {
        try {
            serviceAccount = require("./firebase-key.json");
            console.log("🔑 Clé Firebase chargée depuis firebase-key.json local");
        } catch (e) {
            try {
                serviceAccount = require("/etc/secrets/firebase-key.json");
                console.log("🔑 Clé Firebase chargée depuis /etc/secrets/firebase-key.json");
            } catch (e2) {
                console.warn("⚠️ Fichier firebase-key.json introuvable :", e.message);
            }
        }
    }

    if (serviceAccount) {
        // Important pour Render : transforme les \n échappés en vrais retours à la ligne
        if (serviceAccount.private_key && typeof serviceAccount.private_key === "string") {
            serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
        }

        initializeApp({
            credential: cert(serviceAccount)
        });

        messaging = getMessaging();
        console.log("✅ Firebase Admin initialisé avec succès !");
        console.log("🔥 Projet Firebase :", serviceAccount.project_id);
    } else {
        console.warn("⚠️ Aucune clé de service Firebase trouvée. Les notifications push FCM seront désactivées.");
    }
} catch (err) {
    console.error("❌ Impossible d'initialiser Firebase Admin :", err.message);
}

// =============================================================================
// FONCTIONS DE NOTIFICATION PUSH DÉDIÉES (TEST 1 vs TEST 2)
// =============================================================================

function gererErreurFCM(error, to) {
    console.error(`❌ Erreur envoi Push FCM à ${to} :`, error.message);
    if (error.code === "messaging/registration-token-not-registered" ||
        error.code === "messaging/invalid-registration-token") {
        console.log(`🗑️ Suppression du token périmé pour ${to}`);
        fcmTokens.delete(to);
        sauvegarderTokensFCM();
    }
}

// =============================================================================
// FONCTION TEST 1 : Bannière interactive (écran allumé / arrière-plan standard)
// - Utilise calls_channel_v5 sans force-start
// - Affiche les deux boutons [Refuser] et [Accepter]
// - Ne force PAS l'ouverture de l'application (zéro concurrence avec l'interface)
// =============================================================================
function envoyerPushTest1Banniere(tokenDestinataire, to, from, callId, offerStr, hasVideo, notIdVal) {
    if (!messaging) {
        console.error("⚠️ Firebase Messaging n'est pas initialisé.");
        return;
    }
    const payload = {
        token: tokenDestinataire,
        data: {
            type: "APPEL",
            mode: "TEST_1_BANNIERE",
            callId: String(callId),
            callerId: String(from),
            caller_name: String(from),
            appelant: String(from),
            app_name: "KamSoft",
            title: "KamSoft - Appel entrant",
            subText: "Appel entrant",
            message: `${from} vous appelle`,
            body: `${from} vous appelle`,
            notId: String(notIdVal),
            icon: "ic_launcher",
            color: "#00A884",
            offer: offerStr || "",
            hasVideo: String(normaliserHasVideo(hasVideo)),
            actions: JSON.stringify([
                {
                    title: "Refuser",
                    callback: "rejectCallAction",
                    foreground: false
                },
                {
                    title: "Accepter",
                    callback: "acceptCallAction",
                    foreground: true
                }
            ]),
            android_channel_id: "calls_channel_v5",
            channelId: "calls_channel_v5",
            priority: "2",
            visibility: "1",
            importance: "5",
            sound: "default",
            vibrate: "true",
            vibrationPattern: "[0, 500, 250, 500]",
            category: "call"
        },
        android: {
            priority: "high",
            ttl: 60 * 1000
        }
    };

    logCall("FCM_SENT", { callId, from, to, info: `[TEST 1 BANNIÈRE] Envoi push avec boutons [Accepter/Refuser] (notId=${notIdVal})` });

    messaging.send(payload)
        .then(response => {
            logCall("FCM_DELIVERED", { callId, from, to, info: `[TEST 1 BANNIÈRE] FCM envoyé avec succès (${response})` });
        })
        .catch(error => {
            gererErreurFCM(error, to);
        });
}

// =============================================================================
// FONCTION TEST 2 : Réveil de l'écran en veille & affichage Interface 2 au-dessus du schéma
// - Payload Data-Only silencieux (AUCUNE notification système affichée dans la barre)
// - Déclenche le réveil matériel de l'écran via backgroundMode.wakeUp() et l'Interface 2
// =============================================================================
function envoyerPushTest2Veille(tokenDestinataire, to, from, callId, offerStr, hasVideo, notIdVal) {
    if (!messaging) {
        console.error("⚠️ Firebase Messaging n'est pas initialisé.");
        return;
    }
    // Payload Data-Only pur : sans title, body, message, ni actions
    // Sur Android, cela ne crée aucune notification dans la barre de notifications
    // mais délivre immédiatement les données à l'application pour allumer l'écran
    const payload = {
        token: tokenDestinataire,
        data: {
            type: "APPEL",
            mode: "TEST_2_VEILLE",
            screen_wake: "true",
            target_mode: "LOCKSCREEN_WAKE",
            callId: String(callId),
            callerId: String(from),
            caller_name: String(from),
            appelant: String(from),
            app_name: "KamSoft",
            offer: offerStr || "",
            hasVideo: String(normaliserHasVideo(hasVideo)),
            "force-start": "1",
            "content-available": "1"
        },
        android: {
            priority: "high",
            ttl: 60 * 1000
        }
    };

    logCall("FCM_SENT", { callId, from, to, info: `[TEST 2 RÉVEIL VEILLE] Envoi push réveil écran (Data-only sans notification)` });

    messaging.send(payload)
        .then(response => {
            logCall("FCM_DELIVERED", { callId, from, to, info: `[TEST 2 RÉVEIL VEILLE] FCM envoyé avec succès (${response})` });
        })
        .catch(error => {
            gererErreurFCM(error, to);
        });
}

// ======================================================
// SERVEUR HTTP (Pour le reveil Render, Diagnostic & Health Check)
// ======================================================
const server = http.createServer(async (req, res) => {
    res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
    });

    const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    // Endpoint d'enregistrement de token FCM direct via HTTP
    if (parsedUrl.pathname === "/register-token") {
        const userId = parsedUrl.searchParams.get("id");
        const token = parsedUrl.searchParams.get("token");

        if (userId && token) {
            fcmTokens.set(String(userId).trim(), String(token).trim());
            sauvegarderTokensFCM();
            console.log(`📲 [HTTP] Token FCM synchronisé pour ${userId} : ${token.substring(0, 15)}...`);
            return res.end(JSON.stringify({ success: true, message: `Token enregistré pour ${userId}` }));
        } else {
            return res.end(JSON.stringify({ error: "Paramètres 'id' et 'token' requis." }));
        }
    }

    // Endpoint de synchronisation de l'état de l'écran (veille vs allumé) via HTTP
    if (parsedUrl.pathname === "/set-screen-state") {
        const userId = parsedUrl.searchParams.get("id");
        const state = parsedUrl.searchParams.get("state"); // "SCREEN_ON" ou "SCREEN_OFF"
        if (userId && state) {
            userScreenStates.set(String(userId).trim(), state);
            console.log(`📱 [HTTP] État écran mis à jour pour ${userId} : ${state}`);
            return res.end(JSON.stringify({ success: true, userId, screenState: state }));
        }
        return res.end(JSON.stringify({ error: "Paramètres 'id' et 'state' requis." }));
    }

    // Endpoint de diagnostic
    if (parsedUrl.pathname === "/status" || parsedUrl.pathname === "/") {
        const tokensList = {};
        fcmTokens.forEach((token, id) => {
            tokensList[id] = token ? `${token.substring(0, 15)}...` : null;
        });

        return res.end(JSON.stringify({
            status: "ok",
            message: "Serveur d'appel operationnel",
            firebaseAdminReady: messaging !== null,
            connectedUsers: Array.from(utilisateurs.keys()),
            activeCallsCount: appels.size / 2,
            activeSessionsCount: callSessions.size,
            registeredFcmTokensCount: fcmTokens.size,
            registeredFcmTokens: tokensList
        }, null, 2));
    }

    // Endpoints de test push FCM directs :
    // - /test-push-banniere?to=ID-123456 (Test 1 : Bannière interactive sans forcer l'app)
    // - /test-push-veille?to=ID-123456   (Test 2 : Réveil de l'écran en veille)
    // - /test-push?to=ID-123456          (Par défaut : Test 1)
    if (parsedUrl.pathname === "/test-push" || parsedUrl.pathname === "/test-push-banniere" || parsedUrl.pathname === "/test-push-veille") {
        const targetId = parsedUrl.searchParams.get("to");
        if (!targetId) {
            return res.end(JSON.stringify({ error: "Parametre 'to' manquant. Exemple: /test-push?to=ID-123456" }));
        }

        const token = fcmTokens.get(targetId);
        if (!token) {
            return res.end(JSON.stringify({ error: `Aucun token FCM enregistre pour l'ID ${targetId}` }));
        }

        if (!messaging) {
            return res.end(JSON.stringify({ error: "Firebase Admin n'est pas initialise sur le serveur." }));
        }

        const isTestVeille = parsedUrl.pathname === "/test-push-veille";
        const notIdVal = "9999";

        try {
            if (isTestVeille) {
                envoyerPushTest2Veille(token, targetId, "TEST-APPELANT", "CALL-TEST-VEILLE", "", false, notIdVal);
                return res.end(JSON.stringify({ success: true, mode: "TEST 2 (Réveil Veille)", target: targetId }));
            } else {
                envoyerPushTest1Banniere(token, targetId, "TEST-APPELANT", "CALL-TEST-BANNIERE", "", false, notIdVal);
                return res.end(JSON.stringify({ success: true, mode: "TEST 1 (Bannière Interactive)", target: targetId }));
            }
        } catch (pushErr) {
            return res.end(JSON.stringify({ success: false, error: pushErr.message }));
        }
    }

    res.end(JSON.stringify({ status: "ok" }));
});

// ======================================================
// SERVEUR WEBSOCKET
// ======================================================
const wss = new WebSocket.Server({ server });

// ======================================================
// DEMARRAGE DU SERVEUR
// ======================================================
server.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Serveur WebSocket & HTTP demarre sur le port ${PORT}`);
});

// ======================================================
// UTILITAIRE : ENVOYER UN MESSAGE WEBSOCKET
// ======================================================
function envoyer(ws, message) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
    }
}

// ======================================================
// UTILITAIRE : ENVOYER A UN UTILISATEUR
// ======================================================
function envoyerAUtilisateur(identifiant, message) {
    const ws = utilisateurs.get(identifiant);
    if (!ws) {
        console.log(`Utilisateur non connecte en WS : ${identifiant}`);
        return false;
    }
    envoyer(ws, message);
    return true;
}

// ======================================================
// UTILITAIRES D'ETAT
// ======================================================
function utilisateurExiste(identifiant) {
    return utilisateurs.has(identifiant);
}

function utilisateurOccupe(identifiant) {
    return appels.has(identifiant);
}

function creerAppel(utilisateurA, utilisateurB) {
    appels.set(utilisateurA, utilisateurB);
    appels.set(utilisateurB, utilisateurA);
    console.log(`📞 APPEL CREE : ${utilisateurA} <--> ${utilisateurB}`);
}

function supprimerAppel(utilisateurA, utilisateurB) {
    if (utilisateurA) {
        appels.delete(utilisateurA);
        pendingOffers.delete(utilisateurA);
    }
    if (utilisateurB) {
        appels.delete(utilisateurB);
        pendingOffers.delete(utilisateurB);
    }
    console.log(`📴 APPEL TERMINE : ${utilisateurA} <--> ${utilisateurB}`);
}

function genererCodeSalle() {
    let code;
    do {
        code = Array.from({ length: 6 }, () =>
            ROOM_CODE_CHARACTERS[crypto.randomInt(ROOM_CODE_CHARACTERS.length)]
        ).join("");
    } while (roomCodes.has(code));
    return code;
}

function trouverSalleParticipant(participantId) {
    for (const room of rooms.values()) {
        if (room.participants.has(participantId)) return room;
    }
    return null;
}

function roomPayload(room) {
    return {
        roomId: room.id,
        code: room.code,
        hostId: room.hostId,
        state: room.state,
        participants: Array.from(room.participants.values())
    };
}

function envoyerErreurSalle(ws, code, message, requestType) {
    envoyer(ws, { type: "ROOM_ERROR", code, message, requestType });
}

function relayerRoomSignalisation(wsClient, from, message) {
    const type = message.type;
    const roomId = String(message.roomId || "");
    const to = String(message.to || "").trim();
    const room = rooms.get(roomId);

    if (!room || !to || !room.participants.has(from) || !room.participants.has(to)) {
        envoyerErreurSalle(wsClient, "NOT_IN_ROOM", "L’expéditeur et le destinataire doivent être dans la même salle.", type);
        return;
    }

    const recipient = utilisateurs.get(to);
    if (!recipient || recipient.readyState !== WebSocket.OPEN) {
        envoyerErreurSalle(wsClient, "NOT_IN_ROOM", "Le destinataire n’est pas connecté dans cette salle.", type);
        return;
    }

    envoyer(recipient, { type, roomId, to, from, payload: message.payload });
}

function fermerSalle(room, reason) {
    room.state = "closed";
    rooms.delete(room.id);
    roomCodes.delete(room.code);
    for (const participantId of room.participants.keys()) {
        envoyerAUtilisateur(participantId, {
            type: "ROOM_CLOSED",
            roomId: room.id,
            code: room.code,
            reason
        });
    }
    room.participants.clear();
}

function retirerParticipantSalle(room, participantId, reason) {
    if (!room || !room.participants.has(participantId)) return;
    if (room.hostId === participantId) {
        fermerSalle(room, reason || "host_left");
        return;
    }

    room.participants.delete(participantId);
    for (const remainingId of room.participants.keys()) {
        envoyerAUtilisateur(remainingId, {
            type: "PARTICIPANT_LEFT",
            roomId: room.id,
            participantId,
            reason
        });
    }
    if (room.participants.size === 0) fermerSalle(room, "empty");
}

function nettoyerSallesParticipant(participantId) {
    for (const room of Array.from(rooms.values())) {
        if (room.participants.has(participantId)) {
            retirerParticipantSalle(room, participantId, "disconnected");
        }
    }
}

// ======================================================
// CONNEXION CLIENT WEBSOCKET
// ======================================================
wss.on("connection", (ws) => {
    console.log("Nouveau client connecte.");
    let identifiant = null;
    ws.joinRoomAttempts = 0;

    ws.isAlive = true;
    ws.on("pong", () => {
        ws.isAlive = true;
    });

    ws.on("message", (data) => {
        try {
            const message = JSON.parse(data.toString());
            traiterMessage(ws, message);
        } catch (error) {
            console.error("Message JSON invalide :", error);
            envoyer(ws, {
                type: "ERROR",
                message: "Message invalide."
            });
        }
    });

    ws.on("close", () => {
        console.log(`Client deconnecte : ${identifiant || "inconnu"}`);
        // ⚠️ Si cette socket a été remplacée par une nouvelle socket active (isReplaced = true),
        // NE PAS exécuter gererDeconnexion pour ne pas raccrocher l'appel !
        if (identifiant && !ws.isReplaced) {
            gererDeconnexion(identifiant, ws);
        }
    });

    ws.on("error", (error) => {
        console.error(`Erreur WebSocket ${identifiant || ""} :`, error);
    });

    // ==================================================
    // TRAITEMENT DES MESSAGES
    // ==================================================
    function traiterMessage(wsClient, message) {
        if (message.targetId) message.to = message.targetId;

        // Normalisation
        if (message.type === "call-user") message.type = "CALLING";
        if (message.type === "answer-call") message.type = "CALL_ACCEPTED";
        if (message.type === "ice-candidate") message.type = "ICE_CANDIDATE";
        if (message.type === "hang-up") message.type = "CALL_ENDED";
        if (message.type === "call-refused") message.type = "CALL_REJECTED";

        const type = message.type;

        if (type === "PING" || type === "ping") {
            ws.isAlive = true;
            envoyer(wsClient, { type: "PONG" });
            return;
        }

        if (type === "REGISTER" || type === "UPDATE_TOKEN") {
            enregistrerUtilisateur(wsClient, message);
            return;
        }

        if (type === "SET_APP_STATE" || type === "SET_SCREEN_STATE") {
            const isFg = !!message.isForeground;
            const screenState = message.screenState || (isFg ? "SCREEN_ON" : undefined);
            if (identifiant) {
                userAppStates.set(identifiant, isFg);
                if (screenState) {
                    userScreenStates.set(identifiant, screenState);
                }
                console.log(`📱 État app pour ${identifiant} : ${isFg ? "FOREGROUND" : "BACKGROUND"} | Écran : ${userScreenStates.get(identifiant) || "n/a"}`);
            }
            return;
        }

        if (!identifiant) {
            envoyer(wsClient, {
                type: "ERROR",
                message: "Vous devez etre enregistre avant d'envoyer des messages."
            });
            return;
        }

        if (
            (type === "CREATE_ROOM" || type === "JOIN_ROOM" || type === "LEAVE_ROOM" ||
                type === "ROOM_OFFER" || type === "ROOM_ANSWER" || type === "ROOM_ICE") &&
            !wsClient.sessionAuthenticated
        ) {
            envoyerErreurSalle(wsClient, "AUTH_REQUIRED", "Un jeton de session est requis pour gérer les salles.", type);
            return;
        }

        if (type === "CALLING") return traiterCalling(message);
        if (type === "CALL_ACCEPTED") return traiterCallAccepted(message);
        if (type === "CALL_REJECTED") return traiterCallRejected(message);
        if (type === "CALL_ENDED") return traiterCallEnded(message);
        if (type === "IVR_TRANSFER") return traiterTransfertIvr(message);
        if (type === "CREATE_ROOM") return creerSalle(wsClient, identifiant, message);
        if (type === "JOIN_ROOM") return rejoindreSalle(wsClient, identifiant, message);
        if (type === "LEAVE_ROOM") return quitterSalle(wsClient, identifiant, message);
        if (type === "ROOM_OFFER" || type === "ROOM_ANSWER" || type === "ROOM_ICE") {
            return relayerRoomSignalisation(wsClient, identifiant, message);
        }
        if (type === "ICE_CANDIDATE" || type === "WEBRTC_OFFER" || type === "WEBRTC_ANSWER" || type === "renegotiate-offer" || type === "renegotiate-answer") {
            return relayerSignalisation(message);
        }

        envoyer(wsClient, {
            type: "ERROR",
            message: `Type de message inconnu : ${type}`
        });
    }

    function creerSalle(wsClient, participantId, message) {
        if (utilisateurOccupe(participantId)) {
            envoyerErreurSalle(wsClient, "CALL_ACTIVE", "Terminez l’appel en cours avant de créer une réunion.", "CREATE_ROOM");
            return;
        }
        if (trouverSalleParticipant(participantId)) {
            envoyerErreurSalle(wsClient, "ALREADY_IN_ROOM", "Vous êtes déjà dans une salle.", "CREATE_ROOM");
            return;
        }

        const room = {
            id: crypto.randomUUID(),
            code: genererCodeSalle(),
            hostId: participantId,
            state: "open",
            participants: new Map(),
            createdAt: Date.now()
        };
        room.participants.set(participantId, {
            id: participantId,
            displayName: String(message.displayName || participantId).slice(0, 80),
            role: "host",
            joinedAt: Date.now()
        });
        rooms.set(room.id, room);
        roomCodes.set(room.code, room.id);
        envoyer(wsClient, { type: "ROOM_CREATED", ...roomPayload(room) });
    }

    function rejoindreSalle(wsClient, participantId, message) {
        ws.joinRoomAttempts += 1;
        if (ws.joinRoomAttempts > MAX_JOIN_ATTEMPTS_PER_CONNECTION) {
            envoyerErreurSalle(wsClient, "JOIN_RATE_LIMITED", "Trop de tentatives de rejoindre une salle.", "JOIN_ROOM");
            ws.close(1008, "Too many JOIN_ROOM attempts");
            return;
        }

        if (utilisateurOccupe(participantId)) {
            envoyerErreurSalle(wsClient, "CALL_ACTIVE", "Terminez l’appel en cours avant de rejoindre une réunion.", "JOIN_ROOM");
            return;
        }

        const code = typeof message.code === "string" ? message.code.trim().toUpperCase() : "";
        if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(code)) {
            envoyerErreurSalle(wsClient, "INVALID_CODE", "Code de salle invalide.", "JOIN_ROOM");
            return;
        }

        const roomId = roomCodes.get(code);
        const room = roomId && rooms.get(roomId);
        if (!room || room.state !== "open") {
            envoyerErreurSalle(wsClient, "ROOM_NOT_FOUND", "Salle introuvable.", "JOIN_ROOM");
            return;
        }
        if (trouverSalleParticipant(participantId)) {
            envoyerErreurSalle(wsClient, "ALREADY_IN_ROOM", "Vous êtes déjà dans une salle.", "JOIN_ROOM");
            return;
        }
        if (room.participants.size >= MAX_PARTICIPANTS) {
            envoyerErreurSalle(wsClient, "ROOM_FULL", "La salle est complète.", "JOIN_ROOM");
            return;
        }

        const participant = {
            id: participantId,
            displayName: String(message.displayName || participantId).slice(0, 80),
            role: "participant",
            joinedAt: Date.now()
        };
        room.participants.set(participantId, participant);
        envoyer(wsClient, { type: "ROOM_JOINED", ...roomPayload(room) });
        for (const existingId of room.participants.keys()) {
            if (existingId !== participantId) {
                envoyerAUtilisateur(existingId, {
                    type: "PARTICIPANT_JOINED",
                    roomId: room.id,
                    participant
                });
            }
        }
    }

    function quitterSalle(wsClient, participantId, message) {
        const room = rooms.get(String(message.roomId || ""));
        if (!room || !room.participants.has(participantId)) {
            envoyerErreurSalle(wsClient, "ROOM_NOT_FOUND", "Salle introuvable.", "LEAVE_ROOM");
            return;
        }
        retirerParticipantSalle(room, participantId, "left");
    }

    // ==================================================
    // ENREGISTRER UTILISATEUR ET TOKEN FCM
    // ==================================================
    function enregistrerUtilisateur(wsClient, message) {
        const nouvelIdentifiant = String(message.id || message.userId || "").trim();

        if (nouvelIdentifiant === "") {
            envoyer(wsClient, {
                type: "ERROR",
                message: "Identifiant obligatoire."
            });
            return;
        }

        const sessionToken = typeof message.sessionToken === "string"
            ? message.sessionToken.trim()
            : "";
        const registeredToken = sessionTokens.get(nouvelIdentifiant);

        if (!sessionToken) {
            if (registeredToken) {
                envoyer(wsClient, {
                    type: "ERROR",
                    code: "ID_ALREADY_CONNECTED",
                    message: "Un jeton de session est requis pour cet identifiant."
                });
                wsClient.close(1008, "Jeton de session requis");
                return;
            }
            console.warn(`⚠️ Client ancien sans jeton de session : ${nouvelIdentifiant}`);
        } else if (registeredToken && registeredToken !== sessionToken) {
            envoyer(wsClient, {
                type: "ERROR",
                code: "ID_ALREADY_CONNECTED",
                message: "Jeton de session invalide pour cet identifiant."
            });
            wsClient.close(1008, "Jeton de session invalide");
            return;
        } else if (!registeredToken) {
            sessionTokens.set(nouvelIdentifiant, sessionToken);
        }

        wsClient.sessionAuthenticated = !!sessionToken;

        // Marquer l'ancienne socket avec isReplaced = true AVANT de la fermer
        if (utilisateurs.has(nouvelIdentifiant)) {
            const ancienneWs = utilisateurs.get(nouvelIdentifiant);
            if (ancienneWs && ancienneWs !== wsClient) {
                console.log(`🔄 Remplacement de l'ancienne socket pour ${nouvelIdentifiant}`);
                ancienneWs.isReplaced = true;
                try { ancienneWs.close(); } catch (e) { }
            }
        }

        identifiant = nouvelIdentifiant;
        utilisateurs.set(identifiant, wsClient);

        // Sauvegarde du token FCM
        if (message.fcmToken) {
            fcmTokens.set(identifiant, message.fcmToken);
            sauvegarderTokensFCM();
            console.log(`📲 TOKEN FCM ENREGISTRE pour ${identifiant} : ${message.fcmToken.substring(0, 20)}...`);
        } else if (fcmTokens.has(identifiant)) {
            console.log(`📲 Token FCM deja conserve en memoire pour ${identifiant}`);
        } else {
            console.log(`⚠️ Aucun token FCM fourni lors du REGISTER pour ${identifiant}`);
        }

        logCall("REGISTER", { from: identifiant, info: `Utilisateur enregistré (${identifiant})` });

        envoyer(wsClient, {
            type: "REGISTERED",
            id: identifiant
        });

        // ⚠️ TRANSMISSION SÉCURISÉE DE L'OFFRE EN ATTENTE :
        // On vérifie STRICTEMENT que l'offre est toujours dans l'état RINGING.
        // Si l'appel a déjà été accepté (state === 'ACCEPTING' ou 'CONNECTED'), ou terminé ('ENDED' / 'REJECTED'),
        // NE SURTOUT PAS renvoyer incoming-call !
        if (pendingOffers.has(identifiant)) {
            const pending = pendingOffers.get(identifiant);
            if (pending && pending.from) {
                const callId = pending.callId;
                const session = callId ? callSessions.get(callId) : null;

                if (isCallEnded(callId)) {
                    logCall("PENDING_OFFER_IGNORED", { callId, to: identifiant, info: "Appel déjà terminé dans endedCalls" });
                    pendingOffers.delete(identifiant);
                } else if (session && session.state !== "RINGING") {
                    logCall("PENDING_OFFER_IGNORED", { callId, to: identifiant, state: session.state, info: `Appel non 'RINGING' (${session.state}), pas de renvoi incoming-call` });
                    if (session.state === "CONNECTED" || session.state === "ENDED" || session.state === "REJECTED") {
                        pendingOffers.delete(identifiant);
                    }
                } else if (utilisateurExiste(pending.from) && appels.get(pending.from) === identifiant) {
                    logCall("PENDING_OFFER_SENT", { callId, from: pending.from, to: identifiant, state: "RINGING" });
                    envoyer(wsClient, {
                        type: "incoming-call",
                        from: pending.from,
                        to: identifiant,
                        offer: pending.offer,
                        hasVideo: normaliserHasVideo(pending.hasVideo),
                        callId: callId
                    });
                } else {
                    logCall("PENDING_OFFER_EXPIRED", { callId, to: identifiant, info: `L'appelant ${pending.from} n'est plus en ligne/occupé` });
                    pendingOffers.delete(identifiant);
                    appels.delete(identifiant);
                }
            }
        }
    }

    // ==================================================
    // TRAITER L'APPEL
    // ==================================================
    function traiterCalling(message) {
        const from = identifiant;
        const to = String(message.to || "").trim();
        const callId = String(message.callId || (Date.now().toString() + "-" + Math.random().toString(36).substring(2, 9)));
        const hasVideo = normaliserHasVideo(message.hasVideo);

        if (to === "") {
            envoyer(ws, { type: "ERROR", message: "Destinataire manquant." });
            return;
        }

        if (from === to) {
            envoyer(ws, { type: "ERROR", message: "Vous ne pouvez pas vous appeler vous-meme." });
            return;
        }

        if (isCallEnded(callId)) {
            logCall("CALLING_IGNORED", { callId, from, to, info: "callId présent dans endedCalls" });
            return;
        }

        if (trouverSalleParticipant(from) || trouverSalleParticipant(to)) {
            envoyer(ws, { type: "BUSY", from: to, message: "Quittez la réunion avant de passer un appel." });
            return;
        }

        const destinataireEnLigne = utilisateurExiste(to);
        const tokenDestinataire = fcmTokens.get(to);

        if (!destinataireEnLigne && !tokenDestinataire) {
            logCall("CALLING_FAILED", { callId, from, to, info: "Destinataire ni connecté ni token FCM" });
            envoyer(ws, { type: "ERROR", message: "Le correspondant est hors ligne ou introuvable." });
            return;
        }

        if (utilisateurOccupe(from)) {
            envoyer(ws, { type: "BUSY", from: to, message: "Vous etes deja en appel." });
            return;
        }

        if (utilisateurOccupe(to)) {
            envoyer(ws, { type: "BUSY", from: to, to: from, message: "Le correspondant est occupe." });
            logCall("CALLING_BUSY", { callId, from, to, info: `${to} est déjà occupé` });
            return;
        }

        creerAppel(from, to);

        // Enregistrement de la session d'appel serveur
        const session = {
            callId: callId,
            from: from,
            to: to,
            state: "RINGING",
            offer: message.offer,
            hasVideo: hasVideo,
            createdAt: Date.now()
        };
        callSessions.set(callId, session);

        if (message.offer) {
            pendingOffers.set(to, {
                from: from,
                offer: message.offer,
                hasVideo: hasVideo,
                callId: callId,
                createdAt: Date.now()
            });
        }

        let transmisWs = false;
        const isDestinataireAuPremierPlan = destinataireEnLigne && (userAppStates.get(to) === true);

        // 1. Envoi direct via WebSocket UNIQUEMENT si le destinataire est au premier plan
        if (destinataireEnLigne && isDestinataireAuPremierPlan) {
            transmisWs = envoyerAUtilisateur(to, {
                type: "incoming-call",
                from: from,
                to: to,
                offer: message.offer,
                hasVideo: hasVideo,
                callId: callId
            });
            if (transmisWs) {
                logCall("WS_RECEIVED", { callId, from, to, state: "RINGING", info: "Transmis par WS direct (app au 1er plan)" });
            }
        }

        // 2. Envoi via Push Firebase FCM (Arrière-plan et Veille) :
        // ⚠️ Si l'app est au premier plan, aucun push n'est requis (l'interface interne s'affiche).
        let pushTente = false;

        if (!isDestinataireAuPremierPlan && tokenDestinataire && messaging) {
            pushTente = true;
            const offerStr = message.offer
                ? (typeof message.offer === "string" ? message.offer : JSON.stringify(message.offer))
                : "";

            const notIdVal = String(Math.floor(10000 + Math.random() * 89999));
            const screenState = userScreenStates.get(to);

            // ── SÉPARATION STRICTE TEST 1 vs TEST 2 ──────────────────────────
            // Si le destinataire a son écran EXPLICITEMENT allumé en arrière-plan ET est connecté en WS :
            // 👉 Utiliser TEST 1 (Bannière interactive avec [Refuser] et [Accepter], sans forçage)
            // Dans TOUS les autres cas (veille, écran noir avec schéma, app fermée, hors-ligne) :
            // 👉 Utiliser TEST 2 (Réveil physique de l'écran + Interface 2 active au-dessus du lockscreen)
            const isStrictementEcranAllume = (screenState === "SCREEN_ON") && destinataireEnLigne;
            if (isStrictementEcranAllume) {
                console.log(`☀️ [TEST 1] Destinataire ${to} écran allumé et en ligne -> Push bannière interactive`);
                envoyerPushTest1Banniere(tokenDestinataire, to, from, callId, offerStr, hasVideo, notIdVal);
            } else {
                console.log(`🌙 [TEST 2] Destinataire ${to} en veille ou hors ligne (${screenState || "défaut"}) -> Push réveil écran`);
                envoyerPushTest2Veille(tokenDestinataire, to, from, callId, offerStr, hasVideo, notIdVal);
            }
        } else if (isDestinataireAuPremierPlan) {
            console.log(`ℹ️ Destinataire ${to} a l'application ouverte au premier plan : push FCM non requis.`);
        } else if (!tokenDestinataire) {
            console.log(`⚠️ Aucun token FCM enregistré pour ${to}.`);
        } else if (!messaging) {
            console.error("⚠️ Firebase Messaging n'est pas configuré sur le serveur.");
        }

        if (!transmisWs && !pushTente) {
            supprimerAppel(from, to);
            callSessions.delete(callId);
            envoyer(ws, {
                type: "ERROR",
                message: "Impossible de joindre le correspondant (hors ligne)."
            });
            return;
        }

        // Timeout de sécurité : si le destinataire ne répond pas après 60 secondes
        setTimeout(() => {
            const currentSession = callSessions.get(callId);
            if (currentSession && currentSession.state === "RINGING") {
                logCall("TIMEOUT", { callId, from, to, info: "Délai d'attente 60s dépassé" });
                markCallEnded(callId);
                pendingOffers.delete(to);
                supprimerAppel(from, to);
                envoyerAUtilisateur(from, {
                    type: "hang-up",
                    from: to,
                    to: from,
                    reason: "timeout",
                    callId: callId
                });
                // Notifier le destinataire pour effacer la notification
                const token = fcmTokens.get(to);
                if (token && messaging) {
                    messaging.send({
                        token: token,
                        data: {
                            type: "CANCEL_CALL",
                            action: "cancel_call",
                            from: String(from),
                            callerId: String(from),
                            callId: String(callId)
                        },
                        android: { priority: "high" }
                    }).catch(() => { });
                }
            }
        }, 60000);

        logCall("CREATED", { callId, from, to, state: "RINGING", info: `WS direct: ${transmisWs}, Push FCM: ${pushTente}` });
    }

    // ==================================================
    // TRAITER CALL ACCEPTED (ATOMIQUE)
    // ==================================================
    function traiterCallAccepted(message) {
        const from = identifiant;
        const to = String(message.to || "").trim();
        const callId = String(message.callId || "");

        if (to === "") return;

        if (callId && isCallEnded(callId)) {
            logCall("ACCEPT_IGNORED_DUPLICATE", { callId, from, to, info: "callId dans endedCalls" });
            return;
        }

        const session = callId ? callSessions.get(callId) : null;
        if (session) {
            if (session.state === "CONNECTED") {
                logCall("ACCEPT_IGNORED_DUPLICATE", { callId, from, to, state: "CONNECTED", info: "Session déjà connectée" });
                return;
            }
            session.state = "CONNECTED";
        }

        // Suppression immédiate et absolue des pendingOffers pour les deux parties
        pendingOffers.delete(from);
        pendingOffers.delete(to);

        envoyerAUtilisateur(to, {
            type: "call-answered",
            from: from,
            to: to,
            callId: callId,
            answer: message.answer
        });

        logCall("ANSWER_SENT", { callId, from, to, state: "CONNECTED", info: "Réponse WebRTC relayée à l'appelant" });
    }

    // ==================================================
    // TRAITER CALL REJECTED
    // ==================================================
    function traiterCallRejected(message) {
        const from = identifiant;
        const to = String(message.to || "").trim();
        const callId = String(message.callId || "");

        if (to === "") return;

        if (callId) {
            markCallEnded(callId);
            const session = callSessions.get(callId);
            if (session) session.state = "REJECTED";
        }

        pendingOffers.delete(from);
        pendingOffers.delete(to);

        envoyerAUtilisateur(to, {
            type: "call-refused",
            from: from,
            to: to,
            callId: callId
        });
        supprimerAppel(from, to);
        logCall("REJECTED", { callId, from, to, state: "REJECTED" });
    }

    // ==================================================
    // TRAITER CALL ENDED
    // ==================================================
    function traiterCallEnded(message) {
        const from = identifiant;
        const to = String(message.to || "").trim();
        const callId = String(message.callId || "");

        if (to === "") return;

        if (callId) {
            markCallEnded(callId);
            const session = callSessions.get(callId);
            if (session) session.state = "ENDED";
        }

        // Si l'appel était en attente (destinataire n'avait pas encore répondu), envoyer un push d'annulation
        if (pendingOffers.has(to)) {
            const tokenTo = fcmTokens.get(to);
            if (tokenTo && messaging) {
                messaging.send({
                    token: tokenTo,
                    data: {
                        type: "CANCEL_CALL",
                        action: "cancel_call",
                        from: String(from),
                        callerId: String(from),
                        callId: String(callId || "")
                    },
                    android: { priority: "high" }
                }).catch(() => { });
            }
        }

        pendingOffers.delete(from);
        pendingOffers.delete(to);

        envoyerAUtilisateur(to, {
            type: "hang-up",
            from: from,
            to: to,
            callId: callId
        });
        supprimerAppel(from, to);
        logCall("ENDED", { callId, from, to, state: "ENDED" });
    }

    // ==================================================
    // TRANSFERT IVR (TOUCHE 1)
    // ==================================================
    function traiterTransfertIvr(message) {
        const from = identifiant;
        const to = String(message.to || "").trim();
        const callId = String(message.callId || "");
        const digit = String(message.digit || "");

        if (!to || !callId || digit !== "1") {
            logCall("IVR_TRANSFER_IGNORED", { callId, from, to, info: "Champs invalides ou touche non autorisee" });
            envoyer(ws, {
                type: "ERROR",
                message: "Demande de transfert invalide : champs manquants ou touche non autorisee."
            });
            return;
        }

        if (to !== IVR_AGENT_ID) {
            logCall("IVR_TRANSFER_REFUSED", { callId, from, to, info: "Destination differente de l'agent IVR attendu" });
            envoyer(ws, {
                type: "ERROR",
                message: `Transfert refuse : la destination doit etre l'agent IVR ${IVR_AGENT_ID}.`
            });
            return;
        }

        const session = callSessions.get(callId);
        if (
            !session ||
            session.callId !== callId ||
            session.from !== from ||
            session.to !== to ||
            session.state !== "CONNECTED"
        ) {
            logCall("IVR_TRANSFER_REFUSED", {
                callId,
                from,
                to,
                state: session ? session.state : "ABSENTE",
                info: "Session IVR non valide pour cet emetteur"
            });
            envoyer(ws, {
                type: "ERROR",
                message: "Transfert refuse : aucun appel connecte ne correspond a cette demande."
            });
            return;
        }

        if (session.ivrTransferRequested) {
            logCall("IVR_TRANSFER_IGNORED", { callId, from, to, state: "CONNECTED", info: "Demande deja transmise pour cet appel" });
            envoyer(ws, {
                type: "ERROR",
                message: "Une demande de conseiller a deja ete transmise pour cet appel."
            });
            return;
        }

        const wsIvr = utilisateurs.get(to);
        if (!wsIvr || wsIvr.readyState !== WebSocket.OPEN) {
            logCall("IVR_TRANSFER_FAILED", { callId, from, to, info: "Agent IVR non connecte en WebSocket" });
            envoyer(ws, {
                type: "ERROR",
                message: "Transfert impossible : l'agent IVR n'est pas connecte."
            });
            return;
        }

        if (appels.get(from) !== to) {
            logCall("IVR_TRANSFER_REFUSED", { callId, from, to, info: "Aucun appel actif entre l'emetteur et l'agent IVR" });
            envoyer(ws, {
                type: "ERROR",
                message: "Transfert refuse : l'appel avec l'agent IVR n'est plus actif."
            });
            return;
        }

        const transmis = envoyerAUtilisateur(to, {
            type: "ivr-transfer",
            from: from,
            to: to,
            callId: callId,
            digit: digit
        });

        if (!transmis) {
            logCall("IVR_TRANSFER_FAILED", { callId, from, to, info: "Agent IVR non connecte en WebSocket" });
            envoyer(ws, {
                type: "ERROR",
                message: "Transfert impossible : l'agent IVR n'est pas connecte."
            });
            return;
        }

        session.ivrTransferRequested = true;
        logCall("IVR_TRANSFER", { callId, from, to, state: "CONNECTED", info: "Touche 1 relayee a l'agent IVR" });
    }

    // ==================================================
    // SIGNALISATION WEBRTC
    // ==================================================
    function relayerSignalisation(message) {
        const from = identifiant;
        const to = String(message.to || "").trim();
        const callId = message.callId;

        if (to === "" || appels.get(from) !== to) return;

        const eventType = (message.type === "ICE_CANDIDATE") ? "ice-candidate" : message.type;

        const signal = {
            type: eventType,
            candidate: message.candidate,
            offer: message.offer,
            answer: message.answer,
            callId: callId,
            from: from,
            to: to
        };

        envoyerAUtilisateur(to, signal);
        console.log(`[CALL] SIGNAL | ${eventType} | callId=${callId || "n/a"} | ${from} -> ${to}`);
    }

    // ==================================================
    // GESTION DECONNEXION
    // ==================================================
    function gererDeconnexion(id, wsOrigine) {
        // 1. Si l'utilisateur est enregistré avec une AUTRE socket active plus récente, on ne touche à rien
        if (utilisateurs.get(id) && utilisateurs.get(id) !== wsOrigine) {
            console.log(`ℹ️ Fermeture d'une socket obsolète pour ${id}, session active préservée.`);
            return;
        }

        // 2. Nettoyer la map utilisateurs si c'est bien la socket active qui a fermé
        if (utilisateurs.get(id) === wsOrigine) {
            utilisateurs.delete(id);
            userAppStates.delete(id);
            userScreenStates.set(id, "SCREEN_OFF");
        }

        nettoyerSallesParticipant(id);

        const correspondant = appels.get(id);

        if (correspondant) {
            // Si un appel est en attente (sonnerie / réveil push) et que l'utilisateur déconnecté est le destinataire,
            // on ne détruit PAS l'appel : le destinataire est probablement en train d'ouvrir l'application via le push !
            if (pendingOffers.has(id)) {
                console.log(`⏳ Destinataire ${id} déconnecté temporairement pendant la sonnerie/push. Appel maintenu.`);
                return;
            }

            envoyerAUtilisateur(correspondant, {
                type: "hang-up",
                from: id,
                to: correspondant,
                reason: "disconnected"
            });

            supprimerAppel(id, correspondant);
        }

        console.log(`❌ UTILISATEUR DECONNECTE : ${id}`);
    }
});

// ======================================================
// HEARTBEAT KEEP-ALIVE (30s)
// ======================================================
const intervalKeepAlive = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            console.log("Connexion inactive terminee (timeout keep-alive)");
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on("close", () => {
    clearInterval(intervalKeepAlive);
});

wss.on("error", (error) => {
    console.error("ERREUR SERVEUR WEBSOCKET :", error);
});