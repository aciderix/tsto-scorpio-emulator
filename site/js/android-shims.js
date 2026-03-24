/**
 * TSTO Web Emulator — Android Shims v2.0
 * JavaScript implementations for native Android/Linux functions
 *
 * v2.0: REAL memcpy/strlen/memset that operate on Unicorn emulator memory
 *       Better android logging with tag/message extraction
 *       Proper __aeabi_ calling conventions
 * v2.1: VFS-backed file I/O (fopen/fread/fclose/fseek/ftell/fgets)
 *       ARM code can now load shader files from the virtual filesystem
 */
const AndroidShims = {
    // Heap management
    _heapPtr: 0xD0100000,
    _heapBase: 0xD0000000,
    _heapSize: 64 * 1024 * 1024,

    // String storage for JNI/libc
    _strings: new Map(),
    _nextStringAddr: 0xC0080000,

    // v2.1: VFS reference (set by engine)
    vfs: null,

    init(engine) {
        this.engine = engine;
        this.vfs = engine.vfs || null;
        Logger.info('Android shims v2.1 initialized (real memcpy/strlen + VFS file I/O)');
    },

    malloc(size) {
        var aligned = (size + 7) & ~7;
        var ptr = this._heapPtr;
        this._heapPtr += aligned;
        if (this._heapPtr >= this._heapBase + this._heapSize) {
            Logger.error('Heap exhausted!');
            return 0;
        }
        return ptr;
    },

    free(ptr) { /* no-op */ },

    calloc(count, size) {
        var total = count * size;
        var ptr = this.malloc(total);
        // Zero the memory
        if (ptr && total > 0 && total < 1048576 && this.engine && this.engine.emu) {
            try {
                var zeros = new Array(Math.min(total, 4096)).fill(0);
                this.engine.emu.mem_write(ptr, zeros);
            } catch(e) {}
        }
        return ptr;
    },

    realloc(ptr, size) {
        return this.malloc(size);
    },

    storeString(str) {
        var addr = this._nextStringAddr;
        this._strings.set(addr, str);
        // Write the actual bytes to Unicorn memory so ARM code can read them
        if (this.engine && this.engine.emu) {
            var bytes = [];
            for (var i = 0; i < str.length; i++) {
                bytes.push(str.charCodeAt(i) & 0xFF);
            }
            bytes.push(0); // null terminator
            try {
                this.engine.emu.mem_write(addr, bytes);
            } catch(e) {
                Logger.warn('[storeString] Failed to write "' + str.substring(0, 40) + '" at 0x' + addr.toString(16));
            }
        }
        this._nextStringAddr += str.length + 16;
        return addr;
    },

    /**
     * Read a C string from emulator memory
     */
    _readCString(emu, addr, maxLen) {
        maxLen = maxLen || 512;
        if (!addr || addr === 0) return '';
        try {
            var bytes = emu.mem_read(addr, maxLen);
            var len = 0;
            while (len < bytes.length && bytes[len] !== 0) len++;
            var arr = [];
            for (var i = 0; i < len; i++) arr.push(bytes[i]);
            return String.fromCharCode.apply(null, arr);
        } catch(e) {
            // Log failures for addresses that look like they should be readable
            if (addr >= 0x10000000) {
                Logger.warn('[_readCString] mem_read failed at 0x' + (addr>>>0).toString(16));
            }
            return '';
        }
    },

    /**
     * Convert IEEE 754 bits to float
     */
    _bitsToFloat(intVal) {
        var buf = new ArrayBuffer(4);
        new Uint32Array(buf)[0] = intVal >>> 0;
        return new Float32Array(buf)[0];
    },

    /**
     * Convert float to IEEE 754 bits
     */
    _floatToBits(f) {
        var buf = new ArrayBuffer(4);
        new Float32Array(buf)[0] = f;
        return new Uint32Array(buf)[0];
    },

    /**
     * Read a 32-bit unsigned value from emulator memory
     */
    _readU32(emu, addr) {
        try {
            var bytes = emu.mem_read(addr, 4);
            return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
        } catch(e) { return 0; }
    },

    /**
     * Read stack arguments beyond R0-R3 (ARM calling convention)
     * index=0 → [SP+0], index=1 → [SP+4], etc.
     */
    _readStackArgs(emu, count) {
        var sp = 0;
        try {
            var spBytes = emu.reg_read(13, 4); // ARM_REG_SP = 13
            sp = (spBytes[0] | (spBytes[1] << 8) | (spBytes[2] << 16) | (spBytes[3] << 24)) >>> 0;
        } catch(e) { return []; }
        var result = [];
        for (var i = 0; i < count; i++) {
            result.push(this._readU32(emu, sp + i * 4));
        }
        return result;
    },

    /**
     * Process a printf-style format string with arguments.
     * fmtStr: the format string
     * getArg: function(index) that returns the next argument value (uint32)
     * emu: emulator instance for reading strings from memory
     */
    _formatString(emu, fmtStr, getArg) {
        var result = '';
        var argIdx = 0;
        var i = 0;
        while (i < fmtStr.length) {
            if (fmtStr[i] !== '%') {
                result += fmtStr[i];
                i++;
                continue;
            }
            i++; // skip %
            if (i >= fmtStr.length) break;

            // Parse flags
            var flags = '';
            while (i < fmtStr.length && '-+ #0'.indexOf(fmtStr[i]) >= 0) {
                flags += fmtStr[i];
                i++;
            }
            // Parse width
            var width = '';
            if (fmtStr[i] === '*') {
                width = getArg(argIdx++) >>> 0;
                i++;
            } else {
                while (i < fmtStr.length && fmtStr[i] >= '0' && fmtStr[i] <= '9') {
                    width += fmtStr[i];
                    i++;
                }
            }
            // Parse precision
            var precision = -1;
            if (i < fmtStr.length && fmtStr[i] === '.') {
                i++;
                var precStr = '';
                if (fmtStr[i] === '*') {
                    precision = getArg(argIdx++) >>> 0;
                    i++;
                } else {
                    while (i < fmtStr.length && fmtStr[i] >= '0' && fmtStr[i] <= '9') {
                        precStr += fmtStr[i];
                        i++;
                    }
                    precision = precStr ? parseInt(precStr) : 0;
                }
            }
            // Parse length modifier
            var lengthMod = '';
            if (i < fmtStr.length && (fmtStr[i] === 'l' || fmtStr[i] === 'h' || fmtStr[i] === 'z' || fmtStr[i] === 'j' || fmtStr[i] === 't')) {
                lengthMod += fmtStr[i];
                i++;
                if (i < fmtStr.length && (fmtStr[i] === 'l' || fmtStr[i] === 'h')) {
                    lengthMod += fmtStr[i];
                    i++;
                }
            }
            if (i >= fmtStr.length) break;

            var spec = fmtStr[i];
            i++;
            var val;
            switch (spec) {
                case '%':
                    result += '%';
                    break;
                case 's':
                    val = getArg(argIdx++);
                    if (val) {
                        result += this._readCString(emu, val);
                    } else {
                        result += '(null)';
                    }
                    break;
                case 'd': case 'i':
                    val = getArg(argIdx++);
                    // Treat as signed 32-bit
                    val = val | 0;
                    result += val.toString();
                    break;
                case 'u':
                    val = getArg(argIdx++);
                    result += (val >>> 0).toString();
                    break;
                case 'x':
                    val = getArg(argIdx++);
                    result += (val >>> 0).toString(16);
                    break;
                case 'X':
                    val = getArg(argIdx++);
                    result += (val >>> 0).toString(16).toUpperCase();
                    break;
                case 'p':
                    val = getArg(argIdx++);
                    result += '0x' + (val >>> 0).toString(16);
                    break;
                case 'c':
                    val = getArg(argIdx++);
                    result += String.fromCharCode(val & 0xFF);
                    break;
                case 'f': case 'F':
                    val = getArg(argIdx++);
                    var f = this._bitsToFloat(val);
                    result += (precision >= 0) ? f.toFixed(precision) : f.toFixed(6);
                    break;
                case 'e': case 'E':
                    val = getArg(argIdx++);
                    var fv = this._bitsToFloat(val);
                    result += (precision >= 0) ? fv.toExponential(precision) : fv.toExponential(6);
                    break;
                case 'g': case 'G':
                    val = getArg(argIdx++);
                    result += this._bitsToFloat(val).toString();
                    break;
                case 'n':
                    // %n - store number of chars written (skip the arg)
                    argIdx++;
                    break;
                default:
                    // Unknown specifier — output literal
                    result += '%' + spec;
                    argIdx++; // consume an arg to stay in sync
                    break;
            }
        }
        return result;
    },

    /**
     * Write a string to emulator memory at dst, return length written
     */
    _writeStringToMem(emu, dst, str, maxLen) {
        if (!dst) return 0;
        var s = (maxLen !== undefined && maxLen > 0) ? str.substring(0, maxLen - 1) : str;
        try {
            var bytes = [];
            for (var i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i) & 0xFF);
            bytes.push(0);
            emu.mem_write(dst, bytes);
        } catch(e) {}
        return s.length;
    },

    /**
     * Get data symbols that need memory allocation (not function stubs)
     * These are global variables referenced by the ARM code
     * Returns {name: {size: bytes, data: [byte array]}}
     */
    getDataSymbols() {
        var symbols = {};

        // __stack_chk_guard: 4-byte canary value (any non-zero constant works)
        symbols['__stack_chk_guard'] = { size: 4, data: [0x42, 0x13, 0x37, 0xDE] };

        // timezone: long (4 bytes), UTC offset in seconds (0 = UTC)
        symbols['timezone'] = { size: 4, data: [0, 0, 0, 0] };

        // __sF: array of 3 FILE structures (stdin, stdout, stderr)
        // Each FILE struct in bionic is ~84 bytes, allocate 256 bytes total
        // Just zero-fill — the important thing is the pointer is valid
        var sfData = new Array(256).fill(0);
        symbols['__sF'] = { size: 256, data: sfData };

        // _ctype_: 256+1 byte character classification table
        // Each byte is a bitmask: 1=upper, 2=lower, 4=digit, 8=space, 16=punct, 32=ctrl, 64=hex, 128=blank
        var ctype = new Array(257).fill(0);
        // Control chars 0-31
        for (var i = 0; i <= 31; i++) ctype[i+1] = 32; // ctrl
        ctype[9+1] = 8|128; // tab = space|blank
        ctype[10+1] = 8; // newline = space
        ctype[11+1] = 8; // vtab = space
        ctype[12+1] = 8; // formfeed = space
        ctype[13+1] = 8; // CR = space
        ctype[32+1] = 8|128; // space = space|blank
        // Uppercase A-Z
        for (var i = 65; i <= 90; i++) ctype[i+1] = 1;
        // Lowercase a-z
        for (var i = 97; i <= 122; i++) ctype[i+1] = 2;
        // Digits 0-9
        for (var i = 48; i <= 57; i++) ctype[i+1] = 4;
        // Hex digits A-F
        for (var i = 65; i <= 70; i++) ctype[i+1] |= 64;
        // Hex digits a-f
        for (var i = 97; i <= 102; i++) ctype[i+1] |= 64;
        // Punctuation (basic set)
        var punct = [33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,58,59,60,61,62,63,64,91,92,93,94,95,96,123,124,125,126];
        for (var p of punct) ctype[p+1] = 16;
        ctype[127+1] = 32; // DEL = ctrl
        symbols['_ctype_'] = { size: 257, data: ctype };

        // _ZSt7nothrow: std::nothrow constant (1 byte, value 0)
        symbols['_ZSt7nothrow'] = { size: 1, data: [0] };

        // C++ RTTI typeinfo objects — allocate minimal valid typeinfo structs
        // Each typeinfo needs: vtable ptr (4 bytes) + name ptr (4 bytes) = 8 bytes
        // We just need them to be non-null and at valid addresses
        var rttiNames = [
            '_ZTIb', '_ZTIc', '_ZTId', '_ZTIf', '_ZTIh', '_ZTIi', '_ZTIj', '_ZTIx', '_ZTIy',
            '_ZTISt12length_error', '_ZTISt12out_of_range',
            '_ZTINSt6__ndk112bad_weak_ptrE', '_ZTINSt6__ndk111regex_errorE',
        ];
        for (var name of rttiNames) {
            symbols[name] = { size: 8, data: [0, 0, 0, 0, 0, 0, 0, 0] };
        }

        // C++ vtables — need at least some valid function pointers
        // Allocate 64 bytes each (enough for a small vtable)
        var vtableNames = [
            '_ZTVSt9exception', '_ZTVSt12length_error', '_ZTVSt12out_of_range',
            '_ZTVNSt6__ndk18ios_baseE', '_ZTVNSt6__ndk112bad_weak_ptrE',
        ];
        for (var name of vtableNames) {
            symbols[name] = { size: 64, data: new Array(64).fill(0) };
        }

        // C++ locale/facet id objects — need to be at valid addresses
        var facetIds = [
            '_ZNSt6__ndk15ctypeIcE2idE',
            '_ZNSt6__ndk17codecvtIcc9mbstate_tE2idE',
            '_ZNSt6__ndk17collateIcE2idE',
            '_ZNSt6__ndk17num_putIcNS_19ostreambuf_iteratorIcNS_11char_traitsIcEEEEE2idE',
            '_ZNSt6__ndk18time_getIcNS_19istreambuf_iteratorIcNS_11char_traitsIcEEEEE2idE',
        ];
        for (var name of facetIds) {
            symbols[name] = { size: 8, data: [0, 0, 0, 0, 0, 0, 0, 0] };
        }

        return symbols;
    },

    getShims() {
        var self = this;
        return {
            // ============================================
            // MEMORY — Real implementations using Unicorn
            // ============================================
            'malloc':   function(emu, args) { return self.malloc(args[0]); },
            'calloc':   function(emu, args) { return self.calloc(args[0], args[1]); },
            'realloc':  function(emu, args) { return self.realloc(args[0], args[1]); },
            'free':     function(emu, args) { self.free(args[0]); return 0; },

            // ---- memcpy: REAL copy through Unicorn memory ----
            'memcpy': function(emu, args) {
                var dst = args[0], src = args[1], n = args[2];
                if (!n || !dst || !src || n > 4194304) return dst;
                try {
                    var data = emu.mem_read(src, n);
                    emu.mem_write(dst, Array.from(data));
                } catch(e) {}
                return dst;
            },
            'memmove': function(emu, args) {
                var dst = args[0], src = args[1], n = args[2];
                if (!n || !dst || !src || n > 4194304) return dst;
                try {
                    var data = emu.mem_read(src, n);
                    emu.mem_write(dst, Array.from(data));
                } catch(e) {}
                return dst;
            },
            'memset': function(emu, args) {
                var dst = args[0], val = args[1] & 0xFF, n = args[2];
                if (!n || !dst || n > 4194304) return dst;
                try {
                    var data = new Array(n);
                    for (var i = 0; i < n; i++) data[i] = val;
                    emu.mem_write(dst, data);
                } catch(e) {}
                return dst;
            },

            // ---- __aeabi variants (ARM EABI calling convention) ----
            '__aeabi_memcpy': function(emu, args) {
                // __aeabi_memcpy(dst, src, n) — same as memcpy
                var dst = args[0], src = args[1], n = args[2];
                if (!n || !dst || !src || n > 4194304) return dst;
                try {
                    var data = emu.mem_read(src, n);
                    emu.mem_write(dst, Array.from(data));
                } catch(e) {}
                return dst;
            },
            '__aeabi_memcpy4': function(emu, args) {
                var dst = args[0], src = args[1], n = args[2];
                if (!n || !dst || !src || n > 4194304) return dst;
                try {
                    var data = emu.mem_read(src, n);
                    emu.mem_write(dst, Array.from(data));
                } catch(e) {}
                return dst;
            },
            '__aeabi_memcpy8': function(emu, args) {
                var dst = args[0], src = args[1], n = args[2];
                if (!n || !dst || !src || n > 4194304) return dst;
                try {
                    var data = emu.mem_read(src, n);
                    emu.mem_write(dst, Array.from(data));
                } catch(e) {}
                return dst;
            },
            '__aeabi_memmove': function(emu, args) {
                var dst = args[0], src = args[1], n = args[2];
                if (!n || !dst || !src || n > 4194304) return dst;
                try {
                    var data = emu.mem_read(src, n);
                    emu.mem_write(dst, Array.from(data));
                } catch(e) {}
                return dst;
            },
            '__aeabi_memmove4': function(emu, args) {
                var dst = args[0], src = args[1], n = args[2];
                if (!n || !dst || !src || n > 4194304) return dst;
                try {
                    var data = emu.mem_read(src, n);
                    emu.mem_write(dst, Array.from(data));
                } catch(e) {}
                return dst;
            },
            // __aeabi_memset(dst, SIZE, VALUE) — note: reversed from standard memset!
            '__aeabi_memset': function(emu, args) {
                var dst = args[0], n = args[1], val = args[2] & 0xFF;
                if (!n || !dst || n > 4194304) return dst;
                try {
                    var data = new Array(n);
                    for (var i = 0; i < n; i++) data[i] = val;
                    emu.mem_write(dst, data);
                } catch(e) {}
                return dst;
            },
            '__aeabi_memset8': function(emu, args) {
                var dst = args[0], n = args[1], val = args[2] & 0xFF;
                if (!n || !dst || n > 4194304) return dst;
                try {
                    var data = new Array(n);
                    for (var i = 0; i < n; i++) data[i] = val;
                    emu.mem_write(dst, data);
                } catch(e) {}
                return dst;
            },
            // __aeabi_memclr(dst, n) — memset with 0
            '__aeabi_memclr': function(emu, args) {
                var dst = args[0], n = args[1];
                if (!n || !dst || n > 4194304) return dst;
                try {
                    var data = new Array(n);
                    for (var i = 0; i < n; i++) data[i] = 0;
                    emu.mem_write(dst, data);
                } catch(e) {}
                return dst;
            },
            '__aeabi_memclr4': function(emu, args) {
                var dst = args[0], n = args[1];
                if (!n || !dst || n > 4194304) return dst;
                try {
                    var data = new Array(n);
                    for (var i = 0; i < n; i++) data[i] = 0;
                    emu.mem_write(dst, data);
                } catch(e) {}
                return dst;
            },
            '__aeabi_memclr8': function(emu, args) {
                var dst = args[0], n = args[1];
                if (!n || !dst || n > 4194304) return dst;
                try {
                    var data = new Array(n);
                    for (var i = 0; i < n; i++) data[i] = 0;
                    emu.mem_write(dst, data);
                } catch(e) {}
                return dst;
            },

            // ============================================
            // STRING — Real implementations reading emu memory
            // ============================================
            'strlen': function(emu, args) {
                var ptr = args[0];
                if (!ptr) return 0;
                try {
                    var len = 0;
                    var CHUNK = 128;
                    while (len < 65536) {
                        var bytes = emu.mem_read(ptr + len, CHUNK);
                        for (var i = 0; i < bytes.length; i++) {
                            if (bytes[i] === 0) return len + i;
                        }
                        len += bytes.length;
                    }
                    return len;
                } catch(e) { return 0; }
            },
            'strcmp': function(emu, args) {
                var s1 = self._readCString(emu, args[0]);
                var s2 = self._readCString(emu, args[1]);
                if (s1 < s2) return -1;
                if (s1 > s2) return 1;
                return 0;
            },
            'strncmp': function(emu, args) {
                var s1 = self._readCString(emu, args[0], args[2]);
                var s2 = self._readCString(emu, args[1], args[2]);
                var n = args[2] || 0;
                s1 = s1.substring(0, n);
                s2 = s2.substring(0, n);
                if (s1 < s2) return -1;
                if (s1 > s2) return 1;
                return 0;
            },
            'strcpy': function(emu, args) {
                var dst = args[0], src = args[1];
                if (!dst || !src) return dst;
                try {
                    var str = self._readCString(emu, src);
                    var bytes = [];
                    for (var i = 0; i < str.length; i++) bytes.push(str.charCodeAt(i) & 0xFF);
                    bytes.push(0);
                    emu.mem_write(dst, bytes);
                } catch(e) {}
                return dst;
            },
            'strncpy': function(emu, args) {
                var dst = args[0], src = args[1], n = args[2];
                if (!dst || !src || !n) return dst;
                try {
                    var str = self._readCString(emu, src, n);
                    var bytes = [];
                    for (var i = 0; i < Math.min(str.length, n); i++) bytes.push(str.charCodeAt(i) & 0xFF);
                    while (bytes.length < n) bytes.push(0);
                    emu.mem_write(dst, bytes);
                } catch(e) {}
                return dst;
            },
            'strdup': function(emu, args) {
                var str = self._readCString(emu, args[0]);
                var ptr = self.malloc(str.length + 1);
                if (ptr) {
                    try {
                        var bytes = [];
                        for (var i = 0; i < str.length; i++) bytes.push(str.charCodeAt(i) & 0xFF);
                        bytes.push(0);
                        emu.mem_write(ptr, bytes);
                    } catch(e) {}
                }
                return ptr;
            },
            'strcat': function(emu, args) {
                var dst = args[0], src = args[1];
                if (!dst || !src) return dst;
                try {
                    var dstStr = self._readCString(emu, dst);
                    var srcStr = self._readCString(emu, src);
                    var combined = dstStr + srcStr;
                    var bytes = [];
                    for (var i = 0; i < combined.length; i++) bytes.push(combined.charCodeAt(i) & 0xFF);
                    bytes.push(0);
                    emu.mem_write(dst, bytes);
                } catch(e) {}
                return dst;
            },
            'strchr': function(emu, args) {
                var str = self._readCString(emu, args[0]);
                var ch = args[1] & 0xFF;
                var idx = str.indexOf(String.fromCharCode(ch));
                return idx >= 0 ? args[0] + idx : 0;
            },
            'strrchr': function(emu, args) {
                var str = self._readCString(emu, args[0]);
                var ch = args[1] & 0xFF;
                var idx = str.lastIndexOf(String.fromCharCode(ch));
                return idx >= 0 ? args[0] + idx : 0;
            },
            'strstr': function(emu, args) {
                var haystack = self._readCString(emu, args[0]);
                var needle = self._readCString(emu, args[1]);
                var idx = haystack.indexOf(needle);
                return idx >= 0 ? args[0] + idx : 0;
            },
            'memcmp': function(emu, args) {
                var p1 = args[0], p2 = args[1], n = args[2];
                if (!n || !p1 || !p2) return 0;
                try {
                    var b1 = emu.mem_read(p1, Math.min(n, 4096));
                    var b2 = emu.mem_read(p2, Math.min(n, 4096));
                    for (var i = 0; i < Math.min(b1.length, b2.length); i++) {
                        if (b1[i] !== b2[i]) return b1[i] - b2[i];
                    }
                    return 0;
                } catch(e) { return 0; }
            },
            'memchr': function(emu, args) {
                var ptr = args[0], val = args[1] & 0xFF, n = args[2];
                if (!ptr || !n) return 0;
                try {
                    var bytes = emu.mem_read(ptr, Math.min(n, 4096));
                    for (var i = 0; i < bytes.length; i++) {
                        if (bytes[i] === val) return ptr + i;
                    }
                    return 0;
                } catch(e) { return 0; }
            },

            // ============================================
            // MATH — IEEE 754 aware
            // ============================================
            'floorf': function(emu, args) { return self._floatToBits(Math.floor(self._bitsToFloat(args[0]))); },
            'ceilf':  function(emu, args) { return self._floatToBits(Math.ceil(self._bitsToFloat(args[0]))); },
            'sinf':   function(emu, args) { return self._floatToBits(Math.sin(self._bitsToFloat(args[0]))); },
            'cosf':   function(emu, args) { return self._floatToBits(Math.cos(self._bitsToFloat(args[0]))); },
            'tanf':   function(emu, args) { return self._floatToBits(Math.tan(self._bitsToFloat(args[0]))); },
            'acosf':  function(emu, args) { return self._floatToBits(Math.acos(self._bitsToFloat(args[0]))); },
            'atanf':  function(emu, args) { return self._floatToBits(Math.atan(self._bitsToFloat(args[0]))); },
            'atan2f': function(emu, args) { return self._floatToBits(Math.atan2(self._bitsToFloat(args[0]), self._bitsToFloat(args[1]))); },
            'sqrtf':  function(emu, args) { return self._floatToBits(Math.sqrt(self._bitsToFloat(args[0]))); },
            'powf':   function(emu, args) { return self._floatToBits(Math.pow(self._bitsToFloat(args[0]), self._bitsToFloat(args[1]))); },
            'fmodf':  function(emu, args) {
                var a = self._bitsToFloat(args[0]), b = self._bitsToFloat(args[1]);
                return self._floatToBits(a - Math.trunc(a / b) * b);
            },
            'fmaxf':  function(emu, args) { return self._floatToBits(Math.max(self._bitsToFloat(args[0]), self._bitsToFloat(args[1]))); },
            'fminf':  function(emu, args) { return self._floatToBits(Math.min(self._bitsToFloat(args[0]), self._bitsToFloat(args[1]))); },
            'roundf': function(emu, args) { return self._floatToBits(Math.round(self._bitsToFloat(args[0]))); },
            'lroundf': function(emu, args) { return Math.round(self._bitsToFloat(args[0])); },
            'modff':  function(emu, args) {
                var f = self._bitsToFloat(args[0]);
                var ipart = Math.trunc(f);
                if (args[1]) {
                    try {
                        var ibuf = new ArrayBuffer(4);
                        new Float32Array(ibuf)[0] = ipart;
                        var ibytes = new Uint8Array(ibuf);
                        emu.mem_write(args[1], Array.from(ibytes));
                    } catch(e) {}
                }
                return self._floatToBits(f - ipart);
            },
            'sincosf': function(emu, args) {
                var angle = self._bitsToFloat(args[0]);
                if (args[1]) {
                    try {
                        var sbuf = new ArrayBuffer(4);
                        new Float32Array(sbuf)[0] = Math.sin(angle);
                        emu.mem_write(args[1], Array.from(new Uint8Array(sbuf)));
                    } catch(e) {}
                }
                if (args[2]) {
                    try {
                        var cbuf = new ArrayBuffer(4);
                        new Float32Array(cbuf)[0] = Math.cos(angle);
                        emu.mem_write(args[2], Array.from(new Uint8Array(cbuf)));
                    } catch(e) {}
                }
                return 0;
            },
            'fabsf':  function(emu, args) { return self._floatToBits(Math.abs(self._bitsToFloat(args[0]))); },
            'expf':   function(emu, args) { return self._floatToBits(Math.exp(self._bitsToFloat(args[0]))); },
            'logf':   function(emu, args) { return self._floatToBits(Math.log(self._bitsToFloat(args[0]))); },
            'log10f': function(emu, args) { return self._floatToBits(Math.log10(self._bitsToFloat(args[0]))); },

            // Double-precision (args passed as 2 registers in ARM: lo in args[0], hi in args[1])
            'floor':  function(emu, args) { return 0; },
            'ceil':   function(emu, args) { return 0; },
            'round':  function(emu, args) { return 0; },
            'trunc':  function(emu, args) { return 0; },
            'pow':    function(emu, args) { return 0; },
            'exp':    function(emu, args) { return 0; },
            'log':    function(emu, args) { return 0; },
            'log10':  function(emu, args) { return 0; },
            'fmod':   function(emu, args) { return 0; },
            'fabs':   function(emu, args) { return args[0]; },

            // ============================================
            // I/O
            // ============================================
            'printf':   function(emu, args) {
                var fmt = self._readCString(emu, args[0]);
                Logger.info('[printf] ' + fmt);
                return fmt.length;
            },
            'fprintf':  function(emu, args) { return 0; },
            'sprintf':  function(emu, args) {
                // sprintf(dst, fmt, ...) → R0=dst, R1=fmt, R2=arg1, R3=arg2, stack for arg3+
                var dst = args[0], fmt = self._readCString(emu, args[1]);
                if (!fmt) return 0;
                var regArgs = [args[2], args[3]]; // R2, R3
                var stackArgs = self._readStackArgs(emu, 8);
                var allArgs = regArgs.concat(stackArgs);
                var result = self._formatString(emu, fmt, function(idx) { return allArgs[idx] || 0; });
                self._writeStringToMem(emu, dst, result);
                return result.length;
            },
            'snprintf': function(emu, args) {
                // snprintf(dst, n, fmt, ...) → R0=dst, R1=n, R2=fmt, R3=arg1, stack for arg2+
                var dst = args[0], n = args[1], fmt = self._readCString(emu, args[2]);
                if (!fmt || !n) return 0;
                var regArgs = [args[3]]; // R3
                var stackArgs = self._readStackArgs(emu, 8);
                var allArgs = regArgs.concat(stackArgs);
                var result = self._formatString(emu, fmt, function(idx) { return allArgs[idx] || 0; });
                self._writeStringToMem(emu, dst, result, n);
                return result.length;
            },
            'vsnprintf': function(emu, args) {
                // vsnprintf(dst, n, fmt, va_list) → R0=dst, R1=n, R2=fmt, R3=va_list ptr
                var dst = args[0], n = args[1], fmt = self._readCString(emu, args[2]);
                var vaPtr = args[3];
                if (!fmt || !n) return 0;
                var result = self._formatString(emu, fmt, function(idx) {
                    return self._readU32(emu, vaPtr + idx * 4);
                });
                self._writeStringToMem(emu, dst, result, n);
                return result.length;
            },
            '__vsnprintf_chk': function(emu, args) {
                // __vsnprintf_chk(dst, maxlen, flag, real_maxlen, fmt_on_stack, va_list_on_stack)
                // R0=dst, R1=maxlen, R2=flag, R3=real_maxlen
                // fmt at [SP+0], va_list at [SP+4]
                var dst = args[0], n = args[1];
                var stackArgs = self._readStackArgs(emu, 2);
                var fmt = self._readCString(emu, stackArgs[0]);
                var vaPtr = stackArgs[1];
                if (!fmt || !n) return 0;
                var result = self._formatString(emu, fmt, function(idx) {
                    return self._readU32(emu, vaPtr + idx * 4);
                });
                self._writeStringToMem(emu, dst, result, n);
                return result.length;
            },

            // ============================================
            // FILE I/O — v2.1: VFS-backed implementations
            // ============================================
            'fopen':   function(emu, args) {
                var path = self._readCString(emu, args[0]);
                var mode = self._readCString(emu, args[1]);

                // Debug: log the address and result for tracing string bridge issues
                if (!path) {
                    Logger.warn('[fopen] EMPTY path from addr 0x' + (args[0]>>>0).toString(16) + ' mode=' + mode);
                }

                // Try VFS first
                if (self.vfs) {
                    var fd = self.vfs.fopen(path, mode);
                    if (fd) return fd; // VFS has this file
                }

                // Not in VFS — log and return NULL
                Logger.info('[fopen] MISS: ' + path + ' mode=' + mode);
                return 0;
            },
            'fclose':  function(emu, args) {
                var fd = args[0];
                if (self.vfs && fd >= 100) {
                    return self.vfs.fclose(fd);
                }
                return 0;
            },
            'fread':   function(emu, args) {
                var destPtr = args[0];
                var itemSize = args[1];
                var itemCount = args[2];
                var fd = args[3];
                
                if (self.vfs && fd >= 100) {
                    return self.vfs.fread(fd, destPtr, itemSize, itemCount, emu);
                }
                return 0;
            },
            'fwrite':  function(emu, args) { return args[2]; }, // pretend success
            'fgets':   function(emu, args) {
                var destPtr = args[0];
                var maxLen = args[1];
                var fd = args[2];
                
                if (self.vfs && fd >= 100) {
                    return self.vfs.fgets(fd, destPtr, maxLen, emu);
                }
                return 0;
            },
            'fseek':   function(emu, args) {
                var fd = args[0];
                var offset = args[1] | 0; // signed
                var whence = args[2];
                
                if (self.vfs && fd >= 100) {
                    return self.vfs.fseek(fd, offset, whence);
                }
                return -1;
            },
            'ftell':   function(emu, args) {
                var fd = args[0];
                if (self.vfs && fd >= 100) {
                    return self.vfs.ftell(fd);
                }
                return -1;
            },
            'feof':    function(emu, args) {
                var fd = args[0];
                if (self.vfs && fd >= 100) {
                    return self.vfs.feof(fd);
                }
                return 1;
            },
            'ferror':  function(emu, args) { return 0; },
            'fflush':  function(emu, args) { return 0; },
            'open':    function(emu, args) {
                var path = self._readCString(emu, args[0]);
                // For POSIX open(), try VFS too
                if (self.vfs && self.vfs.exists(path)) {
                    var fd = self.vfs.fopen(path, 'r');
                    if (fd) {
                        Logger.info('[open] VFS HIT: ' + path + ' → fd=' + fd);
                        return fd;
                    }
                }
                Logger.info('[open] MISS: ' + path);
                return -1;
            },
            'close':   function(emu, args) {
                var fd = args[0];
                if (self.vfs && fd >= 100) {
                    return self.vfs.fclose(fd);
                }
                return 0;
            },
            'read':    function(emu, args) {
                var fd = args[0];
                var destPtr = args[1];
                var count = args[2];
                
                if (self.vfs && fd >= 100) {
                    return self.vfs.fread(fd, destPtr, 1, count, emu) * 1; // bytes read
                }
                return 0;
            },
            'write':   function(emu, args) { return args[2]; },
            'lseek':   function(emu, args) {
                var fd = args[0];
                var offset = args[1] | 0;
                var whence = args[2];
                
                if (self.vfs && fd >= 100) {
                    self.vfs.fseek(fd, offset, whence);
                    return self.vfs.ftell(fd);
                }
                return -1;
            },
            'stat':    function(emu, args) {
                var path = self._readCString(emu, args[0]);
                if (self.vfs && self.vfs.exists(path)) {
                    // Write a minimal stat struct: set st_size at offset 44
                    var size = self.vfs.fileSize(path);
                    if (args[1] && size >= 0) {
                        try {
                            // Zero the stat struct first (128 bytes)
                            var zeros = new Array(128).fill(0);
                            emu.mem_write(args[1], zeros);
                            // st_mode at offset 8: regular file (S_IFREG = 0100000)
                            var mode = 0x8000 | 0x1B4; // S_IFREG | 0644
                            emu.mem_write(args[1] + 8, [mode & 0xFF, (mode >> 8) & 0xFF, 0, 0]);
                            // st_size at offset 44 (ARM stat64)
                            emu.mem_write(args[1] + 44, [
                                size & 0xFF, (size >> 8) & 0xFF,
                                (size >> 16) & 0xFF, (size >> 24) & 0xFF
                            ]);
                        } catch(e) {}
                    }
                    Logger.info('[stat] VFS HIT: ' + path + ' size=' + size);
                    return 0;
                }
                return -1;
            },
            'fstat':   function(emu, args) {
                // fstat on a VFS fd
                var fd = args[0];
                if (self.vfs && fd >= 100) {
                    var handle = self.vfs._handles.get(fd);
                    if (handle && args[1]) {
                        try {
                            var zeros = new Array(128).fill(0);
                            emu.mem_write(args[1], zeros);
                            var mode = 0x8000 | 0x1B4;
                            emu.mem_write(args[1] + 8, [mode & 0xFF, (mode >> 8) & 0xFF, 0, 0]);
                            emu.mem_write(args[1] + 44, [
                                handle.size & 0xFF, (handle.size >> 8) & 0xFF,
                                (handle.size >> 16) & 0xFF, (handle.size >> 24) & 0xFF
                            ]);
                        } catch(e) {}
                        return 0;
                    }
                }
                return -1;
            },
            'access':  function(emu, args) {
                var path = self._readCString(emu, args[0]);
                if (self.vfs && self.vfs.exists(path)) {
                    Logger.info('[access] VFS HIT: ' + path);
                    return 0;
                }
                return -1;
            },
            'mkdir':   function(emu, args) { return 0; },

            // ============================================
            // Conversion
            // ============================================
            'atoi':    function(emu, args) {
                var str = self._readCString(emu, args[0]);
                return parseInt(str, 10) || 0;
            },
            'atol':    function(emu, args) {
                var str = self._readCString(emu, args[0]);
                return parseInt(str, 10) || 0;
            },
            'atoll':   function(emu, args) { return 0; },
            'atof':    function(emu, args) {
                var str = self._readCString(emu, args[0]);
                return self._floatToBits(parseFloat(str) || 0);
            },
            'strtol':  function(emu, args) {
                var str = self._readCString(emu, args[0]);
                return parseInt(str, args[2] || 10) || 0;
            },
            'strtoul': function(emu, args) {
                var str = self._readCString(emu, args[0]);
                return (parseInt(str, args[2] || 10) || 0) >>> 0;
            },
            'strtoll':  function(emu, args) { return 0; },
            'strtoull': function(emu, args) { return 0; },
            'strtod':   function(emu, args) { return 0; },
            'strtof':   function(emu, args) {
                var str = self._readCString(emu, args[0]);
                return self._floatToBits(parseFloat(str) || 0);
            },
            'sscanf':   function(emu, args) { return 0; },

            // ============================================
            // Time
            // ============================================
            'time':          function(emu, args) {
                var t = Math.floor(Date.now() / 1000);
                if (args[0]) {
                    try {
                        var buf = [t & 0xFF, (t >> 8) & 0xFF, (t >> 16) & 0xFF, (t >> 24) & 0xFF];
                        emu.mem_write(args[0], buf);
                    } catch(e) {}
                }
                return t;
            },
            'gettimeofday': function(emu, args) {
                if (args[0]) {
                    try {
                        var now = Date.now();
                        var sec = Math.floor(now / 1000);
                        var usec = (now % 1000) * 1000;
                        var buf = [
                            sec & 0xFF, (sec >> 8) & 0xFF, (sec >> 16) & 0xFF, (sec >> 24) & 0xFF,
                            usec & 0xFF, (usec >> 8) & 0xFF, (usec >> 16) & 0xFF, (usec >> 24) & 0xFF,
                        ];
                        emu.mem_write(args[0], buf);
                    } catch(e) {}
                }
                return 0;
            },
            'clock_gettime': function(emu, args) {
                if (args[1]) {
                    try {
                        var now = performance.now();
                        var sec = Math.floor(now / 1000);
                        var nsec = Math.floor((now % 1000) * 1000000);
                        var buf = [
                            sec & 0xFF, (sec >> 8) & 0xFF, (sec >> 16) & 0xFF, (sec >> 24) & 0xFF,
                            nsec & 0xFF, (nsec >> 8) & 0xFF, (nsec >> 16) & 0xFF, (nsec >> 24) & 0xFF,
                        ];
                        emu.mem_write(args[1], buf);
                    } catch(e) {}
                }
                return 0;
            },
            'localtime':   function(emu, args) { return self.malloc(64); },
            'localtime_r': function(emu, args) { return args[1]; },
            'gmtime':      function(emu, args) { return self.malloc(64); },
            'gmtime_r':    function(emu, args) { return args[1]; },
            'mktime':      function(emu, args) { return Math.floor(Date.now() / 1000); },
            'strftime':    function(emu, args) { return 0; },
            'difftime':    function(emu, args) { return 0; },
            'sleep':       function(emu, args) { return 0; },
            'usleep':      function(emu, args) { return 0; },
            'nanosleep':   function(emu, args) { return 0; },

            // ============================================
            // Threading (no-op stubs)
            // ============================================
            'pthread_mutex_init':    function(emu, args) { return 0; },
            'pthread_mutex_lock':    function(emu, args) { return 0; },
            'pthread_mutex_unlock':  function(emu, args) { return 0; },
            'pthread_mutex_destroy': function(emu, args) { return 0; },
            'pthread_mutex_trylock': function(emu, args) { return 0; },
            'pthread_create': function(emu, args) {
                // args: [thread_ptr, attr, start_routine, arg]
                var threadPtr = args[0], attr = args[1], startRoutine = args[2], threadArg = args[3];
                Logger.warn('[PTHREAD] pthread_create: thread_ptr=0x' + (threadPtr>>>0).toString(16) +
                    ' start_routine=0x' + (startRoutine>>>0).toString(16) +
                    ' arg=0x' + (threadArg>>>0).toString(16));
                // Store thread info for potential later execution
                if (!self._pendingThreads) self._pendingThreads = [];
                self._pendingThreads.push({ func: startRoutine, arg: threadArg });
                // Write a fake thread ID
                if (threadPtr) {
                    try { engine.emu.mem_write(threadPtr, [self._pendingThreads.length, 0, 0, 0]); } catch(e) {}
                }
                return 0;
            },
            'pthread_join':          function(emu, args) { return 0; },
            'pthread_detach':        function(emu, args) { return 0; },
            'pthread_self':          function(emu, args) { return 1; },
            'pthread_exit':          function(emu, args) { return 0; },
            'pthread_once':          function(emu, args) { return 0; },
            'pthread_cond_init':     function(emu, args) { return 0; },
            'pthread_cond_wait': function(emu, args) {
                if (!self._condWaitCount) self._condWaitCount = 0;
                self._condWaitCount++;
                if (self._condWaitCount <= 5 || self._condWaitCount % 10000 === 0) {
                    Logger.warn('[PTHREAD] pthread_cond_wait #' + self._condWaitCount +
                        ' cond=0x' + (args[0]>>>0).toString(16) +
                        ' mutex=0x' + (args[1]>>>0).toString(16));
                }
                return 0;
            },
            'pthread_cond_signal':   function(emu, args) { return 0; },
            'pthread_cond_broadcast':function(emu, args) { return 0; },
            'pthread_cond_destroy':  function(emu, args) { return 0; },
            'pthread_cond_timedwait': function(emu, args) {
                if (!self._condTimedWaitCount) self._condTimedWaitCount = 0;
                self._condTimedWaitCount++;
                if (self._condTimedWaitCount <= 5 || self._condTimedWaitCount % 10000 === 0) {
                    Logger.warn('[PTHREAD] pthread_cond_timedwait #' + self._condTimedWaitCount +
                        ' cond=0x' + (args[0]>>>0).toString(16) +
                        ' mutex=0x' + (args[1]>>>0).toString(16));
                }
                return 0;
            },
            'pthread_attr_init':     function(emu, args) { return 0; },
            'pthread_attr_destroy':  function(emu, args) { return 0; },
            'pthread_attr_setdetachstate':  function(emu, args) { return 0; },
            'pthread_attr_setschedpolicy':  function(emu, args) { return 0; },
            'pthread_attr_setschedparam':   function(emu, args) { return 0; },
            'pthread_mutexattr_init':       function(emu, args) { return 0; },
            'pthread_mutexattr_settype':    function(emu, args) { return 0; },
            'pthread_mutexattr_destroy':    function(emu, args) { return 0; },
            'pthread_kill':          function(emu, args) { return 0; },
            'sched_yield':           function(emu, args) { return 0; },
            'sched_get_priority_min':function(emu, args) { return 0; },

            // ============================================
            // System
            // ============================================
            '__errno':      function(emu, args) { return self.malloc(4); },
            'sysconf':      function(emu, args) { return 4096; },
            'getpagesize':  function(emu, args) { return 4096; },
            'getpid':       function(emu, args) { return 1234; },
            'gettid':       function(emu, args) { return 1234; },
            'getenv':       function(emu, args) {
                var name = self._readCString(emu, args[0]);
                Logger.info('[getenv] ' + name);
                return 0;
            },
            'setenv':       function(emu, args) { return 0; },
            'abort':        function(emu, args) { Logger.error('abort() called!'); return 0; },
            '__stack_chk_fail': function(emu, args) { Logger.warn('Stack canary fail (ignored)'); return 0; },
            '__cxa_finalize':   function(emu, args) { return 0; },
            '__cxa_atexit':     function(emu, args) { return 0; },
            '__cxa_guard_acquire': function(emu, args) { return 1; },
            '__cxa_guard_release': function(emu, args) { return 0; },
            '__cxa_guard_abort':   function(emu, args) { return 0; },
            'mmap':      function(emu, args) { return self.malloc(args[1] || 4096); },
            'munmap':    function(emu, args) { return 0; },
            'mprotect':  function(emu, args) { return 0; },

            // ============================================
            // Android logging (read actual tag + message)
            // ============================================
            '__android_log_vprint': function(emu, args) {
                var tag = self._readCString(emu, args[1]);
                var fmt = self._readCString(emu, args[2]);
                Logger.info('[Android:' + tag + '] ' + fmt);
                return 0;
            },
            '__android_log_write': function(emu, args) {
                var tag = self._readCString(emu, args[1]);
                var msg = self._readCString(emu, args[2]);
                Logger.info('[Android:' + tag + '] ' + msg);
                return 0;
            },
            '__android_log_print': function(emu, args) {
                var tag = self._readCString(emu, args[1]);
                var fmt = self._readCString(emu, args[2]);
                Logger.info('[Android:' + tag + '] ' + fmt);
                return 0;
            },
            'AndroidBitmap_getInfo':     function(emu, args) { return 0; },
            'AndroidBitmap_lockPixels':  function(emu, args) { return 0; },
            'AndroidBitmap_unlockPixels':function(emu, args) { return 0; },

            // dlsym — return 0 (symbol not found)
            'dlsym': function(emu, args) {
                var name = self._readCString(emu, args[1]);
                Logger.info('[dlsym] ' + name);
                return 0;
            },
            'dlopen':  function(emu, args) {
                var path = self._readCString(emu, args[0]);
                Logger.info('[dlopen] ' + path);
                return 1; // fake handle
            },
            'dlclose': function(emu, args) { return 0; },
            'dlerror': function(emu, args) { return 0; },

            // ============================================
            // Random
            // ============================================
            'rand':    function(emu, args) { return Math.floor(Math.random() * 0x7FFFFFFF); },
            'random':  function(emu, args) { return Math.floor(Math.random() * 0x7FFFFFFF); },
            'srand':   function(emu, args) { return 0; },
            'srand48': function(emu, args) { return 0; },
            'drand48': function(emu, args) { return 0; },
            'lrand48': function(emu, args) { return Math.floor(Math.random() * 0x7FFFFFFF); },

            // ============================================
            // C++ new/delete
            // ============================================
            '_Znwj':   function(emu, args) { return self.malloc(args[0] || 16); },
            '_Znaj':   function(emu, args) { return self.malloc(args[0] || 16); },
            '_ZdlPv':  function(emu, args) { self.free(args[0]); return 0; },
            '_ZdaPv':  function(emu, args) { self.free(args[0]); return 0; },

            // ============================================
            // Compression (zlib stubs)
            // ============================================
            'inflate':       function(emu, args) { return 0; },
            'inflateInit2_': function(emu, args) { return 0; },
            'inflateEnd':    function(emu, args) { return 0; },
            'inflateReset':  function(emu, args) { return 0; },
            'inflateInit_':  function(emu, args) { return 0; },
            'deflate':       function(emu, args) { return 0; },
            'deflateInit2_': function(emu, args) { return 0; },
            'deflateEnd':    function(emu, args) { return 0; },
            'deflateReset':  function(emu, args) { return 0; },
            'crc32':         function(emu, args) { return 0; },

            // ============================================
            // OpenAL Audio (no-op)
            // ============================================
            'alGenSources':       function(emu, args) { return 0; },
            'alGenBuffers':       function(emu, args) { return 0; },
            'alDeleteSources':    function(emu, args) { return 0; },
            'alDeleteBuffers':    function(emu, args) { return 0; },
            'alSourcePlay':       function(emu, args) { return 0; },
            'alSourceStop':       function(emu, args) { return 0; },
            'alSourcePause':      function(emu, args) { return 0; },
            'alSourceRewind':     function(emu, args) { return 0; },
            'alSourcef':          function(emu, args) { return 0; },
            'alSourcei':          function(emu, args) { return 0; },
            'alSource3f':         function(emu, args) { return 0; },
            'alGetSourcei':       function(emu, args) { return 0; },
            'alGetSourcef':       function(emu, args) { return 0; },
            'alGetSourcefv':      function(emu, args) { return 0; },
            'alBufferData':       function(emu, args) { return 0; },
            'alSourceQueueBuffers':  function(emu, args) { return 0; },
            'alSourceUnqueueBuffers':function(emu, args) { return 0; },
            'alListenerf':        function(emu, args) { return 0; },
            'alListener3f':       function(emu, args) { return 0; },
            'alListenerfv':       function(emu, args) { return 0; },
            'alGetListener3f':    function(emu, args) { return 0; },
            'alDistanceModel':    function(emu, args) { return 0; },
            'alGetError':         function(emu, args) { return 0; },
            'alGetString':        function(emu, args) { return 0; },
            'alcOpenDevice':      function(emu, args) { return 1; },
            'alcCreateContext':   function(emu, args) { return 1; },
            'alcMakeContextCurrent': function(emu, args) { return 1; },
            'alcDestroyContext':  function(emu, args) { return 0; },
            'alcCloseDevice':    function(emu, args) { return 0; },
            'alcGetCurrentContext': function(emu, args) { return 1; },
            'alcSuspendContext':  function(emu, args) { return 0; },
            'alcProcessContext':  function(emu, args) { return 0; },

            // ============================================
            // Crypto (no-op stubs)
            // ============================================
            'EVP_CIPHER_CTX_new':  function(emu, args) { return self.malloc(256); },
            'EVP_CIPHER_CTX_free': function(emu, args) { return 0; },
            'EVP_aes_256_cbc':     function(emu, args) { return self.malloc(64); },
            'EVP_aes_128_ecb':     function(emu, args) { return self.malloc(64); },
            'EVP_DecryptInit_ex':  function(emu, args) { return 1; },
            'EVP_DecryptUpdate':   function(emu, args) { return 1; },
            'EVP_DecryptFinal_ex': function(emu, args) { return 1; },
            'EVP_EncryptInit_ex':  function(emu, args) { return 1; },
            'EVP_EncryptUpdate':   function(emu, args) { return 1; },
            'EVP_EncryptFinal_ex': function(emu, args) { return 1; },
            'MD5':                 function(emu, args) { return args[2] || self.malloc(16); },
            'SHA1':                function(emu, args) { return args[2] || self.malloc(20); },

            // ============================================
            // Protobuf
            // ============================================
            '_ZN6google8protobuf11MessageLite14ParseFromArrayEPKvi': function(emu, args) { return 1; },
            '_ZNK6google8protobuf11MessageLite17SerializeToStringEPNSt6__ndk112basic_stringIcNS2_11char_traitsIcEENS2_9allocatorIcEEEE': function(emu, args) { return 1; },
            '_ZN6google8protobuf11MessageLite15ParseFromStringERKNSt6__ndk112basic_stringIcNS2_11char_traitsIcEENS2_9allocatorIcEEEE': function(emu, args) { return 1; },
            '_ZN6google8protobuf13SetLogHandlerEPFvNS0_8LogLevelEPKciRKNSt6__ndk112basic_stringIcNS4_11char_traitsIcEENS4_9allocatorIcEEEEE': function(emu, args) { return 0; },

            // ============================================
            // Breakpad crash reporting (no-op)
            // ============================================
            '_ZN15google_breakpad16ExceptionHandlerC1ERKNS_18MinidumpDescriptorEPFbPvEPFbS3_S4_bES4_bi': function(emu, args) { return 0; },

            // ============================================
            // FORTIFIED libc (__*_chk) — Android Bionic uses these
            // These are THE CRITICAL MISSING SHIMS
            // Without them, strlen/memcpy/memmove all return 0!
            // ============================================
            '__strlen_chk': function(emu, args) {
                // __strlen_chk(const char *s, size_t maxlen) - same as strlen
                var ptr = args[0];
                if (!ptr) return 0;
                try {
                    var len = 0;
                    var CHUNK = 128;
                    while (len < 65536) {
                        var bytes = emu.mem_read(ptr + len, CHUNK);
                        for (var i = 0; i < bytes.length; i++) {
                            if (bytes[i] === 0) return len + i;
                        }
                        len += bytes.length;
                    }
                    return len;
                } catch(e) { return 0; }
            },
            '__memcpy_chk': function(emu, args) {
                // __memcpy_chk(dst, src, n, dst_size) - same as memcpy
                var dst = args[0], src = args[1], n = args[2];
                if (!n || !dst || !src || n > 4194304) return dst;
                try {
                    var data = emu.mem_read(src, n);
                    emu.mem_write(dst, Array.from(data));
                } catch(e) {}
                return dst;
            },
            '__memmove_chk': function(emu, args) {
                // __memmove_chk(dst, src, n, dst_size) - same as memmove
                var dst = args[0], src = args[1], n = args[2];
                if (!n || !dst || !src || n > 4194304) return dst;
                try {
                    var data = emu.mem_read(src, n);
                    emu.mem_write(dst, Array.from(data));
                } catch(e) {}
                return dst;
            },
            '__memset_chk': function(emu, args) {
                // __memset_chk(dst, val, n, dst_size) - same as memset
                var dst = args[0], val = args[1] & 0xFF, n = args[2];
                if (!n || !dst || n > 4194304) return dst;
                try {
                    var data = new Array(n);
                    for (var i = 0; i < n; i++) data[i] = val;
                    emu.mem_write(dst, data);
                } catch(e) {}
                return dst;
            },
            '__strcpy_chk': function(emu, args) {
                var dst = args[0], src = args[1];
                if (!dst || !src) return dst;
                try {
                    var str = self._readCString(emu, src);
                    var bytes = [];
                    for (var i = 0; i < str.length; i++) bytes.push(str.charCodeAt(i) & 0xFF);
                    bytes.push(0);
                    emu.mem_write(dst, bytes);
                } catch(e) {}
                return dst;
            },
            '__strncpy_chk': function(emu, args) {
                var dst = args[0], src = args[1], n = args[2];
                if (!dst || !src || !n) return dst;
                try {
                    var str = self._readCString(emu, src, n);
                    var bytes = [];
                    for (var i = 0; i < Math.min(str.length, n); i++) bytes.push(str.charCodeAt(i) & 0xFF);
                    while (bytes.length < n) bytes.push(0);
                    emu.mem_write(dst, bytes);
                } catch(e) {}
                return dst;
            },
            '__strcat_chk': function(emu, args) {
                var dst = args[0], src = args[1];
                if (!dst || !src) return dst;
                try {
                    var dstStr = self._readCString(emu, dst);
                    var srcStr = self._readCString(emu, src);
                    var combined = dstStr + srcStr;
                    var bytes = [];
                    for (var i = 0; i < combined.length; i++) bytes.push(combined.charCodeAt(i) & 0xFF);
                    bytes.push(0);
                    emu.mem_write(dst, bytes);
                } catch(e) {}
                return dst;
            },
            '__strncat_chk': function(emu, args) {
                var dst = args[0], src = args[1], n = args[2];
                if (!dst || !src) return dst;
                try {
                    var dstStr = self._readCString(emu, dst);
                    var srcStr = self._readCString(emu, src, n).substring(0, n);
                    var combined = dstStr + srcStr;
                    var bytes = [];
                    for (var i = 0; i < combined.length; i++) bytes.push(combined.charCodeAt(i) & 0xFF);
                    bytes.push(0);
                    emu.mem_write(dst, bytes);
                } catch(e) {}
                return dst;
            },
            '__sprintf_chk': function(emu, args) {
                // __sprintf_chk(dst, flag, dst_size, fmt, ...) → R0=dst, R1=flag, R2=dst_size, R3=fmt
                // format args start on stack
                var dst = args[0], fmt = self._readCString(emu, args[3]);
                if (!fmt) return 0;
                var stackArgs = self._readStackArgs(emu, 8);
                var result = self._formatString(emu, fmt, function(idx) { return stackArgs[idx] || 0; });
                self._writeStringToMem(emu, dst, result);
                return result.length;
            },
            '__snprintf_chk': function(emu, args) {
                // __snprintf_chk(dst, maxlen, flag, dst_size, fmt, ...)
                // R0=dst, R1=maxlen, R2=flag, R3=dst_size
                // fmt at [SP+0], format args at [SP+4]+
                var dst = args[0], n = args[1];
                var stackArgs = self._readStackArgs(emu, 10);
                var fmt = self._readCString(emu, stackArgs[0]);
                if (!fmt || !n) return 0;
                var fmtArgs = stackArgs.slice(1);
                var result = self._formatString(emu, fmt, function(idx) { return fmtArgs[idx] || 0; });
                self._writeStringToMem(emu, dst, result, n);
                return result.length;
            },

            // ============================================
            // Missing libc functions
            // ============================================
            'fputc': function(emu, args) {
                // fputc(char, FILE*) - just return the char
                return args[0] & 0xFF;
            },
            'fputs': function(emu, args) {
                var str = self._readCString(emu, args[0]);
                return str.length;
            },
            'putchar': function(emu, args) { return args[0] & 0xFF; },
            'puts': function(emu, args) {
                var str = self._readCString(emu, args[0]);
                Logger.info('[puts] ' + str);
                return str.length;
            },
            'longjmp': function(emu, args) {
                Logger.warn('[longjmp] called — cannot implement in emulator');
                return 0;
            },
            'setjmp': function(emu, args) {
                // setjmp returns 0 on first call (save point)
                return 0;
            },
            '_setjmp': function(emu, args) { return 0; },
            'sigsetjmp': function(emu, args) { return 0; },
            'siglongjmp': function(emu, args) { return 0; },
            'getentropy': function(emu, args) {
                // getentropy(buf, buflen) — fill with random bytes
                var buf = args[0], len = args[1];
                if (buf && len > 0 && len <= 256) {
                    try {
                        var bytes = [];
                        for (var i = 0; i < len; i++) bytes.push(Math.floor(Math.random() * 256));
                        emu.mem_write(buf, bytes);
                    } catch(e) {}
                }
                return 0;
            },
            'asprintf': function(emu, args) {
                // asprintf(char **strp, const char *fmt, ...) → R0=strp, R1=fmt, R2=arg1, R3=arg2
                var fmt = self._readCString(emu, args[1]);
                if (!args[0] || !fmt) return -1;
                var regArgs = [args[2], args[3]];
                var stackArgs = self._readStackArgs(emu, 8);
                var allArgs = regArgs.concat(stackArgs);
                var result = self._formatString(emu, fmt, function(idx) { return allArgs[idx] || 0; });
                var ptr = self.malloc(result.length + 1);
                if (ptr) {
                    self._writeStringToMem(emu, ptr, result);
                    try {
                        emu.mem_write(args[0], [
                            ptr & 0xFF, (ptr >> 8) & 0xFF,
                            (ptr >> 16) & 0xFF, (ptr >> 24) & 0xFF
                        ]);
                    } catch(e) {}
                }
                return result.length;
            },
            'vasprintf': function(emu, args) {
                // vasprintf(char **strp, const char *fmt, va_list ap) → R0=strp, R1=fmt, R2=va_list
                var fmt = self._readCString(emu, args[1]);
                var vaPtr = args[2];
                if (!args[0] || !fmt) return -1;
                var result = self._formatString(emu, fmt, function(idx) {
                    return self._readU32(emu, vaPtr + idx * 4);
                });
                var ptr = self.malloc(result.length + 1);
                if (ptr) {
                    self._writeStringToMem(emu, ptr, result);
                    try {
                        emu.mem_write(args[0], [
                            ptr & 0xFF, (ptr >> 8) & 0xFF,
                            (ptr >> 16) & 0xFF, (ptr >> 24) & 0xFF
                        ]);
                    } catch(e) {}
                }
                return result.length;
            },
            'remove': function(emu, args) {
                var path = self._readCString(emu, args[0]);
                Logger.info('[remove] ' + path + ' (no-op)');
                return 0;
            },
            'rename': function(emu, args) {
                var oldp = self._readCString(emu, args[0]);
                var newp = self._readCString(emu, args[1]);
                Logger.info('[rename] ' + oldp + ' → ' + newp + ' (no-op)');
                return 0;
            },
            'qsort': function(emu, args) {
                // qsort is complex — skip for now
                return 0;
            },
            'bsearch': function(emu, args) { return 0; },
            'abs': function(emu, args) {
                var val = args[0] | 0;
                return val < 0 ? -val : val;
            },
            'labs': function(emu, args) {
                var val = args[0] | 0;
                return val < 0 ? -val : val;
            },

            // ============================================
            // C++ Standard Library — destructors & exceptions
            // ============================================
            '_ZNSt9exceptionD2Ev': function(emu, args) { return 0; },
            '_ZNSt12length_errorD1Ev': function(emu, args) { return 0; },
            '_ZNSt12out_of_rangeD1Ev': function(emu, args) { return 0; },
            '_ZNSt6__ndk111regex_errorD1Ev': function(emu, args) { return 0; },
            '_ZNSt6__ndk112bad_weak_ptrD1Ev': function(emu, args) { return 0; },
            '_ZNSt6__ndk18ios_base4initEPv': function(emu, args) { return 0; },
            '_ZNSt6__ndk18ios_base5clearEj': function(emu, args) { return 0; },
            '_ZNKSt6__ndk18ios_base6getlocEv': function(emu, args) { return 0; },
            '_ZNKSt6__ndk16locale9use_facetERNS0_2idE': function(emu, args) { return 0; },
            '_ZNSt6__ndk16localeD1Ev': function(emu, args) { return 0; },
            '_ZNSt6__ndk112__next_primeEj': function(emu, args) {
                // Return next prime after args[0] — used by unordered_map
                var n = args[0];
                if (n < 2) return 2;
                for (var i = n; i < n + 1000; i++) {
                    var isPrime = true;
                    for (var j = 2; j * j <= i; j++) {
                        if (i % j === 0) { isPrime = false; break; }
                    }
                    if (isPrime) return i;
                }
                return n;
            },
            '_ZNSt6__ndk119__shared_weak_count14__release_weakEv': function(emu, args) { return 0; },
            '_ZNSt6__ndk113basic_istreamIcNS_11char_traitsIcEEED2Ev': function(emu, args) { return 0; },
            '_ZNKSt6__ndk112basic_stringIcNS_11char_traitsIcEENS_9allocatorIcEEE7compareEPKc': function(emu, args) {
                // std::string::compare(const char*) - compare this string with C string
                // In libc++, the string object is at args[0] (this pointer)
                // The C string is at args[1]
                // Simplified: return 0 (equal) to avoid crashes
                return 0;
            },
            '__cxa_throw': function(emu, args) {
                Logger.warn('[C++ exception thrown — suppressed]');
                return 0;
            },
            '__cxa_begin_catch': function(emu, args) { return args[0]; },
            '__cxa_end_catch': function(emu, args) { return 0; },
            '__cxa_allocate_exception': function(emu, args) { return self.malloc(args[0] || 64); },
            '__cxa_free_exception': function(emu, args) { return 0; },
            '__gxx_personality_v0': function(emu, args) { return 0; },
            '_Unwind_Resume': function(emu, args) { return 0; },

            // ============================================
            // Misc missing
            // ============================================
            'signal': function(emu, args) { return 0; },
            'raise': function(emu, args) { return 0; },
            'sigaction': function(emu, args) { return 0; },
            'sigemptyset': function(emu, args) { return 0; },
            'sigaddset': function(emu, args) { return 0; },
            'sigfillset': function(emu, args) { return 0; },
            'sigprocmask': function(emu, args) { return 0; },
            'prctl': function(emu, args) { return 0; },
            'ioctl': function(emu, args) { return -1; },
            'fcntl': function(emu, args) { return 0; },
            'pipe': function(emu, args) { return -1; },
            'dup': function(emu, args) { return -1; },
            'dup2': function(emu, args) { return -1; },
            'isatty': function(emu, args) { return 0; },
            'fileno': function(emu, args) { return args[0]; },
            'setbuf': function(emu, args) { return 0; },
            'setvbuf': function(emu, args) { return 0; },
            'tmpfile': function(emu, args) { return 0; },
            'tmpnam': function(emu, args) { return 0; },
            'unlink': function(emu, args) { return 0; },
            'rmdir': function(emu, args) { return 0; },
            'getcwd': function(emu, args) {
                if (args[0] && args[1] > 0) {
                    try {
                        var cwd = '/data/data/com.ea.game.simpsons4_row/files';
                        var bytes = [];
                        for (var i = 0; i < cwd.length; i++) bytes.push(cwd.charCodeAt(i) & 0xFF);
                        bytes.push(0);
                        emu.mem_write(args[0], bytes);
                    } catch(e) {}
                }
                return args[0];
            },
            'chdir': function(emu, args) { return 0; },
            'opendir': function(emu, args) { return 0; },
            'readdir': function(emu, args) { return 0; },
            'closedir': function(emu, args) { return 0; },
            'socket': function(emu, args) { return -1; },
            'connect': function(emu, args) { return -1; },
            'send': function(emu, args) { return -1; },
            'recv': function(emu, args) { return -1; },
            'bind': function(emu, args) { return -1; },
            'listen': function(emu, args) { return -1; },
            'accept': function(emu, args) { return -1; },
            'select': function(emu, args) { return 0; },
            'poll': function(emu, args) { return 0; },
            'setsockopt': function(emu, args) { return 0; },
            'getsockopt': function(emu, args) { return 0; },
            'getaddrinfo': function(emu, args) { return -1; },
            'freeaddrinfo': function(emu, args) { return 0; },
            'gai_strerror': function(emu, args) { return 0; },
            'inet_addr': function(emu, args) { return 0xFFFFFFFF; },
            'htons': function(emu, args) { return ((args[0] & 0xFF) << 8) | ((args[0] >> 8) & 0xFF); },
            'htonl': function(emu, args) {
                var v = args[0];
                return ((v & 0xFF) << 24) | ((v & 0xFF00) << 8) | ((v >> 8) & 0xFF00) | ((v >> 24) & 0xFF);
            },
            'ntohs': function(emu, args) { return ((args[0] & 0xFF) << 8) | ((args[0] >> 8) & 0xFF); },
            'ntohl': function(emu, args) {
                var v = args[0];
                return ((v & 0xFF) << 24) | ((v & 0xFF00) << 8) | ((v >> 8) & 0xFF00) | ((v >> 24) & 0xFF);
            },
            'strerror': function(emu, args) {
                var ptr = self.storeString('Unknown error');
                return ptr;
            },
            'strerror_r': function(emu, args) { return -1; },
            'perror': function(emu, args) { return 0; },
            'exit': function(emu, args) {
                Logger.warn('[exit] called with code ' + args[0]);
                return 0;
            },
            '_exit': function(emu, args) {
                Logger.warn('[_exit] called with code ' + args[0]);
                return 0;
            },

            // === v15.5: Critical missing shims ===
            
            // std::string copy constructor (libc++ short string optimization)
            '_ZNSt6__ndk112basic_stringIcNS_11char_traitsIcEENS_9allocatorIcEEEC1ERKS5_': function(emu, args) {
                var dst = args[0], src = args[1];
                if (!dst || !src) return dst;
                try {
                    // Copy 24 bytes (sizeof std::string in libc++)
                    var data = emu.mem_read(src, 24);
                    emu.mem_write(dst, Array.from(data));
                    // Check if long string (bit 0 of first byte = 1 in libc++)
                    if (data[0] & 1) {
                        // Long string: duplicate the heap buffer
                        var ptrBytes = [data[16], data[17], data[18], data[19]];
                        var ptr = (ptrBytes[0] | (ptrBytes[1] << 8) | (ptrBytes[2] << 16) | (ptrBytes[3] << 24)) >>> 0;
                        var lenBytes = [data[8], data[9], data[10], data[11]];
                        var len = ((lenBytes[0] | (lenBytes[1] << 8) | (lenBytes[2] << 16) | (lenBytes[3] << 24)) >>> 0) >> 1;
                        if (ptr && len > 0 && len < 65536) {
                            var strData = emu.mem_read(ptr, len + 1);
                            var newBuf = self.malloc(len + 1);
                            if (newBuf) {
                                emu.mem_write(newBuf, Array.from(strData));
                                // Write new pointer at dst+16
                                emu.mem_write(dst + 16, [
                                    newBuf & 0xFF, (newBuf >> 8) & 0xFF,
                                    (newBuf >> 16) & 0xFF, (newBuf >> 24) & 0xFF
                                ]);
                            }
                        }
                    }
                } catch(e) {}
                return dst;
            },

            // std::string move constructor
            '_ZNSt6__ndk112basic_stringIcNS_11char_traitsIcEENS_9allocatorIcEEEC1EOS5_': function(emu, args) {
                var dst = args[0], src = args[1];
                if (!dst || !src) return dst;
                try {
                    var data = emu.mem_read(src, 24);
                    emu.mem_write(dst, Array.from(data));
                    // Zero the source (moved-from state)
                    emu.mem_write(src, new Array(24).fill(0));
                } catch(e) {}
                return dst;
            },

            // std::string destructor
            '_ZNSt6__ndk112basic_stringIcNS_11char_traitsIcEENS_9allocatorIcEEED1Ev': function(emu, args) {
                // No-op (we don't track heap allocations for cleanup)
                return 0;
            },

            // std::string::c_str() / data()
            '_ZNKSt6__ndk112basic_stringIcNS_11char_traitsIcEENS_9allocatorIcEEE5c_strEv': function(emu, args) {
                var strObj = args[0];
                if (!strObj) return 0;
                try {
                    var data = emu.mem_read(strObj, 24);
                    if (data[0] & 1) {
                        // Long string: pointer at offset 16
                        return (data[16] | (data[17] << 8) | (data[18] << 16) | (data[19] << 24)) >>> 0;
                    } else {
                        // Short string: data starts at offset 1
                        return strObj + 1;
                    }
                } catch(e) { return 0; }
            },

            // std::string::size() / length()
            '_ZNKSt6__ndk112basic_stringIcNS_11char_traitsIcEENS_9allocatorIcEEE4sizeEv': function(emu, args) {
                var strObj = args[0];
                if (!strObj) return 0;
                try {
                    var data = emu.mem_read(strObj, 24);
                    if (data[0] & 1) {
                        // Long string: length at offset 8 (shifted right by 1)
                        return ((data[8] | (data[9] << 8) | (data[10] << 16) | (data[11] << 24)) >>> 0) >> 1;
                    } else {
                        // Short string: length is byte[0] >> 1
                        return data[0] >> 1;
                    }
                } catch(e) { return 0; }
            },

            // std::string from C string constructor
            '_ZNSt6__ndk112basic_stringIcNS_11char_traitsIcEENS_9allocatorIcEEEC1EPKc': function(emu, args) {
                var dst = args[0], cstr = args[1];
                if (!dst) return dst;
                try {
                    // Read the C string
                    var str = self._readCString(emu, cstr, 1024);
                    var len = str.length;
                    if (len <= 22) {
                        // Short string optimization
                        var bytes = new Array(24).fill(0);
                        bytes[0] = len << 1; // length in upper bits
                        for (var i = 0; i < len; i++) bytes[i + 1] = str.charCodeAt(i);
                        emu.mem_write(dst, bytes);
                    } else {
                        // Long string
                        var buf = self.malloc(len + 1);
                        if (buf) {
                            var strBytes = [];
                            for (var i = 0; i < len; i++) strBytes.push(str.charCodeAt(i));
                            strBytes.push(0);
                            emu.mem_write(buf, strBytes);
                            var bytes = new Array(24).fill(0);
                            bytes[0] = 1; // long string flag
                            // capacity at offset 4
                            var cap = len + 1;
                            bytes[4] = cap & 0xFF; bytes[5] = (cap >> 8) & 0xFF;
                            bytes[6] = (cap >> 16) & 0xFF; bytes[7] = (cap >> 24) & 0xFF;
                            // length at offset 8 (shifted left by 1)
                            var slen = len << 1;
                            bytes[8] = slen & 0xFF; bytes[9] = (slen >> 8) & 0xFF;
                            bytes[10] = (slen >> 16) & 0xFF; bytes[11] = (slen >> 24) & 0xFF;
                            // pointer at offset 16
                            bytes[16] = buf & 0xFF; bytes[17] = (buf >> 8) & 0xFF;
                            bytes[18] = (buf >> 16) & 0xFF; bytes[19] = (buf >> 24) & 0xFF;
                            emu.mem_write(dst, bytes);
                        }
                    }
                } catch(e) {}
                return dst;
            },

            // std::mutex lock/unlock (single-threaded = no-op)
            '_ZNSt6__ndk15mutex4lockEv': function(emu, args) { return 0; },
            '_ZNSt6__ndk15mutex6unlockEv': function(emu, args) { return 0; },
            '_ZNSt6__ndk115recursive_mutex4lockEv': function(emu, args) { return 0; },
            '_ZNSt6__ndk115recursive_mutex6unlockEv': function(emu, args) { return 0; },
            '_ZNSt6__ndk115recursive_mutexC1Ev': function(emu, args) { return 0; },
            '_ZNSt6__ndk115recursive_mutexD1Ev': function(emu, args) { return 0; },
            
            // std::call_once — just call the function pointer
            '_ZNSt6__ndk111__call_onceERVmPvPFvS2_E': function(emu, args) {
                // args[0] = flag, args[1] = arg, args[2] = func ptr
                // In single-threaded mode, we should call the function, but that's complex
                // For now, just mark as called by setting flag to 1
                if (args[0]) {
                    try { emu.mem_write(args[0], [1, 0, 0, 0]); } catch(e) {}
                }
                return 0;
            },

            // File I/O extensions
            'fseeko': function(emu, args) {
                // Same as fseek for our purposes
                return self.engine.vfs ? self.engine.vfs.fseek(args[0], args[1], args[2]) : -1;
            },
            'ftello': function(emu, args) {
                return self.engine.vfs ? self.engine.vfs.ftell(args[0]) : -1;
            },
            'fgetc': function(emu, args) {
                if (!self.engine.vfs) return -1;
                var fd = args[0];
                var buf = self.malloc(1);
                if (!buf) return -1;
                var read = self.engine.vfs.fread(buf, 1, 1, fd);
                if (read <= 0) return -1;
                try {
                    var byte = emu.mem_read(buf, 1);
                    return byte[0];
                } catch(e) { return -1; }
            },
            'lseek64': function(emu, args) {
                // lseek64(fd, offset_low, offset_high, whence)
                // For simplicity, use low 32 bits only
                return self.engine.vfs ? self.engine.vfs.fseek(args[0], args[1], args[3] || 0) : -1;
            },
            '__open_2': function(emu, args) {
                // fortified open — same as open
                var path = self._readCString(emu, args[0]);
                return self.engine.vfs ? self.engine.vfs.open(path, args[1]) : -1;
            },
            'ftruncate': function(emu, args) { return 0; },

            // String utilities
            'strcasecmp': function(emu, args) {
                var s1 = self._readCString(emu, args[0]).toLowerCase();
                var s2 = self._readCString(emu, args[1]).toLowerCase();
                if (s1 < s2) return -1;
                if (s1 > s2) return 1;
                return 0;
            },
            'strncasecmp': function(emu, args) {
                var n = args[2];
                var s1 = self._readCString(emu, args[0], n).toLowerCase().substring(0, n);
                var s2 = self._readCString(emu, args[1], n).toLowerCase().substring(0, n);
                if (s1 < s2) return -1;
                if (s1 > s2) return 1;
                return 0;
            },
            '__strchr_chk': function(emu, args) {
                // Same as strchr
                var str = self._readCString(emu, args[0]);
                var ch = args[1] & 0xFF;
                var idx = str.indexOf(String.fromCharCode(ch));
                if (idx < 0) return 0;
                return args[0] + idx;
            },
            'strtok_r': function(emu, args) {
                // Simplified strtok_r
                return 0; // return NULL (no more tokens)
            },
            'strpbrk': function(emu, args) {
                var str = self._readCString(emu, args[0]);
                var accept = self._readCString(emu, args[1]);
                for (var i = 0; i < str.length; i++) {
                    if (accept.indexOf(str[i]) >= 0) return args[0] + i;
                }
                return 0;
            },
            'memrchr': function(emu, args) {
                var ptr = args[0], ch = args[1] & 0xFF, n = args[2];
                if (!ptr || !n || n > 1048576) return 0;
                try {
                    var data = emu.mem_read(ptr, n);
                    for (var i = n - 1; i >= 0; i--) {
                        if (data[i] === ch) return ptr + i;
                    }
                } catch(e) {}
                return 0;
            },
            'wcslen': function(emu, args) {
                if (!args[0]) return 0;
                try {
                    var len = 0;
                    var ptr = args[0];
                    while (len < 4096) {
                        var bytes = emu.mem_read(ptr + len * 4, 4);
                        if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 0) break;
                        len++;
                    }
                    return len;
                } catch(e) { return 0; }
            },

            // Time functions
            '_ZNSt6__ndk16chrono12system_clock3nowEv': function(emu, args) {
                // Return current time in nanoseconds since epoch
                return Math.floor(Date.now() * 1000000) >>> 0;
            },
            'ctime': function(emu, args) {
                var str = new Date().toString();
                var ptr = self.malloc(32);
                if (ptr) {
                    var bytes = [];
                    for (var i = 0; i < str.length && i < 25; i++) bytes.push(str.charCodeAt(i));
                    bytes.push(10); // newline
                    bytes.push(0);
                    try { emu.mem_write(ptr, bytes); } catch(e) {}
                }
                return ptr;
            },
            'asctime': function(emu, args) {
                return self.engine.shims['ctime'](emu, args);
            },

            // Regex stubs (return failure)
            'regcomp': function(emu, args) { return 1; }, // REG_BADRPT = error
            'regexec': function(emu, args) { return 1; }, // REG_NOMATCH
            'regfree': function(emu, args) { return 0; },
            'regerror': function(emu, args) { return 0; },

            // Network stubs
            'inet_pton': function(emu, args) { return 0; },
            'inet_ntop': function(emu, args) { return 0; },
            'if_nametoindex': function(emu, args) { return 0; },
            'getsockname': function(emu, args) { return -1; },

            // System info stubs
            'uname': function(emu, args) {
                // Write minimal utsname struct
                if (args[0]) {
                    try {
                        var fields = ['Linux', 'localhost', '4.4.0', '#1 SMP', 'armv7l'];
                        var offset = 0;
                        for (var f of fields) {
                            var bytes = [];
                            for (var i = 0; i < f.length; i++) bytes.push(f.charCodeAt(i));
                            bytes.push(0);
                            while (bytes.length < 65) bytes.push(0);
                            emu.mem_write(args[0] + offset, bytes);
                            offset += 65;
                        }
                    } catch(e) {}
                }
                return 0;
            },
            'syscall': function(emu, args) { return -1; },
            'geteuid': function(emu, args) { return 1000; },
            'getpwuid_r': function(emu, args) { return -1; },
            'fnmatch': function(emu, args) { return 1; }, // FNM_NOMATCH

            // zlib
            'zlibVersion': function(emu, args) {
                var ptr = self.malloc(8);
                if (ptr) {
                    try { emu.mem_write(ptr, [0x31, 0x2e, 0x32, 0x2e, 0x38, 0]); } catch(e) {} // "1.2.8"
                }
                return ptr;
            },

            // File traversal stubs
            'fts_open': function(emu, args) { return 0; },
            'fts_read': function(emu, args) { return 0; },
            'fts_close': function(emu, args) { return 0; },

            // Formatted output
            'vfprintf': function(emu, args) { return 0; },

            // C++ iostream stubs
            '_ZNSt6__ndk16localeC1ERKS0_': function(emu, args) {
                // locale copy ctor: copy 4 bytes
                if (args[0] && args[1]) {
                    try {
                        var data = emu.mem_read(args[1], 4);
                        emu.mem_write(args[0], Array.from(data));
                    } catch(e) {}
                }
                return args[0];
            },
            '_ZNKSt6__ndk16locale9has_facetERNS0_2idE': function(emu, args) { return 0; },
            '_ZNSt6__ndk113basic_istreamIcNS_11char_traitsIcEEE6sentryC1ERS3_b': function(emu, args) {
                // istream::sentry ctor — set ok flag to true
                if (args[0]) { try { emu.mem_write(args[0], [1]); } catch(e) {} }
                return args[0];
            },
            '_ZNSt6__ndk113basic_ostreamIcNS_11char_traitsIcEEE6sentryC1ERS3_': function(emu, args) {
                if (args[0]) { try { emu.mem_write(args[0], [1]); } catch(e) {} }
                return args[0];
            },
            '_ZNSt6__ndk113basic_ostreamIcNS_11char_traitsIcEEE6sentryD1Ev': function(emu, args) { return 0; },
            '_ZNSt6__ndk19to_stringEl': function(emu, args) {
                // std::to_string(long) — return a string object
                var val = args[0];
                var str = String(val >>> 0);
                var dst = self.malloc(24);
                if (dst) {
                    var bytes = new Array(24).fill(0);
                    bytes[0] = str.length << 1;
                    for (var i = 0; i < str.length; i++) bytes[i + 1] = str.charCodeAt(i);
                    try { emu.mem_write(dst, bytes); } catch(e) {}
                }
                return dst;
            },
            '_ZNSt6__ndk16stoullERKNS_12basic_stringIcNS_11char_traitsIcEENS_9allocatorIcEEEEPji': function(emu, args) {
                // stoull — parse string to unsigned long long
                // Read the std::string and parse
                return 0;
            },
            '_ZNSt6__ndk119__shared_weak_countD2Ev': function(emu, args) { return 0; },
        };
    }
};
