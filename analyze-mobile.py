#!/usr/bin/env python3
"""
TSTO v29d Mobile Log Analyzer — Compact comprehensive diagnostic
Analyzes tsto-raw-logs and tsto-report from mobile session.
"""

import re
import os
from collections import Counter

RAW_LOG = "logs/tsto-raw-logs-2026-03-27T15-34-33.898Z.txt"
REPORT = "logs/tsto-report-2026-03-27T15-34-33.389Z.txt"

print("=" * 80)
print("TSTO v29d MOBILE LOG ANALYSIS")
print("=" * 80)

# Report first
if os.path.exists(REPORT):
    with open(REPORT, 'r', errors='replace') as f:
        print(f.read()[:5000])

# Analyze raw log
print("\n" + "=" * 80)
print("RAW LOG DEEP SCAN")
print("=" * 80)

counters = {
    'closeApp': 0, 'errors': [], 'warnings_sample': [],
    'qemu': [], 'unmapped': [], 'vfs_miss': [],
    'fopen': [], 'pthread_create': [], 'pthread_exec': [],
    'net_socket': [], 'net_connect': [], 'null_ptr': [],
    'generic_return': [], 'spin': [], 'mem_map_err': [],
    'init_steps': [], 'shim_calls': Counter(),
    'fread': [], 'fwrite': [], 'fseek': [],
    'dialog': [], 'crash': [], 'timeout': [],
    'singleton': [], 'dlsym': [], 'mmap': [],
}

total_lines = 0
last_30 = []

with open(RAW_LOG, 'r', errors='replace') as f:
    for line in f:
        total_lines += 1
        l = line.rstrip()

        last_30.append(l)
        if len(last_30) > 30: last_30.pop(0)

        if 'closeApp' in l:
            counters['closeApp'] += 1

        if any(x in l for x in ['ERROR', '❌', 'FATAL', 'ASSERTION', 'assertion']):
            if len(counters['errors']) < 50: counters['errors'].append((total_lines, l[:250]))

        if any(x in l for x in ['QEMU', 'qemu', 'phys_section', 'assertion.*fail']):
            counters['qemu'].append((total_lines, l[:300]))

        if 'unmapped' in l.lower() or 'UNMAPPED' in l:
            if len(counters['unmapped']) < 30: counters['unmapped'].append((total_lines, l[:200]))

        if 'fopen MISS' in l or 'file not found' in l.lower():
            counters['vfs_miss'].append((total_lines, l[:200]))

        if '[fopen]' in l:
            if len(counters['fopen']) < 30: counters['fopen'].append((total_lines, l[:200]))

        if 'pthread_create' in l:
            counters['pthread_create'].append((total_lines, l[:200]))

        if 'Executing thread' in l:
            counters['pthread_exec'].append((total_lines, l[:200]))

        if 'socket()' in l:
            counters['net_socket'].append((total_lines, l[:200]))

        if 'connect()' in l and '[NET]' in l:
            counters['net_connect'].append((total_lines, l[:200]))

        if 'NULL function ptr' in l or 'NULL pointer' in l:
            counters['null_ptr'].append((total_lines, l[:200]))

        if 'GENERIC_RETURN' in l or 'generic return' in l.lower():
            if len(counters['generic_return']) < 20: counters['generic_return'].append((total_lines, l[:200]))

        if 'SPIN' in l:
            counters['spin'].append((total_lines, l[:300]))

        if 'mem_map' in l and ('error' in l.lower() or 'fail' in l.lower()):
            counters['mem_map_err'].append((total_lines, l[:200]))

        if 'Step ' in l and '/9' in l or '/11' in l or '/8' in l:
            counters['init_steps'].append((total_lines, l[:200]))

        m = re.search(r'SHIM:(\w+)', l)
        if m: counters['shim_calls'][m.group(1)] += 1

        if '[fread]' in l:
            if len(counters['fread']) < 20: counters['fread'].append((total_lines, l[:200]))

        if '[fwrite]' in l or 'fwrite' in l.lower():
            if len(counters['fwrite']) < 10: counters['fwrite'].append((total_lines, l[:200]))

        if 'showDialog' in l:
            counters['dialog'].append((total_lines, l[:200]))

        if 'singleton' in l.lower() and ('+0x' in l or 'field' in l.lower()):
            if len(counters['singleton']) < 20: counters['singleton'].append((total_lines, l[:200]))

        if 'ScorpioJNI_init' in l and 'instructions' in l:
            counters['init_steps'].append((total_lines, l[:300]))

        if 'LifecycleStart' in l and 'instructions' in l:
            counters['init_steps'].append((total_lines, l[:300]))

        if 'dlsym' in l.lower():
            if len(counters['dlsym']) < 10: counters['dlsym'].append((total_lines, l[:200]))

        if 'mmap' in l and 'shim' not in l.lower():
            if len(counters['mmap']) < 10: counters['mmap'].append((total_lines, l[:200]))

print(f"\nTotal lines: {total_lines:,}")
print(f"closeApp calls: {counters['closeApp']}")

# CRITICAL CHECKS
print("\n--- QEMU ASSERTIONS ---")
if counters['qemu']:
    print(f"⚠ {len(counters['qemu'])} QEMU issues!")
    for ln, t in counters['qemu'][:5]: print(f"  L{ln}: {t}")
else:
    print("✅ None")

print("\n--- MEM_MAP ERRORS ---")
if counters['mem_map_err']:
    for ln, t in counters['mem_map_err'][:5]: print(f"  L{ln}: {t}")
else:
    print("✅ None")

print("\n--- SPIN DETECTION ---")
if counters['spin']:
    for ln, t in counters['spin'][:10]: print(f"  L{ln}: {t}")
else:
    print("✅ No spin detected")

print("\n--- INIT STEPS ---")
for ln, t in counters['init_steps'][:20]: print(f"  L{ln}: {t}")

print("\n--- ERRORS ---")
if counters['errors']:
    print(f"Total: {len(counters['errors'])}")
    for ln, t in counters['errors'][:20]: print(f"  L{ln}: {t}")
else:
    print("✅ None")

print("\n--- UNMAPPED ACCESSES ---")
if counters['unmapped']:
    print(f"Total: {len(counters['unmapped'])}")
    for ln, t in counters['unmapped'][:10]: print(f"  L{ln}: {t}")
else:
    print("✅ None")

print("\n--- NULL POINTERS ---")
if counters['null_ptr']:
    for ln, t in counters['null_ptr'][:10]: print(f"  L{ln}: {t}")
else:
    print("✅ None")

print("\n--- FOPEN ---")
for ln, t in counters['fopen'][:20]: print(f"  L{ln}: {t}")

print("\n--- VFS MISSES ---")
if counters['vfs_miss']:
    unique = set(t for _, t in counters['vfs_miss'])
    print(f"Total: {len(counters['vfs_miss'])}, unique: {len(unique)}")
    for t in sorted(unique)[:10]: print(f"  {t[:150]}")
else:
    print("✅ None")

print("\n--- FREAD ---")
for ln, t in counters['fread'][:10]: print(f"  L{ln}: {t}")

print("\n--- THREADS ---")
print(f"pthread_create: {len(counters['pthread_create'])}")
for ln, t in counters['pthread_create'][:5]: print(f"  L{ln}: {t}")
print(f"Thread executions: {len(counters['pthread_exec'])}")
for ln, t in counters['pthread_exec'][:5]: print(f"  L{ln}: {t}")

print("\n--- NETWORK ---")
print(f"socket(): {len(counters['net_socket'])}")
for ln, t in counters['net_socket'][:5]: print(f"  L{ln}: {t}")
print(f"connect(): {len(counters['net_connect'])}")
for ln, t in counters['net_connect'][:5]: print(f"  L{ln}: {t}")

print("\n--- GENERIC RETURN (unresolved functions) ---")
for ln, t in counters['generic_return'][:10]: print(f"  L{ln}: {t}")

print("\n--- DIALOGS ---")
for ln, t in counters['dialog'][:5]: print(f"  L{ln}: {t}")

print("\n--- SINGLETON FIELDS ---")
for ln, t in counters['singleton'][:10]: print(f"  L{ln}: {t}")

print("\n--- TOP SHIM CALLS ---")
for name, cnt in counters['shim_calls'].most_common(20):
    print(f"  {name}: {cnt}")

print("\n--- LAST 30 LINES ---")
for l in last_30: print(f"  {l[:200]}")

# SUMMARY
print("\n" + "=" * 80)
print("SUMMARY")
print("=" * 80)
issues = []
if counters['qemu']: issues.append("P0: QEMU assertions still present")
if counters['mem_map_err']: issues.append("P0: mem_map errors")
if counters['spin']: issues.append("P1: SPIN detected — init stuck")
if counters['closeApp'] > 0: issues.append(f"P1: closeApp x{counters['closeApp']} — game stuck")
if not counters['pthread_create']: issues.append("P2: 0 threads created")
if not counters['net_socket']: issues.append("P2: 0 network sockets")
if counters['null_ptr']: issues.append(f"P3: {len(counters['null_ptr'])} NULL ptrs")
if counters['vfs_miss']: issues.append(f"P3: {len(counters['vfs_miss'])} VFS misses")

if not issues:
    print("✅ No critical issues found!")
else:
    for i in issues: print(f"  ❌ {i}")
