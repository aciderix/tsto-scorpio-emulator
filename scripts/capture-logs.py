#!/usr/bin/env python3
"""
TSTO Emulator — Automated Log Capture via Playwright (local headless Chrome)
Replaces BrowserBase — runs directly in GitHub Actions with SwiftShader WebGL.

Flow:
  1. Launch headless Chromium with WebGL flags
  2. Navigate to site, wait for libscorpio.so to load
  3. Click #btn-init → wait for engine init
  4. Click #btn-start → wait for game loop (45s)
  5. Extract: _generateReport(), _armTrace, _capturedLogs, screenshot
  6. Save everything to logs/
"""

import os
import sys
import json
import time
from datetime import datetime, timezone
from playwright.sync_api import sync_playwright

# --- Configuration ---
SITE_URL = "https://tsto-scorpio-emulator.netlify.app/"
GAME_LOOP_WAIT = 45


def main():
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    os.makedirs("logs", exist_ok=True)
    print(f"=== TSTO Log Capture (Playwright) — {timestamp} ===\n")

    console_lines = []

    with sync_playwright() as p:
        # ── 1. Launch browser with WebGL support ──
        print("1️⃣  Launching Chromium with SwiftShader WebGL...")
        browser = p.chromium.launch(
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
                "--enable-features=Vulkan",
            ]
        )
        context = browser.new_context(
            viewport={"width": 1280, "height": 720},
            ignore_https_errors=True,
        )
        page = context.new_page()

        # Collect console logs
        def on_console(msg):
            text = msg.text
            if text:
                console_lines.append(f"[{msg.type}] {text}")

        def on_page_error(error):
            console_lines.append(f"[PAGE_ERROR] {error}")

        page.on("console", on_console)
        page.on("pageerror", on_page_error)

        print(f"   Browser launched (PID: {browser.contexts[0].pages[0].url})")

        # ── 2. Check WebGL before navigating ──
        print("2️⃣  Checking WebGL support...")
        page.goto("about:blank")
        webgl_info = page.evaluate("""() => {
            const c = document.createElement('canvas');
            const gl = c.getContext('webgl2') || c.getContext('webgl');
            if (!gl) return 'NO WEBGL';
            return gl.getParameter(gl.VERSION) + ' | ' + gl.getParameter(gl.RENDERER);
        }""")
        print(f"   WebGL: {webgl_info}")

        if webgl_info == "NO WEBGL":
            print("   ⚠️ WebGL not available — continuing anyway (GL calls will be no-ops)")

        # ── 3. Navigate to site ──
        print(f"3️⃣  Navigating to {SITE_URL}...")
        page.goto(SITE_URL, wait_until="networkidle", timeout=60000)
        print(f"   Page loaded ({len(console_lines)} console lines)")

        # ── 4. Wait for .so to load (btn-init becomes enabled) ──
        print("4️⃣  Waiting for libscorpio.so to load...")
        so_loaded = False
        for i in range(90):  # max 90s
            ready = page.evaluate("""() => {
                const btn = document.getElementById('btn-init');
                return btn && !btn.disabled;
            }""")
            if ready:
                so_loaded = True
                print(f"   .so loaded after ~{i}s ({len(console_lines)} lines)")
                break
            time.sleep(1)

        if not so_loaded:
            print("   ⚠️ btn-init still disabled after 90s, clicking anyway...")

        # ── 5. Click Init Engine (#btn-init) ──
        print("5️⃣  Clicking #btn-init (Initialize Engine)...")
        click_result = page.evaluate("""() => {
            const btn = document.getElementById('btn-init');
            if (btn) { btn.click(); return 'clicked'; }
            return 'not found';
        }""")
        print(f"   Result: {click_result}")

        # Wait for init to complete (btn-start becomes enabled)
        print("   Waiting for engine init...")
        init_done = False
        for i in range(90):  # max 90s
            ready = page.evaluate("""() => {
                const btn = document.getElementById('btn-start');
                return btn && !btn.disabled;
            }""")
            if ready:
                init_done = True
                print(f"   Engine initialized after ~{i}s ({len(console_lines)} lines)")
                break
            time.sleep(1)

        if not init_done:
            print("   ⚠️ btn-start still disabled after 90s, clicking anyway...")

        # ── 6. Click Start Game Loop (#btn-start) ──
        print(f"6️⃣  Clicking #btn-start (Start Game Loop)...")
        pre_loop = len(console_lines)
        click_result = page.evaluate("""() => {
            const btn = document.getElementById('btn-start');
            if (btn) { btn.click(); return 'clicked'; }
            return 'not found';
        }""")
        print(f"   Result: {click_result}")

        print(f"   Waiting {GAME_LOOP_WAIT}s for game loop...")
        for i in range(GAME_LOOP_WAIT):
            time.sleep(1)
            if i % 10 == 9:
                print(f"   ... {i+1}s ({len(console_lines)} total lines)")

        post_loop = len(console_lines)
        print(f"   Game loop done: +{post_loop - pre_loop} new lines")

        # ── 7. Extract data from site API ──
        print("7️⃣  Extracting report, trace, and logs...")

        # a) _generateReport()
        report = page.evaluate("typeof window._generateReport === 'function' ? window._generateReport() : null")
        if report:
            path = f"logs/report-{timestamp}.txt"
            with open(path, "w") as f:
                f.write(report)
            print(f"   ✅ Report: {path} ({len(report)} chars)")
        else:
            print("   ⚠️ _generateReport() returned nothing")

        # b) _armTrace
        arm_trace = page.evaluate("window._armTrace || ''")
        if arm_trace:
            path = f"logs/arm-trace-{timestamp}.txt"
            with open(path, "w") as f:
                f.write(arm_trace)
            print(f"   ✅ ARM Trace: {path} ({len(arm_trace)} chars)")
        else:
            print("   ⚠️ _armTrace is empty")

        # c) _capturedLogs
        captured = page.evaluate("JSON.stringify(window._capturedLogs || [])")
        if captured and captured != "[]":
            path = f"logs/captured-logs-{timestamp}.json"
            with open(path, "w") as f:
                f.write(captured)
            print(f"   ✅ Captured logs: {path} ({len(captured)} chars)")
        else:
            print("   ⚠️ _capturedLogs is empty")

        # d) Engine stats
        stats = page.evaluate("""() => {
            if (!window._engine) return null;
            const e = window._engine;
            return JSON.stringify({
                framesRendered: e.framesRendered || 0,
                totalGlCalls: e.glBridge ? e.glBridge.callCount || 0 : 0,
                jniFunctions: (window._jniFunctions || []).length,
                renderStubs: (window._renderStubs || []).length,
                vfsFiles: window._vfs ? Object.keys(window._vfs.files || {}).length : 0,
                dlcPackages: window._dlcLoader ? window._dlcLoader.loadedCount || 0 : 0
            });
        }""")
        if stats:
            path = f"logs/engine-stats-{timestamp}.json"
            with open(path, "w") as f:
                f.write(stats)
            print(f"   ✅ Engine stats: {path}")

        # ── 8. Screenshot ──
        print("8️⃣  Taking screenshot...")
        screenshot_path = f"logs/screenshot-{timestamp}.png"
        page.screenshot(path=screenshot_path, full_page=False)
        size = os.path.getsize(screenshot_path)
        print(f"   ✅ Screenshot: {screenshot_path} ({size:,} bytes)")

        # ── 9. Save raw console logs ──
        print("9️⃣  Saving raw console logs...")
        header = f"""=== TSTO Playwright Log Capture ===
Timestamp: {timestamp}
WebGL: {webgl_info}
Console lines: {len(console_lines)}
Game loop lines: {post_loop - pre_loop}
========================================

"""
        full_log = header + "\n".join(console_lines)
        log_path = f"logs/console-{timestamp}.txt"
        with open(log_path, "w") as f:
            f.write(full_log)
        print(f"   ✅ Console: {log_path} ({len(console_lines)} lines)")

        # ── 10. Summary ──
        print("\n" + "=" * 50)
        print(f"📦 Files generated in logs/:")
        for fname in sorted(os.listdir("logs")):
            if timestamp in fname:
                fsize = os.path.getsize(f"logs/{fname}")
                print(f"   📄 {fname} ({fsize:,} bytes)")
        print("=" * 50)

        # ── Cleanup ──
        browser.close()
        print(f"\n✅ Done! All artifacts saved to logs/")


if __name__ == "__main__":
    main()
