const WebSocket = require("ws");
const assert = require("node:assert/strict");

const url = process.env.MEET_WS_URL || "ws://localhost:8080";
const clients = [];

function connect(id) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error(`Délai dépassé : ${id}`)), 5000);

    ws.on("error", reject);
       
   
    ws.on("open", () => ws.send(JSON.stringify({
         type: "REGISTER",
         id,
         sessionToken: `token-${id}`
     })));


    ws.on("message", function onMessage(raw) {
      const message = JSON.parse(raw.toString());
      if (message.type !== "REGISTERED") return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      clients.push(ws);
      resolve(ws);
    });


    console.log(`[${id}] connexion à ${url}`);
ws.on("message", raw => console.log(`[${id}] reçu :`, raw.toString()));
ws.on("close", (code, reason) => console.log(`[${id}] fermé`, code, reason.toString()));


  });


  
}

function waitFor(ws, predicate, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error("Délai dépassé en attendant la réponse"));
    }, timeout);

    function onMessage(raw) {
      const message = JSON.parse(raw.toString());
      if (!predicate(message)) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(message);
    }

    ws.on("message", onMessage);
  });
}

async function request(ws, payload, predicate) {
  const response = waitFor(ws, predicate);
  ws.send(JSON.stringify(payload));
  return response;
}

(async () => {
  try {
    const host = await connect("test-host");
    const guests = [];
    for (let i = 2; i <= 5; i++) guests.push(await connect(`test-user-${i}`));

    const room = await request(
      host,
      { type: "CREATE_ROOM" },
      message => message.type === "ROOM_CREATED"
    );
    assert.match(room.code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);

    for (const guest of guests.slice(0, 3)) {
      const joined = await request(
        guest,
        { type: "JOIN_ROOM", code: room.code },
        message => message.type === "ROOM_JOINED" || message.type === "ROOM_ERROR"
      );
      assert.equal(joined.type, "ROOM_JOINED");
    }

    const full = await request(
      guests[3],
      { type: "JOIN_ROOM", code: room.code },
      message => message.type === "ROOM_ERROR"
    );
    assert.equal(full.code, "ROOM_FULL");

    const closedNotifications = [host, ...guests.slice(0, 3)].map(ws =>
      waitFor(ws, message =>
        message.type === "ROOM_CLOSED" && message.roomId === room.roomId
      )
    );
    host.send(JSON.stringify({ type: "LEAVE_ROOM", roomId: room.roomId }));
    await Promise.all(closedNotifications);

    console.log("OK : création, jonctions, ROOM_FULL au 5e et fermeture de la salle.");
  } finally {
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.close();
    }
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
