# 🍩 TSTO Web Emulator — Scorpio Engine ARM → WebGL Bridge

## What is this?

An experimental web-based emulator that runs **The Simpsons: Tapped Out**'s native ARM engine (`libscorpio.so`) directly in the browser using:

- **[Unicorn.js](https://alexaltea.github.io/unicorn.js/)** — ARM CPU emulator compiled to JavaScript via Emscripten
- **WebGL** — Browser's native GPU API (1:1 compatible with OpenGL ES 2.0)
- **JavaScript shims** — Mock implementations for Android/Linux system calls

## Architecture

```
┌─────────────────────────────────────────────┐
│  Browser                                     │
│                                              │
│  ┌─────────────┐  ┌──────────────────────┐  │
│  │  WebGL       │←─│  GL Bridge           │  │
│  │  Canvas      │  │  (50 GL functions)   │  │
│  └─────────────┘  └──────────▲───────────┘  │
│                               │              │
│  ┌────────────────────────────┼──────────┐  │
│  │  Unicorn.js ARM Emulator   │          │  │
│  │                            │          │  │
│  │  ┌──────────────────────────────────┐ │  │
│  │  │ libscorpio.so (26 MB ARM code)   │ │  │
│  │  │ 16,473 exported symbols          │ │  │
│  │  │ 74 JNI functions (97% working)   │ │  │
│  │  └──────────────────────────────────┘ │  │
│  │                                        │  │
│  │  Hooks:                                │  │
│  │  • GL calls → GL Bridge (WebGL)       │  │
│  │  • Android API → JS shims            │  │
│  │  • Memory access → auto-mapping      │  │
│  └───────────────────────────────────────┘  │
│                                              │
│  ┌─────────────┐  ┌──────────────────────┐  │
│  │  JNI Bridge  │  │  Android Shims       │  │
│  │  (mock env)  │  │  (libc, pthread,     │  │
│  │              │  │   OpenAL, crypto)    │  │
│  └─────────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────┘
```

## How to use

### 1. Extract libscorpio.so

From your APK (or the uploaded Springfield-V07.apk):
```bash
unzip Springfield-V07.apk lib/armeabi-v7a/libscorpio.so
```

### 2. Serve the web app

```bash
cd web-port
python3 -m http.server 8080
# or
npx serve .
```

### 3. Open in browser

Navigate to `http://localhost:8080` and select `libscorpio.so`.

## File Structure

```
web-port/
├── index.html              # Main page with WebGL canvas
├── js/
│   ├── logger.js           # Console logging with categories
│   ├── elf-loader.js       # ELF32 parser (headers, segments, symbols, relocations)
│   ├── android-shims.js    # Shims for 200+ Android/Linux functions
│   ├── jni-bridge.js       # Mock JNI environment (JNIEnv, JavaVM, jobject)
│   ├── gl-bridge.js        # OpenGL ES 2.0 → WebGL bridge (50 functions)
│   ├── scorpio-engine.js   # Main emulation controller
│   └── main.js             # Entry point, game loop, input handling
└── README.md               # This file
```

## PoC Results (verified with Python/Unicorn 2.x)

| Metric | Result |
|--------|--------|
| JNI functions tested | 74 |
| Success rate | **97% (72/74)** |
| BGCore.init | ✅ 4,495 instructions |
| ScorpioJNI.init | ✅ 50,000+ instructions |
| JNI_OnLoad | ✅ 1,322 instructions |
| OGLESInit/Render | ✅ Working |
| Input (pointer/key) | ✅ Working |
| GL functions mapped | 50/50 (100%) |

## Known Limitations

1. **Unicorn.js is v1.x** — may lack VFP/NEON support that the Python PoC uses with Unicorn 2.x
2. **Performance** — ARM emulation in JS is ~100-1000x slower than native. TSTO is a slow-paced game, so it may be acceptable for basic interaction
3. **Missing DLC assets** — Game textures/sounds need to be loaded separately (see [TappedOutReborn/DLC-Downloader](https://github.com/TappedOutReborn/DLC-Downloader))
4. **Shader compilation** — ARM code passes GLSL shaders as strings; reading them from emulator memory for WebGL compilation needs more work
5. **Thread simulation** — pthread calls are no-op'd; some game logic may expect threading

## Next Steps

- [ ] Test with real unicorn.js in browser
- [ ] Implement shader source extraction from emulator memory
- [ ] Add asset loading (textures, sounds)
- [ ] Connect to Project Springfield server API
- [ ] Performance profiling and optimization
- [ ] THUMB mode support for remaining functions

## Credits

- **[Project Springfield](https://teamtsto.org/)** — Private server keeping TSTO alive
- **[Unicorn Engine](https://www.unicorn-engine.org/)** — CPU emulator framework
- **[AlexAltea/unicorn.js](https://github.com/AlexAltea/unicorn.js)** — JavaScript port
- **[al1sant0s/tstorgb](https://github.com/al1sant0s/tstorgb)** — Texture extraction tool
- **[TappedOutReborn](https://github.com/TappedOutReborn)** — Server reimplementation and tools

## License

This is an experimental research project. The Simpsons: Tapped Out is © Electronic Arts / Bight Interactive.
