import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testsDir = fileURLToPath(new URL('../', import.meta.url));

function readHarness(name) {
    return fs.readFileSync(`${testsDir}${name}`, 'utf8');
}

function commandLines(source) {
    return source
        .split('\n')
        .map((line, index) => ({ index, text: line.replace(/#.*$/, '').trim() }))
        .filter((line) => line.text.length > 0);
}

function extractShellFunction(source, name) {
    const start = source.indexOf(`\n${name}() {\n`);
    assert.notEqual(start, -1, `${name} should exist`);
    const end = source.indexOf('\n}\n', start);
    assert.notEqual(end, -1, `${name} should be terminated`);
    return source.slice(start, end);
}

test('doStop.sh completes every Router-dependent enable before it stops the Router', () => {
    const lines = commandLines(readHarness('doStop.sh'));
    const stop = lines.find((line) => /^ploinky stop\b/.test(line.text));
    assert.ok(stop, 'doStop.sh should stop the workspace');

    const enables = lines.filter((line) => /^ploinky enable\b/.test(line.text));
    assert.ok(enables.length > 0, 'doStop.sh should still exercise a Router-dependent enable');

    // `ploinky stop` kills the RoutingServer, and the enable path synchronously
    // attests Router authority over the private health socket. Any enable after
    // the stop would fail closed or leave the workspace partially prepared.
    for (const enable of enables) {
        assert.ok(
            enable.index < stop.index,
            `'${enable.text}' must run before 'ploinky stop' (line ${enable.index + 1} vs ${stop.index + 1})`,
        );
    }
});

test('doStart.sh enables the deferred fast-suite agents only after the Router is ready', () => {
    const lines = commandLines(readHarness('doStart.sh'));
    const wait = lines.find((line) => /^wait_for_router\b/.test(line.text));
    const enable = lines.find((line) => /^enable_fast_suite_agents_after_router\b/.test(line.text));
    assert.ok(wait, 'doStart.sh should wait for the Router');
    assert.ok(enable, 'doStart.sh should enable the deferred fast-suite agents');
    assert.ok(
        wait.index < enable.index,
        'the deferred fast-suite enables must follow wait_for_router',
    );
});

test('doPrepare.sh defers every agent enable until the Router exists', () => {
    const lines = commandLines(readHarness('doPrepare.sh'));
    const agentEnables = lines.filter((line) => /^ploinky enable agent\b/.test(line.text));
    assert.deepEqual(
        agentEnables.map((line) => line.text),
        [],
        'doPrepare.sh runs before any Router is started, so it must not enable agents',
    );
});

test('doPrepare.sh pins the networked fast suite to container runtime before recording it', () => {
    const lines = commandLines(readHarness('doPrepare.sh'));
    const routing = lines.find((line) => /^cat >.*\.ploinky\/routing\.json/.test(line.text));
    const disable = lines.find((line) => /^ploinky disable sandbox\b/.test(line.text));
    const runtime = lines.find((line) => /^write_state_var "FAST_AGENT_RUNTIME"/.test(line.text));
    const repo = lines.find((line) => /^ploinky enable repo\b/.test(line.text));

    assert.ok(routing, 'doPrepare.sh should initialize the workspace before changing sandbox policy');
    assert.ok(disable, 'doPrepare.sh should explicitly select the container fallback');
    assert.ok(runtime, 'doPrepare.sh should persist the effective fixture runtime');
    assert.ok(repo, 'doPrepare.sh should continue with repository enablement');
    assert.ok(routing.index < disable.index, 'sandbox policy must be workspace-scoped');
    assert.ok(disable.index < runtime.index, 'the expected runtime must follow the persisted policy');
    assert.ok(runtime.index < repo.index, 'runtime policy must be fixed before repository preparation');
    assert.doesNotMatch(readHarness('doPrepare.sh'), /ploinky enable sandbox/);
});

test('graph startup fixtures do not enable their root agent before the Router lifecycle starts', () => {
    const graphFixtures = readHarness('test-functions/workspace_dependency_startup_tests.sh');
    assert.doesNotMatch(
        graphFixtures,
        /^\s*ploinky enable agent graphRepo\/root\b/m,
        'fast_graph_start_workspace owns Router-first root/dependency startup',
    );
});

test('each post-Router enable records its own completion marker', () => {
    const lib = readHarness('lib.sh');
    const body = extractShellFunction(lib, 'enable_fast_suite_agents_after_router');

    // A repeated enable is not a no-op: cli/utils/agents.js passes
    // forceRecreate for the enable path, so a retry after a partial failure
    // would recreate agents that already succeeded.
    assert.doesNotMatch(
        body,
        /^\s*ploinky enable agent\b/m,
        'post-Router enables must go through enable_agent_once, not a bare ploinky enable agent',
    );

    const calls = [...body.matchAll(/enable_agent_once\s+"([A-Z_]+)"/g)].map((match) => match[1]);
    assert.equal(calls.length, 6, 'all six post-Router enables should be individually tracked');
    assert.equal(new Set(calls).size, calls.length, 'each enable needs a distinct completion marker');

    const once = extractShellFunction(lib, 'enable_agent_once');
    assert.match(once, /local marker="TEST_POST_ROUTER_ENABLED_\$1"/);
    assert.match(once, /if \[\[ "\$\{!marker:-0\}" == "1" \]\]; then/);
    assert.match(once, /ploinky enable agent "\$@" \|\| return 1/);
    assert.match(once, /write_state_var "\$marker" "1"/);

    // The aggregate marker may only advance after the last tracked enable.
    const lastCall = body.lastIndexOf('enable_agent_once');
    const aggregate = body.indexOf('write_state_var "TEST_POST_ROUTER_AGENTS_ENABLED" "1"');
    assert.notEqual(aggregate, -1, 'the aggregate marker should still be written');
    assert.ok(lastCall < aggregate, 'the aggregate marker must be written after every per-agent enable');
});

function writeFakePloinky(root) {
    const executable = path.join(root, 'fake-ploinky.sh');
    fs.writeFileSync(executable, `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_PLOINKY_CALLS"
if [[ -n "\${FAKE_PLOINKY_FAIL_ONCE:-}" && "$*" == "\${FAKE_PLOINKY_FAIL_ONCE}" && ! -e "$FAKE_PLOINKY_FAILED" ]]; then
  : > "$FAKE_PLOINKY_FAILED"
  exit 1
fi
`);
    fs.chmodSync(executable, 0o755);
    return executable;
}

test('doStop.sh executes the dependent devel enable before the real stop command', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-stop-order-'));
    try {
        const calls = path.join(root, 'calls.log');
        const failed = path.join(root, 'failed');
        const state = path.join(root, 'state.sh');
        const fakePloinky = writeFakePloinky(root);
        fs.writeFileSync(state, [
            `TEST_RUN_DIR=${root}`,
            'TEST_AGENT_NAME=testAgent',
            'TEST_AGENT_CONT_NAME=test-agent-container',
            'TEST_REPO_NAME=testRepo',
            'TEST_ENABLE_ALIAS_AGENT_NAME=aliasAgent',
            'FAST_AGENT_RUNTIME=bwrap',
            '',
        ].join('\n'));
        const result = spawnSync('bash', [path.join(testsDir, 'doStop.sh')], {
            encoding: 'utf8',
            env: {
                ...process.env,
                FAST_STATE_FILE: state,
                PLOINKY_FAST_CLI: fakePloinky,
                FAKE_PLOINKY_CALLS: calls,
                FAKE_PLOINKY_FAILED: failed,
            },
        });
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n'), [
            'enable agent aliasAgent devel testRepo as aliasDevel',
            'stop',
        ]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a failed deferred enable resumes without recreating successful agents', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-enable-resume-'));
    try {
        const calls = path.join(root, 'calls.log');
        const failed = path.join(root, 'failed');
        const state = path.join(root, 'state.sh');
        const fakePloinky = writeFakePloinky(root);
        fs.writeFileSync(state, [
            `TEST_RUN_DIR=${root}`,
            'TEST_REPO_NAME=testRepo',
            'TEST_OPENAI_AGENT_NAME=openaiAgent',
            'TEST_AGENT_TO_DISABLE_QUALIFIED=testRepo/disableAgent',
            'TEST_HEALTH_AGENT_NAME=healthAgent',
            'TEST_ENABLE_ALIAS_AGENT_NAME=aliasAgent',
            'TEST_ENABLE_ALIAS_AGENT_ALIAS=aliasName',
            'TEST_GLOBAL_AGENT_NAME=globalAgent',
            'TEST_DEVEL_AGENT_NAME=develAgent',
            '',
        ].join('\n'));
        const script = `
source ${JSON.stringify(path.join(testsDir, 'lib.sh'))}
assert_router_status_ok() { return 0; }
if enable_fast_suite_agents_after_router; then
  echo 'first pass unexpectedly succeeded' >&2
  exit 91
fi
enable_fast_suite_agents_after_router
`;
        const result = spawnSync('bash', ['-c', script], {
            encoding: 'utf8',
            env: {
                ...process.env,
                FAST_STATE_FILE: state,
                PLOINKY_FAST_CLI: fakePloinky,
                FAKE_PLOINKY_CALLS: calls,
                FAKE_PLOINKY_FAILED: failed,
                FAKE_PLOINKY_FAIL_ONCE: 'enable agent testRepo/disableAgent',
            },
        });
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        const observed = fs.readFileSync(calls, 'utf8').trim().split('\n');
        assert.equal(observed.filter((line) => line === 'enable agent testRepo/openaiAgent').length, 1);
        assert.equal(observed.filter((line) => line === 'enable agent testRepo/disableAgent').length, 2);
        assert.deepEqual(observed.slice(-5), [
            'enable agent testRepo/disableAgent',
            'enable agent testRepo/healthAgent',
            'enable agent aliasAgent as aliasName',
            'enable agent globalAgent global',
            'enable agent develAgent devel testRepo',
        ]);
        const persisted = fs.readFileSync(state, 'utf8');
        assert.match(persisted, /^TEST_POST_ROUTER_ENABLED_OPENAI=1$/m);
        assert.match(persisted, /^TEST_POST_ROUTER_ENABLED_DEVEL=1$/m);
        assert.match(persisted, /^TEST_POST_ROUTER_AGENTS_ENABLED=1$/m);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
