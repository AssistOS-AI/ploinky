import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runInsideDiagnostics } from '../../ploinky-box/diagnose/inside.mjs';
import { NESTED_PODMAN_SECCOMP_BOX_PATH } from '../../ploinky-box/seccomp.mjs';

const IMAGE = 'docker.io/assistos/ploinky-box@sha256:' + 'a'.repeat(64);
const IMAGE_ID = 'sha256:' + 'b'.repeat(64);
const RUN_ID = '11111111-1111-4111-8111-111111111111';
const OWNER = 'io.assistos.ploinky.diagnose-run';
const pass = (stdout = '') => ({ ok: true, status: 0, stdout, stderr: '' });
const fail = (stderr = 'operation failed') => ({ ok: false, status: 125, stdout: '', stderr });

function completeNestedReport({ registryKnown = true } = {}) {
    const operations = { 'podman-info': 'info', 'podman-settings': null, 'agent-create': 'create', 'agent-start': 'start', 'agent-exec': 'exec', 'agent-filesystem': 'exec', 'agent-network': 'exec', 'agent-remove': 'rm' };
    return { checks: Object.entries(operations).map(([id, operation]) => ({
        id: `nested-engine.${id}`, label: id, status: id === 'agent-network' && !registryKnown ? 'skip' : 'pass', detail: 'Checked',
        ...(operation ? { command: { file: 'podman', args: [operation, 'd'.repeat(64)] } } : {}),
    })), exitCode: 0 };
}

function archive(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-archive-unit-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'image.tar');
    fs.writeFileSync(file, 'test archive fixture');
    return file;
}

function fixture(t, { override, info, nestedReport } = {}) {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-diagnose-unit-'));
    t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
    const calls = [];
    const containers = new Map();
    let serial = 0;
    const runner = {
        async query(file, args, options) {
            calls.push({ file, args, options });
            const overridden = override?.({ file, args, options, calls, containers });
            if (overridden !== undefined) return overridden;
            if (file !== 'podman') return pass(`${file} works`);
            if (args[0] === 'info') return pass(JSON.stringify(info ?? {
                host: { security: { rootless: true }, networkBackend: 'netavark' },
                store: { graphDriverName: 'overlay', graphRoot: '/home/podman/.local/share/containers/storage', graphOptions: { 'overlay.mount_program': { Executable: '/usr/bin/fuse-overlayfs' } } },
            }));
            if (args[0] === 'image') return pass(JSON.stringify([{ Id: IMAGE_ID }]));
            if (args[0] === 'unshare') return pass('0 1000 1\n1 1 999\n1000 1001 64535\n');
            if (args[0] === 'create') {
                const Id = String(++serial).padStart(64, '0');
                const container = { Id, Image: IMAGE_ID, Config: { Labels: { [OWNER]: RUN_ID } }, name: args[args.indexOf('--name') + 1] };
                containers.set(Id, container);
                return pass(Id + '\n');
            }
            if (args[0] === 'inspect') {
                const reference = args.at(-1);
                const container = containers.get(reference) || [...containers.values()].find((item) => item.name === reference);
                return container ? pass(JSON.stringify([container])) : fail('no such container');
            }
            if (args[0] === 'exec' && args.includes('--nested-engine')) return pass(JSON.stringify(nestedReport ?? completeNestedReport({ registryKnown: !args[4].startsWith('sha256:') })));
            if (args[0] === 'rm') containers.delete(args.at(-1));
            return pass('passed');
        },
    };
    return { calls, containers, tempRoot, run: (extra = {}) => runInsideDiagnostics({ runner, imageRef: IMAGE, tempRoot, dataRoot: tempRoot, runId: RUN_ID, progress: () => {}, ...extra }) };
}

test('isolated probes use immutable images, canonical confinement, separate lifecycle commands and guarded cleanup', async (t) => {
    const state = fixture(t);
    const result = await state.run();
    assert.equal(result.exitCode, 0, JSON.stringify(result.checks.filter((check) => check.status === 'fail')));
    const creates = state.calls.filter((call) => call.args[0] === 'create');
    assert.equal(creates.length, 2);
    for (const { args } of creates) {
        assert.equal(args.includes('--pull=never'), true);
        assert.equal(args[args.indexOf('--network') + 1], 'pasta');
        assert.equal(args[args.indexOf('--ipc') + 1], 'none');
        assert.equal(args.includes(IMAGE_ID), true);
        assert.equal(args.includes(IMAGE), false);
        assert.equal(args.includes('--privileged'), false);
        assert.equal(args.some((arg) => arg.includes('unconfined')), false);
        assert.equal(args[args.indexOf('--entrypoint') + 1], '/bin/sh');
    }
    const engine = creates[1].args;
    assert.deepEqual(engine.filter((_, index) => engine[index - 1] === '--cap-add'), ['SYS_ADMIN', 'NET_ADMIN']);
    assert.deepEqual(engine.filter((_, index) => engine[index - 1] === '--device'), ['/dev/fuse', '/dev/net/tun']);
    assert.deepEqual(engine.filter((_, index) => engine[index - 1] === '--tmpfs'), ['/dev/shm:rw,size=64m,mode=1777']);
    assert.equal(creates[0].args.includes('--tmpfs'), false);
    assert.deepEqual(engine.filter((_, index) => engine[index - 1] === '--security-opt'), ['label=disable', `seccomp=${NESTED_PODMAN_SECCOMP_BOX_PATH}`]);
    assert.equal(engine.includes('/opt/ploinky:/opt/ploinky:ro'), true);
    const dataMount = engine.find((arg) => arg.endsWith(':/data:rw'));
    assert.match(dataMount, new RegExp(`^${state.tempRoot}/ploinky-diagnose-data-${RUN_ID}-[^/]+:/data:rw$`));
    assert.equal(creates[0].args.some((arg) => arg.endsWith(':/data:rw')), false);
    for (let index = 0; index < state.calls.length; index += 1) {
        const call = state.calls[index];
        assert.equal(call.options.timeoutMs > 0, true);
        if (['start', 'exec', 'rm'].includes(call.args[0])) {
            assert.equal(state.calls[index - 1].args[0], 'inspect');
            assert.match(call.args[0] === 'rm' ? call.args.at(-1) : call.args[1], /^[a-f0-9]{64}$/);
        }
    }
    assert.equal(state.containers.size, 0);
    assert.deepEqual(fs.readdirSync(state.tempRoot), []);
    assert.equal(result.checks.some((check) => check.id === 'inner.agent-filesystem'), true);
    assert.equal(result.checks.some((check) => check.id === 'nested-engine.agent-start'), true);
});

test('a missing cached image triggers explicit bounded pull before immutable create', async (t) => {
    let initial = true;
    const state = fixture(t, { override: ({ args }) => {
        if (args[0] === 'image' && initial) { initial = false; return fail('image absent'); }
    } });
    const result = await state.run();
    assert.equal(result.exitCode, 0);
    const pull = state.calls.find((call) => call.args[0] === 'pull');
    assert.deepEqual(pull.args, ['pull', IMAGE]);
    assert.equal(pull.options.timeoutMs, 240_000);
    assert.equal(result.checks.find((check) => check.id === 'inner.image-inspect').status, 'skip');
});

test('failed image pull records precise failure, skips containers and removes scratch', async (t) => {
    const state = fixture(t, { override: ({ args }) => ['image', 'pull'].includes(args[0]) ? fail('DNS lookup refused; password=never-print-this') : undefined });
    const result = await state.run();
    assert.equal(result.exitCode, 1);
    assert.equal(state.calls.some((call) => call.args[0] === 'create'), false);
    assert.equal(result.checks.some((check) => check.id === 'inner.container-probe' && check.status === 'skip'), true);
    assert.equal(JSON.stringify(result).includes('never-print-this'), false);
    assert.deepEqual(fs.readdirSync(state.tempRoot), []);
});

test('pasta start failure preserves error, removes its container and still probes independent engine', async (t) => {
    let first = true;
    const state = fixture(t, { override: ({ args }) => {
        if (args[0] === 'start' && first) { first = false; return fail('pasta: Cannot open network namespace /run/netns/netns-test: Permission denied'); }
    } });
    const result = await state.run();
    assert.equal(result.exitCode, 1);
    const failure = result.checks.find((check) => check.id === 'inner.agent-start');
    assert.equal(failure.status, 'fail');
    assert.match(failure.detail, /Permission denied/);
    assert.match(failure.next, /AppArmor/);
    assert.equal(result.checks.some((check) => check.id === 'inner.engine-exec'), true);
    assert.equal(state.containers.size, 0);
});

test('cleanup refuses a container whose ownership changed and never removes by name', async (t) => {
    const state = fixture(t, { override: ({ args, containers }) => {
        if (args[0] === 'start') {
            containers.get(args[1]).Config.Labels[OWNER] = 'another-run';
            return fail('changed owner');
        }
    } });
    const result = await state.run();
    assert.equal(result.exitCode, 1);
    assert.equal(state.calls.some((call) => call.args[0] === 'rm'), false);
    assert.equal(result.checks.filter((check) => /-remove$/.test(check.id) && check.status === 'fail').length, 2);
});

test('failed exec does not suppress filesystem and networking probes or cleanup', async (t) => {
    const state = fixture(t, { override: ({ args }) => args[0] === 'exec' && args.includes('/bin/true') ? fail('OCI exec denied') : undefined });
    const result = await state.run();
    assert.equal(result.exitCode, 1);
    assert.equal(result.checks.find((check) => check.id === 'inner.agent-filesystem').status, 'pass');
    assert.equal(result.checks.find((check) => check.id === 'inner.agent-network').status, 'pass');
    assert.equal(state.containers.size, 0);
});

test('unknown Podman settings cannot report success', async (t) => {
    const state = fixture(t, { info: {} });
    const result = await state.run();
    assert.equal(result.exitCode, 1);
    assert.equal(result.checks.find((check) => check.id === 'inner.podman-settings').status, 'fail');
    assert.equal(result.checks.find((check) => check.id === 'inner.agent-start').status, 'pass');
});

test('invalid JSON info and incomplete mappings report failures without hiding other diagnostics', async (t) => {
    const state = fixture(t, { override: ({ args }) => args[0] === 'info' ? pass('not JSON') : args[0] === 'unshare' ? pass('0 1000 1\n') : undefined });
    const result = await state.run();
    assert.equal(result.exitCode, 1);
    for (const id of ['podman-settings', 'uid-mapping', 'gid-mapping']) assert.equal(result.checks.find((check) => check.id === `inner.${id}`).status, 'fail');
    assert.equal(result.checks.find((check) => check.id === 'inner.agent-start').status, 'pass');
});

test('untrusted nested report diagnostics are sanitized and commands get their execution context', async (t) => {
    const state = fixture(t, { nestedReport: { checks: [{ id: 'nested-engine.agent-start', label: 'Nested start', status: 'fail', detail: 'password=do-not-print', next: 'Fix password=do-not-print', command: { file: 'podman', args: ['start', 'd'.repeat(64)] } }], exitCode: 1 } });
    const result = await state.run();
    assert.equal(result.exitCode, 1);
    assert.equal(JSON.stringify(result).includes('do-not-print'), false);
    const nested = result.checks.find((check) => check.id === 'nested-engine.agent-start');
    assert.equal(nested.command.file, 'podman');
    assert.deepEqual(nested.command.args.slice(0, 1), ['exec']);
    assert.equal(state.containers.size, 0);
});

test('malformed and host-local image references are rejected before commands or scratch creation', async (t) => {
    for (const imageRef of ['sha256:' + 'a'.repeat(64), 'image; echo unsafe', '--all', 'https://secret@example.com/image']) {
        const state = fixture(t);
        const result = await state.run({ imageRef });
        assert.equal(result.exitCode, 1);
        assert.deepEqual(state.calls, []);
        assert.deepEqual(fs.readdirSync(state.tempRoot), []);
    }
});

test('nested engine uses isolated rootful fuse storage at the real profile pathname and cannot recurse', async (t) => {
    const writes = [];
    const directories = [];
    const state = fixture(t, { info: {
        host: { security: { rootless: false }, networkBackend: 'netavark' },
        store: { graphDriverName: 'overlay', graphRoot: '/data/podman/storage', graphOptions: { 'overlay.mount_program': '/usr/bin/fuse-overlayfs' } },
    } });
    const fsApi = {
        ...fs,
        mkdirSync(directory, options) {
            directories.push(directory);
            if (directory !== '/data/podman/storage') return fs.mkdirSync(directory, options);
        },
        writeFileSync(file, text, options) {
            writes.push({ file, text });
            return fs.writeFileSync(file, text, options);
        },
    };
    const result = await state.run({ nestedEngine: true, fsApi });
    assert.equal(result.exitCode, 0);
    assert.equal(directories.includes('/data/podman/storage'), true);
    const configuration = writes.find((write) => write.file.endsWith('/storage.conf'));
    assert.match(configuration.text, /graphroot = "\/data\/podman\/storage"/);
    assert.match(configuration.text, /mount_program = "\/usr\/bin\/fuse-overlayfs"/);
    assert.equal(state.calls.filter((call) => call.args[0] === 'create').length, 1);
    assert.equal(state.calls.some((call) => call.args.includes('--nested-engine')), false);
    for (const call of state.calls) {
        assert.equal(call.options.env.CONTAINERS_STORAGE_CONF, configuration.file);
        assert.equal(call.options.env.USER, 'root');
        assert.equal(call.options.env.HOME, '/root');
    }
    assert.deepEqual(fs.readdirSync(state.tempRoot), []);
});

test('verified archive loads by exact expected image ID without pulling or forwarding registry credentials', async (t) => {
    let initial = true;
    const imageArchive = archive(t);
    const state = fixture(t, { override: ({ args }) => {
        if (args[0] === 'image' && initial) { initial = false; return fail('not in isolated cache'); }
    } });
    const result = await state.run({ imageArchive, imageId: IMAGE_ID });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(state.calls.find((call) => call.args[0] === 'load').args, ['load', '--input', imageArchive]);
    assert.equal(state.calls.some((call) => call.args[0] === 'pull'), false);
    for (const call of state.calls.filter((call) => call.args[0] === 'image')) assert.equal(call.args.at(-1), IMAGE_ID);
    const engine = state.calls.filter((call) => call.args[0] === 'create')[1].args;
    assert.equal(engine.includes(`${imageArchive}:/diagnose-image.tar:ro`), true);
    const recursion = state.calls.find((call) => call.args[0] === 'exec' && call.args.includes('--nested-engine')).args;
    assert.deepEqual(recursion.slice(-4), ['--image-archive', '/diagnose-image.tar', '--image-id', IMAGE_ID]);
});

test('an archive with the wrong immutable image fails before creating any containers', async (t) => {
    const state = fixture(t);
    const result = await state.run({ imageArchive: archive(t), imageId: 'sha256:' + 'c'.repeat(64) });
    assert.equal(result.exitCode, 1);
    assert.equal(result.checks.find((check) => check.id === 'inner.image-identity').status, 'fail');
    assert.equal(state.calls.some((call) => call.args[0] === 'create'), false);
});

test('archive mode requires a known immutable image and rejects symlink archives', async (t) => {
    const imageArchive = archive(t);
    const state = fixture(t);
    const missingId = await state.run({ imageArchive });
    assert.equal(missingId.exitCode, 1);
    assert.deepEqual(state.calls, []);
    const link = imageArchive + '.link';
    fs.symlinkSync(imageArchive, link);
    const symlink = await state.run({ imageArchive: link, imageId: IMAGE_ID });
    assert.equal(symlink.exitCode, 1);
    assert.deepEqual(state.calls, []);
});

test('registry network probe targets the selected registry and Docker Hub uses its actual registry endpoint', async (t) => {
    for (const [imageRef, expected] of [[IMAGE, 'https://registry-1.docker.io/v2/'], ['registry.example.test:5443/team/box:current', 'https://registry.example.test:5443/v2/']]) {
        const state = fixture(t);
        const result = await state.run({ imageRef });
        assert.equal(result.exitCode, 0);
        const network = result.checks.find((check) => check.id === 'inner.agent-network');
        assert.equal(network.command.args.at(-1), expected);
        assert.equal(network.command.args.at(-2).includes('registry-1.docker.io'), false);
    }
});

test('a verified local image runs container probes and explicitly skips unknown registry checks', async (t) => {
    const state = fixture(t);
    const result = await state.run({ imageRef: IMAGE_ID, imageId: IMAGE_ID, imageArchive: archive(t) });
    assert.equal(result.exitCode, 0);
    assert.equal(result.checks.find((check) => check.id === 'inner.agent-start').status, 'pass');
    assert.equal(result.checks.find((check) => check.id === 'inner.agent-network').status, 'skip');
    assert.equal(state.calls.some((call) => call.args[0] === 'pull'), false);
});

test('successful image inspection never includes raw environment or other image metadata in reports', async (t) => {
    const state = fixture(t, { override: ({ args }) => args[0] === 'image' ? pass(JSON.stringify([{ Id: IMAGE_ID, Config: { Env: ['INTERNAL_VALUE=must-not-be-reported'] } }])) : undefined });
    const result = await state.run();
    assert.equal(result.exitCode, 0);
    assert.equal(JSON.stringify(result).includes('must-not-be-reported'), false);
    assert.equal(result.checks.find((check) => check.id === 'inner.image-inspect').detail, `Verified immutable diagnostic image ${IMAGE_ID}.`);
});

test('empty, invalid-status, incomplete and inconsistent recursive reports cannot claim success', async (t) => {
    const invalidStatus = completeNestedReport();
    invalidStatus.checks[0].status = 'unknown';
    const incomplete = completeNestedReport();
    incomplete.checks = incomplete.checks.filter((check) => check.id !== 'nested-engine.agent-remove');
    const wrongCommand = completeNestedReport();
    wrongCommand.checks.find((check) => check.id === 'nested-engine.agent-start').command.args[0] = 'info';
    const inconsistent = completeNestedReport();
    inconsistent.checks[0].status = 'fail';
    for (const nestedReport of [{ checks: [], exitCode: 0 }, invalidStatus, incomplete, wrongCommand, inconsistent]) {
        const state = fixture(t, { nestedReport });
        const result = await state.run();
        assert.equal(result.exitCode, 1);
        const execution = result.checks.find((check) => check.id === 'inner.engine-exec');
        assert.equal(execution.status, 'fail');
        assert.match(execution.detail, /no complete, valid/);
        assert.equal(state.containers.size, 0);
    }
});

test('OCI mkdir failures receive storage guidance instead of a misleading networking diagnosis', async (t) => {
    const state = fixture(t, { override: ({ args }) => args[0] === 'start' ? fail('crun: mkdir `/diagnose`: Invalid argument') : undefined });
    const result = await state.run();
    assert.equal(result.exitCode, 1);
    const failure = result.checks.find((check) => check.id === 'inner.agent-start');
    assert.match(failure.next, /overlay driver/);
    assert.equal(failure.next.includes('netns'), false);
    assert.equal(state.containers.size, 0);
});

test('subordinate-owned diagnostic data cleanup uses unshare on only its generated directory', async (t) => {
    const state = fixture(t, { override: ({ args }) => {
        if (args[0] === 'unshare' && args[1] === 'node') { fs.rmSync(args.at(-1), { recursive: true, force: true }); return pass(); }
    } });
    const result = await state.run({ fsApi: { ...fs, rmSync(file, options) {
        if (path.basename(file).startsWith('ploinky-diagnose-data-')) throw Object.assign(new Error('Subordinate ID owns child files'), { code: 'EACCES' });
        return fs.rmSync(file, options);
    } } });
    assert.equal(result.exitCode, 0);
    const cleanup = state.calls.find((call) => call.args[0] === 'unshare' && call.args[1] === 'node');
    assert.equal(cleanup.args.at(-1).startsWith(path.join(state.tempRoot, `ploinky-diagnose-data-${RUN_ID}-`)), true);
    assert.deepEqual(fs.readdirSync(state.tempRoot), []);
});
