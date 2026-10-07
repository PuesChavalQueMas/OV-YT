# 🦖 OnceView Fantasma Premium

Bot multifuncional para WhatsApp basado en **Baileys 7.0.0-rc14** con soporte para extracción silenciosa de mensajes de una sola vista (*View-Once*), conversión de texto a voz de alta velocidad (Google TTS) y descarga con soporte de recorte de audio desde YouTube.

---

## 📋 Estructura del Proyecto

```text
onceview-fantasma/
├── .gitignore
├── README.md
├── config.js
├── index.js
├── nodemon.json
├── package.json
└── handlers/
    ├── commandHandler.js
    ├── musicHandler.js
    └── replyDetector.js
```

---

## 🚀 Características

- 👁️ **OnceView Extractor**: Descarga imágenes y videos en formato *View-Once* al responder a un mensaje con el sistema activo.
- 🗣️ **Google TTS (`.say`)**: Convierte cualquier texto en nota de voz limpia y rápida con división automática por bloques.
- 🎵 **Música (`.yt`, `.play`, `.p`)**: Convierte y descarga audios de YouTube en formato Voice Note (PTT/Opus) con soporte para recortes directos por marcas de tiempo.
- 📱 **Pairing Code Directo**: Inicia sesión utilizando el código de vinculación por número telefónico sin necesidad de código QR.

---

## 🛠️ Requisitos Previos

- **Node.js**: Versión `20.0.0` o superior.
- **FFmpeg**: Configurado mediante dependencias estáticas incluidas (`ffmpeg-static`).

---

## 📦 Instalación

1. **Clonar el repositorio:**
   ```bash
   git clone https://github.com/TU_USUARIO/onceview-fantasma.git
   cd onceview-fantasma
   ```

2. **Instalar dependencias:**
   ```bash
   npm install
   ```

---

## ⚙️ Configuración

Edita el archivo `config.js` e introduce tu número telefónico principal con código de país (sin el signo `+`):

```javascript
// config.js
export default {
    bot: {
        owner: '593XXXXXXXXX@s.whatsapp.net', // Tu número en formato WhatsApp JID
        prefix: {
            toggle: '.',
            public: ['.say', '.yt', '.play', '.p']
        },
        // ...
    }
};
```

---

## 🚦 Ejecución y Comandos

### Iniciar el bot
```bash
npm start
```

### Modo Desarrollo (Nodemon)
```bash
npm run dev
```

---

### 💬 Lista de Comandos

| Comando | Descripción | Ejemplo de Uso |
| :--- | :--- | :--- |
| `.onov` | Activa la extracción silenciosa de View-Once | `.onov` |
| `.offov` | Desactiva el extractor | `.offov` |
| `.status` | Muestra el estado del bot y prefijos | `.status` |
| `.say <texto>` | Genera una nota de voz del texto ingresado | `.say Hola, probando voz rápida` |
| `.yt <nombre/link>` | Descarga el audio completo de YouTube | `.yt https://youtu.be/xxx` |
| `.yt <link> <inicio> <fin>` | Descarga un fragmento recortado por tiempos | `.yt https://youtu.be/xxx 0:30 1:45` |

---

## 📄 Licencia

Este proyecto está bajo la Licencia **ISC**.
