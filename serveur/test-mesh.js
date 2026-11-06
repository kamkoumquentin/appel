const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const EventEmitter = require("node:events");

const serverPath = path.join(__dirname, "..", "serveur.js");
const serverSource = fs.readFileSync(serverPath, "utf8");

class FakeWSS extends EventEmitter {
  constructor() {
    super();
    this.clients = new Set();
  }
}

class FakeWS extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
  }
  send(data) { this.sent.push(JSON.parse(data)); }
  close(code, reason) {
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3;
    this.emit("close");
  }
  terminate() {
    this.readyState = 3;
    this.emit("close");
  }
}

const wss = new FakeWSS();
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
  __dirname: path.dirname(serverPath),
  process: { env: {} },
  console: { log() {}, warn() {}, error() {} },
  Buffer,
  URL,
  setInterval: () => 1,
  clearInterval() {},
  Date,
  Map,
  Set,
  Array,
  String,
  Number,
  Math,
  JSON,
  Promise
}, { filename: "serveur.js" });

function connect(id) {
  const ws = new FakeWS();
  wss.emit("connection", ws);
  ws.emit("message", Buffer.from(JSON.stringify({
    type: "REGISTER",
    id,
    sessionToken: `token-${id}`
  })));
  return ws;
}

function send(ws, message) {
  ws.emit("message", Buffer.from(JSON.stringify(message)));
}

function messagesOfType(ws, type) {
  return ws.sent.filter((message) => message.type === type);
}

const host = connect("host");
const recipient = connect("recipient");
const otherRoomMember = connect("other-member");
const outsider = connect("outsider");

send(host, { type: "CREATE_ROOM" });
const created = messagesOfType(host, "ROOM_CREATED")[0];
assert.ok(created, "l’hôte crée une salle");

for (const client of [recipient, otherRoomMember]) {
  send(client, { type: "JOIN_ROOM", code: created.code });
}
assert.ok(messagesOfType(recipient, "ROOM_JOINED")[0], "le destinataire rejoint la salle");
assert.ok(messagesOfType(otherRoomMember, "ROOM_JOINED")[0], "le troisième membre rejoint la salle");

send(host, { type: "CALLING", to: "outsider", callId: "call-during-room" });
assert.ok(
  messagesOfType(host, "BUSY").some((message) => message.message.includes("réunion")),
  "un appel 1-à-1 lancé depuis une salle est refusé"
);

for (const client of [host, recipient, otherRoomMember, outsider]) client.sent.length = 0;
send(host, {
  type: "ROOM_OFFER",
  roomId: created.roomId,
  to: "recipient",
  from: "forged-sender",
  payload: { type: "offer", sdp: "test-offer" }
});

const receivedOffers = messagesOfType(recipient, "ROOM_OFFER");
assert.equal(receivedOffers.length, 1, "l’offre est remise une seule fois au destinataire");
assert.equal(receivedOffers[0].from, "host", "le serveur remplace le from falsifié par l’id authentifié");
assert.equal(messagesOfType(host, "ROOM_OFFER").length, 0, "l’expéditeur ne reçoit pas l’offre");
assert.equal(messagesOfType(otherRoomMember, "ROOM_OFFER").length, 0, "les autres membres ne reçoivent pas l’offre");
assert.equal(messagesOfType(outsider, "ROOM_OFFER").length, 0, "un utilisateur extérieur ne reçoit pas l’offre");

send(host, {
  type: "ROOM_OFFER",
  roomId: created.roomId,
  to: "outsider",
  from: "host",
  payload: { type: "offer", sdp: "must-not-arrive" }
});
assert.ok(
  messagesOfType(host, "ROOM_ERROR").some((message) => message.code === "NOT_IN_ROOM"),
  "le serveur refuse un destinataire hors de la salle"
);
assert.equal(messagesOfType(outsider, "ROOM_OFFER").length, 0, "l’offre refusée n’est jamais transmise");

const caller = connect("caller");
const callee = connect("callee");
send(callee, { type: "SET_APP_STATE", isForeground: true });
send(caller, { type: "CALLING", to: "callee", callId: "call-before-room" });
send(caller, { type: "CREATE_ROOM" });
assert.ok(
  messagesOfType(caller, "ROOM_ERROR").some((message) => message.code === "CALL_ACTIVE"),
  "une salle ne peut pas être créée pendant un appel 1-à-1"
);

console.log("PASS: relais ciblé, from falsifié ignoré, hors-salle refusé et appels/salles mutuellement exclusifs.");
