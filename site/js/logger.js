/**
 * TSTO Web Emulator — Logger
 * Routes logs to #log-container and browser console
 */
const Logger = {
    panel: null,
    maxLines: 500,
    lineCount: 0,

    init() {
        this.panel = document.getElementById('log-container');
    },

    _log(cls, prefix, ...args) {
        const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
        
        // UI log
        if (this.panel) {
            const line = document.createElement('div');
            line.className = cls;
            line.textContent = `[${prefix}] ${msg}`;
            this.panel.appendChild(line);
            this.lineCount++;
            if (this.lineCount > this.maxLines) {
                this.panel.removeChild(this.panel.firstChild);
                this.lineCount--;
            }
            this.panel.scrollTop = this.panel.scrollHeight;
        }
        console.log(`[${prefix}]`, ...args);
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
