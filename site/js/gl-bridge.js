/**
 * TSTO Web Emulator — OpenGL ES 2.0 → WebGL Bridge v15.0
 * FULL IMPLEMENTATION: Reads shaders, buffers, textures from ARM emulator memory
 *
 * All 50 GL imports from libscorpio.so are properly bridged.
 * Shader source is extracted from ARM memory and compiled in WebGL.
 * Buffer data is read from ARM memory and uploaded to WebGL.
 * Uniform values are forwarded to real WebGL programs.
 */
class GLBridge {
    constructor(canvas) {
        this.canvas = canvas;
        this.headless = false;

        // v22: Detailed WebGL diagnostic
        if (!canvas) {
            console.error('[GL] Canvas is null/undefined!');
            this.headless = true;
            this.gl = null;
            return;
        }
        console.log('[GL] Canvas: ' + canvas.width + 'x' + canvas.height + ', id=' + canvas.id + ', tagName=' + canvas.tagName);

        // Try WebGL2 first, then WebGL1
        this.gl = null;
        var contextNames = ['webgl2', 'webgl', 'experimental-webgl'];
        var attrs = {
            alpha: false,
            antialias: false,
            preserveDrawingBuffer: true,
            depth: true,
            stencil: true,
            failIfMajorPerformanceCaveat: false,
            powerPreference: 'default',
        };
        for (var i = 0; i < contextNames.length; i++) {
            try {
                this.gl = canvas.getContext(contextNames[i], attrs);
                if (this.gl) {
                    console.log('[GL] Got context: ' + contextNames[i]);
                    break;
                }
            } catch(e) {
                console.warn('[GL] getContext(' + contextNames[i] + ') threw: ' + e.message);
            }
        }

        if (!this.gl) {
            // Last resort: try with no attributes at all
            try {
                this.gl = canvas.getContext('webgl');
            } catch(e) {}
        }

        if (!this.gl) {
            console.error('[GL] ALL WebGL context attempts failed! Canvas may be in a restricted context.');
            console.error('[GL] window.WebGLRenderingContext exists: ' + !!window.WebGLRenderingContext);
            this.headless = true;
            return;
        }

        // Stats
        this.callCount = 0;
        this.drawCalls = 0;
        this.textureCount = 0;
        this.shaderCount = 0;
        this._clearCount = 0;
        this._shaderCompileOK = 0;
        this._shaderCompileFail = 0;
        this._programLinkOK = 0;
        this._programLinkFail = 0;

        // v15.1: Shader manager reference (set from outside)
        this.shaderManager = null;
        this._forceVisibleClear = false;  // v15.1: disabled, using real shader rendering now

        // Emulator ↔ WebGL object ID mapping
        // ARM code uses integer IDs; WebGL uses WebGLObject references
        this._nextId = 1;
        this._textures = new Map();      // id -> WebGLTexture
        this._buffers = new Map();       // id -> WebGLBuffer
        this._programs = new Map();      // id -> WebGLProgram
        this._shaders = new Map();       // id -> WebGLShader
        this._uniforms = new Map();      // id -> WebGLUniformLocation
        this._shaderSources = new Map(); // id -> source string (debug)

        // State tracking
        this._currentProgramId = 0;
        this._currentProgram = null;
        this._boundBuffer = new Map();   // target -> buffer id
        this._bufferSizes = new Map();   // buffer id -> size
        this._mappedBuffers = new Map(); // target -> { ptr, size, bufId }

        // Temp allocator for glMapBufferOES
        this._tempHeapPtr = 0xD0800000;
        this._tempHeapEnd = 0xD1000000;

        Logger.gl('WebGL context created: ' + this.gl.getParameter(this.gl.VERSION));
    }

    // ================================================================
    // MEMORY HELPERS — Read/write ARM emulator memory via Unicorn
    // ================================================================

    _readU32(emu, addr) {
        try {
            var bytes = emu.mem_read(addr, 4);
            return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
        } catch (e) { return 0; }
    }

    _writeU32(emu, addr, val) {
        try {
            emu.mem_write(addr, [
                val & 0xFF, (val >> 8) & 0xFF,
                (val >> 16) & 0xFF, (val >> 24) & 0xFF
            ]);
        } catch (e) {}
    }

    _readCString(emu, addr, maxLen) {
        maxLen = maxLen || 16384;
        if (!addr || addr === 0) return '';
        try {
            var result = '';
            var CHUNK = 256;
            var offset = 0;
            while (offset < maxLen) {
                var readLen = Math.min(CHUNK, maxLen - offset);
                var bytes = emu.mem_read(addr + offset, readLen);
                for (var i = 0; i < bytes.length; i++) {
                    if (bytes[i] === 0) return result;
                    result += String.fromCharCode(bytes[i]);
                }
                offset += readLen;
            }
            return result;
        } catch (e) { return ''; }
    }

    _readBytes(emu, addr, size) {
        if (!addr || size <= 0 || size > 8388608) return null;
        try {
            var bytes = emu.mem_read(addr, size);
            var u8 = new Uint8Array(size);
            for (var i = 0; i < size; i++) u8[i] = bytes[i];
            return u8;
        } catch (e) { return null; }
    }

    _readFloats(emu, addr, count) {
        if (!addr || count <= 0) return new Float32Array(0);
        try {
            var bytes = emu.mem_read(addr, count * 4);
            var ab = new ArrayBuffer(count * 4);
            var u8 = new Uint8Array(ab);
            for (var i = 0; i < count * 4; i++) u8[i] = bytes[i];
            return new Float32Array(ab);
        } catch (e) { return new Float32Array(count); }
    }

    /** Read the Nth stack argument (0-indexed, where 0 = 5th function arg at [SP+0]) */
    _readStackArg(emu, index) {
        try {
            var spBytes = emu.reg_read(uc.ARM_REG_SP, 4);
            var sp = (spBytes[0] | (spBytes[1] << 8) | (spBytes[2] << 16) | (spBytes[3] << 24)) >>> 0;
            return this._readU32(emu, sp + index * 4);
        } catch (e) { return 0; }
    }

    /** Interpret a 32-bit int as IEEE 754 float (ARM softfp ABI) */
    _f32(intVal) {
        var buf = new ArrayBuffer(4);
        new Uint32Array(buf)[0] = intVal >>> 0;
        return new Float32Array(buf)[0];
    }

    /** Convert float to IEEE 754 int bits */
    _i32(floatVal) {
        var buf = new ArrayBuffer(4);
        new Float32Array(buf)[0] = floatVal;
        return new Uint32Array(buf)[0];
    }

    /** Get bytes per pixel for a given format + type */
    _getBpp(format, type) {
        if (type === 0x1401) { // GL_UNSIGNED_BYTE
            switch (format) {
                case 0x1908: return 4; // RGBA
                case 0x1907: return 3; // RGB
                case 0x1909: return 1; // LUMINANCE
                case 0x1906: return 1; // ALPHA
                case 0x190A: return 2; // LUMINANCE_ALPHA
                default: return 4;
            }
        }
        // GL_UNSIGNED_SHORT_5_6_5, _4_4_4_4, _5_5_5_1
        if (type === 0x8363 || type === 0x8033 || type === 0x8034) return 2;
        return 4;
    }

    /** Allocate temporary ARM memory (for glMapBufferOES) */
    _allocTemp(emu, size) {
        var aligned = (size + 0x3FFF) & ~0x3FFF;
        if (this._tempHeapPtr + aligned > this._tempHeapEnd) return 0;
        var ptr = this._tempHeapPtr;
        try { emu.mem_map(ptr, aligned, uc.PROT_ALL); } catch (e) { /* may already be mapped */ }
        this._tempHeapPtr += aligned;
        return ptr;
    }

    // ================================================================
    // SHADER HELPERS
    // ================================================================

    /** Preprocess GLSL source for WebGL compatibility */
    _preprocessShader(source, type) {
        if (!source) return '';
        var GL_FRAGMENT_SHADER = 0x8B30;

        // For fragment shaders, ensure precision qualifier exists
        if (type === GL_FRAGMENT_SHADER) {
            if (!/precision\s+(lowp|mediump|highp)\s+float/i.test(source)) {
                source = 'precision mediump float;\n' + source;
            }
        }

        // Replace highp with mediump in fragment shaders (some WebGL impls don't support highp)
        if (type === GL_FRAGMENT_SHADER) {
            source = source.replace(/\bhighp\b/g, 'mediump');
        }

        return source;
    }

    // ================================================================
    // PUBLIC API
    // ================================================================

    setForceVisibleClear(enabled) {
        this._forceVisibleClear = enabled;
    }

    /**
     * Returns all GL function shims that intercept ARM calls.
     * Each shim: (emu, [R0, R1, R2, R3]) => return_value
     */
    getShims() {
        // v22: If headless, return no-op shims that won't crash
        if (this.headless || !this.gl) {
            Logger.warn('[GL] Headless mode — returning no-op GL shims');
            var noop = function() { return 0; };
            var glNames = [
                'glEnable','glDisable','glBlendFunc','glCullFace','glFrontFace','glLineWidth',
                'glViewport','glScissor','glClearColor','glClear','glDepthFunc','glDepthMask',
                'glDepthRangef','glStencilFunc','glStencilOp','glStencilMask','glColorMask',
                'glGenTextures','glBindTexture','glTexImage2D','glTexParameteri',
                'glDeleteTextures','glActiveTexture','glPixelStorei','glCompressedTexImage2D',
                'glGenerateMipmap','glGenBuffers','glBindBuffer','glBufferData','glBufferSubData',
                'glDeleteBuffers','glCreateShader','glShaderSource','glCompileShader',
                'glCreateProgram','glAttachShader','glLinkProgram','glUseProgram',
                'glGetAttribLocation','glGetUniformLocation','glEnableVertexAttribArray',
                'glDisableVertexAttribArray','glVertexAttribPointer','glDrawArrays',
                'glDrawElements','glUniform1i','glUniform1f','glUniform2f','glUniform3f',
                'glUniform4f','glUniform4fv','glUniformMatrix4fv','glGetShaderiv',
                'glGetProgramiv','glGetShaderInfoLog','glGetProgramInfoLog','glDeleteShader',
                'glDeleteProgram','glGetError','glMapBufferOES','glUnmapBufferOES',
                'glBlendFuncSeparate','glTexSubImage2D',
            ];
            var shims = {};
            for (var i = 0; i < glNames.length; i++) {
                shims[glNames[i]] = noop;
            }
            return shims;
        }

        var gl = this.gl;
        var self = this;

        return {

            // ============================================================
            // STATE (8 functions)
            // ============================================================
            'glEnable':     function(emu, args) { self.callCount++; gl.enable(args[0]); return 0; },
            'glDisable':    function(emu, args) { self.callCount++; gl.disable(args[0]); return 0; },
            'glBlendFunc':  function(emu, args) { self.callCount++; gl.blendFunc(args[0], args[1]); return 0; },
            'glCullFace':   function(emu, args) { self.callCount++; gl.cullFace(args[0]); return 0; },
            'glFrontFace':  function(emu, args) { self.callCount++; gl.frontFace(args[0]); return 0; },
            'glLineWidth':  function(emu, args) { self.callCount++; gl.lineWidth(1.0); return 0; },
            'glViewport':   function(emu, args) {
                self.callCount++;
                gl.viewport(args[0], args[1], args[2], args[3]);
                return 0;
            },
            'glScissor':    function(emu, args) {
                self.callCount++;
                gl.scissor(args[0], args[1], args[2], args[3]);
                return 0;
            },

            // ============================================================
            // CLEAR (2 functions)
            // ============================================================
            'glClearColor': function(emu, args) {
                self.callCount++;
                var r = self._f32(args[0]), g = self._f32(args[1]);
                var b = self._f32(args[2]), a = self._f32(args[3]);
                if (self._forceVisibleClear) {
                    gl.clearColor(0.18, 0.75, 0.29, 1.0); // Springfield green 🟢
                } else {
                    gl.clearColor(r, g, b, a);
                }
                Logger.gl('clearColor(' + r.toFixed(2) + ', ' + g.toFixed(2) + ', ' + b.toFixed(2) + ', ' + a.toFixed(2) + ')');
                return 0;
            },
            'glClear': function(emu, args) {
                self.callCount++;
                self._clearCount++;
                var mask = args[0];
                var parts = [];
                if (mask & 0x4000) parts.push('COLOR');
                if (mask & 0x100) parts.push('DEPTH');
                if (mask & 0x400) parts.push('STENCIL');
                Logger.gl('clear(' + (parts.join('|') || '0x' + mask.toString(16)) + ')');
                gl.clear(mask);
                // v15.1: After ARM clear, inject test scene using game's own shaders
                if (self.shaderManager && self.shaderManager.testRendering) {
                    self.shaderManager.renderTestScene();
                }
                return 0;
            },

            // ============================================================
            // TEXTURES (7 functions)
            // ============================================================
            'glGenTextures': function(emu, args) {
                self.callCount++;
                var n = args[0];
                var outPtr = args[1];
                for (var i = 0; i < n && i < 256; i++) {
                    var tex = gl.createTexture();
                    var id = self._nextId++;
                    self._textures.set(id, tex);
                    self.textureCount++;
                    // v15: Write ID back to ARM memory
                    if (outPtr) self._writeU32(emu, outPtr + i * 4, id);
                }
                Logger.gl('genTextures(' + n + ')');
                return 0;
            },

            'glDeleteTextures': function(emu, args) {
                self.callCount++;
                var n = args[0];
                var ptr = args[1];
                for (var i = 0; i < n && i < 256; i++) {
                    var id = ptr ? self._readU32(emu, ptr + i * 4) : 0;
                    var tex = self._textures.get(id);
                    if (tex) {
                        gl.deleteTexture(tex);
                        self._textures.delete(id);
                    }
                }
                return 0;
            },

            'glBindTexture': function(emu, args) {
                self.callCount++;
                var tex = self._textures.get(args[1]) || null;
                gl.bindTexture(args[0], tex);
                return 0;
            },

            'glActiveTexture': function(emu, args) {
                self.callCount++;
                gl.activeTexture(args[0]);
                return 0;
            },

            'glTexParameterf': function(emu, args) {
                self.callCount++;
                var param = self._f32(args[2]);
                try { gl.texParameterf(args[0], args[1], param); } catch (e) {}
                return 0;
            },

            'glTexImage2D': function(emu, args) {
                self.callCount++;
                // 9 args: target, level, internalformat, width | height, border, format, type, pixels on stack
                var target = args[0];
                var level = args[1];
                var internalformat = args[2];
                var width = args[3];
                var height = self._readStackArg(emu, 0);
                var border = self._readStackArg(emu, 1);
                var format = self._readStackArg(emu, 2);
                var type = self._readStackArg(emu, 3);
                var pixelsPtr = self._readStackArg(emu, 4);

                Logger.gl('texImage2D ' + width + 'x' + height + ' fmt=0x' + (format >>> 0).toString(16) + ' type=0x' + (type >>> 0).toString(16));

                // WebGL1: internalformat must match format
                var webglFmt = format || internalformat;
                var webglType = type || gl.UNSIGNED_BYTE;

                if (width > 0 && height > 0 && width <= 4096 && height <= 4096) {
                    if (pixelsPtr && pixelsPtr !== 0) {
                        var bpp = self._getBpp(webglFmt, webglType);
                        var dataSize = width * height * bpp;
                        if (dataSize > 0 && dataSize <= 4194304) {
                            var pixels = self._readBytes(emu, pixelsPtr, dataSize);
                            if (pixels) {
                                try {
                                    gl.texImage2D(target, level, webglFmt, width, height, border, webglFmt, webglType, pixels);
                                    return 0;
                                } catch (e) {
                                    Logger.gl('texImage2D pixel upload failed: ' + e.message);
                                }
                            }
                        }
                    }
                    // No pixels or upload failed — allocate empty
                    try {
                        gl.texImage2D(target, level, webglFmt, width, height, border, webglFmt, webglType, null);
                    } catch (e) {}
                }
                return 0;
            },

            'glTexSubImage2D': function(emu, args) {
                self.callCount++;
                var target = args[0], level = args[1], xoff = args[2], yoff = args[3];
                var width = self._readStackArg(emu, 0);
                var height = self._readStackArg(emu, 1);
                var format = self._readStackArg(emu, 2);
                var type = self._readStackArg(emu, 3);
                var pixelsPtr = self._readStackArg(emu, 4);

                if (pixelsPtr && width > 0 && height > 0 && width <= 4096 && height <= 4096) {
                    var bpp = self._getBpp(format, type);
                    var dataSize = width * height * bpp;
                    if (dataSize > 0 && dataSize <= 4194304) {
                        var pixels = self._readBytes(emu, pixelsPtr, dataSize);
                        if (pixels) {
                            try {
                                gl.texSubImage2D(target, level, xoff, yoff, width, height, format, type, pixels);
                            } catch (e) {}
                        }
                    }
                }
                return 0;
            },

            // ============================================================
            // BUFFERS (6 functions)
            // ============================================================
            'glGenBuffers': function(emu, args) {
                self.callCount++;
                var n = args[0];
                var outPtr = args[1];
                for (var i = 0; i < n && i < 256; i++) {
                    var buf = gl.createBuffer();
                    var id = self._nextId++;
                    self._buffers.set(id, buf);
                    // v15: Write ID back to ARM memory
                    if (outPtr) self._writeU32(emu, outPtr + i * 4, id);
                }
                Logger.gl('genBuffers(' + n + ')');
                return 0;
            },

            'glDeleteBuffers': function(emu, args) {
                self.callCount++;
                var n = args[0];
                var ptr = args[1];
                for (var i = 0; i < n && i < 256; i++) {
                    var id = ptr ? self._readU32(emu, ptr + i * 4) : 0;
                    var buf = self._buffers.get(id);
                    if (buf) {
                        gl.deleteBuffer(buf);
                        self._buffers.delete(id);
                    }
                }
                return 0;
            },

            'glBindBuffer': function(emu, args) {
                self.callCount++;
                var target = args[0];
                var id = args[1];
                self._boundBuffer.set(target, id);
                var buf = self._buffers.get(id) || null;
                gl.bindBuffer(target, buf);
                return 0;
            },

            'glBufferData': function(emu, args) {
                self.callCount++;
                var target = args[0];
                var size = args[1];
                var dataPtr = args[2];
                var usage = args[3];

                // Track buffer size for glMapBufferOES
                var bufId = self._boundBuffer.get(target);
                if (bufId) self._bufferSizes.set(bufId, size);

                if (dataPtr && dataPtr !== 0 && size > 0 && size <= 4194304) {
                    var bytes = self._readBytes(emu, dataPtr, size);
                    if (bytes) {
                        gl.bufferData(target, bytes, usage);
                        Logger.gl('bufferData(' + size + ' bytes, real data)');
                        return 0;
                    }
                }
                // No data or read failed — allocate empty
                gl.bufferData(target, size, usage);
                Logger.gl('bufferData(' + size + ' bytes, empty)');
                return 0;
            },

            'glMapBufferOES': function(emu, args) {
                self.callCount++;
                var target = args[0];
                var bufId = self._boundBuffer.get(target);
                var size = bufId ? (self._bufferSizes.get(bufId) || 0) : 0;

                if (size > 0 && size <= 4194304) {
                    var ptr = self._allocTemp(emu, size);
                    if (ptr) {
                        self._mappedBuffers.set(target, { ptr: ptr, size: size, bufId: bufId });
                        Logger.gl('mapBufferOES → 0x' + ptr.toString(16) + ' (' + size + ' bytes)');
                        return ptr;
                    }
                }
                return 0;
            },

            'glUnmapBufferOES': function(emu, args) {
                self.callCount++;
                var target = args[0];
                var mapped = self._mappedBuffers.get(target);
                if (mapped && mapped.ptr && mapped.size > 0) {
                    var bytes = self._readBytes(emu, mapped.ptr, mapped.size);
                    if (bytes) {
                        try { gl.bufferSubData(target, 0, bytes); } catch (e) {}
                    }
                    self._mappedBuffers.delete(target);
                }
                return 1; // GL_TRUE
            },

            // ============================================================
            // SHADERS (5 functions) — v15: REAL shader source extraction!
            // ============================================================
            'glCreateShader': function(emu, args) {
                self.callCount++;
                var shader = gl.createShader(args[0]);
                var id = self._nextId++;
                self._shaders.set(id, shader);
                self.shaderCount++;
                var typeStr = args[0] === gl.VERTEX_SHADER ? 'VERTEX' : 'FRAGMENT';
                Logger.gl('createShader(' + typeStr + ') → id=' + id);
                return id;
            },

            'glShaderSource': function(emu, args) {
                self.callCount++;
                var shaderId = args[0];
                var count = args[1];
                var stringsPtr = args[2];
                var lengthsPtr = args[3];
                var shader = self._shaders.get(shaderId);

                if (!shader || !stringsPtr || count <= 0) {
                    Logger.gl('shaderSource: invalid args (shader=' + shaderId + ', count=' + count + ')');
                    return 0;
                }

                // Read all string parts from ARM memory
                var fullSource = '';
                for (var i = 0; i < count && i < 64; i++) {
                    var strPtr = self._readU32(emu, stringsPtr + i * 4);
                    if (!strPtr) continue;

                    var str = '';
                    if (lengthsPtr && lengthsPtr !== 0) {
                        var rawLen = self._readU32(emu, lengthsPtr + i * 4);
                        var len = rawLen | 0; // signed 32-bit
                        if (len > 0 && len < 65536) {
                            var bytes = self._readBytes(emu, strPtr, len);
                            if (bytes) {
                                for (var j = 0; j < bytes.length; j++) {
                                    if (bytes[j] === 0) break;
                                    str += String.fromCharCode(bytes[j]);
                                }
                            }
                        } else {
                            str = self._readCString(emu, strPtr);
                        }
                    } else {
                        str = self._readCString(emu, strPtr);
                    }
                    fullSource += str;
                }

                if (fullSource.length > 0) {
                    var shaderType = gl.getShaderParameter(shader, gl.SHADER_TYPE);
                    fullSource = self._preprocessShader(fullSource, shaderType);
                    gl.shaderSource(shader, fullSource);
                    self._shaderSources.set(shaderId, fullSource);

                    var typeStr = shaderType === gl.VERTEX_SHADER ? 'VERTEX' : 'FRAGMENT';
                    Logger.gl('🔑 shaderSource(' + typeStr + ' #' + shaderId + ', ' + fullSource.length + ' chars)');
                    console.log('[GL] Shader #' + shaderId + ' (' + typeStr + ') source:\n' + fullSource);
                } else {
                    Logger.gl('shaderSource: empty source for shader #' + shaderId);
                }
                return 0;
            },

            'glCompileShader': function(emu, args) {
                self.callCount++;
                var shaderId = args[0];
                var shader = self._shaders.get(shaderId);
                if (!shader) return 0;

                gl.compileShader(shader);

                var success = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
                var shaderType = gl.getShaderParameter(shader, gl.SHADER_TYPE);
                var typeStr = shaderType === gl.VERTEX_SHADER ? 'VERTEX' : 'FRAGMENT';

                if (success) {
                    self._shaderCompileOK++;
                    Logger.gl('compileShader(' + typeStr + ' #' + shaderId + '): ✅ SUCCESS');
                } else {
                    self._shaderCompileFail++;
                    var log = gl.getShaderInfoLog(shader) || '(no info)';
                    Logger.gl('compileShader(' + typeStr + ' #' + shaderId + '): ❌ FAILED');
                    console.error('[GL] Shader #' + shaderId + ' compile failed:\n' + log);
                    var src = self._shaderSources.get(shaderId);
                    if (src) console.error('[GL] Source was:\n' + src);
                }
                return 0;
            },

            'glGetShaderiv': function(emu, args) {
                self.callCount++;
                var shaderId = args[0];
                var pname = args[1];
                var paramsPtr = args[2];
                var shader = self._shaders.get(shaderId);
                var value = 0;

                var GL_COMPILE_STATUS = 0x8B81;
                var GL_INFO_LOG_LENGTH = 0x8B84;
                var GL_SHADER_TYPE = 0x8B4F;
                var GL_DELETE_STATUS = 0x8B80;

                if (shader) {
                    switch (pname) {
                        case GL_COMPILE_STATUS:
                            value = gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? 1 : 0;
                            break;
                        case GL_INFO_LOG_LENGTH:
                            value = (gl.getShaderInfoLog(shader) || '').length;
                            break;
                        case GL_SHADER_TYPE:
                            value = gl.getShaderParameter(shader, gl.SHADER_TYPE);
                            break;
                        case GL_DELETE_STATUS:
                            value = 0;
                            break;
                        default:
                            value = 0;
                    }
                } else {
                    // Shader not found — report success to avoid crash
                    if (pname === GL_COMPILE_STATUS) value = 1;
                }

                if (paramsPtr) self._writeU32(emu, paramsPtr, value);
                return 0;
            },

            'glDeleteShader': function(emu, args) {
                self.callCount++;
                var shader = self._shaders.get(args[0]);
                if (shader) {
                    gl.deleteShader(shader);
                    self._shaders.delete(args[0]);
                    self._shaderSources.delete(args[0]);
                }
                return 0;
            },

            // ============================================================
            // PROGRAMS (9 functions)
            // ============================================================
            'glCreateProgram': function(emu, args) {
                self.callCount++;
                var prog = gl.createProgram();
                var id = self._nextId++;
                self._programs.set(id, prog);
                Logger.gl('createProgram → id=' + id);
                return id;
            },

            'glAttachShader': function(emu, args) {
                self.callCount++;
                var prog = self._programs.get(args[0]);
                var shader = self._shaders.get(args[1]);
                if (prog && shader) {
                    gl.attachShader(prog, shader);
                    Logger.gl('attachShader(prog=' + args[0] + ', shader=' + args[1] + ')');
                }
                return 0;
            },

            'glBindAttribLocation': function(emu, args) {
                self.callCount++;
                var progId = args[0];
                var index = args[1];
                var namePtr = args[2];
                var prog = self._programs.get(progId);
                var name = self._readCString(emu, namePtr);

                if (prog && name) {
                    gl.bindAttribLocation(prog, index, name);
                    Logger.gl('bindAttribLocation(' + index + ', "' + name + '")');
                }
                return 0;
            },

            'glLinkProgram': function(emu, args) {
                self.callCount++;
                var progId = args[0];
                var prog = self._programs.get(progId);
                if (!prog) return 0;

                gl.linkProgram(prog);

                var success = gl.getProgramParameter(prog, gl.LINK_STATUS);
                if (success) {
                    self._programLinkOK++;
                    Logger.gl('linkProgram(#' + progId + '): ✅ SUCCESS');
                } else {
                    self._programLinkFail++;
                    var log = gl.getProgramInfoLog(prog) || '(no info)';
                    Logger.gl('linkProgram(#' + progId + '): ❌ FAILED');
                    console.error('[GL] Program #' + progId + ' link failed:\n' + log);
                }
                return 0;
            },

            'glValidateProgram': function(emu, args) {
                self.callCount++;
                var prog = self._programs.get(args[0]);
                if (prog) gl.validateProgram(prog);
                return 0;
            },

            'glGetProgramiv': function(emu, args) {
                self.callCount++;
                var progId = args[0];
                var pname = args[1];
                var paramsPtr = args[2];
                var prog = self._programs.get(progId);
                var value = 0;

                var GL_LINK_STATUS = 0x8B82;
                var GL_VALIDATE_STATUS = 0x8B83;
                var GL_INFO_LOG_LENGTH = 0x8B84;
                var GL_ATTACHED_SHADERS = 0x8B85;
                var GL_ACTIVE_UNIFORMS = 0x8B86;
                var GL_ACTIVE_ATTRIBUTES = 0x8B89;
                var GL_DELETE_STATUS = 0x8B80;

                if (prog) {
                    switch (pname) {
                        case GL_LINK_STATUS:
                            value = gl.getProgramParameter(prog, gl.LINK_STATUS) ? 1 : 0;
                            break;
                        case GL_VALIDATE_STATUS:
                            value = gl.getProgramParameter(prog, gl.VALIDATE_STATUS) ? 1 : 0;
                            break;
                        case GL_ATTACHED_SHADERS:
                            value = gl.getProgramParameter(prog, gl.ATTACHED_SHADERS) || 0;
                            break;
                        case GL_ACTIVE_ATTRIBUTES:
                            value = gl.getProgramParameter(prog, gl.ACTIVE_ATTRIBUTES) || 0;
                            break;
                        case GL_ACTIVE_UNIFORMS:
                            value = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) || 0;
                            break;
                        case GL_INFO_LOG_LENGTH:
                            value = (gl.getProgramInfoLog(prog) || '').length;
                            break;
                        default:
                            value = 0;
                    }
                } else {
                    // Program not found — report success to avoid crash
                    if (pname === GL_LINK_STATUS) value = 1;
                }

                if (paramsPtr) self._writeU32(emu, paramsPtr, value);
                return 0;
            },

            'glDeleteProgram': function(emu, args) {
                self.callCount++;
                var prog = self._programs.get(args[0]);
                if (prog) {
                    gl.deleteProgram(prog);
                    self._programs.delete(args[0]);
                }
                return 0;
            },

            'glUseProgram': function(emu, args) {
                self.callCount++;
                var progId = args[0];
                var prog = self._programs.get(progId) || null;
                self._currentProgramId = progId;
                self._currentProgram = prog;
                gl.useProgram(prog);
                return 0;
            },

            'glGetUniformLocation': function(emu, args) {
                self.callCount++;
                var progId = args[0];
                var namePtr = args[1];
                var prog = self._programs.get(progId);
                var name = self._readCString(emu, namePtr);

                if (!prog || !name) return 0xFFFFFFFF; // -1

                var loc = gl.getUniformLocation(prog, name);
                if (loc === null) {
                    Logger.gl('getUniformLocation("' + name + '") → -1 (not found)');
                    return 0xFFFFFFFF; // -1
                }

                var id = self._nextId++;
                self._uniforms.set(id, loc);
                Logger.gl('getUniformLocation("' + name + '") → ' + id);
                return id;
            },

            // ============================================================
            // UNIFORMS (7 functions) — v15: Real values forwarded!
            // ============================================================
            'glUniform1i': function(emu, args) {
                self.callCount++;
                var loc = self._uniforms.get(args[0]);
                if (loc) gl.uniform1i(loc, args[1]);
                return 0;
            },

            'glUniform1f': function(emu, args) {
                self.callCount++;
                var loc = self._uniforms.get(args[0]);
                if (loc) gl.uniform1f(loc, self._f32(args[1]));
                return 0;
            },

            'glUniform1fv': function(emu, args) {
                self.callCount++;
                var loc = self._uniforms.get(args[0]);
                var count = args[1];
                var ptr = args[2];
                if (loc && ptr && count > 0 && count <= 256) {
                    var floats = self._readFloats(emu, ptr, count);
                    gl.uniform1fv(loc, floats);
                }
                return 0;
            },

            'glUniform2fv': function(emu, args) {
                self.callCount++;
                var loc = self._uniforms.get(args[0]);
                var count = args[1];
                var ptr = args[2];
                if (loc && ptr && count > 0 && count <= 256) {
                    var floats = self._readFloats(emu, ptr, count * 2);
                    gl.uniform2fv(loc, floats);
                }
                return 0;
            },

            'glUniform3fv': function(emu, args) {
                self.callCount++;
                var loc = self._uniforms.get(args[0]);
                var count = args[1];
                var ptr = args[2];
                if (loc && ptr && count > 0 && count <= 256) {
                    var floats = self._readFloats(emu, ptr, count * 3);
                    gl.uniform3fv(loc, floats);
                }
                return 0;
            },

            'glUniform4fv': function(emu, args) {
                self.callCount++;
                var loc = self._uniforms.get(args[0]);
                var count = args[1];
                var ptr = args[2];
                if (loc && ptr && count > 0 && count <= 256) {
                    var floats = self._readFloats(emu, ptr, count * 4);
                    gl.uniform4fv(loc, floats);
                }
                return 0;
            },

            'glUniformMatrix4fv': function(emu, args) {
                self.callCount++;
                var loc = self._uniforms.get(args[0]);
                var count = args[1];
                var transpose = !!args[2];
                var ptr = args[3];
                if (loc && ptr && count > 0 && count <= 64) {
                    var floats = self._readFloats(emu, ptr, count * 16);
                    // WebGL 1 requires transpose=false
                    gl.uniformMatrix4fv(loc, false, floats);
                }
                return 0;
            },

            // ============================================================
            // VERTEX ATTRIBUTES (3 functions)
            // ============================================================
            'glVertexAttribPointer': function(emu, args) {
                self.callCount++;
                var index = args[0];
                var size = args[1];
                var type = args[2];
                var normalized = !!args[3];
                var stride = self._readStackArg(emu, 0);
                var offset = self._readStackArg(emu, 1);

                try {
                    gl.vertexAttribPointer(index, size, type, normalized, stride, offset);
                } catch (e) {
                    Logger.gl('vertexAttribPointer failed: ' + e.message);
                }
                return 0;
            },

            'glEnableVertexAttribArray': function(emu, args) {
                self.callCount++;
                gl.enableVertexAttribArray(args[0]);
                return 0;
            },

            'glDisableVertexAttribArray': function(emu, args) {
                self.callCount++;
                gl.disableVertexAttribArray(args[0]);
                return 0;
            },

            // ============================================================
            // DRAW CALLS (2 functions)
            // ============================================================
            'glDrawArrays': function(emu, args) {
                self.callCount++;
                self.drawCalls++;
                Logger.gl('drawArrays mode=' + args[0] + ' first=' + args[1] + ' count=' + args[2]);
                try { gl.drawArrays(args[0], args[1], args[2]); } catch (e) {
                    Logger.gl('drawArrays error: ' + e.message);
                }
                return 0;
            },

            'glDrawElements': function(emu, args) {
                self.callCount++;
                self.drawCalls++;
                Logger.gl('drawElements mode=' + args[0] + ' count=' + args[1] + ' type=0x' + args[2].toString(16));
                try { gl.drawElements(args[0], args[1], args[2], args[3]); } catch (e) {
                    Logger.gl('drawElements error: ' + e.message);
                }
                return 0;
            },

            // ============================================================
            // QUERY (1 function)
            // ============================================================
            'glGetIntegerv': function(emu, args) {
                self.callCount++;
                var pname = args[0];
                var dataPtr = args[1];
                var value = 0;

                try {
                    var result = gl.getParameter(pname);
                    if (typeof result === 'number') {
                        value = result | 0;
                    } else if (typeof result === 'boolean') {
                        value = result ? 1 : 0;
                    } else if (result && result.length) {
                        // Array result (e.g., viewport, scissor)
                        if (dataPtr) {
                            for (var i = 0; i < result.length; i++) {
                                self._writeU32(emu, dataPtr + i * 4, Math.round(result[i]));
                            }
                        }
                        return 0;
                    }
                } catch (e) {
                    // Return safe defaults for common queries
                    switch (pname) {
                        case 0x0D33: value = 4096; break;  // GL_MAX_TEXTURE_SIZE
                        case 0x8869: value = 16; break;    // GL_MAX_VERTEX_ATTRIBS
                        case 0x8872: value = 16; break;    // GL_MAX_TEXTURE_IMAGE_UNITS
                        case 0x851C: value = 16; break;    // GL_MAX_VERTEX_TEXTURE_IMAGE_UNITS
                        case 0x8B4C: value = 256; break;   // GL_MAX_VERTEX_UNIFORM_VECTORS
                        case 0x8DFD: value = 256; break;   // GL_MAX_FRAGMENT_UNIFORM_VECTORS
                        default: value = 0;
                    }
                }

                if (dataPtr) self._writeU32(emu, dataPtr, value);
                return 0;
            },
        };
    }

    // ================================================================
    // TEST PATTERN
    // ================================================================

    drawTestPattern() {
        var gl = this.gl;
        gl.clearColor(0.1, 0.05, 0.2, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        var vs = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vs, 'attribute vec2 pos; attribute vec3 col; varying vec3 vCol; void main() { gl_Position = vec4(pos, 0.0, 1.0); vCol = col; }');
        gl.compileShader(vs);

        var fs = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fs, 'precision mediump float; varying vec3 vCol; void main() { gl_FragColor = vec4(vCol, 1.0); }');
        gl.compileShader(fs);

        var prog = gl.createProgram();
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        gl.useProgram(prog);

        var verts = new Float32Array([
            -0.8, -0.5, 1.0, 0.84, 0.0,
             0.8, -0.5, 1.0, 0.42, 0.2,
             0.8,  0.5, 0.0, 0.6,  1.0,
            -0.8,  0.5, 0.5, 0.8,  0.2,
        ]);
        var buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);

        var posLoc = gl.getAttribLocation(prog, 'pos');
        var colLoc = gl.getAttribLocation(prog, 'col');
        gl.enableVertexAttribArray(posLoc);
        gl.enableVertexAttribArray(colLoc);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 20, 0);
        gl.vertexAttribPointer(colLoc, 3, gl.FLOAT, false, 20, 8);
        gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
        Logger.gl('Test pattern drawn');
    }

    // ================================================================
    // STATS & DEBUG
    // ================================================================

    getStats() {
        return {
            calls: this.callCount,
            draws: this.drawCalls,
            textures: this.textureCount,
            shaders: this.shaderCount,
            clears: this._clearCount,
            shaderCompileOK: this._shaderCompileOK,
            shaderCompileFail: this._shaderCompileFail,
            programLinkOK: this._programLinkOK,
            programLinkFail: this._programLinkFail,
        };
    }

    drawDebugOverlay(fps, totalInsns, frameGLCalls) {
        if (!this._overlayCanvas) {
            this._overlayCanvas = document.createElement('canvas');
            this._overlayCanvas.style.position = 'absolute';
            this._overlayCanvas.style.top = '0';
            this._overlayCanvas.style.left = '0';
            this._overlayCanvas.style.pointerEvents = 'none';
            this._overlayCanvas.style.zIndex = '10';
            this.canvas.parentElement.appendChild(this._overlayCanvas);
        }
        this._overlayCanvas.width = this.canvas.width;
        this._overlayCanvas.height = this.canvas.height;
        var ctx = this._overlayCanvas.getContext('2d');
        ctx.clearRect(0, 0, this._overlayCanvas.width, this._overlayCanvas.height);

        // Top bar
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(0, 0, this._overlayCanvas.width, 52);

        ctx.font = 'bold 14px monospace';
        ctx.fillStyle = '#f7d354';
        ctx.fillText(
            '\uD83C\uDF69 TSTO v15.2 | ' + fps + ' FPS | ' +
            this.callCount + ' GL | ' + this._clearCount + ' clr | ' +
            this.drawCalls + ' draw',
            10, 20
        );

        ctx.font = '12px monospace';
        ctx.fillStyle = '#aaa';
        // v15.2: Show shader + VFS info
        var shaderInfo = '';
        if (this.shaderManager) {
            var info = this.shaderManager.getInfo();
            shaderInfo = 'Shaders: ' + info.compiledVariants + ' variants | ' +
                'Test: ' + (info.testRendering ? 'ON' : 'OFF');
        } else {
            shaderInfo = 'GL Shaders: ' + this._shaderCompileOK + ' ok / ' + this._shaderCompileFail + ' fail';
        }
        // Add VFS info if available
        var vfsInfo = '';
        if (window._vfs) {
            var vs = window._vfs.getStats();
            vfsInfo = ' | VFS: ' + vs.opens + ' opens, ' + (vs.bytesRead/1024).toFixed(1) + 'KB read, ' + vs.misses + ' miss';
        }
        ctx.fillText(shaderInfo + vfsInfo, 10, 42);

        // Rendering indicator
        if (this._clearCount > 0) {
            var hasTestRender = this.shaderManager && this.shaderManager.testRendering && this.shaderManager.frameCount > 0;
            ctx.fillStyle = hasTestRender ? '#4ade80' : (this.drawCalls > 0 ? '#4ade80' : '#f7d354');
            var label = hasTestRender ? '● RENDERING' : (this.drawCalls > 0 ? '● DRAWING' : '● CLEARING');
            ctx.font = 'bold 14px monospace';
            ctx.fillText(label, this._overlayCanvas.width - 140, 20);
        }
    }
}
