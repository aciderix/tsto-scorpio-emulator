const http = require('http');
const fs = require('fs');
const path = require('path');

const SITE_DIR = path.join(__dirname, 'site');
const GAME_SERVER = 'http://localhost:4242';
const PORT = 9090;

// MIME types
const MIME = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.so': 'application/octet-stream', '.wasm': 'application/wasm',
    '.bin': 'application/octet-stream', '.txt': 'text/plain',
};

const server = http.createServer((req, res) => {
    // CORS headers for sync XHR from browser
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        return res.end();
    }

    // Known game server paths → proxy to GameServer-Reborn
    const gameServerPaths = ['/connect/', '/director/', '/mh/', '/user/', '/auth/'];
    const isGameRequest = gameServerPaths.some(p => req.url.startsWith(p));
    
    if (isGameRequest) {
        // Collect body
        let body = [];
        req.on('data', chunk => body.push(chunk));
        req.on('end', () => {
            const bodyBuf = Buffer.concat(body);
            const proxyReq = http.request(GAME_SERVER + req.url, {
                method: req.method,
                headers: {
                    ...req.headers,
                    host: 'localhost:4242',
                    'content-length': bodyBuf.length,
                },
            }, proxyRes => {
                res.writeHead(proxyRes.statusCode, proxyRes.headers);
                proxyRes.pipe(res);
            });
            proxyReq.on('error', e => {
                console.error('[PROXY] Error:', e.message);
                res.writeHead(502);
                res.end('Bad Gateway: ' + e.message);
            });
            if (bodyBuf.length > 0) proxyReq.write(bodyBuf);
            proxyReq.end();
        });
        return;
    }

    // Static files from site/
    let filePath = path.join(SITE_DIR, req.url === '/' ? 'index.html' : req.url);
    filePath = filePath.split('?')[0]; // strip query string
    
    fs.stat(filePath, (err, stats) => {
        if (err) {
            res.writeHead(404);
            return res.end('Not found: ' + req.url);
        }
        const ext = path.extname(filePath);
        const mime = MIME[ext] || 'application/octet-stream';
        res.writeHead(200, {
            'Content-Type': mime,
            'Content-Length': stats.size,
        });
        fs.createReadStream(filePath).pipe(res);
    });
});

server.listen(PORT, () => console.log(`Proxy server on http://localhost:${PORT}`));
