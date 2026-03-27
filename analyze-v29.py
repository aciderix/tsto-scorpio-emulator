#!/usr/bin/env python3
"""
TSTO v29 Log Analyzer — Comprehensive diagnostic from latest logs
Analyzes console logs, reports, and raw logs to find ALL problems.
"""

import re
import json
import os
from collections import Counter, defaultdict

# Latest log files (post-v29 push)
CONSOLE_LOG = "logs/console-20260326-173118.txt"
RAW_LOG = "logs/tsto-raw-logs-2026-03-26T17-39-30.449Z.txt"
REPORT = "logs/tsto-report-2026-03-26T17-39-27.958Z.txt"
REPORT2 = "logs/report-20260326-173118.txt"
ENGINE_STATS = "logs/engine-stats-20260326-173118.json"
ARM_TRACE = "logs/arm-trace-20260326-173118.txt"
CAPTURED = "logs/captured-logs-20260326-173118.json"

def read_file(path, max_lines=None):
    try:
        with open(path, 'r', errors='replace') as f:
            if max_lines:
                return [f.readline() for _ in range(max_lines)]
            return f.readlines()
    except:
        return []

def read_json(path):
    try:
        with open(path, 'r', errors='replace') as f:
            return json.load(f)
    except:
        return None

print("=" * 80)
print("TSTO v29 COMPREHENSIVE LOG ANALYSIS")
print("=" * 80)

# ============================================================
# 1. ENGINE STATS
# ============================================================
stats = read_json(ENGINE_STATS)
if stats:
    print("\n## ENGINE STATS")
    for k, v in stats.items():
        print(f"  {k}: {v}")

# ============================================================
# 2. REPORT ANALYSIS
# ============================================================
print("\n## REPORT SUMMARY")
for rpath in [REPORT, REPORT2]:
    if os.path.exists(rpath):
        lines = read_file(rpath)
        print(f"\n--- {rpath} ({len(lines)} lines) ---")
        for line in lines[:50]:
            print(f"  {line.rstrip()}")
        if len(lines) > 50:
            print(f"  ... ({len(lines) - 50} more lines)")
        break

# ============================================================
# 3. CONSOLE LOG DEEP ANALYSIS
# ============================================================
print("\n" + "=" * 80)
print("## CONSOLE LOG ANALYSIS")

# Read line by line to handle huge files
errors = []
warnings = []
mem_maps = []
mem_unmapped = []
shim_calls = Counter()
jni_calls = Counter()
closeapp_count = 0
qemu_assertions = []
vfs_misses = []
vfs_opens = []
pthread_events = []
net_events = []
fopen_events = []
fread_events = []
malloc_events = []
generic_return_calls = []
null_ptr_events = []
render_frames = 0
init_steps = []
dlc_events = []
hook_events = []
file_struct_events = []
socket_events = []
crash_events = []
arm_insn_counts = []
timeouts = []
gl_events = []
sync_events = []
exception_events = []
unknown_shims = []
mem_map_errors = []

# Patterns
PAT_ERROR = re.compile(r'\[ERROR\]|\bERROR\b|❌|FATAL|ASSERTION|assertion|Uncaught|TypeError|RangeError', re.I)
PAT_WARN = re.compile(r'\[WARN\]|\bWARN\b|⚠', re.I)
PAT_MEMMAP = re.compile(r'mem_map|mem_map_js', re.I)
PAT_UNMAPPED = re.compile(r'unmapped|UNMAPPED', re.I)
PAT_CLOSEAPP = re.compile(r'closeApp', re.I)
PAT_QEMU = re.compile(r'qemu|QEMU|assertion.*fail|phys_section', re.I)
PAT_VFS_MISS = re.compile(r'VFS.*not found|VFS.*miss|file not found', re.I)
PAT_VFS_OPEN = re.compile(r'fopen|VFS.*open', re.I)
PAT_PTHREAD = re.compile(r'pthread|PTHREAD|thread', re.I)
PAT_NET = re.compile(r'\[NET\]|socket|connect|HTTP|network', re.I)
PAT_RENDER = re.compile(r'OGLESRender|frame\s+\d+|renderFrame', re.I)
PAT_INIT = re.compile(r'Step \d+|JNI_OnLoad|ScorpioJNI|BGCoreJNI|init.*start|init.*complete', re.I)
PAT_DLC = re.compile(r'\[DLC\]|dlc|textpool', re.I)
PAT_GENERIC = re.compile(r'generic.?return|GENERIC_RETURN|0xe00fe000', re.I)
PAT_NULL_PTR = re.compile(r'NULL.*function|null.*ptr|0x0000|NULL pointer', re.I)
PAT_MALLOC = re.compile(r'malloc|free|alloc|heap', re.I)
PAT_GL = re.compile(r'\[GL\]|WebGL|shader|texture', re.I)
PAT_SOCKET = re.compile(r'socket\(\)|connect\(\)|send\(\)|recv', re.I)
PAT_ARM_INSN = re.compile(r'(\d[\d,]+)\s*(?:ARM\s+)?insn', re.I)
PAT_SHIM = re.compile(r'\[SHIM\]|shim call|shimmed|calling shim', re.I)
PAT_FILE_STRUCT = re.compile(r'FILE.*struct|_syncFile|_filePtrToFd|bionic|_bf\._base', re.I)
PAT_TIMEOUT = re.compile(r'timeout|timed out|TIMEOUT', re.I)
PAT_EXCEPTION = re.compile(r'exception|Exception|throw|CRASH', re.I)

line_count = 0
first_error_lines = []
last_lines = []

try:
    with open(CONSOLE_LOG, 'r', errors='replace') as f:
        for line in f:
            line_count += 1
            l = line.rstrip()

            # Keep last 20 lines
            last_lines.append(l)
            if len(last_lines) > 20:
                last_lines.pop(0)

            if PAT_ERROR.search(l):
                errors.append((line_count, l[:200]))
                if len(first_error_lines) < 30:
                    first_error_lines.append((line_count, l[:300]))

            if PAT_WARN.search(l):
                warnings.append((line_count, l[:200]))

            if PAT_CLOSEAPP.search(l):
                closeapp_count += 1

            if PAT_QEMU.search(l):
                qemu_assertions.append((line_count, l[:300]))

            if PAT_UNMAPPED.search(l):
                mem_unmapped.append((line_count, l[:200]))

            if PAT_VFS_MISS.search(l):
                vfs_misses.append((line_count, l[:200]))

            if 'fopen' in l.lower():
                fopen_events.append((line_count, l[:200]))

            if PAT_PTHREAD.search(l):
                pthread_events.append((line_count, l[:200]))

            if PAT_NET.search(l) or PAT_SOCKET.search(l):
                net_events.append((line_count, l[:200]))

            if PAT_GENERIC.search(l):
                generic_return_calls.append((line_count, l[:200]))

            if PAT_NULL_PTR.search(l):
                null_ptr_events.append((line_count, l[:200]))

            if PAT_RENDER.search(l):
                render_frames += 1

            if PAT_INIT.search(l):
                init_steps.append((line_count, l[:200]))

            if PAT_DLC.search(l) and len(dlc_events) < 50:
                dlc_events.append((line_count, l[:200]))

            if PAT_FILE_STRUCT.search(l):
                file_struct_events.append((line_count, l[:200]))

            if PAT_GL.search(l) and len(gl_events) < 30:
                gl_events.append((line_count, l[:200]))

            if PAT_TIMEOUT.search(l):
                timeouts.append((line_count, l[:200]))

            if PAT_EXCEPTION.search(l):
                exception_events.append((line_count, l[:200]))

            if 'mem_map' in l.lower():
                mem_maps.append((line_count, l[:200]))
                if 'error' in l.lower() or 'fail' in l.lower() or 'overlap' in l.lower():
                    mem_map_errors.append((line_count, l[:200]))

            m = PAT_ARM_INSN.search(l)
            if m:
                try:
                    count = int(m.group(1).replace(',', ''))
                    arm_insn_counts.append(count)
                except:
                    pass

except Exception as e:
    print(f"Error reading console log: {e}")

print(f"\nTotal lines: {line_count:,}")
print(f"Errors: {len(errors)}")
print(f"Warnings: {len(warnings)}")
print(f"closeApp calls: {closeapp_count}")
print(f"QEMU assertions: {len(qemu_assertions)}")
print(f"Unmapped accesses: {len(mem_unmapped)}")
print(f"mem_map calls: {len(mem_maps)}")
print(f"mem_map errors: {len(mem_map_errors)}")
print(f"VFS misses: {len(vfs_misses)}")
print(f"fopen events: {len(fopen_events)}")
print(f"FILE struct events: {len(file_struct_events)}")
print(f"pthread events: {len(pthread_events)}")
print(f"Network events: {len(net_events)}")
print(f"Socket events: {len([e for e in net_events if 'socket' in e[1].lower()])}")
print(f"Generic return calls: {len(generic_return_calls)}")
print(f"NULL ptr events: {len(null_ptr_events)}")
print(f"Render-related lines: {render_frames}")
print(f"GL events: {len(gl_events)}")
print(f"DLC events: {len(dlc_events)}")
print(f"Timeout events: {len(timeouts)}")
print(f"Exception events: {len(exception_events)}")
if arm_insn_counts:
    print(f"ARM instruction counts seen: max={max(arm_insn_counts):,}, total entries={len(arm_insn_counts)}")

# ============================================================
# QEMU ASSERTIONS — THE KEY QUESTION
# ============================================================
print("\n" + "=" * 80)
print("## QEMU ASSERTIONS (did v29 fix the section overflow?)")
if qemu_assertions:
    print(f"⚠ STILL {len(qemu_assertions)} QEMU assertion(s)!")
    for ln, text in qemu_assertions[:10]:
        print(f"  L{ln}: {text}")
else:
    print("✅ NO QEMU assertions found — v29 fix worked!")

# ============================================================
# MEM_MAP ERRORS
# ============================================================
print("\n## MEM_MAP ERRORS")
if mem_map_errors:
    print(f"⚠ {len(mem_map_errors)} mem_map error(s):")
    for ln, text in mem_map_errors[:10]:
        print(f"  L{ln}: {text}")
else:
    print("✅ No mem_map errors")

# ============================================================
# UNMAPPED MEMORY ACCESSES
# ============================================================
print("\n## UNMAPPED MEMORY ACCESSES")
if mem_unmapped:
    print(f"Total: {len(mem_unmapped)}")
    # Categorize by address range
    addr_ranges = Counter()
    for ln, text in mem_unmapped:
        m = re.search(r'0x([0-9a-f]+)', text, re.I)
        if m:
            addr = int(m.group(1), 16)
            range_key = f"0x{(addr >> 24):02X}xxxxxx"
            addr_ranges[range_key] += 1
    print("  By address range:")
    for rng, cnt in addr_ranges.most_common(10):
        print(f"    {rng}: {cnt}")
    print("  First 10:")
    for ln, text in mem_unmapped[:10]:
        print(f"    L{ln}: {text}")
    if len(mem_unmapped) > 10:
        print("  Last 5:")
        for ln, text in mem_unmapped[-5:]:
            print(f"    L{ln}: {text}")
else:
    print("✅ No unmapped memory accesses")

# ============================================================
# ERRORS (first 30)
# ============================================================
print("\n## FIRST 30 ERRORS")
for ln, text in first_error_lines[:30]:
    print(f"  L{ln}: {text}")

# ============================================================
# CLOSEAPP
# ============================================================
print(f"\n## CLOSEAPP: {closeapp_count} calls")
if closeapp_count > 0:
    print("  Game is still calling closeApp — singleton fields still not populated?")

# ============================================================
# VFS MISSES
# ============================================================
print("\n## VFS MISSES (files not found)")
if vfs_misses:
    # Deduplicate
    unique_misses = set()
    for ln, text in vfs_misses:
        unique_misses.add(text.strip())
    print(f"  {len(unique_misses)} unique misses:")
    for m in sorted(unique_misses)[:20]:
        print(f"    {m[:150]}")
else:
    print("  None")

# ============================================================
# FOPEN EVENTS
# ============================================================
print("\n## FOPEN EVENTS")
if fopen_events:
    print(f"  {len(fopen_events)} fopen calls:")
    for ln, text in fopen_events[:20]:
        print(f"    L{ln}: {text}")
else:
    print("  None")

# ============================================================
# FILE STRUCT EVENTS
# ============================================================
print("\n## FILE STRUCT / BIONIC EVENTS")
if file_struct_events:
    print(f"  {len(file_struct_events)} events:")
    for ln, text in file_struct_events[:15]:
        print(f"    L{ln}: {text}")
else:
    print("  None")

# ============================================================
# PTHREAD / THREADS
# ============================================================
print("\n## PTHREAD / THREAD EVENTS")
if pthread_events:
    creates = [e for e in pthread_events if 'create' in e[1].lower()]
    joins = [e for e in pthread_events if 'join' in e[1].lower()]
    execs = [e for e in pthread_events if 'execut' in e[1].lower()]
    once = [e for e in pthread_events if 'once' in e[1].lower()]
    print(f"  Total: {len(pthread_events)}, creates: {len(creates)}, joins: {len(joins)}, executions: {len(execs)}, once: {len(once)}")
    for ln, text in creates[:10]:
        print(f"    CREATE L{ln}: {text}")
    for ln, text in execs[:10]:
        print(f"    EXEC L{ln}: {text}")
else:
    print("  None — no thread activity")

# ============================================================
# NETWORK / SOCKET EVENTS
# ============================================================
print("\n## NETWORK / SOCKET EVENTS")
if net_events:
    sockets = [e for e in net_events if 'socket' in e[1].lower()]
    connects = [e for e in net_events if 'connect' in e[1].lower()]
    print(f"  Total: {len(net_events)}, sockets: {len(sockets)}, connects: {len(connects)}")
    for ln, text in net_events[:15]:
        print(f"    L{ln}: {text}")
else:
    print("  None — game never reached networking code")

# ============================================================
# GENERIC RETURN CALLS
# ============================================================
print("\n## GENERIC RETURN STUB CALLS (unresolved functions)")
if generic_return_calls:
    print(f"  {len(generic_return_calls)} calls:")
    for ln, text in generic_return_calls[:15]:
        print(f"    L{ln}: {text}")
else:
    print("  None")

# ============================================================
# NULL POINTER EVENTS
# ============================================================
print("\n## NULL POINTER EVENTS")
if null_ptr_events:
    print(f"  {len(null_ptr_events)} events:")
    for ln, text in null_ptr_events[:10]:
        print(f"    L{ln}: {text}")
else:
    print("  None")

# ============================================================
# GL EVENTS
# ============================================================
print("\n## GL / WEBGL EVENTS")
for ln, text in gl_events[:15]:
    print(f"  L{ln}: {text}")

# ============================================================
# INIT STEPS
# ============================================================
print("\n## INIT STEPS")
for ln, text in init_steps[:30]:
    print(f"  L{ln}: {text}")

# ============================================================
# TIMEOUTS
# ============================================================
print("\n## TIMEOUTS")
if timeouts:
    for ln, text in timeouts[:10]:
        print(f"  L{ln}: {text}")
else:
    print("  None")

# ============================================================
# EXCEPTIONS
# ============================================================
print("\n## EXCEPTIONS / CRASHES")
if exception_events:
    print(f"  {len(exception_events)} events:")
    for ln, text in exception_events[:15]:
        print(f"    L{ln}: {text}")
else:
    print("  None")

# ============================================================
# LAST 20 LINES
# ============================================================
print("\n## LAST 20 LINES OF CONSOLE")
for l in last_lines:
    print(f"  {l[:200]}")

# ============================================================
# RAW LOGS ANALYSIS (mobile logs)
# ============================================================
print("\n" + "=" * 80)
print("## RAW LOG ANALYSIS (tsto-raw-logs)")
raw_lines = read_file(RAW_LOG)
if raw_lines:
    print(f"  {len(raw_lines)} lines")

    raw_errors = []
    raw_qemu = []
    raw_closeapp = 0
    raw_unmapped = []
    raw_net = []
    raw_threads = []
    raw_vfs_miss = []
    raw_mem_map_err = []

    for i, line in enumerate(raw_lines):
        l = line.rstrip()
        if PAT_ERROR.search(l):
            raw_errors.append((i+1, l[:200]))
        if PAT_QEMU.search(l):
            raw_qemu.append((i+1, l[:300]))
        if PAT_CLOSEAPP.search(l):
            raw_closeapp += 1
        if PAT_UNMAPPED.search(l):
            raw_unmapped.append((i+1, l[:200]))
        if PAT_NET.search(l) or PAT_SOCKET.search(l):
            raw_net.append((i+1, l[:200]))
        if PAT_PTHREAD.search(l) and ('create' in l.lower() or 'execut' in l.lower()):
            raw_threads.append((i+1, l[:200]))
        if PAT_VFS_MISS.search(l):
            raw_vfs_miss.append((i+1, l[:200]))
        if 'mem_map' in l.lower() and ('error' in l.lower() or 'fail' in l.lower()):
            raw_mem_map_err.append((i+1, l[:200]))

    print(f"  Errors: {len(raw_errors)}")
    print(f"  QEMU assertions: {len(raw_qemu)}")
    print(f"  closeApp: {raw_closeapp}")
    print(f"  Unmapped: {len(raw_unmapped)}")
    print(f"  Network: {len(raw_net)}")
    print(f"  Threads: {len(raw_threads)}")
    print(f"  VFS misses: {len(raw_vfs_miss)}")
    print(f"  mem_map errors: {len(raw_mem_map_err)}")

    if raw_qemu:
        print("\n  QEMU ASSERTIONS in raw log:")
        for ln, text in raw_qemu[:5]:
            print(f"    L{ln}: {text}")

    if raw_errors:
        print("\n  First 20 errors in raw log:")
        for ln, text in raw_errors[:20]:
            print(f"    L{ln}: {text}")

    if raw_net:
        print("\n  Network events in raw log:")
        for ln, text in raw_net[:10]:
            print(f"    L{ln}: {text}")

    if raw_threads:
        print("\n  Thread events in raw log:")
        for ln, text in raw_threads[:10]:
            print(f"    L{ln}: {text}")

    if raw_vfs_miss:
        print("\n  VFS misses in raw log:")
        unique = set(t for _, t in raw_vfs_miss)
        for t in sorted(unique)[:15]:
            print(f"    {t[:150]}")

    if raw_mem_map_err:
        print("\n  mem_map errors in raw log:")
        for ln, text in raw_mem_map_err[:5]:
            print(f"    L{ln}: {text}")

    # Last 30 lines of raw log
    print("\n  Last 30 lines of raw log:")
    for l in raw_lines[-30:]:
        print(f"    {l.rstrip()[:200]}")
else:
    print("  No raw log found")

# ============================================================
# ARM TRACE
# ============================================================
print("\n" + "=" * 80)
print("## ARM TRACE")
trace_lines = read_file(ARM_TRACE)
if trace_lines:
    print(f"  {len(trace_lines)} lines")
    for l in trace_lines[:30]:
        print(f"  {l.rstrip()[:200]}")
else:
    print("  No trace")

# ============================================================
# CAPTURED LOGS (JSON)
# ============================================================
print("\n" + "=" * 80)
print("## CAPTURED LOGS JSON")
captured = read_json(CAPTURED)
if captured:
    if isinstance(captured, list):
        print(f"  {len(captured)} entries")
        # Find unique message types
        types = Counter()
        levels = Counter()
        for entry in captured:
            if isinstance(entry, dict):
                types[entry.get('type', 'unknown')] += 1
                levels[entry.get('level', 'unknown')] += 1
        print(f"  Types: {dict(types.most_common(10))}")
        print(f"  Levels: {dict(levels.most_common(10))}")
    elif isinstance(captured, dict):
        print(f"  Keys: {list(captured.keys())[:20]}")
else:
    print("  Could not parse captured logs JSON")

# ============================================================
# SUMMARY & PRIORITIES
# ============================================================
print("\n" + "=" * 80)
print("## DIAGNOSIS SUMMARY")
print("=" * 80)

issues = []

if qemu_assertions:
    issues.append(("P0-CRITICAL", f"QEMU assertion STILL fires ({len(qemu_assertions)}x) — v29 fix insufficient"))
else:
    issues.append(("OK", "QEMU section overflow FIXED by v29"))

if mem_map_errors:
    issues.append(("P1-HIGH", f"mem_map errors persist ({len(mem_map_errors)}x)"))
else:
    issues.append(("OK", "No mem_map errors"))

if closeapp_count > 0:
    issues.append(("P1-HIGH", f"closeApp still called {closeapp_count}x — game still stuck"))
elif closeapp_count == 0:
    issues.append(("OK", "No closeApp calls — game may be progressing!"))

if len(mem_unmapped) > 20:
    issues.append(("P2-MEDIUM", f"Unmapped accesses: {len(mem_unmapped)} — some regions still not mapped"))

if len(net_events) == 0:
    issues.append(("P2-MEDIUM", "Zero network activity — game never reached networking"))
else:
    issues.append(("OK", f"Network activity detected: {len(net_events)} events"))

creates = [e for e in pthread_events if 'create' in e[1].lower()]
if len(creates) == 0:
    issues.append(("P2-MEDIUM", "Zero threads created"))
else:
    issues.append(("OK", f"Threads created: {len(creates)}"))

if null_ptr_events:
    issues.append(("P3-LOW", f"NULL pointer dereferences: {len(null_ptr_events)}"))

if vfs_misses:
    issues.append(("P3-LOW", f"VFS file misses: {len(vfs_misses)}"))

if generic_return_calls:
    issues.append(("P3-LOW", f"Generic return stub hit {len(generic_return_calls)}x (unresolved functions)"))

print()
for severity, msg in issues:
    icon = "✅" if severity == "OK" else "❌"
    print(f"  {icon} [{severity}] {msg}")

print("\n" + "=" * 80)
print("ANALYSIS COMPLETE")
print("=" * 80)
