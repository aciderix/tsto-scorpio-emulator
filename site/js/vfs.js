/**
 * TSTO Web Emulator — Virtual File System v15.2
 * 
 * Provides a virtual filesystem so ARM code (via fopen/fread/fclose/fseek/ftell)
 * can load shader files, configs, and assets served from the web deployment.
 * 
 * The game constructs paths like:
 *   /data/data/com.ea.game.simpsons4_row/files/core/res-core/2DShader.vsh
 * 
 * This VFS intercepts those paths and serves pre-loaded content.
 */

class VirtualFS {
    constructor() {
        // File content store: normalized path -> Uint8Array
        this._files = new Map();
        
        // Open file handles: fd -> { path, data, pos, size }
        this._handles = new Map();
        this._nextFd = 100; // Start at 100 to avoid confusion with 0/null
        
        // Path alias mappings (multiple game paths can map to same content)
        this._aliases = new Map();
        
        // Stats
        this.openCount = 0;
        this.readCount = 0;
        this.readBytes = 0;
        this.missCount = 0;
        this._openLog = [];    // Log of all fopen calls for debugging
        this._missLog = [];    // Log of files we couldn't serve
        
        Logger.info('[VFS] Virtual File System initialized');
    }

    /**
     * Register a file in the VFS
     * @param {string} path - The path the ARM code will use
     * @param {Uint8Array|string} content - File content (string will be converted to UTF-8 bytes)
     */
    addFile(path, content) {
        var data;
        if (typeof content === 'string') {
            // Convert string to Uint8Array (UTF-8)
            var bytes = [];
            for (var i = 0; i < content.length; i++) {
                var code = content.charCodeAt(i);
                if (code < 0x80) {
                    bytes.push(code);
                } else if (code < 0x800) {
                    bytes.push(0xC0 | (code >> 6));
                    bytes.push(0x80 | (code & 0x3F));
                } else {
                    bytes.push(0xE0 | (code >> 12));
                    bytes.push(0x80 | ((code >> 6) & 0x3F));
                    bytes.push(0x80 | (code & 0x3F));
                }
            }
            data = new Uint8Array(bytes);
        } else if (content instanceof Uint8Array) {
            data = content;
        } else if (content instanceof ArrayBuffer) {
            data = new Uint8Array(content);
        } else {
            Logger.warn('[VFS] Unknown content type for ' + path);
            return;
        }
        
        var normalized = this._normalizePath(path);
        this._files.set(normalized, data);
        Logger.info('[VFS] ✅ Registered: ' + normalized + ' (' + data.length + ' bytes)');
    }

    /**
     * Add a path alias: when ARM opens aliasPath, serve the same content as realPath
     */
    addAlias(aliasPath, realPath) {
        this._aliases.set(this._normalizePath(aliasPath), this._normalizePath(realPath));
    }

    /**
     * Register shader files under multiple possible game paths
     * The game may use different base directories depending on config
     */
    addShaderFile(filename, content) {
        // Common base paths the game might use
        var basePaths = [
            '/data/data/com.ea.game.simpsons4_row/files',
            '/data/data/com.ea.game.simpsons4_na/files',
            '/sdcard/Android/data/com.ea.game.simpsons4_row/files',
            '/sdcard/Android/data/com.ea.game.simpsons4_na/files',
            '/data/data/com.ea.game.simpsons4_row/cache',
            '',  // Relative path
        ];
        
        var fullPaths = [];
        for (var i = 0; i < basePaths.length; i++) {
            var base = basePaths[i];
            // The game uses: %s/core/res-core/%s.vsh (or .fsh)
            var fullPath = base + '/core/res-core/' + filename;
            fullPaths.push(fullPath);
            this.addFile(fullPath, content);
        }
        
        // Also register just the filename itself
        this.addFile(filename, content);
        this.addFile('core/res-core/' + filename, content);
        
        Logger.info('[VFS] 📦 Shader "' + filename + '" registered under ' + (fullPaths.length + 2) + ' paths');
    }

    /**
     * Check if a file exists in the VFS
     */
    exists(path) {
        var normalized = this._normalizePath(path);
        if (this._files.has(normalized)) return true;
        
        // Check aliases
        var aliased = this._aliases.get(normalized);
        if (aliased && this._files.has(aliased)) return true;
        
        // Try fuzzy matching on filename
        return this._fuzzyFind(normalized) !== null;
    }

    /**
     * Get file size
     */
    fileSize(path) {
        var data = this._resolveFile(path);
        return data ? data.length : -1;
    }

    // ================================================================
    // FILE OPERATIONS (used by android-shims fopen/fread/etc.)
    // ================================================================

    /**
     * Open a file — returns a fake file descriptor (fd), or 0 if not found
     */
    fopen(path, mode) {
        this._openLog.push({ path: path, mode: mode, time: Date.now() });
        
        var data = this._resolveFile(path);
        if (!data) {
            this.missCount++;
            if (this._missLog.length < 100) {
                this._missLog.push(path);
            }
            Logger.info('[VFS] ❌ fopen MISS: ' + path + ' mode=' + mode);
            return 0; // NULL — file not found
        }
        
        var fd = this._nextFd++;
        this._handles.set(fd, {
            path: path,
            data: data,
            pos: 0,
            size: data.length,
        });
        
        this.openCount++;
        Logger.info('[VFS] ✅ fopen: ' + path + ' → fd=' + fd + ' (' + data.length + ' bytes)');
        return fd;
    }

    /**
     * Read from a file handle
     * Returns: number of items actually read
     */
    fread(fd, destPtr, itemSize, itemCount, emu) {
        var handle = this._handles.get(fd);
        if (!handle) return 0;
        
        var totalBytes = itemSize * itemCount;
        var remaining = handle.size - handle.pos;
        var toRead = Math.min(totalBytes, remaining);
        
        if (toRead <= 0) return 0;
        
        // Write data from VFS to ARM emulator memory
        if (destPtr && emu) {
            try {
                // Read from our buffer
                var chunk = handle.data.slice(handle.pos, handle.pos + toRead);
                // Write to emu memory
                emu.mem_write(destPtr, Array.from(chunk));
            } catch (e) {
                Logger.warn('[VFS] fread write to emu failed: ' + e.message);
                return 0;
            }
        }
        
        handle.pos += toRead;
        this.readCount++;
        this.readBytes += toRead;
        
        // Return number of items read
        var itemsRead = Math.floor(toRead / itemSize);
        return itemsRead;
    }

    /**
     * Read a line from file (fgets-style)
     * Returns: pointer to buffer (destPtr) or 0 on EOF
     */
    fgets(fd, destPtr, maxLen, emu) {
        var handle = this._handles.get(fd);
        if (!handle || handle.pos >= handle.size) return 0;
        
        var line = [];
        var i = handle.pos;
        while (i < handle.size && line.length < maxLen - 1) {
            var byte = handle.data[i++];
            line.push(byte);
            if (byte === 0x0A) break; // newline
        }
        
        handle.pos = i;
        
        if (line.length === 0) return 0;
        
        // Write line + null terminator to ARM memory
        if (destPtr && emu) {
            try {
                line.push(0); // null terminator
                emu.mem_write(destPtr, line);
            } catch (e) {
                return 0;
            }
        }
        
        return destPtr;
    }

    /**
     * Seek in a file
     * whence: 0=SEEK_SET, 1=SEEK_CUR, 2=SEEK_END
     */
    fseek(fd, offset, whence) {
        var handle = this._handles.get(fd);
        if (!handle) return -1;
        
        var newPos;
        switch (whence) {
            case 0: // SEEK_SET
                newPos = offset;
                break;
            case 1: // SEEK_CUR
                newPos = handle.pos + offset;
                break;
            case 2: // SEEK_END
                newPos = handle.size + offset;
                break;
            default:
                return -1;
        }
        
        if (newPos < 0) newPos = 0;
        if (newPos > handle.size) newPos = handle.size;
        handle.pos = newPos;
        return 0; // success
    }

    /**
     * Get current position
     */
    ftell(fd) {
        var handle = this._handles.get(fd);
        return handle ? handle.pos : -1;
    }

    /**
     * Check if at end of file
     */
    feof(fd) {
        var handle = this._handles.get(fd);
        return handle ? (handle.pos >= handle.size ? 1 : 0) : 1;
    }

    /**
     * Close a file handle
     */
    fclose(fd) {
        if (this._handles.has(fd)) {
            this._handles.delete(fd);
            return 0;
        }
        return -1; // EOF/error
    }

    /**
     * stat() — fill a stat buffer
     * Returns 0 for known files, -1 otherwise
     */
    stat(path) {
        return this.exists(path) ? 0 : -1;
    }

    /**
     * access() — check if file exists
     * Returns 0 for known files, -1 otherwise
     */
    access(path) {
        return this.exists(path) ? 0 : -1;
    }

    // ================================================================
    // INTERNAL
    // ================================================================

    _normalizePath(path) {
        if (!path) return '';
        // v22: Strip "(null)/" prefix from paths (caused by NULL base dir pointer in ARM code)
        path = path.replace(/^\(null\)\/?/g, '');
        // Remove double slashes, trim
        path = path.replace(/\/+/g, '/').replace(/^\/+/, '/').trim();
        // If stripping left us with just a filename, prefix with /
        if (path && path[0] !== '/') path = '/' + path;
        return path;
    }

    _resolveFile(path) {
        var normalized = this._normalizePath(path);

        // Direct lookup
        if (this._files.has(normalized)) return this._files.get(normalized);

        // Alias lookup
        var aliased = this._aliases.get(normalized);
        if (aliased && this._files.has(aliased)) return this._files.get(aliased);

        // v22: Try prepending common base directories for relative paths
        // (handles NULL base dir producing paths like "/core/res-core/foo.vsh")
        var basePrefixes = [
            '/data/data/com.ea.game.simpsons4_row/files',
            '/data/data/com.ea.game.simpsons4_na/files',
            '/sdcard/Android/data/com.ea.game.simpsons4_row/files',
        ];
        for (var i = 0; i < basePrefixes.length; i++) {
            var candidate = basePrefixes[i] + normalized;
            if (this._files.has(candidate)) return this._files.get(candidate);
        }

        // Fuzzy match: try just the filename
        return this._fuzzyFind(normalized);
    }

    _fuzzyFind(path) {
        // Extract just the filename from the path
        var parts = path.split('/');
        var filename = parts[parts.length - 1];
        if (!filename) return null;
        
        // Look for any registered file ending with this filename in a matching subpath
        for (var entry of this._files) {
            var key = entry[0];
            if (key.endsWith('/' + filename) || key === filename) {
                return entry[1];
            }
        }
        
        // Try matching core/res-core/ subpath
        var coreIdx = path.indexOf('core/res-core/');
        if (coreIdx >= 0) {
            var subPath = path.substring(coreIdx);
            for (var entry of this._files) {
                if (entry[0].indexOf(subPath) >= 0) {
                    return entry[1];
                }
            }
        }
        
        return null;
    }

    // ================================================================
    // LOADING HELPERS
    // ================================================================

    /**
     * Load shader files from the web server and register them
     */
    async loadShaderFiles() {
        var files = ['2DShader.vsh', '2DShader.fsh', 'UberShader.vsh', 'UberShader.fsh'];
        var loaded = 0;
        
        for (var i = 0; i < files.length; i++) {
            var file = files[i];
            try {
                var resp = await fetch('assets/core/res-core/' + file);
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                var text = await resp.text();
                this.addShaderFile(file, text);
                loaded++;
            } catch (e) {
                Logger.warn('[VFS] Failed to load shader: ' + file + ' — ' + e.message);
            }
        }
        
        Logger.info('[VFS] 📦 Loaded ' + loaded + '/4 shader files');
        return loaded;
    }

    /**
     * Add a Shaders.xml config (game uses this to define shader variants)
     * We generate a basic one since the original isn't easily extractable
     */
    addShadersXml() {
        var xml = '<?xml version="1.0" encoding="utf-8"?>\n' +
            '<Shaders>\n' +
            '  <Shader name="2DShader" vs="2DShader.vsh" fs="2DShader.fsh">\n' +
            '    <Variant name="VertexColor" defines="DIFFUSEVERTEX"/>\n' +
            '    <Variant name="Textured" defines="DIFFUSETEXTURE"/>\n' +
            '    <Variant name="TexturedVertexColor" defines="DIFFUSETEXTURE,DIFFUSEVERTEX"/>\n' +
            '    <Variant name="UniformColor" defines="DIFFUSEUNIFORM"/>\n' +
            '  </Shader>\n' +
            '  <Shader name="UberShader" vs="UberShader.vsh" fs="UberShader.fsh">\n' +
            '    <Variant name="VertexColor" defines="DIFFUSEVERTEX"/>\n' +
            '    <Variant name="Textured" defines="DIFFUSETEXTURE"/>\n' +
            '    <Variant name="Full" defines="DIFFUSETEXTURE,DIFFUSEVERTEX"/>\n' +
            '  </Shader>\n' +
            '</Shaders>\n';
        
        // Register under various possible paths
        var basePaths = [
            '/data/data/com.ea.game.simpsons4_row/files',
            '/data/data/com.ea.game.simpsons4_na/files',
            '',
        ];
        for (var i = 0; i < basePaths.length; i++) {
            this.addFile(basePaths[i] + '/core/res-core/Shaders.xml', xml);
            this.addFile(basePaths[i] + '/Shaders.xml', xml);
        }
        this.addFile('Shaders.xml', xml);
        
        Logger.info('[VFS] 📄 Shaders.xml registered');
    }


    /**
     * Register a binary asset file under all possible game paths
     * @param {string} relativePath - e.g. "core/res-core/0"
     * @param {ArrayBuffer|Uint8Array} content - Binary file content
     */
    addAssetFile(relativePath, content) {
        var data = (content instanceof Uint8Array) ? content : new Uint8Array(content);
        
        var basePaths = [
            '/data/data/com.ea.game.simpsons4_row/files',
            '/data/data/com.ea.game.simpsons4_na/files',
            '/sdcard/Android/data/com.ea.game.simpsons4_row/files',
            '/sdcard/Android/data/com.ea.game.simpsons4_na/files',
            '/data/data/com.ea.game.simpsons4_row/cache',
            '',
        ];
        
        for (var i = 0; i < basePaths.length; i++) {
            var fullPath = basePaths[i] + '/' + relativePath;
            this._files.set(this._normalizePath(fullPath), data);
        }
        // Also register plain relative path
        this._files.set(this._normalizePath(relativePath), data);
        this._files.set(this._normalizePath('/' + relativePath), data);
        
        Logger.info('[VFS] 📦 Asset: ' + relativePath + ' (' + data.length + ' bytes) → ' + (basePaths.length + 2) + ' paths');
    }

    /**
     * Load ALL game assets from the web server (binary files)
     * This includes textures, meshes, audio, splash screens — everything the ARM code needs.
     */
    async loadAllAssets() {
        // All asset files from the APK (relative to assets/ on the server)
        var assetFiles = [
            // Core game data (textures, meshes, XML configs) — ESSENTIAL for rendering
            'core/res-core/0',          // Resource index (BGrm format)
            'core/res-core/1',          // Resource data (~10 MB)
            
            // Resolution-specific assets
            'core/core-large/0',
            'core/core-large/1',
            'core/core-medium/0',
            'core/core-medium/1',
            'core/core-medium-small/0',
            'core/core-medium-small/1',
            'core/core-small/0',
            'core/core-small/1',
            
            // Support data
            'core/support/0',
            'core/support/1',
            
            // Splash screens
            'core/core-splashes-large/0',
            'core/core-splashes-large/1',
            'core/core-splashes-medium/0',
            'core/core-splashes-medium/1',
            'core/core-splashes-small/0',
            'core/core-splashes-small/1',
            
            // Audio
            'audio/res-audio/0',
            'audio/res-audio/1',
        ];
        
        var loaded = 0;
        var failed = 0;
        var totalBytes = 0;
        
        Logger.info('[VFS] 🚀 Loading ' + assetFiles.length + ' game assets...');
        
        for (var i = 0; i < assetFiles.length; i++) {
            var assetPath = assetFiles[i];
            try {
                var resp = await fetch('assets/' + assetPath);
                if (!resp.ok) {
                    Logger.warn('[VFS] ⚠️ Asset not found: ' + assetPath + ' (HTTP ' + resp.status + ')');
                    failed++;
                    continue;
                }
                var buffer = await resp.arrayBuffer();

                // v35: Do NOT decompress data blob ZIPs — the BGrm reader has built-in
                // ZIP handling (inflate/uncompress) and expects the raw ZIP format.

                this.addAssetFile(assetPath, buffer);
                loaded++;
                totalBytes += buffer.byteLength;

                // Log progress for large files
                var sizeMB = (buffer.byteLength / 1048576).toFixed(1);
                Logger.info('[VFS] ✅ [' + (i+1) + '/' + assetFiles.length + '] ' + assetPath + ' (' + sizeMB + ' MB)');
            } catch (e) {
                Logger.warn('[VFS] ❌ Failed to load asset: ' + assetPath + ' — ' + e.message);
                failed++;
            }
        }
        
        var totalMB = (totalBytes / 1048576).toFixed(1);
        Logger.info('[VFS] 🎮 Assets loaded: ' + loaded + '/' + assetFiles.length + ' (' + totalMB + ' MB total, ' + failed + ' failed)');
        Logger.info('[VFS] 📊 Total VFS files registered: ' + this._files.size);
        return loaded;
    }


    // ================================================================
    // DEBUG
    // ================================================================

    getStats() {
        return {
            registeredFiles: this._files.size,
            openHandles: this._handles.size,
            opens: this.openCount,
            reads: this.readCount,
            bytesRead: this.readBytes,
            misses: this.missCount,
            missedPaths: this._missLog.slice(0, 20),
        };
    }

    getOpenLog() {
        return this._openLog;
    }
}

// Export
window.VirtualFS = VirtualFS;
