# 🤖 EDITH — ton assistant WhatsApp

Un assistant IA perso branché sur WhatsApp, propulsé par Groq (gratuit).
Il répond quand tu l'appelles, **en privé comme dans les groupes**.

Tu n'as **aucune ligne de code à écrire**. Suis juste les étapes dans l'ordre.
Compte ~20-30 minutes la première fois.

---

## 🧠 Comment ça marche (en 10 secondes)

```
Ton WhatsApp  ⇄  le bot (sur Render, allumé 24/7)  ⇄  l'IA Groq
```

Le bot se connecte à WhatsApp comme "WhatsApp Web" (tu scannes un QR code une seule fois).

> ⚠️ **Important** : utilise de préférence un **numéro secondaire** pour le bot
> (pas ton numéro perso principal). C'est une connexion non-officielle : si le bot
> répondait à tout le monde en boucle, WhatsApp pourrait bannir le numéro. Réglé
> comme ici (il ne répond que sur commande, ou qu'à toi), le risque reste faible.

---

## ÉTAPE 1 — Récupérer ta clé Groq (gratuit, 2 min)

1. Va sur **https://console.groq.com**
2. Crée un compte (Google/GitHub, c'est direct).
3. Menu de gauche → **API Keys** → **Create API Key**.
4. Donne-lui un nom (ex `edith`), puis **copie la clé** (elle commence par `gsk_...`).

📌 **Garde cette clé de côté**, tu en auras besoin à l'étape 3.
(Si tu la perds, tu en recrées une, pas de souci.)

---

## ÉTAPE 2 — Mettre le code sur GitHub (5 min)

Render a besoin de lire le code depuis GitHub. Pas de terminal, tout se fait dans le navigateur.

1. Crée un compte sur **https://github.com** si tu n'en as pas.
2. Clique sur le **+** en haut à droite → **New repository**.
   - Nom : `edith-whatsapp`
   - Coche **Private** (perso, c'est mieux).
   - Clique **Create repository**.
3. Sur la page du repo vide, clique **"uploading an existing file"** (lien bleu au milieu).
4. **Glisse-dépose tous les fichiers** que je t'ai envoyés (le contenu du dossier) :
   `index.js`, `package.json`, `render.yaml`, `.gitignore`, `.env.example`, `GUIDE.md`.
   > ❌ N'uploade PAS le dossier `node_modules` s'il existe (inutile, Render le refait tout seul).
5. En bas, clique **Commit changes**.

✅ Ton code est en ligne.

---

## ÉTAPE 3 — Déployer sur Render (10 min)

1. Va sur **https://render.com** et connecte-toi **avec ton compte GitHub**.
2. En haut à droite → **New** → **Blueprint**.
3. Render te demande de choisir un repo → sélectionne **`edith-whatsapp`**.
   (Il va lire automatiquement le fichier `render.yaml` que je t'ai préparé.)
4. Render affiche le service `edith-whatsapp` avec le plan **Starter (~7$/mois)** et un disque.
   Il va te demander de remplir ces valeurs :
   - **`GROQ_API_KEY`** → colle ta clé Groq de l'étape 1.
   - **`BOT_NUMBER`** → le numéro **du bot** (celui que tu connectes), format
     international sans `+` ni espaces (ex `33612345678`). Ça active la connexion
     par **code de jumelage** (plus simple que le QR). Laisse vide si tu préfères
     le QR code.
   - **`OWNER_NUMBER`** → (optionnel) ton **vrai** numéro perso, même format. Si tu
     le remplis, **le bot ne répondra qu'à toi**, où que tu écrives. Laisse **vide**
     si tu veux qu'il réponde à tout le monde (avec la commande `!edith` en groupe).
5. Clique **Apply** / **Create**.

Render installe tout et démarre le bot. Ça prend 1-3 minutes.

> 💡 Si tu ne vois pas l'option "Blueprint", tu peux faire **New → Web Service**,
> choisir ton repo, et il utilisera quand même `render.yaml`. Pense juste à ajouter
> un **Disk** (mount path `/data`, 1 GB) et les variables si besoin.

---

## ÉTAPE 4 — Connecter WhatsApp

### 🔑 Méthode recommandée : code de jumelage (si tu as rempli `BOT_NUMBER`)

1. Dans Render, ouvre ton service → onglet **Logs**.
2. Attends de voir apparaître un bloc avec :
   ```
   🔑  CODE DE JUMELAGE : ABCD-1234
   ```
3. Sur le téléphone **du bot** : **WhatsApp → Réglages → Appareils connectés →
   Connecter un appareil → Connecter avec le numéro de téléphone**.
4. Saisis le **code à 8 caractères** affiché dans les logs.
5. Dès que c'est bon : `✅ EDITH est connecté à WhatsApp !`

> Le code est valable quelques minutes. S'il expire, redémarre le service
> (**Manual Deploy → Restart**) pour en générer un nouveau.

### 📲 Méthode alternative : QR code (si `BOT_NUMBER` est vide)

1. Onglet **Logs** → attends le **QR code en ASCII** (`📲 SCANNE CE QR CODE...`).
2. Sur le téléphone du bot : **WhatsApp → Appareils connectés → Connecter un
   appareil** → scanne le QR.

🎉 **C'est vivant.** La session est sauvegardée sur le disque : tu n'auras
**pas** à te reconnecter à chaque redémarrage.

---

## ÉTAPE 5 — Tester

- **En privé** : écris un message au numéro du bot → il répond direct.
- **Dans un groupe** (où le numéro du bot est présent) : écris
  `!edith c'est quoi la capitale du Japon ?` → il répond.

---

## ⚙️ Personnaliser (facultatif)

Dans Render → ton service → onglet **Environment**, tu peux modifier / ajouter :

| Variable | À quoi ça sert | Défaut |
|---|---|---|
| `BOT_NAME` | Le nom de ton assistant | `EDITH` |
| `PREFIX` | Le mot qui déclenche le bot en groupe | `!edith` |
| `PRIVATE_NO_PREFIX` | En privé, répondre à tout (`true`) ou seulement au préfixe (`false`) | `true` |
| `OWNER_NUMBER` | Ne répondre qu'à ce numéro (ex `33612345678`), vide = tout le monde | vide |
| `BOT_NUMBER` | Numéro du bot → connexion par code de jumelage. Vide = QR code | vide |
| `ALLOW_SELF` | Répondre quand TU écris depuis le tél du bot (avec le préfixe) | `true` |
| `SYSTEM_PROMPT` | La personnalité / les instructions de l'assistant | (défaut fourni) |
| `GROQ_MODEL` | Le modèle IA | `llama-3.3-70b-versatile` |

Après une modif, clique **Save Changes** → Render redémarre le bot tout seul
(pas besoin de rescanner le QR).

**Exemple de personnalité custom** (colle dans `SYSTEM_PROMPT`) :
```
Tu es EDITH, l'assistant perso de Kylian. Tu réponds en français, court et efficace,
avec un ton complice et un peu d'humour. Tu vas droit au but.
```

---

## 🆘 Problèmes courants

- **Pas de QR dans les logs** → attends 30 s, rafraîchis les logs. Vérifie que le
  service est bien "Live".
- **`GROQ_API_KEY manquante`** → tu as oublié de coller la clé (Environment → ajoute-la).
- **Le bot ne répond pas en groupe** → il faut le préfixe `!edith` devant ton message,
  et le numéro du bot doit être membre du groupe.
- **Le bot ne répond qu'à moi alors que je veux qu'il réponde à tous** → vide le
  champ `OWNER_NUMBER`.
- **Déconnexion "loggedOut"** → tu as retiré l'appareil depuis WhatsApp. Rescanne le
  QR dans les logs.

---

Voilà, tu as ton EDITH. Reviens me voir si tu veux lui ajouter des pouvoirs
(rappels, résumés de liens, recherche web, réponses vocales, etc.) — c'est là que
ça devient vraiment marrant. 6767.
