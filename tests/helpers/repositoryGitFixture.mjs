import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(predicate, label, timeout = 4000) {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
        assert.ok(Date.now() < deadline, `timed out: ${label}`);
        await sleep(5);
    }
}

export function installGitFixture(t, options = {}) {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'repository-git-child-'));
    const log = path.join(directory, 'events.jsonl');
    const settings = path.join(directory, 'settings.json');
    const previousPath = process.env.PATH;
    const realGit = childProcess.execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    fs.writeFileSync(settings, JSON.stringify(options));
    fs.writeFileSync(path.join(directory, 'git'), `#!${process.execPath}
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const settings = JSON.parse(fs.readFileSync(${JSON.stringify(settings)}, 'utf8'));
const directory = process.argv[3];
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ directory, pid: process.pid }) + '\\n');
process.on('SIGTERM', () => {});
if (settings.hang || (settings.hangName && path.basename(directory) === settings.hangName)) {
    setInterval(() => {}, 1000);
} else if (settings.overflow) {
    process.stdout.write(Buffer.alloc(2 * 1024 * 1024, 'x'));
    setInterval(() => {}, 1000);
} else setTimeout(() => {
    if (settings.values && Object.hasOwn(settings.values, directory)) process.stdout.end(settings.values[directory] + '\\n');
    else if (Object.hasOwn(settings, 'value')) process.stdout.end(settings.value + '\\n');
    else {
        try { process.stdout.end(cp.execFileSync(${JSON.stringify(realGit)}, process.argv.slice(2), { stdio: ['ignore', 'pipe', 'ignore'] })); }
        catch { process.exitCode = 1; }
    }
}, settings.delayMs || 0);
`, { mode: 0o755 });
    process.env.PATH = `${directory}${path.delimiter}${previousPath}`;
    const spawn = childProcess.spawn;
    const exec = childProcess.execFileSync;
    const live = new Set();
    const started = [];
    let peak = 0;
    let synchronous = 0;
    const mockedSpawn = t.mock.method(childProcess, 'spawn', (command, args, opts) => {
        const child = spawn(command, args, opts);
        if (command === 'git') {
            live.add(child);
            started.push({ child, directory: args[1] });
            peak = Math.max(peak, live.size);
            child.once('close', () => live.delete(child));
        }
        return child;
    });
    const mockedExec = t.mock.method(childProcess, 'execFileSync', (...args) => {
        if (args[0] === 'git') synchronous += 1;
        return exec(...args);
    });
    syncBuiltinESMExports();
    t.after(async () => {
        await Promise.all([...live].map(child => new Promise(resolve => { child.once('close', resolve); child.kill('SIGKILL'); })));
        mockedSpawn.mock.restore();
        mockedExec.mock.restore();
        syncBuiltinESMExports();
        process.env.PATH = previousPath;
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return {
        started, live,
        peak: () => peak,
        synchronous: () => synchronous,
        events: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [],
        configure: value => fs.writeFileSync(settings, JSON.stringify(value)),
    };
}
