# TSTO Scorpio Emulator — Étape 2 Status

## Date: 2026-03-30

## What's Working
- ✅ GameServer-Reborn on port 4242 (all endpoints verified)
- ✅ Proxy server on port 9090 (static + reverse proxy)
- ✅ Emulator init: 9 steps complete, no crashes
- ✅ Game loop: 200K+ logs in 60s, ~23 FPS
- ✅ Auto-dismiss dialogs (External Storage, etc.)
- ✅ JNI bridge: 344+ successful calls
- ✅ Core assets loaded (10.7 MB)

## Current Blocker: Zero Network Requests

### Root Cause
The ARM native code never opens HTTP sockets because the EA Nimble authentication flow never completes.

### Auth Flow (Real Android)
1. C++ calls onApplicationLaunch() ✅
2. Java NimbleSDK → EA servers → gets nucleus_token ❌ (no real SDK)
3. Java calls NimbleCppComponent_setup() → C++ registers ❌ (timeout >10K insns)
4. Java calls BaseNativeCallback_nativeCallback(token) ❌ (never reached)
5. C++ receives token → calls /connect/auth on game server ❌
6. C++ gets session → opens sockets → loads Director/town ❌

### Game Loop Behavior
- OGLESRender runs but returns after exactly 61 ARM instructions per frame
- Checks singleton at 0x12C2F34, finds auth not complete
- Redraws loading screen, returns
- Never opens sockets

### Key Memory Addresses
- Singleton: 0x12C2F34
  - +0x1B0: Set to 1 to prevent closeApp() quit
  - +0x1AC: BGCore pointer (rewritten each frame)
  - +0xD10: Unknown state field
- NimbleCppComponent_setup: .so offset 0x16d3f81
- BaseNativeCallback_nativeCallback: .so offset 0x16d9255
- onNimblePushTNGReady: .so offset 0x11b7328

### SharedPreferences Auth State
- CustomConfigBasicAuth = "" (empty)
- CustomConfigBasicAuthExpiry = "0"

## What Was Tried (Did Not Work)
1. Pre-auth with GameServer + inject token into SharedPreferences → C++ doesn't read from there
2. Call NimbleCppComponent_setup from JS → too many JNI calls, timeout
3. Call onNimblePushTNGReady → no effect without prior Nimble setup

## Next Steps (Recommended Approach)
1. Enable instruction tracing in scorpio-engine.js for the first OGLESRender call
2. Log every instruction: address, opcode, registers read
3. Find the conditional branch at ~instruction 61 that decides "auth not ready → return"
4. Identify the memory address that branch tests
5. Write the expected value to that address BEFORE OGLESRender to bypass the auth check
6. Alternative: search libscorpio.so (27MB ARM binary) for strings "nucleus", "access_token" to find auth storage
