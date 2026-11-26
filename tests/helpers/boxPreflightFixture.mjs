import assert from 'node:assert/strict';
import { IMAGE_CONTRACT } from '../../ploinky-box/contract/image.mjs';
import { nativeRuntimeExpectation } from '../../core-services/webtty/native-runtime.mjs';

// Synthetic engine responses for the real immutable-image admission probes.
export function preflightImageQuery(args) {
    if (args[0] === 'image' && args[1] === 'inspect') {
        const id = args.at(-1);
        assert.match(id, /^(?:sha256:)?[a-f0-9]{64}$/);
        return { ok: true, stdout: JSON.stringify([{ Id: id, Os: 'linux', Architecture: 'arm64', Config: {
            User: IMAGE_CONTRACT.user, WorkingDir: IMAGE_CONTRACT.workdir,
            Env: Object.entries(IMAGE_CONTRACT.environment).map(([key, value]) => `${key}=${value}`),
            Entrypoint: [IMAGE_CONTRACT.entrypoint], Cmd: [], Volumes: {}, Labels: {},
        } }]) };
    }
    if (args.includes('--entrypoint=/bin/bash')) return { ok: true, stdout: [...IMAGE_CONTRACT.requiredBinaries, IMAGE_CONTRACT.networkHelpers[0]].map(name => name.startsWith('/') ? name : `/usr/bin/${name}`).join('\n') };
    if (args.includes('--entrypoint=/usr/local/bin/node')) return { ok: true, stdout: JSON.stringify({
        ...nativeRuntimeExpectation({ platform: 'linux', architecture: 'arm64' }),
        nativeArtifactSha256: 'a'.repeat(64), sourceSha: 'b'.repeat(40), uid: 1000, gid: 1000,
        pty: { import: true, input: true, output: true, resize: true, exit: true, reap: true, identity: true },
    }) };
    return null;
}

export function assertProfileCommand(engine, id, argv, hostPort, mediaPort, _runner, options) {
    assert.equal(engine.name, 'podman');
    assert.match(id, /^[a-f0-9]{64}$/);
    assert.deepEqual(argv.slice(0, 2), ['profile', 'assert']);
    assert.ok(Number.isInteger(hostPort) && hostPort > 0);
    assert.ok(Number.isInteger(mediaPort) && mediaPort > 0);
    assert.ok(options.workspaceRoot && options.agentLib);
}
