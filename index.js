// index.js
import {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers,
    fetchLatestBaileysVersion,
    delay
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import config from './config.js';

import { handleMessage } from './handlers/replyDetector.js';
import { handleCommands } from './handlers/commandHandler.js';
import { handleMusic } from './handlers/musicHandler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function printBanner() {
    console.log('╔════════════════════════════════════════╗');
    console.log('║         🦖 ONCEVIEW FANTASMA           ║');
    console.log('║      Premium  ·  Baileys 7.0.0-rc14    ║');
    console.log('╚════════════════════════════════════════╝\n');
}

class Bot {
    constructor() {
        this.sock = null;
        this.reconnectAttempts = 0;
        this.maxReconnects = 8;
        this.shuttingDown = false;
        this.phoneNumber = null;

        this.sessionReady = false;
        this.waVersion = null;
        this.connecting = false;
        this.reconnectTimer = null;
        this.onConnectionUpdate = null;
        this.onMessagesUpsert = null;
    }

    async start() {
        if (this.shuttingDown) return;
        if (this.connecting) return;

        this.connecting = true;

        try {
            const isFirstBoot = !this.sessionReady;

            if (isFirstBoot) {
                console.clear();
                printBanner();
                console.log('📁 Cargando sesión...');
            } else {
                console.log('\n🔁 Reconectando (misma sesión, sin borrar consola)...');
            }

            const sessionPath = join(__dirname, 'session');
            const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

            if (!state.creds.registered) {
                console.log('📱 No hay sesión vinculada.\n');
                this.phoneNumber = await this.askForPhoneNumber();

                if (!this.phoneNumber) {
                    console.error('❌ Número inválido. Saliendo...');
                    process.exit(1);
                }
            }

            if (!this.waVersion) {
                this.waVersion = await fetchLatestBaileysVersion();
            }
            const { version, isLatest } = this.waVersion;

            if (isFirstBoot) {
                console.log(`📦 WA Version: ${version.join('.')} ${isLatest ? '(latest)' : ''}`);
                console.log('🔌 Conectando a WhatsApp...\n');
            }

            await this.destroySocket();

            this.sock = makeWASocket({
                version,
                logger: pino({ level: config.logger.level }),
                printQRInTerminal: false,
                auth: state,
                markOnlineOnConnect: config.mode?.markOnline ?? false,
                syncFullHistory: config.mode?.syncFullHistory ?? false,
                browser: Browsers.macOS('Chrome'),
                generateHighQualityLinkPreview: false,
                getMessage: async () => undefined
            });

            this.setupEventHandlers(saveCreds);
            this.sessionReady = true;

        } catch (error) {
            console.error('❌ Error al iniciar:', error.message);
            this.queueReconnect(null, error.message);
        } finally {
            this.connecting = false;
        }
    }

    setupEventHandlers(saveCreds) {
        const sock = this.sock;

        if (this.onConnectionUpdate) {
            sock.ev.off('connection.update', this.onConnectionUpdate);
        }
        if (this.onMessagesUpsert) {
            sock.ev.off('messages.upsert', this.onMessagesUpsert);
        }

        this.onConnectionUpdate = async (update) => {
            const { connection, lastDisconnect } = update;

            if (
                connection === 'connecting' &&
                !sock.authState.creds.registered &&
                this.phoneNumber
            ) {
                try {
                    await delay(1200);
                    console.log('⏳ Generando pairing code...');
                    const code = await sock.requestPairingCode(this.phoneNumber);
                    this.showPairingCode(code);
                    this.phoneNumber = null;
                } catch (err) {
                    console.error('❌ Error al generar pairing code:', err.message);
                    console.log('\n💡 Prueba de nuevo en 1-2 minutos.');
                    process.exit(1);
                }
            }

            if (connection === 'open') {
                this.reconnectAttempts = 0;
                const number = sock.user?.id?.split(':')[0] || 'N/A';
                console.log('✅ CONECTADO A WHATSAPP');
                console.log(`📱 Número: ${number}`);
                if (!this._readyHintShown) {
                    this._readyHintShown = true;
                    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                    console.log('💡 Escribe .onov en tu chat privado para activar OnceView\n');
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const reason =
                    lastDisconnect?.error?.output?.payload?.message ||
                    lastDisconnect?.error?.message ||
                    'unknown';

                if (statusCode === DisconnectReason.loggedOut) {
                    console.error('🔒 SESIÓN CERRADA (loggedOut)');
                    console.error('   → Borra la carpeta "session" y vuelve a vincular.');
                    process.exit(0);
                }

                if (this.shuttingDown) return;

                this.queueReconnect(statusCode, reason);
            }
        };

        this.onMessagesUpsert = async ({ messages, type }) => {
            if (type !== 'notify') return;

            for (const message of messages) {
                try {
                    if (!message?.message) continue;

                    const remoteJid = message.key.remoteJid;
                    if (!remoteJid || remoteJid === 'status@broadcast' || remoteJid.includes('broadcast')) {
                        continue;
                    }

                    await handleCommands(message, sock, config);
                    await handleMusic(message, sock, config);
                    await handleMessage(message, sock, config);
                } catch (err) {
                    console.error('[messages.upsert] Error:', err.message);
                }
            }
        };

        sock.ev.on('connection.update', this.onConnectionUpdate);
        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('messages.upsert', this.onMessagesUpsert);
    }

    queueReconnect(statusCode, reason) {
        if (this.shuttingDown || this.reconnectTimer) return;

        if (this.reconnectAttempts >= this.maxReconnects) {
            console.error('❌ Límite de reconexiones alcanzado.');
            process.exit(1);
        }

        const isConflict = statusCode === DisconnectReason.connectionReplaced;
        const baseWait = config.bot.timeouts.reconnect || 10000;
        const waitMs = isConflict ? Math.max(baseWait, 15000) : baseWait;

        console.log(`⚠️  Desconectado (${statusCode ?? 'N/A'}): ${reason}`);

        if (isConflict) {
            console.log('💡 Conflicto 440: otra instancia del bot o WhatsApp Web con la misma sesión.');
            console.log('   Deja solo UNA terminal con npm start (no dupliques nodemon + start).');
        }

        const nextAttempt = this.reconnectAttempts + 1;
        console.log(`🔄 Reintento ${nextAttempt}/${this.maxReconnects} en ${waitMs / 1000}s...\n`);

        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            this.reconnectAttempts = nextAttempt;
            await this.start();
        }, waitMs);
    }

    async destroySocket() {
        const sock = this.sock;
        this.sock = null;

        if (!sock) return;

        if (this.onConnectionUpdate) {
            sock.ev.off('connection.update', this.onConnectionUpdate);
        }
        if (this.onMessagesUpsert) {
            sock.ev.off('messages.upsert', this.onMessagesUpsert);
        }

        try {
            sock.end(undefined);
        } catch {
            /* ya cerrado */
        }

        await delay(2000);
    }

    async askForPhoneNumber() {
        return new Promise((resolve) => {
            const rl = createInterface({
                input: process.stdin,
                output: process.stdout,
                terminal: true
            });

            console.log('════════════════════════════════════════');
            console.log('  ESCRIBE TU NÚMERO (solo dígitos)');
            console.log('  México  → 5215512345678');
            console.log('  España  → 34612345678');
            console.log('════════════════════════════════════════\n');

            rl.question('👉 Número: ', (answer) => {
                rl.close();

                const cleaned = String(answer || '').replace(/\D/g, '');

                if (cleaned.length >= 10 && cleaned.length <= 15) {
                    console.log(`\n✅ Número aceptado: ${cleaned}\n`);
                    resolve(cleaned);
                } else {
                    console.log(`\n❌ Número inválido: "${cleaned}"\n`);
                    resolve(null);
                }
            });
        });
    }

    showPairingCode(code) {
        console.clear();
        console.log('╔════════════════════════════════════════╗');
        console.log('║             🔢 PAIRING CODE            ║');
        console.log('╚════════════════════════════════════════╝\n');

        console.log('📱 EN TU IPHONE / ANDROID:\n');
        console.log('1. Abre WhatsApp');
        console.log('2. Ajustes → Dispositivos vinculados');
        console.log('3. Vincular un dispositivo');
        console.log('4. Abajo: "Vincular con número de teléfono"');
        console.log('5. Escribe este código:\n');

        console.log('──────────────────────────────────────────');
        console.log(`               ${code}`);
        console.log('──────────────────────────────────────────\n');

        console.log('⏳ Tienes ~60 segundos. Escríbelo ahora.\n');
    }

    async stop() {
        this.shuttingDown = true;

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        console.log('\n👋 Deteniendo el bot...');
        await this.destroySocket();
        console.log('✅ Bot detenido.');
        process.exit(0);
    }
}

const bot = new Bot();

let sigintCount = 0;
let sigintTimer = null;

const handleShutdown = () => {
    if (sigintCount === 0) {
        console.log('\n⚠️  Presiona Ctrl+C otra vez en 3s para detener.');
        sigintCount = 1;
        sigintTimer = setTimeout(() => {
            sigintCount = 0;
            console.log('✅ Cancelado.');
        }, 3000);
        return;
    }
    if (sigintTimer) clearTimeout(sigintTimer);
    bot.stop();
};

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', () => bot.stop());

if (process.platform === 'win32') {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.on('SIGINT', () => process.emit('SIGINT'));
}

bot.start().catch(console.error);
