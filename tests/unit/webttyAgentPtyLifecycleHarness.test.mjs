import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    fixedAgentPodmanArgv,
    fixedAgentShellWrapperArgv,
} from '../../cli/server/webtty/agentRuntime.mjs';
import { readinessCommands } from '../integration/webttyAgentPtyReadiness.mjs';

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('Phase 0 readiness derives numeric identity from proc without terminal-control bytes or optional tools', (t) => {
    const marker = 'phase0-regression-marker';
    const readyPrefix = `__PLOINKY_READY__${marker}|`;
    const command = readinessCommands({
        readyPrefix,
        ioPrefix: `__PLOINKY_IO__${marker}|`,
        inputVariable: 'phase0_value',
    }).join('; ') + '\r';
    const readyPattern = new RegExp(
        `${escapeRegExp(readyPrefix)}(\\d+)\\|(\\d+)\\|(\\d+)\\|(\\d+)\\|(\\d+)`,
    );

    assert.match(command, /\/proc\/\$\$\/stat/);
    assert.doesNotMatch(command, /\$\((?:ps|id)\b/);
    assert.doesNotMatch(command.slice(0, -1), /[\x00-\x1f\x7f]/,
        'Readline must receive no literal tab/control byte in the server command');
    assert.equal(command.match(readyPattern), null, 'terminal echo must not satisfy readiness');

    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'webtty-readiness-'));
    t.after(() => fs.rmSync(fixture, { recursive: true, force: false }));
    const statPath = path.join(fixture, 'stat');
    const statusPath = path.join(fixture, 'status');
    fs.writeFileSync(statPath,
        '41 (bash) R 40 41 41 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0 98765 0 0\n');
    fs.writeFileSync(statusPath, 'Name:\tbash\nUid:\t1000\t1000\t1000\t1000\n');
    const executable = command.slice(0, -1)
        .replace('"/proc/$$/stat"', JSON.stringify(statPath))
        .replace('/proc/$$/status', JSON.stringify(statusPath));
    const executed = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', executable], {
        encoding: 'utf8',
        input: 'application-roundtrip\n',
    });
    assert.equal(executed.status, 0, executed.stderr);
    const applicationOutput = executed.stdout;
    const match = applicationOutput.match(readyPattern);
    assert.match(match?.[1] || '', /^\d+$/);
    assert.deepEqual(match?.slice(2), ['41', '41', '1000', '98765']);
});

test('Phase 0 CLI admission imports the production exact argv builder', () => {
    const driverPath = fileURLToPath(new URL(
        '../integration/webttyAgentPtyLifecycleDriver.mjs', import.meta.url,
    ));
    const source = fs.readFileSync(driverPath, 'utf8');
    const markerAudit = source.slice(
        source.indexOf('function markerProcesses('),
        source.indexOf('async function waitForTerminalOutput('),
    );
    assert.match(source, /import \{[\s\S]*fixedAgentPodmanArgv[\s\S]*\} from '\.\.\/\.\.\/cli\/server\/webtty\/agentRuntime\.mjs'/);
    assert.match(source, /import \{ buildAgentWorkerEnvironment \} from '\.\.\/\.\.\/cli\/server\/webtty\/agentWorkerEnvironment\.mjs'/);
    assert.doesNotMatch(source, /buildWorkerEnvironment/);
    assert.match(source, /const productionArgv = fixedAgentPodmanArgv\(/);
    assert.match(source, /fixedAgentShellWrapperArgv/);
    assert.match(source, /\/proc\/\$\{pid\}\/cmdline/);
    assert.doesNotMatch(markerAudit, /'node', '-e'/);
    assert.doesNotMatch(source, /\/environ/,
        'the non-root admission proof must not rely on cross-UID environment reads');
    assert.doesNotMatch(markerAudit, /'\/bin\/(?:ba)?sh'/,
        'marker and cleanup proofs must remain available when either shell is absent');
    assert.match(source, /--env', `\$\{TARGET_CONFIG_ENV_KEY\}=phase0-target-\$\{runId\}`/);
    assert.match(source, /__PLOINKY_TARGET_ENV__\$\{marker\}\|%s/);
    assert.match(source, /"\$\$\{TARGET_CONFIG_ENV_KEY\}"/,
        'the application proof must expand the inherited variable instead of echoing its value');
    assert.deepEqual(fixedAgentPodmanArgv({
        targetUser: '1000:1000',
        translatedCwd: '/tmp',
        marker: 'phase0-regression-marker',
        containerId: 'a'.repeat(64),
    }), [
        'container', 'exec', '--interactive', '--tty',
        '--user', '1000:1000', '--workdir', '/tmp',
        '--env', 'TERM=xterm-256color',
        '--env', 'PS1=$PWD $ ',
        '--env', 'PLOINKY_WEBTTY_MARKER=phase0-regression-marker',
        'a'.repeat(64),
        '/bin/bash', '--noprofile', '--norc', '-p', '-c',
        'PS1=\'$PWD $ \'; export PS1; /bin/bash --noprofile --norc; ploinky_webtty_status=$?; case "$ploinky_webtty_status" in 126|127) exit 124 ;; *) exit "$ploinky_webtty_status" ;; esac',
        'ploinky-webtty-marker:phase0-regression-marker',
    ]);
    assert.deepEqual(fixedAgentShellWrapperArgv(
        'phase0-regression-marker',
        '/bin/sh',
    ), [
        '/bin/sh', '-p', '-c',
        'PS1=\'$PWD $ \'; export PS1; /bin/sh -i; ploinky_webtty_status=$?; exit "$ploinky_webtty_status"',
        'ploinky-webtty-marker:phase0-regression-marker',
    ]);
});

test('agent wrapper exports a dynamic working-directory prompt into the nested shell', (t) => {
    const promptDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'webtty prompt folder-'));
    t.after(() => fs.rmSync(promptDirectory, { recursive: true, force: true }));
    for (const shellPath of ['/bin/bash', '/bin/sh']) {
        const wrapperArgv = [...fixedAgentShellWrapperArgv(
            'phase0-regression-marker',
            shellPath,
        )];
        const wrapperIndex = wrapperArgv.length - 2;
        if (shellPath === '/bin/bash') {
            // Production Bash is interactive because Podman supplies a PTY.
            // Force interactive mode here because spawnSync uses pipes.
            wrapperArgv[wrapperIndex] = wrapperArgv[wrapperIndex].replace(
                '/bin/bash --noprofile --norc;',
                '/bin/bash --noprofile --norc -i;',
            );
        }
        const result = spawnSync(wrapperArgv[0], wrapperArgv.slice(1), {
            encoding: 'utf8',
            env: {
                HOME: os.tmpdir(),
                PATH: process.env.PATH,
                TERM: 'xterm-256color',
            },
            input: `cd ${JSON.stringify(promptDirectory)}\nexit\n`,
        });
        assert.equal(result.status, 0, `${shellPath}: ${result.stderr}`);
        assert.match(
            `${result.stdout}${result.stderr}`,
            new RegExp(`${escapeRegExp(promptDirectory)} \\$ `),
            shellPath,
        );
    }
});
