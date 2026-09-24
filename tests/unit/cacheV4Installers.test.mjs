import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createContainerNpmInstaller, createHostNpmInstaller, containerInstallName } from '../../cli/utils/dependencies/cacheV4/installers.mjs';
import { buildHostNpmEnv, resolveHostNpmPolicy } from '../../cli/utils/dependencies/cacheV4/npmPolicy.mjs';
import { hashInstalledTree } from '../../cli/utils/dependencies/cacheV4/treeHash.mjs';
import {
    defaultProveBuildQuiescent,
    defaultProveReaderQuiescent,
    processIdentityEnded,
} from '../../cli/utils/dependencies/cacheV4/receipts.mjs';
import { hostProbe, tempRoot } from './cacheV4Fixtures.mjs';

const IMAGE = `sha256:${'a'.repeat(64)}`;
const OBJECT_ID = '11111111-2222-4333-8444-555555555555';

test('cache-v4 installers: the host adapter runs the probed node/npm with an isolated, allowlisted environment', (t) => {
    const root = tempRoot(t);
    const payloadDir = path.join(root, 'payload');
    const workDir = path.join(root, 'work');
    fs.mkdirSync(payloadDir);
    fs.mkdirSync(workDir);
    const { policy, transport } = resolveHostNpmPolicy({
        env: { NODE_ENV: 'production' },
        files: [{ path: '/u/.npmrc', text: '//registry.example/:_authToken=super-secret-token\n' }],
    });
    let seen = null;
    const spawn = (command, args, options) => {
        const npmrc = fs.readFileSync(options.env.npm_config_userconfig, 'utf8');
        seen = { command, args, options, npmrc, mode: fs.statSync(options.env.npm_config_userconfig).mode & 0o777 };
        fs.writeSync(options.stdio[1], 'x'.repeat(5000) + ' leaked super-secret-token\n');
        return { status: 0 };
    };
    const installer = createHostNpmInstaller({
        toolchain: hostProbe(),
        policy,
        transport,
        env: { PATH: '/usr/bin', HOME: '/home/u', NODE_OPTIONS: '--require /evil.js', npm_config_registry: 'https://ambient.example/', SSH_AUTH_SOCK: '/tmp/agent', SECRET_API_KEY: 'x' },
        outputLimitBytes: 128,
        spawn,
    });
    const result = installer.install({ payloadDir, workDir, options: { linkAgentLib: true } });
    assert.equal(seen.command, '/fake/bin/node');
    assert.deepEqual(seen.args, ['/fake/lib/npm-cli.js', 'install', '--no-package-lock', '--no-audit', '--no-fund', '--update-notifier=false', '--install-links=false']);
    assert.equal(seen.options.cwd, payloadDir);
    assert.equal(seen.options.env.NODE_OPTIONS, undefined, 'NODE_OPTIONS is not inherited');
    assert.equal(seen.options.env.SECRET_API_KEY, undefined, 'unrelated variables are not inherited');
    assert.equal(seen.options.env.npm_config_registry, undefined, 'ambient npm config is replaced by the explicit contract');
    assert.equal(seen.options.env.SSH_AUTH_SOCK, '/tmp/agent', 'transport variables pass through');
    assert.equal(seen.options.env.NODE_ENV, 'production');
    assert.equal(seen.options.env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(seen.options.env.npm_config_cache, path.join(workDir, 'npm-cache'));
    assert.equal(seen.options.env.PATH.split(path.delimiter)[0], '/fake/bin', 'the probed node directory is first on PATH');
    assert.match(seen.npmrc, /omit\[\]=dev/);
    assert.match(seen.npmrc, /\/\/registry\.example\/:_authToken=super-secret-token/);
    assert.equal(seen.mode, 0o600);
    const userconfig = seen.options.env.npm_config_userconfig;
    assert.equal(userconfig.startsWith(workDir) || userconfig.startsWith(payloadDir), false, 'credentials never enter the workspace object');
    assert.equal(fs.existsSync(path.dirname(userconfig)), false, 'the private credential directory is removed after the run');
    assert.deepEqual(fs.readdirSync(workDir), ['npm-cache'], 'only the isolated npm cache is kept in the object work area');
    assert.ok(result.outputTail.length <= 128);
    assert.equal(result.outputTail.includes('super-secret-token'), false, 'credential values are redacted from output');
});

test('cache-v4 installers: host install failures and deadlines are named', (t) => {
    const root = tempRoot(t);
    fs.mkdirSync(path.join(root, 'work'));
    const { policy } = resolveHostNpmPolicy({ env: {}, files: [] });
    const failing = createHostNpmInstaller({ toolchain: hostProbe(), policy, spawn: () => ({ status: 1 }) });
    assert.throws(() => failing.install({ payloadDir: root, workDir: path.join(root, 'work') }), { code: 'PLOINKY_DEPS_INSTALL_FAILED' });
    const slow = createHostNpmInstaller({ toolchain: hostProbe(), policy, timeoutMs: 5, spawn: () => ({ status: null, signal: 'SIGKILL', error: { code: 'ETIMEDOUT' } }) });
    assert.throws(() => slow.install({ payloadDir: root, workDir: path.join(root, 'work') }), { code: 'PLOINKY_DEPS_INSTALL_TIMEOUT' });
});

test('cache-v4 installers: the container adapter runs the immutable image ID under a unique name', (t) => {
    const root = tempRoot(t);
    fs.mkdirSync(path.join(root, 'work'));
    const calls = [];
    const installer = createContainerNpmInstaller({
        engine: 'podman',
        imageId: IMAGE,
        detectShell: (_agent, image) => { assert.equal(image, IMAGE); return '/bin/sh'; },
        spawn: (command, args) => { calls.push([command, args]); return { status: calls.length === 1 ? 1 : 0 }; },
    });
    assert.deepEqual(installer.describe({ objectId: OBJECT_ID }), {
        kind: 'container-npm', engine: 'podman', imageId: IMAGE, containerName: containerInstallName(OBJECT_ID),
    });
    const args = installer.buildArgs({ payloadDir: '/cache/payload', objectId: OBJECT_ID, options: { linkAgentLib: true, agentLibSourceDir: '/src/agentlib' }, shellPath: '/bin/sh' });
    assert.deepEqual(args.slice(0, 4), ['run', '--name', `ploinky-deps-${OBJECT_ID}`, '--rm']);
    assert.ok(args.includes(IMAGE), 'the image ID, not a tag, is run');
    assert.ok(args.includes('/cache/payload:/install:z'));
    assert.ok(args.includes('/src/agentlib:/opt/ploinky-agentlib:ro'));
    assert.throws(() => installer.install({ payloadDir: '/cache/payload', workDir: path.join(root, 'work'), objectId: OBJECT_ID }), { code: 'PLOINKY_DEPS_INSTALL_FAILED' });
    assert.deepEqual(calls[1], ['podman', ['rm', '-f', `ploinky-deps-${OBJECT_ID}`]], 'a failed install stops its named container');
    assert.throws(() => createContainerNpmInstaller({ engine: 'podman', imageId: 'node:20' }), { code: 'PLOINKY_DEPS_IMAGE_IDENTITY_REQUIRED' });
});

test('cache-v4 tree: hashes paths, bytes, exec bit and symlink text without following links', (t) => {
    const root = tempRoot(t);
    const payload = path.join(root, 'payload');
    const external = path.join(root, 'agentlib');
    fs.mkdirSync(path.join(payload, 'node_modules', 'a', 'bin'), { recursive: true });
    fs.mkdirSync(external);
    fs.writeFileSync(path.join(payload, 'node_modules', 'a', 'index.js'), 'one');
    fs.writeFileSync(path.join(payload, 'node_modules', 'a', 'bin', 'cli'), '#!/bin/sh\n');
    fs.symlinkSync(external, path.join(payload, 'node_modules', 'achillesAgentLib'));
    fs.symlinkSync('../a/bin/cli', path.join(payload, 'node_modules', 'a', 'link'));
    const hash = () => hashInstalledTree(payload, { approvedExternalTargets: [external] }).hash;
    const base = hash();
    fs.writeFileSync(path.join(external, 'changed.txt'), 'x');
    assert.equal(hash(), base, 'approved provider links are not followed');
    fs.chmodSync(path.join(payload, 'node_modules', 'a', 'bin', 'cli'), 0o755);
    const exec = hash();
    assert.notEqual(exec, base);
    fs.utimesSync(path.join(payload, 'node_modules', 'a', 'index.js'), new Date(0), new Date(0));
    assert.equal(hash(), exec, 'timestamps are not identity');
    fs.mkdirSync(path.join(payload, 'node_modules', 'empty'));
    assert.notEqual(hash(), exec, 'empty directories are part of the tree');
    assert.throws(() => hashInstalledTree(payload, { approvedExternalTargets: [] }), { code: 'PLOINKY_DEPS_TREE_UNSAFE' });
    fs.symlinkSync('../../../outside', path.join(payload, 'node_modules', 'escape'));
    assert.throws(() => hashInstalledTree(payload, { approvedExternalTargets: [external] }), /escapes the payload/);
    fs.rmSync(path.join(payload, 'node_modules', 'escape'));
    fs.chmodSync(path.join(payload, 'node_modules', 'a', 'index.js'), 0o4755);
    if ((fs.statSync(path.join(payload, 'node_modules', 'a', 'index.js')).mode & 0o4000) !== 0) {
        assert.throws(() => hashInstalledTree(payload, { approvedExternalTargets: [external] }), /setuid/);
    }
});

test('cache-v4 receipts: PID absence proves quiescence only in the same boot scope', () => {
    const identity = { pid: 4242, processStart: 'start-a', bootScope: 'scope-1' };
    assert.equal(processIdentityEnded(identity, { bootScope: 'scope-1', isAlive: () => false }).ended, true);
    assert.equal(processIdentityEnded(identity, { bootScope: 'scope-2', isAlive: () => false }).ended, false, 'another boot/namespace is unknown');
    assert.equal(processIdentityEnded(identity, { bootScope: '', isAlive: () => false }).ended, false);
    assert.equal(processIdentityEnded(identity, { bootScope: 'scope-1', isAlive: () => true, startIdentity: () => 'start-a' }).ended, false);
    assert.equal(processIdentityEnded(identity, { bootScope: 'scope-1', isAlive: () => true, startIdentity: () => 'start-b' }).ended, true, 'PID reuse');
    const dead = { bootScope: 'scope-1', isAlive: () => false };
    const container = { writer: identity, installerStarted: true, installer: { kind: 'container-npm', engine: 'podman', containerName: 'ploinky-deps-x' } };
    assert.equal(defaultProveBuildQuiescent(container, { ...dead, inspectContainer: () => 'present' }).quiescent, false);
    assert.equal(defaultProveBuildQuiescent(container, { ...dead, inspectContainer: () => 'unknown' }).quiescent, false, 'engine unavailable means retain');
    assert.equal(defaultProveBuildQuiescent(container, { ...dead, inspectContainer: () => 'absent' }).quiescent, true);
    const host = { writer: identity, installerStarted: true, installer: { kind: 'host-npm' } };
    assert.equal(defaultProveBuildQuiescent(host, dead).quiescent, false, 'host npm descendants are not tracked');
    assert.equal(defaultProveBuildQuiescent(host, { ...dead, proveHostInstaller: () => ({ quiescent: true }) }).quiescent, true);
    assert.equal(defaultProveReaderQuiescent({ consumer: { kind: 'attachment' } }).quiescent, false, 'unprovable consumers are retained');
    assert.equal(defaultProveReaderQuiescent({ consumer: { kind: 'container', engine: 'podman', containerId: 'abc' } }, { inspectContainer: () => 'absent' }).quiescent, true);
});

test('cache-v4 npm env: explicit isolated config paths override any inherited value', () => {
    const { policy, transport } = resolveHostNpmPolicy({ env: {}, files: [] });
    const env = buildHostNpmEnv({
        env: { PATH: '/a:/fake/bin:/b', HOME: '/h', npm_config_cache: '/ambient', NODE_ENV: 'development' },
        policy, transport, nodeBinDir: '/fake/bin', cacheDir: '/w/cache', userconfig: '/w/npmrc', globalconfig: '/w/g',
    });
    assert.equal(env.PATH, '/fake/bin:/a:/b');
    assert.equal(env.npm_config_cache, '/w/cache');
    assert.equal(env.NODE_ENV, undefined, 'NODE_ENV only when represented in the keyed policy');
});

test('host sandbox receipts in their production shape are proven through their process, not as containers', () => {
    // bwrap/seatbelt consumers carry their registration's container name but
    // no engine; they must not be misread as containers and retained forever.
    const consumer = (pid) => ({
        kind: 'bwrap-service',
        key: 'bwrap:ploinky_repo_agent:instance:1',
        containerName: 'ploinky_repo_agent',
        registration: 'ploinky_repo_agent',
        phase: 'running',
        process: { pid, processStart: 'start-1', bootScope: 'scope-a' },
    });
    let inspected = 0;
    const inspectContainer = () => { inspected += 1; return 'unknown'; };
    const ended = defaultProveReaderQuiescent({ consumer: consumer(4242) }, {
        inspectContainer, bootScope: 'scope-a', isAlive: () => false,
    });
    assert.equal(ended.quiescent, true);
    const alive = defaultProveReaderQuiescent({ consumer: consumer(4242) }, {
        inspectContainer, bootScope: 'scope-a', isAlive: () => true, startIdentity: () => 'start-1',
    });
    assert.equal(alive.quiescent, false);
    const otherScope = defaultProveReaderQuiescent({ consumer: consumer(4242) }, {
        inspectContainer, bootScope: 'scope-b', isAlive: () => false,
    });
    assert.equal(otherScope.quiescent, false, 'a different boot/PID namespace is never proof');
    assert.equal(inspected, 0, 'no engine inspection for sandbox consumers');
});
