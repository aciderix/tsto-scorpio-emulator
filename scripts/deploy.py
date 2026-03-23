#!/usr/bin/env python3
"""
TSTO Emulator — Netlify Deploy Script

Uses the digest API method (the only one that works — zip upload stays stuck on "new")

Usage:
    python3 scripts/deploy.py                   # Deploy from current directory
    python3 scripts/deploy.py /path/to/build    # Deploy from specified directory
    NETLIFY_TOKEN=xxx python3 scripts/deploy.py # Override token via env var
"""

import hashlib, os, sys, json, time, urllib.request, urllib.parse

SITE_ID = "09f5b92b-3e4b-4a8d-991f-f4aa649de20e"
TOKEN = os.environ.get("NETLIFY_TOKEN", "nfp_LryH8Vuiwo6Fyez9Vc8ErQCSwAFihEQrb334")
API = "https://api.netlify.com/api/v1"
SKIP_DIRS = {'.git', '__pycache__'}
SKIP_FILES = set()
SKIP_EXTS = {'.zip', '.pyc'}

def main():
    build_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'site')
    os.chdir(build_dir)
    
    print("🚀 TSTO Emulator Deploy")
    print(f"   Directory: {os.path.abspath('.')}")
    print()
    
    # Step 1: SHA1 digests
    print("📋 Step 1/4: Calculating SHA1 digests...")
    digests = {}
    file_map = {}
    for root, dirs, files in os.walk('.'):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for fname in files:
            if fname in SKIP_FILES or any(fname.endswith(e) for e in SKIP_EXTS):
                continue
            fpath = os.path.join(root, fname)
            rel = fpath[2:]  # strip ./
            with open(fpath, 'rb') as f:
                sha = hashlib.sha1(f.read()).hexdigest()
            digests['/' + rel] = sha
            file_map[sha] = fpath
    
    print(f"   Found {len(digests)} files")
    
    # Step 2: Create deploy
    print("📤 Step 2/4: Creating deploy...")
    data = json.dumps({"files": digests}).encode()
    req = urllib.request.Request(
        f"{API}/sites/{SITE_ID}/deploys",
        data=data,
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "application/json"
        }
    )
    try:
        resp = json.loads(urllib.request.urlopen(req, timeout=30).read())
    except Exception as e:
        print(f"❌ Deploy creation failed: {e}")
        sys.exit(1)
    
    deploy_id = resp['id']
    required = resp.get('required', [])
    print(f"   Deploy ID: {deploy_id}")
    print(f"   Files to upload: {len(required)}")
    
    # Step 3: Upload required
    if required:
        print("📁 Step 3/4: Uploading changed files...")
        for sha in required:
            fpath = file_map.get(sha)
            if not fpath:
                continue
            rel = fpath[2:]
            size = os.path.getsize(fpath)
            print(f"   ↑ /{rel} ({size:,} bytes)")
            
            with open(fpath, 'rb') as f:
                file_data = f.read()
            
            encoded_path = urllib.parse.quote('/' + rel, safe='')
            req = urllib.request.Request(
                f"{API}/deploys/{deploy_id}/files/{encoded_path}",
                data=file_data,
                headers={
                    "Authorization": f"Bearer {TOKEN}",
                    "Content-Type": "application/octet-stream"
                },
                method='PUT'
            )
            urllib.request.urlopen(req, timeout=60)
    else:
        print("📁 Step 3/4: No files changed — skipping upload")
    
    # Step 4: Wait for ready
    print("⏳ Step 4/4: Waiting for deploy...")
    for i in range(30):
        req = urllib.request.Request(
            f"{API}/deploys/{deploy_id}",
            headers={"Authorization": f"Bearer {TOKEN}"}
        )
        state = json.loads(urllib.request.urlopen(req, timeout=10).read()).get('state', '?')
        if state == 'ready':
            print()
            print("✅ Deploy successful!")
            print(f"   URL: https://tsto-scorpio-emulator.netlify.app")
            print(f"   Deploy ID: {deploy_id}")
            sys.exit(0)
        elif state == 'error':
            print(f"\n❌ Deploy failed with state: error")
            sys.exit(1)
        sys.stdout.write('.')
        sys.stdout.flush()
        time.sleep(2)
    
    print(f"\n⚠️ Deploy still processing after 60s (state: {state})")
    sys.exit(1)

if __name__ == '__main__':
    main()
