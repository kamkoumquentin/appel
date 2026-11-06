/**
 * ============================================================================
 * CallManager.js - SDK JavaScript Universel pour Appels WebRTC & Téléphonie
 * ============================================================================
 * Ce module encapsule toute la logique d'appel, WebRTC, WebSocket et l'orchestration
 * des plugins natifs standards (CallKeep, PushNotification, AudioToggle, BackgroundMode)
 * sans JAMAIS nécessiter de modifications manuelles dans les fichiers natifs Java/Kotlin.
 *
 * Fonctionne à 100% en environnement Web/PWA ET dans les conteneurs Cordova/Capacitor.
 */

class CallManager {
  constructor(options = {}) {
    // Configuration Serveur & Utilisateur
    this.serverUrl = options.serverUrl || window.APP_CONFIG.serverUrl;
    this.userId = options.userId || localStorage.getItem("app_user_id") || null;
    this.fcmToken = options.fcmToken || localStorage.getItem("app_fcm_token") || null;

    this.iceServers = options.iceServers || window.APP_CONFIG.iceServers;

    // Callbacks d'événements
    this.onRegistered = options.onRegistered || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});
    this.onIncomingCall = options.onIncomingCall || (() => {});
    this.onCallAccepted = options.onCallAccepted || (() => {});
    this.onCallConnected = options.onCallConnected || (() => {});
    this.onCallEnded = options.onCallEnded || (() => {});
    this.onRemoteStream = options.onRemoteStream || (() => {});
    this.onLocalStream = options.onLocalStream || (() => {});
    this.onError = options.onError || ((err) => console.error("[CallManager Error]", err));

    // États internes
    this.ws = null;
    this.wsQueue = [];
    this.roomMessageHandler = null;
    this.reconnectTimer = null;
    this.pingInterval = null;
    this.isManuallyDisconnected = false;

    // État d'appel : "IDLE" | "CALLING" | "RINGING" | "ACCEPTING" | "CONNECTED" | "ENDED"
    this.callState = "IDLE";
    this.currentCallId = null;
    this.currentCallerId = null;
    this.targetUserId = null;
    this.pendingOffer = null;
    this.pendingLocalIceCandidates = [];
    this.callSignalingReady = true;
    this.hasVideo = false;
    this.isMuted = false;
    this.isVideoOff = false;
    this.currentFacingMode = "user";

    // WebRTC
    this.peerConnection = null;
    this.videoSender = null;
    this.localStream = null;
    this.remoteStream = null;
    this.pendingIceCandidates = [];
    this.videoDiagnosticsInterval = null;
    this.videoDiagnosticsInFlight = false;

    // Cache anti-replay (TTL 60s)
    this.endedCalls = new Map();

    // Moteur Audio Web Fallback & WakeLock
    this.audioContext = null;
    this.ringtoneInterval = null;
    this.ringbackInterval = null;
    this.wakeLock = null;

    // ── BUG 1 FIX ──────────────────────────────────────────────────────────────
    // Flag anti-double-déclenchement : empêche que WebSocket ET FCM déclenchent
    // deux fois l'UI d'appel entrant pour le même callId.
    this._incomingCallHandled = false;
    this._lastIncomingCallId = null;
    // ──────────────────────────────────────────────────────────────────────────

    // Initialisation
    this.initAudioContext();
  }

  /* ==========================================================================
     1. INITIALISATION CENTRALE & DÉTECTION DES PLUGINS
     ========================================================================== */

  async init() {
    this.log("Initialisation du CallManager...");
    if (!this.userId) {
      this.userId = this.generateUserId();
      localStorage.setItem("app_user_id", this.userId);
    }

    // A. Initialiser les plugins Cordova s'ils sont présents
    this.initNativePlugins();

    // Vérifier l'autorisation des notifications plein écran (Android 14+)
    this.verifyFullScreenIntentPermission();

    // B. Connexion WebSocket
    this.connectWebSocket();

    // C. Synchroniser immédiatement le token FCM par HTTP s'il est déjà en cache local
    if (this.fcmToken) {
      this.syncFcmTokenHttp(this.userId, this.fcmToken);
    }

    // D. Nettoyage périodique du cache d'appels terminés
    setInterval(() => {
      const now = Date.now();
      this.endedCalls.forEach((time, id) => {
        if (now - time > 60000) this.endedCalls.delete(id);
      });
    }, 30000);

    return this.userId;
  }

  generateUserId() {
    return "ID-" + Math.floor(100000 + Math.random() * 900000);
  }

  log(event, details = {}) {
    console.log(`[CallManager] ${event} | state=${this.callState} | callId=${this.currentCallId || "n/a"}`, details);
  }

  /* ==========================================================================
     2. GESTION DES PLUGINS STANDARDS (ZERO MODIFICATION NATIVE)
     ========================================================================== */

  initNativePlugins() {
    // 1. Plugin Standard CallKeep (ConnectionService Android / CallKit iOS)
    if (window.CallKeep && typeof window.CallKeep.setup === "function") {
      try {
        window.CallKeep.setup({
          appName: "KamSoft",
          imageName: "ic_launcher",
          ringtoneSound: "ringtone"
        });

        window.CallKeep.addEventListener("answerCall", ({ callUUID }) => {
          this.log("Native AnswerCall trigger", { callUUID });
          this.acceptCall(callUUID, "native_callkeep_answer");
        });

        window.CallKeep.addEventListener("endCall", ({ callUUID }) => {
          this.log("Native EndCall trigger", { callUUID });
          this.hangUp(true, "native_callkeep_end");
        });

        this.log("✅ Plugin CallKeep initialisé avec succès");
      } catch (e) {
        console.warn("[CallManager] Erreur init CallKeep :", e);
      }
    }

    // 2. Plugin Standard PushNotification (@havesource/cordova-plugin-push)
    if (typeof window.PushNotification !== "undefined") {
      try {
        const push = window.PushNotification.init({
          android: {
            senderID: "826636218450",
            sound: "true",
            vibrate: "true",
            clearBadge: "true",
            forceShow: false,
            importance: 5,
            icon: "ic_launcher",
            iconColor: "#00A884"
          },
          ios: { alert: "true", badge: "true", sound: "true" }
        });
        this.push = push;

        // Création des canaux de notification Android (Heads-Up Banner)
        // ATTENTION : createChannel est une méthode statique sur window.PushNotification
        const createChannelFn = window.PushNotification.createChannel || push.createChannel;
        if (typeof createChannelFn === "function") {
          // Canal principal v5 (Importance 5 = IMPORTANCE_HIGH / HEADS-UP BANNER)
          createChannelFn.call(
            window.PushNotification,
            () => console.log("[CallManager] ✅ Canal 'calls_channel_v5' (Bannière Heads-Up Max) créé avec succès"),
            (e) => console.error("[CallManager] Erreur createChannel v5 :", e),
            {
              id: "calls_channel_v5",
              description: "Appels entrants KamSoft",
              importance: 5,
              visibility: 1,
              vibration: true,
              sound: "default"
            }
          );

          // Rétrocompatibilité canal v4
          createChannelFn.call(
            window.PushNotification,
            () => console.log("[CallManager] ✅ Canal 'calls_channel_v4' créé avec succès"),
            (e) => console.error("[CallManager] Erreur createChannel v4 :", e),
            {
              id: "calls_channel_v4",
              description: "Appels entrants KamSoft",
              importance: 5,
              visibility: 1,
              vibration: true,
              sound: "default"
            }
          );
        }

        push.on("registration", (data) => {
          this.fcmToken = data.registrationId;
          localStorage.setItem("app_fcm_token", this.fcmToken);
          this.log("📲 Token FCM enregistré :", this.fcmToken.substring(0, 15) + "...");
          
          // 1. Enregistrement par WebSocket
          this.sendSignal({ type: "REGISTER", id: this.userId, fcmToken: this.fcmToken });
          
          // 2. Synchronisation de secours par HTTP (garantit que le serveur Render a le token même si WebSocket est coupée)
          this.syncFcmTokenHttp(this.userId, this.fcmToken);
        });

        // Si un token est déjà en mémoire locale, synchroniser immédiatement par HTTP
        if (this.fcmToken) {
          this.syncFcmTokenHttp(this.userId, this.fcmToken);
        }

        // 1. Écouteur principal de notification (RÉCEPTION PASSIVE DU PUSH)
        push.on("notification", (data) => {
          this.log("📩 Événement push 'notification' déclenché", data);
          // ⚠️ IMPORTANT : la simple réception du push n'est PAS un clic sur [Accepter] !
          const payload = data || {};
          if (payload.additionalData) {
            delete payload.additionalData.actionCallback;
            delete payload.additionalData.callback;
          }
          delete payload.actionCallback;
          delete payload.callback;
          this.handlePushNotification(payload);
        });

        // 2. Écouteur spécifique pour le clic réel sur le bouton [Accepter]
        push.on("acceptCallAction", (data) => {
          this.log("⚡ Événement push 'acceptCallAction' capturé depuis le clic sur le bouton", data);
          const payload = data || {};
          payload.actionCallback = "acceptCallAction";
          if (!payload.additionalData) payload.additionalData = {};
          payload.additionalData.actionCallback = "acceptCallAction";
          this.handlePushNotification(payload);
        });

        // 3. Écouteur spécifique pour le clic réel sur le bouton [Refuser]
        push.on("rejectCallAction", (data) => {
          this.log("⚡ Événement push 'rejectCallAction' capturé depuis le clic sur le bouton", data);
          const payload = data || {};
          payload.actionCallback = "rejectCallAction";
          if (!payload.additionalData) payload.additionalData = {};
          payload.additionalData.actionCallback = "rejectCallAction";
          this.handlePushNotification(payload);
        });

        push.on("error", (e) => {
          console.warn("[CallManager] Erreur PushNotification :", e);
        });
      } catch (e) {
        console.warn("[CallManager] Erreur init PushNotification :", e);
      }
    }

    // 3. Plugin Standard AudioToggle
    if (window.AudioToggle && typeof window.AudioToggle.setAudioMode === "function") {
      this.log("✅ Plugin AudioToggle détecté et disponible");
    }

    // 4. Plugin Standard Background Mode (Maintien de l'écoute et réveil de l'écran en veille)
    if (window.cordova?.plugins?.backgroundMode) {
      try {
        const bm = window.cordova.plugins.backgroundMode;
        bm.enable();
        if (typeof bm.overrideBackButton === "function") {
          bm.overrideBackButton();
        }
        if (typeof bm.disableBatteryOptimizations === "function") {
          bm.disableBatteryOptimizations();
        }
        if (typeof bm.disableWebViewOptimizations === "function") {
          bm.disableWebViewOptimizations();
        }
        if (typeof bm.setDefaults === "function") {
          bm.setDefaults({
            title: "KamSoft",
            text: "Service d'appels prêt",
            icon: "ic_launcher",
            color: "00A884",
            silent: true
          });
        }
        this.log("✅ Plugin BackgroundMode activé en continu (maintien veille & réveil écran)");
      } catch (e) {
        console.warn("[CallManager] Erreur init BackgroundMode :", e);
      }
    }
  }

  /* ==========================================================================
     2.1 GESTION DE LA PERMISSION FULL SCREEN INTENT (ANDROID 14+)
     ========================================================================== */

  checkFullScreenIntentPermission() {
    return new Promise((resolve) => {
      if (window.PushNotification && typeof window.PushNotification.checkFullScreenIntentPermission === "function") {
        window.PushNotification.checkFullScreenIntentPermission(
          (result) => {
            const allowed = (result && typeof result.canUseFullScreenIntent !== "undefined")
              ? result.canUseFullScreenIntent
              : (result === true || (result && result.isEnabled === true));
            resolve(!!allowed);
          },
          (err) => {
            console.warn("[CallManager] Erreur checkFullScreenIntentPermission:", err);
            resolve(true);
          }
        );
      } else if (window.cordova && window.cordova.exec) {
        window.cordova.exec(
          (result) => {
            const allowed = (result && typeof result.canUseFullScreenIntent !== "undefined")
              ? result.canUseFullScreenIntent
              : (result === true || (result && result.isEnabled === true));
            resolve(!!allowed);
          },
          (err) => {
            console.warn("[CallManager] Erreur exec checkFullScreenIntentPermission:", err);
            resolve(true);
          },
          "PushNotification",
          "checkFullScreenIntentPermission",
          []
        );
      } else {
        resolve(true);
      }
    });
  }

  openFullScreenIntentSettings() {
    this.log("Ouverture des paramètres système Notifications plein écran...");
    if (window.PushNotification && typeof window.PushNotification.openFullScreenIntentSettings === "function") {
      window.PushNotification.openFullScreenIntentSettings(
        () => console.log("[CallManager] Paramètres plein écran ouverts avec succès"),
        (err) => console.warn("[CallManager] Erreur openFullScreenIntentSettings:", err)
      );
    } else if (window.cordova && window.cordova.exec) {
      window.cordova.exec(
        () => console.log("[CallManager] Paramètres plein écran ouverts via exec"),
        (err) => console.warn("[CallManager] Erreur exec openFullScreenIntentSettings:", err),
        "PushNotification",
        "openFullScreenIntentSettings",
        []
      );
    }
  }

  async verifyFullScreenIntentPermission() {
    if (!window.cordova) return;

    try {
      const isAllowed = await this.checkFullScreenIntentPermission();
      this.log(`Statut autorisation plein écran Android 14+ : isAllowed=${isAllowed}`);

      if (!isAllowed) {
        this.showFullScreenPermissionAlert();
      } else {
        const modal = document.getElementById("modal-fullscreen-permission");
        if (modal && modal.parentNode) {
          modal.parentNode.removeChild(modal);
          this.log("✅ Autorisation plein écran confirmée, modal masqué");
        }
      }
    } catch (e) {
      console.warn("[CallManager] Impossible de vérifier l'autorisation plein écran:", e);
    }
  }

  showFullScreenPermissionAlert() {
    if (document.getElementById("modal-fullscreen-permission")) return;

    const overlay = document.createElement("div");
    overlay.id = "modal-fullscreen-permission";
    overlay.style.cssText = "position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.85);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;";

    const box = document.createElement("div");
    box.style.cssText = "background-color:#111b21;border:1px solid #00a884;border-radius:18px;max-width:390px;width:100%;padding:24px;color:#e9edef;text-align:center;box-shadow:0 12px 36px rgba(0,0,0,0.8);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;";

    box.innerHTML = `
      <div style="font-size:46px;margin-bottom:12px;">📱</div>
      <h3 style="margin:0 0 10px 0;font-size:19px;color:#ffffff;font-weight:600;">Autorisation requise (Android 14+)</h3>
      <p style="font-size:14px;line-height:1.55;color:#8696a0;margin:0 0 20px 0;text-align:left;">
        Pour que les appels entrants puissent <strong>allumer votre écran en veille</strong> et s'afficher par-dessus le verrouillage comme un vrai téléphone, vous devez activer l'autorisation <strong>"Notifications plein écran"</strong> dans les paramètres Android.
      </p>
      <div style="display:flex;flex-direction:column;gap:10px;">
        <button id="btn-open-fsi-settings" style="background-color:#00a884;color:#ffffff;border:none;padding:13px;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;transition:all 0.2s;">⚙️ Ouvrir les Paramètres</button>
        <button id="btn-dismiss-fsi-modal" style="background:transparent;color:#8696a0;border:1px solid rgba(255,255,255,0.15);padding:11px;border-radius:10px;font-size:14px;cursor:pointer;">Plus tard</button>
      </div>
    `;

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const btnOpen = box.querySelector("#btn-open-fsi-settings");
    const btnDismiss = box.querySelector("#btn-dismiss-fsi-modal");

    if (btnOpen) {
      btnOpen.onclick = () => {
        this.openFullScreenIntentSettings();
      };
    }

    if (btnDismiss) {
      btnDismiss.onclick = () => {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      };
    }
  }

  // ── BUG 2 FIX ──────────────────────────────────────────────────────────────
  // Normalise le payload FCM quel que soit le format (foreground/background,
  // plugin v6/v7, données à plat ou dans additionalData).
  _extractPushData(data) {
    if (!data) return {};
    const ad = data.additionalData || {};

    // Champs de contrôle d'action
    const actionCallback = ad.actionCallback || data.actionCallback || ad.callback || data.callback || "";
    const callAction     = ad.CALL_ACTION || data.CALL_ACTION || ad.action || data.action || "";

    // Type de notification
    const type = ad.type || data.type || "";

    // Identification de l'appel
    const callId  = ad.callId  || data.callId  || ad.call_id  || data.call_id  || null;
    const caller  = ad.callerId || ad.caller_name || ad.appelant || ad.from
                 || data.callerId || data.caller_name || data.appelant || data.from || null;

    // Offre WebRTC — BUG 4 FIX : chercher dans les deux niveaux
    const offer = ad.offer || data.offer || null;

    const isAccepted = actionCallback === "acceptCallAction"
                    || callAction === "ACCEPT"
                    || ad.call_accepted === "true";
    const isRejected = actionCallback === "rejectCallAction"
                    || callAction === "DECLINE"
                    || callAction === "REJECT";
    const isCancel   = type === "CANCEL_CALL";
    const isIncoming = type === "APPEL" || (!!caller && !isAccepted && !isRejected && !isCancel);

    const rawHasVideo = ad.hasVideo !== undefined ? ad.hasVideo : data.hasVideo;
    const hasVideo = rawHasVideo === true || rawHasVideo === "true" || rawHasVideo === "1";

    return { actionCallback, callAction, type, callId, caller, offer, hasVideo,
             isAccepted, isRejected, isCancel, isIncoming };
  }
  // ──────────────────────────────────────────────────────────────────────────

  handlePushNotification(data) {
    if (!data) return;

    // ── BUG 2 FIX : utiliser le helper normalisé ────────────────────────────
    const { callId, caller, offer, hasVideo, isAccepted, isRejected, isCancel, isIncoming } =
      this._extractPushData(data);
    // ────────────────────────────────────────────────────────────────────────

    this.log("📩 Traitement Notification Push", {
      callId, caller, isAccepted, isRejected, isCancel, isIncoming,
      foreground: data.foreground
    });

    // ── Annulation distante ─────────────────────────────────────────────────
    if (isCancel) {
      this.handleRemoteCancel(callId);
      return;
    }

    // ── Tap [Accepter] sur la bannière ──────────────────────────────────────
    if (isAccepted) {
      this.log("⚡ Clic [Accepter] sur bannière → Interface Active");

      // ── BUG 4 FIX : lire l'offre via le helper (couvre data.offer ET additionalData.offer)
      if (offer) this.pendingOffer = offer;
      if (caller) {
        this.targetUserId   = String(caller);
        this.currentCallerId = String(caller);
      }
      if (callId) this.currentCallId = String(callId);
      this.hasVideo = hasVideo;

      // Amener l'app au premier plan
      this._bringToForeground();

      // Déclencher l'acceptation → affiche #interface-1 avec Bluetooth + chrono
      this.acceptCall(this.currentCallId, "push_action_accept");
      return;
    }

    // ── Tap [Refuser] sur la bannière ───────────────────────────────────────
    if (isRejected) {
      this.rejectCall(callId, "push_action_reject");
      return;
    }

    // ── Appel entrant (Gestion séparée TEST 1 vs TEST 2) ───────────────────
    if (isIncoming) {
      if (offer) this.pendingOffer = offer;
      if (callId) this.currentCallId = String(callId);
      if (caller) {
        this.currentCallerId = String(caller);
        this.targetUserId    = String(caller);
      }
      this.hasVideo = hasVideo;
      this.callState = "RINGING";

      const ad = (data && data.additionalData) || {};
      const signal = { from: caller, callId: callId, offer: offer, hasVideo: hasVideo };

      // Action exécutée si l'écran est en veille (TEST 2)
      const lancerReveilVeille = () => {
        this.log("🌙 [TEST 2] Écran en veille détecté -> Réveil écran + Interface 2 active au-dessus du schéma");
        this._wakeAndUnlockScreen();
        this.handleIncomingCallSignal(signal, true);
      };

      // Action exécutée si l'écran est déjà allumé (TEST 1)
      const gererEcranAllume = () => {
        // L'écran est DÉJÀ ALLUMÉ : ne PAS ouvrir l'interface sauvagement pour ne pas entrer en conflit avec la bannière !
        // Si l'utilisateur clique volontairement sur le corps de la bannière :
        if (ad.coldstart === true || (typeof document !== "undefined" && document.visibilityState === "visible")) {
          this.log("☀️ [TEST 1] Tap volontaire sur la bannière -> Affichage Interface 2");
          this.handleIncomingCallSignal(signal);
        } else {
          this.log("☀️ [TEST 1] Écran allumé : Bannière affichée en haut avec boutons [Accepter]/[Refuser], attente du clic");
        }
      };

      const isExplicitVeilleMode = (data.mode === "TEST_2_VEILLE") || (ad.mode === "TEST_2_VEILLE") ||
                                   (data.target_mode === "LOCKSCREEN_WAKE") || (ad.target_mode === "LOCKSCREEN_WAKE") ||
                                   (data.screen_wake === "true") || (ad.screen_wake === "true");

      // Si le push est explicitement un réveil de veille (Test 2 / /test-push-veille) :
      if (isExplicitVeilleMode) {
        lancerReveilVeille();
      } else if (window.cordova?.plugins?.backgroundMode?.isScreenOff) {
        // Détection matérielle locale infaillible sur le téléphone :
        window.cordova.plugins.backgroundMode.isScreenOff((isOff) => {
          if (isOff) {
            lancerReveilVeille();
          } else {
            gererEcranAllume();
          }
        });
      } else {
        // Fallback sans plugin : si document caché, veille probable
        if (typeof document !== "undefined" && document.hidden) {
          lancerReveilVeille();
        } else {
          gererEcranAllume();
        }
      }
    }
  }

  // Notifie le serveur si l'écran est allumé (SCREEN_ON) ou en veille (SCREEN_OFF)
  setScreenState(screenState) {
    this.screenState = screenState;
    // 1. Envoi par WebSocket
    this.sendSignal({
      type: "SET_SCREEN_STATE",
      id: this.userId,
      isForeground: this.isForeground,
      screenState: screenState
    });

    // 2. Envoi par HTTP de secours (garantit la transmission même si socket en veille)
    try {
      if (this.userId && this.serverUrl) {
        const httpUrl = this.serverUrl.replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://");
        fetch(`${httpUrl}/set-screen-state?id=${encodeURIComponent(this.userId)}&state=${encodeURIComponent(screenState)}`, {
          method: "GET",
          mode: "cors"
        }).catch(() => {});
      }
    } catch (e) {}

    this.log(`📱 État d'écran envoyé au serveur : ${screenState}`);
  }

  // Synchronisation du token FCM par HTTP direct avec le serveur
  async syncFcmTokenHttp(userId, token) {
    if (!userId || !token) return;
    try {
      const httpUrl = this.serverUrl.replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://");
      const url = `${httpUrl}/register-token?id=${encodeURIComponent(userId)}&token=${encodeURIComponent(token)}`;
      await fetch(url, { method: "GET", mode: "cors" });
      this.log("✅ Token FCM synchronisé par HTTP avec le serveur Render");
    } catch (e) {
      // Ignorer silencieusement si hors ligne
    }
  }

  // Notifie le serveur si l'application est au premier plan ou en arrière-plan
  setAppState(isForeground) {
    this.isForeground = !!isForeground;
    this.sendSignal({
      type: "SET_APP_STATE",
      id: this.userId,
      isForeground: this.isForeground
    });
    this.log(`📱 État visibilité application envoyé au serveur : ${this.isForeground ? "FOREGROUND" : "BACKGROUND"}`);
  }

  /* ==========================================================================
     3. WEBSOCKET & SIGNALISATION EN TEMPS RÉEL
     ========================================================================== */

  connectWebSocket() {
    if (this.isManuallyDisconnected) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.log("Connexion au serveur WebSocket...", { url: this.serverUrl });
    this.onStatusChange("Connexion au serveur...");

    try {
      this.ws = new WebSocket(this.serverUrl);

      this.ws.onopen = () => {
        this.log("✅ WebSocket connectée");
        this.onStatusChange("En ligne");
        this.startHeartbeat();

        // Enregistrer l'utilisateur auprès du serveur
        this.sendSignal({
          type: "REGISTER",
          id: this.userId,
          fcmToken: this.fcmToken
        });

        // Signaler immédiatement au serveur que l'app est au premier plan
        const isCurrentlyVisible = typeof document !== "undefined" ? document.visibilityState === "visible" : true;
        this.setAppState(isCurrentlyVisible);

        // Vider la file d'attente
        while (this.wsQueue.length > 0) {
          const msg = this.wsQueue.shift();
          this.sendSignal(msg);
        }

        this.onRegistered(this.userId);
      };

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          this.handleSocketMessage(message);
        } catch (err) {
          console.error("[CallManager] Message JSON invalide :", err);
        }
      };

      this.ws.onclose = () => {
        this.log("WebSocket fermée");
        this.stopHeartbeat();
        if (!this.isManuallyDisconnected) {
          this.onStatusChange("Déconnecté (reconnexion...)");
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = (err) => {
        console.warn("[CallManager] Erreur WebSocket :", err);
        this.ws.close();
      };
    } catch (e) {
      this.scheduleReconnect();
    }
  }

  sendSignal(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      this.wsQueue.push(message);
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
        this.connectWebSocket();
      }
    }
  }

  setRoomMessageHandler(handler) {
    if (handler !== null && typeof handler !== "function") {
      throw new TypeError("Le gestionnaire de messages de salle doit être une fonction ou null.");
    }
    this.roomMessageHandler = handler;
  }

  scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.log("Tentative de reconnexion...");
      this.connectWebSocket();
    }, 4000);
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "PING" }));
      }
    }, 25000);
  }

  stopHeartbeat() {
    if (this.pingInterval) clearInterval(this.pingInterval);
    this.pingInterval = null;
  }

  /* ==========================================================================
     4. TRAITEMENT DES MESSAGES SIGNALISATION
     ========================================================================== */

  handleSocketMessage(message) {
    const type = message.type;
    if (
      type === "ROOM_CREATED" ||
      type === "ROOM_JOINED" ||
      type === "PARTICIPANT_JOINED" ||
      type === "PARTICIPANT_LEFT" ||
      type === "ROOM_CLOSED" ||
      type === "ROOM_ERROR"
    ) {
      this.roomMessageHandler?.(message);
      return;
    }

    switch (type) {
      case "incoming-call":
      case "CALLING":
        this.handleIncomingCallSignal(message);
        break;

      case "call-answered":
      case "CALL_ACCEPTED":
      case "answer-call":
        this.handleCallAcceptedSignal(message);
        break;

      case "call-refused":
      case "CALL_REJECTED":
      case "call-declined":
        this.handleCallRejectedSignal(message);
        break;

      case "hang-up":
      case "CALL_ENDED":
        this.handleCallEndedSignal(message);
        break;

      case "ice-candidate":
      case "ICE_CANDIDATE":
        this.handleRemoteIceCandidate(message);
        break;

      case "WEBRTC_OFFER":
        this.handleRemoteWebRTCOffer(message);
        break;

      case "WEBRTC_ANSWER":
        this.handleRemoteWebRTCAnswer(message);
        break;

      case "BUSY":
        this.handleBusySignal(message);
        break;

      case "ERROR":
        this.onError(new Error(message.message || "Erreur serveur"));
        break;

      case "PONG":
      case "REGISTERED":
        break;

      default:
        this.log("Message WebSocket non géré :", message);
    }
  }

  /* ==========================================================================
     5. GESTION DES APPELS (START, ACCEPT, REJECT, HANGUP)
     ========================================================================== */

  async startCall(targetId, options = {}) {
    if (!targetId || targetId.trim() === "") {
      throw new Error("L'identifiant du destinataire est requis.");
    }
    if (targetId === this.userId) {
      throw new Error("Vous ne pouvez pas vous appeler vous-même.");
    }
    if (this.callState !== "IDLE") {
      throw new Error("Un appel est déjà en cours.");
    }

    this.targetUserId = String(targetId).trim();
    this.hasVideo = !!options.video;
    this.currentCallId = Date.now() + "-" + Math.random().toString(36).substring(2, 8);
    this.callState = "CALLING";
    this.callSignalingReady = false;
    this.pendingLocalIceCandidates = [];

    this.log("Démarrage d'un appel sortant...", { to: this.targetUserId, callId: this.currentCallId, video: this.hasVideo });
    this.onStatusChange(`Appel en cours vers ${this.targetUserId}...`);

    this.startRingbackTone();
    this.acquireWakeLock();
    this.enableBackgroundMode();

    try {
      if (this.hasVideo && !(await this.ensureCameraPermission())) {
        throw new Error("L'autorisation d'accès à la caméra est nécessaire pour un appel vidéo.");
      }

      // 1. Obtenir le flux média local (micro / caméra)
      await this.initLocalStream(this.hasVideo);

      // 2. Créer l'offre WebRTC
      await this.createPeerConnection();
      const offer = await this.peerConnection.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true
      });
      await this.peerConnection.setLocalDescription(offer);

      // 3. Envoyer l'offre via WebSocket + FCM
      this.sendSignal({
        type: "CALLING",
        to: this.targetUserId,
        from: this.userId,
        callId: this.currentCallId,
        offer: offer,
        hasVideo: this.hasVideo
      });
      this.callSignalingReady = true;
      while (this.pendingLocalIceCandidates.length > 0) {
        this.sendSignal(this.pendingLocalIceCandidates.shift());
      }
    } catch (err) {
      this.hangUp(true, "init_call_error");
      throw err;
    }
  }

  async handleIncomingCallSignal(message, forceShowUI = false) {
    const callId = message.callId;
    const from = message.from;

    if (callId && this.endedCalls.has(String(callId))) {
      this.log("Offre d'appel ignorée (déjà terminée)", { callId });
      return;
    }

    // ── BUG 1 FIX : anti double-déclenchement WS + FCM ──────────────────────
    // Si le même callId a déjà été traité (ex: arrivé via WS puis via FCM),
    // on met à jour l'offre si manquante, mais on ne ré-affiche pas l'UI sauf si forceShowUI est requis.
    if (callId && this._lastIncomingCallId === String(callId) && this._incomingCallHandled) {
      this.log("⚠️ Appel entrant déjà traité (anti double WS+FCM)", { callId, forceShowUI });
      if (message.offer && !this.pendingOffer) {
        this.pendingOffer = message.offer;
      }
      if (this.callState === "ACCEPTING" || this.autoAcceptPendingOffer) {
        this.autoAcceptPendingOffer = false;
        await this.completeWebRTCAnswer();
        return;
      }
      // Si un réveil de veille force l'UI alors qu'elle n'était pas affichée :
      if (forceShowUI) {
        this.log("🌙 [Rattrapage UI Veille] Forçage affichage Interface 2 suite au réveil", { callId });
        this.onIncomingCall({
          callId: this.currentCallId,
          callerId: from || this.currentCallerId,
          callerName: from || this.currentCallerId,
          hasVideo: this.hasVideo,
          isAppVisible: true
        });
      }
      return;
    }
    // ────────────────────────────────────────────────────────────────────────

    if (message.offer) this.pendingOffer = message.offer;
    if (callId) this.currentCallId = String(callId);
    if (from) {
      this.currentCallerId = String(from);
      this.targetUserId = String(from);
    }
    this.hasVideo = message.hasVideo === true || message.hasVideo === "true" || message.hasVideo === "1";

    // Si l'utilisateur a déjà cliqué sur Accepter (autoAcceptPendingOffer) :
    if (this.callState === "ACCEPTING" || this.autoAcceptPendingOffer) {
      this.log("Offre reçue pendant l'état ACCEPTING -> Finalisation de la réponse WebRTC", { callId });
      this.autoAcceptPendingOffer = false;
      await this.completeWebRTCAnswer();
      return;
    }

    if (this.callState === "CONNECTED") {
      this.log("Signal d'appel entrant ignoré car déjà en communication", { callId });
      return;
    }

    if (this.callState !== "IDLE" && this.callState !== "RINGING") {
      this.log("Destinataire occupé, rejet automatique", { callId });
      this.sendSignal({ type: "CALL_REJECTED", to: from, callId: callId, reason: "busy" });
      return;
    }

    this.callState = "RINGING";
    this.log("🔔 Appel entrant reçu", { from, callId, forceShowUI });
    this.onStatusChange(`Appel entrant de ${from}`);

    // ── BUG 1 FIX : marquer cet appel comme traité ───────────────────────────
    this._lastIncomingCallId = callId ? String(callId) : null;
    this._incomingCallHandled = true;
    // ────────────────────────────────────────────────────────────────────────

    // ── GESTION DISTINCTE DU CYCLE DE VIE (1er plan vs Veille vs Écran allumé) ──
    const isAppVisible = typeof document !== "undefined" && document.visibilityState === "visible";

    const afficherAppelUI = () => {
      this.startRingtone();
      this._showWebNotification(from || "Correspondant");
      this.onIncomingCall({
        callId: this.currentCallId,
        callerId: from,
        callerName: from,
        hasVideo: this.hasVideo,
        isAppVisible: isAppVisible || forceShowUI
      });
    };

    if (forceShowUI || isAppVisible) {
      // 📱 Réveil de veille forcé (Lockscreen) OU Application au 1er plan
      this.log(`📱 ${forceShowUI ? "Réveil veille forcé (Lockscreen)" : "Application au premier plan"} -> Affichage direct de l'Interface 2`);
      afficherAppelUI();
    } else {
      // 🌙 Cas où l'application est en arrière-plan : vérifier si l'écran est en veille ou allumé
      if (window.cordova?.plugins?.backgroundMode?.isScreenOff) {
        window.cordova.plugins.backgroundMode.isScreenOff((isOff) => {
          if (isOff) {
            // 🌙 TEST 2 : Téléphone en veille (écran éteint / schéma)
            // Réveil physique de l'écran et affichage de l'Interface 2 active au-dessus du schéma
            this.log("🌙 [TEST 2] Écran éteint (veille) -> Réveil écran + Interface 2 au-dessus du schéma");
            this._wakeAndUnlockScreen();
            afficherAppelUI();
          } else {
            // ☀️ TEST 1 : Écran déjà allumé (l'utilisateur utilise son téléphone)
            // Ne PAS forcer le passage au 1er plan ni afficher l'Interface 2 sauvagement !
            // Laisser la bannière Heads-Up avec les 2 boutons [Refuser] et [Accepter] s'afficher sans conflit !
            this.log("☀️ [TEST 1] Écran allumé : pas de forçage plein écran, bannière avec boutons [Accepter]/[Refuser] affichée");
            this.startRingtone();
          }
        });
      } else {
        // Fallback sans plugin : réveil systématique
        this.log("📱 Arrière-plan sans détection matérielle : réveil écran + Interface 2");
        this._wakeAndUnlockScreen();
        afficherAppelUI();
      }
    }
  }

  clearNotifications() {
    if (this.push && typeof this.push.clearAllNotifications === "function") {
      try {
        this.push.clearAllNotifications(() => {}, () => {});
      } catch (e) {}
    }
  }

  // ── LACUNE 7 FIX : Fallback Notification API Web (mode navigateur pur) ────
  // Affiche une notification système native du navigateur quand Cordova n'est
  // pas disponible (tests desktop, PWA).
  _showWebNotification(callerName) {
    if (window.cordova) return; // Cordova gère ses propres notifications (FCM)
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    try {
      const notif = new Notification("📞 Appel entrant — KamSoft", {
        body: `${callerName} vous appelle`,
        icon: "img/ic_launcher.png",
        tag: "incoming-call",
        requireInteraction: true, // reste visible jusqu'à action
        vibrate: [200, 100, 200]
      });
      notif.onclick = () => {
        window.focus();
        notif.close();
        if (typeof window.acceptCall === "function") window.acceptCall("web_notif_click");
      };
      // Stocker la référence pour la fermer à la fin de l'appel
      this._webNotification = notif;
    } catch (e) {
      console.warn("[CallManager] Erreur Notification API Web :", e);
    }
  }

  _closeWebNotification() {
    if (this._webNotification) {
      try { this._webNotification.close(); } catch (e) {}
      this._webNotification = null;
    }
  }

  // ── Utilitaire : réveil écran + affichage au-dessus du schéma (Lockscreen) ─
  _wakeAndUnlockScreen() {
    this.log("💡 [Lockscreen] Réveil écran + affichage par-dessus l'écran de verrouillage avec schéma");

    if (window.cordova?.plugins?.backgroundMode) {
      try {
        const bm = window.cordova.plugins.backgroundMode;
        // 1. Allumer physiquement l'écran du téléphone (si écran éteint)
        if (typeof bm.wakeUp === "function") {
          bm.wakeUp();
        }
        // 2. Déverrouiller et injecter les flags FLAG_SHOW_WHEN_LOCKED, FLAG_TURN_SCREEN_ON, FLAG_DISMISS_KEYGUARD
        // Note : bm.unlock() démarre déjà l'activité avec getLaunchIntent().
        // Ne pas appeler moveToForeground() juste après pour éviter un double lancement instable.
        if (typeof bm.unlock === "function") {
          bm.unlock();
        }
      } catch (e) {
        console.warn("[CallManager] Erreur backgroundMode wakeUp/unlock :", e);
      }
    }

    // 4. WakeLock Web API (empêche l'écran de se rendormir pendant la sonnerie)
    this.acquireWakeLock();
  }

  // ── Utilitaire : amener l'app au premier plan (background mode) ───────────
  _bringToForeground() {
    this._wakeAndUnlockScreen();
  }
  // ──────────────────────────────────────────────────────────────────────────

  async acceptCall(callId, source = "ui_accept") {
    if (this.callState === "CONNECTED") {
      return;
    }

    this.log("Acceptation de l'appel...", { callId, source });
    this.stopRingtone();
    this.stopRingbackTone();
    this.stopVibration();
    this.clearNotifications();

    this.callState = "ACCEPTING";
    this.onStatusChange("Connexion audio...");
    this.acquireWakeLock();
    this.enableBackgroundMode();
    this.setAudioOutput("EARPIECE");

    // ⚡ Notification UI IMMÉDIATE pour basculer vers l'écran d'appel actif instantanément
    this.onCallAccepted({ callId: this.currentCallId || callId, targetId: this.targetUserId || this.currentCallerId });

    try {
      if (this.hasVideo && !(await this.ensureCameraPermission())) {
        throw new Error("L'autorisation d'accès à la caméra est nécessaire pour accepter cet appel vidéo.");
      }

      // 1. Obtenir le flux média local
      await this.initLocalStream(this.hasVideo);

      // 2. Créer la PeerConnection
      await this.createPeerConnection();

      // 3. Appliquer l'offre distante si disponible ou mettre en attente
      if (this.pendingOffer) {
        await this.completeWebRTCAnswer();
      } else {
        this.log("En attente de l'offre WebRTC pour générer l'Answer...");
        this.autoAcceptPendingOffer = true;
      }
    } catch (err) {
      this.log("Erreur lors de l'acceptation :", err);
      this.hangUp(true, "accept_error");
    }
  }

  async completeWebRTCAnswer() {
    if (!this.pendingOffer || !this.peerConnection) return;
    try {
      let desc = this.pendingOffer;
      if (typeof desc === "string") {
        if (!desc.trim()) return;
        try {
          desc = JSON.parse(desc);
        } catch (parseErr) {
          console.warn("[CallManager] Erreur parsing pendingOffer JSON :", parseErr);
          return;
        }
      }

      await this.peerConnection.setRemoteDescription(new RTCSessionDescription(desc));
      this.processPendingIceCandidates();

      const answer = await this.peerConnection.createAnswer();
      await this.peerConnection.setLocalDescription(answer);

      this.sendSignal({
        type: "CALL_ACCEPTED",
        to: this.targetUserId || this.currentCallerId,
        from: this.userId,
        callId: this.currentCallId,
        answer: answer
      });

      this.callState = "CONNECTED";
      this.onStatusChange("En communication");
      this.log("✅ Réponse WebRTC envoyée au correspondant");
    } catch (e) {
      this.log("Erreur completeWebRTCAnswer :", e);
    }
  }

  rejectCall(callId, reason = "user_declined") {
    const target = this.targetUserId || this.currentCallerId;
    this.log("Refus de l'appel", { callId, target, reason });

    this.stopRingtone();
    this.stopRingbackTone();
    this.stopVibration();
    this.clearNotifications();
    this._closeWebNotification(); // LACUNE 7 FIX

    if (callId) this.endedCalls.set(String(callId), Date.now());

    if (target) {
      this.sendSignal({
        type: "CALL_REJECTED",
        to: target,
        from: this.userId,
        callId: callId || this.currentCallId,
        reason: reason
      });
    }

    if (window.CallKeep) window.CallKeep.endCall(callId || this.currentCallId);
    this.resetCallState();
    this.onCallEnded({ callId, reason });
  }

  hangUp(notifyRemote = true, reason = "user_hangup") {
    this.log("Fin de l'appel", { callId: this.currentCallId, notifyRemote, reason });

    this.stopRingtone();
    this.stopRingbackTone();
    this.stopVibration();
    this.clearNotifications();
    this._closeWebNotification(); // LACUNE 7 FIX
    this.releaseWakeLock();
    this.disableBackgroundMode();

    if (this.currentCallId) {
      this.endedCalls.set(String(this.currentCallId), Date.now());
    }

    if (notifyRemote && this.targetUserId) {
      this.sendSignal({
        type: "CALL_ENDED",
        to: this.targetUserId,
        from: this.userId,
        callId: this.currentCallId,
        reason: reason
      });
    }

    if (window.CallKeep && this.currentCallId) {
      window.CallKeep.endCall(this.currentCallId);
    }

    // Fermeture des flux WebRTC
    this.closePeerConnection();
    this.stopLocalStream();

    const endedCallId = this.currentCallId;
    this.resetCallState();
    this.onStatusChange("En ligne");
    this.onCallEnded({ callId: endedCallId, reason });
  }

  handleCallAcceptedSignal(message) {
    this.log("L'appel a été accepté par le correspondant", message);
    this.stopRingbackTone();
    this.callState = "CONNECTED";
    this.onStatusChange("En communication");

    if (message.answer && this.peerConnection) {
      const desc = typeof message.answer === "string" ? JSON.parse(message.answer) : message.answer;
      this.peerConnection.setRemoteDescription(new RTCSessionDescription(desc))
        .then(() => this.processPendingIceCandidates())
        .catch((e) => console.error("[CallManager] Erreur setRemoteDescription answer :", e));
    }

    this.onCallAccepted({ callId: this.currentCallId, targetId: this.targetUserId });
  }

  handleCallRejectedSignal(message) {
    this.log("L'appel a été rejeté", message);
    this.onStatusChange("Appel refusé");
    this.hangUp(false, "rejected_by_remote");
  }

  handleCallEndedSignal(message) {
    this.log("L'appel a été terminé par le correspondant", message);
    this.onStatusChange("Appel terminé");
    this.hangUp(false, "ended_by_remote");
  }

  handleBusySignal(message) {
    this.log("Le correspondant est occupé", message);
    this.onStatusChange("Correspondant occupé");
    this.hangUp(false, "busy");
  }

  handleRemoteCancel(callId) {
    // ── BUG 5 FIX ────────────────────────────────────────────────────────────
    // Condition élargie : annuler si callId correspond OU si on est en RINGING
    // (l'annulation peut arriver avec un callId légèrement différent selon le timing).
    // On force resetCallState() AVANT hangUp pour garantir que callState repasse
    // à IDLE même si l'app était en background et que l'UI n'était pas affichée.
    const concernsCurrentCall = !callId
      || String(callId) === String(this.currentCallId)
      || this.callState === "RINGING";

    if (concernsCurrentCall) {
      this.log("📵 Appel annulé à distance par l'appelant", { callId });
      this._closeWebNotification(); // LACUNE 7 : fermer la notif Web si présente
      this._incomingCallHandled = false; // BUG 1 : réinitialiser le flag anti-double
      this._lastIncomingCallId  = null;
      // Forcer la remise à zéro de l'état avant hangUp (BUG 5)
      // pour éviter que callState reste "RINGING" si l'UI n'était pas affichée.
      if (this.callState === "RINGING") {
        this.stopRingtone();
        this.stopVibration();
        this.clearNotifications();
      }
      this.hangUp(false, "remote_cancelled");
    }
  }

  resetCallState() {
    this.callState = "IDLE";
    this.currentCallId = null;
    this.currentCallerId = null;
    this.targetUserId = null;
    this.pendingOffer = null;
    this.pendingLocalIceCandidates = [];
    this.callSignalingReady = true;
    this.pendingIceCandidates = [];
    this.isMuted = false;
    this.isVideoOff = false;
    this.hasVideo = false;
    // BUG 1 FIX : réinitialiser le flag anti-double à chaque fin d'appel
    this._incomingCallHandled = false;
    this._lastIncomingCallId  = null;
    // LACUNE 7 FIX : fermer la notification Web si elle est encore visible
    this._closeWebNotification();
    this.stopVideoDiagnostics();
  }

  /* ==========================================================================
     6. GESTION WEBRTC (PEERCONNECTION, STREAMS, TRACKS)
     ========================================================================== */

  async initLocalStream(withVideo = false) {
    if (this.localStream) return this.localStream;

    const constraints = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: withVideo ? { facingMode: this.currentFacingMode, width: { ideal: 640 }, height: { ideal: 480 } } : false
    };

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
      this.onLocalStream(this.localStream);
      return this.localStream;
    } catch (err) {
      console.error("[CallManager] Erreur getUserMedia :", err);
      throw new Error("Impossible d'accéder au micro ou à la caméra.");
    }
  }

  ensureCameraPermission() {
    const permissions = window.cordova?.plugins?.permissions;
    if (!permissions) return Promise.resolve(true);

    const cameraPermission = permissions.CAMERA || "android.permission.CAMERA";
    return new Promise((resolve, reject) => {
      permissions.checkPermission(cameraPermission, (status) => {
        if (status.hasPermission) {
          resolve(true);
          return;
        }
        permissions.requestPermission(cameraPermission, (result) => {
          resolve(!!result.hasPermission);
        }, reject);
      }, reject);
    });
  }

  async createPeerConnection() {
    if (this.peerConnection) return this.peerConnection;

    this.peerConnection = new RTCPeerConnection({ iceServers: this.iceServers });

    // Keep a video transceiver in audio calls so either participant can enable
    // their camera later without requiring an SDP renegotiation.
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach((track) => {
        this.peerConnection.addTrack(track, this.localStream);
      });
      const videoTrack = this.localStream.getVideoTracks()[0];
      this.videoSender = videoTrack
        ? this.peerConnection.addTrack(videoTrack, this.localStream)
        : this.peerConnection.addTransceiver("video", { direction: "sendrecv" }).sender;
    } else {
      this.videoSender = this.peerConnection.addTransceiver("video", { direction: "sendrecv" }).sender;
    }

    // Réception des pistes distantes
    this.peerConnection.ontrack = (event) => {
      const track = event.track;
      const trackState = () => ({
        kind: track.kind,
        id: track.id,
        enabled: track.enabled,
        muted: track.muted,
        readyState: track.readyState,
        streams: event.streams?.length || 0
      });
      this.log("WEBRTC_VIDEO_DIAG receive ontrack", trackState());
      if (track.kind === "video") {
        track.addEventListener("mute", () => {
          this.log("WEBRTC_VIDEO_DIAG receive track-mute", trackState());
        });
        track.addEventListener("unmute", () => {
          this.log("WEBRTC_VIDEO_DIAG receive track-unmute", trackState());
        });
      }
      if (!this.remoteStream) {
        this.remoteStream = event.streams?.[0] || new MediaStream();
      }

      const tracks = event.streams?.[0]?.getTracks() || [];
      if (event.track && !tracks.includes(event.track)) tracks.push(event.track);
      tracks.forEach((track) => {
        if (!this.remoteStream.getTracks().includes(track)) {
          this.remoteStream.addTrack(track);
        }
      });

      this.onRemoteStream(this.remoteStream);
    };

    // Émission des ICE Candidates
    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate && this.targetUserId) {
        const signal = {
          type: "ICE_CANDIDATE",
          to: this.targetUserId,
          from: this.userId,
          callId: this.currentCallId,
          candidate: event.candidate
        };
        if (this.callState === "CALLING" && !this.callSignalingReady) {
          this.pendingLocalIceCandidates.push(signal);
        } else {
          this.sendSignal(signal);
        }
      }
    };

    this.peerConnection.onconnectionstatechange = () => {
      this.log(`État connexion WebRTC : ${this.peerConnection.connectionState}`);
      if (this.peerConnection.connectionState === "connected") {
        this.onCallConnected({ callId: this.currentCallId, targetId: this.targetUserId, stream: this.remoteStream });
      } else if (this.peerConnection.connectionState === "disconnected" || this.peerConnection.connectionState === "failed") {
        this.onStatusChange("Connexion instable...");
      }
    };

    this.startVideoDiagnostics();
    return this.peerConnection;
  }

  startVideoDiagnostics() {
    if (this.videoDiagnosticsInterval) return;

    const collectStats = async () => {
      const peerConnection = this.peerConnection;
      if (!peerConnection || !["CALLING", "ACCEPTING", "CONNECTED"].includes(this.callState)) {
        this.stopVideoDiagnostics();
        return;
      }
      if (this.videoDiagnosticsInFlight) return;

      this.videoDiagnosticsInFlight = true;
      try {
        const stats = await peerConnection.getStats();
        if (this.peerConnection !== peerConnection) return;

        const isVideoReport = (report) => {
          if (report.kind === "video" || report.mediaType === "video") return true;
          const track = report.trackId && stats.get(report.trackId);
          return track?.kind === "video" || track?.mediaType === "video";
        };
        const outboundVideo = [];
        const inboundVideo = [];
        stats.forEach((report) => {
          if (!isVideoReport(report)) return;
          if (report.type === "outbound-rtp") {
            outboundVideo.push({
              bytesSent: report.bytesSent ?? null,
              framesEncoded: report.framesEncoded ?? null,
              framesSent: report.framesSent ?? null
            });
          } else if (report.type === "inbound-rtp") {
            inboundVideo.push({
              bytesReceived: report.bytesReceived ?? null,
              framesReceived: report.framesReceived ?? null,
              framesDecoded: report.framesDecoded ?? null,
              framesDropped: report.framesDropped ?? null
            });
          }
        });

        const videoTransceiver = peerConnection.getTransceivers().find((transceiver) =>
          transceiver.receiver?.track?.kind === "video" || transceiver.sender?.track?.kind === "video"
        );
        const sender = this.videoSender || videoTransceiver?.sender;
        const localTrack = sender?.track || this.localStream?.getVideoTracks()[0] || null;
        this.log("WEBRTC_VIDEO_DIAG send stats", {
          sampledAt: new Date().toISOString(),
          localTrack: localTrack ? {
            id: localTrack.id,
            enabled: localTrack.enabled,
            muted: localTrack.muted,
            readyState: localTrack.readyState
          } : null,
          senderExists: !!sender,
          senderHasTrack: !!sender?.track,
          transceiverDirection: videoTransceiver?.direction || null,
          negotiatedDirection: videoTransceiver?.currentDirection || null,
          stats: outboundVideo
        });

        const remoteVideoTracks = peerConnection.getReceivers()
          .map((receiver) => receiver.track)
          .filter((track) => track?.kind === "video")
          .map((track) => ({
            id: track.id,
            enabled: track.enabled,
            muted: track.muted,
            readyState: track.readyState
          }));
        this.log("WEBRTC_VIDEO_DIAG receive stats", {
          sampledAt: new Date().toISOString(),
          remoteTracks: remoteVideoTracks,
          stats: inboundVideo
        });
      } catch (error) {
        this.log("WEBRTC_VIDEO_DIAG stats error", {
          direction: "send+receive",
          message: error.message
        });
      } finally {
        this.videoDiagnosticsInFlight = false;
      }
    };

    collectStats();
    this.videoDiagnosticsInterval = setInterval(collectStats, 2000);
  }

  stopVideoDiagnostics() {
    if (this.videoDiagnosticsInterval) {
      clearInterval(this.videoDiagnosticsInterval);
      this.videoDiagnosticsInterval = null;
    }
  }

  handleRemoteIceCandidate(message) {
    if (!message.candidate) return;
    const candidate = new RTCIceCandidate(message.candidate);
    if (this.peerConnection && this.peerConnection.remoteDescription) {
      this.peerConnection.addIceCandidate(candidate).catch((e) => console.warn("Erreur addIceCandidate :", e));
    } else {
      this.pendingIceCandidates.push(candidate);
    }
  }

  processPendingIceCandidates() {
    if (!this.peerConnection) return;
    while (this.pendingIceCandidates.length > 0) {
      const candidate = this.pendingIceCandidates.shift();
      this.peerConnection.addIceCandidate(candidate).catch((e) => console.warn("Erreur addIceCandidate :", e));
    }
  }

  closePeerConnection() {
    this.stopVideoDiagnostics();
    if (this.peerConnection) {
      this.peerConnection.ontrack = null;
      this.peerConnection.onicecandidate = null;
      this.peerConnection.close();
      this.peerConnection = null;
    }
    this.videoSender = null;
    this.remoteStream = null;
  }

  stopLocalStream() {
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }
  }

  /* ==========================================================================
     7. CONTRÔLES AUDIO / VIDÉO EN COURS D'APPEL
     ========================================================================== */

  toggleMute() {
    if (!this.localStream) return false;
    const audioTrack = this.localStream.getAudioTracks()[0];
    if (audioTrack) {
      this.isMuted = !this.isMuted;
      audioTrack.enabled = !this.isMuted;
      this.log(`Microphone ${this.isMuted ? "coupé" : "activé"}`);
      return this.isMuted;
    }
    return false;
  }

  async toggleVideo() {
    if (!this.localStream) return false;
    if (!(await this.ensureCameraPermission())) {
      throw new Error("L'autorisation d'accès à la caméra est nécessaire pour activer la vidéo.");
    }

    const videoTrack = this.localStream.getVideoTracks()[0];
    const sender = this.videoSender || this.peerConnection?.getTransceivers()
      .find((transceiver) => transceiver.receiver.track.kind === "video")?.sender;

    if (videoTrack) {
      if (!sender) throw new Error("La connexion vidéo WebRTC n'est pas disponible.");
      await sender.replaceTrack(null);
      this.localStream.removeTrack(videoTrack);
      videoTrack.stop();
      this.isVideoOff = true;
      this.onLocalStream(this.localStream);
      return false;
    }

    if (!sender) throw new Error("La connexion vidéo WebRTC n'est pas disponible.");

    let videoStream;
    try {
      videoStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: this.currentFacingMode, width: { ideal: 640 }, height: { ideal: 480 } }
      });
      const newTrack = videoStream.getVideoTracks()[0];
      if (!newTrack) throw new Error("Aucune piste caméra n'a été créée.");
      await sender.replaceTrack(newTrack);
      this.localStream.addTrack(newTrack);
      this.hasVideo = true;
      this.isVideoOff = false;
      this.videoSender = sender;
      this.onLocalStream(this.localStream);
      return true;
    } catch (error) {
      videoStream?.getTracks().forEach((track) => track.stop());
      console.error("Erreur activation vidéo :", error);
      throw new Error("Impossible d'activer la caméra. Vérifiez son autorisation et sa disponibilité.");
    }
  }

 async switchCamera() {
  if (!this.localStream || !this.localStream.getVideoTracks().length) return;

  const previousFacingMode = this.currentFacingMode;
  this.currentFacingMode = this.currentFacingMode === "user" ? "environment" : "user";
  const oldVideoTrack = this.localStream.getVideoTracks()[0];
  let newStream = null;

  try {
    newStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { exact: this.currentFacingMode },
        width: { ideal: 640 },
        height: { ideal: 480 }
      }
    });

    const newVideoTrack = newStream.getVideoTracks()[0];
    if (!newVideoTrack) {
      throw new Error("Impossible d'obtenir la nouvelle piste vidéo");
    }

    // Récupérer le sender vidéo
    const sender = this.videoSender || this.peerConnection?.getSenders()
      .find((s) => s.track && s.track.kind === "video");

    if (!sender) {
      throw new Error("La connexion vidéo WebRTC n'est pas disponible.");
    }

    // Remplacer la piste côté WebRTC
    await sender.replaceTrack(newVideoTrack);

    // Mettre à jour le stream local
    if (oldVideoTrack) {
      this.localStream.removeTrack(oldVideoTrack);
      oldVideoTrack.stop();
    }
    this.localStream.addTrack(newVideoTrack);
    this.videoSender = sender;

    // Mettre à jour l'affichage local
    this.onLocalStream(this.localStream);

  } catch (e) {
    // En cas d'erreur, on restaure l'ancien facingMode
    this.currentFacingMode = previousFacingMode;

    // On arrête le nouveau stream s'il a été créé
    if (newStream) {
      newStream.getTracks().forEach((track) => track.stop());
    }

    console.warn("Impossible de basculer la caméra :", e);
  }
}

  setAudioOutput(mode = "EARPIECE") {
    // 1. Essai avec le plugin natif standard AudioToggle
    if (window.AudioToggle && typeof window.AudioToggle.setAudioMode === "function") {
      try {
        if (mode === "SPEAKER") window.AudioToggle.setAudioMode(window.AudioToggle.SPEAKER);
        else if (mode === "EARPIECE") window.AudioToggle.setAudioMode(window.AudioToggle.EARPIECE);
        else if (mode === "BLUETOOTH") window.AudioToggle.setAudioMode(window.AudioToggle.BLUETOOTH);
        else window.AudioToggle.setAudioMode(window.AudioToggle.NORMAL);
        this.log(`Routage audio AudioToggle : ${mode}`);
        return;
      } catch (e) {
        console.warn("Erreur AudioToggle :", e);
      }
    }

    // 2. Repli Web Standard : HTMLMediaElement.setSinkId
    const remoteAudio = document.getElementById("remoteAudio");
    if (remoteAudio && "setSinkId" in HTMLMediaElement.prototype) {
      navigator.mediaDevices.enumerateDevices().then((devices) => {
        const outputs = devices.filter((d) => d.kind === "audiooutput");
        const target = outputs.find((d) => d.label.toLowerCase().includes(mode.toLowerCase()));
        if (target) {
          remoteAudio.setSinkId(target.deviceId);
          this.log(`Routage audio Web setSinkId : ${target.label}`);
        }
      }).catch((e) => console.warn("Erreur enumerateDevices setSinkId :", e));
    }
  }

  /* ==========================================================================
     8. MOTEUR AUDIO WEB PUR (SONNERIE SYNTHÉTISÉE & WAKELOCK)
     ========================================================================== */

  initAudioContext() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) this.audioContext = new AudioCtx();
    } catch (e) {}
  }

  startRingtone() {
    this.stopRingtone();
    if (!this.audioContext) this.initAudioContext();
    if (!this.audioContext) return;

    if (this.audioContext.state === "suspended") {
      this.audioContext.resume();
    }

    const playBeep = () => {
      try {
        const osc1 = this.audioContext.createOscillator();
        const osc2 = this.audioContext.createOscillator();
        const gain = this.audioContext.createGain();

        osc1.type = "sine";
        osc1.frequency.setValueAtTime(440, this.audioContext.currentTime); // La
        osc2.type = "sine";
        osc2.frequency.setValueAtTime(480, this.audioContext.currentTime); // Si

        gain.gain.setValueAtTime(0.3, this.audioContext.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 1.2);

        osc1.connect(gain);
        osc2.connect(gain);
        gain.connect(this.audioContext.destination);

        osc1.start();
        osc2.start();
        osc1.stop(this.audioContext.currentTime + 1.2);
        osc2.stop(this.audioContext.currentTime + 1.2);
      } catch (e) {}
    };

    playBeep();
    this.ringtoneInterval = setInterval(playBeep, 2500);
  }

  stopRingtone() {
    if (this.ringtoneInterval) clearInterval(this.ringtoneInterval);
    this.ringtoneInterval = null;
  }

  startRingbackTone() {
    this.stopRingbackTone();
    if (!this.audioContext) this.initAudioContext();
    if (!this.audioContext) return;

    const playTone = () => {
      try {
        const osc = this.audioContext.createOscillator();
        const gain = this.audioContext.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(425, this.audioContext.currentTime); // Tonalité européenne standard
        gain.gain.setValueAtTime(0.15, this.audioContext.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 1.0);

        osc.connect(gain);
        gain.connect(this.audioContext.destination);

        osc.start();
        osc.stop(this.audioContext.currentTime + 1.0);
      } catch (e) {}
    };

    playTone();
    this.ringbackInterval = setInterval(playTone, 3000);
  }

  stopRingbackTone() {
    if (this.ringbackInterval) clearInterval(this.ringbackInterval);
    this.ringbackInterval = null;
  }

  vibrate(pattern = [500, 250, 500]) {
    if ("vibrate" in navigator) {
      navigator.vibrate(pattern);
    }
  }

  stopVibration() {
    if ("vibrate" in navigator) {
      navigator.vibrate(0);
    }
  }

  async acquireWakeLock() {
    try {
      if ("wakeLock" in navigator && !this.wakeLock) {
        this.wakeLock = await navigator.wakeLock.request("screen");
        this.log("Screen Wake Lock actif");
      }
    } catch (e) {}
  }

  releaseWakeLock() {
    if (this.wakeLock) {
      this.wakeLock.release().catch(() => {});
      this.wakeLock = null;
    }
  }

  enableBackgroundMode() {
    if (window.cordova?.plugins?.backgroundMode) {
      try {
        window.cordova.plugins.backgroundMode.enable();
        window.cordova.plugins.backgroundMode.setDefaults({
          title: "Appel en cours",
          text: `Communication active avec ${this.targetUserId || "le correspondant"}`,
          resume: true
        });
      } catch (e) {}
    }
  }

  disableBackgroundMode() {
    if (window.cordova?.plugins?.backgroundMode) {
      try {
        window.cordova.plugins.backgroundMode.setDefaults({
          title: "KamSoft",
          text: "Service d'appels prêt",
          icon: "ic_launcher",
          color: "00A884",
          silent: true
        });
      } catch (e) {}
    }
  }
}

// Export universel (Support navigateur global + modules)
if (typeof window !== "undefined") {
  window.CallManager = CallManager;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = CallManager;
}
