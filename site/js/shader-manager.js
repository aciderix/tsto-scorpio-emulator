/**
 * TSTO Shader Manager v15.1
 * 
 * Pre-compiles the game's actual GLSL shaders (extracted from APK)
 * and provides test rendering using the game's own shader programs.
 * 
 * Shader variants are created by prepending #define directives.
 * The game uses: 2DShader and UberShader with various #ifdef combinations.
 */

class TSTOShaderManager {
    constructor(gl) {
        this.gl = gl;
        this.shaderSources = {};  // name -> source text
        this.programs = {};       // variant_name -> { program, uniforms, attribs }
        this.loaded = false;
        this.testGeometry = null;
        this.testRendering = false;
        this.frameCount = 0;
        this.log = window.logMessage || console.log;
    }

    /**
     * Load all 4 shader source files from server
     */
    async loadShaderSources() {
        const files = [
            '2DShader.vsh', '2DShader.fsh',
            'UberShader.vsh', 'UberShader.fsh'
        ];
        
        for (const file of files) {
            try {
                const resp = await fetch(`assets/core/res-core/${file}`);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                this.shaderSources[file] = await resp.text();
                this.log(`[SHADER] ✅ Loaded ${file} (${this.shaderSources[file].length} chars)`);
            } catch (e) {
                this.log(`[SHADER] ❌ Failed to load ${file}: ${e.message}`);
                return false;
            }
        }
        this.loaded = true;
        this.log(`[SHADER] 📦 All 4 shader sources loaded from APK assets`);
        return true;
    }

    /**
     * Compile a shader with optional #define directives prepended
     */
    compileShader(type, source, defines = []) {
        const gl = this.gl;
        const shader = gl.createShader(type);
        
        // Prepend defines before the source
        let prefix = '';
        for (const def of defines) {
            prefix += `#define ${def}\n`;
        }
        
        const fullSource = prefix + source;
        gl.shaderSource(shader, fullSource);
        gl.compileShader(shader);
        
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const info = gl.getShaderInfoLog(shader);
            this.log(`[SHADER] ❌ Compile error: ${info}`);
            this.log(`[SHADER] Source (first 200): ${fullSource.substring(0, 200)}`);
            gl.deleteShader(shader);
            return null;
        }
        return shader;
    }

    /**
     * Create a program from vertex + fragment shaders with defines
     */
    createProgram(vsName, fsName, defines = [], label = '') {
        const gl = this.gl;
        const vs = this.compileShader(gl.VERTEX_SHADER, this.shaderSources[vsName], defines);
        if (!vs) return null;
        
        const fs = this.compileShader(gl.FRAGMENT_SHADER, this.shaderSources[fsName], defines);
        if (!fs) { gl.deleteShader(vs); return null; }
        
        const program = gl.createProgram();
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            const info = gl.getProgramInfoLog(program);
            this.log(`[SHADER] ❌ Link error (${label}): ${info}`);
            gl.deleteProgram(program);
            gl.deleteShader(vs);
            gl.deleteShader(fs);
            return null;
        }
        
        // Get attribute and uniform locations
        const result = {
            program,
            attribs: {},
            uniforms: {}
        };
        
        // Common attributes
        const attribNames = ['position', 'uvs', 'colourRGBA'];
        for (const name of attribNames) {
            const loc = gl.getAttribLocation(program, name);
            if (loc >= 0) result.attribs[name] = loc;
        }
        
        // Common uniforms
        const uniformNames = [
            'matWorldViewProj', 'matView', 'matWorld', 'matWorldView', 'matWorldViewInv',
            'diffuseTexture', 'blendTexture', 'diffuseColour', 'gAlphaTestVal'
        ];
        for (const name of uniformNames) {
            const loc = gl.getUniformLocation(program, name);
            if (loc) result.uniforms[name] = loc;
        }
        
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        
        return result;
    }

    /**
     * Pre-compile all useful shader variants
     */
    compileAllVariants() {
        if (!this.loaded) {
            this.log('[SHADER] ⚠️ Sources not loaded yet');
            return false;
        }
        
        const gl = this.gl;
        this.log('[SHADER] 🔨 Compiling shader variants...');
        
        // Variant 1: 2DShader with vertex colors (simplest - good for test rendering)
        const v1 = this.createProgram('2DShader.vsh', '2DShader.fsh', 
            ['DIFFUSEVERTEX'], '2D-VertexColor');
        if (v1) {
            this.programs['2D-VertexColor'] = v1;
            this.log(`[SHADER] ✅ 2D-VertexColor: attribs=[${Object.keys(v1.attribs)}] uniforms=[${Object.keys(v1.uniforms)}]`);
        }
        
        // Variant 2: 2DShader with texture
        const v2 = this.createProgram('2DShader.vsh', '2DShader.fsh',
            ['DIFFUSETEXTURE'], '2D-Textured');
        if (v2) {
            this.programs['2D-Textured'] = v2;
            this.log(`[SHADER] ✅ 2D-Textured: attribs=[${Object.keys(v2.attribs)}] uniforms=[${Object.keys(v2.uniforms)}]`);
        }
        
        // Variant 3: 2DShader with texture + vertex color
        const v3 = this.createProgram('2DShader.vsh', '2DShader.fsh',
            ['DIFFUSETEXTURE', 'DIFFUSEVERTEX'], '2D-TexturedVertexColor');
        if (v3) {
            this.programs['2D-TexturedVertexColor'] = v3;
            this.log(`[SHADER] ✅ 2D-TexturedVertexColor compiled`);
        }
        
        // Variant 4: 2DShader with uniform color
        const v4 = this.createProgram('2DShader.vsh', '2DShader.fsh',
            ['DIFFUSEUNIFORM'], '2D-UniformColor');
        if (v4) {
            this.programs['2D-UniformColor'] = v4;
            this.log(`[SHADER] ✅ 2D-UniformColor compiled`);
        }
        
        // Variant 5: UberShader with vertex colors
        const v5 = this.createProgram('UberShader.vsh', 'UberShader.fsh',
            ['DIFFUSEVERTEX'], 'Uber-VertexColor');
        if (v5) {
            this.programs['Uber-VertexColor'] = v5;
            this.log(`[SHADER] ✅ Uber-VertexColor compiled`);
        }
        
        // Variant 6: UberShader with texture
        const v6 = this.createProgram('UberShader.vsh', 'UberShader.fsh',
            ['DIFFUSETEXTURE'], 'Uber-Textured');
        if (v6) {
            this.programs['Uber-Textured'] = v6;
            this.log(`[SHADER] ✅ Uber-Textured compiled`);
        }
        
        // Variant 7: UberShader with texture + vertex color (most common in-game)
        const v7 = this.createProgram('UberShader.vsh', 'UberShader.fsh',
            ['DIFFUSETEXTURE', 'DIFFUSEVERTEX'], 'Uber-Full');
        if (v7) {
            this.programs['Uber-Full'] = v7;
            this.log(`[SHADER] ✅ Uber-Full compiled`);
        }

        const count = Object.keys(this.programs).length;
        this.log(`[SHADER] 🎮 ${count} shader variants compiled successfully!`);
        
        // Setup test geometry
        this.setupTestGeometry();
        
        return count > 0;
    }

    /**
     * Setup test geometry - a Springfield-themed scene using the game's shaders
     */
    setupTestGeometry() {
        const gl = this.gl;
        
        // --- Test scene: Springfield ground + sky + donut ---
        
        // Vertex data: position (x,y,z,w) + color (r,g,b,a) per vertex
        // Using 2D-VertexColor shader: attributes are 'position' (vec4) and 'colourRGBA' (vec4)
        
        const vertices = new Float32Array([
            // === Sky quad (blue gradient) ===
            // Triangle 1
            -1.0,  0.0, 0.0, 1.0,   0.35, 0.65, 0.95, 1.0,   // bottom-left (lighter blue)
             1.0,  0.0, 0.0, 1.0,   0.35, 0.65, 0.95, 1.0,   // bottom-right
             1.0,  1.0, 0.0, 1.0,   0.15, 0.35, 0.85, 1.0,   // top-right (deeper blue)
            // Triangle 2
            -1.0,  0.0, 0.0, 1.0,   0.35, 0.65, 0.95, 1.0,   // bottom-left
             1.0,  1.0, 0.0, 1.0,   0.15, 0.35, 0.85, 1.0,   // top-right
            -1.0,  1.0, 0.0, 1.0,   0.15, 0.35, 0.85, 1.0,   // top-left
            
            // === Ground quad (Springfield green) ===
            // Triangle 1
            -1.0, -1.0, 0.0, 1.0,   0.15, 0.50, 0.10, 1.0,   // bottom-left (darker green)
             1.0, -1.0, 0.0, 1.0,   0.15, 0.50, 0.10, 1.0,   // bottom-right
             1.0,  0.0, 0.0, 1.0,   0.30, 0.70, 0.20, 1.0,   // top-right (lighter green)
            // Triangle 2
            -1.0, -1.0, 0.0, 1.0,   0.15, 0.50, 0.10, 1.0,   // bottom-left
             1.0,  0.0, 0.0, 1.0,   0.30, 0.70, 0.20, 1.0,   // top-right
            -1.0,  0.0, 0.0, 1.0,   0.30, 0.70, 0.20, 1.0,   // top-left
            
            // === Homer's Donut (orange/pink ring - simplified as triangles) ===
            // Center donut at (0, 0.3)
            // Outer ring - 8 triangles
            ...this.generateDonutVertices(0.0, 0.3, 0.25, 0.12, 12),
            
            // === Power Plant cooling tower (gray trapezoid) ===
            // Triangle 1 (left side)
            -0.6, -0.05, 0.0, 1.0,   0.55, 0.55, 0.55, 1.0,   // bottom-left
            -0.35, -0.05, 0.0, 1.0,  0.55, 0.55, 0.55, 1.0,   // bottom-right
            -0.42,  0.55, 0.0, 1.0,  0.75, 0.75, 0.75, 1.0,   // top-right (narrower)
            // Triangle 2 (right side)
            -0.6, -0.05, 0.0, 1.0,   0.55, 0.55, 0.55, 1.0,   // bottom-left
            -0.42,  0.55, 0.0, 1.0,  0.75, 0.75, 0.75, 1.0,   // top-right
            -0.53,  0.55, 0.0, 1.0,  0.75, 0.75, 0.75, 1.0,   // top-left
            
            // === Simpsons house (yellow rectangle + brown roof) ===
            // House body (yellow)
            // Triangle 1
             0.3, -0.05, 0.0, 1.0,   0.95, 0.85, 0.15, 1.0,   // bottom-left
             0.7, -0.05, 0.0, 1.0,   0.95, 0.85, 0.15, 1.0,   // bottom-right
             0.7,  0.30, 0.0, 1.0,   1.00, 0.90, 0.20, 1.0,   // top-right
            // Triangle 2
             0.3, -0.05, 0.0, 1.0,   0.95, 0.85, 0.15, 1.0,   // bottom-left
             0.7,  0.30, 0.0, 1.0,   1.00, 0.90, 0.20, 1.0,   // top-right
             0.3,  0.30, 0.0, 1.0,   1.00, 0.90, 0.20, 1.0,   // top-left
            // Roof (brown triangle)
             0.25, 0.30, 0.0, 1.0,   0.55, 0.30, 0.10, 1.0,   // left
             0.75, 0.30, 0.0, 1.0,   0.55, 0.30, 0.10, 1.0,   // right
             0.50, 0.55, 0.0, 1.0,   0.70, 0.40, 0.15, 1.0,   // apex
            
            // === Sun (yellow circle) ===
            ...this.generateCircleVertices(0.75, 0.75, 0.12, 10, [1.0, 0.95, 0.2, 1.0]),
        ]);
        
        // Create VBO
        this.testVBO = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.testVBO);
        gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
        this.testVertexCount = vertices.length / 8;  // 8 floats per vertex (pos4 + color4)
        
        this.log(`[SHADER] 🎨 Test geometry created: ${this.testVertexCount} vertices (Springfield scene)`);
    }
    
    /**
     * Generate donut (torus) vertices as triangles
     */
    generateDonutVertices(cx, cy, outerR, innerR, segments) {
        const verts = [];
        // Pink icing colors
        const outerColor = [0.95, 0.45, 0.65, 1.0]; // Pink
        const innerColor = [0.85, 0.65, 0.35, 1.0];  // Dough color
        
        for (let i = 0; i < segments; i++) {
            const a1 = (i / segments) * Math.PI * 2;
            const a2 = ((i + 1) / segments) * Math.PI * 2;
            
            const ox1 = cx + Math.cos(a1) * outerR;
            const oy1 = cy + Math.sin(a1) * outerR;
            const ox2 = cx + Math.cos(a2) * outerR;
            const oy2 = cy + Math.sin(a2) * outerR;
            const ix1 = cx + Math.cos(a1) * innerR;
            const iy1 = cy + Math.sin(a1) * innerR;
            const ix2 = cx + Math.cos(a2) * innerR;
            const iy2 = cy + Math.sin(a2) * innerR;
            
            // Two triangles per segment
            verts.push(
                ox1, oy1, 0, 1, ...outerColor,
                ox2, oy2, 0, 1, ...outerColor,
                ix1, iy1, 0, 1, ...innerColor,
                
                ix1, iy1, 0, 1, ...innerColor,
                ox2, oy2, 0, 1, ...outerColor,
                ix2, iy2, 0, 1, ...innerColor,
            );
        }
        return verts;
    }
    
    /**
     * Generate filled circle vertices
     */
    generateCircleVertices(cx, cy, r, segments, color) {
        const verts = [];
        for (let i = 0; i < segments; i++) {
            const a1 = (i / segments) * Math.PI * 2;
            const a2 = ((i + 1) / segments) * Math.PI * 2;
            verts.push(
                cx, cy, 0, 1, ...color,
                cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, 0, 1, ...color,
                cx + Math.cos(a2) * r, cy + Math.sin(a2) * r, 0, 1, ...color,
            );
        }
        return verts;
    }

    /**
     * Render test scene using the game's own compiled shaders
     * Called after ARM glClear to add visible content
     */
    renderTestScene() {
        const gl = this.gl;
        const prog = this.programs['2D-VertexColor'];
        if (!prog || !this.testVBO) return;
        
        this.frameCount++;
        
        // Use the game's shader program
        gl.useProgram(prog.program);
        
        // Bind vertex buffer
        gl.bindBuffer(gl.ARRAY_BUFFER, this.testVBO);
        
        // Setup attributes - position (vec4) at offset 0, colourRGBA (vec4) at offset 16
        const stride = 32; // 8 floats * 4 bytes
        
        if (prog.attribs.position !== undefined) {
            gl.enableVertexAttribArray(prog.attribs.position);
            gl.vertexAttribPointer(prog.attribs.position, 4, gl.FLOAT, false, stride, 0);
        }
        if (prog.attribs.colourRGBA !== undefined) {
            gl.enableVertexAttribArray(prog.attribs.colourRGBA);
            gl.vertexAttribPointer(prog.attribs.colourRGBA, 4, gl.FLOAT, false, stride, 16);
        }
        
        // Set identity matrix for matWorldViewProj (renders in clip space directly)
        if (prog.uniforms.matWorldViewProj) {
            const identity = new Float32Array([
                1, 0, 0, 0,
                0, 1, 0, 0,
                0, 0, 1, 0,
                0, 0, 0, 1
            ]);
            gl.uniformMatrix4fv(prog.uniforms.matWorldViewProj, false, identity);
        }
        
        // Enable blending for transparency
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.disable(gl.DEPTH_TEST);
        
        // Draw all vertices
        gl.drawArrays(gl.TRIANGLES, 0, this.testVertexCount);
        
        // Cleanup
        if (prog.attribs.position !== undefined) gl.disableVertexAttribArray(prog.attribs.position);
        if (prog.attribs.colourRGBA !== undefined) gl.disableVertexAttribArray(prog.attribs.colourRGBA);
        gl.useProgram(null);
        gl.disable(gl.BLEND);
        
        // Log first time
        if (this.frameCount === 1) {
            this.log(`[SHADER] 🎮 First test frame rendered! ${this.testVertexCount} vertices with game shaders`);
        }
    }

    /**
     * Get info about compiled programs
     */
    getInfo() {
        const names = Object.keys(this.programs);
        return {
            loaded: this.loaded,
            sourceFiles: Object.keys(this.shaderSources).length,
            compiledVariants: names.length,
            variantNames: names,
            testRendering: this.testRendering,
            testVertices: this.testVertexCount || 0,
            framesRendered: this.frameCount
        };
    }
}

// Export
window.TSTOShaderManager = TSTOShaderManager;
