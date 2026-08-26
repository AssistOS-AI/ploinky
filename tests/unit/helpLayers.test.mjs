import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { showHelp } from '../../cli/commands/help.js';

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
    assert.match(host, /destroy \[--delete-cache\]/i);
    assert.match(host, /remove the outer runtime without prompting/i);
    assert.match(host, /optionally delete \.ploinky\/box cache data/i);
    assert.doesNotMatch(host, /--delete-volumes/i);
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
    assert.match(
        hostDestroy,
        /retaining the host workspace and its \.ploinky\/box dependency and image cache directories by default/i,
    );
    assert.match(hostDestroy, /destroy --delete-cache/i);
    assert.match(hostDestroy, /both forms run without prompting/i);
    assert.match(hostDestroy, /\.ploinky\/box\/dependencies and \.ploinky\/box\/images/i);
    assert.match(hostDestroy, /\.ploinky\/master-key.*are never deleted/i);
    // Nested state is disposable now; help must not promise it is retained.
    assert.match(hostDestroy, /nested agents are stopped through the in-box helper/i);
    assert.match(hostDestroy, /persistent agent data must use workspace binds/i);
    // The retired outer named-volume design must not survive in active help.
    assert.doesNotMatch(hostDestroy, /--delete-volumes/i);
    assert.doesNotMatch(hostDestroy, /cache volumes/i);
    assert.doesNotMatch(hostDestroy, /anonymous volumes/i);
    assert.match(coreStatus, /workspace\/router\/agent state/i);
    assert.match(coreStop, /leave the outer runtime running/i);
    assert.match(coreDestroy, /leave the outer runtime running/i);
});

test('layer-aware main help preserves unrelated command lines', () => {
    for (const surface of ['host', 'core']) {
        const text = captureHelp([], { surface });
        assert.match(text, /install <url\|repoName> \[name\] \[branch\]\s+Install repository/);
        assert.doesNotMatch(text, /webchat\s+Print the authenticated WebChat access URL/);
        assert.doesNotMatch(text, /administrator-only Dashboard access URL/);
        assert.match(text, /client tool <name>\s+Invoke any MCP tool/);
        assert.match(text, /restart\s+Restart enabled agents \+ Router/);
        assert.match(text, /logs tail \[router\|agent\] \[--startup\]\s+Follow Router or one agent's logs/);
        assert.match(text, /logs last \[<N>\] \[router\|agent\] \[--startup\]\s+Show the last N lines for Router or one agent/);
    }
});

test('the logs help summary states the no-lifecycle-mutation guarantee and both subcommands', () => {
    for (const surface of ['host', 'core']) {
        const text = captureHelp(['logs'], { surface });
        assert.match(text, /Inspect Router or agent runtime logs without changing lifecycle state/);
        assert.match(text, /tail\s+Follow the Ploinky Router file or one agent runtime/);
        assert.match(text, /last\s+Show the last N lines for Router or one agent/);
        assert.match(text, /never create, start, repair, or remove/);
        // Stdout is reserved for log bytes.
        assert.match(text, /messages go to stderr/);
    }
});

test('detailed logs tail help documents Router and agent forms, handoff, and --startup', () => {
    for (const surface of ['host', 'core']) {
        const text = captureHelp(['logs', 'tail'], { surface });
        assert.match(text, /logs tail \[router\|agent\] \[--startup\]/);
        assert.match(text, /logs tail router/);
        // Every documented agent reference form appears in the examples.
        assert.match(text, /logs tail myAgent/);
        assert.match(text, /logs tail myRepo\/myAgent/);
        assert.match(text, /logs tail myAgent --startup/);
        assert.match(text, /one round-trip-proved reference per enabled record/);
        assert.match(text, /Linux `\/proc` argv or macOS `KERN_PROCARGS2`/);
        assert.match(text, /rechecks marker, registry generation, and source identity/);
        assert.match(text, /never falls back/);
        assert.match(text, /never opens runtime output/);
    }
});

test('detailed logs last help documents Router, strict counts, and the output ceiling', () => {
    for (const surface of ['host', 'core']) {
        const text = captureHelp(['logs', 'last'], { surface });
        assert.match(text, /logs last \[<N>\] \[router\|agent\] \[--startup\]/);
        assert.match(text, /logs last 50 router/);
        assert.match(text, /logs last 200 myRepo\/myAgent/);
        assert.match(text, /logs last 40 myAgent --startup/);
        assert.match(text, /between 1 and 10000/);
        assert.match(text, /fractions, signs, partial integers, and padded values are rejected/);
        assert.match(text, /ownership-proved runtime is selected before no-wait state/);
        assert.match(text, /16 MiB/);
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
