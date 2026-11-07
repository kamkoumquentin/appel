(function (global) {
  const turnServer = {
    urls: [
      "turn:VOTRE_SERVEUR_TURN:3478?transport=udp",
      "turn:VOTRE_SERVEUR_TURN:3478?transport=tcp",
      "turns:VOTRE_SERVEUR_TURN:443?transport=tcp"
    ],
    username: "",
    credential: ""
  };

  const iceServers = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ];

  if (turnServer.username.trim() && turnServer.credential.trim() &&
      turnServer.urls.every((url) => !url.includes("VOTRE_SERVEUR_TURN"))) {
    iceServers.push({
      urls: turnServer.urls,
      username: turnServer.username,
      credential: turnServer.credential
    });
  }

  const params = new URLSearchParams(global.location.search);
  const serverOverride = params.get("server");
  const productionServerUrl = "wss://serveur-appel.onrender.com";
  const localServerUrl = "ws://localhost:8080";

  let serverUrl;
  if (serverOverride === "prod") {
    serverUrl = productionServerUrl;
  } else if (serverOverride === "local") {
    serverUrl = localServerUrl;
  } else {
    serverUrl = global.location.protocol === "http:" &&
      global.location.hostname === "localhost" &&
      global.location.port !== ""
      ? localServerUrl
      : productionServerUrl;
  }

  console.log(`[Config] serveur utilisé : ${serverUrl}`);

  global.APP_CONFIG = {
    serverUrl,
    httpServerUrl: serverUrl.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:"),
    iceServers
  };
})(window);
