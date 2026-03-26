/**
 * TSTO Web Emulator — In-Browser Game Server v1.0
 * Implements the TappedOutReborn server endpoints locally in JavaScript.
 * Handles auth, direction, config, land, currency, and telemetry.
 * Uses manual protobuf encoding (no external library needed).
 */
var GameServer = (function() {
    'use strict';

    // ===========================
    // Protobuf Encoding Helpers
    // ===========================

    function encodeVarint(value) {
        var bytes = [];
        value = value >>> 0;
        do {
            var b = value & 0x7F;
            value >>>= 7;
            if (value > 0) b |= 0x80;
            bytes.push(b);
        } while (value > 0);
        return bytes;
    }

    function encodeVarint64(value) {
        var bytes = [];
        if (value < 0) value = 0;
        do {
            var b = value & 0x7F;
            value = Math.floor(value / 128);
            if (value > 0) b |= 0x80;
            bytes.push(b);
        } while (value > 0);
        return bytes;
    }

    function encodeTag(fieldNum, wireType) {
        return encodeVarint((fieldNum << 3) | wireType);
    }

    function encodeString(fieldNum, str) {
        var strBytes = [];
        for (var i = 0; i < str.length; i++) {
            var c = str.charCodeAt(i);
            if (c < 0x80) {
                strBytes.push(c);
            } else if (c < 0x800) {
                strBytes.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
            } else {
                strBytes.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
            }
        }
        return encodeTag(fieldNum, 2).concat(encodeVarint(strBytes.length)).concat(strBytes);
    }

    function encodeInt32(fieldNum, value) {
        return encodeTag(fieldNum, 0).concat(encodeVarint(value));
    }

    function encodeInt64(fieldNum, value) {
        return encodeTag(fieldNum, 0).concat(encodeVarint64(value));
    }

    function encodeBool(fieldNum, value) {
        return encodeTag(fieldNum, 0).concat([value ? 1 : 0]);
    }

    function encodeBytes(fieldNum, bytes) {
        return encodeTag(fieldNum, 2).concat(encodeVarint(bytes.length)).concat(Array.from(bytes));
    }

    function encodeMessage(fieldNum, msgBytes) {
        return encodeTag(fieldNum, 2).concat(encodeVarint(msgBytes.length)).concat(msgBytes);
    }

    // ===========================
    // User State (in-memory)
    // ===========================

    var _state = {
        userId: 1000000000001,
        mayhemId: '3042000000000001',
        accessToken: 'AT_emu_' + Math.random().toString(36).substr(2, 16),
        accessCode: 'AC_emu_' + Math.random().toString(36).substr(2, 16),
        wholeLandToken: '',
        landData: null,
        currencyData: null,
        userName: 'emulator_user',
        donuts: 5000
    };

    // ===========================
    // URL Parser
    // ===========================

    function parseUrl(url) {
        var qIdx = url.indexOf('?');
        var path = qIdx >= 0 ? url.substring(0, qIdx) : url;
        var query = {};
        if (qIdx >= 0) {
            var qs = url.substring(qIdx + 1);
            var pairs = qs.split('&');
            for (var i = 0; i < pairs.length; i++) {
                var eqIdx = pairs[i].indexOf('=');
                if (eqIdx >= 0) {
                    query[decodeURIComponent(pairs[i].substring(0, eqIdx))] =
                        decodeURIComponent(pairs[i].substring(eqIdx + 1));
                }
            }
        }
        // Normalize path: remove double slashes, trailing slashes (but keep root /)
        path = path.replace(/\/+/g, '/');
        if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
        return { path: path, query: query };
    }

    // ===========================
    // JWT Builder (fake but structurally valid)
    // ===========================

    function base64url(str) {
        return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function buildJwt(userId) {
        var header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
        var now = Math.floor(Date.now() / 1000);
        var payload = base64url(JSON.stringify({
            aud: 'simpsons4-android-client',
            iss: 'accounts.ea.com',
            iat: now,
            exp: now + 368435455,
            pid_id: String(userId),
            user_id: String(userId),
            persona_id: userId,
            pid_type: 'AUTHENTICATOR_ANONYMOUS',
            auth_time: 0
        }));
        var sig = base64url('fakesignature_for_emulator');
        return header + '.' + payload + '.' + sig;
    }

    // ===========================
    // Direction Config
    // ===========================

    var VIRTUAL_SERVER = 'http://10.0.0.1:4242';

    function buildDirectionResponse() {
        return {
            DMGId: 0,
            appUpgrade: 0,
            clientId: 'simpsons4-android-client',
            clientSecret: 'D0fpQvaBKmAgBRCwGPvROmBf96zHnAuZmNepQht44SgyhbCdCfFgtUTdCezpWpbRI8N6oPtb38aOVg2y',
            disabledFeatures: [],
            facebookAPIKey: '43b9130333cc984c79d06aa0cad3a0c8',
            facebookAppId: '185424538221919',
            hwId: 2363,
            mayhemGameCode: 'bg_gameserver_plugin',
            mdmAppKey: 'simpsons-4-android',
            packageId: 'com.ea.game.simpsons4_row',
            pollIntervals: [{ key: 'badgePollInterval', value: '300' }],
            productId: 48302,
            resultCode: 0,
            sellId: 857120,
            serverApiVersion: '1.0.0',
            serverData: [
                { key: 'nexus.portal', value: VIRTUAL_SERVER + '/' },
                { key: 'nexus.connect', value: VIRTUAL_SERVER + '/' },
                { key: 'nexus.proxy', value: VIRTUAL_SERVER + '/' },
                { key: 'synergy.tracking', value: VIRTUAL_SERVER },
                { key: 'synergy.user', value: VIRTUAL_SERVER },
                { key: 'synergy.director', value: VIRTUAL_SERVER },
                { key: 'synergy.m2u', value: VIRTUAL_SERVER },
                { key: 'synergy.pns', value: VIRTUAL_SERVER },
                { key: 'synergy.s2s', value: VIRTUAL_SERVER },
                { key: 'synergy.product', value: VIRTUAL_SERVER },
                { key: 'synergy.drm', value: VIRTUAL_SERVER },
                { key: 'synergy.cipgl', value: VIRTUAL_SERVER },
                { key: 'mayhem.url', value: VIRTUAL_SERVER },
                { key: 'friends.url', value: VIRTUAL_SERVER },
                { key: 'geoip.url', value: VIRTUAL_SERVER },
                { key: 'akamai.url', value: VIRTUAL_SERVER + '/dlc/' },
                { key: 'dmg.url', value: VIRTUAL_SERVER },
                { key: 'avatars.url', value: VIRTUAL_SERVER },
                { key: 'river.pin', value: VIRTUAL_SERVER },
                { key: 'antelope.rtm.host', value: VIRTUAL_SERVER },
                { key: 'antelope.rtm.url', value: VIRTUAL_SERVER },
                { key: 'antelope.friends.url', value: VIRTUAL_SERVER },
                { key: 'antelope.groups.url', value: VIRTUAL_SERVER },
                { key: 'antelope.inbox.url', value: VIRTUAL_SERVER },
                { key: 'eadp.friends.host', value: VIRTUAL_SERVER },
                { key: 'service.discovery.url', value: VIRTUAL_SERVER },
                { key: 'aruba.url', value: VIRTUAL_SERVER },
                { key: 'pin.aruba.url', value: VIRTUAL_SERVER },
                { key: 'ens.url', value: VIRTUAL_SERVER },
                { key: 'origincasualserver.url', value: VIRTUAL_SERVER },
                { key: 'origincasualapp.url', value: VIRTUAL_SERVER },
                { key: 'group.recommendations.url', value: VIRTUAL_SERVER },
                { key: 'friend.recommendations.url', value: VIRTUAL_SERVER }
            ],
            telemetryFreq: 300
        };
    }

    // ===========================
    // Client Config (protobuf)
    // ===========================

    var CLIENT_CONFIG_ITEMS = [
        { id: 0, name: 'AppUrl.ios.na', value: 'https://apps.apple.com/app/id497595276' },
        { id: 1, name: 'GameClient.MaxBundleSize', value: '50' },
        { id: 5, name: 'LocalSaveInterval', value: '10' },
        { id: 6, name: 'ServerSaveInterval', value: '100' },
        { id: 10, name: 'CheckDLCInterval', value: '3600' },
        { id: 20, name: 'MinimumVersion.android', value: '4.69.0' },
        { id: 21, name: 'CurrentVersion.android', value: '4.69.0' },
        { id: 26, name: 'CoppaEnabledNa', value: '1' },
        { id: 27, name: 'CoppaEnabledRow', value: '1' },
        { id: 28, name: 'MaxBuildingSoftCapEnabled', value: '1' },
        { id: 29, name: 'MaxBuildingSoftCapLimit', value: '19500' },
        { id: 31, name: 'MaxBuildingHardCapEnabled', value: '1' },
        { id: 32, name: 'MaxBuildingHardCapLimit', value: '24000' },
        { id: 41, name: 'ClientConfigInterval', value: '300' },
        { id: 43, name: 'TelemetryEnabled.android', value: '0' },
        { id: 55, name: 'TutorialDLCEnabled.android', value: '1' },
        { id: 67, name: 'EnableVBOCache', value: '1' },
        { id: 74, name: 'ExpiredTokenForcedLogoutEnabled', value: '0' },
        { id: 85, name: 'AkamaiClientEnabled.android', value: '0' },
        { id: 92, name: 'EnableOptAppSwitch.android', value: '1' },
        { id: 105, name: 'EnableRoadCacheOptimization', value: '1' },
        { id: 107, name: 'LandDataVersionUpgraderEnabled', value: '1' },
        { id: 108, name: 'ConfigVersion', value: '131' },
        { id: 109, name: 'Game:Enable:JobManagerEnabled', value: '1' },
        { id: 115, name: 'MinimumOSVersion.android', value: '3.0.0' },
        { id: 117, name: 'XZeroSortFix', value: '1' },
        { id: 118, name: 'DefaultJobCensus', value: '1' },
        { id: 126, name: 'EnableCheckIndex', value: '1' },
        { id: 129, name: 'CrashReportingAndroidOn', value: '0' },
        { id: 131, name: 'LogOalErrors', value: '0' },
        { id: 132, name: 'UseNumPadCodeLogin', value: '1' },
        { id: 133, name: 'DeleteUserEnabled', value: '1' },
        { id: 135, name: 'EnableBGDownloadAndroid', value: '0' },
        { id: 994, name: 'ServerVersion', value: 'local' },
        { id: 995, name: 'KillswitchAllowFriends', value: '0' },
        { id: 996, name: 'GeolocationCountryCode', value: 'US' },
        { id: 997, name: 'GeolocationCountryName', value: 'United States' },
        { id: 1010, name: 'MHVersion', value: '1' },
        { id: 1011, name: 'RequestsPerSecond', value: '44' }
    ];

    function buildClientConfigProto() {
        // ClientConfigResponse { repeated ClientConfigItem items = 2; }
        // ClientConfigItem { int32 clientConfigId = 1; string name = 2; string value = 3; }
        var result = [];
        for (var i = 0; i < CLIENT_CONFIG_ITEMS.length; i++) {
            var item = encodeInt32(1, CLIENT_CONFIG_ITEMS[i].id)
                .concat(encodeString(2, CLIENT_CONFIG_ITEMS[i].name))
                .concat(encodeString(3, CLIENT_CONFIG_ITEMS[i].value));
            result = result.concat(encodeMessage(2, item));
        }
        return new Uint8Array(result);
    }

    // ===========================
    // Gameplay Config (protobuf)
    // ===========================

    var GAMEPLAY_CONFIG_ITEMS = [
        { name: 'MysteryBoxUpgrade_GameConfig:Enable:GambleCall', value: '0' },
        { name: 'System:Disable:DynamicSteamer', value: '1' },
        { name: 'TouchPriority_GameConfig:Enable:TouchPriority', value: 'true' },
        { name: 'Validator_GameConfig:VariablesValidator:Validator', value: '1' },
        { name: 'NewUserBalancingConfig:XPTarget:Lvl60_TargetToNext', value: '500000' },
        { name: 'NewUserBalancingConfig:XPTarget:PrestigeIncreaseBonusExp', value: '1000000' },
        { name: 'FirstTimeMTX_GameConfig:FirstTimePacks:Enabled', value: 'true' },
        { name: 'SpringfieldGames_GameConfig:FirmwareMessage:Enabled', value: '1' }
    ];

    function buildGameplayConfigProto() {
        // GameplayConfigResponse { repeated NameValue item = 1; }
        // NameValue { string name = 1; string value = 2; }
        var result = [];
        for (var i = 0; i < GAMEPLAY_CONFIG_ITEMS.length; i++) {
            var nv = encodeString(1, GAMEPLAY_CONFIG_ITEMS[i].name)
                .concat(encodeString(2, GAMEPLAY_CONFIG_ITEMS[i].value));
            result = result.concat(encodeMessage(1, nv));
        }
        return new Uint8Array(result);
    }

    // ===========================
    // Protobuf Message Builders
    // ===========================

    function buildUsersResponse() {
        // UsersResponseMessage { UserIndirectData user = 1; TokenData token = 2; }
        var userMsg = encodeString(1, _state.mayhemId)
            .concat(encodeString(2, '42'));
        var tokenMsg = encodeString(1, '');
        return new Uint8Array(
            encodeMessage(1, userMsg).concat(encodeMessage(2, tokenMsg))
        );
    }

    function buildWholeLandTokenResponse(token) {
        // WholeLandTokenResponse { string token = 1; bool conflict = 2; }
        var result = encodeString(1, token).concat(encodeBool(2, false));
        return new Uint8Array(result);
    }

    function buildCurrencyData() {
        // CurrencyData { string id=1; int32 vcTotalPurchased=2; int32 vcTotalAwarded=3;
        //                int32 vcBalance=4; int64 createdAt=5; int64 updatedAt=6; }
        var result = encodeString(1, _state.mayhemId)
            .concat(encodeInt32(2, 0))
            .concat(encodeInt32(3, _state.donuts))
            .concat(encodeInt32(4, _state.donuts))
            .concat(encodeInt64(5, 1715911362))
            .concat(encodeInt64(6, Math.floor(Date.now() / 1000)));
        return new Uint8Array(result);
    }

    function buildExtraLandResponse() {
        // ExtraLandResponse { repeated CurrencyDelta processedCurrencyDelta=1; ... }
        // Empty response (no deltas to process)
        return new Uint8Array([]);
    }

    function buildDeleteTokenResponse(success) {
        // DeleteTokenResponse { bool result = 1; }
        return new Uint8Array(encodeBool(1, success));
    }

    // ===========================
    // HTTP Response Helpers
    // ===========================

    function jsonResponse(status, obj) {
        var body = JSON.stringify(obj);
        return {
            status: status,
            headers: { 'Content-Type': 'application/json' },
            body: body
        };
    }

    function xmlResponse(status, xml) {
        return {
            status: status,
            headers: { 'Content-Type': 'application/xml' },
            body: xml
        };
    }

    function protoResponse(status, bytes) {
        return {
            status: status,
            headers: { 'Content-Type': 'application/x-protobuf' },
            bodyBytes: bytes
        };
    }

    function textResponse(status, text) {
        return {
            status: status,
            headers: { 'Content-Type': 'text/plain' },
            body: text || ''
        };
    }

    // ===========================
    // Route Handlers
    // ===========================

    function handleRequest(method, url, headers, bodyBytes) {
        var parsed = parseUrl(url);
        var path = parsed.path;
        var query = parsed.query;

        Logger.info('[GameServer] ' + method + ' ' + path);

        // --- Probe ---
        if (path === '/probe' || path === '/probe/') {
            return textResponse(200, '');
        }

        // --- Auth: connect/auth ---
        if (path === '/connect/auth') {
            var responseType = (query.response_type || 'code').split(/[\s+]+/);
            var resp = {};
            if (responseType.indexOf('code') >= 0) resp.code = _state.accessCode;
            if (responseType.indexOf('lnglv_token') >= 0) resp.lnglv_token = _state.accessToken;
            return jsonResponse(200, resp);
        }

        // --- Auth: connect/token ---
        if (path === '/connect/token') {
            return jsonResponse(200, {
                access_token: _state.accessToken,
                expires_in: 368435455,
                id_token: buildJwt(_state.userId),
                refresh_token: 'NotImplemented',
                refresh_token_expires_in: 368435455,
                token_type: 'Bearer'
            });
        }

        // --- Auth: connect/tokeninfo ---
        if (path === '/connect/tokeninfo') {
            var resp = {
                client_id: 'long_live_token',
                expires_in: 368435455,
                persona_id: _state.userId,
                pid_id: String(_state.userId),
                pid_type: 'AUTHENTICATOR_ANONYMOUS',
                scope: 'offline basic.antelope.links.bulk openid signin antelope-rtm-readwrite search.identity basic.antelope basic.identity basic.persona antelope-inbox-readwrite',
                user_id: String(_state.userId),
                is_underage: false,
                stopProcess: 'OFF',
                telemetry_id: _state.userId
            };
            resp.authenticators = [{
                authenticator_pid_id: _state.userId,
                authenticator_type: 'AUTHENTICATOR_ANONYMOUS'
            }];
            return jsonResponse(200, resp);
        }

        // --- Director: getDirectionByPackage / getDirectionByBundle ---
        if (path.match(/\/director\/api\/\w+\/getDirection/)) {
            return jsonResponse(200, buildDirectionResponse());
        }

        // --- User: getDeviceID ---
        if (path.match(/\/user\/api\/\w+\/getDeviceID/)) {
            return jsonResponse(200, {
                deviceId: 'emu-' + Date.now().toString(16),
                resultCode: 0,
                serverApiVersion: '1.0.0'
            });
        }

        // --- User: validateDeviceID ---
        if (path.match(/\/user\/api\/\w+\/validateDeviceID/)) {
            return jsonResponse(200, {
                deviceId: query.eadeviceid || 'emu-device',
                resultCode: 0,
                serverApiVersion: '1.0.0'
            });
        }

        // --- User: getAnonUid ---
        if (path.match(/\/user\/api\/\w+\/getAnonUid/)) {
            return jsonResponse(200, {
                resultCode: 0,
                serverApiVersion: '1.0.0',
                uid: _state.userId
            });
        }

        // --- Proxy: identity/geoagerequirements ---
        if (path.match(/\/identity\/geoagerequirements/)) {
            return jsonResponse(200, {
                geoAgeRequirements: {
                    country: 'US',
                    minAgeWithConsent: '3',
                    minLegalContactAge: 13,
                    minLegalRegAge: 13
                }
            });
        }

        // --- Proxy: identity/pids/.../personas ---
        if (path.match(/\/identity\/pids\/.*\/personas/)) {
            return jsonResponse(200, {
                personas: {
                    persona: [{
                        dateCreated: '2024-12-12T15:42Z',
                        displayName: _state.userName,
                        isVisible: true,
                        lastAuthenticated: '',
                        name: _state.userName,
                        namespaceName: 'gsp-redcrow-simpsons4',
                        personaId: _state.userId,
                        pidId: _state.userId,
                        showPersona: 'EVERYONE',
                        status: 'ACTIVE',
                        statusReasonCode: ''
                    }]
                }
            });
        }

        // --- Proxy: identity/links ---
        if (path.match(/\/identity\/links/)) {
            return jsonResponse(200, {
                pidGamePersonaMappings: {
                    pidGamePersonaMapping: [{
                        newCreated: false,
                        personaId: _state.userId,
                        personaNamespace: 'gsp-redcrow-simpsons4',
                        pidGamePersonaMappingId: _state.userId,
                        pidId: _state.userId,
                        status: 'ACTIVE'
                    }]
                }
            });
        }

        // --- MH: users (PUT = register, GET = lookup) ---
        if (path === '/mh/users' || path === '/mh/users/') {
            if (method === 'PUT') {
                return protoResponse(200, buildUsersResponse());
            }
            // GET: return XML with user URI
            return xmlResponse(200,
                '<?xml version="1.0" encoding="UTF-8"?><Resources><URI>/users/' + _state.mayhemId + '</URI></Resources>'
            );
        }

        // --- MH: lobby/time ---
        if (path.match(/\/games\/lobby\/time/)) {
            return xmlResponse(200,
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Time><epochMilliseconds>' +
                Date.now() + '</epochMilliseconds></Time>'
            );
        }

        // --- MH: protoClientConfig ---
        if (path.match(/\/protoClientConfig/)) {
            return protoResponse(200, buildClientConfigProto());
        }

        // --- MH: gameplayconfig ---
        if (path === '/mh/gameplayconfig' || path === '/mh/gameplayconfig/') {
            return protoResponse(200, buildGameplayConfigProto());
        }

        // --- MH: protoWholeLandToken (POST = create, GET = check, POST deleteToken) ---
        if (path.match(/\/protoWholeLandToken/)) {
            if (path.match(/\/deleteToken\//)) {
                return protoResponse(200, buildDeleteTokenResponse(true));
            }
            if (path.match(/\/checkToken\//)) {
                return protoResponse(200, buildWholeLandTokenResponse(_state.wholeLandToken || ''));
            }
            // POST: create new token
            _state.wholeLandToken = 'emu-wlt-' + Math.random().toString(36).substr(2, 12);
            return protoResponse(200, buildWholeLandTokenResponse(_state.wholeLandToken));
        }

        // --- MH: protoland (GET = load, PUT = create, POST = update) ---
        if (path.match(/\/protoland\//)) {
            if (path.match(/\/extraLandUpdate\//)) {
                return protoResponse(200, buildExtraLandResponse());
            }
            if (method === 'GET') {
                if (_state.landData) {
                    return protoResponse(200, _state.landData);
                }
                // New player — no land yet
                return xmlResponse(404,
                    '<?xml version="1.0" encoding="UTF-8"?><error code="404" type="NO_SUCH_RESOURCE" field="LAND_NOT_FOUND"/>'
                );
            }
            if (method === 'PUT' || method === 'POST') {
                if (bodyBytes && bodyBytes.length > 0) {
                    _state.landData = new Uint8Array(bodyBytes);
                    Logger.info('[GameServer] Land saved: ' + _state.landData.length + ' bytes');
                }
                if (method === 'PUT') {
                    return protoResponse(200, bodyBytes || new Uint8Array(0));
                }
                return xmlResponse(200,
                    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><WholeLandUpdateResponse/>'
                );
            }
        }

        // --- MH: protocurrency ---
        if (path.match(/\/protocurrency\//)) {
            return protoResponse(200, buildCurrencyData());
        }

        // --- MH: friendData ---
        if (path.match(/\/friendData/)) {
            return textResponse(200, '');
        }

        // --- MH: event ---
        if (path.match(/\/event\/.*\/protoland/)) {
            return protoResponse(200, new Uint8Array(0));
        }

        // --- MH: trackinglog ---
        if (path.match(/\/trackinglog/)) {
            return xmlResponse(200,
                '<?xml version="1.0" encoding="UTF-8"?><Resources><URI>OK</URI></Resources>'
            );
        }

        // --- MH: trackingmetrics ---
        if (path.match(/\/trackingmetrics/)) {
            return xmlResponse(200,
                '<?xml version="1.0" encoding="UTF-8"?><Resources><URI>OK</URI></Resources>'
            );
        }

        // --- MH: link ---
        if (path.match(/\/link\/.*\/users/)) {
            return xmlResponse(200,
                '<?xml version="1.0" encoding="UTF-8"?><Resources><URI>OK</URI></Resources>'
            );
        }

        // --- MH: userstats ---
        if (path.match(/\/userstats/)) {
            return textResponse(200, '');
        }

        // --- MH: clienttelemetry ---
        if (path.match(/\/clienttelemetry/)) {
            return textResponse(200, '');
        }

        // --- Tracking: logEvent ---
        if (path.match(/\/tracking\/api\/core\/logEvent/)) {
            return jsonResponse(200, { status: 'ok' });
        }

        // --- Root ---
        if (path === '/' || path === '') {
            return textResponse(200, 'OK');
        }

        // --- Default: return 200 empty to avoid blocking the game ---
        Logger.warn('[GameServer] Unhandled route: ' + method + ' ' + path);
        return textResponse(200, '');
    }

    // ===========================
    // Public API
    // ===========================

    return {
        handleRequest: handleRequest,
        state: _state,
        VIRTUAL_SERVER: VIRTUAL_SERVER,
        // Expose for debugging
        buildDirectionResponse: buildDirectionResponse,
        buildClientConfigProto: buildClientConfigProto,
        buildGameplayConfigProto: buildGameplayConfigProto,
        buildUsersResponse: buildUsersResponse
    };
})();
