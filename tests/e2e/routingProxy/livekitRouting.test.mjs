import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('configured LiveKit deployment proves routed signaling and direct UDP media', { timeout: 180_000 }, () => {
    const command = String(process.env.PLOINKY_LIVEKIT_E2E_COMMAND || '').trim();
    assert.notEqual(command, '', 'PLOINKY_LIVEKIT_E2E_COMMAND must run the real deployment media harness');
    const result = spawnSync('/bin/sh', ['-lc', command], {
        encoding: 'utf8',
        timeout: 170_000,
        env: { ...process.env, PLOINKY_LIVEKIT_REQUIRED_PREFIX: '/base-agent-additional-server/' },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const evidence = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(evidence.signalingViaRoutingServer, true);
    assert.equal(evidence.browserPrivateDialCount, 0);
    assert.equal(evidence.remoteScreenShareTrack, true);
    assert.ok(Number(evidence.mediaByteIncrease) > 0);
    assert.equal(evidence.privateAssertionAndAcl, true);
});
