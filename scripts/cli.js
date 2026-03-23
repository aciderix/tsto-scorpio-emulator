#!/usr/bin/env node
/**
 * TSTO Emulator CLI Controller
 * 
 * Pilots the web emulator via headless Chrome (Puppeteer).
 * Designed for Claude Code or any terminal-only environment.
 * 
 * Usage:
 *   node scripts/cli.js test              # Full test: init → start → wait → dump logs
 *   node scripts/cli.js init              # Just initialize the engine
 *   node scripts/cli.js start             # Init + start game loop
 *   node scripts/cli.js logs              # Init + start + dump all logs
 *   node scripts/cli.js logs --wait=30    # Wait 30s before dumping logs
 *   node scripts/cli.js screenshot        # Take a screenshot of the canvas
 *   node scripts/cli.js fopen-misses      # Show only fopen MISS entries
 *   node scripts/cli.js dlc-status        # Show DLC loader status
 *   node scripts/cli.js vfs-stats         # Show VFS statistics
 *   node scripts/cli.js eval "JS_CODE"    # Evaluate arbitrary JS in page context
 * 
 * Options:
 *   --url=URL          Override site URL (default: https://tsto-scorpio-emulator.netlify.app)
 *   --wait=SECONDS     Wait time after start before collecting (default: 15)
 *   --output=FILE      Save output to file instead of stdout
 *   --screenshot=FILE  Save screenshot to file (default: screenshot.png)
 *   --no-headless      Show the browser window (for debugging)
 *   --verbose          Show progress messages on stderr
 * 
 * Prerequisites:
 *   npm install puppeteer
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// Parse arguments
const args = process.argv.slice(2);
const command = args.find(a => !a.startsWith('--')) || 'test';
const opts = {};
args.filter(a => a.startsWith('--')).forEach(a => {
    const [k, v] = a.slice(2).split('=');
    opts[k] = v === undefined ? true : v;
});

const SITE_URL = opts.url || 'https://tsto-scorpio-emulator.netlify.app';
const WAIT_SECONDS = parseInt(opts.wait || '15', 10);
const HEADLESS = !opts['no-headless'];
const VERBOSE = !!opts.verbose;
const OUTPUT_FILE = opts.output || null;
const SCREENSHOT_FILE = opts.screenshot || 'screenshot.png';

function log(...msg) {
    if (VERBOSE) process.stderr.write('[cli] ' + msg.join(' ') + '\n');
}

function output(text) {
    if (OUTPUT_FILE) {
        fs.writeFileSync(OUTPUT_FILE, text, 'utf-8');
        log(`Output written to ${OUTPUT_FILE}`);
    } else {
        process.stdout.write(text);
    }
}

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function launchBrowser() {
    log('Launching browser...');
    const browser = await puppeteer.launch({
        headless: HEADLESS ? 'new' : false,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-web-security',        // Avoid CORS issues
            '--disable-features=VizDisplayCompositor',
            '--use-gl=swiftshader',          // Software WebGL
            '--enable-webgl',
        ]
    });
    const page = await browser.newPage();
    
    // Capture console messages
    const consoleLogs = [];
    page.on('console', msg => {
        const entry = {
            time: new Date().toISOString(),
            level: msg.type().toUpperCase(),
            text: msg.text()
        };
        consoleLogs.push(entry);
        if (VERBOSE && entry.level === 'ERR') {
            process.stderr.write(`  [console.${entry.level}] ${entry.text}\n`);
        }
    });
    
    // Capture page errors
    page.on('pageerror', err => {
        consoleLogs.push({
            time: new Date().toISOString(),
            level: 'PAGEERROR',
            text: err.message
        });
    });
    
    return { browser, page, consoleLogs };
}

async function navigateToSite(page) {
    log(`Navigating to ${SITE_URL}...`);
    await page.goto(SITE_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    log('Page loaded');
    
    // Wait for the init button to be ready
    await page.waitForSelector('#initBtn, button', { timeout: 10000 }).catch(() => {});
    await sleep(1000);
}

async function clickInit(page) {
    log('Clicking Initialize Engine...');
    
    // Find and click the init button
    const clicked = await page.evaluate(() => {
        // Try by ID first
        let btn = document.getElementById('initBtn');
        if (!btn) {
            // Search by text content
            const buttons = Array.from(document.querySelectorAll('button'));
            btn = buttons.find(b => b.textContent.includes('Init'));
        }
        if (btn) {
            btn.click();
            return btn.textContent.trim();
        }
        return null;
    });
    
    if (!clicked) {
        throw new Error('Could not find Init button');
    }
    log(`Clicked: "${clicked}"`);
    
    // Wait for initialization to complete
    log('Waiting for engine initialization...');
    await sleep(5000);  // Init takes ~3-5 seconds
    
    // Check if engine is initialized
    const status = await page.evaluate(() => {
        const logs = window._capturedLogs || [];
        const initLog = logs.find(l => l.msg && l.msg.includes('Engine Initialized'));
        const errorLog = logs.find(l => l.msg && l.msg.includes('FATAL'));
        return {
            initialized: !!initLog,
            error: errorLog ? errorLog.msg : null,
            logCount: logs.length
        };
    });
    
    if (status.error) {
        throw new Error(`Engine init failed: ${status.error}`);
    }
    
    log(status.initialized ? '✅ Engine initialized' : '⚠️ Init status unclear');
    return status;
}

async function clickStart(page) {
    log('Clicking Start Game Loop...');
    
    const clicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        let btn = buttons.find(b => b.textContent.includes('Start'));
        if (btn) {
            btn.click();
            return btn.textContent.trim();
        }
        return null;
    });
    
    if (!clicked) {
        throw new Error('Could not find Start button');
    }
    log(`Clicked: "${clicked}"`);
    return true;
}

async function waitForFrames(page, seconds) {
    log(`Waiting ${seconds}s for game loop to run...`);
    await sleep(seconds * 1000);
    
    const stats = await page.evaluate(() => {
        const el = document.getElementById('statusDisplay') || 
                   document.querySelector('.status') ||
                   document.querySelector('[id*="status"]');
        return {
            statusText: el ? el.textContent : 'N/A',
            logCount: (window._capturedLogs || []).length
        };
    });
    
    log(`Status: ${stats.statusText} | Logs: ${stats.logCount}`);
    return stats;
}

async function getLogs(page) {
    return page.evaluate(() => {
        return (window._capturedLogs || []).map(e => 
            e.t + ' [' + e.level + '] ' + e.msg
        ).join('\n');
    });
}

async function getStructuredLogs(page) {
    return page.evaluate(() => {
        return JSON.stringify(window._capturedLogs || [], null, 2);
    });
}

async function getFopenMisses(page) {
    return page.evaluate(() => {
        return (window._capturedLogs || [])
            .filter(e => e.msg && e.msg.includes('fopen') && e.msg.includes('MISS'))
            .map(e => e.msg)
            .join('\n');
    });
}

async function getDlcStatus(page) {
    return page.evaluate(() => {
        const logs = window._capturedLogs || [];
        const dlcLogs = logs.filter(e => e.msg && (
            e.msg.includes('DLC') || 
            e.msg.includes('dlc') ||
            e.msg.includes('manifest') ||
            e.msg.includes('fopen')
        ));
        
        // Extract key metrics
        const result = {
            dlcLoaderInit: dlcLogs.some(l => l.msg.includes('DLC Loader initialized')),
            manifestLoaded: null,
            fopenMisses: [],
            dlcDownloads: [],
            errors: []
        };
        
        dlcLogs.forEach(l => {
            if (l.msg.includes('directories')) {
                result.manifestLoaded = l.msg;
            }
            if (l.msg.includes('fopen') && l.msg.includes('MISS')) {
                result.fopenMisses.push(l.msg);
            }
            if (l.msg.includes('Downloaded') || l.msg.includes('Fetching')) {
                result.dlcDownloads.push(l.msg);
            }
            if (l.level === 'ERR' || l.level === 'WARN') {
                result.errors.push(l.msg);
            }
        });
        
        return JSON.stringify(result, null, 2);
    });
}

async function getVfsStats(page) {
    return page.evaluate(() => {
        const logs = window._capturedLogs || [];
        const vfsLogs = logs.filter(e => e.msg && (
            e.msg.includes('VFS') || 
            e.msg.includes('vfs') ||
            e.msg.includes('fopen') ||
            e.msg.includes('fread') ||
            e.msg.includes('asset')
        ));
        return vfsLogs.map(e => e.t + ' ' + e.msg).join('\n');
    });
}

async function takeScreenshot(page, filepath) {
    log(`Taking screenshot → ${filepath}`);
    
    // Try to screenshot just the canvas
    const canvasShot = await page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        if (canvas) {
            return canvas.toDataURL('image/png');
        }
        return null;
    });
    
    if (canvasShot) {
        const data = canvasShot.replace(/^data:image\/png;base64,/, '');
        fs.writeFileSync(filepath.replace('.png', '-canvas.png'), Buffer.from(data, 'base64'));
        log('Canvas screenshot saved');
    }
    
    // Also take full page screenshot
    await page.screenshot({ path: filepath, fullPage: true });
    log('Full page screenshot saved');
}

async function evalInPage(page, code) {
    return page.evaluate(code);
}

// ============================================
// MAIN COMMAND DISPATCH
// ============================================

async function main() {
    const { browser, page, consoleLogs } = await launchBrowser();
    
    try {
        await navigateToSite(page);
        
        switch (command) {
            case 'test':
            case 'logs': {
                await clickInit(page);
                await clickStart(page);
                await waitForFrames(page, WAIT_SECONDS);
                const logs = await getLogs(page);
                await takeScreenshot(page, SCREENSHOT_FILE);
                output(logs + '\n');
                
                // Summary on stderr
                const misses = await getFopenMisses(page);
                const missCount = misses ? misses.split('\n').length : 0;
                process.stderr.write(`\n=== SUMMARY ===\n`);
                process.stderr.write(`Total log lines: ${consoleLogs.length}\n`);
                process.stderr.write(`fopen misses: ${missCount}\n`);
                process.stderr.write(`Screenshot: ${SCREENSHOT_FILE}\n`);
                if (misses) process.stderr.write(`\nfopen MISS paths:\n${misses}\n`);
                break;
            }
            
            case 'init': {
                const status = await clickInit(page);
                const logs = await getLogs(page);
                output(logs + '\n');
                break;
            }
            
            case 'start': {
                await clickInit(page);
                await clickStart(page);
                await waitForFrames(page, 5);
                const logs = await getLogs(page);
                output(logs + '\n');
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
                const misses = await getFopenMisses(page);
                output(misses ? misses + '\n' : 'No fopen misses detected\n');
                break;
            }
            
            case 'dlc-status': {
                await clickInit(page);
                await clickStart(page);
                await waitForFrames(page, WAIT_SECONDS);
                const status = await getDlcStatus(page);
                output(status + '\n');
                break;
            }
            
            case 'vfs-stats': {
                await clickInit(page);
                await clickStart(page);
                await waitForFrames(page, WAIT_SECONDS);
                const stats = await getVfsStats(page);
                output(stats + '\n');
                break;
            }
            
            case 'eval': {
                const code = args.find(a => !a.startsWith('--') && a !== 'eval');
                if (!code) {
                    process.stderr.write('Usage: cli.js eval "window._capturedLogs.length"\n');
                    process.exit(1);
                }
                await clickInit(page);
                const result = await evalInPage(page, code);
                output(JSON.stringify(result, null, 2) + '\n');
                break;
            }
            
            default:
                process.stderr.write(`Unknown command: ${command}\n`);
                process.stderr.write('Commands: test, init, start, logs, screenshot, fopen-misses, dlc-status, vfs-stats, eval\n');
                process.exit(1);
        }
        
    } catch (err) {
        process.stderr.write(`ERROR: ${err.message}\n`);
        // Dump whatever logs we have
        if (consoleLogs.length > 0) {
            const logText = consoleLogs.map(e => `${e.time} [${e.level}] ${e.text}`).join('\n');
            if (OUTPUT_FILE) {
                fs.writeFileSync(OUTPUT_FILE, logText, 'utf-8');
            }
            process.stderr.write(`Captured ${consoleLogs.length} log entries before error\n`);
        }
        process.exit(1);
    } finally {
        await browser.close();
    }
}

main();
