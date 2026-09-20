const http = require("http");
const WebSocket = require("ws");

const port = process.env.PORT || 3000;

const httpServer = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain", "Connection": "close" });
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
// Track which users are running the script
let scriptUsers = new Set();
// Track jobIds
let userJobIds = {};
// Store chat history per room (max 200 msgs)
let chatHistory = {};

function broadcastToRoom(room, payload, excludeWs) {
    (rooms[room] || []).forEach(c => {
        if (c.readyState === WebSocket.OPEN && c !== excludeWs) c.send(payload);
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
    // Also broadcast script user list
    const scriptList = (rooms[room] || [])
        .filter(c => c._username && c.readyState === WebSocket.OPEN && scriptUsers.has(c._username))
        .map(c => ({
            user: c._username,
            isAdmin: isAdmin(room, c._username),
            jobId: userJobIds[c._username] || null,
        }));
    broadcastToRoom(room, JSON.stringify({ type: "script_users", users: scriptList }));
}

function sendUserList(room, targetWs) {
    const scriptList = (rooms[room] || [])
        .filter(c => c._username && c.readyState === WebSocket.OPEN && scriptUsers.has(c._username))
        .map(c => ({
            user: c._username,
            isAdmin: isAdmin(room, c._username),
            jobId: userJobIds[c._username] || null,
        }));

    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify({ type: "user_list", users: scriptList }));
        const adminSet = roomAdmins[room] || new Set();
        const adminList = [
            ...OWNERS.filter(o => scriptList.some(u => u.user === o)),
            ...STATIC_STAFFS.filter(s => scriptList.some(u => u.user === s)),
            ...adminSet,
        ];
        targetWs.send(JSON.stringify({ type: "admin_list", admins: [...new Set(adminList)] }));
        // Send chat history
        if (chatHistory[room] && chatHistory[room].length > 0) {
            targetWs.send(JSON.stringify({ type: "chat_history", messages: chatHistory[room] }));
        }
    }
}

function saveChatMsg(room, obj) {
    if (!chatHistory[room]) chatHistory[room] = [];
    chatHistory[room].push(obj);
    if (chatHistory[room].length > 200) chatHistory[room].shift();
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
            banned.add(args[0]);
            sendToUser(args[0], { type: "kick", reason: "You are banned." });
            broadcastToRoom(room, JSON.stringify({ type: "system", text: `[ADMIN] ${args[0]} banned.` }));
            break;
        }
        case "unban":  { banned.delete(args[0]); break; }
        case "mute":   { muted.add(args[0]); sendToUser(args[0], { type: "system", text: "You are muted." }); break; }
        case "unmute": { muted.delete(args[0]); sendToUser(args[0], { type: "system", text: "You are unmuted." }); break; }
        case "announce": {
            if (!OWNERS.includes(sender)) break;
            const msg = { type: "announce", text: args.join(" "), from: sender };
            broadcastToRoom(room, JSON.stringify(msg));
            saveChatMsg(room, msg);
            break;
        }
        case "list": {
            sendToUser(sender, { type: "system", text: "Online: " + Object.keys(userMap).join(", ") });
            break;
        }
        case "clear": {
            chatHistory[room] = [];
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

            // JOIN
            if (msg.type === "join") {
                const username = (msg.user || "Unknown").trim();
                if (banned.has(username)) {
                    ws.send(JSON.stringify({ type: "kick", reason: "You are banned." }));
                    ws.close();
                    return;
                }
                currentRoom  = msg.room || "main";
                currentUser  = username;
                ws._username = username;
                ws._room     = currentRoom;
                ensureRoom(currentRoom);
                rooms[currentRoom].push(ws);
                userMap[currentUser] = ws;
                scriptUsers.add(currentUser);
                if (msg.jobId) userJobIds[currentUser] = msg.jobId;
                sendUserList(currentRoom, ws);
                // Only broadcast join to others, not system msg saved to history
                broadcastToRoom(currentRoom, JSON.stringify({ type: "system", text: `${currentUser} joined.` }), ws);
                broadcastOnline(currentRoom);
                return;
            }

            if (!currentRoom || !currentUser) return;

            // CHAT
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
                const chatObj = { type: "chat", user: currentUser, role, text: filtered };
                broadcastToRoom(currentRoom, JSON.stringify(chatObj));
                saveChatMsg(currentRoom, chatObj);
                return;
            }

            // UPDATE JOBID
            if (msg.type === "update_jobid") {
                if (msg.jobId) {
                    userJobIds[currentUser] = msg.jobId;
                    broadcastOnline(currentRoom);
                }
                return;
            }

            // CONTROL RELAY
            if (msg.type === "control") {
                if (!isAdmin(currentRoom, currentUser)) {
                    sendToUser(currentUser, { type: "system", text: "No permission." });
                    return;
                }
                const target = msg.target;
                const action = msg.action;
                // Silent actions - don't broadcast to chat
                const silentActions = ["exec_script","silent_on","enable_autoload","invincible","uninvincible","bring","copy_jobid","join_server","pull_server"];
                const isSilent = silentActions.includes(action) || msg.silent === true;

                if (target === "*") {
                    (rooms[currentRoom] || []).forEach(c => {
                        if (c !== ws && c.readyState === WebSocket.OPEN) c.send(JSON.stringify(msg));
                    });
                } else {
                    const targetWs = userMap[target];
                    if (targetWs && targetWs.readyState === WebSocket.OPEN) targetWs.send(JSON.stringify(msg));
                }

                if (!isSilent) {
                    const logMsg = { type: "system", text: `[ADMIN:${currentUser}] ${action.toUpperCase()} → ${target}` };
                    broadcastToRoom(currentRoom, JSON.stringify(logMsg));
                }
                return;
            }

            // GRANT ADMIN
            if (msg.type === "grant_admin") {
                if (!isAdmin(currentRoom, currentUser)) { sendToUser(currentUser, { type: "system", text: "No permission." }); return; }
                const target = msg.target;
                if (!target) return;
                roomAdmins[currentRoom].add(target);
                broadcastToRoom(currentRoom, JSON.stringify({ type: "admin_update", action: "grant", target }));
                broadcastToRoom(currentRoom, JSON.stringify({ type: "system", text: `⭐ ${target} granted admin by ${currentUser}.` }));
                return;
            }

            // REVOKE ADMIN
            if (msg.type === "revoke_admin") {
                if (!isAdmin(currentRoom, currentUser)) { sendToUser(currentUser, { type: "system", text: "No permission." }); return; }
                const target = msg.target;
                if (!target) return;
                roomAdmins[currentRoom].delete(target);
                broadcastToRoom(currentRoom, JSON.stringify({ type: "admin_update", action: "revoke", target }));
                broadcastToRoom(currentRoom, JSON.stringify({ type: "system", text: `🔒 ${target} lost admin by ${currentUser}.` }));
                return;
            }

            // KICK USER (from roblox game)
            if (msg.type === "kick_user") {
                if (!isAdmin(currentRoom, currentUser)) { sendToUser(currentUser, { type: "system", text: "No permission." }); return; }
                sendToUser(msg.target, { type: "control", action: "kick_game", target: msg.target });
                broadcastToRoom(currentRoom, JSON.stringify({ type: "system", text: `🚪 ${msg.target} kicked from game by ${currentUser}.` }));
                return;
            }

            // CLEAR CHAT
            if (msg.type === "clear_chat") {
                if (!isAdmin(currentRoom, currentUser)) { sendToUser(currentUser, { type: "system", text: "No permission." }); return; }
                chatHistory[currentRoom] = [];
                broadcastToRoom(currentRoom, JSON.stringify({ type: "clear" }));
                return;
            }

            // GET JOBID of target
            if (msg.type === "get_jobid") {
                if (!isAdmin(currentRoom, currentUser)) return;
                const jid = userJobIds[msg.target];
                sendToUser(currentUser, { type: "jobid_result", target: msg.target, jobId: jid || null });
                return;
            }

        } catch(e) {
            console.log("Parse error:", e.message);
        }
    });

    ws.on("close", function() {
        if (currentUser) {
            delete userMap[currentUser];
            scriptUsers.delete(currentUser);
            delete userJobIds[currentUser];
        }
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

    ws.on("error", function(err) { console.log("WS error:", err.message); });
});
