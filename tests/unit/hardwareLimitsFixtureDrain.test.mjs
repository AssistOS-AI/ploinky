// P1U: the live fixture agents honour Ploinky's targeted-drain contract. Ploinky starts a manifest `agent` as
// `<shell> -c "cd <cwd> && <agent>"` (cli/sandbox/docker/agentServiceManager.js, agentShell.js) under a control entrypoint that
// forwards SIGTERM, SIGINT and SIGHUP to that shell, and the targeted drain accepts only EXIT ZERO
// (targetedContainerLifecycle.js assertCleanTermination: a signal death, including 143, is never an acknowledgement).
// LIVE-P1 attempt 6 failed at client-launch with exit 143 because the fixture agent had no handler. These tests spawn the
// EXACT fixture agent command, in the same shell form, as a local process: no engine, no container.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { FIXTURE_AGENT_COMMAND, fixtureManifest } from '../hardware-limits/liveFixture.mjs';
import { drainAgent, drainExitCode } from '../hardware-limits/fixtureDrain.mjs';

const OLD_COMMAND = 'node -e "setInterval(()=>{},3600000)"';
const SHELLS = ['/bin/sh', '/bin/bash'].filter(shell => fs.existsSync(shell));

test('P1U.the-fixture-manifest-carries-the-exec-form-agent-command-that-acknowledges-a-drain', () => {
    const manifest = fixtureManifest({ name: 'probe', hardwareLimits: {} }, { image: 'docker.io/x/y@sha256:' + 'a'.repeat(64), agents: [{ name: 'probe' }] });
    assert.equal(manifest.agent, FIXTURE_AGENT_COMMAND);
    assert.match(manifest.agent, /^exec node -e "/, 'the node process replaces the shell, so it is the signalled main process');
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) assert.ok(manifest.agent.includes(`'${signal}'`), signal);
    // The command survives the manifest JSON and a shell parse unchanged.
    assert.equal(JSON.parse(JSON.stringify(manifest)).agent, FIXTURE_AGENT_COMMAND);
});

for (const shell of SHELLS) for (const [signal, name] of [['SIGTERM', 'SIGTERM'], ['SIGINT', 'SIGINT'], ['SIGHUP', 'SIGHUP']]) {
    test(`P1U.the-fixture-agent-exits-zero-without-a-signal-on-${name.toLowerCase()}-in-the-${path.basename(shell)}-launch-form`, async () => {
        const outcome = await drainAgent(FIXTURE_AGENT_COMMAND, signal, { shell });
        assert.equal(outcome.ready, true, 'the handlers were installed');
        assert.deepEqual({ code: outcome.code, signal: outcome.signal, timedOut: outcome.timedOut }, { code: 0, signal: null, timedOut: undefined });
    });
}

test('P1U.the-previous-fixture-agent-is-killed-by-sigterm-as-in-live-attempt-6-and-is-not-an-acknowledgement', async () => {
    const outcome = await drainAgent(OLD_COMMAND, 'SIGTERM', { shell: '/bin/sh' });
    // A signal death (143 in a container) is what the product refuses; the old command can never pass the exit-zero assertion.
    assert.ok(outcome.signal === 'SIGTERM' && outcome.code === null, JSON.stringify(outcome));
    assert.notDeepEqual({ code: outcome.code, signal: outcome.signal }, { code: 0, signal: null });
});

test('P1U.the-drain-exit-code-the-fakes-use-is-measured-from-the-real-process', () => {
    assert.equal(drainExitCode(FIXTURE_AGENT_COMMAND), 0);
    assert.equal(drainExitCode(OLD_COMMAND), 143);
});
