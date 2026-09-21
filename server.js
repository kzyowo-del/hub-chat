// MiyooOwnerPanel v7.1 — server_v7.js
// by kzynusOtheraccount & Verity
// Changes v7.1:
//   • Added ping handler for keepalive
//   • Added silent_off to silentActions
//   • Fixed exec_relay for Op Executor support

const http       = require("http");
const WebSocket  = require("ws");

const port = process.env.PORT || 3000;

const httpServer = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain", "Connection": "close" });
    res.end("ok");
});

const wss = new WebSocket.Server({ server: httpServer });

httpServer.listen(port, "0.0.0.0", () => {
    console.log("MiyooOwnerPanel v7.1 running on port " + port);
});

// ─────────────────────────────────────────────────────────────────────────────
// STATIC ROLES
// ─────────────────────────────────────────────────────────────────────────────
const STATIC_OWNERS = ["kzynusOtheraccount"];
const STATIC_VIPS   = [];

const roomRoles = {};

function ensureRoom(room) {
    if (!rooms[room])     rooms[room]     = [];
    if (!roomRoles[room]) roomRoles[room] = {};
}

function getRole(room, username) {
    if (STATIC_OWNERS.includes(username)) return "owner";
    if (STATIC_VIPS.includes(username))   return "vip";
    const rr = roomRoles[room];
    if (rr && rr[username]) return rr[username];
    return "user";
}

function isOwner(room, username) { return getRole(room, username) === "owner"; }
function isVip(room, username)   { const r = getRole(room, username); return r === "owner" || r === "vip"; }
function canControl(room, username) { return isOwner(room, username); }

// ─────────────────────────────────────────────────────────────────────────────
// BAD WORD FILTER
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────────────────
let rooms       = {};
let userMap     = {};
let muted       = new Set();
let banned      = new Set();
let scriptUsers = new Set();
let userJobIds  = {};
let chatHistory = {};
let posSharing  = new Set();

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function broadcastToRoom(room, payload, excludeWs) {
    (rooms[room] || []).forEach(c => {
        if (c.readyState === WebSocket.OPEN && c !== excludeWs)
            c.send(payload);
    });
}

function broadcastToOwners(room, payload, excludeWs) {
    (rooms[room] || []).forEach(c => {
        if (c.readyState === WebSocket.OPEN
            && c !== excludeWs
            && c._username
            && isOwner(room, c._username))
        {
            c.send(payload);
        }
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
    const scriptList = (rooms[room] || [])
        .filter(c => c._username && c.readyState === WebSocket.OPEN && scriptUsers.has(c._username))
        .map(c => ({
            user:  c._username,
            role:  getRole(room, c._username),
            jobId: userJobIds[c._username] || null,
        }));
    broadcastToRoom(room, JSON.stringify({ type: "script_users", users: scriptList }));
}

function sendUserList(room, targetWs) {
    const scriptList = (rooms[room] || [])
        .filter(c => c._username && c.readyState === WebSocket.OPEN && scriptUsers.has(c._username))
        .map(c => ({
            user:  c._username,
            role:  getRole(room, c._username),
            jobId: userJobIds[c._username] || null,
        }));
    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify({ type: "user_list", users: scriptList }));
        if (chatHistory[room] && chatHistory[room].length > 0)
            targetWs.send(JSON.stringify({ type: "chat_history", messages: chatHistory[room] }));
    }
}

function saveChatMsg(room, obj) {
    if (!chatHistory[room]) chatHistory[room] = [];
    chatHistory[room].push(obj);
    if (chatHistory[room].length > 200) chatHistory[room].shift();
}

// ─────────────────────────────────────────────────────────────────────────────
// CONNECTION
// ─────────────────────────────────────────────────────────────────────────────
wss.on("connection", function(ws) {
    let currentRoom = null;
    let currentUser = null;

    ws.on("message", function(data) {
        try {
            const msg = JSON.parse(data);

            // ── JOIN ──────────────────────────────────────────────────────────
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

                if (msg.jobId && msg.jobId !== "")
                    userJobIds[currentUser] = msg.jobId;

                const myRole = getRole(currentRoom, currentUser);
                ws.send(JSON.stringify({ type: "my_role", role: myRole }));
                sendUserList(currentRoom, ws);
                broadcastToRoom(currentRoom, JSON.stringify({
                    type: "system", text: `${currentUser} joined.`
                }), ws);
                broadcastOnline(currentRoom);
                return;
            }

            if (!currentRoom || !currentUser) return;

            // ── PING (Keepalive) ──────────────────────────────────────────────
            if (msg.type === "ping") {
                ws.send(JSON.stringify({ type: "pong" }));
                return;
            }

            // ── CHAT ──────────────────────────────────────────────────────────
            if (msg.type === "chat") {
                if (muted.has(currentUser)) {
                    sendToUser(currentUser, { type: "system", text: "You are muted." });
                    return;
                }
                const text = (msg.text || "").trim();
                if (!text) return;

                if (text.startsWith("/") && isOwner(currentRoom, currentUser)) {
                    const parts = text.slice(1).trim().split(/\s+/);
                    const cmd   = parts[0].toLowerCase();
                    const args  = parts.slice(1);
                    switch (cmd) {
                        case "kick":   sendToUser(args[0], { type: "kick", reason: args.slice(1).join(" ") || "Kicked." }); break;
                        case "ban":    banned.add(args[0]); sendToUser(args[0], { type: "kick", reason: "Banned." }); break;
                        case "unban":  banned.delete(args[0]); break;
                        case "mute":   muted.add(args[0]);    sendToUser(args[0], { type: "system", text: "You are muted." }); break;
                        case "unmute": muted.delete(args[0]); sendToUser(args[0], { type: "system", text: "You are unmuted." }); break;
                        case "clear":  chatHistory[currentRoom] = []; broadcastToRoom(currentRoom, JSON.stringify({ type: "clear" })); break;
                        case "announce": {
                            const announceText = args.join(" ");
                            broadcastToRoom(currentRoom, JSON.stringify({
                                type: "announce_exec",
                                text: announceText,
                                from: currentUser,
                                target: "*",
                            }));
                            const m = { type: "announce", text: announceText, from: currentUser };
                            broadcastToRoom(currentRoom, JSON.stringify(m));
                            saveChatMsg(currentRoom, m);
                            break;
                        }
                    }
                    return;
                }

                const role     = getRole(currentRoom, currentUser);
                const filtered = filterBadWords(text);
                const chatObj  = { type: "chat", user: currentUser, role, text: filtered };
                broadcastToRoom(currentRoom, JSON.stringify(chatObj));
                saveChatMsg(currentRoom, chatObj);
                return;
            }

            // ── UPDATE JOBID ──────────────────────────────────────────────────
            if (msg.type === "update_jobid") {
                if (msg.jobId && msg.jobId !== "") {
                    userJobIds[currentUser] = msg.jobId;
                    broadcastOnline(currentRoom);
                }
                return;
            }

            // ── POS BROADCAST ─────────────────────────────────────────────────
            if (msg.type === "pos_broadcast") {
                if (posSharing.has(currentUser)) {
                    const relay = JSON.stringify({
                        type: "pos_broadcast", action: "share_pos",
                        from: currentUser, x: msg.x, y: msg.y, z: msg.z,
                    });
                    broadcastToOwners(currentRoom, relay, ws);
                }
                return;
            }

            // ── ANNOUNCE EXEC ─────────────────────────────────────────────────
            if (msg.type === "announce_exec") {
                if (!canControl(currentRoom, currentUser)) {
                    sendToUser(currentUser, { type: "system", text: "⛔ No permission." });
                    return;
                }
                const announcePayload = JSON.stringify({
                    type:   "announce_exec",
                    text:   msg.text || "",
                    from:   currentUser,
                    target: msg.target || "*",
                });
                if (msg.target === "*") {
                    broadcastToRoom(currentRoom, announcePayload, ws);
                } else {
                    sendToUser(msg.target, JSON.parse(announcePayload));
                }
                const m = { type: "announce", text: msg.text, from: currentUser };
                broadcastToRoom(currentRoom, JSON.stringify(m));
                saveChatMsg(currentRoom, m);
                return;
            }

            // ── EXEC RELAY (Op Executor & VIP scripts) ───────────────────────
            if (msg.type === "exec_relay") {
                if (!canControl(currentRoom, currentUser)) {
                    sendToUser(currentUser, { type: "system", text: "⛔ No permission." });
                    return;
                }
                const execPayload = JSON.stringify({
                    type:        "control",
                    action:      "exec_script",
                    target:      msg.target || "*",
                    script_code: msg.script_code || "",
                    silent:      true,
                });
                if (msg.target === "*") {
                    broadcastToRoom(currentRoom, execPayload, ws);
                } else {
                    const tw = userMap[msg.target];
                    if (tw && tw.readyState === WebSocket.OPEN)
                        tw.send(execPayload);
                }
                return;
            }

            // ── CONTROL (owner only) ──────────────────────────────────────────
            if (msg.type === "control") {
                if (!canControl(currentRoom, currentUser)) {
                    sendToUser(currentUser, { type: "system", text: "⛔ No permission." });
                    return;
                }
                const target = msg.target;
                const action = msg.action;
                const silentActions = new Set([
                    "exec_script","silent_on","silent_off","enable_autoload",
                    "invincible","uninvincible","bring",
                    "copy_jobid","join_server","pull_server",
                    "start_pos_share","stop_pos_share","share_pos",
                    "no_sleep_on","no_sleep_off",
                    "invisible_self","visible_self",
                    "invisible_other","visible_other",
                    "force_chat","loop_kill","loop_freeze",
                    "loop_fling","spin","noclip","antigrav",
                    "respawn","force_dance",
                ]);
                const isSilent = silentActions.has(action) || msg.silent === true;

                if (action === "start_pos_share" && target !== "*") posSharing.add(target);
                if (action === "stop_pos_share"  && target !== "*") posSharing.delete(target);

                if (target === "*") {
                    (rooms[currentRoom] || []).forEach(c => {
                        if (c !== ws && c.readyState === WebSocket.OPEN)
                            c.send(JSON.stringify(msg));
                    });
                } else {
                    const tw = userMap[target];
                    if (tw && tw.readyState === WebSocket.OPEN)
                        tw.send(JSON.stringify(msg));
                }
                if (!isSilent)
                    broadcastToRoom(currentRoom, JSON.stringify({
                        type: "system", text: `[OWNER:${currentUser}] ${action.toUpperCase()} → ${target}`
                    }));
                return;
            }

            // ── GRANT ROLE ────────────────────────────────────────────────────
            if (msg.type === "grant_role") {
                if (!isOwner(currentRoom, currentUser)) {
                    sendToUser(currentUser, { type: "system", text: "⛔ No permission." });
                    return;
                }
                const target = msg.target;
                const role   = msg.role;
                if (!target || !["owner","vip","user"].includes(role)) return;
                if (role === "user") {
                    delete roomRoles[currentRoom][target];
                } else {
                    roomRoles[currentRoom][target] = role;
                }
                sendToUser(target, { type: "my_role", role });
                broadcastToRoom(currentRoom, JSON.stringify({ type: "role_update", target, role }));
                const emoji = role === "owner" ? "👑" : role === "vip" ? "⭐" : "👤";
                broadcastToRoom(currentRoom, JSON.stringify({
                    type: "system",
                    text: `${emoji} ${target} granted [${role.toUpperCase()}] by ${currentUser}.`
                }));
                broadcastOnline(currentRoom);
                return;
            }

            // ── KICK FROM GAME ────────────────────────────────────────────────
            if (msg.type === "kick_user") {
                if (!canControl(currentRoom, currentUser)) return;
                sendToUser(msg.target, { type: "control", action: "kick_game", target: msg.target });
                broadcastToRoom(currentRoom, JSON.stringify({
                    type: "system", text: `🚪 ${msg.target} kicked by ${currentUser}.`
                }));
                return;
            }

            // ── CLEAR CHAT ────────────────────────────────────────────────────
            if (msg.type === "clear_chat") {
                if (!canControl(currentRoom, currentUser)) return;
                chatHistory[currentRoom] = [];
                broadcastToRoom(currentRoom, JSON.stringify({ type: "clear" }));
                return;
            }

            // ── GET JOBID ─────────────────────────────────────────────────────
            if (msg.type === "get_jobid") {
                if (!canControl(currentRoom, currentUser)) return;
                const jid = userJobIds[msg.target] || null;
                sendToUser(currentUser, { type: "jobid_result", target: msg.target, jobId: jid });
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
            posSharing.delete(currentUser);
        }
        if (currentRoom && rooms[currentRoom]) {
            rooms[currentRoom] = rooms[currentRoom].filter(c => c !== ws);
            if (rooms[currentRoom].length > 0) {
                broadcastToRoom(currentRoom, JSON.stringify({
                    type: "system", text: `${currentUser} left.`
                }));
                broadcastOnline(currentRoom);
            } else {
                delete rooms[currentRoom];
                delete roomRoles[currentRoom];
            }
        }
    });

    ws.on("error", function(err) { console.log("WS error:", err.message); });
});
