// config.js
export default {
    bot: {
        // Owner principal (PN). En v7 también se soporta LID automáticamente.
        owner: '593978971824@s.whatsapp.net',

        // Prefijos de comandos
        prefix: {
            toggle: '.',          // .onov / .offov / .status
            public: ['.say', '.yt', '.play', '.p']
        },

        // Timeouts (ms)
        timeouts: {
            download: 25000,      // media download
            send: 20000,          // envío de mensajes
            reconnect: 10000      // espera entre reconexiones
        },

        // Límites
        limits: {
            ttsMaxChars: 1500,
            musicMaxDurationSec: 600,   // 10 min
            musicMaxSizeMB: 16
        }
    },

    // Modo de operación
    mode: {
        silent: true,             // sin mensajes de estado innecesarios
        markOnline: false,        // no aparece "en línea"
        syncFullHistory: false    // más rápido al conectar
    },

    // Logging
    logger: {
        level: 'silent'           // 'silent' | 'info' | 'debug'
    }
};