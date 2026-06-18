const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');

const app = express();
const PORT = process.env.PORT || 3000;

// Health check for Render
app.get('/', (req, res) => res.send('✅ WhatsApp Bot is Running on Render!'));

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

        if (qr) console.log('📱 QR Code received - Scan it!');
        
        if (connection === 'close') {
            if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
                console.log('🔄 Reconnecting...');
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('✅ Bot is Online!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Simple auto-reply example
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.key.fromMe && msg.message?.conversation) {
            const text = msg.message.conversation.toLowerCase();
            if (text === 'hi' || text === 'hello') {
                await sock.sendMessage(msg.key.remoteJid, { text: 'Hello! I am your WhatsApp Bot 🤖' });
            }
        }
    });
}

connectToWhatsApp();

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));