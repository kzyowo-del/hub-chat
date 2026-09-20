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

const OWNERS = ["Kzynusotheraccount"];
const STATIC_STAFFS = ["lam648291", "gshahwgsydhs"];

const roomAdmins = {};

function ensureRoom(room) {
    if (!rooms[room]) rooms[room] = [];
    if (!roomAdmins[room]) roomAdmins[room] = new Set();
}

function getStaticRole(u) {
    if (OWNERS.includes(u)) return "owner";
    if (STATIC_STAFFS.includes(u)) return "staff";
    return null;
}

function isAdmin(room, username) {
    if (OWNERS.includes(username)) return true;
    if (STATIC_STAFFS.includes(username)) return true;
    return roomAdmins[room] && roomAdmins[room].has(username);
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

function sendUserList(room, targetWs) {
    const users = (rooms[room] || [])
        .filter(c => c._username && c.readyState === WebSocket.OPEN)
        .map(c => ({
            user: c._username,
            isAdmin: isAdmin(room, c._username),
        }));

    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify({ type: "user_list", users }));

        const adminSet = roomAdmins[room] || new Set();
        const adminList = [
            ...OWNERS.filter(o => users.some(u => u.user === o)),
            ...STATIC_STAFFS.filter(s => users.some(u => u.user === s)),
            ...adminSet,
        ];
        targetWs.send(JSON.stringify({ type: "admin_list", admins: [...new Set(adminList)] }));
    }
}

function handleCmd(role, sender, room, cmd, args) {
    if (!role && !isAdmin(room, sender)) return;

    switch (cmd) {
        case "kick": {
            const [target, ...rp] = args;
            const reason = rp.join(" ") || "Kicked by admin.";
            sendToUser(target, { type: "kick", reason });
            broadcastToRoom(room, JSON.stringify({ type: "system", text: `[ADMIN] ${target} was kicked.` }));
            break;
        }
        case "ban": {
            const [target] = args;
            banned.add(target);
            sendToUser(target, { type: "kick", reason: "You are banned." });
            broadcastToRoom(room, JSON.stringify({ type: "system", text: `[ADMIN] ${target} banned.` }));
            break;
        }
        case "unban":  { banned.delete(args[0]); break; }
        case "mute":   { muted.add(args[0]); sendToUser(args[0], { type: "system", text: "You are muted." }); break; }
        case "unmute": { muted.delete(args[0]); sendToUser(args[0], { type: "system", text: "You are unmuted." }); break; }
        case "kill": {
            sendToUser(args[0], { type: "control", action: "kill", target: args[0] });
            broadcastToRoom(room, JSON.stringify({ type: "system", text: `[ADMIN] ${args[0]} was killed.` }));
            break;
        }
        case "freeze": {
            sendToUser(args[0], { type: "control", action: "freeze", target: args[0] });
            broadcastToRoom(room, JSON.stringify({ type: "system", text: `[ADMIN] ${args[0]} frozen.` }));
            break;
        }
        case "unfreeze": { sendToUser(args[0], { type: "control", action: "unfreeze", target: args[0] }); break; }
        case "tp": {
            const [target, x, y, z] = args;
            sendToUser(target, { type: "control", action: "tp", target, x: Number(x), y: Number(y), z: Number(z) });
            break;
        }
        case "speed": {
            const [target, val] = args;
            sendToUser(target, { type: "control", action: "speed", target, value: Number(val) || 16 });
            break;
        }
        case "fling": { sendToUser(args[0], { type: "control", action: "fling", target: args[0] }); break; }
        case "god": {
            const [target, toggle] = args;
            sendToUser(target, { type: "control", action: toggle === "off" ? "ungod" : "god", target });
            break;
        }
        case "announce": {
            if (!OWNERS.includes(sender)) break;
            broadcastToRoom(room, JSON.stringify({ type: "announce", text: args.join(" "), from: sender }));
            break;
        }
        case "list": {
            sendToUser(sender, { type: "system", text: "Online: " + Object.keys(userMap).join(", ") });
            break;
        }
        case "clear": {
            broadcastToRoom(room, JSON.stringify({ type: "clear" }));
            break;
        }
        default:
            sendToUser(sender, { type: "system", text: `Unknown command: /${cmd}` });
    }
}

wss.on("connection", function(ws) {
    let currentRoom = null;
    let currentUser = null;

    ws.on("message", function(data) {
        try {
            const msg = JSON.parse(data);

            if (msg.type === "join") {
                const username = (msg.user || "Unknown").trim();
                if (banned.has(username)) {
                    ws.send(JSON.stringify({ type: "kick", reason: "You are banned." }));
                    ws.close();
                    return;
                }
                currentRoom      = msg.room || "main";
                currentUser      = username;
                ws._username     = username;
                ws._room         = currentRoom;
                ensureRoom(currentRoom);
                rooms[currentRoom].push(ws);
                userMap[currentUser] = ws;
                sendUserList(currentRoom, ws);
                broadcastToRoom(currentRoom, JSON.stringify({ type: "system", text: `${currentUser} joined.` }));
                broadcastOnline(currentRoom);
                return;
            }

            if (!currentRoom || !currentUser) return;

            if (msg.type === "chat") {
                if (muted.has(currentUser)) {
                    sendToUser(currentUser, { type: "system", text: "You are muted." });
                    return;
                }
                const text = (msg.text || "").trim();
                if (!text) return;
                if (text.startsWith("/") && (getStaticRole(currentUser) || isAdmin(currentRoom, currentUser))) {
                    const parts = text.slice(1).trim().split(/\s+/);
                    handleCmd(getStaticRole(currentUser), currentUser, currentRoom, parts[0].toLowerCase(), parts.slice(1));
                    return;
                }
                const role = getStaticRole(currentUser) || (isAdmin(currentRoom, currentUser) ? "admin" : null);
                const filtered = filterBadWords(text);
                broadcastToRoom(currentRoom, JSON.stringify({ type: "chat", user: currentUser, role, text: filtered }));
                return;
            }

            if (msg.type === "control") {
                if (!isAdmin(currentRoom, currentUser)) {
                    sendToUser(currentUser, { type: "system", text: "No permission." });
                    return;
                }
                const target = msg.target;
                const action = msg.action;
                if (target === "*") {
                    (rooms[currentRoom] || []).forEach(c => {
                        if (c !== ws && c.readyState === WebSocket.OPEN) c.send(JSON.stringify(msg));
                    });
                } else {
                    const targetWs = userMap[target];
                    if (targetWs && targetWs.readyState === WebSocket.OPEN) targetWs.send(JSON.stringify(msg));
                }
                const logActions = ["kill","freeze","unfreeze","fling","god","ungod","mute","unmute","tp","speed","silent_on","enable_autoload"];
                if (logActions.includes(action)) {
                    broadcastToRoom(currentRoom, JSON.stringify({
                        type: "system",
                        text: `[ADMIN:${currentUser}] ${action.toUpperCase()} → ${target}`,
                    }));
                }
                return;
            }

            if (msg.type === "grant_admin") {
                if (!isAdmin(currentRoom, currentUser)) {
                    sendToUser(currentUser, { type: "system", text: "No permission." });
                    return;
                }
                const target = msg.target;
                if (!target) return;
                roomAdmins[currentRoom].add(target);
                broadcastToRoom(currentRoom, JSON.stringify({ type: "admin_update", action: "grant", target }));
                broadcastToRoom(currentRoom, JSON.stringify({ type: "system", text: `⭐ ${target} granted admin by ${currentUser}.` }));
                return;
            }

            if (msg.type === "revoke_admin") {
                if (!isAdmin(currentRoom, currentUser)) {
                    sendToUser(currentUser, { type: "system", text: "No permission." });
                    return;
                }
                const target = msg.target;
                if (!target) return;
                roomAdmins[currentRoom].delete(target);
                broadcastToRoom(currentRoom, JSON.stringify({ type: "admin_update", action: "revoke", target }));
                broadcastToRoom(currentRoom, JSON.stringify({ type: "system", text: `🔒 ${target} lost admin by ${currentUser}.` }));
                return;
            }

            if (msg.type === "kick_user") {
                if (!isAdmin(currentRoom, currentUser)) {
                    sendToUser(currentUser, { type: "system", text: "No permission." });
                    return;
                }
                const target = msg.target;
                sendToUser(target, { type: "kick", reason: msg.reason || "Kicked by admin." });
                broadcastToRoom(currentRoom, JSON.stringify({ type: "system", text: `🚪 ${target} was kicked by ${currentUser}.` }));
                return;
            }

            if (msg.type === "clear_chat") {
                if (!isAdmin(currentRoom, currentUser)) {
                    sendToUser(currentUser, { type: "system", text: "No permission." });
                    return;
                }
                broadcastToRoom(currentRoom, JSON.stringify({ type: "clear" }));
                return;
            }

        } catch(e) {
            console.log("Parse error:", e.message);
        }
    });

    ws.on("close", function() {
        if (currentUser) delete userMap[currentUser];
        if (currentRoom && rooms[currentRoom]) {
            rooms[currentRoom] = rooms[currentRoom].filter(c => c !== ws);
            if (rooms[currentRoom].length > 0) {
                broadcastToRoom(currentRoom, JSON.stringify({ type: "system", text: `${currentUser} left.` }));
                broadcastOnline(currentRoom);
            } else {
                delete rooms[currentRoom];
                delete roomAdmins[currentRoom];
            }
        }
    });

    ws.on("error", function(err) {
        console.log("WS error:", err.message);
    });
});
