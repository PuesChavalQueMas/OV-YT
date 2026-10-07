// handlers/musicHandler.js
import youtubedl from 'youtube-dl-exec';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import tmp from 'tmp-promise';
import fs from 'fs/promises';
import path from 'path';
import { createWriteStream } from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

ffmpeg.setFfmpegPath(ffmpegStatic);

console.log('[musicHandler] Cargado — YouTube Audio premium v4 (ultra)');

const PREFIXES = ['.yt', '.play', '.p'];

const FFMPEG_HEADERS =
    'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36\r\n' +
    'Referer: https://www.youtube.com/\r\n';

const YTDLP_OPTS = {
    noPlaylist: true,
    noWarnings: true,
    preferFreeFormats: true,
    concurrentFragments: 16,
    retries: 10,
    fragmentRetries: 10,
    addHeader: [
        'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
        'Referer:https://www.youtube.com/'
    ]
};

export async function handleMusic(message, sock, config) {
    const { key, message: msg } = message;
    const jid = key.remoteJid;

    let text = '';
    if (msg?.conversation) text = msg.conversation.trim();
    else if (msg?.extendedTextMessage?.text) text = msg.extendedTextMessage.text.trim();
    if (!text) return;

    const lower = text.toLowerCase();
    const matched = PREFIXES.find(p => lower.startsWith(p + ' ') || lower === p);
    if (!matched) return;

    let rawQuery = text.slice(matched.length).trim();
    if (!rawQuery) {
        await sock.sendMessage(jid, {
            text:
                'Uso:\n' +
                '• *.yt* nombre o link → audio completo\n' +
                '• *.yt* link *0:34 1:30* → recorte (inicio fin)\n' +
                '• También segundos: *.yt* link *130 190*'
        });
        return;
    }

    const { query, startSec, endSec } = splitQueryAndTrim(rawQuery);
    if (!query) {
        await sock.sendMessage(jid, { text: '❌ Falta el link o nombre después del comando.' });
        return;
    }

    const maxDuration = config.bot.limits?.musicMaxDurationSec || 600;
    const maxSizeMB = config.bot.limits?.musicMaxSizeMB || 16;

    let tempInput = null;
    let tempOutput = null;
    let tempDirHandle = null;

    try {
        console.log(`[music] ${matched} → "${query.slice(0, 60)}"${startSec != null ? ` [${startSec}s–${endSec}s]` : ''}`);

        const ytdlpTarget = toYtdlpTarget(query);
        const { title, duration, audioUrl, pageUrl, ytdlpSource } = await resolveAudio(ytdlpTarget, query);

        const clipSec = resolveClipDuration(duration, startSec, endSec);
        if (startSec != null && endSec != null && endSec <= startSec) {
            await sock.sendMessage(jid, { text: '❌ El tiempo final debe ser mayor que el inicial.' });
            return;
        }
        if (clipSec > maxDuration) {
            const clipStr = formatClock(clipSec);
            await sock.sendMessage(jid, { text: `⛔ Muy largo (${clipStr}). Máx ${formatClock(maxDuration)}.` });
            return;
        }

        const durationStr = duration > 0 ? formatClock(duration) : '??:??';
        const clipLabel =
            startSec != null && endSec != null
                ? `\n✂️ ${formatClock(startSec)} → ${formatClock(endSec)}`
                : '';

        await sock.sendMessage(jid, {
            text: `🎵 *${title.slice(0, 55)}${title.length > 55 ? '…' : ''}*\n⏱ ${durationStr}${clipLabel}\n⏳ Procesando…`
        });

        tempDirHandle = await tmp.dir({ unsafeCleanup: true });
        const workDir = tempDirHandle.path;
        tempOutput = await tmp.file({ postfix: '.ogg', dir: workDir });

        const trim = startSec != null && endSec != null ? { startSec, endSec } : null;
        let converted = false;

        try {
            await convertToOpus({ inputUrl: audioUrl, outputPath: tempOutput.path, trim });
            converted = true;
            console.log('[music] Conversión OK (ffmpeg URL directo)');
        } catch (directErr) {
            console.warn('[music] ffmpeg URL falló:', directErr.message);
        }

        if (!converted) {
            tempInput = await tmp.file({ postfix: '.m4a', dir: workDir });
            try {
                await downloadFromUrl(audioUrl, tempInput.path);
                console.log('[music] Descarga OK (URL)');
            } catch (fetchErr) {
                console.warn('[music] Fetch falló, yt-dlp:', fetchErr.message);
                await downloadWithYtdlp(ytdlpSource, tempInput.path, workDir, trim);
                console.log('[music] Descarga OK (yt-dlp)');
            }

            await convertToOpus({ inputPath: tempInput.path, outputPath: tempOutput.path, trim });
            await tempInput.cleanup().catch(() => {});
            tempInput = null;
            console.log('[music] Conversión OK (archivo local)');
        }

        const { size } = await fs.stat(tempOutput.path);
        if (size > maxSizeMB * 1024 * 1024) {
            await sock.sendMessage(jid, { text: `⛔ Archivo muy pesado (>${maxSizeMB} MB)` });
            return;
        }

        const sendSeconds = Math.max(1, Math.ceil(clipSec > 0 ? clipSec : duration));

        await sock.sendMessage(jid, {
            audio: { url: tempOutput.path },
            mimetype: 'audio/ogg; codecs=opus',
            ptt: true,
            seconds: sendSeconds
        });

        console.log(`[music] ✅ Enviado (PTT) → ${title} (${pageUrl || ytdlpSource})`);

    } catch (err) {
        console.error('[music] ERROR:', err.message);
        if (err.stderr) console.error('[music] stderr:', String(err.stderr).slice(0, 400));
        await sock.sendMessage(jid, {
            text: '❌ No se pudo obtener el audio.\nPrueba con un nombre más específico o un link directo.'
        }).catch(() => {});
    } finally {
        if (tempInput) await tempInput.cleanup().catch(() => {});
        if (tempOutput) await tempOutput.cleanup().catch(() => {});
        if (tempDirHandle) await tempDirHandle.cleanup().catch(() => {});
    }
}

function formatClock(totalSec) {
    const s = Math.max(0, Math.floor(totalSec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) {
        return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    }
    return `${m}:${String(sec).padStart(2, '0')}`;
}

function parseTimeToken(token) {
    if (!/^\d+(?::\d{1,2}){0,2}$/.test(token)) return null;
    if (!token.includes(':')) return parseInt(token, 10);
    const parts = token.split(':').map(p => parseInt(p, 10));
    if (parts.some(n => Number.isNaN(n))) return null;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return null;
}

/** Quita hasta 2 tiempos al final: `.yt url 0:34 1:30` */
function splitQueryAndTrim(raw) {
    const parts = raw.trim().split(/\s+/);
    const times = [];
    while (parts.length > 0) {
        const sec = parseTimeToken(parts[parts.length - 1]);
        if (sec === null) break;
        times.unshift(sec);
        parts.pop();
        if (times.length >= 2) break;
    }
    let startSec = null;
    let endSec = null;
    if (times.length >= 2) {
        startSec = times[0];
        endSec = times[1];
    }
    return { query: parts.join(' '), startSec, endSec };
}

function resolveClipDuration(fullDuration, startSec, endSec) {
    if (startSec != null && endSec != null) return endSec - startSec;
    return fullDuration || 0;
}

function ytdlpSectionTime(sec) {
    const s = Math.max(0, Math.floor(sec));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, '0')}`;
}

function convertToOpus({ inputUrl, inputPath, outputPath, trim }) {
    return new Promise((resolve, reject) => {
        let cmd;
        const inputOpts = ['-threads', '0'];

        if (inputUrl) {
            cmd = ffmpeg(inputUrl);
            inputOpts.push('-headers', FFMPEG_HEADERS);
        } else {
            cmd = ffmpeg(inputPath);
        }

        if (trim?.startSec != null && trim.startSec > 0) {
            inputOpts.push('-ss', String(trim.startSec));
        }

        cmd = cmd.inputOptions(inputOpts);

        const outOpts = ['-vn', '-map_metadata', '-1', '-threads', '0', '-application', 'voip'];
        if (trim?.startSec != null && trim?.endSec != null) {
            const dur = trim.endSec - trim.startSec;
            if (dur > 0) outOpts.push('-t', String(dur));
        }

        cmd
            .audioCodec('libopus')
            .audioBitrate(64)
            .audioChannels(1)
            .format('ogg')
            .outputOptions(outOpts)
            .on('error', reject)
            .on('end', resolve)
            .save(outputPath);
    });
}

function isYoutubeLink(query) {
    return /^https?:\/\//i.test(query) || /(?:youtu\.be\/|youtube\.com\/)/i.test(query);
}

function stripYoutubePlaylist(url) {
    try {
        const u = new URL(url);
        u.searchParams.delete('list');
        u.searchParams.delete('index');
        u.searchParams.delete('start_radio');
        return u.toString();
    } catch {
        return url;
    }
}

function toYtdlpTarget(query) {
    let url = query;
    if (/^https?:\/\//i.test(query)) url = query;
    else if (/(?:youtu\.be\/|youtube\.com\/)/i.test(query)) {
        url = query.startsWith('//') ? `https:${query}` : `https://${query.replace(/^\/\//, '')}`;
    } else {
        return `ytsearch1:${query}`;
    }
    return stripYoutubePlaylist(url);
}

function unwrapYtdlpInfo(raw) {
    if (!raw) return null;
    const firstEntry = raw.entries?.[0];
    if (firstEntry && (raw._type === 'playlist' || !raw.formats)) {
        return firstEntry;
    }
    return raw;
}

function pageUrlFromInfo(info) {
    if (info.webpage_url) return info.webpage_url;
    if (info.original_url) return info.original_url;
    if (info.id) return `https://www.youtube.com/watch?v=${info.id}`;
    return null;
}

function pickAudioUrl(info) {
    if (info.url && typeof info.url === 'string' && info.url.includes('googlevideo.com')) {
        return info.url;
    }

    if (!Array.isArray(info.formats)) return null;

    const withUrl = info.formats.filter(f => f.url && f.acodec !== 'none' && f.acodec !== undefined);
    const audioOnly = withUrl.filter(f => !f.vcodec || f.vcodec === 'none');
    const pool = audioOnly.length ? audioOnly : withUrl;

    pool.sort((a, b) => (b.abr || 0) - (a.abr || 0));

    const m4a = pool.find(f => f.ext === 'm4a' || f.container === 'm4a');
    if (m4a?.url) return m4a.url;
    if (pool[0]?.url) return pool[0].url;

    if (Array.isArray(info.requested_formats)) {
        const merged = info.requested_formats.find(f => f.url && f.acodec !== 'none');
        if (merged?.url) return merged.url;
    }

    const any = info.formats.find(f => f.url);
    return any?.url || null;
}

async function getUrlViaYtdlp(pageUrl) {
    const result = await youtubedl(pageUrl, {
        ...YTDLP_OPTS,
        format: 'bestaudio/best',
        getUrl: true,
        skipDownload: true
    });

    const url = String(result).trim().split('\n')[0];
    return url.startsWith('http') ? url : null;
}

async function resolveAudio(ytdlpTarget, originalQuery) {
    const raw = await youtubedl(ytdlpTarget, {
        ...YTDLP_OPTS,
        dumpSingleJson: true,
        format: 'bestaudio/best'
    });

    const info = unwrapYtdlpInfo(raw);
    if (!info) throw new Error('No se encontró información del video');

    const title = info.title || info.fulltitle || 'Sin título';
    const duration = Math.floor(info.duration || 0);
    const pageUrl = pageUrlFromInfo(info);

    let audioUrl = pickAudioUrl(info);

    if (!audioUrl && pageUrl) {
        audioUrl = await getUrlViaYtdlp(pageUrl);
    }

    if (!audioUrl) {
        console.error('[music] Debug — keys:', Object.keys(info), 'formats:', info.formats?.length ?? 0);
        throw new Error('No se pudo obtener URL de audio');
    }

    const ytdlpSource = isYoutubeLink(originalQuery)
        ? toYtdlpTarget(originalQuery)
        : (pageUrl || ytdlpTarget);

    console.log(`[music] Título: ${title} | Duración: ${duration}s`);
    return { title, duration, audioUrl, pageUrl, ytdlpSource };
}

async function downloadFromUrl(audioUrl, destPath) {
    const res = await fetch(audioUrl, {
        redirect: 'follow',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
            'Referer': 'https://www.youtube.com/',
            'Accept-Language': 'en-US,en;q=0.9'
        }
    });

    if (!res.ok) throw new Error(`Download failed: ${res.status}`);

    const body = res.body ? Readable.fromWeb(res.body) : null;
    if (!body) throw new Error('Download failed: empty body');
    await pipeline(body, createWriteStream(destPath));
}

async function downloadWithYtdlp(source, destPath, workDir, trim) {
    const base = path.join(workDir, `ytdlp-${Date.now()}`);
    const opts = {
        ...YTDLP_OPTS,
        format: 'bestaudio/best',
        output: `${base}.%(ext)s`,
        noPart: true
    };

    if (trim?.startSec != null && trim?.endSec != null) {
        opts.downloadSections = `*${ytdlpSectionTime(trim.startSec)}-${ytdlpSectionTime(trim.endSec)}`;
        opts.forceKeyframesAtCuts = true;
    }

    await youtubedl(source, opts);

    const files = await fs.readdir(workDir);
    const downloaded = files.find(f => f.startsWith(path.basename(base) + '.'));
    if (!downloaded) throw new Error('yt-dlp no generó archivo');

    await fs.rename(path.join(workDir, downloaded), destPath);
}
