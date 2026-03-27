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
        this.HEAP_SIZE = 64 * 1024 * 1024; // v29: match AndroidShims._heapSize (64MB) — fixes QEMU section overflow from auto-mapping 0xD2000000+ pages
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
        Logger.info('=== Scorpio Engine v22: Direct render bypass + instruction trace ===');

        if (typeof uc === 'undefined' || !uc.Unicorn) {
            Logger.error('Unicorn.js not loaded!');
            return false;
        }
        Logger.success('Unicorn.js loaded OK (uc.Unicorn available)');

        // Parse ELF
        this.soBuffer = soBuffer;
        this.elf = new ElfLoader(soBuffer).parse();

        // Initialize WebGL — v22: retry with diagnostics
        this.glBridge = null;
        var glAttempts = 0;
        var maxGLAttempts = 3;
        while (glAttempts < maxGLAttempts) {
            glAttempts++;
            try {
                Logger.info('[GL] WebGL init attempt ' + glAttempts + '/' + maxGLAttempts + '...');
                Logger.info('[GL] Canvas arg: ' + (canvas ? canvas.tagName + ' ' + canvas.width + 'x' + canvas.height : 'NULL'));
                this.glBridge = new GLBridge(canvas);
                if (!this.glBridge.headless) {
                    Logger.success('[GL] WebGL context acquired on attempt ' + glAttempts);
                    break;
                }
                Logger.warn('[GL] Attempt ' + glAttempts + ' returned headless');
            } catch(e) {
                Logger.warn('[GL] Attempt ' + glAttempts + ' threw: ' + e.message);
            }
            // Brief yield before retry (canvas might need layout time)
            if (glAttempts < maxGLAttempts) {
                await new Promise(function(r) { setTimeout(r, 100); });
            }
        }
        if (!this.glBridge || this.glBridge.headless) {
            Logger.error('[GL] WebGL FAILED after ' + maxGLAttempts + ' attempts — GL calls will be no-ops');
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

        // v20: Write binary using ELF segment mapping (vaddr != file offset!)
        // Previously loaded as flat file (BASE+file_off), but segment 2+ have
        // vaddr != file_offset, causing vtables/data to be at wrong addresses.
        Logger.arm('Writing relocated binary using ELF segment mapping...');
        var u8 = new Uint8Array(soBuffer);
        var CHUNK = 1024 * 1024;
        var totalWritten = 0;
        for (var seg of this.elf.segments) {
            if (seg.type !== 1) continue; // PT_LOAD only
            var diff = seg.vaddr - seg.offset;
            Logger.arm('  LOAD seg: file 0x' + seg.offset.toString(16) + ' → VA 0x' + seg.vaddr.toString(16) +
                ' (filesz=0x' + seg.filesz.toString(16) + ', gap=' + diff + ')');
            for (var off = 0; off < seg.filesz; off += CHUNK) {
                var end = Math.min(off + CHUNK, seg.filesz);
                var filePos = seg.offset + off;
                var memAddr = this.BASE + seg.vaddr + off;
                var chunk = Array.from(u8.slice(filePos, filePos + (end - off)));
                this.emu.mem_write(memAddr, chunk);
            }
            totalWritten += seg.filesz;
        }
        Logger.success('Binary loaded: ' + (totalWritten/1024/1024).toFixed(1) + ' MB via ' +
            this.elf.segments.filter(function(s){return s.type===1}).length + ' LOAD segments (with relocations)');

        // v30: Shadow-map the binary at VA 0 (unrelocated address space)
        // Some function/data pointers in the binary are unrelocated — they reference
        // VA 0x100586 instead of BASE+0x100586. By mapping the relocated binary at VA 0,
        // these unrelocated accesses transparently work (both code FETCH and data READ).
        Logger.arm('v30: Shadow-mapping binary at VA 0 for unrelocated pointer support...');
        try {
            this.emu.mem_map(0, mapSize, uc.PROT_ALL);
            this.memMapped += mapSize;
            // Register these blocks with auto-mapper to prevent double-mapping
            for (var soff = 0; soff < mapSize; soff += 0x100000) {
                this._autoMapped.add(soff);
            }
            for (var seg of this.elf.segments) {
                if (seg.type !== 1) continue;
                for (var off = 0; off < seg.filesz; off += CHUNK) {
                    var end = Math.min(off + CHUNK, seg.filesz);
                    var filePos = seg.offset + off;
                    var memAddr = seg.vaddr + off; // VA 0-based (no BASE)
                    var chunk = Array.from(u8.slice(filePos, filePos + (end - off)));
                    this.emu.mem_write(memAddr, chunk);
                }
            }
            Logger.success('v30: Shadow binary mapped at 0x0-0x' + mapSize.toString(16) +
                ' (' + (mapSize/1024/1024).toFixed(1) + ' MB)');
        } catch(e) {
            Logger.warn('v30: Shadow map failed: ' + e.message);
        }

        // BSS
        for (var seg of this.elf.segments) {
            if (seg.type !== 1) continue;
            if (seg.memsz > seg.filesz) { /* zero-init by mem_map */ }
        }

        // v21: NOP render gate checks (safety net while engine state is uncertain)
        // At 0x12C36B4: BEQ that skips rendering when singleton[4]==0
        // At 0x12C36C0: BNE that skips rendering when singleton[5]!=0
        var NOP = [0x00, 0x00, 0xA0, 0xE1]; // MOV R0, R0
        this.emu.mem_write(this.BASE + 0x12C36B4, NOP);
        this.emu.mem_write(this.BASE + 0x12C36C0, NOP);
        Logger.success('v21: NOP\'d render gate checks at +0x12C36B4/+0x12C36C0');

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

        // v29e: FILE struct function pointer stubs
        // Bionic's internal fwrite/fflush/fgetc call _read/_write/_close/_seek via
        // function pointers in the FILE struct. If these are NULL, bionic calls 0x0,
        // our BX LR stub returns 0, and bionic retries infinitely.
        // Fix: provide proper stubs at known SHIM addresses.
        this.FILE_READ_STUB  = this.SHIM_BASE + 0xFD000;  // 0xE00FD000
        this.FILE_WRITE_STUB = this.SHIM_BASE + 0xFD010;  // 0xE00FD010
        this.FILE_CLOSE_STUB = this.SHIM_BASE + 0xFD020;  // 0xE00FD020
        this.FILE_SEEK_STUB  = this.SHIM_BASE + 0xFD030;  // 0xE00FD030

        // _read(cookie, buf, count) → return -1 (EOF, no data)
        // MVN R0, #0 = 0xE3E00000; BX LR = 0xE12FFF1E
        this.emu.mem_write(this.FILE_READ_STUB, [
            0x00, 0x00, 0xE0, 0xE3,  // MVN R0, #0 (R0 = -1)
            0x1E, 0xFF, 0x2F, 0xE1,  // BX LR
        ]);
        // _write(cookie, buf, count) → return count (R2) = pretend all bytes written
        // MOV R0, R2 = 0xE1A00002; BX LR = 0xE12FFF1E
        this.emu.mem_write(this.FILE_WRITE_STUB, [
            0x02, 0x00, 0xA0, 0xE1,  // MOV R0, R2
            0x1E, 0xFF, 0x2F, 0xE1,  // BX LR
        ]);
        // _close(cookie) → return 0 (success)
        this.emu.mem_write(this.FILE_CLOSE_STUB, [
            0x00, 0x00, 0xA0, 0xE3,  // MOV R0, #0
            0x1E, 0xFF, 0x2F, 0xE1,  // BX LR
        ]);
        // _seek(cookie, pos, whence) → return 0
        this.emu.mem_write(this.FILE_SEEK_STUB, [
            0x00, 0x00, 0xA0, 0xE3,  // MOV R0, #0
            0x1E, 0xFF, 0x2F, 0xE1,  // BX LR
        ]);
        Logger.info('[v29e] FILE struct function stubs written at 0x' +
            this.FILE_READ_STUB.toString(16) + '-0x' + (this.FILE_SEEK_STUB + 8).toString(16));

        // Setup JNI environment (maps string heap + writes JNI structures)
        this.jni.setup(this.emu);

        // Setup shims (Android + GL + JNI vtable handlers)
        this._setupShims();

        // Apply PLT/GOT relocations
        this._applyRelocations();

        // Add hooks
        this._setupHooks();

        this.initialized = true;
        Logger.success('Scorpio Engine v22 loaded and ready! (direct render bypass)');
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
        var absSkippedNull = 0;
        for (var rel of this.elf.absRelocations) {
            var fileOff = this.elf.vaToFileOffset(rel.offset);
            if (fileOff !== null && fileOff >= 0 && fileOff + 4 <= bufLen) {
                var addend = dv.getUint32(fileOff, true);
                if (rel.symValue !== undefined && rel.symValue > 0) {
                    // Symbol has a value: result = BASE + symValue + addend
                    dv.setUint32(fileOff, ((this.BASE + rel.symValue) + addend) >>> 0, true);
                    absApplied++;
                } else if (rel.symShndx && rel.symShndx !== 0) {
                    // Symbol defined in a section (value=0): result = BASE + addend
                    dv.setUint32(fileOff, (this.BASE + addend) >>> 0, true);
                    absApplied++;
                } else {
                    // v21 FIX: NULL/undefined symbol (sym_idx=0).
                    // Per ARM ELF spec: R_ARM_ABS32 result = S + A = 0 + A = A (unchanged)
                    // Do NOT add BASE — that was corrupting 3202 vtable entries,
                    // data pointers, and turning constants like 0x4000 or ASCII "nik"
                    // (0x6e696b) into bogus addresses.
                    // If the linker wanted BASE added, it would use R_ARM_RELATIVE.
                    absSkippedNull++;
                }
            } else {
                errors++;
            }
        }
        Logger.success('R_ARM_ABS32: ' + absApplied + ' applied, ' + absSkippedNull + ' null-sym left as-is (' + (performance.now() - t1).toFixed(0) + 'ms)');

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
                // v26: Track which GOT entries are unresolved for STUB diagnostics
                if (!this._unresolvedGOT) this._unresolvedGOT = {};
                this._unresolvedGOT[gotAddr] = rel.symName;
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
                    // v24: Log shim calls in trace mode for debugging render path
                    if (self._traceEnabled && self._traceInsnsCount < self._traceMaxInsns) {
                        var lr = self._readReg(uc.ARM_REG_LR);
                        self._traceLog.push({
                            n: self._traceInsnsCount + 1,
                            pc: '0x' + (addr>>>0).toString(16),
                            off: 'SHIM:' + handler.name,
                            bytes: '-- shim --',
                            r0: '0x' + (r0>>>0).toString(16),
                            r1: '0x' + (r1>>>0).toString(16),
                            r2: '0x' + (r2>>>0).toString(16),
                            r3: '0x' + (r3>>>0).toString(16),
                            sp: '0x' + (self._readReg(uc.ARM_REG_SP)>>>0).toString(16),
                            lr: '0x' + (lr>>>0).toString(16),
                            mem: ''
                        });
                    }
                    var result = handler.handler(self.emu, [r0, r1, r2, r3]);
                    if (result !== undefined && result !== null) {
                        self._writeReg(uc.ARM_REG_R0, result >>> 0);
                    }
                } else if (addr === self.RETURN_SENTINEL) {
                    // v13.2: RETURN_SENTINEL reached — function returned cleanly
                    // emu_start will stop here since this is the stop address
                    Logger.arm('↩ RETURN_SENTINEL reached — function returned cleanly');
                } else if (self.jni && self.jni.JNI_STUB_BASE && addr >= self.jni.JNI_STUB_BASE && addr < self.jni.JNI_STUB_BASE + 0x1000) {
                    // v26b: JNI stub — identify which vtable slot was called
                    var slot = (addr - self.jni.JNI_STUB_BASE) / 8;
                    var lr = self._readReg(uc.ARM_REG_LR);
                    var r0 = self._readReg(uc.ARM_REG_R0);
                    var r1 = self._readReg(uc.ARM_REG_R1);
                    // JNI function names by slot number
                    var jniNames = {
                        6: 'FindClass', 10: 'GetSuperclass', 15: 'ExceptionOccurred',
                        16: 'ExceptionDescribe', 17: 'ExceptionClear', 21: 'NewGlobalRef',
                        28: 'NewObject', 31: 'GetObjectClass', 33: 'GetMethodID',
                        34: 'CallObjectMethod', 37: 'CallBooleanMethod',
                        49: 'CallIntMethod', 61: 'CallVoidMethod',
                        94: 'GetFieldID', 95: 'GetObjectField', 96: 'GetBooleanField',
                        97: 'GetByteField', 100: 'GetIntField', 102: 'GetLongField',
                        104: 'GetFloatField', 113: 'GetStaticMethodID',
                        114: 'CallStaticObjectMethod', 117: 'CallStaticBooleanMethod',
                        129: 'CallStaticIntMethod', 141: 'CallStaticVoidMethod',
                        144: 'GetStaticFieldID', 145: 'GetStaticObjectField',
                        154: 'GetStaticIntField', 167: 'NewStringUTF',
                        169: 'GetStringUTFChars', 171: 'GetArrayLength',
                        228: 'ExceptionCheck'
                    };
                    var name = jniNames[slot] || 'JNI#' + slot;
                    if (!self._jniStubCounts) self._jniStubCounts = {};
                    var cnt = self._jniStubCounts[slot] || 0;
                    self._jniStubCounts[slot] = cnt + 1;
                    if (cnt < 3) {
                        Logger.warn('[JNI-STUB] Unhandled JNI slot ' + slot + ' (' + name + ') from LR=0x' + (lr>>>0).toString(16) +
                            ' R0=0x' + (r0>>>0).toString(16) + ' R1=0x' + (r1>>>0).toString(16));
                    }
                } else if (addr === self.GENERIC_RETURN || addr === self.SHIM_BASE) {
                    // v16: Generic return stub — R0 is set to 0 by ARM instructions
                    // (MOV R0, #0; BX LR). Track callers for debugging.
                    var lr = self._readReg(uc.ARM_REG_LR);
                    var count = self._genericReturnCalls.get(lr) || 0;
                    self._genericReturnCalls.set(lr, count + 1);
                    // v26: Enhanced STUB logging — try to identify the unresolved function
                    if (count < 5) {
                        var r0 = self._readReg(uc.ARM_REG_R0);
                        var r1 = self._readReg(uc.ARM_REG_R1);
                        var offset = ((lr - self.BASE) >>> 0);
                        var symName = '(unknown)';
                        // Try to find the function name: read the BL target at LR-4
                        // On ARM, BL instruction encodes offset. But easier: check PLT veneer.
                        // The call chain is: caller BL → PLT veneer → LDR PC,[GOT] → GENERIC_RETURN
                        // We can scan nearby GOT entries for clues
                        try {
                            // Read 8 bytes before LR to look for the BL instruction
                            var callerBytes = self.emu.mem_read(lr - 8, 8);
                            var inst1 = (callerBytes[0] | (callerBytes[1]<<8) | (callerBytes[2]<<16) | (callerBytes[3]<<24)) >>> 0;
                            var inst2 = (callerBytes[4] | (callerBytes[5]<<8) | (callerBytes[6]<<16) | (callerBytes[7]<<24)) >>> 0;
                            // If Thumb mode (LR bit 0 set), decode BL differently
                            var isThumb = (lr & 1) !== 0;
                            if (isThumb) {
                                // Thumb BL: 2-part encoding, target = PC + offset
                                // Just log the raw bytes for now
                                symName = '(thumb@LR-8: ' + inst1.toString(16) + ' ' + inst2.toString(16) + ')';
                            } else {
                                // ARM BL: top 4 bits = cond, next 4 = 0xB (BL), bottom 24 = signed offset
                                if ((inst2 & 0x0F000000) === 0x0B000000) {
                                    var blOffset = inst2 & 0x00FFFFFF;
                                    if (blOffset & 0x800000) blOffset = blOffset | 0xFF000000; // sign extend
                                    var target = ((lr - 4) + (blOffset << 2) + 8) >>> 0;
                                    // Target should be a PLT veneer — read it to get GOT addr
                                    try {
                                        var pltBytes = self.emu.mem_read(target, 12);
                                        // Look for LDR PC, [PC, #offset] pattern
                                        var gotAddr2 = 0;
                                        var pltInst = (pltBytes[0] | (pltBytes[1]<<8) | (pltBytes[2]<<16) | (pltBytes[3]<<24)) >>> 0;
                                        if ((pltInst & 0xFFFFF000) === 0xE59FF000) {
                                            // LDR PC, [PC, #imm12]
                                            var pltOff = pltInst & 0xFFF;
                                            gotAddr2 = (target + 8 + pltOff) >>> 0;
                                        }
                                        if (gotAddr2 && self._unresolvedGOT && self._unresolvedGOT[gotAddr2]) {
                                            symName = self._unresolvedGOT[gotAddr2];
                                        } else if (gotAddr2) {
                                            symName = '(GOT@0x' + gotAddr2.toString(16) + ')';
                                        }
                                    } catch(ee) {}
                                }
                            }
                        } catch(e2) {}
                        Logger.warn('[STUB] Generic return from LR=0x' + (lr>>>0).toString(16) +
                            ' (offset 0x' + offset.toString(16) + ') fn=' + symName +
                            ' R0=0x' + (r0>>>0).toString(16) +
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
        // v30: Unrelocated function pointer redirect
        // If FETCH targets addr below BASE but (BASE + addr) is within binary range,
        // this is an unrelocated function pointer (missing R_ARM_RELATIVE).
        // Redirect PC to the correct address instead of returning 0.
        if (type === 'fetch' && (addr >>> 0) < this.BASE) {
            var pc = this._readReg(uc.ARM_REG_PC);
            var lr = this._readReg(uc.ARM_REG_LR);
            var r0 = this._readReg(uc.ARM_REG_R0);
            var lrUnsigned = lr >>> 0;

            // v30: Check if this is an unrelocated binary address
            var relocatedAddr = (this.BASE + addr) >>> 0;
            var binaryEnd = (this.BASE + this.elf.mapSize) >>> 0;
            if (addr > 0 && relocatedAddr >= this.BASE && relocatedAddr < binaryEnd) {
                if (!this._unrelocRedirectCount) this._unrelocRedirectCount = 0;
                this._unrelocRedirectCount++;
                if (this._unrelocRedirectCount <= 20) {
                    Logger.warn('[MEM] v30: Unrelocated function ptr 0x' + (addr>>>0).toString(16) +
                        ' → redirecting to 0x' + relocatedAddr.toString(16) +
                        ' (BASE+0x' + (addr>>>0).toString(16) + ') LR=0x' + lrUnsigned.toString(16));
                }
                // Map the page containing the unrelocated address (in case it's not mapped)
                var CODE_BLOCK = 0x100000;
                var aligned = addr & ~(CODE_BLOCK - 1);
                if (!this._autoMapped.has(aligned)) {
                    try {
                        this.emu.mem_map(aligned, CODE_BLOCK, uc.PROT_ALL);
                        this._autoMapped.add(aligned);
                    } catch(e) {}
                }
                // Write a branch to the correct address at the target location
                // ARM: LDR PC, [PC, #-4] followed by the target address
                // This is a PC-relative load: when PC is at addr, it reads addr+8-4=addr+4
                try {
                    var b0 = relocatedAddr & 0xFF;
                    var b1 = (relocatedAddr >> 8) & 0xFF;
                    var b2 = (relocatedAddr >> 16) & 0xFF;
                    var b3 = (relocatedAddr >> 24) & 0xFF;
                    this.emu.mem_write(addr, [
                        0x04, 0xF0, 0x1F, 0xE5,  // LDR PC, [PC, #-4]
                        b0, b1, b2, b3            // target address
                    ]);
                } catch(e) {}
                return true;  // let execution continue — will jump to correct address
            }

            // Genuine NULL function pointer (addr doesn't map to binary)
            if (lrUnsigned >= this.BASE || (lrUnsigned >= 0xe0000000 && lrUnsigned < 0xf0000000)) {
                if (!this._nullPtrCount) this._nullPtrCount = 0;
                this._nullPtrCount++;
                if (this._nullPtrCount <= 5) {
                    Logger.warn('[MEM] NULL function ptr at 0x' + (addr>>>0).toString(16) +
                        ' — auto-return to LR=0x' + lrUnsigned.toString(16) +
                        ' R0=0x' + (r0>>>0).toString(16));
                }
                // Map the page so Unicorn doesn't fault, fill entirely with BX LR
                var CODE_BLOCK = 0x100000;
                var aligned = addr & ~(CODE_BLOCK - 1);
                if (!this._autoMapped.has(aligned)) {
                    try {
                        this.emu.mem_map(aligned, CODE_BLOCK, uc.PROT_ALL);
                        this._autoMapped.add(aligned);
                        // Fill with MOV R0,#0; BX LR every 8 bytes
                        var stub = [0x00, 0x00, 0xA0, 0xE3, 0x1E, 0xFF, 0x2F, 0xE1];
                        var fill = [];
                        for (var si = 0; si < 512; si++) {
                            for (var sj = 0; sj < 8; sj++) fill.push(stub[sj]);
                        }
                        for (var off = 0; off < CODE_BLOCK; off += 4096) {
                            this.emu.mem_write(aligned + off, fill);
                        }
                    } catch(e) {}
                }
                try {
                    this.emu.mem_write(addr, [0x00, 0x00, 0xA0, 0xE3, 0x1E, 0xFF, 0x2F, 0xE1]);
                } catch(e) {}
                return true;
            }
            // LR not valid — hard stop
            Logger.error('[MEM] FETCH below BASE at 0x' + (addr>>>0).toString(16) +
                ' — NULL function pointer! PC=0x' + (pc>>>0).toString(16) +
                ' LR=0x' + (lr>>>0).toString(16) + ' R0=0x' + (r0>>>0).toString(16));
            this._unmappedAccessLog.push({ type: type, addr: addr, size: size, pc: pc, lr: lr });
            try { this.emu.emu_stop(); } catch(e) {}
            return false;
        }

        // v29: Use 1MB blocks instead of 16KB to reduce QEMU section table fragmentation.
        var AUTO_BLOCK = 0x100000; // 1MB
        var aligned = addr & ~(AUTO_BLOCK - 1);
        if (!this._autoMapped.has(aligned)) {
            try {
                this.emu.mem_map(aligned, AUTO_BLOCK, uc.PROT_ALL);
                this._autoMapped.add(aligned);
                this.memMapped += AUTO_BLOCK;

                // v29d: Fill blocks below BASE with BX LR to prevent NOP-slide spin.
                // Data auto-maps below BASE can later be executed if code jumps there
                // via corrupted pointers. Without fill, the zeros decode as ANDEQ (NOP).
                if ((aligned >>> 0) < this.BASE) {
                    var stub = [0x00, 0x00, 0xA0, 0xE3, 0x1E, 0xFF, 0x2F, 0xE1]; // MOV R0,#0; BX LR
                    var fill = [];
                    for (var si = 0; si < 512; si++) {
                        for (var sj = 0; sj < 8; sj++) fill.push(stub[sj]);
                    }
                    for (var off = 0; off < AUTO_BLOCK; off += 4096) {
                        this.emu.mem_write(aligned + off, fill);
                    }
                }

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
            // v29: Init mode uses 100M — ScorpioJNI_init was hitting 20M cap without completing
            // (R0=0x0 = incomplete). With QEMU section overflow fixed, init runs longer and needs
            // more budget to fully initialize game state (singleton fields, threads, networking).
            var maxInsns = initMode ? 100000000 : this.maxFrameInsns;
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
            if (insns >= maxInsns - 10) {
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
        Logger.info('Step 2/9: BGCoreJNIBridge.init');
        results.push(this.callFunction('Java_com_bight_android_jni_BGCoreJNIBridge_init', this.jni.prepareBGCoreInit(width, height), true));

        // Step 3: ScorpioJNI.init (moved BEFORE OGLESInit — creates Scorpio singleton)
        Logger.info('Step 3/9: ScorpioJNI.init');
        results.push(this.callFunction('Java_com_ea_simpsons_ScorpioJNI_init', this.jni.prepareCall('ScorpioJNI_init'), true));

        // === v18: Pre-allocate BGCore object for OGLESInit ===
        // OGLESInit reads ScorpioSingleton (VA 0x1A45728) → +0x1AC → BGCore object
        // If ScorpioJNI.init properly initialized, field +0x1AC may already be set.
        // v30: Only pre-allocate if the field is still NULL.
        var SINGLETON_PTR_ADDR = this.BASE + 0x1A45728;
        var singletonPtr = this._readU32FromEmu(SINGLETON_PTR_ADDR);
        var existingBGCore = singletonPtr ? this._readU32FromEmu(singletonPtr + 0x1AC) : 0;
        if (singletonPtr && singletonPtr !== 0 && (!existingBGCore || existingBGCore === 0)) {
            // Allocate fake BGCore object (0x200 bytes)
            var bgCoreSize = 0x200;
            var bgCorePtr = AndroidShims.malloc(bgCoreSize);
            // Zero it
            try { this.emu.mem_write(bgCorePtr, new Array(bgCoreSize).fill(0)); } catch(e) {}

            // Create vtable: 64 entries of GENERIC_RETURN
            var vtableSize = 64 * 4;
            var vtablePtr = AndroidShims.malloc(vtableSize);
            var vtableData = [];
            for (var vi = 0; vi < 64; vi++) {
                var addr = this.GENERIC_RETURN;
                vtableData.push(addr & 0xFF, (addr >> 8) & 0xFF, (addr >> 16) & 0xFF, (addr >> 24) & 0xFF);
            }
            try { this.emu.mem_write(vtablePtr, vtableData); } catch(e) {}

            // Write vtable pointer at BGCore+0
            this._writeU32ToEmu(bgCorePtr, vtablePtr);
            // Write BGCore pointer at singleton+0x1AC
            this._writeU32ToEmu(singletonPtr + 0x1AC, bgCorePtr);
            Logger.success('v18: Pre-allocated BGCore object at 0x' + bgCorePtr.toString(16) +
                ' (vtable at 0x' + vtablePtr.toString(16) + ') → singleton+0x1AC');
        } else if (existingBGCore && existingBGCore !== 0) {
            Logger.success('v30: BGCore already initialized at 0x' + existingBGCore.toString(16) + ' — skipping pre-allocation');
        } else {
            Logger.warn('v18: Scorpio singleton still NULL after ScorpioJNI.init — BGCore NOT pre-allocated');
        }

        // Step 4: OGLESInit (now has valid BGCore via pre-allocation)
        Logger.info('Step 4/9: OGLESInit');
        results.push(this.callFunction('Java_com_bight_android_jni_BGCoreJNIBridge_OGLESInit', this.jni.prepareCall('OGLESInit', [width, height]), true));

        // Step 5: OGLESResize
        Logger.info('Step 5/9: OGLESResize');
        results.push(this.callFunction('Java_com_bight_android_jni_BGCoreJNIBridge_OGLESResize', {
            r0: this.jni.JNIENV_BASE,
            r1: this.jni.JOBJECT_BASE,
            r2: width,
            r3: height,
        }, true));

        // Step 6: Lifecycle.onCreate
        Logger.info('Step 6/9: Lifecycle.onCreate');
        results.push(this.callFunction('Java_com_ea_simpsons_ScorpioJNI_LifecycleOnCreate',
            this.jni.prepareCall('LifecycleOnCreate'), true));

        // Step 7: Lifecycle.Start
        Logger.info('Step 7/9: Lifecycle.Start');
        results.push(this.callFunction('Java_com_ea_simpsons_ScorpioJNI_LifecycleStart',
            this.jni.prepareCall('LifecycleStart'), true));

        // Step 8: Lifecycle.Resume
        Logger.info('Step 8/9: Lifecycle.Resume');
        results.push(this.callFunction('Java_com_ea_simpsons_ScorpioJNI_LifecycleResume',
            this.jni.prepareCall('LifecycleResume'), true));
        // v22: Call Nimble framework lifecycle (needed for engine subsystem init)
        Logger.info('Step 8b/9: Nimble.onApplicationLaunch');
        results.push(this.callFunction('Java_com_ea_nimble_bridge_NimbleCppApplicationLifeCycle_onApplicationLaunch',
            this.jni.prepareCall('NimbleOnAppLaunch'), true));

        Logger.info('Step 8c/9: Nimble.onApplicationResume');
        results.push(this.callFunction('Java_com_ea_nimble_bridge_NimbleCppApplicationLifeCycle_onApplicationResume',
            this.jni.prepareCall('NimbleOnAppResume'), true));

        results.push(this.callFunction('Java_com_bight_android_jni_BGCoreJNIBridge_resume', {
            r0: this.jni.JNIENV_BASE,
            r1: this.jni.JOBJECT_BASE,
        }, true));

        // === v26c: Java→Native callbacks (simulate Android Activity behavior) ===
        // On real Android, the Java activity drives boot sequence by calling these JNI methods.
        // The native code waits for these callbacks to proceed with networking.

        // 1. Signal DLC download complete (the game expects Java side to manage DLC)
        Logger.info('Step 9a/11: downloadComplete callback');
        results.push(this.callFunction('Java_com_ea_simpsons_BackgroundDownloaderJava_downloadComplete', {
            r0: this.jni.JNIENV_BASE,
            r1: this.jni.JOBJECT_BASE,
            r2: 1,  // success = true
            r3: 0,  // downloadId = 0
        }, true));

        // 2. Set server time (the Java activity gets this from system clock)
        var serverTime = Math.floor(Date.now() / 1000);
        Logger.info('Step 9b/11: serverStartTime(' + serverTime + ')');
        results.push(this.callFunction('Java_com_ea_simpsons_ScorpioJNI_serverStartTime', {
            r0: this.jni.JNIENV_BASE,
            r1: this.jni.JOBJECT_BASE,
            r2: serverTime & 0xFFFFFFFF,
            r3: 0,
        }, true));

        // 3. Set current server time
        Logger.info('Step 9c/11: serverCurrentTime(' + serverTime + ')');
        results.push(this.callFunction('Java_com_ea_simpsons_ScorpioJNI_serverCurrentTime', {
            r0: this.jni.JNIENV_BASE,
            r1: this.jni.JOBJECT_BASE,
            r2: serverTime & 0xFFFFFFFF,
            r3: 0,
        }, true));

        // 4. Execute pending threads that may have been created
        // === v24: Execute pending background threads ===
        // pthread_create stores routines but doesn't run them (single-threaded emulator).
        // Run them now so asset loaders, initialization threads, etc. complete.
        if (AndroidShims._pendingThreads && AndroidShims._pendingThreads.length > 0) {
            Logger.info('v24: Running ' + AndroidShims._pendingThreads.length + ' pending thread routines...');
            var threadsRan = AndroidShims.runPendingThreads(20);
            Logger.info('v24: Executed ' + threadsRan + ' threads, ' +
                        AndroidShims._pendingThreads.length + ' remaining');
        }

        // === v24: Log heap stats ===
        Logger.info('v24 Heap: ' + AndroidShims._allocCount + ' allocs, ' +
                    AndroidShims._freeCount + ' frees, ' +
                    AndroidShims._recycledCount + ' recycled (' +
                    Math.round(AndroidShims._recycledBytes / 1024) + ' KB), ' +
                    Math.round((AndroidShims._heapPtr - AndroidShims._heapBase) / 1048576) + 'MB used');

        // === v13.2: Force-enable rendering ===
        // The game's render function checks a flag at singleton+0xD1B
        // This byte is normally set by internal async loading, which we can't emulate
        // Read the singleton pointer and force the flag
        var SINGLETON_PTR_ADDR = this.BASE + 0x1A45728;
        var singletonPtr = this._readU32FromEmu(SINGLETON_PTR_ADDR);
        if (singletonPtr && singletonPtr !== 0) {
            // v19: Correct flag analysis from OGLESRender disassembly:
            //   flag@0x1A466A8: 0=normal, !=0=SHUTDOWN (confirmed: deletes, mutex_destroy)
            //   singleton+0xD1B: 0=real render (tail-call 0x12C33C0), !=0=glClear only
            // So: flag=0, render-ready=0 → REAL rendering path!
            this.emu.mem_write(singletonPtr + 0xD1B, [0]);  // 0 = real render
            this.savedSingletonPtr = singletonPtr;
            Logger.success('v19: render-ready=0 at singleton (0x' + singletonPtr.toString(16) + '+0xD1B) — routes to real render function');

            // v22 FIX: The render function at 0x12C33C0 does:
            //   LDRB R1, [singleton, #0xD1C]
            //   CMP R1, #0
            //   BEQ skip_render_body         ← 0 = SKIP (not enter!)
            //   ... main render body (scene graph traversal, draw calls) ...
            // skip_render_body:
            //   LDRB R0, [singleton, #4]     ← engine initialized check
            //   if (R0 != 0 && singleton[5] == 0) → glClearColor only
            //
            // So: 0xD1C must be NON-ZERO (1) to enter the render body!
            // Previous versions had this inverted (set 0, which skipped rendering).
            this.emu.mem_write(singletonPtr + 4, [1]);     // engine initialized = true
            this.emu.mem_write(singletonPtr + 5, [0]);     // no error
            this.emu.mem_write(singletonPtr + 0xD1C, [1]); // 1 = ENTER render body (BNE path)
            Logger.success('v22: engine-init=1, error=0, D1C=1 (render body ENABLED)');

            // v22 FIX: The byte at VA 0x1A466A8 controls OGLESRender's render path:
            //   0 = normal (needs scene graph) → skip loading render → empty black
            //   1 = loading mode → calls loading screen renderer at 0x12C2EF8
            // Set to 1 so OGLESRender enters loading screen path (splash/progress)
            var GLOBAL_FLAG_ADDR = this.BASE + 0x1A466A8;
            this.emu.mem_write(GLOBAL_FLAG_ADDR, [1]);
            Logger.success('v22: engine-flag=1 (loading mode), D1B=0, D1C=1 → loading screen render path');

            // === v23: PATCH ARM BINARY to hardcode singleton in dispatch ===
            // The dispatch at 0x12C30C4 reads a global pointer from VA 0x1A45728:
            //   LDR R0, [PC, #4]     ; load literal offset from 0x12C30D0
            //   LDR R0, [PC, R0]     ; indirect read from global at 0x1A45728
            //   BX LR
            // Writing to 0x1A45728 from JS gets cleared before OGLESRender reads it.
            // FIX: Replace the dispatch to return singleton directly from literal pool.
            //   LDR R0, [PC, #4]     ; load singleton from literal at 0x12C30D0 (SAME instruction)
            //   BX LR                ; return immediately (skip indirect load)
            //   <nop>                ; was BX LR, now dead
            //   <singleton ptr>      ; was 0x00782658 offset, now singleton ptr value
            this.emu.mem_write(this.BASE + 0x12C30C8, [
                0x1E, 0xFF, 0x2F, 0xE1  // BX LR (was: LDR R0, [PC, R0])
            ]);
            this._writeU32ToEmu(this.BASE + 0x12C30D0, singletonPtr); // literal = singleton ptr
            // Verify patch
            var patchVerify1 = this.emu.mem_read(this.BASE + 0x12C30C4, 16);
            Logger.success('v23: Patched dispatch@0x12C30C4 bytes: ' +
                Array.from(patchVerify1).map(function(b){return ('0'+b.toString(16)).slice(-2)}).join(' '));

            // Also patch the loading renderer wrapper at 0x12C2EF8:
            //   PUSH; MOV R11,SP; LDR R0,[PC,#0x24]; LDR R0,[PC,R0]; CMP; POPEQ
            // The second LDR reads from 0x1A45728 (same global). Patch:
            //   Replace LDR R0,[PC,R0] at 0x12C2F04 with NOP
            //   Replace literal at 0x12C2F2C with singleton ptr value
            // Then: LDR R0,[PC,#0x24] loads singleton directly, CMP!=0, continues to renderer
            this.emu.mem_write(this.BASE + 0x12C2F04, [
                0x00, 0x00, 0xA0, 0xE1  // NOP (MOV R0,R0) — skip indirect global read
            ]);
            this._writeU32ToEmu(this.BASE + 0x12C2F2C, singletonPtr); // literal = singleton ptr
            var patchVerify2 = this.emu.mem_read(this.BASE + 0x12C2EF8, 56);
            Logger.success('v23: Patched renderer@0x12C2EF8 bytes(+0..+8): ' +
                Array.from(patchVerify2.slice(0, 16)).map(function(b){return ('0'+b.toString(16)).slice(-2)}).join(' '));
            Logger.success('v23: Patched renderer literal@0x12C2F2C: ' +
                Array.from(patchVerify2.slice(0x2C - 0x00 + 0, 0x2C - 0x00 + 4)).map(function(b){return ('0'+b.toString(16)).slice(-2)}).join(' '));
            // Also verify the global at 0x1A45728
            var globalVal = this._readU32FromEmu(this.BASE + 0x1A45728);
            Logger.success('v23: Global@0x1A45728 = 0x' + globalVal.toString(16) + ' (singleton=0x' + singletonPtr.toString(16) + ')');
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

        // v22: List ALL available Java_ JNI functions from the binary
        var jniFunctions = this.elf.getJNIFunctions ? this.elf.getJNIFunctions() : [];
        window._jniFunctions = jniFunctions;
        Logger.info('Available JNI functions from binary (' + jniFunctions.length + '):');
        for (var ji = 0; ji < jniFunctions.length; ji++) {
            Logger.info('  [JNI] ' + jniFunctions[ji].name + ' @ 0x' + jniFunctions[ji].offset.toString(16));
        }

        return true;
    }

    /**
     * v22: Call a raw binary address (not a symbol) with given register args
     */
    callAddress(addr, args, maxInsns) {
        args = args || {};
        maxInsns = maxInsns || this.maxFrameInsns;

        this._writeReg(uc.ARM_REG_SP, this.STACK + this.STACK_SIZE - 0x1000);
        this._writeReg(uc.ARM_REG_LR, this.RETURN_SENTINEL);

        if (args.r0 !== undefined) this._writeReg(uc.ARM_REG_R0, args.r0);
        if (args.r1 !== undefined) this._writeReg(uc.ARM_REG_R1, args.r1);
        if (args.r2 !== undefined) this._writeReg(uc.ARM_REG_R2, args.r2);
        if (args.r3 !== undefined) this._writeReg(uc.ARM_REG_R3, args.r3);

        var startInsns = this.totalInstructions;
        try {
            this.emu.emu_start(addr, this.RETURN_SENTINEL, 0, maxInsns);
        } catch(e) {
            Logger.error('callAddress(0x' + addr.toString(16) + ') error: ' + e.message);
        }
        var insns = this.totalInstructions - startInsns;
        var r0 = this._readReg(uc.ARM_REG_R0);
        var endPC = this._readReg(uc.ARM_REG_PC);
        return { success: true, instructions: insns, r0: r0, endPC: endPC };
    }

    runFrame() {
        // v22: Track GENERIC_RETURN stubs hit during this frame
        if (!this._frameStubLog) this._frameStubLog = [];
        var prevStubCalls = new Map(this._genericReturnCalls);

        // v22: Ensure rendering state is correct before each frame
        if (this.savedSingletonPtr) {
            var SINGLETON_PTR_ADDR = this.BASE + 0x1A45728;
            var currentPtr = this._readU32FromEmu(SINGLETON_PTR_ADDR);
            if (currentPtr === 0) {
                this._writeU32ToEmu(SINGLETON_PTR_ADDR, this.savedSingletonPtr);
            }
            // v22 FIX: flag byte at 0x1A466A8 controls OGLESRender path:
            //   0 = normal render (needs populated scene graph — which we DON'T have)
            //   1 = loading mode (calls loading screen renderer at 0x12C2EF8)
            // We were wrongly setting 0 ("normal") but with empty scene = black screen.
            // Set to 1 to trigger the loading screen render path!
            this.emu.mem_write(this.BASE + 0x1A466A8, [1]);     // loading mode = show loading screen
            this.emu.mem_write(this.savedSingletonPtr + 0xD1B, [0]); // D1B = 0 → render path
            this.emu.mem_write(this.savedSingletonPtr + 0xD1C, [1]); // D1C = 1 → enter render body (BNE)
            this.emu.mem_write(this.savedSingletonPtr + 4, [1]);     // engine init = 1
            this.emu.mem_write(this.savedSingletonPtr + 5, [0]);     // no error
        }
        // Start function profiling for first few frames
        if (this._frameProfileCount < this._maxProfileFrames) {
            this._frameCallProfile = new Map();
        }

        // v22: Auto-enable trace on first frame to capture OGLESRender's early return
        if (this._frameProfileCount === 0 && !this._v22TraceCaptureDone) {
            this._traceEnabled = true;
            this._traceLog = [];
            this._traceInsnsCount = 0;
            this._traceMaxInsns = 200; // 111 insns + some margin
            Logger.info('[v22] ARM trace auto-enabled for first frame (capturing up to 200 insns)');
        }

        this._pcSamples = {}; // reset PC sampling for this frame
        this._writeGenericReturnStub();
        this._writeReturnSentinelStub();

        // v27: Execute any pending threads each frame (threads may be created during render)
        if (AndroidShims._pendingThreads && AndroidShims._pendingThreads.length > 0) {
            var threadCount = AndroidShims._pendingThreads.length;
            var threadsRan = AndroidShims.runPendingThreads(5);
            if (threadsRan > 0) {
                Logger.info('[v27] Ran ' + threadsRan + '/' + threadCount + ' pending threads during frame');
            }
        }

        // v22: Call OGLESRenderGLLoadingScreen FIRST — this renders the loading/splash screen
        // while the scene graph is empty. Then also call OGLESRender for the main scene.
        if (!this._loadingScreenDone) {
            var loadingResult = this.callFunction('Java_com_bight_android_jni_BGCoreJNIBridge_OGLESRenderGLLoadingScreen',
                this.jni.prepareCall('OGLESRenderGLLoadingScreen'));
            var loadInsns = loadingResult ? loadingResult.instructions || 0 : 0;

            // Log first few frames
            if (!this._loadingScreenFrameCount) this._loadingScreenFrameCount = 0;
            this._loadingScreenFrameCount++;
            if (this._loadingScreenFrameCount <= 5) {
                Logger.info('[v22] OGLESRenderGLLoadingScreen: ' + loadInsns + ' insns, R0=0x' +
                    ((loadingResult && loadingResult.r0 || 0) >>> 0).toString(16));
                // v23: Verify dispatch patch is still intact before OGLESRender
                var dispBytes = this.emu.mem_read(this.BASE + 0x12C30C4, 16);
                Logger.info('[v23] dispatch@0x12C30C4 pre-OGLESRender: ' +
                    Array.from(dispBytes).map(function(b){return ('0'+b.toString(16)).slice(-2)}).join(' '));
                var globalNow = this._readU32FromEmu(this.BASE + 0x1A45728);
                Logger.info('[v23] global@0x1A45728 = 0x' + globalNow.toString(16));
            }

            // Check if scene graph became populated (singleton+0x58 != 0)
            if (this.savedSingletonPtr) {
                try {
                    var renderList = this._readU32FromEmu(this.savedSingletonPtr + 0x58);
                    if (renderList !== 0) {
                        Logger.success('[v22] Scene graph populated! singleton+0x58 = 0x' + renderList.toString(16) + ' — switching to OGLESRender');
                        this._loadingScreenDone = true;
                    }
                } catch(e) {}
            }
        }

        // v23: Write singleton pointer to 0x1A45728 IMMEDIATELY before OGLESRender
        // The dispatch at 0x12C30C4 reads this global and returns it.
        // Previous write (in per-frame setup) gets cleared during OGLESRenderGLLoadingScreen ARM execution.
        if (this.savedSingletonPtr) {
            this._writeU32ToEmu(this.BASE + 0x1A45728, this.savedSingletonPtr);
        }

        var frameResult = this.callFunction('Java_com_bight_android_jni_BGCoreJNIBridge_OGLESRender',
            this.jni.prepareCall('OGLESRender'));

        // v22: Detect early return and bypass via direct call to 0x12C33C0
        // With flag=1 (loading mode), OGLESRender should run longer (calls loading screen renderer)
        var oglesInsns = frameResult ? frameResult.instructions || 0 : 0;
        if (oglesInsns < 1000 && this.savedSingletonPtr) {
            Logger.warn('[v23] OGLESRender returned early (' + oglesInsns + ' insns) — bypassing to direct loading renderer at 0x12C2F34');

            // Analyze the trace to find the early-return branch
            if (this._traceLog.length > 0 && !this._v22TraceCaptureDone) {
                this._v22TraceCaptureDone = true;
                Logger.info('[v22] === OGLESRender TRACE (' + this._traceLog.length + ' instructions) ===');

                // Find branches (instruction bytes containing 0x0A/0x1A/0xEA = B, 0x0B = BL, etc.)
                var branchInsns = [];
                for (var i = 0; i < this._traceLog.length; i++) {
                    var t = this._traceLog[i];
                    var bytes = t.bytes.split(' ');
                    if (bytes.length >= 4) {
                        var opByte = parseInt(bytes[3], 16);
                        // ARM branch opcodes: 0xEA=B, 0xEB=BL, 0x0A=BEQ, 0x1A=BNE, 0xDA=BLE, etc.
                        // Also BX LR: 0x1E 0xFF 0x2F 0xE1
                        var isBranch = (opByte & 0x0F) === 0x0A || (opByte & 0x0F) === 0x0B;
                        var isBX = (bytes[0] === '1e' && bytes[1] === 'ff' && bytes[2] === '2f' && bytes[3] === 'e1');
                        if (isBranch || isBX) {
                            branchInsns.push({ idx: i, entry: t, isBX: isBX });
                        }
                    }
                }

                // Log all branches
                for (var j = 0; j < branchInsns.length; j++) {
                    var b = branchInsns[j];
                    Logger.warn('[v22] Branch #' + b.idx + ': ' + b.entry.off + ' [' + b.entry.bytes + '] R0=' + b.entry.r0 + ' LR=' + b.entry.lr + (b.isBX ? ' (BX LR — RETURN)' : ''));
                }

                // Log last 10 instructions before return
                Logger.info('[v22] Last 10 instructions before return:');
                var start = Math.max(0, this._traceLog.length - 10);
                for (var k = start; k < this._traceLog.length; k++) {
                    var t = this._traceLog[k];
                    Logger.info('  #' + t.n + ' ' + t.off + ' [' + t.bytes + '] R0=' + t.r0 + ' R1=' + t.r1 + ' LR=' + t.lr + (t.mem ? ' ' + t.mem : ''));
                }
            }

            // === v23: DIRECT LOADING SCREEN RENDER CALL ===
            // Call the actual loading screen renderer at 0x12C2F34 directly
            // This function takes R0 = singleton pointer (same object stored at 0x1A45728)
            // It accesses offsets +0xD20, +0xD24, +0xD28, +0xD30, +0xD34, +0x1B0, +0x1AC, etc.
            this._writeU32ToEmu(this.BASE + 0x1A45728, this.savedSingletonPtr);
            this.emu.mem_write(this.savedSingletonPtr + 4, [1]);
            this.emu.mem_write(this.savedSingletonPtr + 5, [0]);

            // Enable trace for the direct call
            this._traceEnabled = true;
            this._traceLog = [];
            this._traceInsnsCount = 0;
            this._traceMaxInsns = 500;

            Logger.info('[v23] Calling loading renderer 0x12C2F34 directly with R0=singletonPtr (0x' + this.savedSingletonPtr.toString(16) + ')');
            var directResult = this.callAddress(this.BASE + 0x12C2F34, {
                r0: this.savedSingletonPtr
            }, this.maxFrameInsns);

            Logger.info('[v23] Loading renderer result: ' + directResult.instructions + ' insns, R0=0x' + (directResult.r0 >>> 0).toString(16) +
                ' endPC=0x' + (directResult.endPC >>> 0).toString(16));

            // Log direct call trace
            if (this._traceLog.length > 0) {
                Logger.info('[v23] === LOADING RENDERER 0x12C2F34 TRACE (' + this._traceLog.length + ' instructions) ===');
                // Log first 40 instructions (include shim names)
                for (var m = 0; m < Math.min(40, this._traceLog.length); m++) {
                    var t = this._traceLog[m];
                    Logger.info('  #' + t.n + ' ' + t.off + ' [' + t.bytes + '] R0=' + t.r0 + ' R1=' + t.r1 + ' LR=' + t.lr + (t.mem ? ' ' + t.mem : ''));
                }
                if (this._traceLog.length > 40) {
                    Logger.info('  ... (' + (this._traceLog.length - 40) + ' more)');
                }
                // Log last 15 if different
                if (this._traceLog.length > 55) {
                    Logger.info('[v23] Last 15 instructions of loading renderer:');
                    var dstart = this._traceLog.length - 15;
                    for (var dm = dstart; dm < this._traceLog.length; dm++) {
                        var dt = this._traceLog[dm];
                        Logger.info('  #' + dt.n + ' ' + dt.off + ' [' + dt.bytes + '] R0=' + dt.r0 + ' R1=' + dt.r1 + ' LR=' + dt.lr + (dt.mem ? ' ' + dt.mem : ''));
                    }
                }
                // Store for download
                window._armTrace = this._traceLog.map(function(t) {
                    return '#' + t.n + ' ' + t.off + ' [' + t.bytes + '] R0=' + t.r0 + ' R1=' + t.r1 + ' R2=' + t.r2 + ' R3=' + t.r3 + ' SP=' + t.sp + ' LR=' + t.lr + (t.mem ? ' MEM:' + t.mem : '');
                }).join('\n');
                window._armTraceData = this._traceLog;
            }

            // Merge results
            frameResult = directResult;
        }

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
        
        // v22: Log stubs hit during this frame (first frame only)
        if (!this._stubsLoggedFirstFrame) {
            this._stubsLoggedFirstFrame = true;
            var newStubs = [];
            var self = this;
            this._genericReturnCalls.forEach(function(count, lr) {
                var prev = prevStubCalls.get(lr) || 0;
                if (count > prev) {
                    var offset = (lr - self.BASE) >>> 0;
                    // Try to find what symbol this caller is near
                    var callerName = '';
                    if (self.shimHandlers) {
                        var handler = self.shimHandlers.get(lr);
                        if (handler) callerName = ' (' + handler.name + ')';
                    }
                    newStubs.push({ lr: lr, offset: offset, hits: count - prev, name: callerName });
                }
            });
            if (newStubs.length > 0) {
                newStubs.sort(function(a,b) { return b.hits - a.hits; });
                Logger.warn('[v22] GENERIC_RETURN stubs hit during render frame (' + newStubs.length + ' unique):');
                for (var si = 0; si < Math.min(newStubs.length, 30); si++) {
                    var s = newStubs[si];
                    Logger.warn('  LR=0x' + (s.lr>>>0).toString(16) + ' (BIN+0x' + s.offset.toString(16) + ') x' + s.hits + s.name);
                }
                window._renderStubs = newStubs;
            } else {
                Logger.info('[v22] No GENERIC_RETURN stubs hit during render frame');
            }
        }

        // v22: Force a visible glClear after ARM rendering
        // The game calls glClearColor but never glClear, so framebuffer is never written.
        // Also inject a test triangle to prove WebGL pipeline works end-to-end.
        if (this.glBridge && this.glBridge.gl && !this.glBridge.headless) {
            var gl = this.glBridge.gl;
            // Force visible clear (green tint so we know WebGL works)
            gl.clearColor(0.05, 0.12, 0.05, 1.0);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            this.glBridge.callCount += 2;

            // Render a test triangle + "TSTO" text indicator
            if (!this._testRendererInit) {
                this._initTestRenderer(gl);
                this._testRendererInit = true;
            }
            if (this._testProgram) {
                this._renderTestFrame(gl);
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
            heapUsed: Math.round((AndroidShims._heapPtr - AndroidShims._heapBase) / 1048576),
            heapAllocs: AndroidShims._allocCount,
            heapFrees: AndroidShims._freeCount,
            heapRecycled: AndroidShims._recycledCount,
            threadsCreated: AndroidShims._nextThreadId - 100,
            threadsExecuted: AndroidShims._threadExecCount,
            dlsymStubs: AndroidShims._dlsymStubs ? AndroidShims._dlsymStubs.size : 0,
            netRequests: AndroidShims._netRequestCount || 0,
            netResponses: AndroidShims._netResponseCount || 0,
            virtualSockets: Object.keys(AndroidShims._virtualSockets || {}).length,
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

    // ================================================================
    // v22: Test renderer — proves WebGL pipeline works
    // Draws a spinning triangle + status text overlay
    // ================================================================

    _initTestRenderer(gl) {
        // Minimal vertex/fragment shaders
        var vsSrc = [
            'attribute vec2 a_pos;',
            'attribute vec3 a_color;',
            'varying vec3 v_color;',
            'uniform float u_time;',
            'uniform float u_aspect;',
            'void main() {',
            '  float c = cos(u_time), s = sin(u_time);',
            '  vec2 p = vec2(a_pos.x * c - a_pos.y * s, a_pos.x * s + a_pos.y * c);',
            '  p.x /= u_aspect;',
            '  gl_Position = vec4(p * 0.5, 0.0, 1.0);',
            '  v_color = a_color;',
            '}',
        ].join('\n');

        var fsSrc = [
            'precision mediump float;',
            'varying vec3 v_color;',
            'void main() {',
            '  gl_FragColor = vec4(v_color, 1.0);',
            '}',
        ].join('\n');

        var vs = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vs, vsSrc);
        gl.compileShader(vs);
        if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
            Logger.error('[TestRender] VS compile: ' + gl.getShaderInfoLog(vs));
            return;
        }

        var fs = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fs, fsSrc);
        gl.compileShader(fs);
        if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
            Logger.error('[TestRender] FS compile: ' + gl.getShaderInfoLog(fs));
            return;
        }

        var prog = gl.createProgram();
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            Logger.error('[TestRender] Link: ' + gl.getProgramInfoLog(prog));
            return;
        }

        this._testProgram = prog;
        this._testTimeLoc = gl.getUniformLocation(prog, 'u_time');
        this._testAspectLoc = gl.getUniformLocation(prog, 'u_aspect');
        this._testPosLoc = gl.getAttribLocation(prog, 'a_pos');
        this._testColorLoc = gl.getAttribLocation(prog, 'a_color');

        // Triangle: positions + colors interleaved
        // Springfield-themed colors: yellow, blue, white
        var data = new Float32Array([
            // x, y, r, g, b
             0.0,  0.6,  1.0, 0.85, 0.0,   // top — Simpsons yellow
            -0.5, -0.4,  0.2, 0.4,  0.9,    // bottom-left — blue
             0.5, -0.4,  1.0, 1.0,  1.0,    // bottom-right — white
        ]);

        this._testVBO = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this._testVBO);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);

        this._testStartTime = performance.now();
        Logger.success('[TestRender] Test renderer initialized — spinning triangle active');
    }

    _renderTestFrame(gl) {
        var t = (performance.now() - this._testStartTime) / 1000.0;
        var aspect = gl.canvas.width / gl.canvas.height;

        gl.useProgram(this._testProgram);
        gl.uniform1f(this._testTimeLoc, t);
        gl.uniform1f(this._testAspectLoc, aspect);

        gl.bindBuffer(gl.ARRAY_BUFFER, this._testVBO);
        gl.enableVertexAttribArray(this._testPosLoc);
        gl.vertexAttribPointer(this._testPosLoc, 2, gl.FLOAT, false, 20, 0);
        if (this._testColorLoc >= 0) {
            gl.enableVertexAttribArray(this._testColorLoc);
            gl.vertexAttribPointer(this._testColorLoc, 3, gl.FLOAT, false, 20, 8);
        }

        gl.disable(gl.DEPTH_TEST);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        this.glBridge.drawCalls++;

        gl.disableVertexAttribArray(this._testPosLoc);
        if (this._testColorLoc >= 0) gl.disableVertexAttribArray(this._testColorLoc);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        gl.useProgram(null);
    }

}
