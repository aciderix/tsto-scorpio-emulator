# 📚 TSTO Scorpio Web Emulator — Documentation Complète

> **Date**: 25 Mars 2026  
> **Auteur**: Analyse automatisée croisée  
> **Sources**: APK patché `Springfield-V07.apk`, GameServer-Reborn, serveur live `gs.pjtsto.com:4246`, code emulateur, traces ARM

---

## Table des matières

1. [Vue d'ensemble du projet](#1-vue-densemble-du-projet)
2. [Architecture de l'émulateur](#2-architecture-de-lémulateur)
3. [Analyse de l'APK patché](#3-analyse-de-lapk-patché)
4. [Serveur privé TeamTSTO — Découverte et cartographie](#4-serveur-privé-teamtsto)
5. [Protocole complet du jeu](#5-protocole-complet-du-jeu)
6. [Flux d'authentification](#6-flux-dauthentification)
7. [Définitions Protobuf](#7-définitions-protobuf)
8. [GameServer-Reborn — Code source complet](#8-gameserver-reborn)
9. [État actuel de l'émulateur](#9-état-actuel-de-lémulateur)
10. [Diagnostic : pourquoi l'écran est teal](#10-diagnostic)
11. [Plan d'implémentation des shims réseau](#11-plan-dimplémentation)
12. [Inventaire complet des fichiers](#12-inventaire-des-fichiers)
13. [Secrets et clés](#13-secrets-et-clés)
14. [Pipeline CI/CD](#14-pipeline-cicd)

---

## 1. Vue d'ensemble du projet

### Objectif
Faire tourner **The Simpsons: Tapped Out** (TSTO) dans un navigateur web en émulant le binaire ARM natif (`libscorpio.so`) via **Unicorn.js** (émulateur CPU) et **WebGL** (rendu graphique).

### Le défi fondamental
TSTO est un jeu **online-only**. Le binaire ARM :
1. Initialise les sous-systèmes (mémoire, threads, mutexes)
2. **Contacte un serveur EA** pour l'authentification
3. Reçoit des données serveur (direction, config, land, currency)
4. **Seulement après** crée les objets de rendu et démarre le gameplay

Sans réponses serveur → la state machine reste bloquée → le renderer n'est jamais créé → écran teal.

### La solution
Le binaire dans l'APK est **déjà patché** pour se connecter au serveur privé TeamTSTO (`gs.pjtsto.com:4246`). On doit :
1. Rendre les shims réseau fonctionnels (socket, connect, send, recv)
2. Intercepter le trafic ARM et le router vers le serveur réel (ou un mock local)
3. Servir les réponses serveur de manière **synchrone** (contrainte Unicorn.js)

---

## 2. Architecture de l'émulateur

### Fichiers source (11 fichiers JS + 1 HTML)

```
site/
├── index.html              # Page principale, canvas WebGL, contrôles UI
├── js/
│   ├── main.js             # Point d'entrée, boucle de jeu, gestion UI
│   ├── scorpio-engine.js   # Moteur principal : charge ELF, configure Unicorn, exécute ARM
│   ├── elf-loader.js       # Parseur ELF : sections, segments, symboles, relocations
│   ├── android-shims.js    # ~2200 lignes — Simule libc/libm/libdl/libGLESv2/liblog
│   ├── jni-bridge.js       # Bridge Java↔C : classes, méthodes, SharedPreferences
│   ├── gl-bridge.js        # Traduction OpenGL ES 2.0 → WebGL 2.0
│   ├── shader-manager.js   # Compilation et cache des shaders GLSL
│   ├── dlc-loader.js       # Chargement des assets DLC (ZIP)
│   ├── vfs.js              # Système de fichiers virtuel (APK assets, saves)
│   ├── logger.js           # Logging avec niveaux, filtrage, export
│   └── splash-loader.js    # Écran de chargement
├── lib/
│   ├── unicorn2.js         # Unicorn.js (émulateur ARM Cortex-A15)
│   ├── unicorn2-wrapper.js # Wrapper high-level pour Unicorn
│   └── jszip.min.js        # Extraction ZIP pour DLC
└── sw.js                   # Service Worker (cache)
```

### Couches d'émulation

```
┌─────────────────────────────────────────────┐
│            Navigateur Web (Chrome)           │
├─────────────────────────────────────────────┤
│   main.js → Boucle de jeu (requestAnimFrame)│
├─────────────────────────────────────────────┤
│   scorpio-engine.js → Unicorn.js (ARM CPU)  │
│     ↕ Interruptions/hooks sur appels natifs │
├──────────────┬──────────────────────────────┤
│ android-     │ jni-bridge.js               │
│ shims.js     │ (Java → C interface)        │
│ (libc/libm/  │ Classes, méthodes, champs   │
│  pthreads/   │ SharedPreferences           │
│  réseau)     │ BGAndroidInfo               │
├──────────────┼──────────────────────────────┤
│ gl-bridge.js │ shader-manager.js           │
│ (GLES→WebGL) │ (GLSL compilation)          │
├──────────────┴──────────────────────────────┤
│ vfs.js (fichiers) │ dlc-loader.js (assets)  │
├─────────────────────────────────────────────┤
│         Canvas WebGL 2.0 (rendu)            │
└─────────────────────────────────────────────┘
```

---

## 3. Analyse de l'APK patché

### Fichier : `Springfield-V07.apk` (79 MB)

**Décompilation** effectuée le 25/03/2026. L'APK contient :
- `classes.dex` (9.3 MB) — Code Java Dalvik
- `classes2.dex` (1.5 MB) — Code Java supplémentaire
- `lib/armeabi-v7a/libscorpio.so` — Binaire ARM 32-bit (notre cible)
- `lib/armeabi-v7a/libscorpio-neon.so` — Variante NEON
- `lib/arm64-v8a/libscorpio.so` — Version ARM64
- `lib/arm64-v8a/libscorpio-neon.so` — Variante ARM64 NEON

### URLs patchées dans le binaire (.so)

| URL originale (EA) | URL patchée (TeamTSTO) |
|---|---|
| `https://prod.simpsons-ea.com` | **Remplacée** (absente du binaire) |
| `https://syn-dir.sn.eamobile.com` | **Remplacée** (absente du binaire) |
| DLC CDN originale | `https://cdn.projectspringfield.com:000...443/static/` |

### URL du serveur de jeu trouvée dans `classes.dex`

```
http://gs.pjtsto.com:4246
```

Cette URL a été trouvée via `strings classes.dex | grep "http://"`. C'est l'URL du **game server** TeamTSTO.

### URLs originales EA conservées dans classes.dex

| URL | Rôle |
|---|---|
| `https://director-int.sn.eamobile.com` | Director serveur EA (test) |
| `https://director-stage.sn.eamobile.com` | Director serveur EA (staging) |
| `http://www.ea.com` | Site EA |

### Routes du jeu trouvées dans libscorpio.so

```
/director/api/android/getDirectionByPackage
/games/bg_gameserver_plugin/protoWholeLandToken/
/games/bg_gameserver_plugin/protoClientConfig
/games/bg_gameserver_plugin/protoClientConfig/custom
/games/bg_gameserver_plugin/protocurrency/
/games/bg_gameserver_plugin/protoland/
/games/bg_gameserver_plugin/land/
/games/bg_gameserver_plugin/friendData
/games/bg_gameserver_plugin/friendData/origin
/games/bg_gameserver_plugin/friendData/facebook
/games/bg_gameserver_plugin/trackinglog/
/games/bg_gameserver_plugin/trackingmetrics/
/games/bg_gameserver_plugin/telemetrylog/
/games/bg_gameserver_plugin/currencyInventory/
/games/bg_gameserver_plugin/upgradeland/
/games/bg_gameserver_plugin/event/
/games/bg_gameserver_plugin/offers/
/games/bg_gameserver_plugin/checkToken/
/games/bg_gameserver_plugin/purchase/
/games/bg_gameserver_plugin/deleteToken/
/games/bg_gameserver_plugin/extraLandUpdate/
```

---

## 4. Serveur privé TeamTSTO

### Découverte

| Information | Valeur |
|---|---|
| **URL du game server** | `http://gs.pjtsto.com:4246` |
| **IP** | `65.109.95.184` |
| **Port** | `4246` |
| **Protocole** | HTTP (pas HTTPS) |
| **CDN DLC** | `https://cdn.projectspringfield.com` (IP: `65.109.95.183`) |
| **Dashboard public** | `https://ps-public.tsto.live` (via Cloudflare) |

### État du serveur (testé le 25/03/2026)

| Route | Méthode | Status | Réponse |
|---|---|---|---|
| `/` | GET | ✅ 200 | `OK` |
| `/director/api/android/getDirectionByPackage` | GET | ✅ 200 | JSON complet (2854 bytes) |
| `/mh/games/bg_gameserver_plugin/protoClientConfig/` | GET | ✅ 200 | Protobuf (5115 bytes) |
| `/connect/auth` | GET | ✅ 302 | Redirect → `signin.ea.com` |
| `/connect/auth` | POST | ❌ 404 | Pas de body |
| `/proxy/identity/pids/me/personas` | POST | ⚠️ 403 | `could not authenticate user` |
| `/mh/games/bg_gameserver_plugin/protocurrency/` | GET | ⚠️ 403 | `could not authenticate user` |
| `/mh/games/bg_gameserver_plugin/protoWholeLandToken/` | GET | ❌ 404 | (nécessite MayhemId dans l'URL) |
| `/probe/` | GET | ❌ 404 | `Unknown endpoint` |

### Réponse Director complète

Le serveur renvoie une config Direction JSON avec **34 services** tous pointant vers `http://65.109.95.184:4246` :

```json
{
  "DMGId": 0,
  "appUpgrade": 0,
  "bundleId": "com.ea.game.simpsons4_row",
  "clientId": "simpsons4-android-client",
  "clientSecret": "D0fpQvaBKmAgBRCwGPvROmBf96zHnAuZmNepQht44SgyhbCdCfFgtUTdCezpWpbRI8N6oPtb38aOVg2y",
  "facebookAPIKey": "43b9130333cc984c79d06aa0cad3a0c8",
  "facebookAppId": "185424538221919",
  "hwId": 2363,
  "mayhemGameCode": "bg_gameserver_plugin",
  "mdmAppKey": "simpsons-4-android",
  "packageId": "com.ea.game.simpsons4_row",
  "productId": 48302,
  "resultCode": 0,
  "sellId": 857120,
  "serverApiVersion": "1.0.0",
  "serverData": [
    {"key": "antelope.rtm.host", "value": "http://65.109.95.184:4246"},
    {"key": "origincasualapp.url", "value": "http://65.109.95.184:4246/loader/mobile/android/"},
    {"key": "akamai.url", "value": "http://65.109.95.184:4246/skumasset/gameasset/"},
    {"key": "nexus.connect", "value": "http://65.109.95.184:4246/{uuid}"},
    {"key": "synergy.tracking", "value": "http://65.109.95.184:4246/{uuid}"},
    {"key": "synergy.user", "value": "http://65.109.95.184:4246/{uuid}"},
    {"key": "nexus.portal", "value": "http://65.109.95.184:4246"},
    {"key": "service.discovery.url", "value": "http://65.109.95.184:4246"},
    {"key": "mayhem.url", "value": "http://65.109.95.184:4246"},
    {"key": "friends.url", "value": "http://65.109.95.184:4246"},
    {"key": "geoip.url", "value": "http://65.109.95.184:4246"},
    {"key": "nexus.proxy", "value": "http://65.109.95.184:4246"}
  ],
  "telemetryFreq": 300
}
```
*(Liste simplifiée — il y a 34 entrées serverData au total, toutes vers la même IP:port)*

### Réponse ClientConfig (décodée partiellement)

Contenu protobuf décodé (118 entrées de configuration) incluant :

| Clé | Valeur |
|---|---|
| `MinimumVersion.android` | `4.69.0` |
| `CurrentVersion.android` | `4.69.0` |
| `ServerSaveInterval` | `100` |
| `LocalSaveInterval` | `10` |
| `CheckDLCInterval` | `3600` |
| `MaxBuildingSoftCapLimit` | `19500` |
| `MaxBuildingHardCapLimit` | `30000` |
| `ConfigVersion` | `131` |
| `TntAuthUrl` | `https://auth.tnt-ea.com` |
| `TntNucleusUrl` | `https://nucleus.tnt-ea.com` |
| `OriginAvatarsUrl` | `http://65.109.95.184:4246` |
| `ServerVersion` | `local` |
| `GeolocationCountryCode` | `US` |
| `FriendsProxyUrl` | `https://friends.simpsons-ea.com` |

---

## 5. Protocole complet du jeu

### Séquence de démarrage (state machine ARM)

```
1. DNS resolve "gs.pjtsto.com" → 65.109.95.184
2. TCP connect 65.109.95.184:4246
3. GET /probe/                                       → 200 OK (vide)
4. GET /director/api/android/getDirectionByPackage   → JSON direction
   ?packageId=com.ea.game.simpsons4_row
5. GET /connect/auth                                 → {code, lnglv_token}
   ?response_type=code+lnglv_token
   &authenticator_login_type=mobile_anonymous
6. POST /connect/token                               → {access_token, id_token}
   ?grant_type=authorization_code
   &code={code_from_step_5}
7. GET /connect/tokeninfo                            → {user_id, persona_id, ...}
   Header: access_token: {access_token}
8. GET /proxy/identity/pids/{userId}/personas        → {personas: [...]}
   Header: Authorization: Bearer {access_token}
9. PUT /mh/users/?applicationUserId={userId}         → protobuf {MayhemId, SessionKey}
   Header: nucleus_token: {access_token}
10. GET /mh/games/bg_gameserver_plugin/protoClientConfig/  → protobuf ClientConfig
11. GET /mh/gameplayconfig/                          → protobuf GameplayConfig
12. POST /mh/games/bg_gameserver_plugin/protoWholeLandToken/{mayhemId}
    Header: nucleus_token: {access_token}           → protobuf {token, conflict}
13. GET /mh/games/bg_gameserver_plugin/protoland/{mayhemId}
    Header: nucleus_token: {access_token}
    Header: land-update-token: {wholeLandToken}     → protobuf LandMessage
    (Si 404 NO_SUCH_RESOURCE → nouveau joueur, tutoriel)
14. GET /mh/games/bg_gameserver_plugin/protocurrency/{mayhemId}
    Header: nucleus_token: {access_token}           → protobuf CurrencyData
15. GET /mh/games/lobby/time                        → XML {epochMilliseconds}
16. GET /proxy/identity/geoagerequirements          → JSON {country, minAge...}
17. GET /proxy/identity/links                       → JSON {pidGamePersonaMappings}
```

### Endpoints en fonctionnement continu

| Route | Méthode | Format | Description |
|---|---|---|---|
| `/mh/games/bg_gameserver_plugin/protoland/{mid}` | PUT | protobuf | Sauvegarde ville |
| `/mh/games/bg_gameserver_plugin/protoland/{mid}` | POST | protobuf | Mise à jour incrémentale |
| `/mh/games/bg_gameserver_plugin/extraLandUpdate/{mid}/protoland/` | POST | protobuf | Donuts, events, achat |
| `/mh/games/bg_gameserver_plugin/protocurrency/{mid}` | GET | protobuf | Lire donuts |
| `/mh/games/bg_gameserver_plugin/friendData` | POST | protobuf | Données amis |
| `/mh/games/bg_gameserver_plugin/friendData/origin` | GET | texte | Amis Origin |
| `/mh/games/bg_gameserver_plugin/trackinglog` | POST | protobuf | Logs d'erreurs client |
| `/mh/games/bg_gameserver_plugin/trackingmetrics` | POST | XML | Métriques |
| `/mh/games/bg_gameserver_plugin/event/{id}/protoland/` | GET | protobuf | Events spéciaux |
| `/mh/games/bg_gameserver_plugin/checkToken/{mid}/protoWholeLandToken/` | GET | protobuf | Vérifier token |
| `/mh/games/bg_gameserver_plugin/deleteToken/{mid}/protoWholeLandToken/` | POST | protobuf | Supprimer token |
| `/mh/link/{mid}/users` | POST | XML | Lier comptes |
| `/mh/clienttelemetry` | POST | protobuf | Télémétrie |

---

## 6. Flux d'authentification

### 6.1 Authentification anonyme (nouveau joueur)

```
Client → GET /connect/auth
          ?response_type=code+lnglv_token
          &authenticator_login_type=mobile_anonymous
       ← 200 { "code": "AC...", "lnglv_token": "AT..." }

Client → POST /connect/token
          ?grant_type=authorization_code
          &code=AC...
       ← 200 {
           "access_token": "AT...",
           "expires_in": 368435455,
           "id_token": "<JWT>",
           "token_type": "Bearer"
         }
```

### 6.2 Authentification email (joueur existant)

```
Client → GET /connect/auth
          ?response_type=code+lnglv_token
          &authenticator_login_type=mobile_ea_account
          &sig=<base64({email, cred})>.xxx
       ← 200 { "code": "AC...", "lnglv_token": "AT..." }
```

### 6.3 Structure du JWT (id_token)

```json
{
  "aud": "simpsons4-android-client",
  "iss": "accounts.ea.com",
  "iat": <timestamp>,
  "exp": <timestamp + 368435455>,
  "pid_id": "<userId>",
  "user_id": "<userId>",
  "persona_id": <userId_int>,
  "pid_type": "AUTHENTICATOR_ANONYMOUS",
  "auth_time": 0
}
```

**Clé de signature JWT** : `2Tok8RykmQD41uWDv5mI7JTZ7NIhcZAIPtiBm4Z5`

### 6.4 Token info

```
Client → GET /connect/tokeninfo
          Header: access_token: AT...
       ← 200 {
           "client_id": "long_live_token",
           "expires_in": 368435455,
           "persona_id": <userId>,
           "pid_id": "<userId>",
           "pid_type": "AUTHENTICATOR_ANONYMOUS",
           "scope": "offline basic.antelope.links.bulk openid signin ...",
           "user_id": "<userId>"
         }
```

### 6.5 Enregistrement utilisateur (PUT /mh/users/)

```
Client → PUT /mh/users/?applicationUserId=<userId>
          Header: nucleus_token: AT...
       ← 200 protobuf UsersResponseMessage {
           user: { userId: "<MayhemId>", telemetryId: "42" },
           token: { sessionKey: "" }
         }
```

---

## 7. Définitions Protobuf

Le fichier `TappedOut.proto` définit **72 messages** et **11 enums**. Voici les plus importants pour le flux réseau :

### Messages d'authentification

```protobuf
message UsersResponseMessage {
  optional UserIndirectData user = 1;  // {userId (=MayhemId), telemetryId}
  optional TokenData token = 2;        // {sessionKey}
}
```

### Messages de configuration

```protobuf
message ClientConfigResponse {
  repeated ClientConfigItem items = 2;  // 118 entrées clé-valeur
}

message GameplayConfigResponse {
  repeated NameValue item = 1;  // 184 entrées clé-valeur
}
```

### Messages de données de jeu

```protobuf
message LandMessage {
  optional string id = 1;                          // MayhemId
  optional FriendData friendData = 2;
  optional UserData userData = 3;                   // Level, XP, Money
  optional InnerLandData innerLandData = 4;         // Grid, timestamps
  optional TerrainData roadsData = 5;
  optional TerrainData riversData = 6;
  repeated BuildingData buildingData = 7;           // Bâtiments
  repeated CharacterData characterData = 8;         // Personnages
  repeated ConsumableData consumableData = 9;
  repeated JobData jobData = 10;                    // Tâches en cours
  repeated QuestData questData = 11;                // Quêtes
  repeated NotificationData notificationData = 12;
  repeated InventoryItemData inventoryItemData = 13;
  // ... 53 champs au total
}

message CurrencyData {
  optional string id = 1;              // MayhemId
  optional int32 vcTotalPurchased = 2; // Donuts achetés
  optional int32 vcTotalAwarded = 3;   // Donuts gagnés
  optional int32 vcBalance = 4;        // Solde donuts
  optional int64 createdAt = 5;
  optional int64 updatedAt = 6;
}

message WholeLandTokenResponse {
  optional string token = 1;    // UUID v4
  optional bool conflict = 2;   // false = OK
}
```

### Messages de mise à jour

```protobuf
message ExtraLandMessage {
  repeated CurrencyDelta currencyDelta = 1;  // Changements de donuts
  repeated EventMessage event = 2;            // Events entre joueurs
  repeated PushNotification pushNotification = 3;
}

message ExtraLandResponse {
  repeated CurrencyDelta processedCurrencyDelta = 1;
  repeated EventMessage processedEvent = 2;
  repeated EventMessage receivedEvent = 3;
  repeated CommunityGoal communityGoal = 4;
}
```

---

## 8. GameServer-Reborn

### Architecture

```
GameServer-Reborn/
├── src/
│   ├── index.js                          # Express app, port 4242
│   └── routes/
│       ├── routes.js                     # Router principal
│       ├── authRoutes/
│       │   ├── connect/
│       │   │   ├── connect.controller.js # GET /connect/auth, POST /connect/token, GET /connect/tokeninfo
│       │   │   └── tokenGen.js           # Génère AT/AC tokens (crypto random + base64url)
│       │   └── probe/
│       │       └── probe.controller.js   # GET /probe/ → 200 vide
│       ├── directorRoutes/
│       │   └── platform/
│       │       └── platform.controller.js # GET /director/api/{platform}/getDirectionByPackage
│       ├── mhRoutes/
│       │   ├── games/
│       │   │   └── games.controller.js   # protoClientConfig, protoland, protocurrency, etc.
│       │   ├── gameplayconfig/
│       │   │   └── gameplayconfig.controller.js
│       │   ├── users/
│       │   │   └── users.controller.js   # PUT/GET /mh/users/
│       │   ├── userstats/
│       │   ├── link/
│       │   └── clienttelemetry/
│       ├── proxyRoutes/
│       │   └── identity/
│       │       └── identity.controller.js # /pids/:who/personas, geoagerequirements, links, progreg
│       ├── trackingRoutes/
│       ├── dashboardRoutes/
│       └── userRoutes/
├── configs/
│   ├── ClientConfig.json                 # 118 entrées (594 lignes)
│   └── GameplayConfig.json               # 184 entrées (740 lignes)
├── directions/
│   └── com.ea.game.simpsons4_row.json    # Template direction (platform→IP remplacé au runtime)
├── TappedOut.proto                       # 72 messages protobuf
├── config.json                           # Port, IP, secrets, options
└── package.json                          # Express, protobufjs, jsonwebtoken, etc.
```

### Configuration serveur (`config.json`)

```json
{
  "verbose": true,
  "ip": "192.168.0.0",          // Remplacé par l'IP réelle au déploiement
  "listenPort": 4242,           // Port par défaut (TeamTSTO utilise 4246)
  "dataDirectory": "data",      // Stockage des saves utilisateur
  "startingDonuts": 0,
  "startingUID": 1000000000000,
  "startingMID": 3042000000000000,
  "adminKey": "",               // Généré aléatoirement au premier lancement
  "useSMTP": false,             // Email pour vérification
  "serveDlcsLocally": true,
  "localDlcFolder": "./dlc"
}
```

### Base de données SQLite

Table `UserData` :

| Colonne | Type | Description |
|---|---|---|
| MayhemId | text unique | ID Mayhem (identifiant de jeu) |
| UserId | int unique | ID utilisateur numérique |
| UserName | text unique | Nom d'affichage |
| UserEmail | text unique | Email (null si anonyme) |
| UserCred | int | Code de vérification email |
| UserAccessToken | string unique | Token AT (Bearer) |
| UserAccessCode | string unique | Token AC (authorization code) |
| UserRefreshToken | string unique | Non implémenté |
| SessionId | string unique | Non implémenté |
| SessionKey | string unique | Non implémenté |
| WholeLandToken | string | UUID v4 pour verrouiller le land |
| LandSavePath | string | Chemin fichier .land (protobuf) |
| CurrencySavePath | string | Chemin fichier .currency (protobuf) |

---

## 9. État actuel de l'émulateur

### ✅ Ce qui fonctionne

| Composant | État | Détails |
|---|---|---|
| Chargement ELF | ✅ | libscorpio.so (134 MB) chargé en mémoire |
| Emulation CPU (Unicorn.js) | ✅ | ARM Cortex-A15, 64 MB heap |
| Résolution de symboles | ✅ | 2042 symboles + 8424 relocations |
| Shims libc (printf, malloc, free, memcpy...) | ✅ | ~80 fonctions |
| Shims libm (sin, cos, sqrt...) | ✅ | ~20 fonctions |
| Shims pthreads | ✅ | mutex lock/unlock retournent 0 |
| JNI Bridge | ✅ | Classes, méthodes, SharedPreferences |
| WebGL 2.0 | ✅ | Initialisé avec extensions |
| Shader compilation | ✅ | Cache GLSL |
| Memory allocator | ✅ | Free-list : 329 allocs, 210 frees, 203 recycled |
| Init ARM (~4 secondes) | ✅ | Singleton créé, mutexes initialisés |
| Game loop (45 sec) | ✅ | 22 726 lignes de log, 0 crash |

### ❌ Ce qui ne fonctionne pas

| Composant | État | Impact |
|---|---|---|
| **Réseau (socket/connect/send/recv)** | ❌ Retournent -1 | **BLOQUANT** — le jeu ne peut pas contacter le serveur |
| DNS (getaddrinfo) | ❌ Retourne -1 | Pas de résolution de noms |
| SSL/TLS | ❌ Non shimmé | Pas de HTTPS |
| Threads (pthread_create) | ⚠️ 0 threads créés | Le jeu n'a pas avancé assez pour spawn des threads |
| dlsym | ⚠️ 0 appels | Aucune bibliothèque dynamique chargée |
| Renderer | ❌ Tous les pointeurs NULL | Le singleton n'a pas été initialisé par le serveur |
| DLC loading | ❌ Pas de CDN connecté | Les assets ne sont pas téléchargés |

### Trace ARM — Dernière exécution

```
Steps #1-11:  Init singleton → réussie
Steps #12,22: pthread_mutex_lock/unlock → retournent 0 ✅
Steps #13-46: Vérification de tous les champs du singleton :
              +0xD24 = 0 (render textures)     → NULL ❌
              +0x1B0 = 0 (counter/flag)         → NULL ❌
              +0x1AC = 0 (sprite object)        → NULL ❌
              +0xD10, +0xD4C, +0xD30 = 0       → NULL ❌
              → SAUTE tous les blocs de rendu
Steps #47-91: pthread_mutex_destroy + operator delete → NETTOYAGE
              → Le jeu DÉTRUIT les objets au lieu de dessiner
```

**Conclusion** : L'init ne va pas assez loin pour créer les objets de rendu car le jeu attend des réponses serveur.

---

## 10. Diagnostic

### Chaîne causale complète

```
socket() retourne -1
    ↓
Le jeu ne peut pas se connecter à gs.pjtsto.com:4246
    ↓
Pas de réponse /probe/ → la state machine ne démarre pas
    ↓
Pas de Direction → pas de config server
    ↓
Pas d'auth → pas de access_token
    ↓
Pas de PUT /mh/users/ → pas de MayhemId
    ↓
Pas de protoClientConfig → pas de configuration
    ↓
Pas de protoland → pas de données de ville
    ↓
Le singleton reste vide (champs +0xD24, +0x1B0, +0x1AC = NULL)
    ↓
Le renderer vérifie les pointeurs → tous NULL
    ↓
Saute les blocs de dessin → nettoyage → écran teal
```

---

## 11. Plan d'implémentation

### Approche recommandée : Pre-fetch + Cache synchrone

**Principe** : Avant de lancer l'émulation ARM, la page web fait des `fetch()` asynchrones vers le serveur réel, cache toutes les réponses en mémoire, puis les shims réseau servent les réponses de manière synchrone.

### Phase 1 — Pre-fetch des données serveur

Créer `server-prefetch.js` :

```javascript
class ServerPrefetch {
    constructor(serverUrl = 'http://gs.pjtsto.com:4246') {
        this.serverUrl = serverUrl;
        this.cache = new Map();
    }

    async prefetchAll() {
        // 1. Direction
        const direction = await this.fetch('/director/api/android/getDirectionByPackage?packageId=com.ea.game.simpsons4_row');
        
        // 2. Auth anonyme
        const auth = await this.fetch('/connect/auth?response_type=code+lnglv_token&authenticator_login_type=mobile_anonymous');
        
        // 3. Token
        const token = await this.fetchPost(`/connect/token?grant_type=authorization_code&code=${auth.code}`);
        
        // 4. Token info
        const tokenInfo = await this.fetch('/connect/tokeninfo', { 'access_token': token.access_token });
        
        // 5. Identity
        const identity = await this.fetch(`/proxy/identity/pids/${tokenInfo.user_id}/personas`, 
            { 'Authorization': `Bearer ${token.access_token}` });
        
        // 6. Register user
        const user = await this.fetchPut(`/mh/users/?applicationUserId=${tokenInfo.user_id}`,
            { 'nucleus_token': token.access_token });
        
        // 7. ClientConfig (protobuf)
        const clientConfig = await this.fetchBinary('/mh/games/bg_gameserver_plugin/protoClientConfig/');
        
        // 8. GameplayConfig (protobuf)
        const gameplayConfig = await this.fetchBinary('/mh/gameplayconfig/');
        
        // 9. WholeLandToken (protobuf)
        const landToken = await this.fetchPostBinary(
            `/mh/games/bg_gameserver_plugin/protoWholeLandToken/${user.mayhemId}`,
            { 'nucleus_token': token.access_token });
        
        // 10. Land data (protobuf) — peut être 404 si nouveau joueur
        const land = await this.fetchBinary(
            `/mh/games/bg_gameserver_plugin/protoland/${user.mayhemId}`,
            { 'nucleus_token': token.access_token, 'land-update-token': landToken.token });
        
        // 11. Currency (protobuf)
        const currency = await this.fetchBinary(
            `/mh/games/bg_gameserver_plugin/protocurrency/${user.mayhemId}`,
            { 'nucleus_token': token.access_token });
        
        // 12. Lobby time (XML)
        const lobbyTime = await this.fetchText('/mh/games/lobby/time');
        
        // Cache tout
        this.cache.set('direction', direction);
        this.cache.set('auth', auth);
        this.cache.set('token', token);
        this.cache.set('tokenInfo', tokenInfo);
        this.cache.set('identity', identity);
        this.cache.set('user', user);
        this.cache.set('clientConfig', clientConfig);
        this.cache.set('gameplayConfig', gameplayConfig);
        this.cache.set('landToken', landToken);
        this.cache.set('land', land);
        this.cache.set('currency', currency);
        this.cache.set('lobbyTime', lobbyTime);
        
        return this;
    }
}
```

### Phase 2 — Shims réseau fonctionnels

Modifier `android-shims.js` pour implémenter un vrai stack réseau simulé :

```javascript
// État réseau global
const networkState = {
    sockets: new Map(),    // fd → { domain, type, connected, sendBuffer, recvBuffer }
    nextFd: 100,
    httpParser: null,       // Parse les requêtes HTTP du code ARM
    prefetchCache: null,    // Référence vers ServerPrefetch
};

// Remplacer les shims actuels :
'socket': function(emu, args) {
    const domain = args[0];  // AF_INET = 2
    const type = args[1];    // SOCK_STREAM = 1
    const fd = networkState.nextFd++;
    networkState.sockets.set(fd, {
        domain, type,
        connected: false,
        sendBuffer: new Uint8Array(0),
        recvBuffer: new Uint8Array(0),
        httpRequest: '',
    });
    return fd;  // ← Retourne un vrai fd au lieu de -1
},

'connect': function(emu, args) {
    const fd = args[0];
    const sock = networkState.sockets.get(fd);
    if (sock) {
        sock.connected = true;
        // On ne fait pas de vrai connect — les données viendront du cache
    }
    return 0;  // ← Succès au lieu de -1
},

'send': function(emu, args) {
    const fd = args[0];
    const bufPtr = args[1];
    const len = args[2];
    const sock = networkState.sockets.get(fd);
    if (!sock) return -1;
    
    // Lire les données envoyées par l'ARM
    const data = emu.readMemory(bufPtr, len);
    sock.httpRequest += new TextDecoder().decode(data);
    
    // Quand la requête HTTP est complète, préparer la réponse
    if (sock.httpRequest.includes('\r\n\r\n')) {
        const response = matchAndServe(sock.httpRequest, networkState.prefetchCache);
        sock.recvBuffer = response;
        sock.httpRequest = '';
    }
    
    return len;  // Tout envoyé
},

'recv': function(emu, args) {
    const fd = args[0];
    const bufPtr = args[1];
    const maxLen = args[2];
    const sock = networkState.sockets.get(fd);
    if (!sock || sock.recvBuffer.length === 0) return 0;
    
    const toRead = Math.min(maxLen, sock.recvBuffer.length);
    emu.writeMemory(bufPtr, sock.recvBuffer.slice(0, toRead));
    sock.recvBuffer = sock.recvBuffer.slice(toRead);
    return toRead;
},
```

### Phase 3 — Matching URL → Réponse

```javascript
function matchAndServe(httpRequest, cache) {
    const [requestLine] = httpRequest.split('\r\n');
    const [method, path] = requestLine.split(' ');
    
    const routeMap = {
        '/probe/': () => httpResponse(200, ''),
        '/director/api/android/getDirectionByPackage': () => 
            httpResponse(200, JSON.stringify(cache.get('direction')), 'application/json'),
        '/connect/auth': () => 
            httpResponse(200, JSON.stringify(cache.get('auth')), 'application/json'),
        '/connect/token': () => 
            httpResponse(200, JSON.stringify(cache.get('token')), 'application/json'),
        '/connect/tokeninfo': () => 
            httpResponse(200, JSON.stringify(cache.get('tokenInfo')), 'application/json'),
        '/mh/users/': () => 
            httpResponse(200, cache.get('user'), 'application/x-protobuf'),
        '/mh/games/bg_gameserver_plugin/protoClientConfig/': () => 
            httpResponse(200, cache.get('clientConfig'), 'application/x-protobuf'),
        '/mh/gameplayconfig/': () => 
            httpResponse(200, cache.get('gameplayConfig'), 'application/x-protobuf'),
        // ... etc pour chaque route
    };
    
    for (const [route, handler] of Object.entries(routeMap)) {
        if (path.startsWith(route)) return handler();
    }
    
    return httpResponse(404, 'Not Found');
}
```

### Phase 4 — DNS et SSL

```javascript
'getaddrinfo': function(emu, args) {
    // Résoudre tout vers une fake IP (on intercepte au niveau socket)
    const hostname = emu.readString(args[0]);
    // Écrire une struct addrinfo en mémoire avec IP 10.0.0.1
    writeAddrInfo(emu, args[2], '10.0.0.1', 4246);
    return 0;  // Succès
},

// SSL : le serveur TeamTSTO utilise HTTP (pas HTTPS)
// donc SSL n'est pas nécessaire pour gs.pjtsto.com:4246
// Mais certains appels EA externes utilisent HTTPS
// → On les intercepte et les sert depuis le cache aussi
```

### ⚠️ Contrainte CORS

Le serveur `gs.pjtsto.com:4246` renvoie `Access-Control-Allow-Origin: *` sur la route Director. Si ce n'est pas le cas pour toutes les routes, il faudra un **proxy CORS** :

```
Navigateur → https://tsto-scorpio-emulator.netlify.app/api/proxy
           → Netlify Function → http://gs.pjtsto.com:4246/...
           → Réponse avec CORS headers ajoutés
```

---

## 12. Inventaire des fichiers

### Repos clonés (persistent: `/agent/home/tsto-repos/`)

| Repo | Fichiers | Taille | Description |
|---|---|---|---|
| `tsto-scorpio-emulator` | 67 | ~10 MB (sans .so) | Notre émulateur web |
| `GameServer-Reborn` | 72 | ~2 MB | Serveur privé Node.js complet |
| `TSTO-Toolbox` | 80 | ~5 MB | Outil Rust multifonction |
| `Patch-Apk` | 34 | ~1 MB | Patcher APK Python |
| `DLC-Downloader` | 33 | ~1 MB | Téléchargeur DLC Python |
| `GameplayConfig-Downloader` | 6 | ~100 KB | Téléchargeur config |

### Fichiers clés de l'émulateur

| Fichier | Lignes | Rôle |
|---|---|---|
| `site/js/android-shims.js` | ~2200 | **CRITIQUE** — C'est ici qu'il faut modifier les shims réseau |
| `site/js/jni-bridge.js` | ~800 | Bridge JNI — SharedPreferences, classes Java |
| `site/js/scorpio-engine.js` | ~1200 | Moteur principal — Unicorn, mémoire, hooks |
| `site/js/gl-bridge.js` | ~600 | OpenGL ES → WebGL |
| `site/js/main.js` | ~200 | UI, boucle de jeu |
| `site/js/elf-loader.js` | ~500 | Parseur ELF |

---

## 13. Secrets et clés

### Serveur TeamTSTO (live)

| Clé | Valeur | Source |
|---|---|---|
| Client ID | `simpsons4-android-client` | Direction JSON |
| Client Secret | `D0fpQvaBKmAgBRCwGPvROmBf96zHnAuZmNepQht44SgyhbCdCfFgtUTdCezpWpbRI8N6oPtb38aOVg2y` | Direction JSON |
| Facebook App ID | `185424538221919` | Direction JSON |
| Facebook API Key | `43b9130333cc984c79d06aa0cad3a0c8` | Direction JSON |

### GameServer-Reborn

| Clé | Valeur | Source |
|---|---|---|
| JWT Secret | `2Tok8RykmQD41uWDv5mI7JTZ7NIhcZAIPtiBm4Z5` | connect.controller.js |
| Starting UID | `1000000000000` | config.json |
| Starting MID | `3042000000000000` | config.json |
| DLC Secret Key | `tapped_out_secret_key_2013` | jni-bridge.js |

### Pipeline CI/CD

| Clé | Usage |
|---|---|
| BrowserBase API Key | `bb_live_NQsJLyjv4NWi8RBd996WRyeg2Rs` |
| BrowserBase Project ID | `dbe000eb-59d7-4a09-b1e4-aadba41b91e6` |
| GitHub PAT | `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` |
| Netlify Token | `nfp_LryH8Vuiwo6Fyez9Vc8ErQCSwAFihEQrb334` |
| Netlify Site ID | `09f5b92b-3e4b-4a8d-991f-f4aa649de20e` |

---

## 14. Pipeline CI/CD

### Architecture

```
Push code → GitHub Actions (branche claude/**)
    ↓
deploy.py → Déploie sur Netlify
    ↓
capture-logs.py → BrowserBase ouvre le site
    ↓
Clique #btn-init → Init moteur (~4s)
    ↓
Clique #btn-start → Game loop (45s)
    ↓
Extrait : report, ARM trace, logs, screenshot, stats
    ↓
Git commit + push → logs/ dans le repo
    ↓
Claude Code peut git pull les logs pour analyse
```

### Fichiers workflow

| Fichier | Rôle |
|---|---|
| `.github/workflows/capture-logs.yml` | Workflow principal |
| `scripts/deploy.py` | Déploie sur Netlify via API |
| `scripts/capture-logs.py` | Automatisation BrowserBase |

### Résultat Run #2 (25/03/2026)

✅ **SUCCÈS** — Pipeline complet :
- 6 fichiers générés (report 18KB, trace 10KB, logs 3.2MB, console 1.9MB, screenshot, stats)
- Commit 23 381 lignes
- Push réussi vers la branche claude/

---

## Annexe A — Comparaison serveur live vs GameServer-Reborn

| Aspect | `gs.pjtsto.com:4246` (live) | GameServer-Reborn (code source) |
|---|---|---|
| Port | 4246 | 4242 (configurable) |
| Langue | Go/Python (inconnu) | Node.js (Express) |
| Probe route | ❌ 404 `Unknown endpoint` | ✅ 200 vide |
| Director | ✅ Renvoie toutes les URLs vers 65.109.95.184 | ✅ Template JSON avec IP configurable |
| Auth anonyme (GET) | ⚠️ 302 redirect vers EA login | ✅ Crée un compte et renvoie code+token |
| Auth (POST token) | ❌ 404 | ✅ authorization_code → JWT |
| ClientConfig | ✅ 5115 bytes protobuf | ✅ Encode depuis ClientConfig.json |
| Currency | ⚠️ 403 sans auth | ✅ Crée currency avec donuts initiaux |
| Land | Nécessite auth | ✅ Lit/écrit fichiers .land |

**Observation** : Le serveur live TeamTSTO ne semble **pas** être une instance de GameServer-Reborn. Les routes ne correspondent pas (probe retourne 404, auth est redirigé vers EA login vrai). C'est probablement une implémentation Go/Python différente.

---

## Annexe B — Prochaines étapes recommandées

### Option A : Serveur mock local (le plus rapide) ⏱️ ~2-3 jours

1. Créer `mock-server.js` intégré à l'émulateur
2. Implémenter les 17 endpoints nécessaires avec des réponses hard-codées
3. Modifier `android-shims.js` pour router les sockets vers le mock
4. Avantage : pas de dépendance réseau, debug facile

### Option B : Proxy vers serveur live (le plus réaliste) ⏱️ ~4-5 jours

1. Créer une Netlify Function proxy pour contourner CORS
2. Pre-fetch les données serveur au chargement
3. Cache synchrone pour les shims ARM
4. Avantage : vraies données du serveur TeamTSTO

### Option C : Déployer GameServer-Reborn (contrôle total) ⏱️ ~3-4 jours

1. Déployer sur Railway/Render/Fly.io
2. Configurer l'IP et le port
3. Utiliser l'approach pre-fetch + cache
4. Avantage : on contrôle tout, on peut modifier les configs

**Recommandation** : Commencer par Option A (mock local) pour valider que les shims réseau fonctionnent et que le jeu avance dans sa state machine. Puis migrer vers Option B ou C pour les vraies données.
