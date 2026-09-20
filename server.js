const WebSocket = require("ws");

const port = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port });

console.log("Hub running on port " + port);

const ADMINS = {
    owners: ["Kzynusotheraccount"],
    staffs: ["lam648291", "gshahwgsydhs"],
};

function getRole(u) {
    if (ADMINS.owners.includes(u)) return "owner";
    if (ADMINS.staffs.includes(u)) return "staff";
    return null;
}

const BAD_WORDS = [
    "nigger","nigga","fuck","shit","bitch","dick","pussy","cunt",
    "địt","lồn","cặc","buồi","đụ","đéo","mẹ mày","bố mày",
];

function filterBadWords(text) {
    let r = text;
    for (const w of BAD_WORDS) {
        const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        r = r.replace(new RegExp(`\\b${esc}\\b`, "gi"), "*".repeat(w.length));
    }
    return r;
}

let rooms   = {};
let userMap = {};
let muted   = new Set();
let banned  = new Set();

function broadcastToRoom(room, payload) {
    (rooms[room] || []).forEach(c => {
        if (c.readyState === WebSocket.OPEN) c.send(payload);
    });
}

function sendToUser(username, obj) {
    const ws = userMap[username];
    if (ws && ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify(obj));
}

function broadcastOnline(room) {
    const active = (rooms[room] || []).filter(c => c.readyState === WebSocket.OPEN);
    broadcastToRoom(room, JSON.stringify({ type: "online_count", count: active.length }));
}

function handleCmd(role, sender, room, cmd, args) {
    if (!role) return;
    switch (cmd) {
        case "kick": {
            const [target, ...rp] = args;
            const reason = rp.join(" ") || "Kicked by admin.";
            sendToUser(target, { type: "kick", reason });
            broadcastToRoom(room, JSON.stringify({ type: "system", text: `[ADMIN] ${target} kicked.` }));
            break;
        }
        case "ban": {
            const [target] = args;
            banned.add(target);
            sendToUser(target, { type: "kick", reason: "You are banned." });
            broadcastToRoom(room, JSON.stringify({ type: "system", text: `[ADMIN] ${target} banned.` }));
            break;
        }
        case "unban":   { banned.delete(args[0]); break; }
        case "mute":    { muted.add(args[0]);     sendToUser(args[0], { type: "system", text: "You are muted." }); break; }
        case "unmute":  { muted.delete(args[0]);  sendToUser(args[0], { type: "system", text: "You are unmuted." }); break; }
        case "kill": {
            sendToUser(args[0], { type: "control", action: "kill" });
            broadcastToRoom(room, JSON.stringify({ type: "system", text: `[ADMIN] ${args[0]} was killed.` }));
            break;
        }
        case "freeze": {
            sendToUser(args[0], { type: "control", action: "freeze" });
            broadcastToRoom(room, JSON.stringify({ type: "system", text: `[ADMIN] ${args[0]} frozen.` }));
            break;
        }
        case "unfreeze": { sendToUser(args[0], { type: "control", action: "unfreeze" }); break; }
        case "tp": {
            const [target, x, y, z] = args;
            sendToUser(target, { type: "control", action: "tp", x: Number(x), y: Number(y), z: Number(z) });
            break;
        }
        case "speed": {
            const [target, val] = args;
            sendToUser(target, { type: "control", action: "speed", value: Number(val) || 16 });
            break;
        }
        case "fling": { sendToUser(args[0], { type: "control", action: "fling" }); break; }
        case "god": {
            const [target, toggle] = args;
            sendToUser(target, { type: "control", action: "god", enabled: toggle !== "off" });
            break;
        }
        case "announce": {
            if (role !== "owner") break;
            broadcastToRoom(room, JSON.stringify({ type: "announce", text: args.join(" "), from: sender }));
            break;
        }
        case "list": {
            sendToUser(sender, { type: "system", text: "Online: " + Object.keys(userMap).join(", ") });
            break;
        }
        case "clear": {
            if (role !== "owner") break;
            broadcastToRoom(room, JSON.stringify({ type: "clear" }));
            break;
        }
        default:
            sendToUser(sender, { type: "system", text: `Unknown: /${cmd}` });
    }
}

wss.on("connection", function(ws) {
    let currentRoom = null;
    let currentUser = null;

    ws.on("message", function(data) {
        try {
            const msg = JSON.parse(data);

            if (msg.type === "join") {
                const username = msg.user || "Unknown";
                if (banned.has(username)) {
                    ws.send(JSON.stringify({ type: "kick", reason: "You are banned." }));
                    ws.close();
                    return;
                }
                currentRoom = msg.room;
                currentUser = username;
                if (!rooms[currentRoom]) rooms[currentRoom] = [];
                rooms[currentRoom].push(ws);
                userMap[currentUser] = ws;
                broadcastOnline(currentRoom);
                broadcastToRoom(currentRoom, JSON.stringify({ type: "system", text: `${currentUser} joined.` }));
            }

            if (msg.type === "chat" && currentRoom) {
                const role = getRole(msg.user);
                const text = msg.text || "";
                if (muted.has(msg.user)) {
                    sendToUser(msg.user, { type: "system", text: "You are muted." });
                    return;
                }
                if (text.startsWith("/") && role) {
                    const parts = text.slice(1).trim().split(/\s+/);
                    handleCmd(role, msg.user, currentRoom, parts[0].toLowerCase(), parts.slice(1));
                    return;
                }
                const filtered = filterBadWords(text);
                broadcastToRoom(currentRoom, JSON.stringify({
                    type: "chat", user: msg.user, role, text: filtered,
                }));
            }
        } catch(e) { console.log("err:", e.message); }
    });

    ws.on("close", function() {
        if (currentUser) delete userMap[currentUser];
        if (currentRoom && rooms[currentRoom]) {
            rooms[currentRoom] = rooms[currentRoom].filter(c => c !== ws);
            broadcastOnline(currentRoom);
            if (rooms[currentRoom].length === 0) delete rooms[currentRoom];
        }
    });
});
