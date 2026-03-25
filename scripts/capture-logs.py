#!/usr/bin/env python3
"""
TSTO Emulator - Automated Log Capture via BrowserBase
Runs in GitHub Actions after each Netlify deploy.
Captures console logs with WebGL support and saves to logs/ directory.
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

# --- Configuration (from environment) ---
BROWSERBASE_API_KEY = os.environ["BROWSERBASE_API_KEY"]
BROWSERBASE_PROJECT_ID = os.environ["BROWSERBASE_PROJECT_ID"]
SITE_URL = "https://tsto-scorpio-emulator.netlify.app/"
INIT_WAIT = 25
GAME_LOOP_WAIT = 45


class CDPSession:
    """CDP session that properly handles message routing."""
    
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
    """Create a BrowserBase session and return the CDP websocket URL."""
    ctx = ssl.create_default_context()
    data = json.dumps({"projectId": BROWSERBASE_PROJECT_ID}).encode()
    req = urllib.request.Request(
        "https://api.browserbase.com/v1/sessions",
        data=data,
        method="POST"
    )
    req.add_header("x-bb-api-key", BROWSERBASE_API_KEY)
    req.add_header("Content-Type", "application/json")
    
    resp = urllib.request.urlopen(req, context=ctx)
    session = json.loads(resp.read())
    session_id = session["id"]
    print(f"Session: {session_id}")
    
    # Get debug URLs
    req2 = urllib.request.Request(
        f"https://api.browserbase.com/v1/sessions/{session_id}/debug",
        method="GET"
    )
    req2.add_header("x-bb-api-key", BROWSERBASE_API_KEY)
    resp2 = urllib.request.urlopen(req2, context=ctx)
    debug = json.loads(resp2.read())
    
    return session_id, debug["debuggerFullscreenUrl"], debug["wsUrl"]


def main():
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    print(f"=== TSTO Log Capture - {timestamp} ===")
    
    # 1. Create BrowserBase session
    print("1️⃣  Creating BrowserBase session...")
    session_id, viewer_url, ws_url = create_browserbase_session()
    print(f"   Session: {session_id}")
    
    # 2. Connect CDP to browser endpoint
    print("2️⃣  Connecting to browser via CDP...")
    cdp = CDPSession(ws_url)
    
    # Get page targets
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
    
    # Attach to page
    attach = cdp.send("Target.attachToTarget", {
        "targetId": page_target,
        "flatten": True
    })
    session = attach.get("sessionId") if attach else None
    if not session:
        print("❌ Could not attach to page")
        cdp.close()
        sys.exit(1)
    
    print(f"   Attached to page (session: {session[:20]}...)")
    
    # Helper to send commands to page session
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
    
    console_lines = []
    
    def collect_console():
        for evt in cdp.get_events():
            method = evt.get("method", "")
            params = evt.get("params", {})
            if method == "Runtime.consoleAPICalled" and evt.get("sessionId") == session:
                args = params.get("args", [])
                line_parts = []
                for a in args:
                    if "value" in a:
                        line_parts.append(str(a["value"]))
                    elif "description" in a:
                        line_parts.append(a["description"])
                if line_parts:
                    console_lines.append(" ".join(line_parts))
            elif method == "Runtime.exceptionThrown" and evt.get("sessionId") == session:
                exc = params.get("exceptionDetails", {})
                text = exc.get("text", "")
                if text:
                    console_lines.append(f"[EXCEPTION] {text}")
    
    # 3. Check WebGL support
    print("3️⃣  Checking WebGL support...")
    webgl = page_send("Runtime.evaluate", {
        "expression": """(() => {
            const c = document.createElement('canvas');
            const gl = c.getContext('webgl2') || c.getContext('webgl');
            if (!gl) return 'NO WEBGL';
            return gl.getParameter(gl.VERSION) + ' | ' + gl.getParameter(gl.RENDERER);
        })()""",
        "returnByValue": True
    })
    webgl_info = webgl.get("result", {}).get("value", "unknown") if webgl else "unknown"
    print(f"   WebGL: {webgl_info}")
    
    # 4. Navigate to site
    print(f"4️⃣  Navigating to {SITE_URL}...")
    page_send("Page.navigate", {"url": SITE_URL}, timeout=30)
    time.sleep(5)
    collect_console()
    pre_lines = len(console_lines)
    print(f"   Page loaded ({pre_lines} console lines)")
    
    # 5. Click Initialize Engine
    print(f"5️⃣  Clicking Initialize Engine...")
    page_send("Runtime.evaluate", {
        "expression": """(() => {
            const btns = document.querySelectorAll('button');
            for (const b of btns) {
                if (b.textContent.includes('Initialize Engine') || b.textContent.includes('Init')) {
                    b.click();
                    return 'clicked';
                }
            }
            return 'not found';
        })()""",
        "returnByValue": True
    })
    
    print(f"   Waiting {INIT_WAIT}s...")
    for i in range(INIT_WAIT):
        time.sleep(1)
        collect_console()
    
    post_init = len(console_lines)
    print(f"   After init: {post_init} console lines (+{post_init - pre_lines})")
    
    # 6. Click Start Game Loop
    print(f"6️⃣  Clicking Start Game Loop...")
    page_send("Runtime.evaluate", {
        "expression": """(() => {
            const btns = document.querySelectorAll('button');
            for (const b of btns) {
                if (b.textContent.includes('Start Game Loop') || b.textContent.includes('Game Loop')) {
                    b.click();
                    return 'clicked';
                }
            }
            return 'not found';
        })()""",
        "returnByValue": True
    })
    
    print(f"   Waiting {GAME_LOOP_WAIT}s...")
    for i in range(GAME_LOOP_WAIT):
        time.sleep(1)
        collect_console()
    
    post_loop = len(console_lines)
    print(f"   After game loop: {post_loop} console lines (+{post_loop - post_init})")
    
    # 7. Also try to click Download Logs button to trigger any extra output
    page_send("Runtime.evaluate", {
        "expression": """(() => {
            const btns = document.querySelectorAll('button');
            for (const b of btns) {
                if (b.textContent.includes('Download Log') || b.textContent.includes('Raw Log')) {
                    b.click();
                    return 'clicked: ' + b.textContent;
                }
            }
            return 'not found';
        })()""",
        "returnByValue": True
    })
    time.sleep(2)
    collect_console()
    
    # 8. Take screenshot
    print("7️⃣  Taking screenshot...")
    screenshot = page_send("Page.captureScreenshot", {"format": "png"})
    if screenshot and "data" in screenshot:
        png_data = base64.b64decode(screenshot["data"])
        os.makedirs("logs", exist_ok=True)
        with open(f"logs/screenshot-{timestamp}.png", "wb") as f:
            f.write(png_data)
        print(f"   Screenshot saved")
    
    # 9. Save logs
    print("8️⃣  Saving logs...")
    
    # Build report header
    header = f"""=== TSTO BrowserBase Log Capture ===
Timestamp: {timestamp}
WebGL: {webgl_info}
Console lines: {len(console_lines)}
Lines after init: {post_init - pre_lines}
Lines after game loop: {post_loop - post_init}
========================================

"""
    
    full_log = header + "\n".join(console_lines)
    os.makedirs("logs", exist_ok=True)
    log_path = f"logs/browserbase-{timestamp}.txt"
    with open(log_path, "w") as f:
        f.write(full_log)
    
    print(f"   Saved {log_path} ({len(console_lines)} lines, {len(full_log)} bytes)")
    
    # 10. Cleanup
    cdp.close()
    print(f"\n✅ Done! Logs saved to {log_path}")
    print(f"   GitHub Actions will commit and push automatically.")


if __name__ == "__main__":
    main()
