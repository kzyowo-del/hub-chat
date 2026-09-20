const http = require("http");
const WebSocket = require("ws");

const port = process.env.PORT || 3000;

const httpServer = http.createServer((req, res) => {
    res.writeHead(200, {
        "Content-Type": "text/plain",
        "Connection": "close"
    });
    res.end("ok");
});

const wss = new WebSocket.Server({ server: httpServer });

httpServer.listen(port, "0.0.0.0", () => {
    console.log("Hub running on port " + port);
});

const OWNERS = ["kzynusOtheraccount"];
const STATIC_STAFFS = ["lam648291", "gshahwgsydhs"];

const roomAdmins = {};

function ensureRoom(room) {
    if (!rooms[room]) rooms[room] = [];
    if (!roomAdmins[room]) roomAdmins[room] = new Set();
}
