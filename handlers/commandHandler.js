// handlers/commandHandler.js  ← GOOGLE TTS RÁPIDO + ESTABLE (2026 working)
console.log('[commandHandler] Cargado OK - Google TTS rápido y estable')

export async function handleCommands(message, sock, config) {
    const { key, message: msg } = message
    const jid = key.remoteJid

    let text = ''
    if (msg?.conversation) text = msg.conversation.trim()
    else if (msg?.extendedTextMessage?.text) text = msg.extendedTextMessage.text.trim()

    if (!text) return

    const lower = text.toLowerCase()

    if (!lower.startsWith('.say')) return

    let query = text.slice(4).trim()

    console.log(`[commandHandler] .say DETECTADO en ${jid} → "${query.substring(0, 50)}..."`)

    if (!query) {
        await sock.sendMessage(jid, { text: 'Pon algo después del .say\nEj: .say hola xd' })
        return
    }

    if (query.length > 1500) {
        await sock.sendMessage(jid, { text: 'Máximo 1500 caracteres (para dividir bien)' })
        return
    }

    try {
        console.log('[commandHandler] Generando voz rápida con Google...')

        // Limpieza básica
        query = query.replace(/[\u{1F000}-\u{1FFFF}]/gu, '').replace(/[^\w\s.,!?¡¿áéíóúñÁÉÍÓÚÑ]/g, ' ')

        // Dividir en chunks de 180 chars (evita 400 y cortes)
        const chunks = []
        let current = ''
        const words = query.split(' ')

        for (const word of words) {
            if (current.length + word.length + 1 > 180) {
                chunks.push(current.trim())
                current = word
            } else {
                current += (current ? ' ' : '') + word
            }
        }
        if (current) chunks.push(current.trim())

        console.log(`[commandHandler] Dividido en ${chunks.length} partes`)

        const sendChunk = async (chunkText) => {
            if (!chunkText.trim()) return

            const encoded = encodeURIComponent(chunkText)
            // VOZ RÁPIDA ESPAÑOLA + velocidad alta
            const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=es-ES&ttsspeed=1.5&q=${encoded}`

            const response = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            })

            if (!response.ok) {
                console.error(`[commandHandler] Falló chunk: ${response.status}`)
                throw new Error(`Google TTS falló: ${response.status}`)
            }

            const buffer = Buffer.from(await response.arrayBuffer())

            await sock.sendMessage(jid, {
                audio: buffer,
                mimetype: 'audio/mpeg',
                ptt: true
            })

            console.log(`[commandHandler] Chunk enviado (${chunkText.length} chars, ${buffer.length} bytes)`)
        }

        for (const chunk of chunks) {
            await sendChunk(chunk)
            await new Promise(r => setTimeout(r, 700))  // pausa corta para que suene fluido
        }

        console.log('[commandHandler] ✅ Todos enviados')

    } catch (err) {
        console.error('[commandHandler] ERROR:', err.message || err)
        await sock.sendMessage(jid, { text: `Error voz: ${err.message?.slice(0, 100) || 'desconocido'}` })
    }
}
