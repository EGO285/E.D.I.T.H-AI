import http from "http";
import { Boom } from "@hapi/boom";
import pino from "pino";
import qrcode from "qrcode-terminal";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";

// ────────────────────────────────────────────────────────────
//  CONFIGURATION (tout se règle via les variables d'environnement Render)
// ────────────────────────────────────────────────────────────
const CONFIG = {
  // Dossier où la session WhatsApp est sauvegardée (disque persistant Render).
  authDir: process.env.AUTH_DIR || "./auth_info",

  // Clé API Groq (obligatoire).
  groqApiKey: process.env.GROQ_API_KEY || "",

  // Modèle Groq utilisé.
  groqModel: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",

  // Nom de ton assistant.
  botName: process.env.BOT_NAME || "EDITH",

  // Préfixe qui déclenche le bot. Ex: "!edith bonjour"
  prefix: (process.env.PREFIX || "!edith").toLowerCase(),

  // En message privé, répondre à TOUT (true) ou seulement avec le préfixe (false) ?
  privateNoPrefix: (process.env.PRIVATE_NO_PREFIX || "true") === "true",

  // Si renseigné (ex "33612345678"), le bot ne répond QU'À ce numéro, partout.
  // Laisse vide pour répondre à tout le monde.
  ownerNumber: (process.env.OWNER_NUMBER || "").replace(/\D/g, ""),

  // Numéro DU BOT (celui qu'on connecte), format international sans "+" ni espaces
  // (ex "33612345678"). Si renseigné => connexion par CODE DE JUMELAGE (pairing code)
  // au lieu du QR code. Laisse vide pour utiliser le QR code classique.
  botNumber: (process.env.BOT_NUMBER || "").replace(/\D/g, ""),

  // Personnalité de l'assistant (system prompt).
  systemPrompt:
    process.env.SYSTEM_PROMPT ||
    `Tu es ${process.env.BOT_NAME || "EDITH"}, un assistant personnel intelligent et efficace qui répond sur WhatsApp.
Tu réponds en français par défaut, de façon claire, utile et concise (WhatsApp, donc pas de pavés inutiles).
Tu es direct, un peu vif, jamais robotique. Tu peux utiliser des emojis avec parcimonie.
Si on te demande quelque chose de factuel que tu ne sais pas, tu le dis honnêtement.`,

  // Nombre de messages d'historique gardés par conversation.
  historyLength: parseInt(process.env.HISTORY_LENGTH || "8", 10),

  port: process.env.PORT || 3000,
};

// Mémoire courte par conversation (RAM). Se vide au redémarrage, c'est normal.
const history = new Map();

// ────────────────────────────────────────────────────────────
//  APPEL À GROQ
// ────────────────────────────────────────────────────────────
async function askGroq(chatId, userText) {
  const past = history.get(chatId) || [];

  const messages = [
    { role: "system", content: CONFIG.systemPrompt },
    ...past,
    { role: "user", content: userText },
  ];

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CONFIG.groqApiKey}`,
    },
    body: JSON.stringify({
      model: CONFIG.groqModel,
      messages,
      temperature: 0.7,
      max_tokens: 1024,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const reply = data.choices?.[0]?.message?.content?.trim() || "🤔 (pas de réponse)";

  // On met à jour l'historique et on le tronque.
  const updated = [
    ...past,
    { role: "user", content: userText },
    { role: "assistant", content: reply },
  ].slice(-CONFIG.historyLength * 2);
  history.set(chatId, updated);

  return reply;
}

// ────────────────────────────────────────────────────────────
//  EXTRACTION DU TEXTE D'UN MESSAGE WHATSAPP
// ────────────────────────────────────────────────────────────
function extractText(msg) {
  const m = msg.message;
  if (!m) return "";
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ""
  ).trim();
}

// ────────────────────────────────────────────────────────────
//  BOT WHATSAPP
// ────────────────────────────────────────────────────────────
async function startBot() {
  if (!CONFIG.groqApiKey) {
    console.error("❌ GROQ_API_KEY manquante. Ajoute-la dans les variables d'environnement.");
    process.exit(1);
  }

  const { state, saveCreds } = await useMultiFileAuthState(CONFIG.authDir);
  const { version } = await fetchLatestBaileysVersion();

  const usePairing = Boolean(CONFIG.botNumber) && !state.creds.registered;
  let pairingRequested = false;

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  // Connexion par CODE DE JUMELAGE : on demande le code juste après le démarrage.
  if (usePairing) {
    setTimeout(async () => {
      if (pairingRequested) return;
      pairingRequested = true;
      try {
        const code = await sock.requestPairingCode(CONFIG.botNumber);
        const pretty = code?.match(/.{1,4}/g)?.join("-") || code;
        console.log("\n══════════════════════════════════════════");
        console.log(`🔑  CODE DE JUMELAGE : ${pretty}`);
        console.log("══════════════════════════════════════════");
        console.log("Sur le téléphone du bot :");
        console.log("WhatsApp > Réglages > Appareils connectés > Connecter un appareil");
        console.log("> Connecter avec le numéro de téléphone > saisis le code ci-dessus.\n");
      } catch (e) {
        console.error("❌ Impossible de générer le code de jumelage :", e.message);
        console.error("Vérifie que BOT_NUMBER est au bon format (ex 33612345678, sans + ni espaces).");
      }
    }, 3000);
  }

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    // On n'affiche le QR que si on N'utilise PAS le code de jumelage.
    if (qr && !usePairing) {
      console.log("\n📲 SCANNE CE QR CODE depuis WhatsApp > Appareils connectés :\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log(`✅ ${CONFIG.botName} est connecté à WhatsApp !`);
    }

    if (connection === "close") {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      console.log(`⚠️  Déconnecté (code ${code}).`, loggedOut ? "Session invalide, il faudra rescanner." : "Reconnexion...");
      if (!loggedOut) startBot();
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      try {
        if (!msg.message) continue;
        if (msg.key.fromMe) continue; // on ignore nos propres messages

        const chatId = msg.key.remoteJid;
        if (!chatId || chatId === "status@broadcast") continue;

        const isGroup = chatId.endsWith("@g.us");
        // Numéro de l'expéditeur (dans un groupe c'est participant, sinon remoteJid).
        const senderJid = isGroup ? msg.key.participant || "" : chatId;
        const senderNumber = senderJid.split("@")[0].split(":")[0];

        // Filtre "propriétaire" : si défini, ne répondre qu'à lui.
        if (CONFIG.ownerNumber && senderNumber !== CONFIG.ownerNumber) continue;

        let text = extractText(msg);
        if (!text) continue;

        // Décider si on doit répondre.
        const lower = text.toLowerCase();
        const hasPrefix = lower.startsWith(CONFIG.prefix);

        let shouldReply = false;
        if (isGroup) {
          shouldReply = hasPrefix; // en groupe, préfixe obligatoire
        } else {
          shouldReply = CONFIG.privateNoPrefix || hasPrefix; // en privé, selon config
        }
        if (!shouldReply) continue;

        // On enlève le préfixe du texte envoyé à l'IA.
        if (hasPrefix) text = text.slice(CONFIG.prefix.length).trim();
        if (!text) text = "Bonjour";

        // Indicateur "en train d'écrire".
        await sock.sendPresenceUpdate("composing", chatId);

        const reply = await askGroq(chatId, text);

        await sock.sendMessage(chatId, { text: reply }, { quoted: msg });
        console.log(`💬 [${isGroup ? "groupe" : "privé"}] ${senderNumber}: ${text.slice(0, 40)}...`);
      } catch (err) {
        console.error("Erreur en traitant un message:", err.message);
        try {
          await sock.sendMessage(msg.key.remoteJid, {
            text: "😵 Petit souci de mon côté, réessaie dans un instant.",
          });
        } catch {}
      }
    }
  });
}

// ────────────────────────────────────────────────────────────
//  MINI SERVEUR HTTP (pour que Render considère le service "vivant")
// ────────────────────────────────────────────────────────────
http
  .createServer((_, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(`${CONFIG.botName} tourne ✅`);
  })
  .listen(CONFIG.port, () => console.log(`🌐 Serveur HTTP sur le port ${CONFIG.port}`));

startBot().catch((e) => {
  console.error("Erreur fatale:", e);
  process.exit(1);
});
