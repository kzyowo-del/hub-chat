            console.log("Parse error:", e.message);
        }
    });

    // ── DISCONNECT ────────────────────────────────────────
    ws.on("close", function() {
        if (currentUser) {
            delete userMap[currentUser];
        }
        if (currentRoom && rooms[currentRoom]) {
            rooms[currentRoom] = rooms[currentRoom].filter(c => c !== ws);
            if (rooms[currentRoom].length > 0) {
                broadcastToRoom(currentRoom, JSON.stringify({
                    type: "system",
                    text: `${currentUser} left.`,
                }));
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
