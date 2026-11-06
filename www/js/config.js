(function (global) {
  const turnServer = {
    urls: "",
    username: "",
    credential: ""
  };

  const iceServers = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ];

  if (turnServer.urls.trim() && turnServer.username.trim() && turnServer.credential.trim()) {
    iceServers.push(turnServer);
  }

  global.APP_CONFIG = {
    serverUrl: "wss://serveur-appel.onrender.com",
    iceServers
  };
})(window);
