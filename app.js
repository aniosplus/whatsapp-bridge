const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const axios = require('axios');
const path = require('path');
const express = require('express');

const app = express();
app.use(express.json());

// Ana sayfa kontrolü için
app.get('/', (req, res) => {
    res.json({ status: 'running', service: 'WhatsApp Bridge', webhook_url: process.env.WEBHOOK_URL });
});

// Oturum Sıfırlama (Eğer takılırsa)
app.get('/reset', (req, res) => {
    const sessionDir = path.join(__dirname, 'auth_info_baileys');
    if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        res.json({ status: 'success', message: 'Session deleted. Restart the service on Render.' });
    } else {
        res.json({ status: 'error', message: 'No session found.' });
    }
});

const PORT = process.env.PORT || 3000;
const PHP_API_URL = process.env.WEBHOOK_URL || 'https://hugx.net/api/whatsapp_webhook.php';
const SESSION_NAME = 'whatsapp_auth_session';

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth_info_baileys'));
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        printQRInTerminal: true,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'info' })),
        },
        logger: pino({ level: 'info' }),
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 10000
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('--- NEW QR GENERATED ---');
            axios.post(PHP_API_URL, { action: 'qr_generated', qr: qr })
                .then(() => console.log('QR sent to PHP'))
                .catch(e => console.error('Webhook Error:', e.message));
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reason:', lastDisconnect?.error, 'Should reconnect:', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('--- WHATSAPP CONNECTED SUCCESSFULLY ---');
            axios.post(PHP_API_URL, { action: 'status_update', status: 'connected', number: sock.user.id })
                .catch(e => console.error('Status Webhook Error:', e.message));
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type === 'notify') {
            for (const msg of m.messages) {
                if (!msg.key.fromMe) {
                    const sender = msg.key.remoteJID;
                    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
                    if (text) {
                        handleIncomingMessage(sender, text);
                    }
                }
            }
        }
    });

    async function handleIncomingMessage(sender, text) {
        try {
            const response = await axios.post(PHP_API_URL, {
                action: 'incoming_message',
                sender: sender,
                message: text
            });
            if (response.data && response.data.reply) {
                await sock.sendMessage(sender, { text: response.data.reply });
            }
        } catch (error) { }
    }

    // PHP'den gelecek komutlar için API (Eğitim vb.)
    app.post('/command', async (req, res) => {
        const { action } = req.body;
        if (action === 'get_history') {
            // Örnek: Son 100 mesajı çek (Simüle veya Baileys store ile)
            // Not: Baileys'de geçmiş mesajları çekmek için store kullanılması önerilir.
            res.json({ status: true, messages: "Geçmiş mesajlar simüle edildi." });
        } else {
            res.json({ status: false });
        }
    });
}

app.listen(PORT, () => console.log(`API Server running on port ${PORT}`));
connectToWhatsApp();
