/**
 * TSTO Web Emulator — Logger
 * Routes logs to #log-container and browser console
 * Smart dedup: detects both consecutive identical lines AND repeating patterns (cycles)
 */
const Logger = {
    panel: null,
    maxLines: 500,
    lineCount: 0,

    // Dedup state
    _lastMsg: null,
    _lastLine: null,
    _repeatCount: 0,

    // Pattern (cycle) detection: detects repeating groups of 2-8 lines
    _recentMsgs: [],       // rolling buffer of recent messages
    _maxPatternLen: 8,     // max cycle length to detect
    _patternLen: 0,        // current detected pattern length (0 = none)
    _patternCount: 0,      // how many times the pattern has repeated
    _patternLine: null,    // DOM element showing the pattern summary
    _patternSuppressed: 0, // lines suppressed by pattern dedup

    init() {
        this.panel = document.getElementById('log-container');
    },

    /**
     * Check if the last N messages form a repeating pattern of length `len`
     */
    _matchesPattern(len) {
        var buf = this._recentMsgs;
        if (buf.length < len * 2) return false;
        var start1 = buf.length - len;
        var start2 = buf.length - len * 2;
        for (var i = 0; i < len; i++) {
            if (buf[start1 + i] !== buf[start2 + i]) return false;
        }
        return true;
    },

    _log(cls, prefix, ...args) {
        const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
        const full = `[${prefix}] ${msg}`;

        // === 1. Exact consecutive dedup ===
        if (full === this._lastMsg && this._lastLine) {
            this._repeatCount++;
            this._lastLine.textContent = this._lastMsg + '  x' + this._repeatCount;
            if (this.panel) this.panel.scrollTop = this.panel.scrollHeight;
            return;
        }

        // Flush repeat count into recent buffer if needed
        this._lastMsg = full;
        this._repeatCount = 1;

        // === 2. Pattern (cycle) dedup ===
        this._recentMsgs.push(full);
        if (this._recentMsgs.length > this._maxPatternLen * 3) {
            this._recentMsgs.splice(0, this._recentMsgs.length - this._maxPatternLen * 3);
        }

        // If we already have an active pattern, check if it continues
        if (this._patternLen > 0) {
            var pl = this._patternLen;
            var buf = this._recentMsgs;
            var expected = buf[buf.length - 1 - pl];
            if (full === expected) {
                // Pattern continues
                this._patternSuppressed++;
                // Update counter on every full cycle
                if (this._patternSuppressed % pl === 0) {
                    this._patternCount++;
                    if (this._patternLine) {
                        this._patternLine.textContent = '  ↻ ... repeating ' + pl + '-line pattern  x' + this._patternCount;
                    }
                    if (this.panel) this.panel.scrollTop = this.panel.scrollHeight;
                }
                return;
            } else {
                // Pattern broken — reset
                this._patternLen = 0;
                this._patternCount = 0;
                this._patternSuppressed = 0;
                this._patternLine = null;
            }
        }

        // Try to detect a new pattern (lengths 2 to maxPatternLen)
        for (var len = 2; len <= this._maxPatternLen; len++) {
            if (this._matchesPattern(len)) {
                this._patternLen = len;
                this._patternCount = 2; // we've seen it twice already
                this._patternSuppressed = 0;

                // Remove the duplicate lines from the UI (the second copy)
                if (this.panel) {
                    for (var i = 0; i < len; i++) {
                        if (this.panel.lastChild && this.panel.lastChild !== this._patternLine) {
                            this.panel.removeChild(this.panel.lastChild);
                            this.lineCount--;
                        }
                    }
                    // Add summary line
                    var sumLine = document.createElement('div');
                    sumLine.className = 'log-warn';
                    sumLine.textContent = '  ↻ ... repeating ' + len + '-line pattern  x' + this._patternCount;
                    this.panel.appendChild(sumLine);
                    this._patternLine = sumLine;
                    this._lastLine = sumLine;
                    this.lineCount++;
                    this.panel.scrollTop = this.panel.scrollHeight;
                }
                return;
            }
        }

        // === 3. Normal output ===
        if (this.panel) {
            const line = document.createElement('div');
            line.className = cls;
            line.textContent = full;
            this.panel.appendChild(line);
            this._lastLine = line;
            this.lineCount++;
            if (this.lineCount > this.maxLines) {
                if (this.panel.firstChild === this._lastLine) {
                    this._lastLine = null;
                    this._lastMsg = null;
                }
                if (this.panel.firstChild === this._patternLine) {
                    this._patternLine = null;
                    this._patternLen = 0;
                }
                this.panel.removeChild(this.panel.firstChild);
                this.lineCount--;
            }
            this.panel.scrollTop = this.panel.scrollHeight;
        }
        console.log(full);
    },

    info(...args)    { this._log('log-info',  'INFO', ...args); },
    warn(...args)    { this._log('log-warn',  'WARN', ...args); },
    error(...args)   { this._log('log-error', 'ERR',  ...args); },
    success(...args) { this._log('log-info',  '✅',   ...args); },
    gl(...args)      { this._log('log-gl',    'GL',   ...args); },
    elf(...args)     { this._log('log-info',  'ELF',  ...args); },
    jni(...args)     { this._log('log-warn',  'JNI',  ...args); },
    arm(...args)     { this._log('log-info',  'ARM',  ...args); },
};
