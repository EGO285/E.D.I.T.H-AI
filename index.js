import http from "http";
import fs from "fs";
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

  // Fournisseur d'IA : "groq" (défaut) ou "huggingface".
  aiProvider: (process.env.AI_PROVIDER || "groq").toLowerCase(),

  // Nom de ton assistant.
  botName: process.env.BOT_NAME || "EDITH",

  // Mots qui déclenchent le bot (la "commande"), séparés par des virgules.
  // Par défaut on accepte "edith", "!edith" et "/edith".
  triggers: (process.env.TRIGGERS || "!edith,/edith,edith")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
    // Les plus longs d'abord pour que "!edith" soit testé avant "edith".
    .sort((a, b) => b.length - a.length),

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

  // Répondre aussi quand TU écris depuis le téléphone du bot lui-même,
  // à condition de mettre le préfixe (ex "!edith ...") — pas de boucle possible.
  allowSelf: (process.env.ALLOW_SELF || "true") === "true",

  // Mets à "true" pour EFFACER la session au prochain démarrage (utile si les clés
  // de chiffrement sont cassées : "Bad MAC"). Il faudra re-jumeler.
  // ⚠️ REMETS-LE À "false" juste après avoir re-jumelé, sinon tu devras rejumeler
  //    à chaque redémarrage.
  resetSession: (process.env.RESET_SESSION || "false") === "true",

  port: process.env.PORT || 3000,
};

// ────────────────────────────────────────────────────────────
//  FOURNISSEURS D'IA (tous compatibles OpenAI : même format d'appel)
// ────────────────────────────────────────────────────────────
const PROVIDERS = {
  groq: {
    label: "Groq",
    url: "https://api.groq.com/openai/v1/chat/completions",
    key: process.env.GROQ_API_KEY || "",
    model: process.env.GROQ_MODEL || "openai/gpt-oss-20b",
  },
  huggingface: {
    label: "Hugging Face",
    url: "https://router.huggingface.co/v1/chat/completions",
    key: process.env.HF_TOKEN || "",
    // Format modèle : "org/Modele" ou "org/Modele:provider" (ex ":hf-inference").
    model: process.env.HF_MODEL || "meta-llama/Llama-3.1-8B-Instruct",
  },
};

const AI = PROVIDERS[CONFIG.aiProvider] || PROVIDERS.groq;

// Mémoire courte par conversation (RAM). Se vide au redémarrage, c'est normal.
const history = new Map();

// ────────────────────────────────────────────────────────────
//  APPEL À L'IA
// ────────────────────────────────────────────────────────────
async function askAI(chatId, userText) {
  const past = history.get(chatId) || [];

  const messages = [
    { role: "system", content: CONFIG.systemPrompt },
    ...past,
    { role: "user", content: userText },
  ];

  const res = await fetch(AI.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${AI.key}`,
    },
    body: JSON.stringify({
      model: AI.model,
      messages,
      temperature: 0.7,
      max_tokens: 1024,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`${AI.label} ${res.status}: ${errText}`);
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
//  DÉTECTION DE LA COMMANDE (ex: "edith ...", "!edith ...", "/edith ...")
//  Renvoie le déclencheur trouvé, ou null. On exige que le mot soit isolé
//  (suivi d'un espace, d'une ponctuation ou de la fin) pour éviter "edithier".
// ────────────────────────────────────────────────────────────
function matchTrigger(lowerText) {
  for (const t of CONFIG.triggers) {
    if (lowerText === t) return t;
    if (lowerText.startsWith(t)) {
      const nextChar = lowerText.charAt(t.length);
      if (/[\s,.:;!?]/.test(nextChar)) return t;
    }
  }
  return null;
}

// Texte du message d'aide (commande "edith help").
function helpText() {
  const b = CONFIG.botName;
  const trig = CONFIG.triggers.join(" / ");
  return (
    `🤖 *${b}* — ton assistant IA (cerveau : ${AI.label})\n\n` +
    `Pour me parler, écris simplement ta question.\n` +
    `• En privé : écris-moi directement.\n` +
    `• En groupe : commence par *${CONFIG.triggers[0]}* (ex : ${CONFIG.triggers[0]} explique-moi X).\n\n` +
    `Déclencheurs reconnus : ${trig}\n\n` +
    `*Commandes :*\n` +
    `• *${CONFIG.triggers[0]} help* — affiche ce message\n` +
    `• *${CONFIG.triggers[0]} reset* — oublie notre conversation et repart à zéro\n\n` +
    `Exemples :\n` +
    `• ${CONFIG.triggers[0]} raconte-moi une blague\n` +
    `• ${CONFIG.triggers[0]} résume-moi la 2e guerre mondiale en 3 phrases`
  );
}

// ────────────────────────────────────────────────────────────
//  BOT WHATSAPP
// ────────────────────────────────────────────────────────────
async function startBot() {
  if (!AI.key) {
    const varName = CONFIG.aiProvider === "huggingface" ? "HF_TOKEN" : "GROQ_API_KEY";
    console.error(`❌ ${varName} manquante. Ajoute-la dans les variables d'environnement.`);
    process.exit(1);
  }
  console.log(`🧠 Cerveau IA : ${AI.label} (modèle : ${AI.model})`);

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

      if (loggedOut) {
        // Session morte (401) : on coupe proprement l'ancien socket (sinon il tente
        // d'écrire dans le dossier et plante), on efface la session, on recrée le
        // dossier vide, puis on repart => nouveau code de jumelage automatique.
        console.log(`⚠️  Session expirée (code ${code}). Nettoyage et régénération d'une nouvelle connexion...`);
        try { sock.ev.removeAllListeners(); } catch {}
        try { sock.end(undefined); } catch {}
        try {
          fs.rmSync(CONFIG.authDir, { recursive: true, force: true });
          fs.mkdirSync(CONFIG.authDir, { recursive: true });
        } catch (e) {
          console.error("Erreur en effaçant la session:", e.message);
        }
      } else {
        console.log(`⚠️  Déconnecté (code ${code}). Reconnexion...`);
      }
      setTimeout(() => startBot(), 2500);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      try {
        if (!msg.message) continue;

        const chatId = msg.key.remoteJid;
        if (!chatId || chatId === "status@broadcast") continue;

        const isGroup = chatId.endsWith("@g.us");
        const fromMe = Boolean(msg.key.fromMe);

        let text = extractText(msg);
        if (!text) continue;

        const lower = text.toLowerCase();
        const trigger = matchTrigger(lower); // le déclencheur "edith"/"!edith"/... ou null
        const hasPrefix = Boolean(trigger);

        // Numéro de l'expéditeur (pour le filtre owner et les logs).
        const senderJid = isGroup ? msg.key.participant || "" : chatId;
        const senderNumber = fromMe
          ? "moi"
          : senderJid.split("@")[0].split(":")[0];

        // Décider si on doit répondre.
        let shouldReply = false;
        if (fromMe) {
          // Message envoyé depuis le téléphone du bot : on répond UNIQUEMENT avec la
          // commande. Les réponses du bot ne commencent pas par un déclencheur
          // => aucune boucle possible.
          shouldReply = CONFIG.allowSelf && hasPrefix;
        } else {
          // Filtre "propriétaire" : si défini, ne répondre qu'à lui.
          if (CONFIG.ownerNumber && senderNumber !== CONFIG.ownerNumber) continue;
          shouldReply = isGroup ? hasPrefix : CONFIG.privateNoPrefix || hasPrefix;
        }
        if (!shouldReply) continue;

        // On enlève le déclencheur du texte.
        if (trigger) text = text.slice(trigger.length).trim();

        // Commandes spéciales.
        const cmd = text.toLowerCase();
        if (["help", "aide", "?", "menu", "commandes"].includes(cmd)) {
          await sock.sendMessage(chatId, { text: helpText() }, { quoted: msg });
          console.log(`ℹ️  [${isGroup ? "groupe" : "privé"}] ${senderNumber}: help`);
          continue;
        }
        if (["reset", "clear", "reinitialiser", "réinitialiser", "oublie"].includes(cmd)) {
          history.delete(chatId);
          await sock.sendMessage(
            chatId,
            { text: "🧹 C'est effacé, on repart de zéro. De quoi tu veux parler ?" },
            { quoted: msg }
          );
          console.log(`♻️  [${isGroup ? "groupe" : "privé"}] ${senderNumber}: reset`);
          continue;
        }

        // Message vide (juste "edith" tout seul) => petit accueil.
        if (!text) text = "Salut ! Présente-toi en une phrase.";

        // Indicateur "en train d'écrire".
        await sock.sendPresenceUpdate("composing", chatId);

        const reply = await askAI(chatId, text);

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

// Réinitialisation de session (une seule fois au démarrage du process, PAS lors des
// reconnexions internes). Efface les clés cassées pour repartir propre.
if (CONFIG.resetSession) {
  try {
    fs.rmSync(CONFIG.authDir, { recursive: true, force: true });
    console.log("🧹 RESET_SESSION actif : session effacée. Un nouveau jumelage sera nécessaire.");
    console.log("⚠️  Pense à remettre RESET_SESSION=false après le jumelage !");
  } catch (e) {
    console.error("Erreur en effaçant la session:", e.message);
  }
}

startBot().catch((e) => {
  console.error("Erreur fatale:", e);
  process.exit(1);
});
