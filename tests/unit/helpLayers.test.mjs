import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { showHelp } from '../../cli/services/help.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const cliEntry = path.join(repoRoot, 'cli', 'index.js');

function captureHelp(args, options) {
    const lines = [];
    const original = console.log;
    console.log = value => lines.push(String(value));
    try {
        showHelp(args, options);
    } finally {
        console.log = original;
    }
    return lines.join('\n');
}

test('cli help documents outer and agent forms', () => {
    const text = captureHelp(['cli'], { surface: 'core' });
    assert.match(text, /^cli$/m);
    assert.match(text, /^cli <agentName> \[args\.\.\.\]$/m);
    assert.match(text, /outer runtime/);
    assert.match(text, /manifest/);
});

test('host and core lifecycle help have different scopes', () => {
    const host = captureHelp([], { surface: 'host' });
    const core = captureHelp([], { surface: 'core' });
    assert.match(host, /combined, read-only outer runtime and workspace status/i);
    assert.match(host, /stop core services, then stop the outer runtime/i);
    assert.match(host, /remove the outer runtime and its three volumes/i);
    assert.match(core, /leave the outer runtime running/i);
    assert.match(core, /exit the REPL before running host ploinky stop or ploinky destroy/i);
});

test('detailed lifecycle help preserves the selected host or core scope', () => {
    const hostStatus = captureHelp(['status'], { surface: 'host' });
    const hostStop = captureHelp(['stop'], { surface: 'host' });
    const hostDestroy = captureHelp(['destroy'], { surface: 'host' });
    const coreStatus = captureHelp(['status'], { surface: 'core' });
    const coreStop = captureHelp(['stop'], { surface: 'core' });
    const coreDestroy = captureHelp(['destroy'], { surface: 'core' });

    assert.match(hostStatus, /combined, read-only outer runtime and workspace status/i);
    assert.match(hostStop, /stop core services, then stop the outer runtime/i);
    assert.match(hostDestroy, /remove the outer runtime and its three volumes/i);
    assert.match(coreStatus, /workspace\/router\/agent state/i);
    assert.match(coreStop, /leave the outer runtime running/i);
    assert.match(coreDestroy, /leave the outer runtime running/i);
});

test('layer-aware main help preserves unrelated command lines', () => {
    for (const surface of ['host', 'core']) {
        const text = captureHelp([], { surface });
        assert.match(text, /install <url\|repoName> \[name\] \[branch\]\s+Install repository/);
        assert.match(text, /webchat \[--rotate\]\s+Print the WebChat access URL/);
        assert.match(text, /client tool <name>\s+Invoke any MCP tool/);
        assert.match(text, /restart\s+Restart enabled agents \+ Router/);
        assert.match(text, /logs last <N>\s+Show last N router log lines/);
    }
});

test('all help aliases bypass dependencies and workspace initialization', () => {
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-help-root-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-help-cwd-'));
    try {
        for (const args of [['help'], ['--help'], ['-h']]) {
            const result = spawnSync(process.execPath, [cliEntry, ...args], {
                cwd,
                env: { ...process.env, PLOINKY_ROOT: emptyRoot },
                encoding: 'utf8',
            });
            const output = (result.stdout || '') + (result.stderr || '');
            assert.equal(result.status, 0, args.join(' '));
            assert.match(output, /PLOINKY/);
            assert.doesNotMatch(output, /Ploinky dependencies missing/);
            assert.equal(fs.existsSync(path.join(cwd, '.ploinky')), false);
        }
    } finally {
        fs.rmSync(emptyRoot, { recursive: true, force: true });
        fs.rmSync(cwd, { recursive: true, force: true });
    }
});
