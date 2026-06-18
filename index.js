const express = require('express');
const qrcode = require('qrcode-terminal');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');

const app = express();
const PORT = process.env.PORT || 10000;

let currentQR = null;

app.get('/', (req, res) => {
    res.send(`
        <h1>✅ WhatsApp Bot is Running on Render!</h1>
        <p><a href="/qr" target="_blank"><b>👉 Click Here to Scan QR Code</b></a></p>
    `);
});

app.get('/qr', (req, res) => {
    if (currentQR) {
        res.send(`
            <h2>Scan this QR Code with WhatsApp</h2>
            <pre style="font-size: 12px; line-height: 10px;">${qrcode.generate(currentQR, { small: true })}</pre>
            <p>Refresh this page if QR is expired.</p>
        `);
    } else {
        res.send('<h2>Waiting for QR Code... Please wait 10 seconds and refresh.</h2>');
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
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
            console.log('✅ Bot is Online!');
            currentQR = null;
        }

        if (connection === 'close') {
            if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
                setTimeout(connectToWhatsApp, 8000);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

connectToWhatsApp();

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));