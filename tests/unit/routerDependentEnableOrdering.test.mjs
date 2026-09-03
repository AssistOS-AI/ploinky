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

test('fast lifecycle launches use a bounded recurring-probe interval without changing production defaults', () => {
    const lib = readHarness('lib.sh');
    const wrapper = extractShellFunction(lib, 'ploinky');
    assert.match(
        wrapper,
        /PLOINKY_CONTAINER_MONITOR_CONTINUOUS_PROBE_INTERVAL_MS="\$\{PLOINKY_CONTAINER_MONITOR_CONTINUOUS_PROBE_INTERVAL_MS:-5000\}"/,
    );
});

test('graph startup fixtures do not enable their root agent before the Router lifecycle starts', () => {
    const graphFixtures = readHarness('test-functions/workspace_dependency_startup_tests.sh');
    assert.doesNotMatch(
        graphFixtures,
        /^\s*ploinky enable agent graphRepo\/root\b/m,
        'fast_graph_start_workspace owns Router-first root/dependency startup',
    );
});

test('continuous health recovery follows the exact watchdog lifecycle events', () => {
    const health = readHarness('test-functions/health_probes_negative.sh');
    assert.match(health, /\.ploinky\/logs\/watchdog\.log/);
    assert.match(health, /container_probe_failed/);
    assert.match(health, /container_scheduling_restart/);
    assert.match(health, /semantic_probe_failed/);
    assert.match(health, /TEST_HEALTH_AGENT_CONT_NAME/);
    assert.doesNotMatch(health, /TEST_AGENT_START_LOG/);
});

test('continuous health recovery accepts only exact active public-route responses', () => {
    const healthHarness = path.join(testsDir, 'test-functions/health_probes_negative.sh');
    const run = (status, body) => {
        const result = spawnSync('bash', ['-c', `
            set -euo pipefail
            FAST_STATE_FILE=$(mktemp -t ploinky-health-response-state.XXXXXX)
            export FAST_STATE_FILE
            source "$1"
            response_file=$(mktemp -t ploinky-active-response.XXXXXX)
            trap 'rm -f "$FAST_STATE_FILE" "$response_file"' EXIT
            printf '%s' "$3" > "$response_file"
            health_probes_response_proves_edge_active "$2" "$response_file"
        `, 'health-response-test', healthHarness, status, body], {
            encoding: 'utf8',
            env: process.env,
        });
        return result.status;
    };

    assert.equal(run('200', '{}'), 0, 'an open active route may return 200');
    assert.equal(
        run('401', JSON.stringify({ ok: false, error: { code: 'AUTH_REQUIRED' } })),
        0,
        'an auth-protected active route must return the exact structured denial',
    );
    assert.notEqual(run('401', JSON.stringify({ error: { code: 'OTHER' } })), 0);
    assert.notEqual(run('503', JSON.stringify({ error: { code: 'EDGE_GENERATION_INACTIVE' } })), 0);
});

function healthRegistry(container = 'current-runtime') {
    return { [container]: { type: 'agent', repoName: 'testRepo', agentName: 'healthAgent' } };
}

function runHealthHarness(script, { registry = healthRegistry(), events = [], env = {} } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-health-identity-'));
    try {
        fs.mkdirSync(path.join(root, '.ploinky', 'logs'), { recursive: true });
        fs.mkdirSync(path.join(root, '.ploinky', 'run'));
        fs.writeFileSync(path.join(root, '.ploinky', 'agents.json'), JSON.stringify(registry));
        fs.writeFileSync(path.join(root, '.ploinky', 'logs', 'watchdog.log'), events.map((event) => JSON.stringify(event)).join('\n') + '\n');
        const state = path.join(root, 'state.sh');
        fs.writeFileSync(state, '');
        const result = spawnSync('bash', ['-c', `
            source "$1"
            assert_container_running() { [[ "$1" == "$EXPECTED_RUNNING_CONTAINER" ]]; }
            wait_for_container() { assert_container_running "$1"; }
            sleep() { exit 89; }
            curl() {
                local body_file=""
                while (( $# > 0 )); do
                    if [[ "$1" == "-o" ]]; then body_file="$2"; shift; fi
                    shift
                done
                printf '%s' "$FAKE_HTTP_BODY" > "$body_file"
                if [[ -n "\${FAKE_REGISTRY_AFTER_CURL:-}" ]]; then
                    printf '%s' "$FAKE_REGISTRY_AFTER_CURL" > "$TEST_RUN_DIR/.ploinky/agents.json"
                fi
                printf '%s' "$FAKE_HTTP_STATUS"
            }
            ${script}
        `, 'health-identity-test', path.join(testsDir, 'test-functions/health_probes_negative.sh')], {
            encoding: 'utf8',
            timeout: 5000,
            env: {
                ...process.env,
                TMPDIR: root,
                FAST_STATE_FILE: state,
                TEST_RUN_DIR: root,
                TEST_REPO_NAME: 'testRepo',
                TEST_HEALTH_AGENT_NAME: 'healthAgent',
                TEST_HEALTH_AGENT_CONT_NAME: 'retired-runtime',
                TEST_ROUTER_PORT: '18080',
                EXPECTED_RUNNING_CONTAINER: 'current-runtime',
                FAKE_HTTP_STATUS: '401',
                FAKE_HTTP_BODY: JSON.stringify({ ok: false, error: { code: 'AUTH_REQUIRED' } }),
                ...env,
            },
        });
        return { ...result, state: fs.readFileSync(state, 'utf8') };
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

test('health recovery resolves the unique current runtime instead of a retired fixture name', () => {
    const resolved = runHealthHarness('health_probes_current_container');
    assert.equal(resolved.status, 0, resolved.stderr);
    assert.equal(resolved.stdout.trim(), 'current-runtime');

    const active = runHealthHarness('health_probes_wait_for_edge_recovery');
    assert.equal(active.status, 0, active.stderr);
    assert.match(active.state, /^TEST_HEALTH_AGENT_CONT_NAME=current-runtime$/m);
});

test('health recovery rejects missing, unrelated, and ambiguous runtime records', () => {
    for (const registry of [
        {},
        { other: { type: 'agent', repoName: 'anotherRepo', agentName: 'healthAgent' } },
        { ...healthRegistry(), ...healthRegistry('another-runtime') },
    ]) {
        const result = runHealthHarness('health_probes_current_container', { registry });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Expected one current health probe runtime/);
        assert.equal(result.state, '');
    }
});

test('active health recovery cannot accept a stopped or concurrently replaced runtime', () => {
    for (const env of [
        { EXPECTED_RUNNING_CONTAINER: 'another-runtime' },
        { FAKE_REGISTRY_AFTER_CURL: JSON.stringify(healthRegistry('another-runtime')) },
    ]) {
        const result = runHealthHarness('health_probes_wait_for_edge_recovery', { env });
        assert.equal(result.status, 89, result.stderr);
        assert.equal(result.state, '', 'an unproven runtime must not update fixture identity');
    }
});

test('health restart completion requires a new event for the exact selected runtime and agent', () => {
    const success = {
        event: 'container_restart_success',
        reason: 'semantic_probe_failed',
        container: 'current-runtime',
        repo: 'testRepo',
        agent: 'healthAgent',
    };
    const accepted = runHealthHarness('health_probes_wait_for_restart_completion 1', {
        events: [{ event: 'old-event' }, success],
    });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(accepted.state, /^TEST_HEALTH_AGENT_CONT_NAME=current-runtime$/m);

    for (const events of [
        [success],
        [{ event: 'old-event' }, { ...success, container: 'retired-runtime' }],
        [{ event: 'old-event' }, { ...success, repo: 'anotherRepo' }],
        [{ event: 'old-event' }, { ...success, agent: 'anotherAgent' }],
        [{ event: 'old-event' }, { ...success, reason: 'not_running' }],
    ]) {
        const rejected = runHealthHarness('health_probes_wait_for_restart_completion 1', { events });
        assert.equal(rejected.status, 89, JSON.stringify({ events, stderr: rejected.stderr }));
        assert.equal(rejected.state, '');
    }
});

test('health recovery accepts a successful retry of the already-observed semantic failure', () => {
    const retriedSuccess = {
        event: 'container_restart_success',
        reason: 'restart_failed',
        container: 'current-runtime',
        repo: 'testRepo',
        agent: 'healthAgent',
    };
    const accepted = runHealthHarness('health_probes_wait_for_restart_completion 1', {
        events: [{ event: 'old-event' }, retriedSuccess],
    });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(accepted.state, /^TEST_HEALTH_AGENT_CONT_NAME=current-runtime$/m);

    for (const events of [
        [retriedSuccess],
        [{ event: 'old-event' }, { ...retriedSuccess, container: 'retired-runtime' }],
        [{ event: 'old-event' }, { ...retriedSuccess, repo: 'anotherRepo' }],
        [{ event: 'old-event' }, { ...retriedSuccess, agent: 'anotherAgent' }],
    ]) {
        const rejected = runHealthHarness('health_probes_wait_for_restart_completion 1', { events });
        assert.equal(rejected.status, 89, JSON.stringify({ events, stderr: rejected.stderr }));
        assert.equal(rejected.state, '');
    }
});

test('negative health injection refreshes identity and waits for replacement completion before route recovery', () => {
    const result = runHealthHarness(`
        edge_checks=0
        health_probes_wait_for_edge_recovery() {
            edge_checks=$((edge_checks + 1))
            if (( edge_checks == 1 )); then
                TEST_HEALTH_AGENT_CONT_NAME=current-runtime
                write_state_var TEST_HEALTH_AGENT_CONT_NAME "$TEST_HEALTH_AGENT_CONT_NAME"
                echo ready-before-injection
            else
                [[ "$TEST_HEALTH_AGENT_CONT_NAME" == recovered-runtime ]] || return 1
                echo ready-after-replacement
            fi
        }
        health_probes_force_failure() {
            [[ "$TEST_HEALTH_AGENT_CONT_NAME" == current-runtime ]] || return 1
            echo failure-injected
        }
        health_probes_wait_for_failure_logs() { echo exact-failure-observed; }
        health_probes_assert_edge_inactive() { echo edge-inactive; }
        health_probes_write_success_scripts() { echo source-restored; }
        health_probes_wait_for_restart_completion() {
            TEST_HEALTH_AGENT_CONT_NAME=recovered-runtime
            write_state_var TEST_HEALTH_AGENT_CONT_NAME "$TEST_HEALTH_AGENT_CONT_NAME"
            echo replacement-completed
        }
        health_probes_fail_closed_and_recovers
    `);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split('\n'), [
        'ready-before-injection',
        'failure-injected',
        'exact-failure-observed',
        'edge-inactive',
        'source-restored',
        'replacement-completed',
        'ready-after-replacement',
    ]);
});

test('the disposable health fixture keeps strict failure thresholds with a VM scheduling budget', () => {
    const source = readHarness('doPrepare.sh');
    const marker = 'cat >"${health_agent_root}/manifest.json" <<\'EOF\'\n';
    const start = source.indexOf(marker);
    assert.notEqual(start, -1);
    const end = source.indexOf('\nEOF', start + marker.length);
    const manifest = JSON.parse(source.slice(start + marker.length, end));
    for (const probe of Object.values(manifest.health)) {
        assert.equal(probe.timeout, 5);
        assert.equal(probe.failureThreshold, 1);
        assert.equal(probe.successThreshold, 1);
    }
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
