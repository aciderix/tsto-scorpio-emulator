/**
 * TSTO Web Emulator — ELF Loader
 * Parses ARM ELF shared library headers, segments, symbols, and relocations
 * Compatible with libscorpio.so from TSTO APK
 * 
 * v11: Added relocation categorization (R_ARM_RELATIVE, R_ARM_ABS32)
 *      Added VA-to-file-offset conversion for data relocation application
 */
class ElfLoader {
    constructor(buffer) {
        this.buffer = buffer;
        this.data = new DataView(buffer);
        this.u8 = new Uint8Array(buffer);

        // ELF header fields
        this.entry = 0;
        this.phoff = 0;
        this.shoff = 0;
        this.phnum = 0;
        this.shnum = 0;
        this.shstrndx = 0;

        // Parsed data
        this.segments = [];
        this.sections = [];
        this.symbols = [];
        this.exportedSymbols = new Map();  // name -> { value, size, info }
        this.pltRelocations = [];          // R_ARM_JUMP_SLOT(22) + R_ARM_GLOB_DAT(21)
        this.relativeRelocations = [];     // R_ARM_RELATIVE(23)
        this.absRelocations = [];          // R_ARM_ABS32(2)
        this.relocations = [];             // ALL relocations
        this.dynamicEntries = [];

        // Memory layout
        this.maxVAddr = 0;
        this.mapSize = 0;
    }

    // Read helpers (little-endian ARM)
    u32(offset) { return this.data.getUint32(offset, true); }
    u16(offset) { return this.data.getUint16(offset, true); }
    u8at(offset) { return this.u8[offset]; }

    readString(offset, maxLen = 256) {
        let s = '';
        for (let i = 0; i < maxLen; i++) {
            const ch = this.u8[offset + i];
            if (ch === 0) break;
            s += String.fromCharCode(ch);
        }
        return s;
    }

    /**
     * Parse the entire ELF file
     */
    parse() {
        Logger.elf('Parsing ELF binary (' + (this.buffer.byteLength / 1024 / 1024).toFixed(1) + ' MB)...');

        // Verify magic
        if (this.u8[0] !== 0x7F || this.u8[1] !== 0x45 || this.u8[2] !== 0x4C || this.u8[3] !== 0x46) {
            throw new Error('Not a valid ELF file');
        }

        // ELF class (must be 32-bit for ARM)
        if (this.u8[4] !== 1) throw new Error('Not a 32-bit ELF');
        // Data encoding (must be little-endian)
        if (this.u8[5] !== 1) throw new Error('Not little-endian');
        // Machine type (must be ARM = 40)
        const machine = this.u16(18);
        if (machine !== 40) throw new Error('Not ARM ELF (machine=' + machine + ')');

        this.entry = this.u32(24);
        this.phoff = this.u32(28);
        this.shoff = this.u32(32);
        this.phnum = this.u16(44);
        this.shnum = this.u16(48);
        this.shstrndx = this.u16(50);

        Logger.elf(`Entry: 0x${this.entry.toString(16)}, ${this.phnum} program headers, ${this.shnum} section headers`);

        this._parseSegments();
        this._parseSections();
        this._parseDynamic();
        this._parseSymbols();
        this._parseRelocations();

        Logger.success(`ELF parsed: ${this.exportedSymbols.size} exports, ${this.pltRelocations.length} PLT, ${this.relativeRelocations.length} RELATIVE, mapSize=0x${this.mapSize.toString(16)}`);
        return this;
    }

    _parseSegments() {
        for (let i = 0; i < this.phnum; i++) {
            const off = this.phoff + i * 32; // 32 bytes per phdr for ELF32
            const seg = {
                type:     this.u32(off),
                offset:   this.u32(off + 4),
                vaddr:    this.u32(off + 8),
                paddr:    this.u32(off + 12),
                filesz:   this.u32(off + 16),
                memsz:    this.u32(off + 20),
                flags:    this.u32(off + 24),
                align:    this.u32(off + 28),
            };

            const end = seg.vaddr + seg.memsz;
            if (end > this.maxVAddr) this.maxVAddr = end;
            this.segments.push(seg);

            // PT_LOAD = 1
            if (seg.type === 1) {
                const bss = seg.memsz > seg.filesz ? seg.memsz - seg.filesz : 0;
                const flagStr = ((seg.flags & 4) ? 'R' : '-') + ((seg.flags & 2) ? 'W' : '-') + ((seg.flags & 1) ? 'X' : '-');
                Logger.elf(`  LOAD VA=0x${seg.vaddr.toString(16)} fileOff=0x${seg.offset.toString(16)} filesz=0x${seg.filesz.toString(16)} memsz=0x${seg.memsz.toString(16)} ${flagStr} BSS=0x${bss.toString(16)}`);
            }
        }

        this.mapSize = (this.maxVAddr + 0xFFF) & ~0xFFF;
        Logger.elf(`Virtual memory: 0x0 - 0x${this.maxVAddr.toString(16)}, mapSize=0x${this.mapSize.toString(16)}`);
    }

    _parseSections() {
        if (this.shoff === 0 || this.shnum === 0) return;

        for (let i = 0; i < this.shnum; i++) {
            const off = this.shoff + i * 40; // 40 bytes per shdr for ELF32
            this.sections.push({
                nameIdx:  this.u32(off),
                type:     this.u32(off + 4),
                flags:    this.u32(off + 8),
                addr:     this.u32(off + 12),
                offset:   this.u32(off + 16),
                size:     this.u32(off + 20),
                link:     this.u32(off + 24),
                info:     this.u32(off + 28),
                addralign:this.u32(off + 32),
                entsize:  this.u32(off + 36),
            });
        }
    }

    _parseDynamic() {
        // Find PT_DYNAMIC segment (type = 2)
        const dynSeg = this.segments.find(s => s.type === 2);
        if (!dynSeg) return;

        for (let off = dynSeg.offset; off < dynSeg.offset + dynSeg.filesz; off += 8) {
            const tag = this.u32(off);
            const val = this.u32(off + 4);
            if (tag === 0) break; // DT_NULL
            this.dynamicEntries.push({ tag, val });
        }
    }

    _getDynVal(tag) {
        const e = this.dynamicEntries.find(d => d.tag === tag);
        return e ? e.val : null;
    }

    _parseSymbols() {
        // Find .dynsym section (type = 11 = SHT_DYNSYM)
        const dynsymSec = this.sections.find(s => s.type === 11);
        if (!dynsymSec) {
            Logger.warn('No .dynsym section found');
            return;
        }

        // Find associated string table
        const strSec = this.sections[dynsymSec.link];
        if (!strSec) {
            Logger.warn('No string table for .dynsym');
            return;
        }

        const entSize = dynsymSec.entsize || 16;
        const count = Math.floor(dynsymSec.size / entSize);

        for (let i = 0; i < count; i++) {
            const off = dynsymSec.offset + i * entSize;
            const sym = {
                nameIdx: this.u32(off),
                value:   this.u32(off + 4),
                size:    this.u32(off + 8),
                info:    this.u8at(off + 12),
                other:   this.u8at(off + 13),
                shndx:   this.u16(off + 14),
            };

            // Read name from string table
            sym.name = this.readString(strSec.offset + sym.nameIdx);

            // Binding: (info >> 4), Type: (info & 0xf)
            const bind = sym.info >> 4;
            const type = sym.info & 0xf;

            // Export if GLOBAL or WEAK and has a value
            if ((bind === 1 || bind === 2) && sym.value !== 0 && sym.name) {
                this.exportedSymbols.set(sym.name, sym);
            }
            this.symbols.push(sym);
        }

        Logger.elf(`Symbols: ${count} total, ${this.exportedSymbols.size} exported`);
    }

    _parseRelocations() {
        // Relocation type counts for logging
        const typeCounts = {};

        for (const sec of this.sections) {
            // SHT_REL = 9, SHT_RELA = 4
            if (sec.type !== 9 && sec.type !== 4) continue;

            const isRela = sec.type === 4;
            const entSize = isRela ? 12 : 8;
            const count = Math.floor(sec.size / entSize);

            // Get the symbol table this relocation references
            const symSec = this.sections[sec.link];
            const strSec = symSec ? this.sections[symSec.link] : null;

            for (let i = 0; i < count; i++) {
                const off = sec.offset + i * entSize;
                const rel = {
                    offset: this.u32(off),
                    info:   this.u32(off + 4),
                    addend: isRela ? this.u32(off + 8) : 0,
                };

                const symIdx = rel.info >> 8;
                const type = rel.info & 0xFF;
                rel.type = type;

                // Count types
                typeCounts[type] = (typeCounts[type] || 0) + 1;

                // Get symbol name, value, and section index
                if (symSec && symIdx > 0 && symIdx < Math.floor(symSec.size / (symSec.entsize || 16))) {
                    const symOff = symSec.offset + symIdx * (symSec.entsize || 16);
                    const nameIdx = this.u32(symOff);
                    const symValue = this.u32(symOff + 4);
                    const symShndx = this.u16(symOff + 14);

                    if (strSec) {
                        rel.symName = this.readString(strSec.offset + nameIdx);
                    }
                    rel.symValue = symValue;
                    rel.symShndx = symShndx;
                }

                // Categorize by type
                switch (type) {
                    case 23: // R_ARM_RELATIVE
                        this.relativeRelocations.push(rel);
                        break;
                    case 2:  // R_ARM_ABS32
                        this.absRelocations.push(rel);
                        break;
                    case 21: // R_ARM_GLOB_DAT
                    case 22: // R_ARM_JUMP_SLOT
                        if (rel.symName) {
                            this.pltRelocations.push(rel);
                        }
                        break;
                    // Types 0 (NONE), 3 (REL32), etc. — skip
                }

                this.relocations.push(rel);
            }
        }

        // Log breakdown
        Logger.elf(`Relocations: ${this.relocations.length} total`);
        Logger.elf(`  R_ARM_RELATIVE (23): ${this.relativeRelocations.length}`);
        Logger.elf(`  R_ARM_ABS32 (2):     ${this.absRelocations.length}`);
        Logger.elf(`  R_ARM_GLOB_DAT (21): ${typeCounts[21] || 0}`);
        Logger.elf(`  R_ARM_JUMP_SLOT(22): ${typeCounts[22] || 0}`);

        // Log any other types found
        for (const [t, c] of Object.entries(typeCounts)) {
            if (![2, 21, 22, 23].includes(Number(t)) && c > 0) {
                Logger.elf(`  Type ${t}: ${c}`);
            }
        }
    }

    /**
     * Convert a virtual address (relative to binary base 0) to a file offset
     * Returns null if the VA is in BSS or outside any LOAD segment
     */
    vaToFileOffset(va) {
        for (const seg of this.segments) {
            if (seg.type !== 1) continue; // PT_LOAD only
            if (va >= seg.vaddr && va < seg.vaddr + seg.filesz) {
                return seg.offset + (va - seg.vaddr);
            }
        }
        return null; // In BSS or unmapped
    }

    /**
     * Check if a VA falls within any LOAD segment (including BSS)
     */
    isVAMapped(va) {
        for (const seg of this.segments) {
            if (seg.type !== 1) continue;
            if (va >= seg.vaddr && va < seg.vaddr + seg.memsz) {
                return true;
            }
        }
        return false;
    }

    /**
     * Get all JNI-exported functions
     */
    getJNIFunctions() {
        const jniFuncs = [];
        for (const [name, sym] of this.exportedSymbols) {
            if (name.startsWith('Java_') || name === 'JNI_OnLoad' || name === 'JNI_OnUnload') {
                jniFuncs.push({ name, offset: sym.value, size: sym.size });
            }
        }
        return jniFuncs;
    }

    /**
     * Get all GL function imports (for WebGL bridge)
     */
    getGLImports() {
        return this.pltRelocations
            .filter(r => r.symName && r.symName.startsWith('gl'))
            .map(r => ({ name: r.symName, gotAddr: r.offset }));
    }

    /**
     * Get a named symbol's offset
     */
    getSymbolOffset(name) {
        const sym = this.exportedSymbols.get(name);
        return sym ? sym.value : null;
    }

    /**
     * Get writable LOAD segments (for data relocation re-write)
     */
    getWritableSegments() {
        return this.segments.filter(s => s.type === 1 && (s.flags & 2));
    }
}
