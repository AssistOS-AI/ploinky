#!/usr/bin/env node
/**
 * A7 wrapper: run the unchanged full live suite, capture its raw exit code
 * programmatically (never typed by hand), then evaluate the scoped gate.
 *
 *   AUTHZ_* environment as for `npm run test:authorization`, plus
 *   node run-acceptance.mjs --offline-dir <dir>
 *
 * Writes AUTHZ_OUTPUT_DIR/raw-exit-code.json and scoped-acceptance.json. The
 * raw suite result is reported unchanged; exit 0 only on a scoped ACCEPT.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Run a Node script and resolve its exact exit code (signals map to null with the signal name). */
export function captureExitCode(script, args = [], { env = process.env, cwd } = {}) {
    return new Promise((resolve, reject) => {
        const startedAt = new Date().toISOString();
        const child = spawn(process.execPath, [script, ...args], { env, cwd, stdio: 'inherit' });
        child.on('error', reject);
        child.on('exit', (code, signal) => resolve({ exitCode: Number.isInteger(code) ? code : null, signal: signal || null, startedAt, finishedAt: new Date().toISOString(), script: path.relative(path.resolve(here, '../../../..'), script) }));
    });
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const argv = process.argv.slice(2);
    const offlineIndex = argv.indexOf('--offline-dir');
    const offlineDir = offlineIndex >= 0 ? argv[offlineIndex + 1] : '';
    if (!offlineDir || !process.env.AUTHZ_OUTPUT_DIR || !process.env.AUTHZ_PINS || !process.env.AUTHZ_PINS_SHA256) {
        console.error('Set AUTHZ_OUTPUT_DIR, AUTHZ_PINS, AUTHZ_PINS_SHA256 and pass --offline-dir');
        process.exitCode = 1;
    } else {
        const raw = await captureExitCode(path.resolve(here, '../run.mjs'), [], { cwd: path.resolve(here, '../../../..') });
        const output = process.env.AUTHZ_OUTPUT_DIR;
        fs.writeFileSync(path.join(output, 'raw-exit-code.json'), JSON.stringify(raw, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        console.log(`RAW SUITE: exit ${raw.exitCode}${raw.signal ? ` signal ${raw.signal}` : ''}`);
        const { verifyFromFiles } = await import('./verify-acceptance.mjs');
        let result;
        try {
            result = verifyFromFiles({ reportFile: path.join(output, 'report.json'), exitCodeFile: path.join(output, 'raw-exit-code.json'), offlineDir, pinsFile: process.env.AUTHZ_PINS, pinsSha256: process.env.AUTHZ_PINS_SHA256 });
        } catch (error) {
            result = { decision: 'REJECT', reasons: [`VERIFY_FAILED: ${error?.message || error}`] };
        }
        fs.writeFileSync(path.join(output, 'scoped-acceptance.json'), JSON.stringify({ raw, ...result }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        console.log(`SCOPED A6: ${result.decision}`);
        for (const reason of result.reasons) console.log(`  ${reason}`);
        process.exitCode = result.decision === 'ACCEPT' ? 0 : 1;
    }
}
