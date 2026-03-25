/**
 * TSTO Web Emulator — Main Entry Point
 * Auto-loads libscorpio.so from the server, manages UI and game loop
 */
(function() {
    'use strict';

    // === State ===
    let engine = null;
    let paused = false;
    let frameCount = 0;
    let lastFpsTime = 0;
    let fps = 0;
    let gameLoopId = null;
    let totalGLCalls = 0;

    // === DOM ===
    const canvas    = document.getElementById('game-canvas');
    const btnInit   = document.getElementById('btn-init');
    const btnStart  = document.getElementById('btn-start');
    const btnPause  = document.getElementById('btn-pause');
    const btnStep   = document.getElementById('btn-step');
    const fpsDisp   = document.getElementById('fps-display');
    const insnDisp  = document.getElementById('insn-display');
    const glCount   = document.getElementById('gl-count');
    const glCallLog = document.getElementById('gl-calls-log');

    // Stat boxes
    const statFunctions   = document.getElementById('stat-functions');
    const statRelocations = document.getElementById('stat-relocations');
    const statSymbols     = document.getElementById('stat-symbols');
    const statGLCalls     = document.getElementById('stat-glcalls');

    // === Init Logger ===
    Logger.init();

    // === Button: Initialize Engine ===
    btnInit.addEventListener('click', async () => {
        btnInit.disabled = true;
        btnInit.textContent = '⏳ Initializing...';

        try {
            const soBuffer = window._scorpioSOBuffer;
            if (!soBuffer) {
                throw new Error('libscorpio.so not loaded yet! Refresh the page.');
            }

            Logger.info('Starting engine initialization...');
            Logger.info(`Binary size: ${(soBuffer.length / 1024 / 1024).toFixed(1)} MB`);

            // Create engine (exposed to window for debugging)
            engine = new ScorpioEngine();
            window._engine = engine;

            // Load binary into emulator
            await engine.load(soBuffer.buffer || soBuffer, canvas);

            // v15.2: Load shader files into VFS BEFORE running init
            if (engine.vfs) {
                Logger.info('📁 Loading shader files into VFS...');
                var vfsLoaded = await engine.vfs.loadShaderFiles();
                engine.vfs.addShadersXml(); // Add generated Shaders.xml
                Logger.success('📁 VFS ready: ' + vfsLoaded + ' shaders, ' + engine.vfs._files.size + ' total files');

                // v15.3: Load ALL game assets (textures, meshes, audio, splashes) into VFS
                Logger.info('🎮 Loading game assets into VFS (this may take a moment)...');
                var assetsLoaded = await engine.vfs.loadAllAssets();
                Logger.success('🎮 VFS fully loaded: ' + assetsLoaded + ' assets, ' + engine.vfs._files.size + ' total paths');
                window._vfs = engine.vfs; // expose for debugging

                // v15.5-DLC: Initialize DLC loader
                if (window.DLCLoader) {
                    Logger.info('📡 Initializing DLC loader...');
                    const dlcLoader = new DLCLoader(engine.vfs);
                    await dlcLoader.loadManifest();
                    engine.dlcLoader = dlcLoader;
                    window._dlcLoader = dlcLoader;
                }
            }

            // Update stats
            const stats = engine.getStats();
            statFunctions.textContent = stats.jniFunctions || 0;
            statRelocations.textContent = stats.relocations || 0;
            statSymbols.textContent = stats.symbols || 0;

            glContextCreated = true; // v14: Lock canvas size after GL init
            Logger.success('Engine loaded! Running init sequence...');

            // Run the initialization sequence with DLC retry loop
            const w = canvas.width;
            const h = canvas.height;
            
            const MAX_DLC_RETRIES = 10;
            let dlcRetry = 0;
            let lastMissCount = 0;
            
            while (dlcRetry <= MAX_DLC_RETRIES) {
                // Clear VFS miss log before each attempt
                if (engine.vfs) {
                    engine.vfs._missLog = [];
                    engine.vfs.missCount = 0;
                }
                
                Logger.info('🔄 Init attempt ' + (dlcRetry + 1) + '/' + (MAX_DLC_RETRIES + 1));
                await engine.runInit(w, h);
                
                // Check for VFS misses that could be DLC files
                if (engine.dlcLoader && engine.vfs && engine.vfs._missLog.length > 0) {
                    const misses = engine.vfs._missLog.slice();
                    Logger.info('[DLC] 🔍 ' + misses.length + ' VFS misses after init attempt ' + (dlcRetry + 1));
                    
                    // If same number of misses as last time, we're stuck
                    if (misses.length === lastMissCount && dlcRetry > 0) {
                        Logger.warn('[DLC] ⚠️ No progress — same miss count. Stopping retry loop.');
                        break;
                    }
                    lastMissCount = misses.length;
                    
                    const loaded = await engine.dlcLoader.resolveVFSMisses(misses);
                    if (loaded === 0) {
                        Logger.info('[DLC] No new DLC packages found for misses. Init complete.');
                        break;
                    }
                    
                    Logger.info('[DLC] 🔄 Loaded ' + loaded + ' new packages. Retrying init...');
                    dlcRetry++;
                    
                    // Reset engine state for re-init
                    if (engine.resetForRetry) {
                        engine.resetForRetry();
                    }
                } else {
                    Logger.info('[DLC] ✅ No VFS misses — init clean!');
                    break;
                }
            }
            
            if (dlcRetry > 0) {
                const dlcStats = engine.dlcLoader ? engine.dlcLoader.getStats() : {};
                Logger.success('🎮 DLC retry complete: ' + (dlcStats.packagesLoaded || 0) + ' packages, ' + 
                    (dlcStats.filesExtracted || 0) + ' files, ' + (dlcStats.downloadedMB || '0') + ' MB');
            }

            // Update stats again
            updateStats();

            btnInit.textContent = '✅ Engine Initialized';
            btnStart.disabled = false;
            btnStep.disabled = false;

            Logger.success('🍩 Engine initialized! Ready to run.');

            // v15.1: Initialize shader manager with game's real shaders
            if (engine.glBridge && engine.glBridge.gl && window.TSTOShaderManager) {
                Logger.info('🔧 Loading game shaders from APK assets...');
                const shaderMgr = new TSTOShaderManager(engine.glBridge.gl);
                const loaded = await shaderMgr.loadShaderSources();
                if (loaded) {
                    shaderMgr.compileAllVariants();
                    shaderMgr.testRendering = true; // Enable test rendering after ARM glClear
                    engine.glBridge.shaderManager = shaderMgr;
                    window._shaderManager = shaderMgr;
                    Logger.success('🎮 Game shaders compiled! Test rendering enabled.');
                }
            }

        } catch(err) {
            Logger.error('Init failed: ' + err.message);
            Logger.error(err.stack || '');
            btnInit.textContent = '❌ Init Failed (see log)';
            btnInit.disabled = false;
            console.error(err);
        }
    });

    // === Button: Start Game Loop ===
    btnStart.addEventListener('click', () => {
        if (!engine) return;
        paused = false;
        btnStart.disabled = true;
        btnPause.disabled = false;
        Logger.info('▶ Game loop started');
        gameLoop();
    });

    // === Button: Pause ===
    btnPause.addEventListener('click', () => {
        paused = true;
        btnStart.disabled = false;
        btnPause.disabled = true;
        if (gameLoopId) {
            cancelAnimationFrame(gameLoopId);
            gameLoopId = null;
        }
        Logger.info('⏸ Game loop paused');
    });

    // === Button: Step Frame ===
    btnStep.addEventListener('click', () => {
        if (!engine) return;
        Logger.info('⏭ Stepping one frame...');
        try {
            engine.runFrame();
            updateStats();
        } catch(err) {
            Logger.error('Frame error: ' + err.message);
        }
    });

    // === Button: Toggle Full Render ===
    const btnFullRender = document.getElementById('btn-full-render');
    if (btnFullRender) {
        btnFullRender.addEventListener('click', () => {
            if (!engine) return;
            const newState = !engine.useFullRender;
            engine.toggleFullRender(newState);
            btnFullRender.textContent = newState ? '🔥 Full Render ON' : '🟢 Simple Render';
            btnFullRender.style.background = newState ? '#e94560' : '#0f3460';
        });
    }

    // === Game Loop ===
    let consecutiveErrors = 0;
    const MAX_ERRORS = 3;

    function gameLoop() {
        if (paused || !engine) return;

        try {
            const result = engine.runFrame();
            
            // Check if frame actually executed ARM instructions
            if (result && result.success && result.instructions > 0) {
                consecutiveErrors = 0;
            } else if (result && !result.success) {
                consecutiveErrors++;
                if (consecutiveErrors >= MAX_ERRORS) {
                    Logger.error(`Game loop stopped: ${MAX_ERRORS} consecutive frame failures`);
                    if (result.error && result.error.includes('pthread_sigmask')) {
                        Logger.warn('⚠️ Stale cache detected! Press Ctrl+Shift+R (or Cmd+Shift+R on Mac) to hard refresh');
                    }
                    paused = true;
                    btnStart.disabled = false;
                    btnPause.disabled = true;
                    return;
                }
            }

            frameCount++;

            // v23: Draw JS loading screen on top of native GL output
            // Native renderer only produces glClear (black) because its rendering
            // sub-objects are not initialized. This gives visual feedback.
            if (engine && engine.glBridge && engine.glBridge.drawLoadingScreen) {
                engine.glBridge.drawLoadingScreen(frameCount);
            }

            // FPS counter
            const now = performance.now();
            if (now - lastFpsTime > 1000) {
                fps = frameCount;
                frameCount = 0;
                lastFpsTime = now;
                updateStats();

                // v14: Draw debug overlay on canvas
                if (engine && engine.glBridge && engine.glBridge.drawDebugOverlay) {
                    engine.glBridge.drawDebugOverlay(fps, engine.totalInstructions, engine.glBridge.callCount);
                }
            }
        } catch(err) {
            Logger.error('Frame error: ' + err.message);
            paused = true;
            btnStart.disabled = false;
            btnPause.disabled = true;
            return;
        }

        gameLoopId = requestAnimationFrame(gameLoop);
    }

    // === Update Stats Display ===
    function updateStats() {
        if (!engine) return;
        const stats = engine.getStats();

        fpsDisp.textContent = fps + ' FPS';
        insnDisp.textContent = formatNumber(stats.totalInstructions || 0) + ' instructions';
        glCount.textContent = (stats.glCalls || 0) + ' GL calls';

        statFunctions.textContent = stats.jniFunctions || 0;
        statRelocations.textContent = formatNumber(stats.relocations || 0);
        statSymbols.textContent = formatNumber(stats.symbols || 0);
        statGLCalls.textContent = stats.glCalls || 0;

        // Update header with more detail
        fpsDisp.textContent = fps + ' FPS';
        insnDisp.textContent = formatNumber(stats.totalInstructions || 0) + ' instructions';
        glCount.textContent = (stats.glCalls || 0) + ' GL calls';

        // Update auto-mapped indicator if many unmapped accesses
        if (stats.autoMapped > 0) {
            glCount.textContent += ` | ${stats.autoMapped} auto-mapped`;
        }
    }

    function formatNumber(n) {
        if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
        if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
        return String(n);
    }

    // === Canvas Input Events ===
    canvas.addEventListener('mousedown', (e) => {
        if (!engine || !engine.initialized) return;
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        engine.sendPointerDown(x, y);
        Logger.info(`👆 Pointer down (${x}, ${y})`);
    });

    canvas.addEventListener('mousemove', (e) => {
        if (!engine || !engine.initialized || !(e.buttons & 1)) return;
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        engine.sendPointerMove(x, y);
    });

    canvas.addEventListener('mouseup', (e) => {
        if (!engine || !engine.initialized) return;
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        engine.sendPointerUp(x, y);
    });

    // Touch support
    canvas.addEventListener('touchstart', (e) => {
        e.preventDefault();
        if (!engine || !engine.initialized) return;
        const rect = canvas.getBoundingClientRect();
        const t = e.touches[0];
        engine.sendPointerDown(t.clientX - rect.left, t.clientY - rect.top);
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
        e.preventDefault();
        if (!engine || !engine.initialized) return;
        const rect = canvas.getBoundingClientRect();
        const t = e.touches[0];
        engine.sendPointerMove(t.clientX - rect.left, t.clientY - rect.top);
    }, { passive: false });

    canvas.addEventListener('touchend', (e) => {
        e.preventDefault();
        if (!engine || !engine.initialized) return;
        engine.sendPointerUp(0, 0);
    }, { passive: false });

    // === Resize Canvas ===
    // v14: Only resize BEFORE GL context is created, to avoid destroying it
    // v22: Fixed for mobile — enforce minimum dimensions
    let glContextCreated = false;

    function resizeCanvas() {
        if (glContextCreated) return; // Don't resize after WebGL init - it destroys the context!
        const container = document.getElementById('canvas-container');

        // v22: Use multiple size sources, pick the best one
        var w, h;
        if (container && container.clientWidth > 100) {
            w = container.clientWidth;
            h = container.clientHeight;
        } else {
            // Container too small (collapsed flex, mobile, etc) — use window size
            w = window.innerWidth || document.documentElement.clientWidth || 960;
            h = window.innerHeight || document.documentElement.clientHeight || 640;
        }

        // Enforce sane minimums for the game (960x540 is minimum playable)
        w = Math.max(w, 960);
        h = Math.max(h, 540);

        // Cap maximums
        canvas.width = Math.min(w, 1280);
        canvas.height = Math.min(h, 720);

        console.log('[Canvas] Resized to ' + canvas.width + 'x' + canvas.height +
            ' (container: ' + (container ? container.clientWidth + 'x' + container.clientHeight : 'null') +
            ', window: ' + window.innerWidth + 'x' + window.innerHeight + ')');
    }

    window.addEventListener('resize', () => {
        if (!glContextCreated) resizeCanvas();
    });
    resizeCanvas();

    Logger.info('🍩 TSTO Web Emulator ready');
    Logger.info('Waiting for libscorpio.so to load...');

})();
