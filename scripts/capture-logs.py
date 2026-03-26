#!/usr/bin/env python3
"""
TSTO Emulator — Automated Log Capture via BrowserBase
Runs in GitHub Actions after Netlify deploy.

Flow:
  1. Create BrowserBase session (WebGL 2.0)
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
import base64
import urllib.request
import ssl
import threading
from datetime import datetime, timezone

# --- Configuration ---
BROWSERBASE_API_KEY = os.environ["BROWSERBASE_API_KEY"]
BROWSERBASE_PROJECT_ID = os.environ["BROWSERBASE_PROJECT_ID"]
SITE_URL = "https://tsto-scorpio-emulator.netlify.app/"
GAME_LOOP_WAIT = 45


class CDPSession:
    """CDP session with threaded message routing."""

    def __init__(self, ws_url):
        import websocket
        self.ws = websocket.create_connection(ws_url, timeout=30)
        self.msg_id = 0
        self.responses = {}
        self.events = []
        self.lock = threading.Lock()
        self.running = True
        self.listener = threading.Thread(target=self._listen, daemon=True)
        self.listener.start()

    def _listen(self):
        while self.running:
            try:
                raw = self.ws.recv()
                if not raw:
                    break
                msg = json.loads(raw)
                if "id" in msg:
                    with self.lock:
                        self.responses[msg["id"]] = msg
                else:
                    with self.lock:
                        self.events.append(msg)
            except Exception:
                break

    def send(self, method, params=None, timeout=15):
        self.msg_id += 1
        mid = self.msg_id
        msg = {"id": mid, "method": method}
        if params:
            msg["params"] = params
        self.ws.send(json.dumps(msg))

        start = time.time()
        while time.time() - start < timeout:
            with self.lock:
                if mid in self.responses:
                    resp = self.responses.pop(mid)
                    return resp.get("result")
            time.sleep(0.1)
        return None

    def get_events(self):
        with self.lock:
            evts = self.events[:]
            self.events.clear()
            return evts

    def close(self):
        self.running = False
        try:
            self.ws.close()
        except:
            pass


def create_browserbase_session():
    """Create a BrowserBase session, return (session_id, ws_url)."""
    ctx = ssl.create_default_context()
    data = json.dumps({"projectId": BROWSERBASE_PROJECT_ID}).encode()
    req = urllib.request.Request(
        "https://api.browserbase.com/v1/sessions",
        data=data, method="POST"
    )
    req.add_header("x-bb-api-key", BROWSERBASE_API_KEY)
    req.add_header("Content-Type", "application/json")

    resp = urllib.request.urlopen(req, context=ctx)
    session = json.loads(resp.read())
    session_id = session["id"]

    req2 = urllib.request.Request(
        f"https://api.browserbase.com/v1/sessions/{session_id}/debug",
        method="GET"
    )
    req2.add_header("x-bb-api-key", BROWSERBASE_API_KEY)
    resp2 = urllib.request.urlopen(req2, context=ctx)
    debug = json.loads(resp2.read())

    return session_id, debug["wsUrl"]


def page_eval(page_send_fn, expression, timeout=15):
    """Evaluate JS in page and return the value."""
    result = page_send_fn("Runtime.evaluate", {
        "expression": expression,
        "returnByValue": True,
        "awaitPromise": True
    }, timeout=timeout)
    if result and "result" in result:
        return result["result"].get("value")
    return None


def main():
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    os.makedirs("logs", exist_ok=True)
    print(f"=== TSTO Log Capture — {timestamp} ===\n")

    # ── 1. Create BrowserBase session ──
    print("1️⃣  Creating BrowserBase session...")
    session_id, ws_url = create_browserbase_session()
    print(f"   Session: {session_id}")

    # ── 2. Connect CDP ──
    print("2️⃣  Connecting via CDP...")
    cdp = CDPSession(ws_url)

    # Find page target
    targets = cdp.send("Target.getTargets")
    page_target = None
    if targets and "targetInfos" in targets:
        for t in targets["targetInfos"]:
            if t.get("type") == "page":
                page_target = t["targetId"]
                break

    if not page_target:
        print("❌ No page target found")
        cdp.close()
        sys.exit(1)

    attach = cdp.send("Target.attachToTarget", {
        "targetId": page_target, "flatten": True
    })
    session = attach.get("sessionId") if attach else None
    if not session:
        print("❌ Could not attach to page")
        cdp.close()
        sys.exit(1)

    print(f"   Attached to page")

    # Helper: send command to page session
    def page_send(method, params=None, timeout=15):
        cdp.msg_id += 1
        mid = cdp.msg_id
        msg = {"id": mid, "method": method, "sessionId": session}
        if params:
            msg["params"] = params
        cdp.ws.send(json.dumps(msg))
        start = time.time()
        while time.time() - start < timeout:
            with cdp.lock:
                if mid in cdp.responses:
                    return cdp.responses.pop(mid).get("result")
            time.sleep(0.1)
        return None

    # Enable console + runtime
    page_send("Runtime.enable")
    page_send("Console.enable")
    page_send("Log.enable")

    # Console log accumulator
    console_lines = []

    def collect_console():
        for evt in cdp.get_events():
            method = evt.get("method", "")
            params = evt.get("params", {})
            if method == "Runtime.consoleAPICalled" and evt.get("sessionId") == session:
                args = params.get("args", [])
                parts = []
                for a in args:
                    if "value" in a:
                        parts.append(str(a["value"]))
                    elif "description" in a:
                        parts.append(a["description"])
                if parts:
                    console_lines.append(" ".join(parts))
            elif method == "Runtime.exceptionThrown" and evt.get("sessionId") == session:
                exc = params.get("exceptionDetails", {})
                text = exc.get("text", "")
                if text:
                    console_lines.append(f"[EXCEPTION] {text}")

    # ── 3. Check WebGL ──
    print("3️⃣  Checking WebGL...")
    webgl_info = page_eval(page_send, """(() => {
        const c = document.createElement('canvas');
        const gl = c.getContext('webgl2') || c.getContext('webgl');
        if (!gl) return 'NO WEBGL';
        return gl.getParameter(gl.VERSION) + ' | ' + gl.getParameter(gl.RENDERER);
    })()""")
    print(f"   WebGL: {webgl_info}")

    # ── 4. Navigate to site ──
    print(f"4️⃣  Navigating to {SITE_URL}...")
    page_send("Page.navigate", {"url": SITE_URL}, timeout=30)
    time.sleep(5)
    collect_console()
    print(f"   Page loaded ({len(console_lines)} console lines)")

    # ── 5. Wait for .so to load (btn-init becomes enabled) ──
    print("5️⃣  Waiting for libscorpio.so to load...")
    so_loaded = False
    for i in range(60):  # max 60s
        collect_console()
        ready = page_eval(page_send, """(() => {
            const btn = document.getElementById('btn-init');
            return btn && !btn.disabled;
        })()""")
        if ready:
            so_loaded = True
            print(f"   .so loaded after ~{i+5}s ({len(console_lines)} lines)")
            break
        time.sleep(1)

    if not so_loaded:
        print("   ⚠️ btn-init still disabled after 60s, clicking anyway...")

    # ── 6. Click Init Engine (#btn-init) ──
    print("6️⃣  Clicking #btn-init (Initialize Engine)...")
    click_result = page_eval(page_send, """(() => {
        const btn = document.getElementById('btn-init');
        if (btn) { btn.click(); return 'clicked'; }
        return 'not found';
    })()""")
    print(f"   Result: {click_result}")

    # Wait for init to complete (btn-start becomes enabled)
    print("   Waiting for engine init...")
    init_done = False
    for i in range(60):  # max 60s
        collect_console()
        ready = page_eval(page_send, """(() => {
            const btn = document.getElementById('btn-start');
            return btn && !btn.disabled;
        })()""")
        if ready:
            init_done = True
            print(f"   Engine initialized after ~{i}s ({len(console_lines)} lines)")
            break
        time.sleep(1)

    if not init_done:
        print("   ⚠️ btn-start still disabled after 60s, clicking anyway...")

    # ── 7. Click Start Game Loop (#btn-start) ──
    print(f"7️⃣  Clicking #btn-start (Start Game Loop)...")
    pre_loop = len(console_lines)
    click_result = page_eval(page_send, """(() => {
        const btn = document.getElementById('btn-start');
        if (btn) { btn.click(); return 'clicked'; }
        return 'not found';
    })()""")
    print(f"   Result: {click_result}")

    print(f"   Waiting {GAME_LOOP_WAIT}s for game loop...")
    for i in range(GAME_LOOP_WAIT):
        time.sleep(1)
        collect_console()
        if i % 10 == 9:
            print(f"   ... {i+1}s ({len(console_lines)} total lines)")

    post_loop = len(console_lines)
    print(f"   Game loop done: +{post_loop - pre_loop} new lines")

    # ── 8. Extract data from site API ──
    print("8️⃣  Extracting report, trace, and logs...")

    # a) _generateReport()
    report = page_eval(page_send, "window._generateReport()", timeout=10)
    if report:
        path = f"logs/report-{timestamp}.txt"
        with open(path, "w") as f:
            f.write(report)
        print(f"   ✅ Report: {path} ({len(report)} chars)")
    else:
        print("   ⚠️ _generateReport() returned nothing")

    # b) _armTrace
    arm_trace = page_eval(page_send, "window._armTrace || ''", timeout=10)
    if arm_trace:
        path = f"logs/arm-trace-{timestamp}.txt"
        with open(path, "w") as f:
            f.write(arm_trace)
        print(f"   ✅ ARM Trace: {path} ({len(arm_trace)} chars)")
    else:
        print("   ⚠️ _armTrace is empty (may not be available yet)")

    # c) _capturedLogs (structured logs from the site's own logger)
    captured = page_eval(page_send, "JSON.stringify(window._capturedLogs || [])", timeout=10)
    if captured and captured != "[]":
        path = f"logs/captured-logs-{timestamp}.json"
        with open(path, "w") as f:
            f.write(captured)
        print(f"   ✅ Captured logs: {path} ({len(captured)} chars)")
    else:
        print("   ⚠️ _capturedLogs is empty")

    # d) Engine stats
    stats = page_eval(page_send, """(() => {
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
    })()""", timeout=10)
    if stats:
        path = f"logs/engine-stats-{timestamp}.json"
        with open(path, "w") as f:
            f.write(stats)
        print(f"   ✅ Engine stats: {path}")

    # ── 9. Screenshot ──
    print("9️⃣  Taking screenshot...")
    screenshot = page_send("Page.captureScreenshot", {"format": "png"})
    if screenshot and "data" in screenshot:
        png_data = base64.b64decode(screenshot["data"])
        path = f"logs/screenshot-{timestamp}.png"
        with open(path, "wb") as f:
            f.write(png_data)
        print(f"   ✅ Screenshot: {path} ({len(png_data)} bytes)")

    # ── 10. Save raw console logs ──
    print("🔟  Saving raw console logs...")
    header = f"""=== TSTO BrowserBase Log Capture ===
Timestamp: {timestamp}
Session: {session_id}
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

    # ── 11. Summary ──
    print("\n" + "=" * 50)
    print(f"📦 Files generated in logs/:")
    for fname in sorted(os.listdir("logs")):
        if timestamp in fname:
            size = os.path.getsize(f"logs/{fname}")
            print(f"   📄 {fname} ({size:,} bytes)")
    print("=" * 50)

    # ── Cleanup ──
    cdp.close()
    print(f"\n✅ Done! All artifacts saved to logs/")


if __name__ == "__main__":
    main()
