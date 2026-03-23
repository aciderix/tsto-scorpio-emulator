#!/usr/bin/env node
/**
 * TSTO Emulator CLI Controller
 * 
 * Pilots the web emulator via headless Chrome (Puppeteer).
 * All logs come from Puppeteer console capture + DOM scraping.
 * 
 * Usage:
 *   node scripts/cli.js test              # Full test: init → start → wait → dump logs
 *   node scripts/cli.js logs              # Init + start + dump all logs
 *   node scripts/cli.js logs --wait=30    # Wait 30s before dumping
 *   node scripts/cli.js screenshot        # Take a screenshot
 *   node scripts/cli.js fopen-misses      # Show fopen MISS entries
 *   node scripts/cli.js dlc-status        # Show DLC loader status
 *   node scripts/cli.js eval "JS_CODE"    # Evaluate arbitrary JS in page
 * 
 * Options:
 *   --url=URL          Override site URL
 *   --wait=SECONDS     Wait time after start (default: 20)
 *   --output=FILE      Save output to file
 *   --screenshot=FILE  Screenshot filename (default: screenshot.png)
 *   --no-headless      Show browser window
 *   --verbose          Progress messages on stderr
 * 
 * Environment:
 *   PUPPETEER_EXECUTABLE_PATH    Override Chrome/Chromium path
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// ── Parse args ──────────────────────────────────────────
const args = process.argv.slice(2);
const command = args.find(a => !a.startsWith('--')) || 'test';
const opts = {};
args.filter(a => a.startsWith('--')).forEach(a => {
    const eq = a.indexOf('=');
    if (eq > -1) opts[a.slice(2, eq)] = a.slice(eq + 1);
    else opts[a.slice(2)] = true;
});

const SITE_URL = opts.url || 'https://tsto-scorpio-emulator.netlify.app';
const WAIT_SECONDS = parseInt(opts.wait || '20', 10);
const HEADLESS = !opts['no-headless'];
const VERBOSE = !!opts.verbose;
const OUTPUT_FILE = opts.output || null;
const SCREENSHOT_FILE = opts.screenshot || 'screenshot.png';

// ── Helpers ─────────────────────────────────────────────
function log(...msg) {
    if (VERBOSE) process.stderr.write('[cli] ' + msg.join(' ') + '\n');
}
function output(text) {
    if (OUTPUT_FILE) {
        fs.writeFileSync(OUTPUT_FILE, text, 'utf-8');
        log(`Output saved to ${OUTPUT_FILE}`);
    } else {
        process.stdout.write(text);
    }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Console log accumulator ─────────────────────────────
// All logs come from Puppeteer's console listener — NOT window._capturedLogs
let consoleLogs = [];

function logsContain(pattern) {
    return consoleLogs.some(e => e.text.includes(pattern));
}
function logsFind(pattern) {
    return consoleLogs.filter(e => e.text.includes(pattern));
}

// ── Browser ─────────────────────────────────────────────
async function launchBrowser() {
    log('Launching browser...');
    const launchOpts = {
        headless: HEADLESS ? 'new' : false,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-web-security',
            '--use-gl=swiftshader',
            '--enable-webgl',
        ]
    };
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    const browser = await puppeteer.launch(launchOpts);
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // Capture ALL console output
    page.on('console', msg => {
        consoleLogs.push({
            time: new Date().toISOString(),
            type: msg.type().toUpperCase(),
            text: msg.text()
        });
    });
    page.on('pageerror', err => {
        consoleLogs.push({
            time: new Date().toISOString(),
            type: 'PAGEERROR',
            text: err.message
        });
    });

    return { browser, page };
}

// ── Wait for condition in console logs ──────────────────
async function waitForLog(pattern, timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (logsContain(pattern)) return true;
        await sleep(500);
    }
    return false;
}

// ── Navigate & wait for WASM ready ──────────────────────
async function navigateAndWaitReady(page) {
    log(`Navigating to ${SITE_URL}...`);
    await page.goto(SITE_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    log('Page loaded');

    // Wait for Unicorn WASM + libscorpio.so to be loaded
    log('Waiting for WASM + ELF to load...');
    const ready = await waitForLog('ELF binary ready', 30000) ||
                  await waitForLog('Engine ready', 10000);
    
    if (logsContain('ELF binary ready')) {
        log('✅ ELF binary ready');
    } else {
        // Check what we got
        const lastLogs = consoleLogs.slice(-5).map(e => e.text).join(' | ');
        log(`⚠️ ELF not confirmed ready. Last logs: ${lastLogs}`);
    }
    
    await sleep(1000); // Extra settle time
}

// ── Click Initialize Engine ─────────────────────────────
async function clickInit(page) {
    log('Clicking "Initialize Engine"...');
    
    const clicked = await page.evaluate(() => {
        let btn = document.getElementById('initBtn');
        if (!btn) {
            btn = Array.from(document.querySelectorAll('button'))
                .find(b => b.textContent.includes('Init'));
        }
        if (btn && !btn.disabled) { btn.click(); return btn.textContent.trim(); }
        return null;
    });
    
    if (!clicked) throw new Error('Init button not found or disabled');
    log(`Clicked: "${clicked}"`);
    
    // Wait for engine initialization (look for JNI functions or relocations)
    log('Waiting for engine init...');
    const initialized = await waitForLog('JNI Functions', 30000) ||
                        await waitForLog('Relocations', 30000);
    
    if (logsContain('JNI Functions')) {
        const jniLog = logsFind('JNI Functions')[0];
        log(`✅ ${jniLog.text.substring(0, 80)}`);
    } else if (logsContain('FATAL')) {
        const fatal = logsFind('FATAL')[0];
        throw new Error(`Init failed: ${fatal.text}`);
    } else {
        log('⚠️ Init completion unclear — continuing anyway');
    }
    
    // Extra wait for post-init setup (DLC loader etc.)
    await sleep(3000);
}

// ── Click Start Game Loop ───────────────────────────────
async function clickStart(page) {
    log('Clicking "Start Game Loop"...');
    
    const clicked = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const btn = btns.find(b => b.textContent.includes('Start Game'));
        if (btn && !btn.disabled) { btn.click(); return btn.textContent.trim(); }
        // Fallback: any button with "Start"
        const btn2 = btns.find(b => b.textContent.includes('Start'));
        if (btn2 && !btn2.disabled) { btn2.click(); return btn2.textContent.trim(); }
        return null;
    });
    
    if (!clicked) throw new Error('Start button not found or disabled');
    log(`Clicked: "${clicked}"`);
}

// ── Wait for frames ─────────────────────────────────────
async function waitForFrames(page, seconds) {
    log(`Waiting ${seconds}s for game loop...`);
    
    // Report progress every 5s
    const chunks = Math.ceil(seconds / 5);
    for (let i = 0; i < chunks; i++) {
        const wait = Math.min(5, seconds - i * 5);
        await sleep(wait * 1000);
        log(`  ${(i + 1) * 5}s — ${consoleLogs.length} logs captured`);
    }
}

// ── Scrape DOM logs (alternative source) ────────────────
async function scrapeDomLogs(page) {
    return page.evaluate(() => {
        const entries = document.querySelectorAll('.log-info, .log-gl, .log-warn, .log-error, .log-jni, .log-vfs, [class^="log-"]');
        return Array.from(entries).map(el => el.textContent.trim());
    });
}

// ── Get status from page ────────────────────────────────
async function getPageStatus(page) {
    return page.evaluate(() => {
        const el = document.getElementById('statusDisplay') || 
                   document.querySelector('.status') ||
                   document.querySelector('[id*="status"]');
        return el ? el.innerText : 'N/A';
    });
}

// ── Format logs for output ──────────────────────────────
function formatConsoleLogs(filter = null) {
    let logs = consoleLogs;
    if (filter) logs = logs.filter(e => e.text.includes(filter));
    return logs.map(e => `${e.time} [${e.type}] ${e.text}`).join('\n');
}

// ── Take screenshot ─────────────────────────────────────
async function takeScreenshot(page, filepath) {
    log(`Screenshot → ${filepath}`);
    
    // Canvas screenshot
    const canvasData = await page.evaluate(() => {
        const c = document.querySelector('canvas');
        return c ? c.toDataURL('image/png') : null;
    });
    if (canvasData) {
        const buf = Buffer.from(canvasData.replace(/^data:image\/png;base64,/, ''), 'base64');
        const canvasFile = filepath.replace('.png', '-canvas.png');
        fs.writeFileSync(canvasFile, buf);
        log(`Canvas saved: ${canvasFile} (${buf.length} bytes)`);
    }
    
    // Full page
    await page.screenshot({ path: filepath, fullPage: true });
    log(`Full page saved: ${filepath}`);
}

// ── Compute summary stats ───────────────────────────────
function summary() {
    const total = consoleLogs.length;
    const errors = consoleLogs.filter(e => e.type === 'ERROR' || e.type === 'PAGEERROR' || (e.type === 'LOG' && e.text.includes('[ERR]'))).length;
    const fopenMisses = consoleLogs.filter(e => e.text.includes('fopen') && e.text.includes('MISS'));
    const dlcLogs = consoleLogs.filter(e => e.text.includes('[DLC]'));
    const glLogs = consoleLogs.filter(e => e.text.includes('[GL]') || e.text.includes('glClear') || e.text.includes('WebGL'));
    const jniLogs = consoleLogs.filter(e => e.text.includes('[JNI]'));
    
    let s = '\n═══════════════════════════════════════\n';
    s += `  Total logs:     ${total}\n`;
    s += `  Errors:         ${errors}\n`;
    s += `  fopen MISS:     ${fopenMisses.length}\n`;
    s += `  DLC logs:       ${dlcLogs.length}\n`;
    s += `  JNI logs:       ${jniLogs.length}\n`;
    s += `  GL logs:        ${glLogs.length}\n`;
    s += '═══════════════════════════════════════\n';
    
    if (fopenMisses.length > 0) {
        s += '\nfopen MISS paths:\n';
        fopenMisses.forEach(e => { s += `  ${e.text}\n`; });
    }
    
    return s;
}

// ── Full test flow ──────────────────────────────────────
async function runTest(page) {
    await clickInit(page);
    await clickStart(page);
    await waitForFrames(page, WAIT_SECONDS);
    
    // Grab DOM logs too
    const domLogs = await scrapeDomLogs(page);
    const status = await getPageStatus(page);
    
    await takeScreenshot(page, SCREENSHOT_FILE);
    
    // Output: console logs + DOM logs + summary
    let out = '=== CONSOLE LOGS ===\n';
    out += formatConsoleLogs() + '\n\n';
    
    if (domLogs.length > 0) {
        out += '=== DOM LOGS ===\n';
        out += domLogs.join('\n') + '\n\n';
    }
    
    out += `=== PAGE STATUS ===\n${status}\n`;
    out += summary();
    
    return out;
}

// ════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════
async function main() {
    const { browser, page } = await launchBrowser();
    
    try {
        await navigateAndWaitReady(page);
        
        switch (command) {
            case 'test': {
                const result = await runTest(page);
                output(result);
                process.stderr.write(summary());
                break;
            }
            case 'logs': {
                await clickInit(page);
                await clickStart(page);
                await waitForFrames(page, WAIT_SECONDS);
                output(formatConsoleLogs() + '\n');
                process.stderr.write(summary());
                break;
            }
            case 'screenshot': {
                await clickInit(page);
                await clickStart(page);
                await waitForFrames(page, WAIT_SECONDS);
                await takeScreenshot(page, SCREENSHOT_FILE);
                output(`Screenshots saved: ${SCREENSHOT_FILE}\n`);
                break;
            }
            case 'fopen-misses': {
                await clickInit(page);
                await clickStart(page);
                await waitForFrames(page, WAIT_SECONDS);
                const misses = formatConsoleLogs('fopen');
                output(misses || 'No fopen entries found\n');
                process.stderr.write(summary());
                break;
            }
            case 'dlc-status': {
                await clickInit(page);
                await clickStart(page);
                await waitForFrames(page, WAIT_SECONDS);
                const dlc = formatConsoleLogs('DLC');
                output(dlc || 'No DLC log entries found\n');
                break;
            }
            case 'vfs-stats': {
                await clickInit(page);
                await clickStart(page);
                await waitForFrames(page, WAIT_SECONDS);
                const vfs = formatConsoleLogs('VFS');
                output(vfs || 'No VFS log entries found\n');
                break;
            }
            case 'eval': {
                const code = args.find(a => !a.startsWith('--') && a !== 'eval');
                if (!code) {
                    process.stderr.write('Usage: cli.js eval "document.title"\n');
                    process.exit(1);
                }
                await clickInit(page);
                const result = await page.evaluate(code);
                output(JSON.stringify(result, null, 2) + '\n');
                break;
            }
            default:
                process.stderr.write(`Unknown command: ${command}\n`);
                process.stderr.write('Commands: test, logs, screenshot, fopen-misses, dlc-status, vfs-stats, eval\n');
                process.exit(1);
        }
    } catch (err) {
        process.stderr.write(`\n❌ ERROR: ${err.message}\n`);
        if (consoleLogs.length > 0) {
            process.stderr.write(`\nCaptured ${consoleLogs.length} logs before failure:\n`);
            const last10 = consoleLogs.slice(-10).map(e => `  ${e.text}`).join('\n');
            process.stderr.write(last10 + '\n');
        }
        // Dump all logs to file on error
        const errLog = formatConsoleLogs();
        fs.writeFileSync('error-logs.txt', errLog, 'utf-8');
        process.stderr.write('Full logs saved to error-logs.txt\n');
        process.exit(1);
    } finally {
        await browser.close();
    }
}

main();
