# 🍩 TSTO Scorpio Emulator — Document de Passation v15.5

> **Date** : 23 mars 2026
> **Version courante** : v15.5 (déployée et LIVE sur Netlify)
> **Statut** : Init ARM fonctionne partiellement, rendu limité à glClear (écran bleu sarcelle)

---

## 1. Vue d'ensemble du projet

### Objectif
Faire tourner **The Simpsons: Tapped Out** (TSTO) dans un navigateur web en émulant le binaire ARM natif (`libscorpio.so`) avec Unicorn.js + WebGL.

### Architecture
```
┌─────────────────────────────────────────────┐
│  Browser                                     │
│                                              │
│  ┌─────────────┐  ┌──────────────────────┐  │
│  │  WebGL       │←─│  GL Bridge           │  │
│  │  Canvas      │  │  (50+ GL functions)  │  │
│  └─────────────┘  └──────────▲───────────┘  │
│                              │               │
│  ┌──────────────────────────┴───────────┐   │
│  │  Scorpio Engine (scorpio-engine.js)   │   │
│  │  - ELF loader                         │   │
│  │  - ARM emulation (Unicorn.js)         │   │
│  │  - Shim dispatcher (332 shims)        │   │
│  │  - JNI bridge (Android JNI env)       │   │
│  │  - VFS (Virtual File System)          │   │
│  └──────────────────────────────────────┘   │
│                                              │
│  ┌──────────────────────────────────────┐   │
│  │  libscorpio.so (ARM binary, ~27 MB)   │   │
│  │  (EA/Bight Games native code)         │   │
│  └──────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
```

### Fichiers JS principaux
| Fichier | Rôle | Lignes (~) |
|---------|------|-----------|
| `js/scorpio-engine.js` | Moteur principal : ELF loader, hooks, shim dispatch, game loop | ~820 |
| `js/jni-bridge.js` | Environnement JNI Android complet (vtable, SharedPrefs, strings) | ~530 |
| `js/android-shims.js` | 332 shims libc/pthread/Android (fopen, malloc, pthread, etc.) | ~960 |
| `js/gl-bridge.js` | Bridge OpenGL ES 2.0 → WebGL | ~600 |
| `js/vfs.js` | Virtual File System (charge assets depuis /assets/) | ~550 |
| `js/elf-loader.js` | Parseur ELF + résolution des relocations | ~400 |
| `js/main.js` | UI + orchestration Init/Start/Render | ~300 |
| `js/shader-manager.js` | Gestionnaire de shaders GLSL | ~200 |
| `js/logger.js` | Système de logging avec download | ~150 |

---

## 2. Credentials & Déploiement

### Netlify
```
Token:   nfp_LryH8Vuiwo6Fyez9Vc8ErQCSwAFihEQrb334
Site ID: 09f5b92b-3e4b-4a8d-991f-f4aa649de20e
URL:     https://main--tsto-scorpio-emulator.netlify.app/
```

### Méthode de déploiement (API digest — la plus fiable)
Le déploiement par zip simple reste bloqué sur l'état "new". La méthode qui fonctionne :

**Étape 1** : Calculer les SHA1 de tous les fichiers
```bash
find . -type f | while read f; do
  REL=$(echo "$f" | sed 's|^\./||')
  SHA=$(sha1sum "$f" | cut -d' ' -f1)
  echo "\"/$REL\": \"$SHA\""
done
```

**Étape 2** : POST les digests pour créer un deploy
```bash
curl -X POST \
  -H "Authorization: Bearer nfp_LryH8Vuiwo6Fyez9Vc8ErQCSwAFihEQrb334" \
  -H "Content-Type: application/json" \
  -d '{"files": {"/index.html": "sha1...", "/js/main.js": "sha2...", ...}}' \
  "https://api.netlify.com/api/v1/sites/09f5b92b-3e4b-4a8d-991f-f4aa649de20e/deploys"
```
→ Retourne un `deploy_id` et la liste `required` (fichiers dont le SHA a changé)

**Étape 3** : Uploader UNIQUEMENT les fichiers `required`
```bash
curl -X PUT \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @./js/scorpio-engine.js \
  "https://api.netlify.com/api/v1/deploys/$DEPLOY_ID/files/js/scorpio-engine.js"
```

**Étape 4** : Vérifier le statut (doit passer de "uploading" → "ready")
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.netlify.com/api/v1/deploys/$DEPLOY_ID" | jq '.state'
```

### Ordinateur distant
- **Connection ID** : `conn_f4nn78g0twts3t864vwm` (Computer Use)
- **OS** : Ubuntu desktop avec Chrome
- **Utilisation** : Naviguer sur le site Netlify, cliquer les boutons, télécharger les logs
- **Downloads** : `/home/tasklet/Downloads/`
- **Skill file** : Lire `/agent/skills/connections/conn_f4nn78g0twts3t864vwm/SKILL.md` AVANT utilisation
- ⚠️ **Limitation** : Le transfert de fichiers volumineux (>10 MB) échoue. Transférer uniquement les fichiers JS modifiés (~200 KB max chacun)

### Procédure de test sur le PC distant
1. Ouvrir Chrome → `https://main--tsto-scorpio-emulator.netlify.app/`
2. **Ctrl+Shift+R** (hard refresh pour bypass le cache)
3. Cliquer **"⚡ Init Engine"** → attendre "Engine Initialized"
4. Cliquer **"▶️ Start"** → lance le game loop (rendu frame par frame)
5. Observer le canvas (actuellement : écran bleu sarcelle = glClear seul)
6. NE PAS cliquer "Full Render" — c'est en fait un bouton SHUTDOWN qui détruit le singleton
7. Cliquer **"📋 Download Logs"** et **"📋 Download ARM Trace"** pour récupérer les diagnostics
8. Copier les fichiers depuis `/home/tasklet/Downloads/` vers `/agent/home/`

---

## 3. Ce qui a été fait (v15.4 → v15.5)

### v15.4 (point de départ)
- Ajout de 99 shims fortifiés (`__strlen_chk`, `__memmove_chk`, etc.) → total 332 shims
- Hypothèse : les fonctions fortifiées manquantes causaient `strlen=0` → `fopen("")`
- **Résultat** : MÊME échec (214 instructions puis bail-out)

### v15.5 (corrections appliquées)
Trois fichiers modifiés : `jni-bridge.js`, `android-shims.js`, `scorpio-engine.js`

#### Correction 1 : SharedPreferences avec vraies valeurs
**Avant (v15.4)** : `getSharedPreference()` retournait `""` (string vide) pour TOUTES les clés
**Après (v15.5)** : Retourne des valeurs réalistes :
```javascript
this._sharedPreferences = {
    'bundleID': 'com.ea.game.simpsons4_row',
    'MHClientVersion': '4.65.5',
    'SellId': '859',
    'Region': 'row',
    'ServerEnvironment': 'prod',
    'DLCSource': 'dlc',
    'DLCLocation': '/data/data/com.ea.game.simpsons4_row/files/',
    'LandDataVersion': '4.65.5',
    'DLCSecretKey': 'tapped_out_secret_key_2013',
    // + d'autres clés...
};
```

#### Correction 2 : std::string layout en mémoire
**Avant** : `NewStringUTF` retournait un pointeur simple
**Après** : Écrit un vrai layout `std::string` compatible ARM (ptr, size, capacity) à l'adresse retournée, pour que le code ARM puisse lire les données de la string via des offsets mémoire.

#### Correction 3 : Flag "Full Render" corrigé
**Découverte critique** : Le flag à `BASE+0x1A466A8` ne contrôle PAS le "full render" :
- **flag=0** → chemin de rendu NORMAL (actuellement glClear car init incomplète)
- **flag=1** → chemin de SHUTDOWN/CLEANUP qui DÉTRUIT le singleton !

**Avant** : `toggleFullRender(true)` mettait flag=1 → déclenchait la destruction
**Après** : Le flag est TOUJOURS forcé à 0. Le bouton "Full Render" de l'UI a été préservé mais ne devrait pas être utilisé.

#### Correction 4 : Shims ajoutés
Nouveaux shims : `__cxa_guard_acquire/release`, `__cxa_begin_catch/end_catch`, `__cxa_allocate_exception`, etc. pour le support C++ exceptions/guards.

---

## 4. Diagnostic du problème actuel

### Symptôme
Après Init (8 étapes), le game loop tourne mais **chaque frame ne fait que glClear** (écran bleu sarcelle). Aucune géométrie n'est dessinée.

### Analyse de la trace ARM (500 instructions capturées)

La fonction appelée est `OGLESRender` à `BIN+0x1363d3c`.

**Instructions #1-#6** : Lecture du flag global à `0x11a466a8`
```
#6 BIN+0x1363d50 LDRB R4,[R0] → MEM:[0x11a466a8]=0x1
```
⚠️ Malgré notre forçage à 0, le flag est lu comme 1 ! Possible que l'init le remette à 1.

**Instructions #11-#14** : Appel `pthread_mutex_lock` (shim 0xe00005a0) → retourne 0 (correct)

**Instructions #15-#17** : Test du résultat de `pthread_mutex_lock` → R0=0xD01002F0 (non-null, OK) → continue

**Instructions #18+** : Lecture du singleton pointer → si NULL, bail-out

### Chaîne de causalité du problème
```
Init ARM (8 étapes)
  └─→ SharedPreferences retournent des strings
       └─→ Le code ARM essaie de lire les fichiers DLC/config
            └─→ fopen() retourne -1 (fichiers pas dans VFS)
                 └─→ Pas de scene data chargée
                      └─→ Singleton renderer initialisé mais VIDE (sous-systèmes à NULL)
                           └─→ OGLESRender vérifie singleton→subsystem → NULL
                                └─→ Bail-out → seulement glClear
```

### Ce qui fonctionne ✅
- Chargement ELF et résolution de 332 shims
- Émulation ARM (Unicorn.js) — exécute des milliers d'instructions
- JNI bridge complet (env, strings, classes, methods)
- VFS avec 27 MB d'assets core (shaders, textures, audio, splashes)
- WebGL initialisé et fonctionnel (glClear fonctionne)
- SharedPreferences retournent des valeurs (v15.5)

### Ce qui ne fonctionne pas ❌
- Le rendu ne dépasse pas glClear
- Le singleton renderer est "vide" (sous-systèmes internes non initialisés)
- Les fichiers DLC manquent → l'init ne peut pas charger la scène

---

## 5. Prochaines étapes (P0 → P2)

### P0 : Intégrer les DLC du serveur privé
L'utilisateur mentionne qu'un **serveur privé** a relancé le jeu et que les DLC sont disponibles dessus.

**Action** : 
1. Obtenir les fichiers DLC du serveur privé
2. Les intégrer dans le dossier `assets/` de l'émulateur
3. Mettre à jour le VFS (`vfs.js`) pour les servir au bon chemin (`/data/data/com.ea.game.simpsons4_row/files/dlc/...`)
4. Le code ARM pourra alors charger les configs, bâtiments, textures via `fopen()`

**Fichiers DLC critiques attendus** :
- `GameplayConfig.xml` — configuration du gameplay
- `BuildingGroups.xml` — définitions des bâtiments
- `Characters/*.xml` — données personnages
- `Land/*.xml` — données terrain
- Textures/meshes en format BGrm (paires de fichiers `0` = index, `1` = archive PK/ZIP)

**Format des assets** : Les fichiers d'assets EA utilisent le format **BGrm** :
- `0` = fichier index (header magic `BGrm`, ~800-4000 bytes)
- `1` = archive PK (ZIP) contenant les vrais assets
- Le code ARM natif sait lire ce format nativement

### P1 : Investiguer pourquoi le flag 0x1A466A8 revient à 1
Malgré le forçage à 0 dans `runFrame()`, le trace montre le flag lu à 1.
- Hypothèse : une des étapes d'init (Step 2 ou Step 5) écrit 1 à cette adresse
- **Action** : Ajouter un hook mémoire WRITE sur `BASE+0x1A466A8` pour tracer QUI écrit cette valeur
- Alternativement, forcer le flag à 0 dans le hook CODE juste AVANT l'instruction #6

### P1 bis : Logger les PLT calls non résolus pendant l'init
Pendant les 8 étapes d'init, beaucoup de fonctions PLT sont appelées et retournent un générique `return 0`. Certaines sont critiques.
- **Action** : Ajouter un compteur/logger dans le PLT dispatcher pour identifier les fonctions les plus appelées et celles qui retournent 0 alors qu'elles devraient retourner un pointeur.

### P2 : Augmenter le budget d'instructions
Actuellement chaque étape d'init a un budget limité d'instructions ARM. Certaines étapes pourraient avoir besoin de plus pour compléter l'initialisation.
- **Action** : Vérifier les budgets dans `callFunction()` et les augmenter si nécessaire.

### P2 bis : Support réseau (optionnel)
Le jeu essaie de se connecter aux serveurs EA pour l'authentification et le téléchargement de contenu. On pourrait simuler les réponses réseau.

---

## 6. Structure des fichiers

### Sur l'agent (/agent/home/)
```
/agent/home/
├── tsto-scorpio-emulator-v15.5.zip   # 37 MB — ZIP complet déployable
├── logs.txt                           # 281 KB — Logs complets du test v15.4
├── trace.txt                          # 55 KB — ARM trace (500 instructions)
├── tsto-diagnostic-v15.md             # Rapport diagnostic initial (certaines conclusions corrigées depuis)
├── tsto-dlc-explainer.md              # Explication DLC pour l'utilisateur
└── TSTO-HANDOFF-v15.5.md             # CE DOCUMENT
```

### Structure du zip déployable
```
tsto-scorpio-emulator-v15.5/
├── index.html              # Page principale
├── readme.md               # README du projet
├── sw.js                   # Service worker
├── _headers                # Headers Netlify (CORS, etc.)
├── bin/
│   └── libscorpio.so       # Binaire ARM (~27 MB)
├── lib/
│   ├── unicorn2.js         # Unicorn.js (émulateur ARM)
│   ├── unicorn2.wasm       # WASM du moteur Unicorn
│   └── unicorn2-wrapper.js # Wrapper
├── js/                     # Code JS (voir tableau section 1)
│   ├── scorpio-engine.js   # ← MODIFIÉ v15.5
│   ├── jni-bridge.js       # ← MODIFIÉ v15.5
│   ├── android-shims.js    # ← MODIFIÉ v15.5
│   ├── gl-bridge.js
│   ├── vfs.js
│   ├── elf-loader.js
│   ├── main.js
│   ├── shader-manager.js
│   └── logger.js
└── assets/
    ├── core/
    │   ├── res-core/        # Shaders + resources principales (10.3 MB)
    │   ├── core-large/      # Textures haute-res
    │   ├── core-medium/     # Textures mid-res
    │   ├── core-small/      # Textures basse-res
    │   ├── core-splashes-*/ # Écrans de chargement (~15 MB)
    │   └── support/         # Données support
    ├── audio/
    │   └── res-audio/       # Sons/musique (2.1 MB)
    └── dexopt/              # Profils DEX Android
```

---

## 7. Adresses mémoire critiques

| Adresse | Description |
|---------|-------------|
| `BASE+0x1A466A8` | Flag global : 0=render normal, 1=SHUTDOWN (détruit singleton) |
| `BASE+0x1A45728` | Pointeur vers le singleton renderer principal |
| `singleton+0xD1B` | Flag "render-ready" (forcé à 1 par l'engine) |
| `singleton+0xD24` | Pointeur sous-système (NULL = pas de rendu) |
| `0xE0000000+` | Zone des shims PLT (332 shims, 4 bytes chacun) |
| `0xD0000000+` | JNI env/tables |
| `0xD0100000+` | Zone allocation JNI (classes, objets, strings) |
| `0xC0000000+` | Heap des strings JNI (NewStringUTF) |
| `0xF0000000+` | Stack ARM |

### Calcul des adresses shim PLT
```
SHIM_BASE = 0xE0000000
shim_address = SHIM_BASE + (index * 4)
```
Les shims sont dans l'ordre défini par `getShims()` dans `android-shims.js`. Les 332 shims couvrent : libc (malloc, free, memcpy, strlen...), pthread, math, stdio (fopen, fread...), Android (property_get, log...), C++ (operator new/delete, __cxa_*...), fortified (__strlen_chk, __memcpy_chk...).

### Shims importants par adresse
| Adresse | Index | Fonction |
|---------|-------|----------|
| `0xE00005A0` | 360 (0x168) | `pthread_mutex_lock` |
| `0xE00005A4` | 361 (0x169) | `pthread_mutex_unlock` |

---

## 8. Notes techniques importantes

### ⚠️ Le bouton "Full Render" est un piège
Le code commente `flag=1` comme "full render" mais c'est en fait le chemin de **SHUTDOWN**. Quand flag=1, le code ARM :
1. Acquiert le mutex
2. Lit le singleton
3. **DÉTRUIT** le singleton (appelle le destructeur)
4. Appelle `closeWithError` / cleanup
5. Le singleton devient NULL → plus rien ne marche

### ⚠️ Le trace de 500 instructions inclut le shutdown
La trace dans `trace.txt` a été capturée avec le "Full Render" activé (flag=1), donc elle montre le chemin de destruction, PAS le chemin de rendu normal. Pour capturer une trace du rendu normal, il faut activer le tracing en mode flag=0.

### ⚠️ Les logs de v15.4 montrent "fopen MISS: (empty path)"
C'est parce qu'en v15.4 `getSharedPreference` retournait `""` pour tout. En v15.5 les SharedPrefs retournent des vraies valeurs, donc les paths `fopen` devraient maintenant être valides — mais les fichiers DLC correspondants manquent dans le VFS.

### Format std::string ARM (important pour JNI)
Le code ARM lit les strings avec un layout spécifique :
```
offset 0: pointer to char data
offset 4: length
offset 8: capacity
```
Le JNI bridge (v15.5) écrit ce layout quand il crée des strings. Si ce format est incorrect, le code ARM lira des données corrompues.

---

## 9. Pour commencer (checklist nouvel agent)

1. ☐ Lire ce document en entier
2. ☐ Lire `/agent/skills/connections/conn_f4nn78g0twts3t864vwm/SKILL.md` (utilisation du PC distant)
3. ☐ Extraire le zip v15.5 : `unzip /agent/home/tsto-scorpio-emulator-v15.5.zip -d /tmp/v15.5/`
4. ☐ Tester la version actuelle sur le PC distant (séquence Init → Start → observer)
5. ☐ Télécharger les NOUVEAUX logs et trace (post-v15.5) pour voir si les SharedPrefs ont amélioré les choses
6. ☐ Identifier les fichiers DLC nécessaires et les intégrer depuis le serveur privé
7. ☐ Ajouter un hook mémoire sur `BASE+0x1A466A8` pour tracer qui remet le flag à 1
8. ☐ Re-capturer une trace ARM en mode flag=0 (rendu normal) pour analyser le vrai chemin de rendu

---

*Document généré automatiquement — TSTO Scorpio Emulator Debug Session, 23 mars 2026*
