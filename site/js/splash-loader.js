/**
 * TSTO Splash Screen Texture Loader
 *
 * Extracts splash textures from BGrm/ZIP asset packages and provides
 * them as WebGL textures for the loading screen.
 *
 * BGrm data files are ZIP archives. Each .rgb file inside has:
 *   - 8-byte header: 4 zero bytes + LE uint16 texWidth + LE uint16 texHeight
 *   - Raw RGBA pixel data (power-of-2 padded)
 * Each .txt file contains "origWidth,origHeight" (actual content dimensions).
 */
(function() {
    'use strict';

    class SplashLoader {
        constructor() {
            this.textures = {};  // name -> { rgba, texW, texH, origW, origH }
            this.loaded = false;
        }

        /**
         * Load splash textures from the core-splashes-large BGrm data file.
         * @returns {Promise<number>} Number of textures loaded
         */
        async load() {
            var url = 'assets/core/core-splashes-large/1';
            console.log('[Splash] Fetching BGrm data from', url);

            try {
                var resp = await fetch(url);
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                var blob = await resp.blob();
                var zip = await JSZip.loadAsync(blob);

                var targets = ['splashscreen', 'splash_homer', 'splashfinger',
                               'bse_titl_coppagradient'];
                var count = 0;

                for (var i = 0; i < targets.length; i++) {
                    var name = targets[i];
                    var rgbFile = zip.file(name + '.rgb');
                    var txtFile = zip.file(name + '.txt');
                    if (!rgbFile) {
                        console.warn('[Splash] Missing:', name + '.rgb');
                        continue;
                    }

                    var rgbData = await rgbFile.async('uint8array');
                    var origW = 0, origH = 0;
                    if (txtFile) {
                        var txt = await txtFile.async('string');
                        var parts = txt.trim().split(',');
                        origW = parseInt(parts[0], 10) || 0;
                        origH = parseInt(parts[1], 10) || 0;
                    }

                    // Parse .rgb header: bytes 4-5 = LE uint16 width, bytes 6-7 = LE uint16 height
                    var texW = rgbData[4] | (rgbData[5] << 8);
                    var texH = rgbData[6] | (rgbData[7] << 8);
                    var rgba = rgbData.subarray(8);

                    this.textures[name] = {
                        rgba: rgba,
                        texW: texW,
                        texH: texH,
                        origW: origW || texW,
                        origH: origH || texH
                    };
                    count++;
                    console.log('[Splash] Loaded', name, texW + 'x' + texH,
                                '(orig ' + origW + 'x' + origH + ')',
                                Math.round(rgba.length / 1024) + ' KB');
                }

                this.loaded = count > 0;
                console.log('[Splash] Done:', count, 'textures loaded');
                return count;
            } catch (err) {
                console.error('[Splash] Load failed:', err);
                return 0;
            }
        }

        /**
         * Upload a named texture to WebGL.
         * @param {WebGLRenderingContext} gl
         * @param {string} name - Texture name (e.g. 'splashscreen')
         * @returns {WebGLTexture|null}
         */
        createGLTexture(gl, name) {
            var entry = this.textures[name];
            if (!entry) return null;

            var tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, entry.texW, entry.texH, 0,
                          gl.RGBA, gl.UNSIGNED_BYTE, entry.rgba);

            // Store UV scale to map from padded texture to original content
            tex._uvScaleX = entry.origW / entry.texW;
            tex._uvScaleY = entry.origH / entry.texH;
            tex._origW = entry.origW;
            tex._origH = entry.origH;

            console.log('[Splash] GL texture created:', name, entry.texW + 'x' + entry.texH,
                        'uvScale:', tex._uvScaleX.toFixed(3) + 'x' + tex._uvScaleY.toFixed(3));
            return tex;
        }
    }

    window.SplashLoader = SplashLoader;
})();
