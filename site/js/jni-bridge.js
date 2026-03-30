/**
 * TSTO Web Emulator — JNI Bridge v3.0
 * Real JNI function table with smart field/method handling
 * 
 * v3.0 FIXES:
 * - prepareBGCoreInit now passes a proper BGAndroidInfo jobject (not width/height)
 * - GetIntField/GetFloatField/GetObjectField return correct values based on field name
 * - Field name tracking via _fieldRegistry
 * - Verbose logging during init for debugging
 */
class JNIBridge {
    constructor() {
        // Memory layout
        this.JNIENV_BASE    = 0xD0000000;
        this.JNIENV_VTABLE  = 0xD0001000;
        this.JAVA_VM_BASE   = 0xD0010000;
        this.JAVA_VM_VTABLE = 0xD0011000;
        this.JOBJECT_BASE   = 0xD0020000;
        this.JSTRING_HEAP   = 0xC0000000;
        this.JSTRING_HEAP_SIZE = 1024 * 1024;
        this.RETURN_STUB    = 0xE0000000;

        // Object pool - fake objects with their fields
        this.BGANDROIDINFO_OBJ = 0xD0040000;
        
        // Registries
        this._classes = new Map();
        this._methods = new Map();
        this._fields = new Map();
        this._fieldRegistry = new Map();  // v3.0: fieldId -> { clazz, name, sig }
        this._methodRegistry = new Map(); // v3.0: methodId -> { clazz, name, sig }
        this._strings = new Map();
        this._stringPtrs = new Map();
        this._globalRefs = new Set();
        this._registeredNatives = [];

        // ID counters
        this._nextClassId   = 0xD0020100;
        this._nextMethodId  = 0xD0020200;
        this._nextFieldId   = 0xD0020300;
        this._nextStringId  = 0xD0030000;
        this._nextStringAddr = 0xC0000000;

        // v3.0: Screen config (set by prepareBGCoreInit)
        this._screenWidth = 960;
        this._screenHeight = 640;
        this._screenDensity = 2.0;

        // v15.5: SharedPreferences with real game values
        this._sharedPreferences = {
            'bundleID': 'com.ea.game.simpsons4_row',
            'MHClientVersion': '4.65.5',
            'SellId': '859',
            'Region': 'row',
            'ServerEnvironment': 'prod',
            'DLCSource': 'dlc',
            'DLCLocation': '/data/data/com.ea.game.simpsons4_row/files/',
            'LandDataVersion': '4.65.5',
            'DebugMenuOnStart': '0',
            'DebugMenuDisabled': '1',
            'ShowVersionsInAbout': '0',
            'TntGameId': 'simpsons4',
            'SubPlatform': 'android',
            'CustomClientConfigEnabled': '0',
            'CustomGameplayConfigEnabled': '0',
            'CustomClientConfigFileName': '',
            'CustomGameplayConfigFileName': '',
            'CustomConfigBasicAuth': '',
            'ServerErrorReason': '',
            'DLCSecretKey': 'tapped_out_secret_key_2013',
            'language': 'eng_us',
        };

        // Logging
        this._jniCallCounts = new Map();
        this._maxLogPerFunc = 50; // v27: increased to capture boolean/void method calls
        this.callLog = [];
        this._verboseInit = true; // v3.0: verbose during init
    }

    setup(emu) {
        this.emu = emu;
        Logger.jni('Setting up JNI environment v3.0...');

        try {
            emu.mem_map(this.JSTRING_HEAP, this.JSTRING_HEAP_SIZE, uc.PROT_ALL);
        } catch(e) {
            Logger.warn('String heap region overlap, skipping map');
        }

        // JNIEnv* → vtable (correct single indirection)
        this._writeU32(this.JNIENV_BASE, this.JNIENV_VTABLE);

        // Fill vtable with unique addresses per slot (for debugging unhandled JNI calls)
        // Each slot gets RETURN_STUB + slot*4 — all map to the same page with BX LR
        // v29: JNI_STUB_BASE is inside SHIM region (0xE0000000-0xE00FFFFF), already mapped.
        // Previous code tried mem_map here → error 11 (overlap) → fell back to RETURN_STUB.
        // Now we just write directly — no extra mem_map needed.
        this.JNI_STUB_BASE = 0xE0080000;
        // Write MOV R0, #0; BX LR at each 8-byte aligned slot
        for (var i = 0; i < 256; i++) {
            var stubAddr = this.JNI_STUB_BASE + i * 8;
            emu.mem_write(stubAddr, [
                0x00, 0x00, 0xA0, 0xE3,  // MOV R0, #0
                0x1E, 0xFF, 0x2F, 0xE1,  // BX LR
            ]);
            this._writeU32(this.JNIENV_VTABLE + i * 4, stubAddr);
        }

        // JavaVM* → vtable
        this._writeU32(this.JAVA_VM_BASE, this.JAVA_VM_VTABLE);
        for (var i = 0; i < 16; i++) {
            this._writeU32(this.JAVA_VM_VTABLE + i * 4, this.RETURN_STUB);
        }

        // Fake jobject markers
        this._writeU32(this.JOBJECT_BASE, 0xDEAD0001);
        this._writeU32(this.BGANDROIDINFO_OBJ, 0xBEEF0001);

        // Pre-allocate known strings for the game
        this._preAllocStrings(emu);

        Logger.jni('JNI environment v3.0 ready');
        Logger.jni('  JNIEnv*  = 0x' + this.JNIENV_BASE.toString(16));
        Logger.jni('  JavaVM*  = 0x' + this.JAVA_VM_BASE.toString(16));
        Logger.jni('  Strings  = 0x' + this.JSTRING_HEAP.toString(16) + ' (1MB)');
        Logger.jni('  BGAndroidInfo = 0x' + this.BGANDROIDINFO_OBJ.toString(16));
    }

    /**
     * Pre-allocate strings that the game will need
     */
    _preAllocStrings(emu) {
        // File paths the game expects
        this._filesDir = this._allocString('/data/data/com.ea.game.simpsons4_row/files');
        this._obbPath = this._allocString('/sdcard/Android/obb/com.ea.game.simpsons4_row');
        this._apkPath = this._allocString('/data/app/com.ea.game.simpsons4_row.apk');
        this._cacheDir = this._allocString('/data/data/com.ea.game.simpsons4_row/cache');
        this._externalDir = this._allocString('/sdcard/Android/data/com.ea.game.simpsons4_row/files');
        this._packageName = this._allocString('com.ea.game.simpsons4_row');
        this._versionName = this._allocString('4.44.5');
        this._locale = this._allocString('en_US');
        this._emptyStr = this._allocString('');
        this._deviceModel = this._allocString('WebEmulator');
        this._osVersion = this._allocString('11');
        
        // Write UTF-8 data for each string to emulator memory
        for (var entry of this._strings) {
            this._getOrWriteStringPtr(emu, entry[0]);
        }
    }

    // ================================================================
    // JNI FUNCTION TABLE HANDLERS
    // ================================================================

    getJNIVtableHandlers() {
        var self = this;
        return {
            // ---- Core ----
            4: { name: 'GetVersion', handler: function(emu, args) { return 0x00010006; } },

            6: { name: 'FindClass', handler: function(emu, args) {
                var name = self._readCString(emu, args[1]);
                var id = self._getOrCreateClass(name);
                self._logJNI('FindClass', name + ' → 0x' + id.toString(16));
                return id;
            }},

            10: { name: 'GetSuperclass', handler: function(emu, args) {
                return self._getOrCreateClass('java/lang/Object');
            }},
            11: { name: 'IsAssignableFrom', handler: function(emu, args) { return 1; } },

            // ---- Exceptions ----
            15: { name: 'ExceptionOccurred', handler: function(emu, args) { return 0; } },
            16: { name: 'ExceptionDescribe', handler: function(emu, args) { return 0; } },
            17: { name: 'ExceptionClear', handler: function(emu, args) { return 0; } },
            228: { name: 'ExceptionCheck', handler: function(emu, args) { return 0; } },

            // ---- References ----
            19: { name: 'PushLocalFrame', handler: function(emu, args) { return 0; } },
            20: { name: 'PopLocalFrame', handler: function(emu, args) { return args[1]; } },
            21: { name: 'NewGlobalRef', handler: function(emu, args) {
                self._globalRefs.add(args[1]);
                self._logJNI('NewGlobalRef', '0x' + (args[1]>>>0).toString(16));
                return args[1];
            }},
            22: { name: 'DeleteGlobalRef', handler: function(emu, args) { self._globalRefs.delete(args[1]); return 0; } },
            23: { name: 'DeleteLocalRef', handler: function(emu, args) { return 0; } },
            24: { name: 'IsSameObject', handler: function(emu, args) { return (args[1] === args[2]) ? 1 : 0; } },
            25: { name: 'NewLocalRef', handler: function(emu, args) { return args[1]; } },
            26: { name: 'EnsureLocalCapacity', handler: function(emu, args) { return 0; } },

            // ---- Object creation ----
            28: { name: 'NewObject', handler: function(emu, args) { return self.JOBJECT_BASE + 0x1000; } },
            29: { name: 'NewObjectV', handler: function(emu, args) { return self.JOBJECT_BASE + 0x1000; } },
            30: { name: 'NewObjectA', handler: function(emu, args) { return self.JOBJECT_BASE + 0x1000; } },
            31: { name: 'GetObjectClass', handler: function(emu, args) {
                // Return specific class for known objects
                if (args[1] === self.BGANDROIDINFO_OBJ) {
                    return self._getOrCreateClass('com/bight/android/jni/BGAndroidInfo');
                }
                return self._getOrCreateClass('java/lang/Object');
            }},
            32: { name: 'IsInstanceOf', handler: function(emu, args) { return 1; } },

            // ---- Methods ----
            33: { name: 'GetMethodID', handler: function(emu, args) {
                var name = self._readCString(emu, args[2]);
                var sig = self._readCString(emu, args[3]);
                var id = self._getOrCreateMethod(args[1], name, sig);
                self._logJNI('GetMethodID', name + sig + ' → 0x' + id.toString(16));
                return id;
            }},

            // CallObjectMethod/V/A (34-36)
            34: { name: 'CallObjectMethod', handler: function(emu, args) { return self._handleCallMethod('Object', emu, args); } },
            35: { name: 'CallObjectMethodV', handler: function(emu, args) { return self._handleCallMethod('Object', emu, args); } },
            36: { name: 'CallObjectMethodA', handler: function(emu, args) { return self._handleCallMethod('Object', emu, args); } },

            // CallBooleanMethod (37-39)
            37: { name: 'CallBooleanMethod', handler: function(emu, args) { return self._handleBooleanMethod(emu, args); } },
            38: { name: 'CallBooleanMethodV', handler: function(emu, args) { return self._handleBooleanMethod(emu, args); } },
            39: { name: 'CallBooleanMethodA', handler: function(emu, args) { return self._handleBooleanMethod(emu, args); } },

            // CallIntMethod (49-51) - v3.0: return sensible values
            49: { name: 'CallIntMethod', handler: function(emu, args) {
                self._logJNI('CallIntMethod', 'obj=0x' + (args[1]>>>0).toString(16) + ' method=0x' + (args[2]>>>0).toString(16));
                return self._handleCallIntMethod(emu, args);
            }},
            50: { name: 'CallIntMethodV', handler: function(emu, args) { return self._handleCallIntMethod(emu, args); } },
            51: { name: 'CallIntMethodA', handler: function(emu, args) { return self._handleCallIntMethod(emu, args); } },

            // CallVoidMethod (61-63)
            61: { name: 'CallVoidMethod', handler: function(emu, args) {
                self._logJNI('CallVoidMethod', 'obj=0x' + (args[1]>>>0).toString(16) + ' method=0x' + (args[2]>>>0).toString(16));
                return 0;
            }},
            62: { name: 'CallVoidMethodV', handler: function(emu, args) { return 0; } },
            63: { name: 'CallVoidMethodA', handler: function(emu, args) { return 0; } },

            // Other Call*Method stubs
            40: { name: 'CallByteMethod', handler: function(emu, args) { return 0; } },
            41: { name: 'CallByteMethodV', handler: function(emu, args) { return 0; } },
            42: { name: 'CallByteMethodA', handler: function(emu, args) { return 0; } },
            43: { name: 'CallCharMethod', handler: function(emu, args) { return 0; } },
            44: { name: 'CallCharMethodV', handler: function(emu, args) { return 0; } },
            45: { name: 'CallCharMethodA', handler: function(emu, args) { return 0; } },
            46: { name: 'CallShortMethod', handler: function(emu, args) { return 0; } },
            47: { name: 'CallShortMethodV', handler: function(emu, args) { return 0; } },
            48: { name: 'CallShortMethodA', handler: function(emu, args) { return 0; } },
            52: { name: 'CallLongMethod', handler: function(emu, args) { return 0; } },
            53: { name: 'CallLongMethodV', handler: function(emu, args) { return 0; } },
            54: { name: 'CallLongMethodA', handler: function(emu, args) { return 0; } },
            55: { name: 'CallFloatMethod', handler: function(emu, args) { return 0; } },
            56: { name: 'CallFloatMethodV', handler: function(emu, args) { return 0; } },
            57: { name: 'CallFloatMethodA', handler: function(emu, args) { return 0; } },
            58: { name: 'CallDoubleMethod', handler: function(emu, args) { return 0; } },
            59: { name: 'CallDoubleMethodV', handler: function(emu, args) { return 0; } },
            60: { name: 'CallDoubleMethodA', handler: function(emu, args) { return 0; } },

            // ---- Fields ---- (v3.0: with name tracking)
            94: { name: 'GetFieldID', handler: function(emu, args) {
                var name = self._readCString(emu, args[2]);
                var sig = self._readCString(emu, args[3]);
                var id = self._getOrCreateField(args[1], name, sig);
                self._logJNI('GetFieldID', name + ':' + sig + ' → 0x' + id.toString(16));
                return id;
            }},

            // v3.0: Smart field getters that return real values
            95: { name: 'GetObjectField', handler: function(emu, args) {
                return self._handleGetObjectField(emu, args[1], args[2]);
            }},
            96: { name: 'GetBooleanField', handler: function(emu, args) {
                return self._handleGetBooleanField(emu, args[1], args[2]);
            }},
            97: { name: 'GetByteField', handler: function(emu, args) { return 0; } },
            98: { name: 'GetCharField', handler: function(emu, args) { return 0; } },
            99: { name: 'GetShortField', handler: function(emu, args) { return 0; } },
            100: { name: 'GetIntField', handler: function(emu, args) {
                return self._handleGetIntField(emu, args[1], args[2]);
            }},
            101: { name: 'GetLongField', handler: function(emu, args) { return 0; } },
            102: { name: 'GetFloatField', handler: function(emu, args) {
                return self._handleGetFloatField(emu, args[1], args[2]);
            }},
            103: { name: 'GetDoubleField', handler: function(emu, args) { return 0; } },

            104: { name: 'SetObjectField', handler: function(emu, args) { return 0; } },
            105: { name: 'SetBooleanField', handler: function(emu, args) { return 0; } },
            106: { name: 'SetByteField', handler: function(emu, args) { return 0; } },
            107: { name: 'SetCharField', handler: function(emu, args) { return 0; } },
            108: { name: 'SetShortField', handler: function(emu, args) { return 0; } },
            109: { name: 'SetIntField', handler: function(emu, args) { return 0; } },
            110: { name: 'SetLongField', handler: function(emu, args) { return 0; } },
            111: { name: 'SetFloatField', handler: function(emu, args) { return 0; } },
            112: { name: 'SetDoubleField', handler: function(emu, args) { return 0; } },

            // ---- Static Methods ----
            113: { name: 'GetStaticMethodID', handler: function(emu, args) {
                var name = self._readCString(emu, args[2]);
                var sig = self._readCString(emu, args[3]);
                var id = self._getOrCreateMethod(args[1], name, sig);
                self._logJNI('GetStaticMethodID', name + sig + ' → 0x' + id.toString(16));
                return id;
            }},

            114: { name: 'CallStaticObjectMethod', handler: function(emu, args) { return self._handleCallMethod('StaticObject', emu, args); } },
            115: { name: 'CallStaticObjectMethodV', handler: function(emu, args) { return self._handleCallMethod('StaticObject', emu, args); } },
            116: { name: 'CallStaticObjectMethodA', handler: function(emu, args) { return self._handleCallMethod('StaticObject', emu, args); } },
            117: { name: 'CallStaticBooleanMethod', handler: function(emu, args) { return self._handleBooleanMethod(emu, args); } },
            118: { name: 'CallStaticBooleanMethodV', handler: function(emu, args) { return self._handleBooleanMethod(emu, args); } },
            119: { name: 'CallStaticBooleanMethodA', handler: function(emu, args) { return self._handleBooleanMethod(emu, args); } },
            120: { name: 'CallStaticByteMethod', handler: function(emu, args) { return 0; } },
            121: { name: 'CallStaticByteMethodV', handler: function(emu, args) { return 0; } },
            122: { name: 'CallStaticByteMethodA', handler: function(emu, args) { return 0; } },
            129: { name: 'CallStaticIntMethod', handler: function(emu, args) {
                self._logJNI('CallStaticIntMethod', 'class=0x' + (args[1]>>>0).toString(16) + ' method=0x' + (args[2]>>>0).toString(16));
                return 0;
            }},
            130: { name: 'CallStaticIntMethodV', handler: function(emu, args) { return 0; } },
            131: { name: 'CallStaticIntMethodA', handler: function(emu, args) { return 0; } },
            126: { name: 'CallStaticShortMethod', handler: function(emu, args) { return 0; } },
            132: { name: 'CallStaticLongMethod', handler: function(emu, args) {
                var method = self._methodRegistry.get(args[2]);
                var name = method ? method.name : '?';
                self._logJNI('CallStaticLongMethod', name + ' class=0x' + (args[1]>>>0).toString(16));
                // Return large value (e.g. available storage space in bytes)
                // Long on ARM: low 32 bits in R0, high 32 bits in R1
                try { emu.reg_write(1, [0, 0, 0, 0]); } catch(e) {} // R1 = 0 (high)
                return 0x40000000; // ~1GB (low 32 bits)
            }},
            133: { name: 'CallStaticLongMethodV', handler: function(emu, args) {
                var method = self._methodRegistry.get(args[2]);
                var name = method ? method.name : '?';
                self._logJNI('CallStaticLongMethodV', name + ' class=0x' + (args[1]>>>0).toString(16));
                try { emu.reg_write(1, [0, 0, 0, 0]); } catch(e) {} // R1 = 0 (high)
                return 0x40000000; // ~1GB
            }},
            134: { name: 'CallStaticLongMethodA', handler: function(emu, args) {
                try { emu.reg_write(1, [0, 0, 0, 0]); } catch(e) {}
                return 0x40000000;
            }},
            135: { name: 'CallStaticFloatMethod', handler: function(emu, args) { return 0; } },
            138: { name: 'CallStaticDoubleMethod', handler: function(emu, args) { return 0; } },
            141: { name: 'CallStaticVoidMethod', handler: function(emu, args) {
                self._logJNI('CallStaticVoidMethod', 'class=0x' + (args[1]>>>0).toString(16) + ' method=0x' + (args[2]>>>0).toString(16));
                return 0;
            }},
            142: { name: 'CallStaticVoidMethodV', handler: function(emu, args) {
                var methodId = args[2];
                var method = self._methodRegistry.get(methodId);
                var name = method ? method.name : '?';
                self._logJNI('CallStaticVoidMethodV', name + ' class=0x' + (args[1]>>>0).toString(16));
                // Intercept closeApp — game wants to quit but we keep running
                if (name === 'closeApp') {
                    Logger.warn('[JNI] closeApp intercepted — game wants to quit, ignoring');
                }
                // v32: Intercept showDialog — read va_list args properly
                if (name === 'showDialog') {
                    // CallStaticVoidMethodV: args = [env, class, methodID, va_list]
                    // va_list points to 3 jstring values on the stack
                    var vaPtr = args[3];
                    var titleHandle = 0, msgHandle = 0, btnHandle = 0;
                    try {
                        titleHandle = self._readU32Emu(emu, vaPtr);
                        msgHandle = self._readU32Emu(emu, vaPtr + 4);
                        btnHandle = self._readU32Emu(emu, vaPtr + 8);
                    } catch(e) {}
                    var title = self._strings.get(titleHandle) || self._strings.get(args[3]) || '?';
                    var msg = self._strings.get(msgHandle) || self._strings.get(args[4]) || '?';
                    Logger.warn('[JNI] showDialog: title="' + title + '" msg="' + msg + '"');

                    // v37: Schedule auto-dismiss of dialog via alertButtonPressed
                    if (self.engine) {
                        self.engine._pendingAlertDismiss = true;
                        Logger.info('[v37] showDialog detected — scheduling alertButtonPressed(0) for next frame');
                    }

                    // v32: If NO TEXT POOL, dump recent shim calls for diagnosis
                    if (title.indexOf('TEXT POOL') >= 0 || msg.indexOf('TEXT POOL') >= 0 ||
                        title === '?' || msg === '?') {
                        Logger.warn('[JNI] showDialog handles: title=0x' + (titleHandle>>>0).toString(16) +
                            ' msg=0x' + (msgHandle>>>0).toString(16) + ' btn=0x' + (btnHandle>>>0).toString(16));
                        Logger.warn('[JNI] showDialog va_list at 0x' + (vaPtr>>>0).toString(16));
                        // Dump all string handles for debugging
                        Logger.warn('[JNI] String table (' + self._strings.size + ' entries):');
                        var strCount = 0;
                        for (var entry of self._strings) {
                            if (strCount < 30) {
                                Logger.warn('  0x' + (entry[0]>>>0).toString(16) + ' → "' + entry[1].substring(0, 50) + '"');
                            }
                            strCount++;
                        }
                        // v35: Dump FILE struct state for open files
                        if (window._filePtrToFd && window._filePtrToFd.size > 0) {
                            Logger.warn('[v35] Open FILE handles (' + window._filePtrToFd.size + '):');
                            for (var entry of window._filePtrToFd) {
                                var fp = entry[0], fdx = entry[1];
                                try {
                                    var fpBytes = emu.mem_read(fp, 24);
                                    var curP = (fpBytes[0] | (fpBytes[1]<<8) | (fpBytes[2]<<16) | (fpBytes[3]<<24)) >>> 0;
                                    var curR = (fpBytes[4] | (fpBytes[5]<<8) | (fpBytes[6]<<16) | (fpBytes[7]<<24)) >>> 0;
                                    var bfBase = (fpBytes[16] | (fpBytes[17]<<8) | (fpBytes[18]<<16) | (fpBytes[19]<<24)) >>> 0;
                                    var bfSize = (fpBytes[20] | (fpBytes[21]<<8) | (fpBytes[22]<<16) | (fpBytes[23]<<24)) >>> 0;
                                    var consumed = (curP - bfBase) >>> 0;
                                    Logger.warn('  FILE*=0x' + fp.toString(16) + ' fd=' + fdx +
                                        ' _p=0x' + curP.toString(16) + ' _r=' + curR +
                                        ' base=0x' + bfBase.toString(16) + ' size=' + bfSize +
                                        ' consumed=' + consumed);
                                } catch(e2) {
                                    Logger.warn('  FILE*=0x' + fp.toString(16) + ' fd=' + fdx + ' ERROR: ' + e2);
                                }
                            }
                        } else {
                            Logger.warn('[v35] No open FILE handles (all closed or map unavailable)');
                        }
                        // Dump recent shim calls from engine
                        if (self.engine && self.engine._recentShimCalls) {
                            Logger.warn('[v32] === RECENT SHIM CALLS before *NO TEXT POOL* ===');
                            for (var i = 0; i < self.engine._recentShimCalls.length; i++) {
                                var call = self.engine._recentShimCalls[i];
                                Logger.warn('  [' + i + '] ' + call.name + ' insn=' + call.insn +
                                    ' LR=0x' + (call.lr>>>0).toString(16) +
                                    ' R0=0x' + (call.r0>>>0).toString(16) +
                                    ' R1=0x' + (call.r1>>>0).toString(16) +
                                    ' R2=0x' + (call.r2>>>0).toString(16) +
                                    ' R3=0x' + (call.r3>>>0).toString(16));
                            }
                        }
                    }
                }
                return 0;
            } },
            143: { name: 'CallStaticVoidMethodA', handler: function(emu, args) { return 0; } },

            // ---- Static Fields ----
            144: { name: 'GetStaticFieldID', handler: function(emu, args) {
                var name = self._readCString(emu, args[2]);
                var sig = self._readCString(emu, args[3]);
                var id = self._getOrCreateField(args[1], name, sig);
                self._logJNI('GetStaticFieldID', name + ':' + sig + ' → 0x' + id.toString(16));
                return id;
            }},
            145: { name: 'GetStaticObjectField', handler: function(emu, args) {
                return self._handleGetStaticObjectField(emu, args[1], args[2]);
            }},
            146: { name: 'GetStaticBooleanField', handler: function(emu, args) { return 0; } },
            147: { name: 'GetStaticByteField', handler: function(emu, args) { return 0; } },
            148: { name: 'GetStaticCharField', handler: function(emu, args) { return 0; } },
            149: { name: 'GetStaticShortField', handler: function(emu, args) { return 0; } },
            150: { name: 'GetStaticIntField', handler: function(emu, args) {
                return self._handleGetStaticIntField(emu, args[1], args[2]);
            }},
            151: { name: 'GetStaticLongField', handler: function(emu, args) { return 0; } },
            152: { name: 'GetStaticFloatField', handler: function(emu, args) { return 0; } },
            153: { name: 'GetStaticDoubleField', handler: function(emu, args) { return 0; } },
            154: { name: 'SetStaticObjectField', handler: function(emu, args) { return 0; } },
            155: { name: 'SetStaticBooleanField', handler: function(emu, args) { return 0; } },
            156: { name: 'SetStaticByteField', handler: function(emu, args) { return 0; } },
            157: { name: 'SetStaticCharField', handler: function(emu, args) { return 0; } },
            158: { name: 'SetStaticShortField', handler: function(emu, args) { return 0; } },
            159: { name: 'SetStaticIntField', handler: function(emu, args) { return 0; } },
            160: { name: 'SetStaticLongField', handler: function(emu, args) { return 0; } },
            161: { name: 'SetStaticFloatField', handler: function(emu, args) { return 0; } },
            162: { name: 'SetStaticDoubleField', handler: function(emu, args) { return 0; } },

            // ---- Strings ----
            163: { name: 'NewString', handler: function(emu, args) { return self._allocString(''); } },
            164: { name: 'GetStringLength', handler: function(emu, args) {
                return (self._strings.get(args[1]) || '').length;
            }},
            165: { name: 'GetStringChars', handler: function(emu, args) {
                return self._getOrWriteStringPtr(emu, args[1]);
            }},
            166: { name: 'ReleaseStringChars', handler: function(emu, args) { return 0; } },

            167: { name: 'NewStringUTF', handler: function(emu, args) {
                var str = self._readCString(emu, args[1]);
                var id = self._allocString(str);
                self._logJNI('NewStringUTF', '"' + str.substring(0, 80) + '" → 0x' + id.toString(16));
                return id;
            }},
            168: { name: 'GetStringUTFLength', handler: function(emu, args) {
                return (self._strings.get(args[1]) || '').length;
            }},
            169: { name: 'GetStringUTFChars', handler: function(emu, args) {
                var ptr = self._getOrWriteStringPtr(emu, args[1]);
                if (args[2]) {
                    try { emu.mem_write(args[2], [0]); } catch(e) {}
                }
                var str = self._strings.get(args[1]) || '';
                self._logJNI('GetStringUTFChars', '"' + str.substring(0, 60) + '" → 0x' + (ptr>>>0).toString(16));
                return ptr;
            }},
            170: { name: 'ReleaseStringUTFChars', handler: function(emu, args) { return 0; } },

            // ---- Arrays ----
            171: { name: 'GetArrayLength', handler: function(emu, args) { return 0; } },
            172: { name: 'NewObjectArray', handler: function(emu, args) { return self.JOBJECT_BASE + 0x4000; } },
            173: { name: 'GetObjectArrayElement', handler: function(emu, args) { return 0; } },
            174: { name: 'SetObjectArrayElement', handler: function(emu, args) { return 0; } },
            175: { name: 'NewBooleanArray', handler: function(emu, args) { return self.JOBJECT_BASE + 0x5000; } },
            176: { name: 'NewByteArray', handler: function(emu, args) { return self.JOBJECT_BASE + 0x5100; } },
            177: { name: 'NewCharArray', handler: function(emu, args) { return self.JOBJECT_BASE + 0x5200; } },
            178: { name: 'NewShortArray', handler: function(emu, args) { return self.JOBJECT_BASE + 0x5300; } },
            179: { name: 'NewIntArray', handler: function(emu, args) { return self.JOBJECT_BASE + 0x5400; } },
            180: { name: 'NewLongArray', handler: function(emu, args) { return self.JOBJECT_BASE + 0x5500; } },
            181: { name: 'NewFloatArray', handler: function(emu, args) { return self.JOBJECT_BASE + 0x5600; } },
            182: { name: 'NewDoubleArray', handler: function(emu, args) { return self.JOBJECT_BASE + 0x5700; } },

            183: { name: 'GetBooleanArrayElements', handler: function(emu, args) { return 0; } },
            184: { name: 'GetByteArrayElements', handler: function(emu, args) { return 0; } },
            185: { name: 'GetCharArrayElements', handler: function(emu, args) { return 0; } },
            186: { name: 'GetShortArrayElements', handler: function(emu, args) { return 0; } },
            187: { name: 'GetIntArrayElements', handler: function(emu, args) { return 0; } },
            188: { name: 'GetLongArrayElements', handler: function(emu, args) { return 0; } },
            189: { name: 'GetFloatArrayElements', handler: function(emu, args) { return 0; } },
            190: { name: 'GetDoubleArrayElements', handler: function(emu, args) { return 0; } },
            191: { name: 'ReleaseBooleanArrayElements', handler: function(emu, args) { return 0; } },
            192: { name: 'ReleaseByteArrayElements', handler: function(emu, args) { return 0; } },
            193: { name: 'ReleaseCharArrayElements', handler: function(emu, args) { return 0; } },
            194: { name: 'ReleaseShortArrayElements', handler: function(emu, args) { return 0; } },
            195: { name: 'ReleaseIntArrayElements', handler: function(emu, args) { return 0; } },
            196: { name: 'ReleaseLongArrayElements', handler: function(emu, args) { return 0; } },
            197: { name: 'ReleaseFloatArrayElements', handler: function(emu, args) { return 0; } },
            198: { name: 'ReleaseDoubleArrayElements', handler: function(emu, args) { return 0; } },
            199: { name: 'GetBooleanArrayRegion', handler: function(emu, args) { return 0; } },
            200: { name: 'GetByteArrayRegion', handler: function(emu, args) { return 0; } },
            201: { name: 'GetCharArrayRegion', handler: function(emu, args) { return 0; } },
            202: { name: 'GetShortArrayRegion', handler: function(emu, args) { return 0; } },
            203: { name: 'GetIntArrayRegion', handler: function(emu, args) { return 0; } },
            204: { name: 'GetLongArrayRegion', handler: function(emu, args) { return 0; } },
            205: { name: 'GetFloatArrayRegion', handler: function(emu, args) { return 0; } },
            206: { name: 'GetDoubleArrayRegion', handler: function(emu, args) { return 0; } },
            207: { name: 'SetBooleanArrayRegion', handler: function(emu, args) { return 0; } },
            208: { name: 'SetByteArrayRegion', handler: function(emu, args) { return 0; } },
            209: { name: 'SetCharArrayRegion', handler: function(emu, args) { return 0; } },
            210: { name: 'SetShortArrayRegion', handler: function(emu, args) { return 0; } },
            211: { name: 'SetIntArrayRegion', handler: function(emu, args) { return 0; } },
            212: { name: 'SetLongArrayRegion', handler: function(emu, args) { return 0; } },
            213: { name: 'SetFloatArrayRegion', handler: function(emu, args) { return 0; } },
            214: { name: 'SetDoubleArrayRegion', handler: function(emu, args) { return 0; } },

            // ---- RegisterNatives ----
            215: { name: 'RegisterNatives', handler: function(emu, args) {
                self._handleRegisterNatives(emu, args[1], args[2], args[3]);
                return 0;
            }},
            216: { name: 'UnregisterNatives', handler: function(emu, args) { return 0; } },

            217: { name: 'MonitorEnter', handler: function(emu, args) { return 0; } },
            218: { name: 'MonitorExit', handler: function(emu, args) { return 0; } },

            219: { name: 'GetJavaVM', handler: function(emu, args) {
                if (args[1]) { self._writeU32Emu(emu, args[1], self.JAVA_VM_BASE); }
                return 0;
            }},

            220: { name: 'GetStringRegion', handler: function(emu, args) {
                // GetStringRegion(env, jstring, start, len, buf) — UTF-16
                var stringId = args[1];
                var start = args[2];
                var len = args[3];
                var sp = 0;
                try {
                    var spReg = emu.reg_read(uc.ARM_REG_SP);
                    sp = emu.mem_read(spReg, 4);
                    sp = sp[0] | (sp[1] << 8) | (sp[2] << 16) | (sp[3] << 24);
                } catch(e) { sp = 0; }
                var buf = sp;
                if (!buf) return 0;
                var str = self._strings.get(stringId) || '';
                var sub = str.substring(start, start + len);
                var bytes = [];
                for (var i = 0; i < sub.length; i++) {
                    var c = sub.charCodeAt(i);
                    bytes.push(c & 0xFF, (c >> 8) & 0xFF); // UTF-16LE
                }
                try { emu.mem_write(buf, bytes); } catch(e) {}
                return 0;
            }},
            221: { name: 'GetStringUTFRegion', handler: function(emu, args) {
                // GetStringUTFRegion(env, jstring, start, len, buf)
                var stringId = args[1];
                var start = args[2];
                var len = args[3];
                // buf is passed on the stack (5th arg) — read from SP+0
                var sp = 0;
                try {
                    var spReg = emu.reg_read(uc.ARM_REG_SP);
                    sp = emu.mem_read(spReg, 4);
                    sp = sp[0] | (sp[1] << 8) | (sp[2] << 16) | (sp[3] << 24);
                } catch(e) { sp = 0; }
                var buf = sp;
                if (!buf) {
                    // Fallback: try using _getOrWriteStringPtr so at least the string is in memory
                    self._getOrWriteStringPtr(emu, stringId);
                    return 0;
                }
                var str = self._strings.get(stringId) || '';
                var sub = str.substring(start, start + len);
                var bytes = [];
                for (var i = 0; i < sub.length; i++) {
                    bytes.push(sub.charCodeAt(i) & 0xFF);
                }
                bytes.push(0); // null terminator
                try { emu.mem_write(buf, bytes); } catch(e) {
                    Logger.warn('GetStringUTFRegion: failed to write to buf 0x' + (buf>>>0).toString(16));
                }
                self._logJNI('GetStringUTFRegion', '"' + sub.substring(0, 60) + '" → buf 0x' + (buf>>>0).toString(16));
                return 0;
            }},
            222: { name: 'GetPrimitiveArrayCritical', handler: function(emu, args) { return 0; } },
            223: { name: 'ReleasePrimitiveArrayCritical', handler: function(emu, args) { return 0; } },
            224: { name: 'GetStringCritical', handler: function(emu, args) {
                return self._getOrWriteStringPtr(emu, args[1]);
            }},
            225: { name: 'ReleaseStringCritical', handler: function(emu, args) { return 0; } },
            226: { name: 'NewWeakGlobalRef', handler: function(emu, args) { return args[1]; } },
            227: { name: 'DeleteWeakGlobalRef', handler: function(emu, args) { return 0; } },
            229: { name: 'NewDirectByteBuffer', handler: function(emu, args) { return self.JOBJECT_BASE + 0x7000; } },
            230: { name: 'GetDirectBufferAddress', handler: function(emu, args) { return 0; } },
            231: { name: 'GetDirectBufferCapacity', handler: function(emu, args) { return 0; } },
            232: { name: 'GetObjectRefType', handler: function(emu, args) { return 1; } },
        };
    }

    // ================================================================
    // JavaVM FUNCTION TABLE HANDLERS
    // ================================================================

    getJavaVMHandlers() {
        var self = this;
        return {
            3: { name: 'DestroyJavaVM', handler: function(emu, args) { return 0; } },
            4: { name: 'AttachCurrentThread', handler: function(emu, args) {
                if (args[1]) { self._writeU32Emu(emu, args[1], self.JNIENV_BASE); }
                return 0;
            }},
            5: { name: 'DetachCurrentThread', handler: function(emu, args) { return 0; } },
            6: { name: 'GetEnv', handler: function(emu, args) {
                if (args[1]) { self._writeU32Emu(emu, args[1], self.JNIENV_BASE); }
                self._logJNI('VM.GetEnv', 'version=0x' + (args[2]>>>0).toString(16));
                return 0;
            }},
            7: { name: 'AttachCurrentThreadAsDaemon', handler: function(emu, args) {
                if (args[1]) { self._writeU32Emu(emu, args[1], self.JNIENV_BASE); }
                return 0;
            }},
        };
    }

    // ================================================================
    // v3.0: SMART FIELD GETTERS
    // ================================================================

    _handleGetIntField(emu, obj, fieldId) {
        var field = this._fieldRegistry.get(fieldId);
        var name = field ? field.name : '?';
        var value = 0;

        // Known BGAndroidInfo int fields
        switch (name) {
            case 'screenWidth':
            case 'mScreenWidth':
            case 'width':
                value = this._screenWidth;
                break;
            case 'screenHeight':
            case 'mScreenHeight':
            case 'height':
                value = this._screenHeight;
                break;
            case 'screenDPI':
            case 'densityDPI':
            case 'dpi':
                value = 320; // xhdpi
                break;
            case 'sdkVersion':
            case 'apiLevel':
            case 'androidApiLevel':
                value = 30; // Android 11
                break;
            case 'versionCode':
                value = 44450;
                break;
            case 'orientation':
                value = 1; // landscape
                break;
            case 'maxTextureSize':
                value = 4096;
                break;
            default:
                value = 0;
                break;
        }

        this._logJNI_call('GetIntField', name + ' → ' + value);
        return value;
    }

    _handleGetFloatField(emu, obj, fieldId) {
        var field = this._fieldRegistry.get(fieldId);
        var name = field ? field.name : '?';
        var value = 0;

        switch (name) {
            case 'screenDensity':
            case 'density':
            case 'mDensity':
                value = this._screenDensity;
                break;
            case 'xdpi':
            case 'ydpi':
                value = 320.0;
                break;
            default:
                value = 0;
                break;
        }

        // Convert float to IEEE 754 int representation for ARM register
        var buf = new ArrayBuffer(4);
        new Float32Array(buf)[0] = value;
        var intVal = new Uint32Array(buf)[0];
        
        this._logJNI_call('GetFloatField', name + ' → ' + value);
        return intVal;
    }

    _handleGetBooleanField(emu, obj, fieldId) {
        var field = this._fieldRegistry.get(fieldId);
        var name = field ? field.name : '?';
        
        var value = 0;
        switch (name) {
            case 'isTablet':
                value = 1;
                break;
            case 'hasGLES20':
            case 'supportsGLES20':
                value = 1;
                break;
        }

        this._logJNI_call('GetBooleanField', name + ' → ' + value);
        return value;
    }

    _handleGetObjectField(emu, obj, fieldId) {
        var field = this._fieldRegistry.get(fieldId);
        var name = field ? field.name : '?';
        var sig = field ? field.sig : '';
        var value = 0;

        // String fields → return pre-allocated jstring handles
        if (sig === 'Ljava/lang/String;') {
            switch (name) {
                case 'filesDir':
                case 'mFilesDir':
                case 'internalPath':
                    value = this._filesDir;
                    break;
                case 'obbDir':
                case 'obbPath':
                case 'mObbPath':
                case 'expansionPath':
                    value = this._obbPath;
                    break;
                case 'apkPath':
                case 'mApkPath':
                    value = this._apkPath;
                    break;
                case 'cacheDir':
                case 'mCacheDir':
                    value = this._cacheDir;
                    break;
                case 'externalFilesDir':
                case 'externalDir':
                case 'mExternalDir':
                    value = this._externalDir;
                    break;
                case 'packageName':
                    value = this._packageName;
                    break;
                case 'versionName':
                    value = this._versionName;
                    break;
                case 'locale':
                case 'language':
                    value = this._locale;
                    break;
                case 'deviceModel':
                case 'model':
                    value = this._deviceModel;
                    break;
                case 'osVersion':
                    value = this._osVersion;
                    break;
                default:
                    value = this._emptyStr;
                    break;
            }
        } else {
            // Non-string object fields → return a generic object
            value = this.JOBJECT_BASE + 0x2000;
        }

        this._logJNI_call('GetObjectField', name + ':' + sig + ' → 0x' + (value>>>0).toString(16));
        return value;
    }

    _handleGetStaticObjectField(emu, clazz, fieldId) {
        var field = this._fieldRegistry.get(fieldId);
        var name = field ? field.name : '?';
        this._logJNI_call('GetStaticObjectField', name);
        return this.JOBJECT_BASE + 0x3000;
    }

    _handleGetStaticIntField(emu, clazz, fieldId) {
        var field = this._fieldRegistry.get(fieldId);
        var name = field ? field.name : '?';
        this._logJNI_call('GetStaticIntField', name);
        return 0;
    }

    _handleCallIntMethod(emu, args) {
        var methodId = args[2];
        var method = this._methodRegistry.get(methodId);
        var name = method ? method.name : '?';
        this._logJNI_call('CallIntMethod', name);
        
        // Return sensible values for known methods
        switch (name) {
            case 'getWidth':
            case 'getScreenWidth':
                return this._screenWidth;
            case 'getHeight':
            case 'getScreenHeight':
                return this._screenHeight;
            case 'intValue':
                return 0;
            default:
                return 0;
        }
    }

    // ================================================================
    // HELPERS
    // ================================================================

    _writeU32(addr, val) {
        var buf = [val & 0xFF, (val >> 8) & 0xFF, (val >> 16) & 0xFF, (val >> 24) & 0xFF];
        try { this.emu.mem_write(addr, buf); } catch(e) {}
    }

    _writeU32Emu(emu, addr, val) {
        var buf = [val & 0xFF, (val >> 8) & 0xFF, (val >> 16) & 0xFF, (val >> 24) & 0xFF];
        try { emu.mem_write(addr, buf); } catch(e) {}
    }

    _readU32Emu(emu, addr) {
        try {
            var bytes = emu.mem_read(addr, 4);
            return bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24);
        } catch(e) { return 0; }
    }

    _readCString(emu, addr) {
        if (!addr || addr === 0) return '';
        try {
            var result = [];
            var CHUNK = 128;
            var offset = 0;
            while (offset < 1024) {
                var bytes = emu.mem_read(addr + offset, CHUNK);
                for (var i = 0; i < bytes.length; i++) {
                    if (bytes[i] === 0) {
                        return String.fromCharCode.apply(null, result);
                    }
                    result.push(bytes[i]);
                }
                offset += CHUNK;
            }
            return String.fromCharCode.apply(null, result);
        } catch(e) {
            return '';
        }
    }

    _getOrCreateClass(name) {
        if (this._classes.has(name)) return this._classes.get(name);
        var id = this._nextClassId;
        this._nextClassId += 0x10;
        this._classes.set(name, id);
        return id;
    }

    _getOrCreateMethod(clazz, name, sig) {
        var key = clazz + '.' + name + '.' + sig;
        if (this._methods.has(key)) return this._methods.get(key);
        var id = this._nextMethodId;
        this._nextMethodId += 0x10;
        this._methods.set(key, id);
        // v3.0: Track method name by ID for smart dispatch
        this._methodRegistry.set(id, { clazz: clazz, name: name, sig: sig });
        return id;
    }

    _getOrCreateField(clazz, name, sig) {
        var key = clazz + '.' + name + '.' + sig;
        if (this._fields.has(key)) return this._fields.get(key);
        var id = this._nextFieldId;
        this._nextFieldId += 0x10;
        this._fields.set(key, id);
        // v3.0: Track field name by ID for smart getters
        this._fieldRegistry.set(id, { clazz: clazz, name: name, sig: sig });
        return id;
    }

    _allocString(str) {
        var id = this._nextStringId;
        this._nextStringId += 0x10;
        this._strings.set(id, str);
        return id;
    }

    _getOrWriteStringPtr(emu, stringId) {
        if (this._stringPtrs.has(stringId)) return this._stringPtrs.get(stringId);
        var str = this._strings.get(stringId);
        if (str === undefined) str = '';
        var addr = this._nextStringAddr;
        var bytes = [];
        for (var i = 0; i < str.length; i++) {
            bytes.push(str.charCodeAt(i) & 0xFF);
        }
        bytes.push(0);
        try { emu.mem_write(addr, bytes); } catch(e) {
            Logger.warn('Failed to write string at 0x' + addr.toString(16));
        }
        this._nextStringAddr += bytes.length + 8;
        this._stringPtrs.set(stringId, addr);
        return addr;
    }

    _handleRegisterNatives(emu, clazz, methodsPtr, nMethods) {
        var className = '?';
        for (var entry of this._classes) {
            if (entry[1] === clazz) { className = entry[0]; break; }
        }
        Logger.jni('RegisterNatives: ' + className + ' (' + nMethods + ' methods)');

        for (var i = 0; i < nMethods && i < 100; i++) {
            var base = methodsPtr + i * 12;
            try {
                var namePtr = this._readU32Emu(emu, base);
                var sigPtr  = this._readU32Emu(emu, base + 4);
                var fnPtr   = this._readU32Emu(emu, base + 8);
                var name = this._readCString(emu, namePtr);
                var sig  = this._readCString(emu, sigPtr);
                Logger.jni('  [' + i + '] ' + name + sig + ' -> 0x' + (fnPtr >>> 0).toString(16));
                this._registeredNatives.push({
                    clazz: clazz, className: className,
                    name: name, sig: sig, fnPtr: fnPtr
                });
            } catch(e) {
                Logger.warn('  [' + i + '] Failed to read native method');
            }
        }
    }

    _handleBooleanMethod(emu, args) {
        var methodId = args[2];
        var method = this._methodRegistry.get(methodId);
        var name = method ? method.name : '?';
        var nameLower = name.toLowerCase();

        // First run — return false (not first run, game is already "installed")
        if (nameLower.indexOf('isfirstrun') >= 0 || nameLower === 'firstrun') {
            this._logJNI('CallBooleanMethod', name + ' → 0 (not first run)');
            return 0;
        }
        // Language changed — return false (no change)
        if (nameLower.indexOf('haslanguagechanged') >= 0 || nameLower.indexOf('sethaslanguagechanged') >= 0) {
            this._logJNI('CallBooleanMethod', name + ' → 0 (no language change)');
            return 0;
        }
        // Network connectivity — always return true (connected)
        if (nameLower.indexOf('isconnected') >= 0 || nameLower.indexOf('isnetwork') >= 0 ||
            nameLower.indexOf('isonline') >= 0 || nameLower.indexOf('isavailable') >= 0 ||
            nameLower.indexOf('haswifi') >= 0 || nameLower.indexOf('iswifi') >= 0 ||
            nameLower.indexOf('hasnetwork') >= 0 || nameLower.indexOf('isreachable') >= 0 ||
            nameLower.indexOf('networkavailable') >= 0 || nameLower.indexOf('hasconnect') >= 0) {
            this._logJNI('CallBooleanMethod', name + ' → 1 (network=connected)');
            return 1;
        }
        // Airplane mode — return false (not in airplane mode)
        if (nameLower.indexOf('airplane') >= 0 || nameLower.indexOf('flightmode') >= 0) {
            this._logJNI('CallBooleanMethod', name + ' → 0 (not airplane)');
            return 0;
        }
        // Download complete / ready checks — return true
        if (nameLower.indexOf('iscomplete') >= 0 || nameLower.indexOf('isready') >= 0 ||
            nameLower.indexOf('isfinished') >= 0 || nameLower.indexOf('isloaded') >= 0 ||
            nameLower.indexOf('isdone') >= 0) {
            this._logJNI('CallBooleanMethod', name + ' → 1 (ready)');
            return 1;
        }
        // mkdir — return true (directory created)
        if (nameLower === 'mkdir' || nameLower === 'mkdirs') {
            this._logJNI('CallBooleanMethod', name + ' → 1 (mkdir ok)');
            return 1;
        }
        // Default: return 1 (true) — most boolean checks are "is X available/enabled"
        this._logJNI('CallBooleanMethod', name + ' → 1 (default true)');
        return 1;
    }

    _handleCallMethod(type, emu, args) {
        var methodId = args[2];
        var method = this._methodRegistry.get(methodId);
        var name = method ? method.name : '?';
        var sig = method ? method.sig : '';
        
        this._logJNI_call('Call' + type + 'Method', name + sig);
        
        // For methods returning String, return appropriate values based on method name
        if (sig.endsWith(')Ljava/lang/String;')) {
            var nameLower = name.toLowerCase();
            
            // File/directory paths
            if (nameLower.indexOf('filesdir') >= 0 || nameLower.indexOf('getfilesdir') >= 0 ||
                nameLower === 'internalpath' || nameLower === 'getdatadir') {
                this._logJNI('CallMethod→String', name + ' → filesDir');
                return this._filesDir;
            }
            if (nameLower.indexOf('cachedir') >= 0 || nameLower.indexOf('getcachedir') >= 0) {
                this._logJNI('CallMethod→String', name + ' → cacheDir');
                return this._cacheDir;
            }
            if (nameLower.indexOf('externalfilesdir') >= 0 || nameLower.indexOf('getexternalfilesdir') >= 0 ||
                nameLower.indexOf('externaldir') >= 0) {
                this._logJNI('CallMethod→String', name + ' → externalDir');
                return this._externalDir;
            }
            if (nameLower.indexOf('obbdir') >= 0 || nameLower.indexOf('expansionpath') >= 0 ||
                nameLower.indexOf('getobbdir') >= 0) {
                this._logJNI('CallMethod→String', name + ' → obbPath');
                return this._obbPath;
            }
            if (nameLower.indexOf('packageresourcepath') >= 0 || nameLower.indexOf('apkpath') >= 0 ||
                nameLower.indexOf('getpackageresourcepath') >= 0) {
                this._logJNI('CallMethod→String', name + ' → apkPath');
                return this._apkPath;
            }
            if (nameLower.indexOf('absolutepath') >= 0 || nameLower.indexOf('getabsolutepath') >= 0 ||
                nameLower.indexOf('getpath') >= 0 || nameLower.indexOf('tostring') >= 0) {
                // getAbsolutePath/getPath/toString on a File object — return filesDir
                this._logJNI('CallMethod→String', name + ' → filesDir (path resolve)');
                return this._filesDir;
            }
            if (nameLower.indexOf('packagename') >= 0 || nameLower.indexOf('getpackagename') >= 0) {
                this._logJNI('CallMethod→String', name + ' → packageName');
                return this._packageName;
            }
            if (nameLower.indexOf('versionname') >= 0 || nameLower.indexOf('getversionname') >= 0) {
                this._logJNI('CallMethod→String', name + ' → versionName');
                return this._versionName;
            }
            if (nameLower.indexOf('locale') >= 0 || nameLower.indexOf('getlanguage') >= 0 ||
                nameLower.indexOf('getcountry') >= 0 || nameLower.indexOf('getlocale') >= 0) {
                this._logJNI('CallMethod→String', name + ' → locale');
                return this._locale;
            }
            if (nameLower.indexOf('model') >= 0 || nameLower.indexOf('getmodel') >= 0 ||
                nameLower.indexOf('device') >= 0) {
                this._logJNI('CallMethod→String', name + ' → deviceModel');
                return this._deviceModel;
            }
            
            // v15.5: SharedPreferences support
            // Match both getSharedPreferences() and getString() on a SharedPrefs object
            if (nameLower === 'getsharedpreference' || nameLower === 'getsharedpreferences' ||
                nameLower.indexOf('sharedpreference') >= 0 ||
                nameLower === 'getstring') {
                // For CallStaticObjectMethod: args = [env, clazz, mid, arg0]
                // arg0 (R3) = the jstring key handle
                var keyHandle = args[3];
                var key = this._strings.get(keyHandle) || '';
                // R3 is often a va_list pointer (stack address) when called via
                // CallStaticObjectMethodV — read the actual jstring handle from it
                if (!key && keyHandle) {
                    try {
                        var vaBytes = emu.mem_read(keyHandle, 4);
                        var realHandle = (vaBytes[0] | (vaBytes[1] << 8) | (vaBytes[2] << 16) | (vaBytes[3] << 24)) >>> 0;
                        key = this._strings.get(realHandle) || '';
                        if (!key) {
                            // Maybe the string is written directly in ARM memory at that address
                            key = this._readCString(emu, realHandle);
                        }
                    } catch(e) {}
                }
                var value = this._sharedPreferences[key];
                if (value === undefined) value = '';
                this._logJNI('CallMethod→String', 'getSharedPreference("' + key + '") → "' + value + '"');
                return this._allocString(value);
            }

            // v34: Handle CreateNewStringUTFSafe(byte[]) → String
            // The native code passes a byte array and expects a Java String back.
            // Read the byte array data from the argument and convert to string.
            if (name === 'CreateNewStringUTFSafe') {
                var byteArrayRef = 0;
                // For CallStaticObjectMethod: args = [env, clazz, mid, byteArray]
                // For CallStaticObjectMethodV: args[3] may be va_list pointer
                try {
                    byteArrayRef = args[3];
                    // If it looks like a va_list (stack pointer), dereference it
                    if (byteArrayRef >= 0xF0000000) {
                        var vaBytes = emu.mem_read(byteArrayRef, 4);
                        byteArrayRef = (vaBytes[0] | (vaBytes[1] << 8) | (vaBytes[2] << 16) | (vaBytes[3] << 24)) >>> 0;
                    }
                } catch(e) {}
                var str = '';
                if (byteArrayRef && byteArrayRef > 0x1000) {
                    try {
                        // Try reading as a C-string from the byte array data
                        str = this._readCString(emu, byteArrayRef);
                    } catch(e) {}
                }
                if (!str) str = '';
                this._logJNI('CallMethod→String', 'CreateNewStringUTFSafe → "' + str.substring(0, 60) + '"');
                return this._allocString(str);
            }

            // Default: return empty string (but log it for debugging)
            this._logJNI('CallMethod→String', name + ' → EMPTY (unhandled)');
            return this._emptyStr;
        }
        
        // For Void methods, just return 0 (success)
        if (sig.endsWith(')V')) {
            return 0;
        }
        
        // For boolean methods, return false (0)
        if (sig.endsWith(')Z')) {
            return 0;
        }
        
        // For int methods, return 0
        if (sig.endsWith(')I')) {
            return 0;
        }
        
        // For Object methods, return a valid object reference
        return this.JOBJECT_BASE + 0x2000;
    }

    _logJNI(funcName, detail) {
        var count = this._jniCallCounts.get(funcName) || 0;
        this._jniCallCounts.set(funcName, count + 1);
        if (count < this._maxLogPerFunc) {
            Logger.jni('[JNI] ' + funcName + ': ' + detail);
        } else if (count === this._maxLogPerFunc) {
            Logger.jni('[JNI] ' + funcName + ': (further calls suppressed)');
        }
    }

    _logJNI_call(funcName, detail) {
        var count = this._jniCallCounts.get(funcName) || 0;
        this._jniCallCounts.set(funcName, count + 1);
        if (count < this._maxLogPerFunc) {
            Logger.jni('[JNI] ' + funcName + ': ' + detail);
        }
    }

    // ================================================================
    // PUBLIC API
    // ================================================================

    prepareCall(funcName, extraArgs) {
        extraArgs = extraArgs || [];
        return {
            r0: this.JNIENV_BASE,
            r1: this.JOBJECT_BASE,
            r2: extraArgs[0] || 0,
            r3: extraArgs[1] || 0,
        };
    }

    prepareOnLoad() {
        return {
            r0: this.JAVA_VM_BASE,
            r1: 0,
        };
    }

    /**
     * v3.0 FIX: Pass a proper BGAndroidInfo jobject in R2
     * (was incorrectly passing width/height as ints)
     */
    prepareBGCoreInit(width, height) {
        this._screenWidth = width;
        this._screenHeight = height;
        Logger.jni('prepareBGCoreInit: screen ' + width + 'x' + height + ', info object at 0x' + this.BGANDROIDINFO_OBJ.toString(16));
        return {
            r0: this.JNIENV_BASE,
            r1: this.JOBJECT_BASE,
            r2: this.BGANDROIDINFO_OBJ,  // v3.0: proper jobject, not width!
        };
    }

    logCallback(funcIndex, args) {
        this.callLog.push({ funcIndex: funcIndex, args: args, time: Date.now() });
    }

    getStats() {
        return {
            classes: this._classes.size,
            methods: this._methods.size,
            fields: this._fields.size,
            strings: this._strings.size,
            globalRefs: this._globalRefs.size,
            registeredNatives: this._registeredNatives.length,
            jniCalls: Array.from(this._jniCallCounts.values()).reduce(function(a,b) { return a+b; }, 0),
        };
    }
}


