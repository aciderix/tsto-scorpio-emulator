/**
 * TSTO Web Emulator — Logger
 * Routes logs to #log-container and browser console
 */
const Logger = {
    panel: null,
    maxLines: 500,
    lineCount: 0,
    _lastMsg: null,
    _lastLine: null,
    _repeatCount: 0,

    init() {
        this.panel = document.getElementById('log-container');
    },

    _log(cls, prefix, ...args) {
        const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
        const full = `[${prefix}] ${msg}`;

        // Deduplicate repeated lines
        if (full === this._lastMsg && this._lastLine) {
            this._repeatCount++;
            this._lastLine.textContent = full + '  x' + this._repeatCount;
            if (this.panel) this.panel.scrollTop = this.panel.scrollHeight;
            return;
        }

        // New distinct message
        this._lastMsg = full;
        this._repeatCount = 1;

        // UI log
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
