/**
 * TSTO Web Emulator — DLC Loader v1.0
 * 
 * Downloads DLC packages from the EA CDN (via Netlify proxy),
 * extracts nested ZIPs (outer ZIP → file "1" → inner ZIP → game files),
 * and registers them into the VFS.
 *
 * Architecture:
 *   1. Load dlc-manifest.json (local_dir → CDN proxy URL)
 *   2. On VFS miss, map the missed path to a DLC local_dir
 *   3. Download the DLC ZIP, extract the inner content
 *   4. Register all files into VFS under the correct game paths
 *   5. Retry the ARM init/frame that triggered the miss
 */

class DLCLoader {
    constructor(vfs) {
        this.vfs = vfs;
        this.manifest = null;        // local_dir → [{u: url, t: tier, l: lang}]
        this.loadedDirs = new Set();  // Already loaded local_dirs
        this.loading = new Map();     // Currently loading: local_dir → Promise
        this.stats = {
            packagesLoaded: 0,
            filesExtracted: 0,
            bytesDownloaded: 0,
            errors: 0,
        };
        
        // Preferred tiers/langs for this "device" (Android tablet, high-res)
        this.preferredTiers = ['all', '100', 'retina', 'mp3'];
        this.preferredLangs = ['all', 'en'];
        
        // Known base paths the game uses
        this.gameBasePaths = [
            '/data/data/com.ea.game.simpsons4_row/files/',
            '/data/data/com.ea.game.simpsons4_na/files/',
            '/sdcard/Android/data/com.ea.game.simpsons4_row/files/',
            '/sdcard/Android/data/com.ea.game.simpsons4_na/files/',
        ];
        
        Logger.info('[DLC] DLC Loader v1.0 initialized');
    }

    /**
     * Load the DLC manifest from the server
     */
    async loadManifest() {
        try {
            Logger.info('[DLC] Loading DLC manifest...');
            const resp = await fetch('dlc-manifest.json');
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            this.manifest = await resp.json();
            const dirCount = Object.keys(this.manifest).length;
            let pkgCount = 0;
            for (const k in this.manifest) pkgCount += this.manifest[k].length;
            Logger.success('[DLC] Manifest loaded: ' + dirCount + ' dirs, ' + pkgCount + ' packages');
            return true;
        } catch (e) {
            Logger.error('[DLC] Failed to load manifest: ' + e.message);
            return false;
        }
    }

    /**
     * Extract the DLC local_dir from a game file path.
     * e.g. "/data/data/com.ea.game.simpsons4_row/files/gamescripts/1/foo.mns"
     *   → tries: "gamescripts/1/foo.mns", "gamescripts/1", "gamescripts"
     */
    extractDLCDir(gamePath) {
        let relative = gamePath;
        
        // Strip known base paths
        for (const base of this.gameBasePaths) {
            if (gamePath.startsWith(base)) {
                relative = gamePath.substring(base.length);
                break;
            }
        }
        
        // Also try stripping "dlc/" prefix if present
        if (relative.startsWith('dlc/')) {
            relative = relative.substring(4);
        }
        
        // Strip leading slash
        if (relative.startsWith('/')) relative = relative.substring(1);
        
        // Try progressively shorter prefixes against manifest
        if (!this.manifest) return null;
        
        const parts = relative.split('/');
        
        // Try from longest to shortest prefix
        for (let i = parts.length - 1; i >= 1; i--) {
            const candidate = parts.slice(0, i).join('/');
            if (this.manifest[candidate]) return candidate;
        }
        
        // Try just the first segment (most common: "gamescripts", "textpools-en", etc.)
        if (parts.length >= 1 && this.manifest[parts[0]]) {
            return parts[0];
        }
        
        // Try first-segment with tier/lang suffixes
        // e.g. path has "buildstates/..." but manifest has "buildstates-100"
        if (parts.length >= 1) {
            const base = parts[0];
            for (const tier of this.preferredTiers) {
                const withTier = base + '-' + tier;
                if (this.manifest[withTier]) return withTier;
            }
            for (const lang of this.preferredLangs) {
                const withLang = base + '-' + lang;
                if (this.manifest[withLang]) return withLang;
            }
        }
        
        return null;
    }

    /**
     * Choose the best package from candidates based on tier/lang preference
     */
    chooseBestPackage(candidates) {
        // Prefer matching tier AND lang
        for (const pkg of candidates) {
            if (this.preferredTiers.includes(pkg.t) && this.preferredLangs.includes(pkg.l)) {
                return pkg;
            }
        }
        // Prefer matching tier
        for (const pkg of candidates) {
            if (this.preferredTiers.includes(pkg.t)) return pkg;
        }
        // Prefer matching lang
        for (const pkg of candidates) {
            if (this.preferredLangs.includes(pkg.l)) return pkg;
        }
        // Fallback: first
        return candidates[0];
    }

    /**
     * Download and extract a single DLC package into the VFS.
     * Returns the number of files extracted.
     */
    async loadPackage(localDir) {
        if (this.loadedDirs.has(localDir)) return 0;
        
        // Dedup concurrent loads
        if (this.loading.has(localDir)) {
            return this.loading.get(localDir);
        }
        
        const promise = this._doLoadPackage(localDir);
        this.loading.set(localDir, promise);
        
        try {
            const result = await promise;
            return result;
        } finally {
            this.loading.delete(localDir);
        }
    }

    async _doLoadPackage(localDir) {
        const candidates = this.manifest[localDir];
        if (!candidates || candidates.length === 0) {
            Logger.warn('[DLC] No packages for dir: ' + localDir);
            return 0;
        }
        
        const pkg = this.chooseBestPackage(candidates);
        Logger.info('[DLC] 📦 Downloading: ' + localDir + ' (tier=' + pkg.t + ', lang=' + pkg.l + ')');
        
        try {
            // Download the outer ZIP via Netlify proxy
            const resp = await fetch(pkg.u);
            if (!resp.ok) throw new Error('HTTP ' + resp.status + ' for ' + pkg.u);
            
            const outerData = await resp.arrayBuffer();
            this.stats.bytesDownloaded += outerData.byteLength;
            
            // Extract outer ZIP using JSZip
            const outerZip = await JSZip.loadAsync(outerData);
            
            // File "0" = BGrm header with local directory path
            // File "1" = Inner ZIP with actual game files
            const file0 = outerZip.file('0');
            const file1 = outerZip.file('1');
            
            if (!file1) {
                Logger.warn('[DLC] ⚠️ No file "1" in package: ' + localDir);
                // Maybe the outer zip directly contains game files
                return await this._extractDirectFiles(outerZip, localDir);
            }
            
            // Read header to get the exact local path
            let dlcSubDir = localDir;
            let headerData = null;
            if (file0) {
                try {
                    headerData = await file0.async('uint8array');
                    dlcSubDir = this._parseBGrmHeader(headerData) || localDir;
                } catch (e) {
                    Logger.warn('[DLC] Header parse failed, using: ' + localDir);
                }
            }

            // Extract inner ZIP
            const innerData = await file1.async('arraybuffer');

            // v31: Register the raw BGrm header (file "0") and data blob (file "1") in VFS.
            // The game uses fopen to read these directly: <dlcDir>/0 = index, <dlcDir>/1 = data.
            // On Android, EA's downloader stores these as individual files on disk.
            if (headerData) {
                var headerPath = localDir + '/0';
                for (var base of this.gameBasePaths) {
                    this.vfs.addFile(base + headerPath, headerData);
                    this.vfs.addFile(base + 'dlc/' + headerPath, headerData);
                }
                this.vfs.addFile(headerPath, headerData);
                this.vfs.addFile('/' + headerPath, headerData);
                this.vfs.addFile('dlc/' + headerPath, headerData);
                Logger.info('[DLC] v31: Registered BGrm header: ' + headerPath + ' (' + headerData.length + ' bytes)');
            }
            // v35: Do NOT decompress the data blob ZIP — the BGrm reader has built-in
            // ZIP handling (inflate/uncompress). Pass raw ZIP data as file "1".
            var rawBlob = new Uint8Array(innerData);
            var innerZip = await JSZip.loadAsync(innerData);
            Logger.info('[DLC] v35: Keeping raw ZIP blob for ' + localDir + ' (' + rawBlob.length + ' bytes)');
            var blobPath = localDir + '/1';
            for (var base of this.gameBasePaths) {
                this.vfs.addFile(base + blobPath, rawBlob);
                this.vfs.addFile(base + 'dlc/' + blobPath, rawBlob);
            }
            this.vfs.addFile(blobPath, rawBlob);
            this.vfs.addFile('/' + blobPath, rawBlob);
            this.vfs.addFile('dlc/' + blobPath, rawBlob);
            Logger.info('[DLC] v31: Registered raw data blob: ' + blobPath + ' (' + rawBlob.length + ' bytes)');
            
            let filesExtracted = 0;
            const fileNames = Object.keys(innerZip.files);
            
            for (const fname of fileNames) {
                const entry = innerZip.files[fname];
                if (entry.dir) continue;
                
                try {
                    const content = await entry.async('uint8array');
                    
                    // Register under multiple paths the game might use
                    const relativePath = dlcSubDir + '/' + fname;
                    
                    // Register under all known base paths
                    for (const base of this.gameBasePaths) {
                        this.vfs.addFile(base + relativePath, content);
                        // Also with dlc/ prefix
                        this.vfs.addFile(base + 'dlc/' + relativePath, content);
                    }
                    // Also register relative paths
                    this.vfs.addFile(relativePath, content);
                    this.vfs.addFile('/' + relativePath, content);
                    this.vfs.addFile('dlc/' + relativePath, content);
                    
                    filesExtracted++;
                } catch (e) {
                    Logger.warn('[DLC] Failed to extract: ' + fname + ' — ' + e.message);
                }
            }
            
            this.loadedDirs.add(localDir);
            this.stats.packagesLoaded++;
            this.stats.filesExtracted += filesExtracted;
            
            const sizeMB = (outerData.byteLength / 1048576).toFixed(1);
            Logger.success('[DLC] ✅ ' + localDir + ': ' + filesExtracted + ' files (' + sizeMB + ' MB)');
            
            return filesExtracted;
            
        } catch (e) {
            this.stats.errors++;
            Logger.error('[DLC] ❌ Failed to load ' + localDir + ': ' + e.message);
            return 0;
        }
    }

    /**
     * Fallback: extract files directly from outer ZIP (no nested structure)
     */
    async _extractDirectFiles(zip, localDir) {
        let count = 0;
        for (const fname of Object.keys(zip.files)) {
            if (zip.files[fname].dir) continue;
            try {
                const content = await zip.files[fname].async('uint8array');
                const relativePath = localDir + '/' + fname;
                for (const base of this.gameBasePaths) {
                    this.vfs.addFile(base + relativePath, content);
                    this.vfs.addFile(base + 'dlc/' + relativePath, content);
                }
                this.vfs.addFile(relativePath, content);
                this.vfs.addFile('/' + relativePath, content);
                count++;
            } catch (e) { /* skip */ }
        }
        this.loadedDirs.add(localDir);
        this.stats.packagesLoaded++;
        this.stats.filesExtracted += count;
        return count;
    }

    /**
     * Parse the BGrm header (file "0") to extract the local directory path.
     * Format: BGrm magic + binary data + null-terminated string with the path.
     */
    _parseBGrmHeader(data) {
        // Look for a readable path string in the header
        // The path is typically near the end, after the binary header
        // It looks like: "textpools-en/1" or "gamescripts/1"
        
        let str = '';
        let bestStr = '';
        
        for (let i = 0; i < data.length; i++) {
            const b = data[i];
            // Printable ASCII (including / and -)
            if (b >= 0x20 && b < 0x7F) {
                str += String.fromCharCode(b);
            } else {
                if (str.length > 3 && str.includes('/')) {
                    // Looks like a path
                    // Clean up: remove any leading junk
                    const pathMatch = str.match(/([a-zA-Z][a-zA-Z0-9_-]*(?:\/[a-zA-Z0-9_.-]+)*)/);
                    if (pathMatch && pathMatch[1].length > bestStr.length) {
                        bestStr = pathMatch[1];
                    }
                }
                str = '';
            }
        }
        
        // Check final string
        if (str.length > 3 && str.includes('/')) {
            const pathMatch = str.match(/([a-zA-Z][a-zA-Z0-9_-]*(?:\/[a-zA-Z0-9_.-]+)*)/);
            if (pathMatch && pathMatch[1].length > bestStr.length) {
                bestStr = pathMatch[1];
            }
        }
        
        if (bestStr) {
            Logger.info('[DLC] Header path: ' + bestStr);
            return bestStr;
        }
        
        return null;
    }

    /**
     * Process VFS misses: map missed paths to DLC packages and load them.
     * Returns the number of new packages loaded.
     */
    async resolveVFSMisses(missedPaths) {
        if (!this.manifest) {
            Logger.warn('[DLC] No manifest loaded, cannot resolve misses');
            return 0;
        }
        
        // Deduplicate: map missed paths to unique DLC dirs
        const dirsToLoad = new Set();
        const unmatchedPaths = [];
        
        for (const path of missedPaths) {
            const dir = this.extractDLCDir(path);
            if (dir && !this.loadedDirs.has(dir)) {
                dirsToLoad.add(dir);
            } else if (!dir) {
                unmatchedPaths.push(path);
            }
        }
        
        if (dirsToLoad.size === 0) {
            Logger.info('[DLC] No new DLC dirs to load (' + unmatchedPaths.length + ' unmatched paths)');
            if (unmatchedPaths.length > 0 && unmatchedPaths.length <= 10) {
                for (const p of unmatchedPaths) {
                    Logger.info('[DLC]   unmatched: ' + p);
                }
            }
            return 0;
        }
        
        Logger.info('[DLC] 🚀 Loading ' + dirsToLoad.size + ' DLC packages for ' + missedPaths.length + ' missed paths...');
        
        // Load in parallel batches of 5
        const dirs = Array.from(dirsToLoad);
        let totalFiles = 0;
        const BATCH_SIZE = 5;
        
        for (let i = 0; i < dirs.length; i += BATCH_SIZE) {
            const batch = dirs.slice(i, i + BATCH_SIZE);
            const promises = batch.map(d => this.loadPackage(d));
            const results = await Promise.all(promises);
            totalFiles += results.reduce((a, b) => a + b, 0);
            
            Logger.info('[DLC] Progress: ' + Math.min(i + BATCH_SIZE, dirs.length) + '/' + dirs.length + ' packages');
        }
        
        Logger.success('[DLC] 🎉 Loaded ' + dirsToLoad.size + ' packages, ' + totalFiles + ' files total');
        return dirsToLoad.size;
    }

    /**
     * Get loading statistics
     */
    getStats() {
        return {
            ...this.stats,
            loadedDirs: this.loadedDirs.size,
            manifestDirs: this.manifest ? Object.keys(this.manifest).length : 0,
            downloadedMB: (this.stats.bytesDownloaded / 1048576).toFixed(1),
        };
    }
}

// Export
window.DLCLoader = DLCLoader;
