#!/bin/sh
# TSTO Scorpio Emulator - Full Environment Rebuild Script
# Run this to reconstruct the entire dev environment after sandbox reset
# Usage: sh /agent/home/tsto-scripts/rebuild.sh

set -e
TOKEN="${GITHUB_TOKEN}"

echo "=== STEP 1: Install dependencies ==="
apk add --no-cache git nodejs npm chromium 2>/dev/null || true

echo "=== STEP 2: Clone TSTO repo (sparse - site/ only) ==="
if [ ! -d /tmp/tsto-repo ]; then
    cd /tmp
    git clone --filter=blob:none --sparse \
        "https://${TOKEN}@github.com/aciderix/tsto-scorpio-emulator.git" tsto-repo
    cd tsto-repo
    git sparse-checkout set site scripts
    echo "Repo cloned"
else
    echo "Repo already exists"
fi

echo "=== STEP 3: Clone GameServer-Reborn ==="
if [ ! -d /tmp/GameServer-Reborn ]; then
    cd /tmp
    git clone https://github.com/TappedOutReborn/GameServer-Reborn.git
    cd GameServer-Reborn
    npm install --production 2>/dev/null
    echo "GameServer installed"
else
    echo "GameServer already exists"
fi

echo "=== STEP 4: Install Puppeteer ==="
cd /tmp/tsto-repo
if [ ! -d node_modules/puppeteer-core ]; then
    npm init -y 2>/dev/null
    npm install puppeteer-core 2>/dev/null
    echo "Puppeteer installed"
else
    echo "Puppeteer already installed"
fi

echo "=== STEP 5: Apply saved patches ==="
# Copy all patched files over the originals
for f in android-shims.js jni-bridge.js scorpio-engine.js main.js; do
    if [ -f /agent/home/tsto-patched-files/$f ]; then
        cp /agent/home/tsto-patched-files/$f /tmp/tsto-repo/site/js/$f
        echo "Restored patched $f"
    fi
done

# Copy index.html
if [ -f /agent/home/tsto-patched-files/index.html ]; then
    cp /agent/home/tsto-patched-files/index.html /tmp/tsto-repo/site/index.html
    echo "Restored patched index.html"
fi

# Copy proxy-server.js
if [ -f /agent/home/tsto-patched-files/proxy-server.js ]; then
    cp /agent/home/tsto-patched-files/proxy-server.js /tmp/tsto-repo/proxy-server.js
    echo "Restored proxy-server.js"
fi

echo "=== STEP 6: Start servers ==="
killall -9 node 2>/dev/null || true
sleep 1

cd /tmp/GameServer-Reborn && node src/index.js > /tmp/gameserver.log 2>&1 &
echo "GameServer-Reborn started on port 4242 (PID $!)"
sleep 2

cd /tmp/tsto-repo && node proxy-server.js > /tmp/proxy.log 2>&1 &
echo "Proxy started on port 9090 (PID $!)"
sleep 1

echo "=== STEP 7: Verify ==="
curl -s http://localhost:4242/connect/auth?authenticator_login_type=mobile_anonymous\&response_type=code | head -c 80
echo ""
curl -s http://localhost:9090/ | head -c 80
echo ""

echo ""
echo "=== REBUILD COMPLETE ==="
echo "Emulator: http://localhost:9090/"
echo "GameServer: http://localhost:4242/"
