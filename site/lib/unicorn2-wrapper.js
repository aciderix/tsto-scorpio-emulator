/**
 * Unicorn2 WASM Wrapper - Compatible API for TSTO Scorpio Emulator
 * 
 * Provides the same `uc` global object interface as the original unicorn-arm.min.js
 * but backed by a freshly-compiled Unicorn 2 WASM build with full VFP support.
 * 
 * Usage: Include this script AFTER unicorn2.js (the Emscripten module loader).
 * It will initialize the WASM module and create the global `uc` object.
 */

(function() {
    'use strict';

    // ---- Constants (from Unicorn headers) ----
    const UC_ARCH_ARM = 1;
    const UC_MODE_ARM = 0;
    const UC_MODE_THUMB = 16;
    const UC_PROT_ALL = 7;
    const UC_ERR_OK = 0;

    // Hook types
    const UC_HOOK_CODE = 4;            // 1 << 2
    const UC_HOOK_MEM_READ_UNMAPPED = 16;   // 1 << 4
    const UC_HOOK_MEM_WRITE_UNMAPPED = 32;  // 1 << 5
    const UC_HOOK_MEM_FETCH_UNMAPPED = 64;  // 1 << 6
    const UC_HOOK_INSN_INVALID = 16384;     // 1 << 14

    // ARM register IDs
    const UC_ARM_REG_R0 = 66;
    const UC_ARM_REG_R1 = 67;
    const UC_ARM_REG_R2 = 68;
    const UC_ARM_REG_R3 = 69;
    const UC_ARM_REG_SP = 12;
    const UC_ARM_REG_LR = 10;
    const UC_ARM_REG_PC = 11;
    const UC_ARM_REG_CPSR = 3;
    const UC_ARM_REG_FPEXC = 4;
    const UC_ARM_REG_FPSCR = 6;

    // Will be set when WASM module loads
    let Module = null;
    let moduleReady = false;

    // Hook callback storage
    const hookCallbacks = {};

    /**
     * Unicorn emulator instance wrapper
     */
    class UnicornWrapper {
        constructor(arch, mode) {
            if (!moduleReady) {
                throw new Error('Unicorn2 WASM module not ready yet');
            }
            // Call uc_open_js which returns the uc_engine pointer as an int
            this._uc = Module.ccall('uc_open_js', 'number', ['number', 'number'], [arch, mode]);
            if (this._uc === 0) {
                throw new Error('Failed to create Unicorn engine');
            }
            this._hooks = [];
            console.log('[UC2] Unicorn2 engine created, handle:', this._uc);
        }

        /**
         * Map memory region
         */
        mem_map(addr, size, perms) {
            const err = Module.ccall('uc_mem_map_js', 'number',
                ['number', 'number', 'number', 'number'],
                [this._uc, addr >>> 0, size >>> 0, perms]);
            if (err !== UC_ERR_OK) {
                console.warn('[UC2] mem_map error:', err, 'at', '0x' + (addr >>> 0).toString(16));
            }
            return err;
        }

        /**
         * Write data to memory
         * @param {number} addr - Address to write to
         * @param {Array|Uint8Array} bytes - Data to write
         */
        mem_write(addr, bytes) {
            const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
            const size = data.length;
            // Allocate buffer in WASM memory
            const buf = Module._malloc(size);
            Module.HEAPU8.set(data, buf);
            const err = Module.ccall('uc_mem_write_js', 'number',
                ['number', 'number', 'number', 'number'],
                [this._uc, addr >>> 0, buf, size]);
            Module._free(buf);
            if (err !== UC_ERR_OK) {
                console.warn('[UC2] mem_write error:', err, 'at', '0x' + (addr >>> 0).toString(16));
            }
            return err;
        }

        /**
         * Read data from memory
         * @param {number} addr - Address to read from
         * @param {number} size - Number of bytes to read
         * @returns {Array} Array of bytes
         */
        mem_read(addr, size) {
            const buf = Module._malloc(size);
            const err = Module.ccall('uc_mem_read_js', 'number',
                ['number', 'number', 'number', 'number'],
                [this._uc, addr >>> 0, buf, size]);
            const result = [];
            for (let i = 0; i < size; i++) {
                result.push(Module.HEAPU8[buf + i]);
            }
            Module._free(buf);
            return result;
        }

        /**
         * Write to a register
         * @param {number} regid - Register ID
         * @param {Array} bytes - 4 bytes (little-endian uint32)
         */
        reg_write(regid, bytes) {
            const buf = Module._malloc(4);
            for (let i = 0; i < 4; i++) {
                Module.HEAPU8[buf + i] = bytes[i] || 0;
            }
            const err = Module.ccall('uc_reg_write_js', 'number',
                ['number', 'number', 'number'],
                [this._uc, regid, buf]);
            Module._free(buf);
            return err;
        }

        /**
         * Read from a register
         * @param {number} regid - Register ID
         * @param {number} size - Must be 4 for ARM
         * @returns {Array} 4 bytes (little-endian uint32)
         */
        reg_read(regid, size) {
            const buf = Module._malloc(4);
            Module.ccall('uc_reg_read_js', 'number',
                ['number', 'number', 'number'],
                [this._uc, regid, buf]);
            const result = [];
            for (let i = 0; i < (size || 4); i++) {
                result.push(Module.HEAPU8[buf + i]);
            }
            Module._free(buf);
            return result;
        }

        /**
         * Start emulation
         */
        emu_start(begin, until, timeout, count) {
            const err = Module.ccall('uc_emu_start_js', 'number',
                ['number', 'number', 'number', 'number', 'number'],
                [this._uc, begin >>> 0, until >>> 0, timeout >>> 0, count >>> 0]);
            return err;
        }

        /**
         * Stop emulation
         */
        emu_stop() {
            return Module.ccall('uc_emu_stop_js', 'number', ['number'], [this._uc]);
        }

        /**
         * Add a hook
         * @param {number} type - Hook type (HOOK_CODE, HOOK_MEM_*, etc.)
         * @param {Function} callback - Callback function
         * @returns {number} Hook slot ID
         */
        hook_add(type, callback) {
            let slot;
            if (type === UC_HOOK_CODE) {
                slot = Module.ccall('uc_hook_add_code_js', 'number',
                    ['number', 'number', 'number'],
                    [this._uc, 1, 0]);
                hookCallbacks[slot] = callback;
            } else if (type === UC_HOOK_MEM_READ_UNMAPPED ||
                       type === UC_HOOK_MEM_WRITE_UNMAPPED ||
                       type === UC_HOOK_MEM_FETCH_UNMAPPED) {
                slot = Module.ccall('uc_hook_add_mem_js', 'number',
                    ['number', 'number', 'number', 'number'],
                    [this._uc, type, 1, 0]);
                hookCallbacks[slot] = callback;
            } else if (type === UC_HOOK_INSN_INVALID) {
                slot = Module.ccall('uc_hook_add_insn_invalid_js', 'number',
                    ['number'], [this._uc]);
                hookCallbacks[slot] = callback;
            } else {
                console.warn('[UC2] Unknown hook type:', type);
                return -1;
            }
            this._hooks.push(slot);
            console.log('[UC2] Hook added, type:', type, 'slot:', slot);
            return slot;
        }

        /**
         * Remove a hook
         */
        hook_del(slot) {
            delete hookCallbacks[slot];
            return Module.ccall('uc_hook_del_js', 'number',
                ['number', 'number'], [this._uc, slot]);
        }

        /**
         * Close/destroy the engine
         */
        close() {
            if (this._uc) {
                Module.ccall('uc_close_js', 'number', ['number'], [this._uc]);
                this._uc = 0;
            }
        }
    }

    /**
     * Initialize the WASM module and set up global `uc` and `MUnicorn` objects
     */
    async function initUnicorn2() {
        console.log('[UC2] Initializing Unicorn2 WASM module...');

        // UnicornModule is the Emscripten factory function from unicorn2.js
        if (typeof UnicornModule === 'undefined') {
            throw new Error('UnicornModule not found. Make sure unicorn2.js is loaded first.');
        }

        Module = await UnicornModule({
            // Hook callbacks from C trampolines
            _codeHookCB: function(slot, addr, size) {
                const cb = hookCallbacks[slot];
                if (cb) cb(addr >>> 0, size);
            },
            _memHookCB: function(slot, type, addr, size, value) {
                const cb = hookCallbacks[slot];
                if (cb) return cb(type, addr >>> 0, size, value) ? 1 : 0;
                return 0;
            },
            _insnInvalidCB: function(slot) {
                const cb = hookCallbacks[slot];
                if (cb) return cb() ? 1 : 0;
                return 0;
            },
            _intrHookCB: function(slot, intno) {
                const cb = hookCallbacks[slot];
                if (cb) cb(intno);
            }
        });

        moduleReady = true;
        console.log('[UC2] Unicorn2 WASM module ready!');
    }

    // Create the global `uc` compatibility object
    window.uc = {
        // Architecture & mode
        ARCH_ARM: UC_ARCH_ARM,
        MODE_ARM: UC_MODE_ARM,
        MODE_THUMB: UC_MODE_THUMB,

        // Protection
        PROT_ALL: UC_PROT_ALL,

        // Errors
        ERR_OK: UC_ERR_OK,

        // Hook types
        HOOK_CODE: UC_HOOK_CODE,
        HOOK_MEM_READ_UNMAPPED: UC_HOOK_MEM_READ_UNMAPPED,
        HOOK_MEM_WRITE_UNMAPPED: UC_HOOK_MEM_WRITE_UNMAPPED,
        HOOK_MEM_FETCH_UNMAPPED: UC_HOOK_MEM_FETCH_UNMAPPED,
        HOOK_INSN_INVALID: UC_HOOK_INSN_INVALID,

        // ARM registers
        ARM_REG_R0: UC_ARM_REG_R0,
        ARM_REG_R1: UC_ARM_REG_R1,
        ARM_REG_R2: UC_ARM_REG_R2,
        ARM_REG_R3: UC_ARM_REG_R3,
        ARM_REG_SP: UC_ARM_REG_SP,
        ARM_REG_LR: UC_ARM_REG_LR,
        ARM_REG_PC: UC_ARM_REG_PC,
        ARM_REG_CPSR: UC_ARM_REG_CPSR,
        ARM_REG_FPEXC: UC_ARM_REG_FPEXC,
        ARM_REG_FPSCR: UC_ARM_REG_FPSCR,

        // Constructor - will be set after init
        Unicorn: null,

        // Init function (must be called before creating engines)
        init: initUnicorn2,

        // Module reference (set after init)
        _module: null
    };

    // Auto-init: start loading the WASM module immediately
    // Expose promise so boot() can await it
    uc._readyPromise = initUnicorn2().then(function() {
        uc.Unicorn = UnicornWrapper;
        uc._module = Module;
        // Also expose as MUnicorn for memory stats
        window.MUnicorn = Module;
        console.log('[UC2] Global uc object ready with Unicorn2 VFP support!');
    }).catch(function(err) {
        console.error('[UC2] Failed to initialize:', err);
    });

})();
