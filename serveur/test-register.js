const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const EventEmitter = require("node:events");

const serverSource = fs.readFileSync(path.join(__dirname, "..", "serveur.js"), "utf8");

class FakeWSS extends EventEmitter {
  constructor() { super(); this.clients = new Set(); }
}

class FakeWS extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.sent = []; }
  send(data) { this.sent.push(JSON.parse(data)); }
  close(code, reason) {
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3;
    this.emit("close");
  }
  terminate() { this.readyState = 3; this.emit("close"); }
}

const wss = new FakeWSS();
const warnings = [];
const fakeRequire = (name) => {
  if (name === "http") return { createServer: () => ({ listen() {} }) };
  if (name === "ws") return { Server: class { constructor() { return wss; } }, OPEN: 1 };
  if (name === "fs") return fs;
  if (name === "path") return path;
  if (name === "crypto") return require("node:crypto");
  if (name === "firebase-admin/app") return { initializeApp() {}, cert: (value) => value };
  if (name === "firebase-admin/messaging") return { getMessaging: () => ({ send: async () => "ok" }) };
  if (name === "./firebase-key.json" || name === "/etc/secrets/firebase-key.json") {
    return { project_id: "test", private_key: "test", client_email: "test" };
  }
  throw new Error(`Unexpected require: ${name}`);
};

vm.runInNewContext(serverSource, {
  require: fakeRequire,
  __dirname: path.dirname(path.join(__dirname, "..", "serveur.js")),
  process: { env: {} },
  console: { log() {}, warn: (...args) => warnings.push(args.join(" ")), error() {} },
  Buffer, URL,
  setInterval: () => 1,
  clearInterval() {},
  Date, Map, Set, Array, String, Number, Math, JSON, Promise
}, { filename: "serveur.js" });

function connect(id, sessionToken) {
  const ws = new FakeWS();
  wss.emit("connection", ws);
  const message = { type: "REGISTER", id };
  if (sessionToken !== undefined) message.sessionToken = sessionToken;
  ws.emit("message", Buffer.from(JSON.stringify(message)));
  return ws;
}

function send(ws, message) {
  ws.emit("message", Buffer.from(JSON.stringify(message)));
}

function hasMessage(ws, type, predicate = () => true) {
  return ws.sent.some((message) => message.type === type && predicate(message));
}

const protectedSocket = connect("protected-user", "correct-token");
assert.ok(hasMessage(protectedSocket, "REGISTERED"), "première inscription avec jeton acceptée");

const badTokenSocket = connect("protected-user", "wrong-token");
assert.ok(hasMessage(badTokenSocket, "ERROR", (message) => message.code === "ID_ALREADY_CONNECTED"));
assert.equal(badTokenSocket.closeCode, 1008);

const missingTokenSocket = connect("protected-user");
assert.ok(hasMessage(missingTokenSocket, "ERROR", (message) => message.code === "ID_ALREADY_CONNECTED"));
assert.equal(missingTokenSocket.closeCode, 1008);

const reconnectedSocket = connect("protected-user", "correct-token");
assert.ok(hasMessage(reconnectedSocket, "REGISTERED"), "reconnexion avec le bon jeton acceptée");
assert.equal(protectedSocket.readyState, 3, "ancien socket remplacé");

const legacySocket = connect("legacy-user");
assert.ok(hasMessage(legacySocket, "REGISTERED"), "client historique sans jeton accepté");
send(legacySocket, { type: "CREATE_ROOM" });
assert.ok(hasMessage(legacySocket, "ROOM_ERROR", (message) => message.code === "AUTH_REQUIRED"));
assert.ok(warnings.some((warning) => warning.includes("sans jeton de session")));

const legacyPeer = connect("legacy-peer");
send(legacyPeer, { type: "SET_APP_STATE", isForeground: true });
send(legacySocket, {
  type: "CALLING",
  to: "legacy-peer",
  callId: "legacy-call",
  offer: { type: "offer", sdp: "test" }
});
assert.ok(
  hasMessage(legacyPeer, "incoming-call", (message) => message.callId === "legacy-call"),
  "appel 1-à-1 historique accepté"
);

console.log("PASS: mauvais jeton refusé, jeton absent sur ID protégé refusé, bon jeton accepté, salle sans jeton refusée, appels 1-à-1 historiques préservés.");
