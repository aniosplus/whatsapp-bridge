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
const crypto = require('crypto');

// Crypto Fix
if (!globalThis.crypto) {
    globalThis.crypto = crypto.webcrypto;
}

const app = express();
app.use(express.json());

const PORT = 80; // Oracle VPS Compatibility
const PHP_API_URL = 'https://hugx.net/api/whatsapp_webhook.php';
const SESSIONS_DIR = path.join(__dirname, 'sessions');

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const bots = new Map();

async function startBot(botId) {
    if (bots.has(botId)) {
        console.log(`Bot ${botId} is already running.`);
        return bots.get(botId);
    }

    const botSessionDir = path.join(SESSIONS_DIR, `bot_${botId}`);
    const { state, saveCreds } = await useMultiFileAuthState(botSessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
        },
        logger: pino({ level: 'silent' }),
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 15000
    });

    bots.set(botId, sock);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log(`QR Generated for Bot ${botId}`);
            // Save QR to file for Dashboard to read
            fs.writeFileSync(path.join(__dirname, `bot_${botId}_qr.txt`), qr);

            axios.post(PHP_API_URL + '?bot_id=' + botId, { action: 'qr_generated', bot_id: botId, qr: qr })
                .catch(e => console.error(`QR Webhook Error [Bot ${botId}]:`, e.message));
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error instanceof Boom)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`Bot ${botId} connection closed. Reason:`, statusCode, 'Reconnect:', shouldReconnect);

            if (statusCode === DisconnectReason.loggedOut) {
                bots.delete(botId);
                if (fs.existsSync(botSessionDir)) fs.rmSync(botSessionDir, { recursive: true, force: true });
                // Notify PHP
                axios.post(PHP_API_URL + '?bot_id=' + botId, { action: 'status_update', bot_id: botId, status: 'disconnected' })
                    .catch(e => { });
            } else if (shouldReconnect) {
                startBot(botId);
            }
        } else if (connection === 'open') {
            console.log(`Bot ${botId} connected!`);
            // Clear QR file
            const qrFile = path.join(__dirname, `bot_${botId}_qr.txt`);
            if (fs.existsSync(qrFile)) fs.unlinkSync(qrFile);

            axios.post(PHP_API_URL + '?bot_id=' + botId, { action: 'status_update', bot_id: botId, status: 'connected', number: sock.user.id })
                .catch(e => console.error(`Status Webhook Error [Bot ${botId}]:`, e.message));
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type === 'notify') {
            for (const msg of m.messages) {
                if (!msg.key.fromMe) {
                    const sender = msg.key.remoteJID;
                    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
                    if (text) {
                        handleIncomingMessage(botId, sender, text, sock);
                    }
                }
            }
        }
    });

    return sock;
}

async function handleIncomingMessage(botId, sender, text, sock) {
    try {
        const response = await axios.post(PHP_API_URL + '?bot_id=' + botId, {
            action: 'incoming_message',
            bot_id: botId,
            sender: sender,
            message: text
        });

        if (response.data && response.data.reply) {
            await sock.sendMessage(sender, { text: response.data.reply });
        }
    } catch (error) {
        console.error(`Message Error [Bot ${botId}]:`, error.message);
    }
}

// API Endpoints
app.get('/', (req, res) => {
    res.json({ status: 'running', service: 'WhatsApp Bridge Multi-Session V3.0', active_bots: Array.from(bots.keys()) });
});

app.get('/init', async (req, res) => {
    const botId = req.query.bot_id;
    if (!botId) return res.json({ status: false, message: 'bot_id required' });

    await startBot(botId);
    res.json({ status: true, message: `Bot ${botId} initialization started.` });
});

app.get('/reset/:bot_id', async (req, res) => {
    const botId = req.params.bot_id;
    if (bots.has(botId)) {
        const sock = bots.get(botId);
        try { await sock.logout(); } catch (e) { }
        bots.delete(botId);
    }
    const sessionDir = path.join(SESSIONS_DIR, `bot_${botId}`);
    if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });

    const qrFile = path.join(__dirname, `bot_${botId}_qr.txt`);
    if (fs.existsSync(qrFile)) fs.unlinkSync(qrFile);

    res.json({ status: true, message: `Bot ${botId} session reset.` });
});

app.post('/command', async (req, res) => {
    const { action, bot_id } = req.body;
    const sock = bots.get(String(bot_id));

    if (!sock) return res.json({ status: false, message: 'Bot not connected' });

    if (action === 'get_history') {
        res.json({ status: true, messages: [] }); // Store implementation needed for full history
    } else {
        res.json({ status: false });
    }
});

app.listen(PORT, () => console.log(`WhatsApp Bridge V3.0 listening on port ${PORT}`));
