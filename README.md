# 🍩 TSTO Scorpio Emulator

> **The Simpsons: Tapped Out** running in the browser — ARM emulation via Unicorn.js + WebGL rendering.

**Live demo**: https://tsto-scorpio-emulator.netlify.app/

## What is this?

An experimental web emulator that runs TSTO's native ARM game engine (`libscorpio.so`) directly in the browser:

- **[Unicorn.js](https://alexaltea.github.io/unicorn.js/)** — ARM CPU emulator (WASM)
- **WebGL** — OpenGL ES 2.0 bridge for GPU rendering
- **EA CDN** — DLC assets loaded on-demand via proxy (5,051 packages)
- **JNI Bridge** — Mock Android environment for the native code

## Status

| Component | Status |
|-----------|--------|
| ARM emulation | ✅ 62M+ instructions, 16.5K symbols resolved |
| WebGL pipeline | ✅ Shaders compiled, GL calls working |
| DLC system | ✅ Manifest built, CDN proxy active |
| Game loop | ✅ Running at 1 FPS |
| **Scene rendering** | ❌ Empty — JNI string bridge bug (see below) |

### 🔴 Current Blocker

The game engine can't read DLC file paths because `GetStringUTFChars()` stores strings in a JS Map but never writes the bytes into emulated ARM memory. The ARM code reads zeroes → `fopen("")` → no DLC loaded → empty render.

**Fix needed in**: `site/js/android-shims.js` — `GetStringUTFChars` must call `emu.mem_write()` to place string bytes in ARM-addressable memory.

See [CLAUDE-CODE-HANDOFF.md](CLAUDE-CODE-HANDOFF.md) for detailed debugging instructions.

## Repository Structure

```
├── apk/                        # Original game APK
│   └── Springfield-V07.apk     # v4.35.0 (75 MB)
│
├── site/                       # Deployable web app (Netlify)
│   ├── index.html              # UI with WebGL canvas
│   ├── _redirects              # Netlify proxy → EA CDN (CORS bypass)
│   ├── dlc-manifest.json       # 4,814 dirs → 5,051 DLC packages
│   ├── js/
│   │   ├── scorpio-engine.js   # ARM Unicorn engine + VFS
│   │   ├── android-shims.js    # libc hooks + JNI string bridge ← THE BUG
│   │   ├── jni-bridge.js       # JNI environment (SharedPrefs, DLC methods)
│   │   ├── gl-bridge.js        # OpenGL ES 2.0 → WebGL (50 functions)
│   │   ├── elf-loader.js       # ELF32 parser (segments, symbols, relocations)
│   │   ├── dlc-loader.js       # Lazy DLC loader (manifest → CDN → VFS)
│   │   ├── main.js             # Orchestrator + DLC retry loop
│   │   ├── vfs.js              # Virtual filesystem
│   │   ├── shader-manager.js   # GLSL shader compilation
│   │   └── logger.js           # Structured logging
│   ├── lib/                    # Unicorn.js WASM engine
│   ├── bin/                    # libscorpio.so (extracted from APK)
│   └── assets/                 # Core game assets (27 MB)
│
├── scripts/
│   ├── cli.js                  # Puppeteer CLI — headless testing
│   └── deploy.py               # Netlify deploy (digest API)
│
├── docs/
│   ├── TSTO-HANDOFF-v15.5.md   # Original project handoff document
│   └── README-technical.md     # Technical architecture notes
│
├── CLAUDE-CODE-HANDOFF.md      # 🎯 Start here for development
└── package.json                # npm scripts for common tasks
```

## Quick Start

### Run locally
```bash
npx serve site -l 8080
# Open http://localhost:8080
```

### Deploy to Netlify
```bash
python3 scripts/deploy.py
```

### Test headlessly (CLI)
```bash
npm install                           # Install Puppeteer
node scripts/cli.js test --verbose    # Full test cycle + logs
node scripts/cli.js fopen-misses      # Show failed file opens
node scripts/cli.js screenshot        # Take a screenshot
node scripts/cli.js logs --limit 500  # Dump engine logs
```

### Using the web UI
1. Click **"Initialize Engine"**
2. Click **"Start Game Loop"** (NOT "Simple Render")
3. ⚠️ **NEVER click "Full Render"** — it triggers shutdown and destroys the singleton
4. Watch the canvas + check console logs

## Architecture

```
┌──────────────┐     ┌──────────────┐     ┌───────────────┐
│  index.html  │────▶│   main.js    │────▶│ scorpio-      │
│  (UI/Canvas) │     │ (orchestr.)  │     │ engine.js     │
└──────────────┘     └──────────────┘     │ (ARM Unicorn) │
                                           └───────┬───────┘
                                                   │
                     ┌──────────────┐     ┌────────▼────────┐
                     │ dlc-loader.js│◀────│ android-shims.js│
                     │ (CDN fetch)  │     │ (JNI + libc)    │
                     └──────┬───────┘     └─────────────────┘
                            │
                     ┌──────▼───────┐
                     │ Netlify proxy│──▶ EA CDN (DLC assets)
                     │ (_redirects) │
                     └──────────────┘
```

## DLC System

The game loads ~5,051 DLC packages from EA's CDN. Since the CDN doesn't serve CORS headers, we proxy through Netlify:

- **`dlc-manifest.json`** maps each game directory to its CDN package URL
- **`_redirects`** proxies `/dlc-proxy/*` → EA CDN
- **`dlc-loader.js`** intercepts `fopen()` misses, downloads the needed DLC, and registers files in the VFS

The manifest was built by crawling 151 sub-indices from the [DLC-Downloader](https://github.com/TappedOutReborn/DLC-Downloader) project.

## Credits

- **[Project Springfield](https://teamtsto.org/)** — Private server keeping TSTO alive
- **[Unicorn Engine](https://www.unicorn-engine.org/)** — CPU emulator framework
- **[TappedOutReborn](https://github.com/TappedOutReborn)** — Server reimplementation & DLC tools
- **[AlexAltea/unicorn.js](https://github.com/AlexAltea/unicorn.js)** — JS/WASM port

## License

Experimental research project. The Simpsons: Tapped Out © Electronic Arts / Bight Interactive.
