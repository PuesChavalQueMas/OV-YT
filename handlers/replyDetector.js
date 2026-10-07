// handlers/replyDetector.js
import {
    downloadMediaMessage,
    downloadContentFromMessage
} from '@whiskeysockets/baileys';

console.log('[replyDetector] Cargado — OnceView premium');

// Estado del toggle (en memoria)
let isOnceViewActive = false;

/**
 * OnceView extractor
 * - .onov / .offov / .status  (solo owner)
 * - Cuando está activo: responde a un view-once → lo extrae y te lo manda en privado (sin caption)
 */
export async function handleMessage(message, sock, config) {
    try {
        const { key, message: msg } = message;
        if (!msg) return;

        const jid = key.remoteJid;
        const fromMe = key.fromMe;
        const ownerJid = config.bot.owner;

        // ────────────────────────────────────────────────
        // 1. Comandos de toggle (solo mensajes propios)
        // ────────────────────────────────────────────────
        if (fromMe) {
            let text = '';
            if (msg.conversation) text = msg.conversation.trim();
            else if (msg.extendedTextMessage?.text) text = msg.extendedTextMessage.text.trim();

            const prefix = config.bot.prefix?.toggle || '.';

            if (text.toLowerCase().startsWith(prefix)) {
                const cmd = text.slice(prefix.length).trim().toLowerCase();

                if (cmd === 'onov') {
                    isOnceViewActive = true;
                    console.log('\n🟢 ONCEVIEW ACTIVADO');
                    await sock.sendMessage(ownerJid, {
                        text: '🟢 *ONCEVIEW ACTIVADO*\n\nResponde a cualquier view-once y te lo extraeré en privado.'
                    });
                    return;
                }

                if (cmd === 'offov') {
                    isOnceViewActive = false;
                    console.log('\n🔴 ONCEVIEW DESACTIVADO');
                    await sock.sendMessage(ownerJid, {
                        text: '🔴 *ONCEVIEW DESACTIVADO*\n\nUsa *.onov* para reactivar.'
                    });
                    return;
                }

                if (cmd === 'status' || cmd === 'estado') {
                    const status = isOnceViewActive ? '🟢 ACTIVADO' : '🔴 DESACTIVADO';
                    await sock.sendMessage(ownerJid, {
                        text: `📊 *ESTADO ONCEVIEW*\n\nModo: ${status}\nPrefijo: \`${prefix}\``
                    });
                    return;
                }
            }
        }

        // ────────────────────────────────────────────────
        // 2. Si está desactivado → silencio total
        // ────────────────────────────────────────────────
        if (!isOnceViewActive) return;

        // Solo procesamos nuestras propias respuestas
        if (!fromMe) return;

        // Debe ser una respuesta (quoted)
        const quotedCtx = msg.extendedTextMessage?.contextInfo;
        if (!quotedCtx?.quotedMessage) return;

        console.log('\n🎯 Respuesta detectada → buscando view-once...');

        const quoted = quotedCtx.quotedMessage;
        let mediaType = null;
        let mediaObject = null;

        // Detección robusta de view-once / imagen / video
        if (quoted.imageMessage) {
            mediaType = 'image';
            mediaObject = quoted.imageMessage;
        } else if (quoted.videoMessage) {
            mediaType = 'video';
            mediaObject = quoted.videoMessage;
        } else if (quoted.viewOnceMessage?.message) {
            const inner = quoted.viewOnceMessage.message;
            if (inner.imageMessage) {
                mediaType = 'image';
                mediaObject = inner.imageMessage;
            } else if (inner.videoMessage) {
                mediaType = 'video';
                mediaObject = inner.videoMessage;
            }
        } else if (quoted.ephemeralMessage?.message?.viewOnceMessage?.message) {
            const inner = quoted.ephemeralMessage.message.viewOnceMessage.message;
            if (inner.imageMessage) {
                mediaType = 'image';
                mediaObject = inner.imageMessage;
            } else if (inner.videoMessage) {
                mediaType = 'video';
                mediaObject = inner.videoMessage;
            }
        } else if (quoted.viewOnceMessageV2?.message) {
            // Formato más nuevo (2025-2026)
            const inner = quoted.viewOnceMessageV2.message;
            if (inner.imageMessage) {
                mediaType = 'image';
                mediaObject = inner.imageMessage;
            } else if (inner.videoMessage) {
                mediaType = 'video';
                mediaObject = inner.videoMessage;
            }
        }

        if (!mediaObject || !mediaType) {
            console.log('⚠️  No es view-once / imagen / video → ignorado');
            return;
        }

        console.log(`📥 Detectado: ${mediaType.toUpperCase()} → descargando...`);

        // ────────────────────────────────────────────────
        // 3. Descarga (doble método)
        // ────────────────────────────────────────────────
        let buffer = null;

        // Método 1: downloadMediaMessage (preferido)
        try {
            buffer = await downloadMediaMessage(
                {
                    key: {
                        remoteJid: jid,
                        id: quotedCtx.stanzaId || key.id,
                        participant: quotedCtx.participant,
                        fromMe: false
                    },
                    message: quoted
                },
                'buffer',
                {},
                {
                    reuploadRequest: sock.updateMediaMessage,
                    timeout: config.bot.timeouts?.download || 25000
                }
            );

            if (!buffer || buffer.length < 1024) throw new Error('Buffer demasiado pequeño');
            console.log(`✅ Descargado (método 1): ${formatSize(buffer.length)}`);
        } catch (err1) {
            console.log(`⚠️  Método 1 falló: ${err1.message} → intentando método 2...`);

            // Método 2: downloadContentFromMessage
            try {
                const stream = await downloadContentFromMessage(mediaObject, mediaType);
                const chunks = [];
                for await (const chunk of stream) {
                    chunks.push(chunk);
                }
                buffer = Buffer.concat(chunks);

                if (!buffer || buffer.length < 1024) throw new Error('Buffer demasiado pequeño');
                console.log(`✅ Descargado (método 2): ${formatSize(buffer.length)}`);
            } catch (err2) {
                console.log(`❌ Ambos métodos fallaron: ${err2.message}`);
                return;
            }
        }

        // Filtro anti-thumbnail
        const sizeKB = buffer.length / 1024;
        if ((mediaType === 'image' && sizeKB < 18) || (mediaType === 'video' && sizeKB < 70)) {
            console.log(`⚠️  Demasiado pequeño (${sizeKB.toFixed(1)} KB) → probablemente thumbnail`);
            return;
        }

        // ────────────────────────────────────────────────
        // 4. Envío silencioso al owner
        // ────────────────────────────────────────────────
        console.log('📤 Enviando a privado (silencioso)...');

        const mime = mediaObject.mimetype || (mediaType === 'image' ? 'image/jpeg' : 'video/mp4');

        try {
            await sock.sendMessage(ownerJid, {
                [mediaType]: buffer,
                mimetype: mime
                // sin caption = 100% silencioso
            });
            console.log('✨ Enviado correctamente\n');
        } catch (sendErr) {
            console.log(`⚠️  Error al enviar media: ${sendErr.message} → fallback documento`);

            // Fallback: documento
            await sock.sendMessage(ownerJid, {
                document: buffer,
                mimetype: mime,
                fileName: `onceview_${Date.now()}.${mediaType === 'image' ? 'jpg' : 'mp4'}`
            }).catch(() => {
                console.log('💀 Falló también el fallback');
            });
        }

    } catch (err) {
        console.log(`💀 Error general OnceView: ${err.message}`);
    }
}

// ── Helper ────────────────────────────────────────────────
function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}