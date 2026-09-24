// Shared fixtures for the immutable dependency cache tests (not a test file).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

import {
    buildProviderContract,
    hostToolchainIdentity,
} from '../../cli/utils/dependencies/cacheV4/installContract.mjs';
import { containerNpmPolicy, resolveHostNpmPolicy } from '../../cli/utils/dependencies/cacheV4/npmPolicy.mjs';

export const HOST_RUNTIME_KEY = 'seatbelt-darwin-arm64-node25';
export const CONTAINER_RUNTIME_KEY = 'container-linux-x64-glibc-node20';

export function tempRoot(t, prefix = 'cachev4-') {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

export function makeAgentLib(root, { name = 'agentlib', fingerprint = 'fp-1', content = 'agentlib-v1' } = {}) {
    const sourceDir = path.join(root, name);
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'package.json'), JSON.stringify({ name: 'ploinky-agent-lib', version: '1.0.0' }));
    fs.writeFileSync(path.join(sourceDir, 'data.txt'), content);
    return { sourceDir, mode: 'local', fingerprint, commit: '', sourceIdHash: 'source-1' };
}

export function hostProbe(overrides = {}) {
    return {
        node: { realpath: '/fake/bin/node', size: 1, mtimeMs: 1, version: '25.8.0', modules: '141', napi: '10', v8: '13' },
        npm: { realpath: '/fake/lib/npm-cli.js', size: 1, mtimeMs: 1, sha256: 'a'.repeat(64), version: '11.11.0', builtinNpmrc: null },
        platform: 'darwin',
        arch: 'arm64',
        libc: '',
        glibc: '',
        tools: { python3: null, make: null, cc: null, 'c++': null, git: null },
        ...overrides,
    };
}

export function hostProvider({
    runtimeKey = HOST_RUNTIME_KEY,
    probe = hostProbe(),
    npmSources = { env: {}, files: [] },
    sdkBundle = null,
    agentLib,
} = {}) {
    return buildProviderContract({
        runtimeKey,
        toolchain: hostToolchainIdentity({ runtimeKey, probe }),
        npmPolicy: resolveHostNpmPolicy(npmSources).policy,
        sdkBundle,
        agentLib,
    });
}

export function containerProvider({ imageId, engine = 'podman', runtimeKey = CONTAINER_RUNTIME_KEY, sdkBundle = null, agentLib }) {
    return buildProviderContract({
        runtimeKey,
        toolchain: { kind: 'container', engine, imageId },
        npmPolicy: containerNpmPolicy(),
        sdkBundle,
        agentLib,
    });
}

export function fakeLease() {
    const lease = { token: crypto.randomUUID() };
    const assertLease = (candidate) => {
        if (candidate !== lease) {
            const error = new Error('workspace mutation requires its exact live workspace lease');
            error.code = 'PLOINKY_WORKSPACE_MUTATION_CAPABILITY_REQUIRED';
            throw error;
        }
        return candidate;
    };
    return { lease, assertLease };
}

const AGENTLIB_NAMES = new Set(['achillesAgentLib', 'ploinky-agent-lib']);

/**
 * Fake npm: for every (non-AgentLib) dependency writes node_modules/<name>
 * with a marker and a hidden lock. Git specs record `resolved` as given by
 * `resolveGit(name, spec)` (default: the spec itself when it names a full SHA).
 */
export function fakeInstaller({ marker = 'm1', resolveGit = null, extra = null, kind = 'fake-npm' } = {}) {
    const calls = [];
    return {
        kind,
        calls,
        describe() { return { kind }; },
        install({ payloadDir, options }) {
            calls.push({ payloadDir, options });
            const pkg = JSON.parse(fs.readFileSync(path.join(payloadDir, 'package.json'), 'utf8'));
            const nodeModules = path.join(payloadDir, 'node_modules');
            fs.mkdirSync(nodeModules, { recursive: true });
            const lock = { name: pkg.name || 'x', lockfileVersion: 3, requires: true, packages: {} };
            for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
                for (const [name, spec] of Object.entries(pkg[section] || {})) {
                    if (AGENTLIB_NAMES.has(name)) continue;
                    const dir = path.join(nodeModules, ...name.split('/'));
                    fs.mkdirSync(dir, { recursive: true });
                    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
                    fs.writeFileSync(path.join(dir, 'index.js'), `module.exports = ${JSON.stringify(`${name}:${marker}`)};\n`);
                    const entry = { version: '1.0.0' };
                    if (/^git\+|^github:/.test(String(spec))) {
                        entry.resolved = resolveGit ? resolveGit(name, spec) : spec;
                    } else {
                        entry.resolved = `https://registry.example/${name}/-/${name}-1.0.0.tgz`;
                    }
                    if (entry.resolved) lock.packages[`node_modules/${name}`] = entry;
                }
            }
            fs.writeFileSync(path.join(nodeModules, '.package-lock.json'), JSON.stringify(lock, null, 2));
            if (extra) extra({ payloadDir, options, pkg });
        },
    };
}

/** Deterministic local Git environment: no user/system config, fixed identity. */
export function gitEnv(home) {
    return {
        PATH: process.env.PATH,
        HOME: home,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
        GIT_TERMINAL_PROMPT: '0',
    };
}

export function git(cwd, args, env) {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
}

export function hasCommand(command) {
    return spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0;
}

/** A work repository plus bare remote whose commits share one package version. */
export function markerRemote(root, env) {
    const work = path.join(root, 'marker-src');
    const remote = path.join(root, 'marker-remote.git');
    fs.mkdirSync(work, { recursive: true });
    git(work, ['init', '-q', '-b', 'main'], env);
    fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'markerpkg', version: '1.0.0', main: 'index.js' }));
    fs.writeFileSync(path.join(work, 'index.js'), 'module.exports = "MARKER_ONE";\n');
    git(work, ['add', '-A'], env);
    git(work, ['commit', '-q', '-m', 'one'], env);
    const first = git(work, ['rev-parse', 'HEAD'], env);
    fs.writeFileSync(path.join(work, 'index.js'), 'module.exports = "MARKER_TWO";\n');
    git(work, ['commit', '-q', '-am', 'two'], env);
    const second = git(work, ['rev-parse', 'HEAD'], env);
    git(root, ['clone', '-q', '--bare', work, remote], env);
    git(remote, ['update-ref', 'refs/heads/main', first], env);
    // Keep the second commit reachable for clones while main points at the first.
    git(remote, ['update-ref', 'refs/heads/next', second], env);
    return { work, remote, first, second, url: `git+file://${remote}` };
}
