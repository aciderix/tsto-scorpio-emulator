# TSTO Scorpio Emulator — Claude Code Handoff

## Repo Structure

- `site/` — Deployable web app (Netlify)
- `scripts/` — CLI tools (Puppeteer + deploy)
- `apk/` — Original game APK (Springfield-V07.apk)
- `docs/` — Original project documentation

---

## TL;DR

L'émulateur **tourne** : 62M+ instructions ARM exécutées, WebGL opérationnel, game loop actif.
Mais le rendu est **vide** (glClear seul, zéro geometry) car **le code ARM ne reçoit pas les chemins DLC**.

**Le bug est dans le pont JNI string : les chaînes écrites en JS ne sont pas lues correctement par le code ARM émulé.**

---

## 🏗️ Architecture

```
┌─────────────┐     ┌──────────────┐     ┌───────────────┐
│  index.html │────▶│   main.js    │────▶│ scorpio-      │
│  (UI/Buttons)│    │  (orchestr.) │     │ engine.js     │
└─────────────┘     └──────────────┘     │ (ARM Unicorn) │
                                          └───────┬───────┘
                                                  │
                    ┌──────────────┐     ┌────────▼────────┐
                    │ dlc-loader.js│◀────│ android-shims.js│
                    │ (CDN fetch)  │     │ (JNI + libc)    │
                    └──────┬───────┘     └─────────────────┘
                           │
                    ┌──────▼───────┐
                    │ Netlify proxy│──▶ EA CDN
                    │ (_redirects) │
                    └──────────────┘
```

### Fichiers clés

| Fichier | Rôle | Lignes |
|---------|------|--------|
| `site/js/scorpio-engine.js` | Moteur ARM Unicorn, VFS, boucle émulation | ~1000 |
| `site/js/android-shims.js` | Hooks libc (fopen/fread/malloc) + pont JNI | ~700 |
| `site/js/jni-bridge.js` | Implémentation JNI (SharedPrefs, DLC methods) | ~500 |
| `site/js/main.js` | Orchestrateur UI + boucle retry DLC | ~400 |
| `site/js/dlc-loader.js` | Chargeur DLC paresseux (manifest → CDN → VFS) | ~400 |
| `site/dlc-manifest.json` | 4,814 dirs → 5,051 packages CDN (724 KB) | - |
| `site/_redirects` | Proxy Netlify `/dlc-proxy/*` → CDN EA | 1 |
| `site/index.html` | UI + capture console + boutons | ~560 |

---

## 🔴 LE BUG — JNI String Bridge

### Symptôme
```
[fopen] MISS:  mode=rb    ← chemin VIDE !
```
Un seul appel fopen intercepté, avec un chemin **vide**. Le jeu ne tente jamais d'ouvrir de fichier DLC.

### Flow attendu
```
1. ARM appelle getSharedPreference("DLCLocation") 
   → JNI retourne un handle Java String (jstring)
   
2. ARM appelle GetStringUTFChars(jstring) 
   → Doit retourner un POINTEUR vers les bytes en mémoire ARM
   
3. ARM construit le chemin complet : DLCLocation + "/" + filename
   
4. ARM appelle fopen(chemin_complet, "rb")
   → Notre hook lit le chemin depuis la mémoire ARM via _readCString()
```

### Ce qui se passe réellement

**Étape 2 est cassée.** Voici le code problématique dans `android-shims.js` :

```javascript
// _allocString : stocke la chaîne dans un Map JS et retourne une fausse adresse
_allocString(str) {
    var addr = this._nextStringAddr;      // Ex: 0xC0080000
    this._strings.set(addr, str);          // Stocké CÔTÉ JS seulement
    this._nextStringAddr += str.length + 16;
    return addr;                           // Adresse fictive retournée au code ARM
}
```

Le problème : quand le code ARM fait `GetStringUTFChars(handle)`, on retourne une adresse (0xC008xxxx) mais **les octets de la chaîne ne sont peut-être jamais écrits dans la mémoire Unicorn** via `emu.mem_write()`. 

Donc quand le code ARM lit à cette adresse pour construire le path fopen, il lit des **zéros** → chaîne vide → `fopen("")`.

### Vérifier dans le code

Chercher `_getOrWriteStringPtr` dans `android-shims.js` — c'est cette fonction qui DEVRAIT écrire les bytes en mémoire ARM :

```javascript
// VÉRIFIER : est-ce que cette fonction fait bien emu.mem_write() ?
_getOrWriteStringPtr(handle) {
    var str = this._strings.get(handle);
    // ... il FAUT écrire les bytes dans la mémoire Unicorn ici
    // emu.mem_write(ptr, Array.from(str).map(c => c.charCodeAt(0)).concat([0]));
}
```

### Fix probable
```javascript
_getOrWriteStringPtr(handle) {
    var str = this._strings.get(handle);
    if (!str) return 0;
    
    // Allouer de la mémoire dans le heap ARM
    var bytes = [];
    for (var i = 0; i < str.length; i++) {
        bytes.push(str.charCodeAt(i) & 0xFF);
    }
    bytes.push(0); // null terminator
    
    var ptr = this.malloc(bytes.length);
    
    // ÉCRIRE les bytes dans la mémoire Unicorn (c'est ça qui manque probablement)
    this.engine.emu.mem_write(ptr, bytes);
    
    return ptr;  // Le code ARM pourra maintenant lire les bytes à cette adresse
}
```

### Comment vérifier le fix
1. Modifier `android-shims.js`
2. `npm run deploy` (ou `python3 scripts/deploy.py`)
3. `npm run test:headless` — les logs doivent montrer des fopen avec des vrais chemins
4. `npm run test:fopen` — devrait montrer des chemins DLC comme `/data/data/com.ea.game.simpsons4_na/files/dlc/...`

---

## 🧰 CLI — Comment tout piloter sans navigateur

### Setup
```bash
npm install     # Installe Puppeteer (headless Chrome)
```

### Commandes

```bash
# Déployer sur Netlify après modification
npm run deploy
# ou
python3 scripts/deploy.py

# Test complet : init → start → 15s → dump logs + screenshot
npm run test:headless
# ou
node scripts/cli.js test --verbose

# Juste les fopen misses (le plus utile pour debugger)
npm run test:fopen

# Status du DLC loader
npm run test:dlc

# Logs complets vers un fichier
node scripts/cli.js logs --verbose --wait=20 --output=debug-logs.txt

# Screenshot du canvas
node scripts/cli.js screenshot --verbose

# Évaluer du JS arbitraire dans la page
node scripts/cli.js eval "window._capturedLogs.filter(l => l.msg.includes('fopen')).length"

# Changer le temps d'attente
node scripts/cli.js test --wait=30 --verbose

# Voir le navigateur (non-headless, pour debug visuel)
node scripts/cli.js test --no-headless --verbose
```

### Cycle de développement typique
```bash
# 1. Modifier le code
vim js/android-shims.js

# 2. Déployer
python3 scripts/deploy.py

# 3. Tester et voir les résultats
node scripts/cli.js fopen-misses --verbose

# 4. Itérer
```

---

## 📊 État actuel (23 mars 2026)

### Ce qui marche ✅
- **ARM émulation** : Unicorn.js exécute 62M+ instructions par session
- **WebGL** : 4 shaders compilés, 7 variants, GL calls exécutés
- **Game loop** : Tourne à 1 FPS, frame counter progresse
- **VFS** : 20 fichiers APK chargés (27.1 MB), fopen/fread fonctionnels
- **DLC infrastructure** : Manifest (5,051 packages), proxy Netlify, loader prêt
- **JNI bridge** : SharedPrefs retournent les bonnes valeurs côté JS
- **Bouton Download Logs** : Fixé (fallback data URI)

### Ce qui bloque ❌
- **JNI string bridge** : Les chaînes ne sont pas écrites en mémoire ARM
- **Rendu** : Chaque frame = `glClear(0,0,0,0)` seulement, zéro geometry
- **DLC loading** : Jamais déclenché car fopen ne reçoit jamais de vrais chemins

### Métriques de la dernière session
| Métrique | Valeur |
|----------|--------|
| Instructions ARM | 62.9M+ |
| GL Calls | 62+ |
| fopen MISS | 1 (chemin vide) |
| DLC téléchargés | 0 |
| Shaders compilés | 4 (7 variants) |
| VFS files loaded | 20 (27.1 MB) |

---

## 🗺️ Roadmap

### Phase 1 : Fix JNI String Bridge (P0 — CRITIQUE)
**Objectif** : Les fopen doivent recevoir des vrais chemins DLC

1. Auditer `_allocString()` et `_getOrWriteStringPtr()` dans `android-shims.js`
2. S'assurer que `emu.mem_write()` est appelé pour écrire les bytes de la chaîne en mémoire ARM
3. Vérifier aussi `NewStringUTF()` et `GetStringUTFChars()` dans le pont JNI
4. Tester : `node scripts/cli.js fopen-misses --verbose` devrait montrer des vrais chemins

### Phase 2 : DLC Loading (dépend de Phase 1)
**Objectif** : Les DLC se téléchargent et se chargent dans le VFS

Le système est déjà en place (`dlc-loader.js`). Une fois que fopen reçoit des vrais chemins :
1. Le hook fopen log le miss
2. `main.js` pause le game loop
3. `dlc-loader.js` cherche le chemin dans le manifest
4. Télécharge le package via le proxy Netlify (`/dlc-proxy/...`)
5. Extrait le ZIP (JSZip) et enregistre les fichiers dans le VFS
6. Relance le game loop

### Phase 3 : Rendu réel
**Objectif** : Voir Springfield à l'écran

Une fois les DLC chargés, les `fopen()` réussiront → le moteur chargera les données de scène → geometry draw → rendu visible.

---

## 🔑 Credentials

```
Netlify Token:   nfp_LryH8Vuiwo6Fyez9Vc8ErQCSwAFihEQrb334
Netlify Site ID: 09f5b92b-3e4b-4a8d-991f-f4aa649de20e
Site URL:        https://tsto-scorpio-emulator.netlify.app
```

---

## ⚠️ Pièges connus

1. **NE PAS cliquer "Full Render"** — C'est un bouton SHUTDOWN (flag=1 = destroy singleton)
2. **Deploy ZIP ne marche pas** — Reste bloqué sur "new". Utiliser TOUJOURS la méthode digest (`python3 scripts/deploy.py`)
3. **CDN EA n'a pas de CORS** — D'où le proxy Netlify `_redirects`
4. **Chaque package DLC** = ZIP externe contenant fichier `0` (header BGrm) + fichier `1` (ZIP interne avec les vrais assets)
5. **`_readCString`** lit les bytes depuis la mémoire ARM — si les bytes n'y sont pas écrits, elle retourne une chaîne vide silencieusement (catch vide)

---

## 📁 Structure du projet

```
tsto-scorpio-emulator/
├── index.html              # Page principale + UI
├── _redirects              # Proxy Netlify → CDN EA
├── dlc-manifest.json       # Manifest DLC (4,814 dirs → 5,051 packages)
├── package.json            # npm scripts + dépendances
├── CLAUDE-CODE-HANDOFF.md  # Ce document
├── js/
│   ├── main.js             # Orchestrateur + boucle retry DLC
│   ├── scorpio-engine.js   # Moteur ARM Unicorn + VFS
│   ├── android-shims.js    # ⭐ Hooks libc + JNI (LE BUG EST ICI)
│   ├── jni-bridge.js       # Implémentation JNI
│   ├── dlc-loader.js       # Chargeur DLC paresseux
│   └── logger.js           # Logger centralisé
├── scripts/
│   ├── cli.js              # CLI Puppeteer pour piloter l'émulateur
│   └── deploy.py           # Script de déploiement Netlify
└── assets/
    └── (APK assets: shaders, configs, etc.)
```
