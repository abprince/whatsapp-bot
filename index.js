const express = require('express');
const QRCode = require('qrcode');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 10000;

let currentQR = null;
let sock;

// Initialize Database
const db = new sqlite3.Database('./bot.db', (err) => {
    if (err) console.error(err);
    else console.log('✅ Database connected');
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS matches (
        id INTEGER PRIMARY KEY,
        match_name TEXT,
        team1 TEXT,
        team2 TEXT,
        kickoff TEXT,
        result TEXT DEFAULT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS votes (
        user_id TEXT,
        match_id INTEGER,
        vote TEXT,
        PRIMARY KEY (user_id, match_id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS points (
        user_id TEXT PRIMARY KEY,
        username TEXT,
        points INTEGER DEFAULT 0
    )`);
});

app.get('/', (req, res) => res.send('<h1>🏆 World Cup Prediction Bot Running!</h1><p><a href="/qr">Scan QR</a></p>'));

app.get('/qr', async (req, res) => {
    if (currentQR) {
        const qrImage = await QRCode.toDataURL(currentQR);
        res.send(`<h2>Scan QR Code</h2><img src="${qrImage}" width="300"/>`);
    } else {
        res.send('<h2>Waiting for QR... Refresh</h2>');
    }
});

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }),
    });

    sock.ev.on('connection.update', (update) => { /* same as before */ });
    sock.ev.on('creds.update', saveCreds);

    // ==================== MAIN COMMAND HANDLER ====================
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.key.fromMe && msg.message?.conversation) {
            const text = msg.message.conversation.trim();
            const from = msg.key.remoteJid;
            const isGroup = from.endsWith('@g.us');

            if (!isGroup) return; // Only work in groups

            const args = text.split(' ');
            const command = args[0].toLowerCase();

            // ADMIN COMMANDS (Change YOUR_NUMBER to your number)
            if (from.includes('971501293693')) {  // ← Replace with your number
                if (command === '!addmatch' && args.length >= 5) {
                    const matchName = args[1];
                    const team1 = args[2];
                    const team2 = args[3];
                    const kickoff = args[4]; // Format: 2026-06-20 20:00
                    db.run(`INSERT INTO matches (match_name, team1, team2, kickoff) VALUES (?, ?, ?, ?)`,
                        [matchName, team1, team2, kickoff]);
                    await sock.sendMessage(from, { text: `✅ Match Added: ${team1} vs ${team2}` });
                }
            }

            // VOTING
            if (command === '!vote') {
                // Logic to show active matches and vote
                // I'll give simplified version first
            }

            // LEADERBOARD
            if (command === '!standings' || command === '!leaderboard') {
                db.all(`SELECT username, points FROM points ORDER BY points DESC LIMIT 10`, async (err, rows) => {
                    let text = "🏆 *World Cup Prediction Standings*\n\n";
                    rows.forEach((row, i) => {
                        text += `${i+1}. ${row.username} - ${row.points} pts\n`;
                    });
                    await sock.sendMessage(from, { text });
                });
            }
        }
    });
}

connectToWhatsApp();

app.listen(PORT, () => console.log(`🚀 Bot Running`));