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
    // Heap management with free-list recycling
    _heapPtr: 0xD0100000,
    _heapBase: 0xD0000000,
    _heapSize: 64 * 1024 * 1024,
    _freeList: [],          // [{addr, size}] sorted by size for best-fit
    _allocSizes: new Map(), // addr -> allocated size (for free/realloc)
    _allocCount: 0,
    _freeCount: 0,
    _recycledCount: 0,
    _recycledBytes: 0,

    // String storage for JNI/libc
    _strings: new Map(),
    _nextStringAddr: 0xC0080000,

    // v2.1: VFS reference (set by engine)
    vfs: null,

    // v24: Thread execution queue and condition variable tracking
    _pendingThreads: [],
    _threadsDone: new Set(),   // set of thread IDs that have completed
    _condSignaled: new Set(),  // set of cond var addresses that have been signaled
    _nextThreadId: 100,
    _threadExecCount: 0,

    // v24: dlsym stub allocation
    _dlsymStubs: new Map(),    // symbol name -> stub address
    _nextDlsymAddr: 0xE0010000,

    // v25: Virtual socket layer for HTTP networking
    _virtualSockets: {},
    _nextSocketFd: 50000,  // high range to avoid VFS FD collision
    _netRequestCount: 0,
    _netResponseCount: 0,

    // v28: Directory enumeration for opendir/readdir/closedir
    _dirHandles: new Map(),   // handle_id -> { path, entries[], index }
    _nextDirHandle: 0xA0000000,
    _direntBuf: 0,  // allocated buffer for dirent struct

    init(engine) {
        this.engine = engine;
        this.vfs = engine.vfs || null;
        this._freeList = [];
        this._allocSizes = new Map();
        this._virtualSockets = {};
        this._nextSocketFd = 50000;
        this._netRequestCount = 0;
        this._netResponseCount = 0;
        this._pendingThreads = [];
        this._threadsDone = new Set();
        this._condSignaled = new Set();
        this._dlsymStubs = new Map();
        this._dirHandles = new Map();
        this._nextDirHandle = 0xA0000000;
        this._direntBuf = 0;
        this._filePtrToFd = new Map();
        this._freadLogCount = 0;
        Logger.info('Android shims v28 initialized (+ opendir/readdir + FILE* struct + stat64)');
    },

    // ============================================
    // v25: HTTP Request Parser & Router
    // ============================================

    _tryProcessHttpRequest(sock) {
        if (sock.requestDone || sock.recvBuf) return; // already processed
        if (sock.sendBuf.length < 16) return; // too small

        // Convert send buffer to string to parse HTTP headers
        var raw = '';
        for (var i = 0; i < Math.min(sock.sendBuf.length, 8192); i++) {
            raw += String.fromCharCode(sock.sendBuf[i]);
        }

        // Find end of HTTP headers
        var headerEnd = raw.indexOf('\r\n\r\n');
        if (headerEnd < 0) return; // headers not complete yet

        var headerPart = raw.substring(0, headerEnd);
        var lines = headerPart.split('\r\n');
        if (lines.length < 1) return;

        // Parse request line: "GET /path HTTP/1.1"
        var reqLine = lines[0].split(' ');
        if (reqLine.length < 2) return;
        var method = reqLine[0];
        var url = reqLine[1];

        // Parse headers
        var headers = {};
        for (var i = 1; i < lines.length; i++) {
            var colonIdx = lines[i].indexOf(':');
            if (colonIdx > 0) {
                var key = lines[i].substring(0, colonIdx).trim().toLowerCase();
                var val = lines[i].substring(colonIdx + 1).trim();
                headers[key] = val;
            }
        }

        // Check if body is complete (for POST/PUT)
        var bodyStart = headerEnd + 4; // after \r\n\r\n
        var contentLength = parseInt(headers['content-length']) || 0;
        var bodyBytes = null;

        if (contentLength > 0) {
            if (sock.sendBuf.length < bodyStart + contentLength) {
                return; // body not complete yet
            }
            bodyBytes = new Uint8Array(sock.sendBuf.slice(bodyStart, bodyStart + contentLength));
        }

        sock.requestDone = true;
        this._netRequestCount++;

        Logger.info('[NET] HTTP Request: ' + method + ' ' + url + ' (body=' + (contentLength || 0) + ' bytes)');

        // Route to GameServer
        var response;
        try {
            response = GameServer.handleRequest(method, url, headers, bodyBytes);
        } catch(e) {
            Logger.error('[NET] GameServer error: ' + e.message);
            response = { status: 500, headers: { 'Content-Type': 'text/plain' }, body: 'Internal Server Error' };
        }

        // Build HTTP response
        var status = response.status || 200;
        var respHeaders = response.headers || {};
        var respBody;

        if (response.bodyBytes) {
            respBody = response.bodyBytes;
        } else if (response.body) {
            // Convert string to bytes
            var str = response.body;
            var bytes = [];
            for (var i = 0; i < str.length; i++) {
                var c = str.charCodeAt(i);
                if (c < 0x80) bytes.push(c);
                else if (c < 0x800) { bytes.push(0xC0 | (c >> 6)); bytes.push(0x80 | (c & 0x3F)); }
                else { bytes.push(0xE0 | (c >> 12)); bytes.push(0x80 | ((c >> 6) & 0x3F)); bytes.push(0x80 | (c & 0x3F)); }
            }
            respBody = new Uint8Array(bytes);
        } else {
            respBody = new Uint8Array(0);
        }

        // Status text
        var statusTexts = { 200: 'OK', 201: 'Created', 302: 'Found', 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 500: 'Internal Server Error' };
        var statusText = statusTexts[status] || 'OK';

        // Build response header string
        var respLine = 'HTTP/1.1 ' + status + ' ' + statusText + '\r\n';
        respLine += 'Content-Length: ' + respBody.length + '\r\n';
        respLine += 'Connection: close\r\n';
        for (var key in respHeaders) {
            respLine += key.charAt(0).toUpperCase() + key.slice(1) + ': ' + respHeaders[key] + '\r\n';
        }
        respLine += '\r\n';

        // Convert header to bytes and concat with body
        var headerBytes = [];
        for (var i = 0; i < respLine.length; i++) {
            headerBytes.push(respLine.charCodeAt(i));
        }

        var fullResponse = new Uint8Array(headerBytes.length + respBody.length);
        fullResponse.set(headerBytes, 0);
        fullResponse.set(respBody, headerBytes.length);

        sock.recvBuf = fullResponse;
        sock.recvOffset = 0;
        this._netResponseCount++;

        Logger.info('[NET] HTTP Response: ' + status + ' ' + statusText + ' (' + respBody.length + ' bytes body)');
    },

    // v28b: Sync bionic FILE struct buffer pointers with VFS position
    // After fread/fseek, update _p and _r so ARM getc() macro works correctly
    _syncFileStruct(emu, filePtr, fd) {
        if (!this._filePtrToFd || !this._filePtrToFd.has(filePtr)) return;
        if (!this._filePtrBufs || !this._filePtrBufs.has(filePtr)) return;
        if (!this.vfs) return;

        var handle = this.vfs._handles.get(fd);
        if (!handle) return;

        var bufBase = this._filePtrBufs.get(filePtr);
        var pos = handle.pos;
        var remaining = handle.size - pos;

        // _p at offset 0: bufBase + pos
        var newP = (bufBase + pos) >>> 0;
        try {
            emu.mem_write(filePtr, [
                newP & 0xFF, (newP >> 8) & 0xFF,
                (newP >> 16) & 0xFF, (newP >> 24) & 0xFF
            ]);
            // _r at offset 4: remaining bytes
            emu.mem_write(filePtr + 4, [
                remaining & 0xFF, (remaining >> 8) & 0xFF,
                (remaining >> 16) & 0xFF, (remaining >> 24) & 0xFF
            ]);
        } catch(e) {}
    },

    malloc(size) {
        if (!size || size <= 0) return 0;
        var aligned = (size + 7) & ~7;

        // Try to recycle from free-list (best-fit)
        var bestIdx = -1;
        var bestWaste = Infinity;
        for (var i = 0; i < this._freeList.length; i++) {
            var block = this._freeList[i];
            if (block.size >= aligned && block.size - aligned < bestWaste) {
                bestIdx = i;
                bestWaste = block.size - aligned;
                if (bestWaste === 0) break; // perfect fit
            }
        }
        if (bestIdx >= 0) {
            var recycled = this._freeList.splice(bestIdx, 1)[0];
            this._allocSizes.set(recycled.addr, recycled.size);
            this._recycledCount++;
            this._recycledBytes += recycled.size;
            this._allocCount++;
            return recycled.addr;
        }

        // Allocate from heap
        var ptr = this._heapPtr;
        this._heapPtr += aligned;
        if (this._heapPtr >= this._heapBase + this._heapSize) {
            // Emergency: compact free list and try again
            Logger.error('Heap pressure! ' + this._freeList.length + ' free blocks, ' +
                         Math.round((this._heapPtr - this._heapBase) / 1048576) + 'MB used');
            return 0;
        }
        this._allocSizes.set(ptr, aligned);
        this._allocCount++;
        return ptr;
    },

    free(ptr) {
        if (!ptr || ptr === 0) return;
        var size = this._allocSizes.get(ptr);
        if (size) {
            this._allocSizes.delete(ptr);
            this._freeList.push({ addr: ptr, size: size });
            this._freeCount++;
            // Limit free list size to avoid O(n) scan overhead
            if (this._freeList.length > 10000) {
                // Drop smallest blocks (least useful)
                this._freeList.sort(function(a, b) { return b.size - a.size; });
                this._freeList.length = 5000;
            }
        }
    },

    calloc(count, size) {
        var total = count * size;
        var ptr = this.malloc(total);
        if (ptr && total > 0 && this.engine && this.engine.emu) {
            try {
                // Zero in 4KB chunks
                var remaining = total;
                var offset = 0;
                while (remaining > 0) {
                    var chunk = Math.min(remaining, 4096);
                    var zeros = new Array(chunk).fill(0);
                    this.engine.emu.mem_write(ptr + offset, zeros);
                    offset += chunk;
                    remaining -= chunk;
                }
            } catch(e) {}
        }
        return ptr;
    },

    realloc(ptr, size) {
        if (!ptr || ptr === 0) return this.malloc(size);
        if (!size || size <= 0) { this.free(ptr); return 0; }
        var oldSize = this._allocSizes.get(ptr) || 0;
        var aligned = (size + 7) & ~7;
        // If existing block is big enough, keep it
        if (oldSize >= aligned) return ptr;
        // Allocate new, copy old data, free old
        var newPtr = this.malloc(size);
        if (newPtr && oldSize > 0 && this.engine && this.engine.emu) {
            try {
                var copySize = Math.min(oldSize, size);
                var data = this.engine.emu.mem_read(ptr, copySize);
                this.engine.emu.mem_write(newPtr, data);
            } catch(e) {}
        }
        this.free(ptr);
        return newPtr;
    },

    /**
     * v24: Execute pending thread routines synchronously.
     * Called by the engine after init steps to run background work.
     */
    runPendingThreads(maxCount) {
        maxCount = maxCount || 10;
        var ran = 0;
        while (this._pendingThreads.length > 0 && ran < maxCount) {
            var thread = this._pendingThreads.shift();
            if (!thread.func || thread.executed) continue;
            thread.executed = true;
            this._threadExecCount++;
            Logger.info('[PTHREAD] Executing thread routine 0x' + (thread.func >>> 0).toString(16) +
                        ' arg=0x' + (thread.arg >>> 0).toString(16));
            try {
                var result = this.engine.callAddress(thread.func, {
                    r0: thread.arg
                }, 500000); // 500K instruction limit per thread
                Logger.info('[PTHREAD] Thread completed: ' + (result.instructions || 0) + ' insns, ' +
                            'R0=0x' + ((result.r0 || 0) >>> 0).toString(16));
                this._threadsDone.add(thread.id);
                // Signal any condition variables that threads might be waiting on
                this._condSignaled.add(0xFFFFFFFF); // broadcast "a thread completed"
            } catch(e) {
                Logger.warn('[PTHREAD] Thread execution failed: ' + e.message);
                this._threadsDone.add(thread.id);
            }
            ran++;
        }
        return ran;
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
                        // v22: NULL %s — output empty string instead of "(null)"
                        // The game's base directory pointer may be uninitialized.
                        // VFS _normalizePath handles the resulting relative paths.
                        result += '';
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
            '__aeabi_memmove8': function(emu, args) {
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
            '__aeabi_memset4': function(emu, args) {
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

                if (!path) {
                    Logger.warn('[fopen] EMPTY path from addr 0x' + (args[0]>>>0).toString(16) + ' mode=' + mode);
                }

                Logger.info('[fopen] ATTEMPT: "' + path + '" mode=' + mode);

                // Try VFS first
                if (self.vfs) {
                    var fd = self.vfs.fopen(path, mode);
                    if (fd) {
                        // v28b: Return heap-allocated FILE struct with full bionic layout
                        // ARM code reads directly from FILE struct buffer pointers (getc macro)
                        // Bionic __sFILE layout:
                        //   0:  unsigned char *_p     — current position in buffer
                        //   4:  int _r                — read space left for getc()
                        //   8:  int _w                — write space left for putc()
                        //  12:  short _flags           — flags
                        //  14:  short _file            — file descriptor number
                        //  16:  struct __sbuf { char *_base; int _size; } _bf
                        //  24:  int _lbfsize
                        //  28:  void *_cookie
                        //  32:  int (*_close)(void *)
                        //  36:  int (*_read)(void *, char *, int)
                        //  40:  fpos_t (*_seek)(void *, fpos_t, int)
                        //  44:  int (*_write)(void *, const char *, int)
                        //  48+: extension fields

                        var handle = self.vfs._handles.get(fd);
                        var fileSize = handle ? handle.size : 0;

                        // Allocate buffer for entire file contents in emulator memory
                        var bufPtr = 0;
                        if (handle && handle.data && fileSize > 0) {
                            bufPtr = self.malloc(fileSize);
                            if (bufPtr) {
                                try {
                                    // Copy file data into emulator memory
                                    var chunk = Array.from(handle.data);
                                    emu.mem_write(bufPtr, chunk);
                                    // v28c: Verify buffer was written correctly
                                    var verifyLen = Math.min(32, fileSize);
                                    var verify = emu.mem_read(bufPtr, verifyLen);
                                    var match = true;
                                    for (var vi = 0; vi < verifyLen; vi++) {
                                        if (verify[vi] !== handle.data[vi]) { match = false; break; }
                                    }
                                    var hexPreview = Array.from(verify).slice(0, 16).map(function(b) { return b.toString(16).padStart(2, '0'); }).join(' ');
                                    Logger.info('[fopen] Loaded ' + fileSize + ' bytes into buffer at 0x' + bufPtr.toString(16) + ' verify=' + (match ? 'OK' : 'MISMATCH') + ' [' + hexPreview + ']');
                                } catch(e) {
                                    Logger.warn('[fopen] Failed to load file buffer: ' + e.message);
                                    self.free(bufPtr);
                                    bufPtr = 0;
                                }
                            }
                        }

                        // Allocate FILE struct (80 bytes)
                        var filePtr = self.malloc(80);
                        if (filePtr) {
                            try {
                                var fs = new Array(80).fill(0);

                                // _p at offset 0: pointer to current read position
                                var p = bufPtr || 0;
                                fs[0] = p & 0xFF; fs[1] = (p >> 8) & 0xFF;
                                fs[2] = (p >> 16) & 0xFF; fs[3] = (p >> 24) & 0xFF;

                                // _r at offset 4: bytes remaining to read
                                fs[4] = fileSize & 0xFF; fs[5] = (fileSize >> 8) & 0xFF;
                                fs[6] = (fileSize >> 16) & 0xFF; fs[7] = (fileSize >> 24) & 0xFF;

                                // _w at offset 8: 0 (not writable)

                                // _flags at offset 12: __SRD (read) = 0x0004
                                fs[12] = 0x04; fs[13] = 0x00;

                                // _file at offset 14: file descriptor
                                fs[14] = fd & 0xFF; fs[15] = (fd >> 8) & 0xFF;

                                // _bf._base at offset 16: base of buffer
                                fs[16] = p & 0xFF; fs[17] = (p >> 8) & 0xFF;
                                fs[18] = (p >> 16) & 0xFF; fs[19] = (p >> 24) & 0xFF;

                                // _bf._size at offset 20: buffer size
                                fs[20] = fileSize & 0xFF; fs[21] = (fileSize >> 8) & 0xFF;
                                fs[22] = (fileSize >> 16) & 0xFF; fs[23] = (fileSize >> 24) & 0xFF;

                                emu.mem_write(filePtr, fs);
                                // v28c: Verify FILE struct was written correctly
                                var fsVerify = emu.mem_read(filePtr, 24);
                                var vp = (fsVerify[0] | (fsVerify[1] << 8) | (fsVerify[2] << 16) | (fsVerify[3] << 24)) >>> 0;
                                var vr = (fsVerify[4] | (fsVerify[5] << 8) | (fsVerify[6] << 16) | (fsVerify[7] << 24)) >>> 0;
                                var vbase = (fsVerify[16] | (fsVerify[17] << 8) | (fsVerify[18] << 16) | (fsVerify[19] << 24)) >>> 0;
                                var vsize = (fsVerify[20] | (fsVerify[21] << 8) | (fsVerify[22] << 16) | (fsVerify[23] << 24)) >>> 0;
                                Logger.info('[fopen] FILE struct verify: _p=0x' + vp.toString(16) + ' _r=' + vr + ' _bf.base=0x' + vbase.toString(16) + ' _bf.size=' + vsize);
                            } catch(e) {
                                Logger.warn('[fopen] Failed to write FILE struct: ' + e.message);
                            }

                            // Map FILE* back to fd and track buffer for cleanup
                            self._filePtrToFd.set(filePtr, fd);
                            if (!self._filePtrBufs) self._filePtrBufs = new Map();
                            if (bufPtr) self._filePtrBufs.set(filePtr, bufPtr);

                            Logger.info('[fopen] HIT: ' + path + ' -> fd=' + fd + ' FILE*=0x' + filePtr.toString(16) + ' buf=0x' + (bufPtr||0).toString(16) + ' size=' + fileSize);
                            return filePtr;
                        }
                        // Fallback: return fd directly
                        Logger.info('[fopen] HIT (raw fd): ' + path + ' -> fd=' + fd);
                        return fd;
                    }
                }

                // Not in VFS — log and return NULL
                Logger.warn('[fopen] MISS: ' + path + ' mode=' + mode);
                return 0;
            },
            'fclose':  function(emu, args) {
                var filePtr = args[0];
                // v28: Resolve FILE* to fd and free resources
                var fd = filePtr;
                if (self._filePtrToFd && self._filePtrToFd.has(filePtr)) {
                    fd = self._filePtrToFd.get(filePtr);
                    self._filePtrToFd.delete(filePtr);
                    // Free the file data buffer
                    if (self._filePtrBufs && self._filePtrBufs.has(filePtr)) {
                        self.free(self._filePtrBufs.get(filePtr));
                        self._filePtrBufs.delete(filePtr);
                    }
                    self.free(filePtr); // free the FILE struct
                }
                if (self.vfs && fd >= 100) {
                    return self.vfs.fclose(fd);
                }
                return 0;
            },
            'fread':   function(emu, args) {
                var destPtr = args[0];
                var itemSize = args[1];
                var itemCount = args[2];
                var filePtr = args[3];
                // v28: Resolve FILE* pointer to VFS fd
                var fd = (self._filePtrToFd && self._filePtrToFd.has(filePtr)) ? self._filePtrToFd.get(filePtr) : filePtr;

                if (self.vfs && fd >= 100) {
                    var posBefore = self.vfs.ftell(fd);
                    var result = self.vfs.fread(fd, destPtr, itemSize, itemCount, emu);

                    // v28b: Sync FILE struct buffer pointers after read
                    self._syncFileStruct(emu, filePtr, fd);

                    // Log fread calls with data preview
                    if (self._freadLogCount < 200) {
                        self._freadLogCount++;
                        var totalBytes = itemSize * result;
                        var preview = '';
                        if (totalBytes > 0 && totalBytes <= 32 && destPtr) {
                            try {
                                var readBytes = emu.mem_read(destPtr, Math.min(totalBytes, 16));
                                preview = ' data=[' + Array.from(readBytes).map(function(b) { return '0x' + b.toString(16).padStart(2, '0'); }).join(',') + ']';
                                var ascii = '';
                                for (var bi = 0; bi < readBytes.length; bi++) {
                                    ascii += (readBytes[bi] >= 32 && readBytes[bi] < 127) ? String.fromCharCode(readBytes[bi]) : '.';
                                }
                                preview += ' "' + ascii + '"';
                            } catch(e) {}
                        }
                        Logger.info('[fread] fd=' + fd + ' pos=' + posBefore + ' size=' + itemSize + ' count=' + itemCount + ' -> ' + result + ' items (' + totalBytes + ' bytes)' + preview);
                    }
                    return result;
                }
                return 0;
            },
            'fwrite':  function(emu, args) { return args[2]; }, // pretend success
            'fgets':   function(emu, args) {
                var destPtr = args[0];
                var maxLen = args[1];
                var filePtr = args[2];
                var fd = (self._filePtrToFd && self._filePtrToFd.has(filePtr)) ? self._filePtrToFd.get(filePtr) : filePtr;

                if (self.vfs && fd >= 100) {
                    return self.vfs.fgets(fd, destPtr, maxLen, emu);
                }
                return 0;
            },
            'fseek':   function(emu, args) {
                var filePtr = args[0];
                var fd = (self._filePtrToFd && self._filePtrToFd.has(filePtr)) ? self._filePtrToFd.get(filePtr) : filePtr;
                var offset = args[1] | 0; // signed
                var whence = args[2];

                if (self.vfs && fd >= 100) {
                    var result = self.vfs.fseek(fd, offset, whence);
                    // v28b: Sync FILE struct buffer pointers after seek
                    self._syncFileStruct(emu, filePtr, fd);
                    var whenceStr = whence === 0 ? 'SET' : whence === 1 ? 'CUR' : 'END';
                    Logger.info('[fseek] fd=' + fd + ' offset=' + offset + ' whence=' + whenceStr + ' -> pos=' + self.vfs.ftell(fd));
                    return result;
                }
                return -1;
            },
            'ftell':   function(emu, args) {
                var filePtr = args[0];
                var fd = (self._filePtrToFd && self._filePtrToFd.has(filePtr)) ? self._filePtrToFd.get(filePtr) : filePtr;
                if (self.vfs && fd >= 100) {
                    var pos = self.vfs.ftell(fd);
                    Logger.info('[ftell] fd=' + fd + ' -> ' + pos);
                    return pos;
                }
                return -1;
            },
            'feof':    function(emu, args) {
                var filePtr = args[0];
                var fd = (self._filePtrToFd && self._filePtrToFd.has(filePtr)) ? self._filePtrToFd.get(filePtr) : filePtr;
                if (self.vfs && fd >= 100) {
                    return self.vfs.feof(fd);
                }
                return 1;
            },
            'ferror':  function(emu, args) { return 0; },
            'fflush':  function(emu, args) { return 0; },
            'open':    function(emu, args) {
                var path = self._readCString(emu, args[0]);
                var flags = args[1];
                Logger.info('[open] ATTEMPT: "' + path + '" flags=0x' + (flags>>>0).toString(16));
                // For POSIX open(), try VFS too
                if (self.vfs && self.vfs.exists(path)) {
                    var fd = self.vfs.fopen(path, 'r');
                    if (fd) {
                        Logger.info('[open] VFS HIT: ' + path + ' -> fd=' + fd);
                        return fd;
                    }
                }
                Logger.info('[open] MISS: ' + path);
                return -1;
            },
            // close/read/write defined in v25 virtual socket section below
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
                // v28: Check if path is a directory in VFS
                if (self.vfs && path) {
                    var dirPath = path.replace(/\/+$/, '') + '/';
                    var normalized = self.vfs._normalizePath(dirPath);
                    for (var entry of self.vfs._files) {
                        if (entry[0].indexOf(normalized) === 0) {
                            // It's a directory — write stat with S_IFDIR
                            if (args[1]) {
                                try {
                                    var zeros = new Array(128).fill(0);
                                    emu.mem_write(args[1], zeros);
                                    var dirMode = 0x4000 | 0x1ED; // S_IFDIR | 0755
                                    emu.mem_write(args[1] + 8, [dirMode & 0xFF, (dirMode >> 8) & 0xFF, 0, 0]);
                                } catch(e) {}
                            }
                            Logger.info('[stat] VFS DIR HIT: ' + path);
                            return 0;
                        }
                    }
                }
                Logger.info('[stat] MISS: ' + path);
                return -1;
            },
            // v28: stat64 alias — ARM Android often uses this
            'stat64':  function(emu, args) {
                return self.engine.shims['stat'](emu, args);
            },
            'lstat':   function(emu, args) {
                return self.engine.shims['stat'](emu, args);
            },
            'lstat64': function(emu, args) {
                return self.engine.shims['stat'](emu, args);
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
            'fstat64': function(emu, args) {
                return self.engine.shims['fstat'](emu, args);
            },
            'access':  function(emu, args) {
                var path = self._readCString(emu, args[0]);
                if (self.vfs && self.vfs.exists(path)) {
                    Logger.info('[access] VFS HIT: ' + path);
                    return 0;
                }
                // v28: Also check if it's a directory (has children in VFS)
                if (self.vfs && path) {
                    var dirPath = path.replace(/\/+$/, '') + '/';
                    var normalized = self.vfs._normalizePath(dirPath);
                    for (var entry of self.vfs._files) {
                        if (entry[0].indexOf(normalized) === 0) {
                            Logger.info('[access] VFS DIR HIT: ' + path);
                            return 0;
                        }
                    }
                }
                Logger.info('[access] MISS: ' + path);
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
                var threadPtr = args[0], startRoutine = args[2], threadArg = args[3];
                var threadId = self._nextThreadId++;
                Logger.info('[PTHREAD] pthread_create: id=' + threadId +
                    ' routine=0x' + (startRoutine>>>0).toString(16) +
                    ' arg=0x' + (threadArg>>>0).toString(16));
                self._pendingThreads.push({
                    id: threadId,
                    func: startRoutine,
                    arg: threadArg,
                    executed: false
                });
                // Write thread ID
                if (threadPtr) {
                    try {
                        self.engine.emu.mem_write(threadPtr, [
                            threadId & 0xFF, (threadId >> 8) & 0xFF,
                            (threadId >> 16) & 0xFF, (threadId >> 24) & 0xFF
                        ]);
                    } catch(e) {}
                }
                return 0;
            },
            'pthread_join': function(emu, args) {
                // If the thread hasn't run yet, run pending threads now
                var tid = args[0];
                if (!self._threadsDone.has(tid) && self._pendingThreads.length > 0) {
                    Logger.info('[PTHREAD] pthread_join(tid=' + tid + ') — running pending threads...');
                    self.runPendingThreads(5);
                }
                return 0;
            },
            'pthread_detach':        function(emu, args) { return 0; },
            'pthread_self':          function(emu, args) { return 1; },
            'pthread_exit': function(emu, args) {
                // Stop emulation for this thread routine
                try { self.engine.emu.emu_stop(); } catch(e) {}
                return 0;
            },
            'pthread_once': function(emu, args) {
                // args[0] = once_control, args[1] = init_routine
                if (args[0]) {
                    try {
                        var val = self.engine.emu.mem_read(args[0], 4);
                        var done = val[0] | (val[1] << 8) | (val[2] << 16) | (val[3] << 24);
                        if (done !== 0) return 0; // already called
                        self.engine.emu.mem_write(args[0], [1, 0, 0, 0]); // mark done
                    } catch(e) {}
                }
                // Execute the init routine
                if (args[1]) {
                    Logger.info('[PTHREAD] pthread_once: calling 0x' + (args[1]>>>0).toString(16));
                    try {
                        self.engine.callAddress(args[1], {}, 100000);
                    } catch(e) {
                        Logger.warn('[PTHREAD] pthread_once routine failed: ' + e.message);
                    }
                }
                return 0;
            },
            'pthread_cond_init':     function(emu, args) { return 0; },
            'pthread_cond_wait': function(emu, args) {
                if (!self._condWaitCount) self._condWaitCount = 0;
                self._condWaitCount++;
                var condAddr = args[0] >>> 0;
                // Check if this condition was signaled
                if (self._condSignaled.has(condAddr) || self._condSignaled.has(0xFFFFFFFF)) {
                    self._condSignaled.delete(condAddr);
                    return 0; // condition met
                }
                // Run pending threads to make progress (they may signal us)
                if (self._pendingThreads.length > 0) {
                    self.runPendingThreads(3);
                    if (self._condSignaled.has(condAddr) || self._condSignaled.has(0xFFFFFFFF)) {
                        self._condSignaled.delete(condAddr);
                        return 0;
                    }
                }
                if (self._condWaitCount <= 10) {
                    Logger.info('[PTHREAD] pthread_cond_wait #' + self._condWaitCount +
                        ' cond=0x' + condAddr.toString(16));
                }
                return 0; // can't actually block in single-threaded JS
            },
            'pthread_cond_signal': function(emu, args) {
                self._condSignaled.add(args[0] >>> 0);
                return 0;
            },
            'pthread_cond_broadcast': function(emu, args) {
                self._condSignaled.add(args[0] >>> 0);
                return 0;
            },
            'pthread_cond_destroy':  function(emu, args) { return 0; },
            'pthread_cond_timedwait': function(emu, args) {
                var condAddr = args[0] >>> 0;
                // Same as cond_wait but with timeout — just run pending threads
                if (self._pendingThreads.length > 0) {
                    self.runPendingThreads(3);
                }
                if (self._condSignaled.has(condAddr) || self._condSignaled.has(0xFFFFFFFF)) {
                    self._condSignaled.delete(condAddr);
                    return 0;
                }
                return 110; // ETIMEDOUT — signal timeout so caller doesn't infinite-loop
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

            // rwlock (read-write lock) stubs
            'pthread_rwlock_init':    function(emu, args) { return 0; },
            'pthread_rwlock_destroy': function(emu, args) { return 0; },
            'pthread_rwlock_rdlock':  function(emu, args) { return 0; },
            'pthread_rwlock_wrlock':  function(emu, args) { return 0; },
            'pthread_rwlock_unlock':  function(emu, args) { return 0; },
            'pthread_rwlock_tryrdlock': function(emu, args) { return 0; },
            'pthread_rwlock_trywrlock': function(emu, args) { return 0; },
            'pthread_rwlockattr_init':    function(emu, args) { return 0; },
            'pthread_rwlockattr_destroy': function(emu, args) { return 0; },

            // TLS (thread-local storage) stubs
            'pthread_key_create':    function(emu, args) {
                // args[0] = key ptr, args[1] = destructor
                // Write a fake key value
                if (args[0]) {
                    if (!self._nextTlsKey) self._nextTlsKey = 1;
                    try { self.engine.emu.mem_write(args[0], [self._nextTlsKey & 0xFF, 0, 0, 0]); } catch(e) {}
                    self._nextTlsKey++;
                }
                return 0;
            },
            'pthread_key_delete':    function(emu, args) { return 0; },
            'pthread_setspecific':   function(emu, args) {
                // args[0] = key, args[1] = value
                if (!self._tlsStore) self._tlsStore = {};
                self._tlsStore[args[0]] = args[1];
                return 0;
            },
            'pthread_getspecific':   function(emu, args) {
                if (!self._tlsStore) self._tlsStore = {};
                return self._tlsStore[args[0]] || 0;
            },

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
            'abort': function(emu, args) {
                Logger.error('abort() called! Stopping emulation.');
                try { self.engine.emu.emu_stop(); } catch(e) {}
                return 0;
            },
            '__stack_chk_fail': function(emu, args) { Logger.warn('Stack canary fail (ignored)'); return 0; },
            '__cxa_finalize':   function(emu, args) { return 0; },
            '__cxa_atexit':     function(emu, args) { return 0; },
            '__cxa_guard_acquire': function(emu, args) { return 1; },
            '__cxa_guard_release': function(emu, args) { return 0; },
            '__cxa_guard_abort':   function(emu, args) { return 0; },
            'mmap':      function(emu, args) {
                // args: [addr, length, prot, flags, fd, offset]
                var addr = args[0], length = args[1] || 4096, prot = args[2];
                var flags = args[3];
                // fd and offset are on stack for mmap (6 args)
                var stackArgs = self._readStackArgs(emu, 2);
                var fd = stackArgs[0], offset = stackArgs[1] || 0;

                var ptr = self.malloc(length);
                Logger.info('[mmap] addr=0x' + (addr>>>0).toString(16) + ' len=' + length +
                    ' fd=' + fd + ' offset=' + offset + ' → 0x' + (ptr>>>0).toString(16));

                // v27f: If fd is a VFS file, copy its data into the mmap'd region
                if (self.vfs && fd >= 100) {
                    var handle = self.vfs._handles.get(fd);
                    if (handle && handle.data) {
                        var start = offset;
                        var end = Math.min(start + length, handle.data.length);
                        var toWrite = end - start;
                        if (toWrite > 0) {
                            try {
                                var chunk = Array.from(handle.data.slice(start, end));
                                emu.mem_write(ptr, chunk);
                                Logger.info('[mmap] Wrote ' + toWrite + ' bytes from VFS fd=' + fd +
                                    ' (file: ' + handle.path + ')');
                            } catch(e) {
                                Logger.warn('[mmap] Failed to write VFS data: ' + e.message);
                            }
                        }
                    }
                }
                return ptr;
            },
            'munmap':    function(emu, args) { return 0; },
            'mprotect':  function(emu, args) { return 0; },

            // ============================================
            // Android logging (read actual tag + message)
            // ============================================
            '__android_log_vprint': function(emu, args) {
                var tag = self._readCString(emu, args[1]);
                var fmt = self._readCString(emu, args[2]);
                var vaPtr = args[3];
                var msg = self._formatString(emu, fmt, function(idx) {
                    return self._readU32(emu, vaPtr + idx * 4);
                });
                Logger.info('[Android:' + tag + '] ' + msg);
                return 0;
            },
            '__android_log_write': function(emu, args) {
                var tag = self._readCString(emu, args[1]);
                var msg = self._readCString(emu, args[2]);
                Logger.info('[Android:' + tag + '] ' + msg);
                return 0;
            },
            '__android_log_print': function(emu, args) {
                // __android_log_print(prio, tag, fmt, ...) — variadic
                // R0=prio, R1=tag, R2=fmt, R3=first_vararg, stack for rest
                var tag = self._readCString(emu, args[1]);
                var fmt = self._readCString(emu, args[2]);
                var regArgs = [args[3]]; // R3 = first vararg
                var stackArgs = self._readStackArgs(emu, 8);
                var allArgs = regArgs.concat(stackArgs);
                var msg = self._formatString(emu, fmt, function(idx) { return allArgs[idx] || 0; });
                Logger.info('[Android:' + tag + '] ' + msg);
                return 0;
            },
            'AndroidBitmap_getInfo':     function(emu, args) { return 0; },
            'AndroidBitmap_lockPixels':  function(emu, args) { return 0; },
            'AndroidBitmap_unlockPixels':function(emu, args) { return 0; },

            // dlsym — return stub function pointer (not 0!)
            'dlsym': function(emu, args) {
                var name = self._readCString(emu, args[1]);
                // Check if we already have a stub for this symbol
                var existing = self._dlsymStubs.get(name);
                if (existing) return existing;
                // Check if it's a shimmed function we know about
                if (self.engine._findShimForName && self.engine._findShimForName(name)) {
                    var addr = self.engine._findShimForName(name);
                    Logger.info('[dlsym] ' + name + ' → shim 0x' + (addr>>>0).toString(16));
                    self._dlsymStubs.set(name, addr);
                    return addr;
                }
                // Check if it's an exported symbol in the binary
                if (self.engine.elf && self.engine.elf.exports) {
                    var sym = self.engine.elf.exports[name];
                    if (sym && sym.value) {
                        var addr = self.engine.BASE + sym.value;
                        Logger.info('[dlsym] ' + name + ' → binary 0x' + (addr>>>0).toString(16));
                        self._dlsymStubs.set(name, addr);
                        return addr;
                    }
                }
                // Allocate a generic stub that returns 0 (better than NULL pointer)
                var stubAddr = self._nextDlsymAddr;
                self._nextDlsymAddr += 8;
                try {
                    self.engine.emu.mem_write(stubAddr, [
                        0x00, 0x00, 0xA0, 0xE3,  // MOV R0, #0
                        0x1E, 0xFF, 0x2F, 0xE1   // BX LR
                    ]);
                } catch(e) {}
                self._dlsymStubs.set(name, stubAddr);
                Logger.info('[dlsym] ' + name + ' → new stub 0x' + (stubAddr>>>0).toString(16));
                return stubAddr;
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

            // C++ RTTI dynamic_cast — returns dest_ptr or NULL
            '__dynamic_cast': function(emu, args) {
                // args: [src_ptr, src_type, dst_type, offset]
                // In a single-threaded emulator, just return the source pointer
                // (acts like static_cast — good enough for most game code)
                return args[0];
            },

            // C++ exception handling
            '_ZSt9terminatev': function(emu, args) {
                Logger.error('[C++] std::terminate() called!');
                return 0;
            },
            '__cxa_pure_virtual': function(emu, args) {
                Logger.error('[C++] Pure virtual call!');
                return 0;
            },
            '__cxa_atexit': function(emu, args) { return 0; },
            '__cxa_guard_acquire': function(emu, args) {
                // Static local variable guard — check if already initialized
                if (args[0]) {
                    try {
                        var guardBuf = self.engine.emu.mem_read(args[0], 1);
                        if (guardBuf[0] !== 0) return 0; // already initialized
                        self.engine.emu.mem_write(args[0], [1]); // mark as initializing
                    } catch(e) {}
                }
                return 1; // needs initialization
            },
            '__cxa_guard_release': function(emu, args) { return 0; },
            '__cxa_guard_abort':   function(emu, args) { return 0; },

            // ============================================
            // Compression (zlib stubs)
            // ============================================
            'inflate':       function(emu, args) { return 0; },
            'inflateInit2_': function(emu, args) { return 0; },
            'inflateEnd':    function(emu, args) { return 0; },
            'inflateReset':  function(emu, args) { return 0; },
            'inflateInit_':  function(emu, args) { return 0; },
            'deflate':       function(emu, args) { return 0; },
            'deflateInit_':  function(emu, args) { return 0; },
            'deflateInit2_': function(emu, args) { return 0; },
            'deflateEnd':    function(emu, args) { return 0; },
            'deflateReset':  function(emu, args) { return 0; },
            'compressBound': function(emu, args) { return (args[0] || 0) + 128; },
            'compress':      function(emu, args) { return 0; },
            'compress2':     function(emu, args) { return 0; },
            'uncompress':    function(emu, args) { return 0; },
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

            // v28: Directory enumeration backed by VFS
            'opendir': function(emu, args) {
                var path = self._readCString(emu, args[0]);
                Logger.info('[opendir] ATTEMPT: "' + path + '"');

                if (!self.vfs || !path) return 0;

                // Normalize: ensure path ends with /
                var dirPath = path.replace(/\/+$/, '') + '/';
                var normalized = self.vfs._normalizePath(dirPath);

                // Collect filenames in this directory from VFS
                var entries = [];
                var seen = {};
                for (var entry of self.vfs._files) {
                    var key = entry[0]; // normalized VFS path
                    if (key.indexOf(normalized) === 0) {
                        // key starts with our dir path — extract the relative part
                        var relative = key.substring(normalized.length);
                        // Only direct children (no sub-slash), skip empty
                        var slashIdx = relative.indexOf('/');
                        var childName;
                        if (slashIdx < 0) {
                            childName = relative; // file
                        } else {
                            childName = relative.substring(0, slashIdx); // subdirectory
                        }
                        if (childName && !seen[childName]) {
                            seen[childName] = true;
                            entries.push(childName);
                        }
                    }
                }

                if (entries.length === 0) {
                    Logger.info('[opendir] MISS (no entries): "' + path + '" normalized="' + normalized + '"');
                    return 0; // NULL — directory not found
                }

                var handle = self._nextDirHandle++;
                self._dirHandles.set(handle, { path: path, entries: entries, index: 0 });
                Logger.info('[opendir] HIT: "' + path + '" → handle=0x' + handle.toString(16) + ' (' + entries.length + ' entries: ' + entries.slice(0, 10).join(', ') + (entries.length > 10 ? '...' : '') + ')');
                return handle;
            },

            'readdir': function(emu, args) {
                var handle = args[0];
                var dir = self._dirHandles.get(handle);
                if (!dir) return 0; // NULL — end of directory or invalid

                if (dir.index >= dir.entries.length) {
                    return 0; // NULL — no more entries
                }

                var name = dir.entries[dir.index++];

                // Allocate a persistent dirent buffer if we haven't yet
                // ARM dirent struct: d_ino(4) + d_off(4) + d_reclen(2) + d_type(1) + d_name(256)
                if (!self._direntBuf) {
                    self._direntBuf = self.malloc(280);
                }
                var buf = self._direntBuf;

                // Write dirent struct
                var bytes = [];
                // d_ino (4 bytes) — fake inode
                bytes.push(dir.index & 0xFF, (dir.index >> 8) & 0xFF, 0, 0);
                // d_off (4 bytes) — fake offset
                bytes.push(dir.index & 0xFF, 0, 0, 0);
                // d_reclen (2 bytes)
                var reclen = 11 + name.length + 1; // header + name + null
                bytes.push(reclen & 0xFF, (reclen >> 8) & 0xFF);
                // d_type (1 byte) — DT_REG=8 for files, DT_DIR=4 for dirs
                bytes.push(8);
                // d_name (null-terminated string)
                for (var i = 0; i < name.length; i++) {
                    bytes.push(name.charCodeAt(i) & 0xFF);
                }
                bytes.push(0); // null terminator
                // Pad to 280 bytes total
                while (bytes.length < 280) bytes.push(0);

                emu.mem_write(buf, bytes);

                if (dir.index <= 5) {
                    Logger.info('[readdir] handle=0x' + handle.toString(16) + ' → "' + name + '" (' + dir.index + '/' + dir.entries.length + ')');
                }

                return buf;
            },

            'closedir': function(emu, args) {
                var handle = args[0];
                if (self._dirHandles.has(handle)) {
                    Logger.info('[closedir] handle=0x' + handle.toString(16));
                    self._dirHandles.delete(handle);
                }
                return 0;
            },
            // ============================================
            // v26: Missing critical libc/ctype/C++ functions
            // ============================================
            'tolower': function(emu, args) {
                var c = args[0] & 0xFF;
                if (c >= 0x41 && c <= 0x5A) return c + 0x20; // A-Z → a-z
                return c;
            },
            'toupper': function(emu, args) {
                var c = args[0] & 0xFF;
                if (c >= 0x61 && c <= 0x7A) return c - 0x20; // a-z → A-Z
                return c;
            },
            'isprint': function(emu, args) {
                var c = args[0] & 0xFF;
                return (c >= 0x20 && c <= 0x7E) ? 1 : 0;
            },
            'isspace': function(emu, args) {
                var c = args[0] & 0xFF;
                return (c === 0x20 || c === 0x09 || c === 0x0A || c === 0x0B || c === 0x0C || c === 0x0D) ? 1 : 0;
            },
            'isdigit': function(emu, args) {
                var c = args[0] & 0xFF;
                return (c >= 0x30 && c <= 0x39) ? 1 : 0;
            },
            'isalpha': function(emu, args) {
                var c = args[0] & 0xFF;
                return ((c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A)) ? 1 : 0;
            },
            'isalnum': function(emu, args) {
                var c = args[0] & 0xFF;
                return ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A)) ? 1 : 0;
            },
            'strspn': function(emu, args) {
                var str = self._readCString(emu, args[0]);
                var accept = self._readCString(emu, args[1]);
                var i = 0;
                while (i < str.length && accept.indexOf(str[i]) >= 0) i++;
                return i;
            },
            'strcspn': function(emu, args) {
                var str = self._readCString(emu, args[0]);
                var reject = self._readCString(emu, args[1]);
                var i = 0;
                while (i < str.length && reject.indexOf(str[i]) < 0) i++;
                return i;
            },
            'basename': function(emu, args) {
                var path = self._readCString(emu, args[0]);
                var idx = path.lastIndexOf('/');
                if (idx >= 0) return args[0] + idx + 1;
                return args[0];
            },
            'clearerr': function(emu, args) { return 0; },
            'rewind': function(emu, args) { return 0; },
            'fdopen': function(emu, args) { return 0; },
            'chmod': function(emu, args) { return 0; },
            'bsd_signal': function(emu, args) { return 0; },
            'gethostname': function(emu, args) {
                var name = 'localhost';
                if (args[0] && args[1] > 0) {
                    try {
                        var bytes = [];
                        for (var i = 0; i < name.length; i++) bytes.push(name.charCodeAt(i));
                        bytes.push(0);
                        emu.mem_write(args[0], bytes);
                    } catch(e) {}
                }
                return 0;
            },
            'gethostbyname': function(emu, args) {
                // Return NULL — getaddrinfo is the preferred path
                return 0;
            },
            'getnameinfo': function(emu, args) { return -1; },
            'recvfrom': function(emu, args) {
                var fd = args[0], bufPtr = args[1], len = args[2];
                var sock = self._virtualSockets[fd];
                if (!sock || !sock.recvBuf) return -1;
                var available = sock.recvBuf.length - sock.recvOffset;
                if (available <= 0) return 0;
                var toRead = Math.min(len, available);
                try {
                    emu.mem_write(bufPtr, Array.from(sock.recvBuf.slice(sock.recvOffset, sock.recvOffset + toRead)));
                    sock.recvOffset += toRead;
                } catch(e) { return -1; }
                return toRead;
            },
            'sendto': function(emu, args) {
                var fd = args[0], bufPtr = args[1], len = args[2];
                var sock = self._virtualSockets[fd];
                if (!sock) return -1;
                try {
                    var data = emu.mem_read(bufPtr, len);
                    for (var i = 0; i < data.length; i++) sock.sendBuf.push(data[i]);
                } catch(e) { return -1; }
                self._tryProcessHttpRequest(sock);
                return len;
            },
            'socketpair': function(emu, args) { return -1; },
            'waitpid': function(emu, args) { return -1; },
            'kill': function(emu, args) { return 0; },
            'fork': function(emu, args) { return -1; },
            'execl': function(emu, args) { return -1; },
            'mlock': function(emu, args) { return 0; },
            'madvise': function(emu, args) { return 0; },
            'getuid': function(emu, args) { return 10000; },
            'getgid': function(emu, args) { return 10000; },
            'getegid': function(emu, args) { return 10000; },
            'geteuid': function(emu, args) { return 10000; },
            'pthread_equal': function(emu, args) { return (args[0] === args[1]) ? 1 : 0; },
            '__assert2': function(emu, args) {
                var file = self._readCString(emu, args[0]);
                var line = args[1];
                var func = self._readCString(emu, args[2]);
                var expr = self._readCString(emu, args[3]);
                Logger.warn('[ASSERT] ' + file + ':' + line + ' ' + func + '(): ' + expr);
                return 0;
            },
            'dl_unwind_find_exidx': function(emu, args) {
                // ARM exception table lookup — return 0 (not found) with count 0
                if (args[1]) {
                    try { emu.mem_write(args[1], [0, 0, 0, 0]); } catch(e) {}
                }
                return 0;
            },
            '__cxa_rethrow': function(emu, args) {
                Logger.warn('[C++ rethrow — suppressed]');
                return 0;
            },

            // ============================================
            // v26: C++ standard library (libc++/ndk)
            // ============================================
            // std::random_device
            '_ZNSt6__ndk113random_deviceC1ERKNS_12basic_stringIcNS_11char_traitsIcEENS_9allocatorIcEEEE': function(emu, args) { return 0; },
            '_ZNSt6__ndk113random_deviceclEv': function(emu, args) {
                return (Math.random() * 0xFFFFFFFF) >>> 0;
            },
            '_ZNSt6__ndk113random_deviceD1Ev': function(emu, args) { return 0; },
            // std::to_string variants
            '_ZNSt6__ndk19to_stringEi': function(emu, args) {
                var val = args[0] | 0; // signed
                var str = val.toString();
                var ptr = self.malloc(str.length + 1);
                self._writeStringToMem(emu, ptr, str);
                // libc++ small string layout: ptr at this+0, size at this+4, capacity at this+8
                // But actually the return is via hidden pointer in R0
                return ptr;
            },
            '_ZNSt6__ndk19to_stringEj': function(emu, args) {
                var val = args[0] >>> 0;
                var str = val.toString();
                var ptr = self.malloc(str.length + 1);
                self._writeStringToMem(emu, ptr, str);
                return ptr;
            },
            '_ZNSt6__ndk19to_stringEx': function(emu, args) {
                // long long — use R0 as low 32 bits
                var val = args[0] | 0;
                var str = val.toString();
                var ptr = self.malloc(str.length + 1);
                self._writeStringToMem(emu, ptr, str);
                return ptr;
            },
            // std::mutex
            '_ZNSt6__ndk15mutexD1Ev': function(emu, args) { return 0; },
            // std::condition_variable
            '_ZNSt6__ndk118condition_variableD1Ev': function(emu, args) { return 0; },
            '_ZNSt6__ndk118condition_variable10notify_allEv': function(emu, args) { return 0; },
            '_ZNSt6__ndk118condition_variable10notify_oneEv': function(emu, args) { return 0; },
            '_ZNSt6__ndk118condition_variable4waitERNS_11unique_lockINS_5mutexEEE': function(emu, args) { return 0; },
            // std::locale
            '_ZNSt6__ndk16localeC1Ev': function(emu, args) { return 0; },
            '_ZNKSt6__ndk16locale4nameEv': function(emu, args) {
                var str = 'C';
                var ptr = self.malloc(str.length + 1);
                self._writeStringToMem(emu, ptr, str);
                return ptr;
            },
            // std::shared_weak_count
            '_ZNSt6__ndk119__shared_weak_count4lockEv': function(emu, args) { return args[0]; },
            // std::logic_error
            '_ZNSt11logic_errorC2EPKc': function(emu, args) { return 0; },
            // std::regex_error
            '_ZNSt6__ndk111regex_errorC1ENS_15regex_constants10error_typeE': function(emu, args) { return 0; },
            // std::ios_base
            '_ZNSt6__ndk18ios_baseD2Ev': function(emu, args) { return 0; },
            '_ZNSt6__ndk18ios_base33__set_badbit_and_consider_rethrowEv': function(emu, args) { return 0; },
            // collation/classname helpers
            '_ZNSt6__ndk120__get_collation_nameEPKc': function(emu, args) { return args[0]; },
            '_ZNSt6__ndk115__get_classnameEPKcb': function(emu, args) { return args[0]; },

            // ============================================
            // v26b: Remaining critical unresolved functions
            // ============================================
            // EA::Nimble::getEnv() — returns JNIEnv* pointer (critical for Nimble!)
            '_ZN2EA6Nimble6getEnvEv': function(emu, args) {
                Logger.info('[Nimble] getEnv() → returning JNIEnv=0xD0000000');
                return 0xD0000000; // JNIEnv base address
            },
            // std::thread
            '_ZNSt6__ndk16threadD1Ev': function(emu, args) { return 0; }, // ~thread()
            '_ZNSt6__ndk115__thread_structC1Ev': function(emu, args) { return 0; }, // __thread_struct()
            '_ZNSt6__ndk115__thread_structD1Ev': function(emu, args) { return 0; }, // ~__thread_struct()
            '_ZNSt6__ndk16thread6detachEv': function(emu, args) { return 0; }, // thread::detach()
            '_ZNSt6__ndk16thread20hardware_concurrencyEv': function(emu, args) { return 4; }, // thread::hardware_concurrency()
            // std::this_thread::sleep_for
            '_ZNSt6__ndk111this_thread9sleep_forERKNS_6chrono8durationIxNS_5ratioILx1ELx1000000000EEEEE': function(emu, args) { return 0; },
            // std::to_string(unsigned long long)
            '_ZNSt6__ndk19to_stringEy': function(emu, args) {
                var val = args[0] >>> 0;
                var str = val.toString();
                var ptr = self.malloc(str.length + 1);
                self._writeStringToMem(emu, ptr, str);
                return ptr;
            },
            // std::__throw_system_error
            '_ZNSt6__ndk120__throw_system_errorEiPKc': function(emu, args) {
                var msg = self._readCString(emu, args[1]);
                Logger.warn('[C++ system_error: ' + args[0] + ' ' + msg + ']');
                return 0;
            },
            // time_get::get (locale-aware time parsing — stub)
            '_ZNKSt6__ndk18time_getIcNS_19istreambuf_iteratorIcNS_11char_traitsIcEEEEE3getES4_S4_RNS_8ios_baseERjP2tmPKcSC_': function(emu, args) { return 0; },
            // std::__throw_bad_function_call
            '_ZSt18__throw_bad_function_callv': function(emu, args) {
                Logger.warn('[C++ bad_function_call]');
                return 0;
            },
            // EA::Nimble::findClass(const char*) — CRITICAL: Returns JNI class ref
            '_ZN2EA6Nimble9findClassEPKc': function(emu, args) {
                var className = self._readCString(emu, args[0]);
                // Use the JNI bridge to find/create the class
                var classId = 0;
                if (self.engine && self.engine.jni) {
                    classId = self.engine.jni._getOrCreateClass(className.replace(/\./g, '/'));
                }
                Logger.info('[Nimble] findClass("' + className + '") → 0x' + (classId>>>0).toString(16));
                return classId;
            },
            // std::uncaught_exception()
            '_ZSt18uncaught_exceptionv': function(emu, args) { return 0; },
            // std::__thread_local_data() — returns a thread-local storage pointer
            '_ZNSt6__ndk119__thread_local_dataEv': function(emu, args) {
                if (!self._threadLocalData) {
                    self._threadLocalData = self.malloc(256); // allocate TLS block
                    // Zero it
                    try {
                        var zeros = new Array(256);
                        for (var i = 0; i < 256; i++) zeros[i] = 0;
                        self.engine.emu.mem_write(self._threadLocalData, zeros);
                    } catch(e) {}
                }
                return self._threadLocalData;
            },
            // std::chrono::steady_clock::now()
            '_ZNSt6__ndk16chrono12steady_clock3nowEv': function(emu, args) {
                // Returns time_point as nanoseconds since epoch
                // On ARM, 64-bit return in R0 (low) and R1 (high)
                var nowNs = Date.now() * 1000000; // ms → ns
                var low = nowNs & 0xFFFFFFFF;
                var high = Math.floor(nowNs / 0x100000000) & 0xFFFFFFFF;
                // Write R1 for the high part
                try {
                    self.engine.emu.reg_write(1, [
                        (high) & 0xFF, (high >> 8) & 0xFF,
                        (high >> 16) & 0xFF, (high >> 24) & 0xFF
                    ]);
                } catch(e) {}
                return low; // R0 = low part
            },
            // std::condition_variable::__do_timed_wait
            '_ZNSt6__ndk118condition_variable15__do_timed_waitERNS_11unique_lockINS_5mutexEEENS_6chrono10time_pointINS5_12system_clockENS5_8durationIxNS_5ratioILx1ELx1000000000EEEEEEE': function(emu, args) {
                return 0; // Return 0 (no timeout)
            },
            // operator new(size_t, nothrow_t) — non-throwing new
            '_ZnwjRKSt9nothrow_t': function(emu, args) {
                var size = args[0] || 16;
                return self.malloc(size);
            },
            // libc
            'modf': function(emu, args) {
                // modf(double, double*) — split into integer and fractional parts
                // ARM: double in R0:R1, ptr in R2
                // Just return 0.0 (fractional part) and store 0.0 at ptr
                if (args[2]) {
                    try { self.engine.emu.mem_write(args[2], [0,0,0,0,0,0,0,0]); } catch(e) {}
                }
                return 0;
            },
            'fsync': function(emu, args) { return 0; },
            'fchown': function(emu, args) { return 0; },
            'utimes': function(emu, args) { return 0; },

            // ============================================
            // v25: VIRTUAL SOCKET LAYER — HTTP networking
            // ============================================
            'socket': function(emu, args) {
                var domain = args[0], type = args[1], protocol = args[2];
                var fd = self._nextSocketFd++;
                self._virtualSockets[fd] = {
                    state: 'created',
                    host: '',
                    port: 0,
                    sendBuf: [],      // accumulated bytes from send()
                    recvBuf: null,    // Uint8Array of HTTP response
                    recvOffset: 0,
                    requestDone: false
                };
                Logger.info('[NET] socket() → fd=' + fd + ' (domain=' + domain + ' type=' + type + ')');
                return fd;
            },
            'connect': function(emu, args) {
                var fd = args[0], addrPtr = args[1], addrLen = args[2];
                var sock = self._virtualSockets[fd];
                if (!sock) { Logger.warn('[NET] connect() unknown fd=' + fd); return -1; }
                try {
                    var data = emu.mem_read(addrPtr, 16);
                    // sockaddr_in: family(2 LE) + port(2 BE) + ip(4)
                    var port = (data[2] << 8) | data[3];
                    var ip = data[4] + '.' + data[5] + '.' + data[6] + '.' + data[7];
                    sock.host = ip;
                    sock.port = port;
                    sock.state = 'connected';
                    Logger.info('[NET] connect() fd=' + fd + ' → ' + ip + ':' + port);
                } catch(e) {
                    sock.state = 'connected';
                    Logger.warn('[NET] connect() fd=' + fd + ' could not parse addr');
                }
                return 0; // success
            },
            'send': function(emu, args) {
                var fd = args[0], bufPtr = args[1], len = args[2], flags = args[3];
                var sock = self._virtualSockets[fd];
                if (!sock) return -1;
                try {
                    var data = emu.mem_read(bufPtr, len);
                    for (var i = 0; i < data.length; i++) sock.sendBuf.push(data[i]);
                } catch(e) { return -1; }

                // Check if we have a complete HTTP request
                self._tryProcessHttpRequest(sock);
                return len;
            },
            'recv': function(emu, args) {
                var fd = args[0], bufPtr = args[1], len = args[2], flags = args[3];
                var sock = self._virtualSockets[fd];
                if (!sock) return -1;

                // If request wasn't processed yet, try now
                if (!sock.recvBuf) self._tryProcessHttpRequest(sock);

                if (!sock.recvBuf) {
                    // Still no response — return 0 (connection closed gracefully)
                    return 0;
                }

                var available = sock.recvBuf.length - sock.recvOffset;
                if (available <= 0) return 0; // EOF

                var toRead = Math.min(len, available);
                try {
                    var slice = sock.recvBuf.slice(sock.recvOffset, sock.recvOffset + toRead);
                    emu.mem_write(bufPtr, Array.from(slice));
                    sock.recvOffset += toRead;
                } catch(e) { return -1; }
                return toRead;
            },
            'write': function(emu, args) {
                // write() can be used on sockets or VFS file descriptors
                var fd = args[0], bufPtr = args[1], len = args[2];
                var sock = self._virtualSockets[fd];
                if (sock) {
                    try {
                        var data = emu.mem_read(bufPtr, len);
                        for (var i = 0; i < data.length; i++) sock.sendBuf.push(data[i]);
                    } catch(e) { return -1; }
                    self._tryProcessHttpRequest(sock);
                    return len;
                }
                // VFS file write — just pretend we wrote it
                return len;
            },
            'read': function(emu, args) {
                // read() can be used on sockets or VFS file descriptors
                var fd = args[0], bufPtr = args[1], len = args[2];
                var sock = self._virtualSockets[fd];
                if (sock) {
                    if (!sock.recvBuf) self._tryProcessHttpRequest(sock);
                    if (!sock.recvBuf) return 0;
                    var available = sock.recvBuf.length - sock.recvOffset;
                    if (available <= 0) return 0;
                    var toRead = Math.min(len, available);
                    try {
                        var slice = sock.recvBuf.slice(sock.recvOffset, sock.recvOffset + toRead);
                        emu.mem_write(bufPtr, Array.from(slice));
                        sock.recvOffset += toRead;
                    } catch(e) { return -1; }
                    return toRead;
                }
                // VFS file read
                if (self.vfs && fd >= 100) {
                    var result = self.vfs.fread(fd, bufPtr, 1, len, emu);
                    // v27e: Log POSIX read() on VFS files
                    if (self._posixReadLogCount === undefined) self._posixReadLogCount = 0;
                    if (self._posixReadLogCount < 50) {
                        self._posixReadLogCount++;
                        Logger.info('[read] fd=' + fd + ' len=' + len + ' → ' + result + ' bytes');
                    }
                    return result;
                }
                return 0;
            },
            'close': function(emu, args) {
                var fd = args[0];
                if (self._virtualSockets[fd]) {
                    delete self._virtualSockets[fd];
                    return 0;
                }
                // VFS file close
                if (self.vfs && fd >= 100) {
                    return self.vfs.fclose(fd);
                }
                return 0;
            },
            'shutdown': function(emu, args) { return 0; },
            'bind': function(emu, args) { return 0; },
            'listen': function(emu, args) { return 0; },
            'accept': function(emu, args) { return -1; },
            'select': function(emu, args) {
                // Check if any virtual sockets have data ready
                // nfds=args[0], readfds=args[1], writefds=args[2], exceptfds=args[3], timeout=args[4-5]
                // Return 1 to indicate ready (simplified)
                return 1;
            },
            'poll': function(emu, args) {
                // Return 1 to indicate ready events
                var fds_ptr = args[0], nfds = args[1];
                if (fds_ptr && nfds > 0) {
                    try {
                        // Set revents = POLLIN | POLLOUT (0x0001 | 0x0004 = 0x0005)
                        // struct pollfd: int fd(4) + short events(2) + short revents(2)
                        for (var i = 0; i < nfds; i++) {
                            emu.mem_write(fds_ptr + i * 8 + 6, [0x05, 0x00]);
                        }
                    } catch(e) {}
                }
                return nfds > 0 ? 1 : 0;
            },
            'setsockopt': function(emu, args) { return 0; },
            'getsockopt': function(emu, args) { return 0; },
            'getaddrinfo': function(emu, args) {
                // args: node(R0), service(R1), hints(R2), res_ptr(R3)
                var nodePtr = args[0], servicePtr = args[1], hintsPtr = args[2], resPtr = args[3];
                var hostname = nodePtr ? self._readCString(emu, nodePtr) : '';
                var service = servicePtr ? self._readCString(emu, servicePtr) : '80';
                var port = parseInt(service) || 80;

                Logger.info('[NET] getaddrinfo("' + hostname + '", "' + service + '")');

                // Allocate addrinfo struct (32 bytes) + sockaddr_in (16 bytes)
                var aiAddr = self.malloc(32 + 16);
                if (!aiAddr) return -1; // EAI_MEMORY
                var saAddr = aiAddr + 32;

                // Write sockaddr_in at saAddr
                var portHi = (port >> 8) & 0xFF, portLo = port & 0xFF;
                // Use 10.0.0.1 as virtual IP for all resolutions
                emu.mem_write(saAddr, [
                    2, 0,           // sin_family = AF_INET (little-endian)
                    portHi, portLo, // sin_port (network byte order = big-endian)
                    10, 0, 0, 1,    // sin_addr = 10.0.0.1
                    0, 0, 0, 0, 0, 0, 0, 0  // sin_zero
                ]);

                // Write addrinfo struct at aiAddr
                // ai_flags=0, ai_family=AF_INET=2, ai_socktype=SOCK_STREAM=1, ai_protocol=IPPROTO_TCP=6
                // ai_addrlen=16, ai_addr=saAddr, ai_canonname=0, ai_next=0
                var saBytes = [
                    saAddr & 0xFF, (saAddr >> 8) & 0xFF,
                    (saAddr >> 16) & 0xFF, (saAddr >> 24) & 0xFF
                ];
                emu.mem_write(aiAddr, [
                    0, 0, 0, 0,     // ai_flags = 0
                    2, 0, 0, 0,     // ai_family = AF_INET
                    1, 0, 0, 0,     // ai_socktype = SOCK_STREAM
                    6, 0, 0, 0,     // ai_protocol = IPPROTO_TCP
                    16, 0, 0, 0,    // ai_addrlen = 16
                    saBytes[0], saBytes[1], saBytes[2], saBytes[3], // ai_addr ptr
                    0, 0, 0, 0,     // ai_canonname = NULL
                    0, 0, 0, 0      // ai_next = NULL
                ]);

                // Write pointer to addrinfo at *res
                if (resPtr) {
                    emu.mem_write(resPtr, [
                        aiAddr & 0xFF, (aiAddr >> 8) & 0xFF,
                        (aiAddr >> 16) & 0xFF, (aiAddr >> 24) & 0xFF
                    ]);
                }

                return 0; // success
            },
            'freeaddrinfo': function(emu, args) {
                if (args[0]) self.free(args[0]);
                return 0;
            },
            'gai_strerror': function(emu, args) {
                return self.storeString('Unknown error');
            },
            'inet_addr': function(emu, args) {
                var str = args[0] ? self._readCString(emu, args[0]) : '';
                var parts = str.split('.');
                if (parts.length === 4) {
                    return ((parseInt(parts[0]) & 0xFF)) |
                           ((parseInt(parts[1]) & 0xFF) << 8) |
                           ((parseInt(parts[2]) & 0xFF) << 16) |
                           ((parseInt(parts[3]) & 0xFF) << 24);
                }
                return 0xFFFFFFFF;
            },
            'inet_pton': function(emu, args) {
                var af = args[0], srcPtr = args[1], dstPtr = args[2];
                if (af === 2 && srcPtr && dstPtr) { // AF_INET
                    var str = self._readCString(emu, srcPtr);
                    var parts = str.split('.');
                    if (parts.length === 4) {
                        emu.mem_write(dstPtr, [
                            parseInt(parts[0]) & 0xFF, parseInt(parts[1]) & 0xFF,
                            parseInt(parts[2]) & 0xFF, parseInt(parts[3]) & 0xFF
                        ]);
                        return 1; // success
                    }
                }
                return 0;
            },
            'inet_ntop': function(emu, args) {
                var af = args[0], srcPtr = args[1], dstPtr = args[2], size = args[3];
                if (af === 2 && srcPtr && dstPtr) { // AF_INET
                    try {
                        var bytes = emu.mem_read(srcPtr, 4);
                        var str = bytes[0] + '.' + bytes[1] + '.' + bytes[2] + '.' + bytes[3];
                        var out = [];
                        for (var i = 0; i < str.length; i++) out.push(str.charCodeAt(i));
                        out.push(0);
                        emu.mem_write(dstPtr, out);
                        return dstPtr;
                    } catch(e) {}
                }
                return 0;
            },
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
            'getsockname': function(emu, args) {
                // Fill in a dummy local address
                var fd = args[0], addrPtr = args[1], lenPtr = args[2];
                if (addrPtr) {
                    try {
                        emu.mem_write(addrPtr, [2, 0, 0, 0, 127, 0, 0, 1, 0,0,0,0,0,0,0,0]);
                        if (lenPtr) emu.mem_write(lenPtr, [16, 0, 0, 0]);
                    } catch(e) {}
                }
                return 0;
            },
            'getpeername': function(emu, args) {
                var fd = args[0], addrPtr = args[1], lenPtr = args[2];
                var sock = self._virtualSockets[fd];
                if (addrPtr && sock) {
                    try {
                        var port = sock.port || 80;
                        emu.mem_write(addrPtr, [2, 0, (port>>8)&0xFF, port&0xFF, 10, 0, 0, 1, 0,0,0,0,0,0,0,0]);
                        if (lenPtr) emu.mem_write(lenPtr, [16, 0, 0, 0]);
                    } catch(e) {}
                }
                return 0;
            },
            // ============================================
            // v25: SSL shims — intercept OpenSSL calls
            // Route SSL_write/SSL_read through virtual sockets
            // ============================================
            'SSL_library_init': function(emu, args) { return 1; },
            'SSL_load_error_strings': function(emu, args) { return 0; },
            'OPENSSL_add_all_algorithms_noconf': function(emu, args) { return 0; },
            'SSLv23_client_method': function(emu, args) { return self.malloc(8); },
            'TLS_client_method': function(emu, args) { return self.malloc(8); },
            'TLSv1_2_client_method': function(emu, args) { return self.malloc(8); },
            'SSL_CTX_new': function(emu, args) {
                var ctx = self.malloc(64);
                return ctx;
            },
            'SSL_CTX_free': function(emu, args) { return 0; },
            'SSL_CTX_set_verify': function(emu, args) { return 0; },
            'SSL_CTX_set_options': function(emu, args) { return 0; },
            'SSL_CTX_ctrl': function(emu, args) { return 0; },
            'SSL_CTX_set_cipher_list': function(emu, args) { return 1; },
            'SSL_CTX_load_verify_locations': function(emu, args) { return 1; },
            'SSL_CTX_set_default_verify_paths': function(emu, args) { return 1; },
            'SSL_new': function(emu, args) {
                // Allocate fake SSL struct, store the socket FD at offset 0
                var ssl = self.malloc(64);
                return ssl;
            },
            'SSL_free': function(emu, args) { return 0; },
            'SSL_set_fd': function(emu, args) {
                var ssl = args[0], fd = args[1];
                if (ssl) {
                    try { emu.mem_write(ssl, [fd & 0xFF, (fd >> 8) & 0xFF, (fd >> 16) & 0xFF, (fd >> 24) & 0xFF]); } catch(e) {}
                }
                return 1;
            },
            'SSL_connect': function(emu, args) { return 1; }, // success
            'SSL_get_error': function(emu, args) { return 0; }, // SSL_ERROR_NONE
            'SSL_write': function(emu, args) {
                // Route through virtual socket send
                var ssl = args[0], bufPtr = args[1], len = args[2];
                var fd = 0;
                if (ssl) {
                    try {
                        var fdBytes = emu.mem_read(ssl, 4);
                        fd = (fdBytes[0] | (fdBytes[1] << 8) | (fdBytes[2] << 16) | (fdBytes[3] << 24)) >>> 0;
                    } catch(e) {}
                }
                var sock = self._virtualSockets[fd];
                if (sock) {
                    try {
                        var data = emu.mem_read(bufPtr, len);
                        for (var i = 0; i < data.length; i++) sock.sendBuf.push(data[i]);
                    } catch(e) { return -1; }
                    self._tryProcessHttpRequest(sock);
                    return len;
                }
                return len; // pretend success
            },
            'SSL_read': function(emu, args) {
                // Route through virtual socket recv
                var ssl = args[0], bufPtr = args[1], len = args[2];
                var fd = 0;
                if (ssl) {
                    try {
                        var fdBytes = emu.mem_read(ssl, 4);
                        fd = (fdBytes[0] | (fdBytes[1] << 8) | (fdBytes[2] << 16) | (fdBytes[3] << 24)) >>> 0;
                    } catch(e) {}
                }
                var sock = self._virtualSockets[fd];
                if (sock) {
                    if (!sock.recvBuf) self._tryProcessHttpRequest(sock);
                    if (!sock.recvBuf) return 0;
                    var available = sock.recvBuf.length - sock.recvOffset;
                    if (available <= 0) return 0;
                    var toRead = Math.min(len, available);
                    try {
                        var slice = sock.recvBuf.slice(sock.recvOffset, sock.recvOffset + toRead);
                        emu.mem_write(bufPtr, Array.from(slice));
                        sock.recvOffset += toRead;
                    } catch(e) { return -1; }
                    return toRead;
                }
                return 0;
            },
            'SSL_shutdown': function(emu, args) { return 1; },
            'SSL_pending': function(emu, args) { return 0; },
            'SSL_get_verify_result': function(emu, args) { return 0; }, // X509_V_OK
            'ERR_error_string_n': function(emu, args) { return 0; },
            'ERR_get_error': function(emu, args) { return 0; },
            'ERR_clear_error': function(emu, args) { return 0; },
            'X509_free': function(emu, args) { return 0; },
            'SSL_get_peer_certificate': function(emu, args) { return 0; },

            'strerror': function(emu, args) {
                var ptr = self.storeString('Unknown error');
                return ptr;
            },
            'strerror_r': function(emu, args) { return -1; },
            'perror': function(emu, args) { return 0; },
            'exit': function(emu, args) {
                Logger.error('[exit] called with code ' + args[0] + ' — stopping emulation');
                try { self.engine.emu.emu_stop(); } catch(e) {}
                return 0;
            },
            '_exit': function(emu, args) {
                Logger.error('[_exit] called with code ' + args[0] + ' — stopping emulation');
                try { self.engine.emu.emu_stop(); } catch(e) {}
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

            // Network stubs (supplementary)
            'if_nametoindex': function(emu, args) { return 0; },

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
