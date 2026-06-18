const express = require('express');
const QRCode = require('qrcode');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');

const app = express();
const PORT = process.env.PORT || 10000;

let currentQR = null;

app.get('/', (req, res) => {
    res.send(`
        <h1>✅ WhatsApp Bot is Running!</h1>
        <p><a href="/qr" target="_blank"><b>👉 Click Here to Scan QR Code</b></a></p>
    `);
});

app.get('/qr', async (req, res) => {
    if (currentQR) {
        try {
            const qrImage = await QRCode.toDataURL(currentQR);
            res.send(`
                <h2>Scan this QR Code with WhatsApp</h2>
                <img src="${qrImage}" width="300" height="300" />
                <p><small>Refresh this page if the QR code expires.</small></p>
            `);
        } catch (e) {
            res.send('<h2>Error generating QR. Please refresh.</h2>');
        }
    } else {
        res.send('<h2>Waiting for QR Code... Refresh after 5-10 seconds.</h2>');
    }
});

let sock;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }),
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            currentQR = qr;
            console.log('📱 New QR Code Generated');
        }

        if (connection === 'open') {
            console.log('✅ Bot is Online!');
            currentQR = null;
        }

        if (connection === 'close') {
            if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
                console.log('🔄 Reconnecting in 10 seconds...');
                setTimeout(connectToWhatsApp, 10000);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // ==================== COMMAND HANDLER ====================
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.key.fromMe && msg.message?.conversation) {
            
            const text = msg.message.conversation.toLowerCase().trim();
            const from = msg.key.remoteJid;

            console.log(`📩 Received: ${text}`);

            if (text === 'hi' || text === 'hello') {
                await sock.sendMessage(from, { text: 'Hello! I am your WhatsApp Bot 🤖' });
            } 
            else if (text === 'ping') {
                await sock.sendMessage(from, { text: '✅ Pong! Bot is alive and working.' });
            } 
            else if (text === 'time') {
                await sock.sendMessage(from, { text: `🕒 Current Time: ${new Date().toLocaleString()}` });
            } 
            else if (text === 'menu' || text === 'help') {
                await sock.sendMessage(from, { 
                    text: `📋 *Available Commands:*\n\n` +
                          `• hi / hello\n` +
                          `• ping\n` +
                          `• time\n` +
                          `• menu / help` 
                });
            }
        }
    });
    // =======================================================
}

connectToWhatsApp();

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));