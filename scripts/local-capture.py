#!/usr/bin/env python3
"""
TSTO Emulator — Local Log Capture (no deploy needed)
Serves site/ locally and runs Playwright against localhost.
"""

import os
import sys
import time
import threading
import http.server
import socketserver
import urllib.request
import urllib.error
import ssl
from datetime import datetime, timezone
from playwright.sync_api import sync_playwright

SITE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'site')
PORT = 8765
GAME_LOOP_WAIT = 45

# CDN proxy — mirrors Netlify _redirects: /dlc-cdn/* → EA CDN (HTTPS required for Host header through proxy)
CDN_BASE = "https://oct2018-4-35-0-uam5h44a.tstodlc.eamobile.com/netstorage/gameasset/direct/simpsons/"
DLC_CACHE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '.dlc-cache')


class ProxyHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=SITE_DIR, **kwargs)

    def log_message(self, format, *args):
        pass  # silence

    def do_GET(self):
        if self.path.startswith('/dlc-cdn/'):
            self._proxy_dlc()
        else:
            super().do_GET()

    def _proxy_dlc(self):
        """Proxy /dlc-cdn/* to EA CDN with local disk cache."""
        relative = self.path[len('/dlc-cdn/'):]
        cache_path = os.path.join(DLC_CACHE_DIR, relative.replace('/', os.sep))

        # Serve from cache if available
        if os.path.isfile(cache_path):
            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream')
            size = os.path.getsize(cache_path)
            self.send_header('Content-Length', str(size))
            self.end_headers()
            with open(cache_path, 'rb') as f:
                self.wfile.write(f.read())
            return

        # Download from CDN
        cdn_url = CDN_BASE + relative
        try:
            ctx = ssl.create_default_context()
            req = urllib.request.Request(cdn_url, headers={'User-Agent': 'TSTO-Emulator/1.0'})
            with urllib.request.urlopen(req, timeout=60, context=ctx) as resp:
                data = resp.read()
            # Cache to disk
            os.makedirs(os.path.dirname(cache_path), exist_ok=True)
            with open(cache_path, 'wb') as f:
                f.write(data)
            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            print(f"  [CDN] Cached: {relative} ({len(data):,} bytes)")
        except urllib.error.HTTPError as e:
            self.send_error(e.code, f'CDN error: {e.reason}')
        except Exception as e:
            self.send_error(502, f'CDN proxy error: {e}')


def start_server():
    with socketserver.TCPServer(("", PORT), ProxyHandler) as httpd:
        httpd.serve_forever()


def main():
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    os.makedirs("logs", exist_ok=True)

    # Start local HTTP server in background
    server_thread = threading.Thread(target=start_server, daemon=True)
    server_thread.start()
    time.sleep(0.5)
    site_url = f"http://localhost:{PORT}/"
    print(f"=== TSTO Local Capture — {timestamp} ===")
    print(f"Serving {SITE_DIR} at {site_url}\n")

    console_lines = []

    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path="/root/.cache/ms-playwright/chromium_headless_shell-1194/chrome-linux/headless_shell",
            headless=True,
            args=[
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--enable-unsafe-swiftshader",
                "--use-gl=swiftshader",
                "--enable-webgl",
                "--ignore-gpu-blocklist",
                "--disable-gpu-sandbox",
                "--use-angle=swiftshader",
                "--disable-software-rasterizer",
            ]
        )
        context = browser.new_context(
            viewport={"width": 1280, "height": 720},
            ignore_https_errors=True,
        )
        page = context.new_page()

        def on_console(msg):
            text = msg.text
            if text:
                console_lines.append(f"[{msg.type}] {text}")

        page.on("console", on_console)
        page.on("pageerror", lambda e: console_lines.append(f"[PAGE_ERROR] {e}"))

        # Navigate
        print(f"Navigating to {site_url}...")
        page.goto(site_url, wait_until="networkidle", timeout=60000)
        print(f"Page loaded ({len(console_lines)} lines)")

        # Wait for .so
        print("Waiting for libscorpio.so...")
        for i in range(120):
            ready = page.evaluate("() => { const b = document.getElementById('btn-init'); return b && !b.disabled; }")
            if ready:
                print(f".so loaded after ~{i}s")
                break
            time.sleep(1)

        # Init Engine
        print("Clicking #btn-init...")
        page.evaluate("document.getElementById('btn-init')?.click()")
        for i in range(120):
            ready = page.evaluate("() => { const b = document.getElementById('btn-start'); return b && !b.disabled; }")
            if ready:
                print(f"Engine init done after ~{i}s ({len(console_lines)} lines)")
                break
            time.sleep(1)

        # Start Game Loop
        print(f"Clicking #btn-start, waiting {GAME_LOOP_WAIT}s...")
        page.evaluate("document.getElementById('btn-start')?.click()")
        for i in range(GAME_LOOP_WAIT):
            time.sleep(1)
            if i % 10 == 9:
                print(f"  ...{i+1}s ({len(console_lines)} lines)")

        # Extract data
        print("Extracting data...")

        report = page.evaluate("typeof window._generateReport === 'function' ? window._generateReport() : null")
        if report:
            path = f"logs/report-{timestamp}.txt"
            with open(path, "w") as f:
                f.write(report)
            print(f"  report: {len(report)} chars")

        arm_trace = page.evaluate("window._armTrace || ''")
        if arm_trace:
            path = f"logs/arm-trace-{timestamp}.txt"
            with open(path, "w") as f:
                f.write(arm_trace)
            print(f"  arm-trace: {len(arm_trace)} chars")

        captured = page.evaluate("JSON.stringify(window._capturedLogs || [])")
        if captured and captured != "[]":
            path = f"logs/captured-logs-{timestamp}.json"
            with open(path, "w") as f:
                f.write(captured)
            print(f"  captured-logs: {len(captured)} chars")

        stats = page.evaluate("""() => {
            if (!window._engine) return null;
            const e = window._engine;
            return JSON.stringify({
                framesRendered: e.framesRendered || 0,
                totalGlCalls: e.glBridge ? e.glBridge.callCount || 0 : 0,
                jniFunctions: (window._jniFunctions || []).length,
                vfsFiles: window._vfs ? Object.keys(window._vfs.files || {}).length : 0,
                dlcPackages: window._dlcLoader ? window._dlcLoader.loadedCount || 0 : 0
            });
        }""")
        if stats:
            path = f"logs/engine-stats-{timestamp}.json"
            with open(path, "w") as f:
                f.write(stats)
            print(f"  engine-stats: {stats}")

        screenshot_path = f"logs/screenshot-{timestamp}.png"
        page.screenshot(path=screenshot_path, full_page=False)
        print(f"  screenshot: {os.path.getsize(screenshot_path):,} bytes")

        # Save console
        log_path = f"logs/console-{timestamp}.txt"
        with open(log_path, "w") as f:
            f.write("\n".join(console_lines))
        print(f"  console: {len(console_lines)} lines")

        browser.close()

    print(f"\nDone! Files in logs/*-{timestamp}.*")


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    main()
