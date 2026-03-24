/**
 * TSTO Web Emulator — Scorpio Engine Controller
 * Manages the Unicorn.js ARM emulator, loads the ELF binary,
 * applies relocations, hooks GL/JNI calls, and runs the game loop
 *
 * v12.0: Real JNI vtable handlers + fixed memcpy/strlen
 *        JNI function table is now properly connected
 *        Generic return stub now returns 0 instead of garbage
 */
class ScorpioEngine {
    constructor() {
        this.emu = null;
        this.elf = null;
        this.jni = null;
        this.glBridge = null;
        this.shims = {};

        // Memory layout
        this.BASE = 0x10000000;
        this.STACK = 0xF0000000;
        this.STACK_SIZE = 2 * 1024 * 1024;
        this.HEAP = 0xD0000000;
        this.HEAP_SIZE = 32 * 1024 * 1024; // v15.3: increased from 4MB for game asset loading
        this.SHIM_BASE = 0xE0000000;
        this.SHIM_SIZE = 0x100000;
        this.RETURN_SENTINEL = this.SHIM_BASE + this.SHIM_SIZE - 0x1000; // Dedicated stop address for emu_start
        this.GENERIC_RETURN = this.SHIM_BASE + this.SHIM_SIZE - 0x2000; // v16: isolated generic return stub

        this.shimHandlers = new Map();
        this._nextShimAddr = this.SHIM_BASE + 0x100; // v16: skip first 256 bytes (reserved + protected)

        // State
        this.initialized = false;
        this.running = false;
        this.totalInstructions = 0;
        this._pcSamples = {};         // PC sampling for spin loop detection
        this._pcSampleInterval = 100000; // sample every 100K instructions
        this.savedSingletonPtr = 0; // v13.2: saved singleton for restoration
        this.memMapped = 0;

        // v15: Render path control
        this.useFullRender = false;       // false=simple(glClear only), true=full RenderScene
        this.maxFrameInsns = 10000000;    // instruction limit for game frames (10M safety cap)

        // v15.2: Virtual File System
        this.vfs = null;

        // Diagnostics
        this._autoMapped = new Set();
        this._unmappedAccessLog = [];
        this._maxUnmappedLog = 50;

        // ARM trace for Full Render debug
        this._traceEnabled = false;
        this._traceLog = [];
        this._traceMaxInsns = 500;  // capture first 500 instructions
        this._traceInsnsCount = 0;
        this._genericReturnCalls = new Map();

        // Render-phase diagnostics: track function calls during first few frames
        this._frameCallProfile = null; // Map of function name → count (active during profiled frames)
        this._frameProfileCount = 0;   // Number of frames profiled so far
        this._maxProfileFrames = 3;    // Profile first 3 frames
    }

    /**
     * Phase 1: Load the binary and set up emulation
     */
    async load(soBuffer, canvas) {
        Logger.info('=== Scorpio Engine v15.5: Loading (SharedPrefs + std::string shims + flag fix) ===');

        if (typeof uc === 'undefined' || !uc.Unicorn) {
            Logger.error('Unicorn.js not loaded!');
            return false;
        }
        Logger.success('Unicorn.js loaded OK (uc.Unicorn available)');

        // Parse ELF
        this.soBuffer = soBuffer;
        this.elf = new ElfLoader(soBuffer).parse();

        // Initialize WebGL
        try {
            this.glBridge = new GLBridge(canvas);
            if (this.glBridge.headless) {
                Logger.warn('WebGL not available - running without graphics');
            }
        } catch(e) {
            Logger.warn('WebGL init failed: ' + e.message + ' — continuing without graphics');
            this.glBridge = { headless: true, callCount: 0, drawCalls: 0, dispatch: function() {}, getShims: function() { return {}; }, getStats: function() { return { calls: 0, draws: 0 }; } };
        }

        // Initialize JNI
        this.jni = new JNIBridge();

        // v15.2: Initialize VFS
        if (window.VirtualFS) {
            this.vfs = new VirtualFS();
            Logger.info('[VFS] Virtual filesystem created');
        }

        // Apply data relocations BEFORE writing to Unicorn
        this._applyDataRelocations();

        // Create Unicorn emulator
        Logger.arm('Creating ARM emulator...');
        this.emu = new uc.Unicorn(uc.ARCH_ARM, uc.MODE_ARM);
        Logger.success('Unicorn.js ARM emulator created');

        // Map binary
        var mapSize = this.elf.mapSize;
        Logger.arm('Mapping binary: 0x' + this.BASE.toString(16) + ' - 0x' + (this.BASE + mapSize).toString(16) + ' (' + (mapSize/1024/1024).toFixed(1) + ' MB)');
        this.emu.mem_map(this.BASE, mapSize, uc.PROT_ALL);
        this.memMapped += mapSize;

        // Write relocated binary to Unicorn
        Logger.arm('Writing relocated binary to emulator memory...');
        var u8 = new Uint8Array(soBuffer);
        var CHUNK = 1024 * 1024;
        for (var off = 0; off < u8.length; off += CHUNK) {
            var end = Math.min(off + CHUNK, u8.length);
            var chunk = Array.from(u8.slice(off, end));
            this.emu.mem_write(this.BASE + off, chunk);
            if ((off / CHUNK) % 5 === 0) {
                Logger.arm('  Written ' + (off/1024/1024).toFixed(1) + ' / ' + (u8.length/1024/1024).toFixed(1) + ' MB');
            }
        }
        Logger.success('Binary loaded: ' + (u8.length/1024/1024).toFixed(1) + ' MB (with relocations applied)');

        // BSS
        for (var seg of this.elf.segments) {
            if (seg.type !== 1) continue;
            if (seg.memsz > seg.filesz) { /* zero-init by mem_map */ }
        }

        // Map stack
        this.emu.mem_map(this.STACK, this.STACK_SIZE, uc.PROT_ALL);
        this.memMapped += this.STACK_SIZE;

        // Map heap
        this._checkWasmHeap('Before HEAP map');
        this.emu.mem_map(this.HEAP, this.HEAP_SIZE, uc.PROT_ALL);
        this.memMapped += this.HEAP_SIZE;

        // Map shim return area
        this.emu.mem_map(this.SHIM_BASE, this.SHIM_SIZE, uc.PROT_ALL);
        this.memMapped += this.SHIM_SIZE;

        // === v17: Write stubs at both GENERIC_RETURN and RETURN_SENTINEL ===
        // GENERIC_RETURN: used by unresolved GOT entries (MOV R0,#0; BX LR)
        // RETURN_SENTINEL: used as emu_start stop address (must also be valid ARM code)
        this._writeGenericReturnStub();
        this._writeReturnSentinelStub();
        // Also write a copy at SHIM_BASE as fallback
        this.emu.mem_write(this.SHIM_BASE, [
            0x00, 0x00, 0xA0, 0xE3,  // MOV R0, #0
            0x1E, 0xFF, 0x2F, 0xE1,  // BX LR
        ]);

        // Setup JNI environment (maps string heap + writes JNI structures)
        this.jni.setup(this.emu);

        // Setup shims (Android + GL + JNI vtable handlers)
        this._setupShims();

        // Apply PLT/GOT relocations
        this._applyRelocations();

        // Add hooks
        this._setupHooks();

        this.initialized = true;
        Logger.success('Scorpio Engine v15.5 loaded and ready! (SharedPrefs + std::string + flag fix)');
        Logger.info('  Memory mapped: ' + (this.memMapped/1024/1024).toFixed(1) + ' MB');
        Logger.info('  JNI functions: ' + this.elf.getJNIFunctions().length);
        Logger.info('  GL imports: ' + this.elf.getGLImports().length);
        Logger.info('  PLT entries: ' + this.elf.pltRelocations.length);
        Logger.info('  Shim handlers: ' + this.shimHandlers.size);
        Logger.info('  Data relocations: ' + this.elf.relativeRelocations.length + ' RELATIVE + ' + this.elf.absRelocations.length + ' ABS32');

        var jniStats = this.jni.getStats();
        Logger.info('  JNI vtable handlers: active');

        return this;
    }

    /**
     * Apply R_ARM_RELATIVE and R_ARM_ABS32 directly to soBuffer
     */
    _applyDataRelocations() {
        Logger.info('=== Applying data relocations ===');

        var dv = new DataView(this.soBuffer);
        var bufLen = this.soBuffer.byteLength;
        var relativeApplied = 0;
        var absApplied = 0;
        var errors = 0;
        var t0 = performance.now();

        for (var rel of this.elf.relativeRelocations) {
            var fileOff = this.elf.vaToFileOffset(rel.offset);
            if (fileOff !== null && fileOff >= 0 && fileOff + 4 <= bufLen) {
                var oldVal = dv.getUint32(fileOff, true);
                var newVal = (oldVal + this.BASE) >>> 0;
                dv.setUint32(fileOff, newVal, true);
                relativeApplied++;
            } else {
                errors++;
            }
        }
        Logger.success('R_ARM_RELATIVE: ' + relativeApplied + ' applied (' + (performance.now() - t0).toFixed(0) + 'ms)');

        var t1 = performance.now();
        for (var rel of this.elf.absRelocations) {
            var fileOff = this.elf.vaToFileOffset(rel.offset);
            if (fileOff !== null && fileOff >= 0 && fileOff + 4 <= bufLen) {
                var addend = dv.getUint32(fileOff, true);
                if (rel.symValue !== undefined && rel.symValue > 0) {
                    dv.setUint32(fileOff, ((this.BASE + rel.symValue) + addend) >>> 0, true);
                    absApplied++;
                } else if (rel.symShndx && rel.symShndx !== 0) {
                    dv.setUint32(fileOff, (this.BASE + addend) >>> 0, true);
                    absApplied++;
                }
            } else {
                errors++;
            }
        }
        Logger.success('R_ARM_ABS32: ' + absApplied + ' applied (' + (performance.now() - t1).toFixed(0) + 'ms)');

        if (errors > 0) {
            Logger.warn('Data relocations: ' + errors + ' entries skipped');
        }
        Logger.success('Total data relocations applied: ' + (relativeApplied + absApplied));
    }

    /**
     * Register all shim handlers (Android + GL + JNI vtable + JavaVM vtable)
     * v12.0: Also registers JNI function table handlers
     */
    _setupShims() {
        Logger.info('Setting up function shims...');

        AndroidShims.init(this);
        var androidShims = AndroidShims.getShims();
        var glShims = this.glBridge.getShims ? this.glBridge.getShims() : {};
        this.shims = {};

        // Merge Android + GL shims
        for (var key in androidShims) { this.shims[key] = androidShims[key]; }
        for (var key in glShims) { this.shims[key] = glShims[key]; }

        // === Data symbols: allocate memory for global variables ===
        this._dataSymbolAddrs = {};
        if (AndroidShims.getDataSymbols) {
            var dataSyms = AndroidShims.getDataSymbols();
            var dataCount = 0;
            for (var name in dataSyms) {
                var sym = dataSyms[name];
                var addr = this._nextShimAddr;
                try {
                    this.emu.mem_write(addr, sym.data);
                } catch(e) {
                    Logger.warn('Failed to write data symbol: ' + name);
                }
                this._dataSymbolAddrs[name] = addr;
                this._nextShimAddr += (sym.size + 3) & ~3; // align to 4
                dataCount++;
            }
            Logger.info('  ' + dataCount + ' data symbols allocated');
        }

        // Register PLT shims
        for (var name in this.shims) {
            var handler = this.shims[name];
            var addr = this._nextShimAddr;
            this.emu.mem_write(addr, [0x1E, 0xFF, 0x2F, 0xE1]); // BX LR
            this.shimHandlers.set(addr, { name: name, handler: handler });
            this._nextShimAddr += 4;
        }
        Logger.info('  ' + Object.keys(this.shims).length + ' PLT shims registered');

        // === v12.0: Register JNI vtable handlers ===
        var jniHandlers = this.jni.getJNIVtableHandlers();
        var jniCount = 0;
        for (var index in jniHandlers) {
            var entry = jniHandlers[index];
            var addr = this._nextShimAddr;
            this.emu.mem_write(addr, [0x1E, 0xFF, 0x2F, 0xE1]); // BX LR
            this.shimHandlers.set(addr, { name: 'JNI.' + entry.name, handler: entry.handler });
            this._nextShimAddr += 4;
            // Write handler address to JNI function table
            this._writeU32ToEmu(this.jni.JNIENV_VTABLE + parseInt(index) * 4, addr);
            jniCount++;
        }
        Logger.info('  ' + jniCount + ' JNI vtable handlers registered');

        // === v12.0: Register JavaVM vtable handlers ===
        var vmHandlers = this.jni.getJavaVMHandlers();
        var vmCount = 0;
        for (var index in vmHandlers) {
            var entry = vmHandlers[index];
            var addr = this._nextShimAddr;
            this.emu.mem_write(addr, [0x1E, 0xFF, 0x2F, 0xE1]); // BX LR
            this.shimHandlers.set(addr, { name: 'VM.' + entry.name, handler: entry.handler });
            this._nextShimAddr += 4;
            // Write handler address to JavaVM function table
            this._writeU32ToEmu(this.jni.JAVA_VM_VTABLE + parseInt(index) * 4, addr);
            vmCount++;
        }
        Logger.info('  ' + vmCount + ' JavaVM vtable handlers registered');

        Logger.info('  Total shim handlers: ' + this.shimHandlers.size);
    }

    /**
     * Apply PLT/GOT relocations
     */
    _applyRelocations() {
        Logger.info('Applying PLT/GOT relocations...');
        var shimmed = 0;
        var resolvedInternal = 0;
        var genericReturn = 0;
        var unresolvedList = [];

        for (var rel of this.elf.pltRelocations) {
            var shimEntry = this._findShimForName(rel.symName);
            var gotAddr = this.BASE + rel.offset;

            if (shimEntry) {
                this._writeU32ToEmu(gotAddr, shimEntry);
                shimmed++;
            } else if (rel.symValue && rel.symValue !== 0 && rel.symShndx && rel.symShndx !== 0) {
                this._writeU32ToEmu(gotAddr, this.BASE + rel.symValue);
                resolvedInternal++;
            } else if (this._dataSymbolAddrs && this._dataSymbolAddrs[rel.symName]) {
                // Data symbol — point GOT to allocated data
                this._writeU32ToEmu(gotAddr, this._dataSymbolAddrs[rel.symName]);
                shimmed++;
            } else {
                this._writeU32ToEmu(gotAddr, this.GENERIC_RETURN);
                genericReturn++;
                unresolvedList.push(rel.symName);
            }
        }

        Logger.success('PLT/GOT: ' + shimmed + ' shimmed, ' + resolvedInternal + ' internal, ' + genericReturn + ' → generic return');

        // v15.5: Build reverse mapping of shim addresses → symbol names for debugging
        var shimAddrToName = {};
        for (var entry of this.shimHandlers) {
            shimAddrToName[entry[0]] = entry[1].name;
        }
        Logger.info('PLT shim address mapping (' + Object.keys(shimAddrToName).length + ' entries):');
        var shimEntries = Object.keys(shimAddrToName).slice(0, 30);
        for (var i = 0; i < shimEntries.length; i++) {
            var a = shimEntries[i];
            Logger.info('  0x' + (parseInt(a) >>> 0).toString(16) + ' → ' + shimAddrToName[a]);
        }
        if (Object.keys(shimAddrToName).length > 30) {
            Logger.info('  ... and ' + (Object.keys(shimAddrToName).length - 30) + ' more');
        }

        if (unresolvedList.length > 0 && unresolvedList.length <= 50) {
            Logger.warn('Unresolved externals: ' + unresolvedList.join(', '));
        } else if (unresolvedList.length > 50) {
            Logger.warn('Unresolved externals (first 50): ' + unresolvedList.slice(0, 50).join(', '));
            Logger.warn('  ... and ' + (unresolvedList.length - 50) + ' more');
        }
    }

    _writeU32ToEmu(addr, val) {
        var bytes = [
            val & 0xFF, (val >> 8) & 0xFF,
            (val >> 16) & 0xFF, (val >> 24) & 0xFF,
        ];
        try { this.emu.mem_write(addr, bytes); } catch(e) {}
    }

    _writeGenericReturnStub() {
        this.emu.mem_write(this.GENERIC_RETURN, [
            0x00, 0x00, 0xA0, 0xE3,  // MOV R0, #0
            0x1E, 0xFF, 0x2F, 0xE1,  // BX LR
        ]);
    }

    _writeReturnSentinelStub() {
        this.emu.mem_write(this.RETURN_SENTINEL, [
            0x00, 0x00, 0xA0, 0xE3,  // MOV R0, #0
            0x1E, 0xFF, 0x2F, 0xE1,  // BX LR
        ]);
    }

    _readU32FromEmu(addr) {
        try {
            var bytes = this.emu.mem_read(addr, 4);
            return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
        } catch(e) { return 0; }
    }

    _findShimForName(name) {
        for (var entry of this.shimHandlers) {
            if (entry[1].name === name) return entry[0];
        }
        return null;
    }

    /**
     * Setup Unicorn hooks
     * v12.0: Generic return stub now sets R0=0
     */
    _setupHooks() {
        var self = this;

        // Hook: intercept execution at shim addresses
        this.emu.hook_add(uc.HOOK_CODE, function(addr, size) {
            self.totalInstructions++;

            // PC sampling every 100K instructions
            if (self.totalInstructions % self._pcSampleInterval === 0) {
                var bucket = (addr >>> 4) << 4; // align to 16-byte boundary
                self._pcSamples[bucket] = (self._pcSamples[bucket] || 0) + 1;
            }

            if (addr >= self.SHIM_BASE && addr < self.SHIM_BASE + self.SHIM_SIZE) {
                var handler = self.shimHandlers.get(addr);
                if (handler) {
                    var r0 = self._readReg(uc.ARM_REG_R0);
                    var r1 = self._readReg(uc.ARM_REG_R1);
                    var r2 = self._readReg(uc.ARM_REG_R2);
                    var r3 = self._readReg(uc.ARM_REG_R3);
                    // Profile: count function calls during render frames
                    if (self._frameCallProfile) {
                        var n = handler.name;
                        self._frameCallProfile.set(n, (self._frameCallProfile.get(n) || 0) + 1);
                    }
                    var result = handler.handler(self.emu, [r0, r1, r2, r3]);
                    if (result !== undefined && result !== null) {
                        self._writeReg(uc.ARM_REG_R0, result >>> 0);
                    }
                } else if (addr === self.RETURN_SENTINEL) {
                    // v13.2: RETURN_SENTINEL reached — function returned cleanly
                    // emu_start will stop here since this is the stop address
                    Logger.arm('↩ RETURN_SENTINEL reached — function returned cleanly');
                } else if (addr === self.GENERIC_RETURN || addr === self.SHIM_BASE) {
                    // v16: Generic return stub — R0 is set to 0 by ARM instructions
                    // (MOV R0, #0; BX LR). Track callers for debugging.
                    var lr = self._readReg(uc.ARM_REG_LR);
                    var count = self._genericReturnCalls.get(lr) || 0;
                    self._genericReturnCalls.set(lr, count + 1);
                    // v17: Log first 10 generic return calls with context during init
                    if (count < 3) {
                        var r0 = self._readReg(uc.ARM_REG_R0);
                        var r1 = self._readReg(uc.ARM_REG_R1);
                        var offset = ((lr - self.BASE) >>> 0);
                        Logger.warn('[STUB] Generic return from LR=0x' + (lr>>>0).toString(16) +
                            ' (offset 0x' + offset.toString(16) + ') R0=0x' + (r0>>>0).toString(16) +
                            ' R1=0x' + (r1>>>0).toString(16));
                    }
                    // v16: Re-write stub in case it was corrupted
                    self._writeGenericReturnStub();
                }
            }
        }, self.SHIM_BASE, self.SHIM_BASE + self.SHIM_SIZE);

        // Hook: auto-map unmapped memory
        this.emu.hook_add(uc.HOOK_MEM_READ_UNMAPPED, function(type, addr, size, value) {
            return self._handleUnmapped('read', addr, size);
        });
        this.emu.hook_add(uc.HOOK_MEM_WRITE_UNMAPPED, function(type, addr, size, value) {
            return self._handleUnmapped('write', addr, size);
        });
        this.emu.hook_add(uc.HOOK_MEM_FETCH_UNMAPPED, function(type, addr, size, value) {
            return self._handleUnmapped('fetch', addr, size);
        });

        // === ARM Trace Hook (covers binary range) ===
        this.emu.hook_add(uc.HOOK_CODE, function(addr, size) {
            if (!self._traceEnabled) return;
            if (self._traceInsnsCount >= self._traceMaxInsns) {
                self._traceEnabled = false;
                Logger.warn('[TRACE] Capture complete: ' + self._traceLog.length + ' instructions logged');
                return;
            }
            self._traceInsnsCount++;
            
            var pc = addr;
            var r0 = self._readReg(uc.ARM_REG_R0);
            var r1 = self._readReg(uc.ARM_REG_R1);
            var r2 = self._readReg(uc.ARM_REG_R2);
            var r3 = self._readReg(uc.ARM_REG_R3);
            var sp = self._readReg(uc.ARM_REG_SP);
            var lr = self._readReg(uc.ARM_REG_LR);
            
            // Read instruction bytes
            var instrBytes = '??';
            try {
                var raw = self.emu.mem_read(addr, size > 4 ? 4 : size);
                instrBytes = Array.from(raw).map(function(b) { return b.toString(16).padStart(2,'0'); }).join(' ');
            } catch(e) {}
            
            // Check if PC is in binary range (offset from BASE)
            var offset = (pc - self.BASE) >>> 0;
            var location = (offset < 0x2000000) ? 'BIN+0x' + offset.toString(16) : 'ADDR 0x' + pc.toString(16);
            
            // Read memory at addresses being accessed (useful for conditional checks)
            var memNote = '';
            try {
                // If instruction reads from an address in R0-R3 range, log what's there
                for (var ri = 0; ri < 4; ri++) {
                    var regVal = [r0, r1, r2, r3][ri];
                    if (regVal >= self.BASE && regVal < self.BASE + 0x2000000) {
                        var memVal = self._readU32FromEmu(regVal);
                        if (memNote) memNote += ' | ';
                        memNote += '[R' + ri + ']=0x' + memVal.toString(16);
                    }
                }
            } catch(e) {}
            
            self._traceLog.push({
                n: self._traceInsnsCount,
                pc: '0x' + (pc>>>0).toString(16),
                off: location,
                bytes: instrBytes,
                r0: '0x' + (r0>>>0).toString(16),
                r1: '0x' + (r1>>>0).toString(16),
                r2: '0x' + (r2>>>0).toString(16),
                r3: '0x' + (r3>>>0).toString(16),
                sp: '0x' + (sp>>>0).toString(16),
                lr: '0x' + (lr>>>0).toString(16),
                mem: memNote
            });
        }, self.BASE, self.BASE + self.elf.mapSize);

        Logger.info('Hooks installed: code interception + memory auto-mapping + ARM trace');
    }

    _handleUnmapped(type, addr, size) {
        // v17: Block FETCH below binary BASE — this is a NULL function pointer call
        // Execution would slide through zero-filled pages forever. Stop it immediately.
        if (type === 'fetch' && (addr >>> 0) < this.BASE) {
            var pc = this._readReg(uc.ARM_REG_PC);
            var lr = this._readReg(uc.ARM_REG_LR);
            var r0 = this._readReg(uc.ARM_REG_R0);
            Logger.error('[MEM] FETCH below BASE at 0x' + (addr>>>0).toString(16) +
                ' — NULL function pointer! PC=0x' + (pc>>>0).toString(16) +
                ' LR=0x' + (lr>>>0).toString(16) + ' R0=0x' + (r0>>>0).toString(16));
            this._unmappedAccessLog.push({ type: type, addr: addr, size: size, pc: pc, lr: lr });
            try { this.emu.emu_stop(); } catch(e) {}
            return false;
        }

        var aligned = addr & ~0x3FFF;
        if (!this._autoMapped.has(aligned)) {
            try {
                this.emu.mem_map(aligned, 0x4000, uc.PROT_ALL);
                this._autoMapped.add(aligned);
                this.memMapped += 0x4000;

                if (this._unmappedAccessLog.length < this._maxUnmappedLog) {
                    var pc = this._readReg(uc.ARM_REG_PC);
                    this._unmappedAccessLog.push({ type: type, addr: addr, size: size, pc: pc });
                    if (type === 'fetch') {
                        Logger.warn('[MEM] FETCH from unmapped 0x' + (addr>>>0).toString(16) + ' (PC=0x' + (pc>>>0).toString(16) + ')');
                    }
                }
                return true;
            } catch(e) {
                return false;
            }
        }
        return true;
    }

    _checkWasmHeap(label) {
        try {
            if (typeof MUnicorn !== 'undefined' && MUnicorn.HEAP8) {
                Logger.info('[MEM] ' + label + ': WASM heap = ' + (MUnicorn.HEAP8.length/1024/1024).toFixed(1) + ' MB');
            }
        } catch(e) {}
    }

    _readReg(reg) {
        var bytes = this.emu.reg_read(reg, 4);
        // Use >>> 0 to ensure unsigned 32-bit result.
        // Without this, values >= 0x80000000 become negative due to JS signed shifts,
        // causing Map lookups to fail (e.g. method ID 0xD0020210 stored as positive
        // but read back as negative).
        return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
    }

    _writeReg(reg, val) {
        var bytes = [val & 0xFF, (val >> 8) & 0xFF, (val >> 16) & 0xFF, (val >> 24) & 0xFF];
        this.emu.reg_write(reg, bytes);
    }

    /**
     * Call a JNI function by name
     */
    callFunction(name, args, initMode) {
        args = args || {};
        var sym = this.elf.getSymbolOffset(name);
        if (sym === null) {
            Logger.error('Function not found: ' + name);
            return null;
        }

        Logger.arm('Calling ' + name + ' at offset 0x' + sym.toString(16) + '...');

        var isThumb = (sym & 1) !== 0;
        var addr = this.BASE + (sym & ~1);

        this._writeReg(uc.ARM_REG_SP, this.STACK + this.STACK_SIZE - 0x1000);
        // v17: LR points to RETURN_SENTINEL (stop address for emu_start)
        // This is DIFFERENT from GENERIC_RETURN (used for unresolved GOT entries)
        // so internal calls to unresolved functions don't stop emu_start prematurely
        this._writeReg(uc.ARM_REG_LR, this.RETURN_SENTINEL);

        if (args.r0 !== undefined) this._writeReg(uc.ARM_REG_R0, args.r0);
        if (args.r1 !== undefined) this._writeReg(uc.ARM_REG_R1, args.r1);
        if (args.r2 !== undefined) this._writeReg(uc.ARM_REG_R2, args.r2);
        if (args.r3 !== undefined) this._writeReg(uc.ARM_REG_R3, args.r3);

        var startInsns = this.totalInstructions;

        try {
            // v15.2: Init mode uses 2M (enough for shader loading), game frames use configurable limit
            var maxInsns = initMode ? 2000000 : this.maxFrameInsns;
            // v17: Use RETURN_SENTINEL as stop address — distinct from GENERIC_RETURN
            var stopAddr = this.RETURN_SENTINEL;
            if (isThumb) {
                this.emu.emu_start(addr | 1, stopAddr, 0, maxInsns);
            } else {
                this.emu.emu_start(addr, stopAddr, 0, maxInsns);
            }

            var insns = this.totalInstructions - startInsns;
            var r0 = this._readReg(uc.ARM_REG_R0);
            var endPC = this._readReg(uc.ARM_REG_PC);
            var endLR = this._readReg(uc.ARM_REG_LR);
            Logger.success(name + ': ' + insns + ' instructions, R0=0x' + (r0 >>> 0).toString(16));

            // If we hit the instruction limit, dump where we stopped (spin loop detection)
            if (!initMode && insns >= maxInsns - 10) {
                var pcOffset = (endPC - this.BASE) >>> 0;
                Logger.warn('[SPIN?] Execution stopped at PC=0x' + (endPC>>>0).toString(16) +
                    ' (BIN+0x' + pcOffset.toString(16) + ') LR=0x' + (endLR>>>0).toString(16));
                // Dump 32 bytes of code around the stop point for disassembly
                try {
                    var codeBytes = this.emu.mem_read(endPC - 16, 48);
                    var hexDump = '';
                    for (var bi = 0; bi < codeBytes.length; bi += 4) {
                        var addr32 = (endPC - 16 + bi) >>> 0;
                        var hex = '';
                        for (var bj = 0; bj < 4 && (bi+bj) < codeBytes.length; bj++) {
                            hex += codeBytes[bi+bj].toString(16).padStart(2,'0') + ' ';
                        }
                        var marker = (addr32 === endPC) ? ' <<< PC' : '';
                        Logger.warn('  0x' + addr32.toString(16) + ': ' + hex + marker);
                    }
                } catch(e2) {}
                // Also read key registers
                var sp = this._readReg(uc.ARM_REG_SP);
                var r1 = this._readReg(uc.ARM_REG_R1);
                var r2 = this._readReg(uc.ARM_REG_R2);
                var r3 = this._readReg(uc.ARM_REG_R3);
                Logger.warn('  Regs: R0=0x' + (r0>>>0).toString(16) + ' R1=0x' + (r1>>>0).toString(16) +
                    ' R2=0x' + (r2>>>0).toString(16) + ' R3=0x' + (r3>>>0).toString(16) + ' SP=0x' + (sp>>>0).toString(16));
                // Read what memory the code might be polling
                try {
                    var polledAddr = r0;
                    if (polledAddr >= 0x10000000 && polledAddr < 0xF0000000) {
                        var polledVal = this._readU32FromEmu(polledAddr);
                        Logger.warn('  [R0]=0x' + polledVal.toString(16));
                    }
                    polledAddr = r1;
                    if (polledAddr >= 0x10000000 && polledAddr < 0xF0000000) {
                        var polledVal = this._readU32FromEmu(polledAddr);
                        Logger.warn('  [R1]=0x' + polledVal.toString(16));
                    }
                } catch(e3) {}

                // Dump PC sample distribution
                var samples = Object.entries(this._pcSamples);
                samples.sort(function(a,b) { return b[1] - a[1]; });
                Logger.warn('[SPIN] PC sample distribution (top 10):');
                for (var si = 0; si < Math.min(10, samples.length); si++) {
                    var sAddr = parseInt(samples[si][0]);
                    var sCount = samples[si][1];
                    var sOff = (sAddr - this.BASE) >>> 0;
                    Logger.warn('  BIN+0x' + sOff.toString(16) + ' (0x' + sAddr.toString(16) + '): ' + sCount + ' hits');
                }
                this._pcSamples = {}; // reset for next frame
            }

            return { success: true, instructions: insns, r0: r0 };
        } catch(e) {
            var insns = this.totalInstructions - startInsns;
            var errStr = String(e);
            var pc = this._readReg(uc.ARM_REG_PC);

            if (errStr.includes('INSN_INVALID')) {
                try {
                    var pcBytes = this.emu.mem_read(pc, 4);
                    var bytesHex = Array.from(pcBytes).map(function(b) { return b.toString(16).padStart(2,'0'); }).join(' ');
                    Logger.error(name + ': INVALID INSTRUCTION after ' + insns + ' insns at PC=0x' + (pc>>>0).toString(16) + ' bytes=[' + bytesHex + ']');
                    var hw = pcBytes[0] | (pcBytes[1] << 8);
                    if (hw !== 0 && hw !== 0xFFFF) {
                        Logger.warn('  → Bytes look like THUMB code');
                    }
                } catch(memErr) {
                    Logger.error(name + ': INVALID INSTRUCTION after ' + insns + ' insns at PC=0x' + (pc>>>0).toString(16));
                }
            } else if (errStr.includes('FETCH_UNMAPPED')) {
                Logger.error(name + ': FETCH_UNMAPPED after ' + insns + ' insns at PC=0x' + (pc>>>0).toString(16));
                if (pc < this.BASE) {
                    Logger.warn('  → PC below BASE — likely unrelocated pointer');
                }
            } else {
                Logger.error(name + ': failed after ' + insns + ' insns at PC=0x' + (pc>>>0).toString(16) + ' — ' + errStr.substring(0, 150));
            }
            return { success: false, instructions: insns, error: errStr, pc: pc };
        }
    }

    /**
     * Run the initialization sequence
     */
    async runInit(width, height) {
        Logger.info('=== Running initialization sequence (v15.5 — SharedPrefs + std::string + flag fix) ===');

        var results = [];

        // Step 1: JNI_OnLoad
        Logger.info('Step 1/8: JNI_OnLoad');
        results.push(this.callFunction('JNI_OnLoad', this.jni.prepareOnLoad(), true));

        // Step 2: BGCore_init
        Logger.info('Step 2/8: BGCoreJNIBridge.init');
        results.push(this.callFunction('Java_com_bight_android_jni_BGCoreJNIBridge_init', this.jni.prepareBGCoreInit(width, height), true));

        // Step 3: OGLESInit
        Logger.info('Step 3/8: OGLESInit');
        results.push(this.callFunction('Java_com_bight_android_jni_BGCoreJNIBridge_OGLESInit', this.jni.prepareCall('OGLESInit', [width, height]), true));

        // Step 4: OGLESResize
        Logger.info('Step 4/8: OGLESResize');
        results.push(this.callFunction('Java_com_bight_android_jni_BGCoreJNIBridge_OGLESResize', {
            r0: this.jni.JNIENV_BASE,
            r1: this.jni.JOBJECT_BASE,
            r2: width,
            r3: height,
        }, true));

        // Step 5: ScorpioJNI.init
        Logger.info('Step 5/8: ScorpioJNI.init');
        results.push(this.callFunction('Java_com_ea_simpsons_ScorpioJNI_init', this.jni.prepareCall('ScorpioJNI_init'), true));

        // Step 6: Lifecycle.onCreate
        Logger.info('Step 6/8: Lifecycle.onCreate');
        results.push(this.callFunction('Java_com_ea_simpsons_ScorpioJNI_LifecycleOnCreate',
            this.jni.prepareCall('LifecycleOnCreate'), true));

        // Step 7: Lifecycle.Start
        Logger.info('Step 7/8: Lifecycle.Start');
        results.push(this.callFunction('Java_com_ea_simpsons_ScorpioJNI_LifecycleStart',
            this.jni.prepareCall('LifecycleStart'), true));

        // Step 8: Lifecycle.Resume
        Logger.info('Step 8/8: Lifecycle.Resume');
        results.push(this.callFunction('Java_com_ea_simpsons_ScorpioJNI_LifecycleResume',
            this.jni.prepareCall('LifecycleResume'), true));
        results.push(this.callFunction('Java_com_bight_android_jni_BGCoreJNIBridge_resume', {
            r0: this.jni.JNIENV_BASE,
            r1: this.jni.JOBJECT_BASE,
        }, true));

        // === v13.2: Force-enable rendering ===
        // The game's render function checks a flag at singleton+0xD1B
        // This byte is normally set by internal async loading, which we can't emulate
        // Read the singleton pointer and force the flag
        var SINGLETON_PTR_ADDR = this.BASE + 0x1A45728;
        var singletonPtr = this._readU32FromEmu(SINGLETON_PTR_ADDR);
        if (singletonPtr && singletonPtr !== 0) {
            // Set render-ready flag
            this.emu.mem_write(singletonPtr + 0xD1B, [1]);
            this.savedSingletonPtr = singletonPtr;
            Logger.success('v13.2: Forced render-ready flag at singleton (0x' + singletonPtr.toString(16) + '+0xD1B) — saved for restoration');
            
            // v15.5: KEEP flag at 0x1A466A8 as ZERO!
            // flag=1 means SHUTDOWN (destroys singleton, calls closeWithError)
            // flag=0 means NORMAL render path (currently just glClear because init incomplete)
            var GLOBAL_FLAG_ADDR = this.BASE + 0x1A466A8;
            this.emu.mem_write(GLOBAL_FLAG_ADDR, [0]);
            Logger.success('v13.5: Cleared engine-running flag at 0x' + GLOBAL_FLAG_ADDR.toString(16) + ' (forces simple GL path)');
        } else {
            Logger.warn('v13.2: Singleton pointer is NULL — render-ready flag NOT set');
        }

        // Summary
        var succeeded = results.filter(function(r) { return r && r.success; }).length;
        var totalInsns = results.reduce(function(sum, r) { return sum + (r ? r.instructions || 0 : 0); }, 0);

        Logger.success('Initialization complete: ' + succeeded + '/' + results.length + ' steps OK');
        Logger.info('Total ARM instructions in init: ' + totalInsns.toLocaleString());
        Logger.info('Cumulative instructions: ' + this.totalInstructions.toLocaleString());
        Logger.info('Auto-mapped regions: ' + this._autoMapped.size);

        if (this._unmappedAccessLog.length > 0) {
            Logger.warn('Unmapped memory accesses (first ' + Math.min(this._unmappedAccessLog.length, 10) + '):');
            for (var i = 0; i < Math.min(this._unmappedAccessLog.length, 10); i++) {
                var a = this._unmappedAccessLog[i];
                Logger.warn('  ' + a.type + ' addr=0x' + (a.addr>>>0).toString(16) + ' size=' + a.size + ' PC=0x' + (a.pc>>>0).toString(16));
            }
        }

        if (this._genericReturnCalls.size > 0) {
            Logger.info('Generic return stub called from ' + this._genericReturnCalls.size + ' unique callers:');
            var sorted = Array.from(this._genericReturnCalls.entries()).sort(function(a,b){ return b[1]-a[1]; });
            for (var i = 0; i < Math.min(sorted.length, 20); i++) {
                var lr = sorted[i][0], count = sorted[i][1];
                var offset = (lr - this.BASE) >>> 0;
                Logger.info('  LR=0x' + (lr>>>0).toString(16) + ' (offset 0x' + offset.toString(16) + ') x' + count);
            }
        }

        // Log JNI stats
        var jniStats = this.jni.getStats();
        Logger.info('JNI stats: ' + jniStats.classes + ' classes, ' + jniStats.methods + ' methods, ' + jniStats.strings + ' strings, ' + jniStats.registeredNatives + ' registered natives');

        // v15.2: Log VFS stats
        if (this.vfs) {
            var vfsStats = this.vfs.getStats();
            Logger.info('VFS stats: ' + vfsStats.registeredFiles + ' files, ' + vfsStats.opens + ' opens, ' + vfsStats.reads + ' reads, ' + (vfsStats.bytesRead/1024).toFixed(1) + 'KB read, ' + vfsStats.misses + ' misses');
            if (vfsStats.missedPaths.length > 0) {
                Logger.warn('VFS missed paths: ' + vfsStats.missedPaths.slice(0, 10).join(', '));
            }
        }

        return true;
    }

    runFrame() {
        // v13.2: Restore singleton pointer if it was zeroed by chaotic init execution
        if (this.savedSingletonPtr) {
            var SINGLETON_PTR_ADDR = this.BASE + 0x1A45728;
            var currentPtr = this._readU32FromEmu(SINGLETON_PTR_ADDR);
            if (currentPtr === 0) {
                // Restore the singleton pointer
                this._writeU32ToEmu(SINGLETON_PTR_ADDR, this.savedSingletonPtr);
                // Also ensure render-ready flag is set
                this.emu.mem_write(this.savedSingletonPtr + 0xD1B, [1]);
            }
            // v15.5: ALWAYS keep flag=0! flag=1 triggers SHUTDOWN/cleanup path
            // (destroys singleton + calls closeWithError). Render mode is controlled
            // by instruction budget only, not by this flag.
            this.emu.mem_write(this.BASE + 0x1A466A8, [0]);
        }
        // Start function profiling for first few frames
        if (this._frameProfileCount < this._maxProfileFrames) {
            this._frameCallProfile = new Map();
        }

        this._pcSamples = {}; // reset PC sampling for this frame
        this._writeGenericReturnStub(); // v17: ensure stubs are intact before each frame
        this._writeReturnSentinelStub();
        var frameResult = this.callFunction('Java_com_bight_android_jni_BGCoreJNIBridge_OGLESRender',
            this.jni.prepareCall('OGLESRender'));

        // Dump function profile for this frame
        if (this._frameCallProfile && this._frameProfileCount < this._maxProfileFrames) {
            this._frameProfileCount++;
            var profile = this._frameCallProfile;
            this._frameCallProfile = null;
            // Sort by count descending
            var entries = [];
            profile.forEach(function(count, name) { entries.push({name: name, count: count}); });
            entries.sort(function(a, b) { return b.count - a.count; });
            Logger.info('=== Frame ' + this._frameProfileCount + ' function profile (top 30) ===');
            for (var i = 0; i < Math.min(30, entries.length); i++) {
                Logger.info('  ' + entries[i].count + 'x ' + entries[i].name);
            }
            Logger.info('  Total unique functions: ' + entries.length);
            // Also log VFS stats
            if (this.vfs) {
                var vs = this.vfs.getStats();
                Logger.info('  VFS: ' + vs.opens + ' opens, ' + vs.reads + ' reads, ' + (vs.bytesRead/1024).toFixed(1) + 'KB read, ' + vs.misses + ' misses');
            }
        }
        
        // Dump ARM trace if captured
        if (this._traceLog.length > 0) {
            Logger.warn('=== ARM TRACE DUMP (' + this._traceLog.length + ' instructions) ===');
            var traceText = 'ARM TRACE — Full Render First Frame\n';
            traceText += 'Instructions: ' + this._traceLog.length + '\n\n';
            for (var i = 0; i < this._traceLog.length; i++) {
                var t = this._traceLog[i];
                var line = '#' + t.n + ' ' + t.off + ' [' + t.bytes + '] R0=' + t.r0 + ' R1=' + t.r1 + ' R2=' + t.r2 + ' R3=' + t.r3 + ' SP=' + t.sp + ' LR=' + t.lr;
                if (t.mem) line += ' MEM:' + t.mem;
                traceText += line + '\n';
            }
            // Store in window for download
            window._armTrace = traceText;
            window._armTraceData = this._traceLog;
            
            // Log first 30 to console
            for (var i = 0; i < Math.min(30, this._traceLog.length); i++) {
                var t = this._traceLog[i];
                console.log('#' + t.n + ' ' + t.off + ' [' + t.bytes + '] R0=' + t.r0 + ' R1=' + t.r1 + ' R2=' + t.r2 + ' R3=' + t.r3 + ' LR=' + t.lr + (t.mem ? ' ' + t.mem : ''));
            }
            if (this._traceLog.length > 30) {
                console.log('... (' + (this._traceLog.length - 30) + ' more in window._armTrace)');
            }
            
            // Clear trace after dump
            this._traceLog = [];
            this._traceInsnsCount = 0;
        }
        
        return frameResult;
    }

    /** v15.5: Toggle between simple and full render paths
     * IMPORTANT: flag=1 at BASE+0x1A466A8 means SHUTDOWN, not full render!
     * We always keep flag=0 and only change the instruction budget.
     */
    toggleFullRender(enabled) {
        this.useFullRender = enabled;
        if (enabled) {
            this.maxFrameInsns = 5000000; // 5M for full render
            if (this.glBridge && this.glBridge.setForceVisibleClear) {
                this.glBridge.setForceVisibleClear(false); // Let game colors through
            }
            Logger.info('🔥 Full render ENABLED (flag stays 0, 5M insns/frame)');
            Logger.info('   v15.5: flag=1 is SHUTDOWN — we never set it!');
            // Enable ARM trace for the first full render frame
            this._traceEnabled = true;
            this._traceLog = [];
            this._traceInsnsCount = 0;
            Logger.info('🔍 ARM TRACE ENABLED — capturing first ' + this._traceMaxInsns + ' instructions');
        } else {
            this.maxFrameInsns = 2000000; // 2M for simple
            if (this.glBridge && this.glBridge.setForceVisibleClear) {
                this.glBridge.setForceVisibleClear(true); // Green override
            }
            Logger.info('🟢 Simple render path (flag=0, 2M insns/frame)');
        }
    }

    sendPointerDown(x, y) {
        this.callFunction('Java_com_bight_android_jni_BGCoreJNIBridge_pointerPressed', {
            r0: this.jni.JNIENV_BASE, r1: this.jni.JOBJECT_BASE, r2: x, r3: y,
        });
    }

    sendPointerMove(x, y) {
        this.callFunction('Java_com_bight_android_jni_BGCoreJNIBridge_pointerMoved', {
            r0: this.jni.JNIENV_BASE, r1: this.jni.JOBJECT_BASE, r2: x, r3: y,
        });
    }

    sendPointerUp(x, y) {
        this.callFunction('Java_com_bight_android_jni_BGCoreJNIBridge_pointerReleased', {
            r0: this.jni.JNIENV_BASE, r1: this.jni.JOBJECT_BASE, r2: x, r3: y,
        });
    }

    getStats() {
        var glStats = this.glBridge ? this.glBridge.getStats() : { calls: 0 };
        var jniFuncs = this.elf ?
            Array.from(this.elf.exportedSymbols.keys()).filter(function(n) { return n.startsWith('Java_'); }).length : 0;
        return {
            totalInstructions: this.totalInstructions,
            memMapped: this.memMapped,
            jniFunctions: jniFuncs,
            relocations: this.elf ? this.elf.pltRelocations.length + this.elf.relocations.length : 0,
            symbols: this.elf ? this.elf.exportedSymbols.size : 0,
            glCalls: glStats.calls || 0,
            glDraws: glStats.draws || 0,
            autoMapped: this._autoMapped.size,
            unmappedAccesses: this._unmappedAccessLog.length,
        };
    }

    /**
     * v15.5-DLC: Reset engine state for DLC retry loop.
     * Reloads the binary and re-applies relocations so init can run again cleanly.
     */
    resetForRetry() {
        Logger.info('[Engine] 🔄 Resetting for DLC retry...');
        
        // Reset instruction count and state
        this.totalInstructions = 0;
        this.savedSingletonPtr = 0;
        
        // Re-write the original binary to Unicorn (with relocations already applied)
        var u8 = new Uint8Array(this.soBuffer);
        var CHUNK = 1024 * 1024;
        for (var off = 0; off < u8.length; off += CHUNK) {
            var end = Math.min(off + CHUNK, u8.length);
            var chunk = Array.from(u8.slice(off, end));
            try {
                this.emu.mem_write(this.BASE + off, chunk);
            } catch(e) {
                // Skip if region not mapped
            }
        }
        
        // Reset heap pointer
        if (this.shims && this.shims._heapPtr) {
            this.shims._heapPtr = 0xD0100000;
        }
        
        // Reset GL state
        if (this.glBridge && this.glBridge.callCount !== undefined) {
            this.glBridge.callCount = 0;
            this.glBridge.drawCalls = 0;
        }
        
        // Re-setup JNI
        if (this.jni && this.jni.setup) {
            this.jni.setup(this.emu);
        }
        
        Logger.info('[Engine] ✅ Reset complete, ready for re-init');
    }

}
