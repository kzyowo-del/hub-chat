const http = require("http");
const WebSocket = require("ws");

const port = process.env.PORT || 3000;

// HTTP server để Render health check / UptimeRobot ping
const httpServer = http.createServer((req, res) => {
    res.writeHead(200);
    res.end("ok");
});

const wss = new WebSocket.Server({ server: httpServer });

httpServer.listen(port, () => {
    console.log("Hub running on port " + port);
});

// =====================
// STATIC ROLES
// =====================
const OWNERS = ["Kzynusotheraccount"];
const STATIC_STAFFS = ["lam648291", "gshahwgsydhs"];

const roomAdmins = {};

function ensureRoom(room) {
    if (!rooms[room]) rooms[room] = [];
    if (!roomAdmins[room]) roomAdmins[room] = new Set();
}
