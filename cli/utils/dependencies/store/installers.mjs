// Real installer adapters for immutable dependency objects.
//
// Both adapters are synchronous (the lifecycle callers are synchronous), run
// with a finite deadline, and keep only a bounded tail of installer output.
// The host adapter executes the exact probed node binary with the probed npm
// entry script, an isolated per-build npm cache and generated config, and an
// allowlisted environment. The container adapter runs the inspected immutable
// image ID (never the tag) under a unique container name so that quiescence can
// later be proven by the engine reporting the container absent.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { buildContainerInstallRunArgs, buildContainerInstallScript } from '../dependencyCache.js';
import { detectShellForImage, SHELL_FALLBACK_DIRECT } from '../../../sandbox/docker/shellDetection.js';
import { dependencyStoreError } from './canonical.mjs';
import { buildHostNpmEnv, renderNpmrc } from './npmPolicy.mjs';

export const DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_OUTPUT_LIMIT_BYTES = 64 * 1024;

function tmpRoot(env) {
    return env?.TMPDIR || os.tmpdir();
}

function readTail(file, limit, secrets = []) {
    let text = '';
    try {
        const stat = fs.statSync(file);
        const length = Math.min(stat.size, limit);
        const fd = fs.openSync(file, 'r');
        try {
            const buffer = Buffer.alloc(length);
            fs.readSync(fd, buffer, 0, length, stat.size - length);
            text = buffer.toString('utf8');
        } finally { fs.closeSync(fd); }
    } catch { /* no output */ }
    for (const secret of secrets) if (secret && secret.length >= 6) text = text.split(secret).join('[redacted]');
    return text;
}

function transportSecrets(transport) {
    return (transport?.npmrcLines || []).map((line) => line.slice(line.indexOf('=') + 1)).filter(Boolean);
}

function runBounded(command, args, { cwd, env, timeoutMs, outputLimitBytes, logFile, spawn, secrets }) {
    const fd = fs.openSync(logFile, 'w', 0o600);
    const started = Date.now();
    let result;
    try {
        result = spawn(command, args, { cwd, env, stdio: ['ignore', fd, fd], timeout: timeoutMs, killSignal: 'SIGKILL' });
    } finally {
        fs.closeSync(fd);
    }
    const outputTail = readTail(logFile, outputLimitBytes, secrets);
    fs.rmSync(logFile, { force: true });
    return { result, outputTail, durationMs: Date.now() - started };
}

function installFailure(kind, { result, outputTail, durationMs }, timeoutMs) {
    if (result?.error?.code === 'ETIMEDOUT' || result?.signal === 'SIGKILL' && durationMs >= timeoutMs) {
        return dependencyStoreError('PLOINKY_DEPS_INSTALL_TIMEOUT', `${kind} exceeded its ${Math.round(timeoutMs / 1000)}s deadline`, { outputTail });
    }
    if (result?.error) return dependencyStoreError('PLOINKY_DEPS_INSTALL_FAILED', `${kind} failed: ${result.error.code || result.error.message}`, { outputTail });
    return dependencyStoreError('PLOINKY_DEPS_INSTALL_FAILED', `${kind} exited with ${result?.status ?? result?.signal}`, { outputTail });
}

/**
 * @param {{ toolchain: object, policy: object, transport: object, env?: object, timeoutMs?: number,
 *   outputLimitBytes?: number, spawn?: Function, ceilingDirectories?: string[] }} options
 *   toolchain is the probe from defaultProbeHostToolchain (node.realpath, npm.realpath).
 */
export function createHostNpmInstaller({
    toolchain,
    policy,
    transport = null,
    env = process.env,
    timeoutMs = DEFAULT_INSTALL_TIMEOUT_MS,
    outputLimitBytes = DEFAULT_OUTPUT_LIMIT_BYTES,
    spawn = spawnSync,
    ceilingDirectories = [],
}) {
    if (!toolchain?.node?.realpath || !toolchain?.npm?.realpath) {
        throw dependencyStoreError('PLOINKY_DEPS_HOST_TOOLCHAIN_MISSING', 'host installer requires probed node and npm identities');
    }
    return Object.freeze({
        kind: 'host-npm',
        describe() {
            return { kind: 'host-npm', node: toolchain.node.realpath, npm: toolchain.npm.realpath, descendantsTracked: false };
        },
        install({ payloadDir, workDir, options = {} }) {
            const cacheDir = path.join(workDir, 'npm-cache');
            // Credentials and raw output never enter the workspace: they live in
            // a private temporary directory removed when the run ends.
            const privateDir = fs.mkdtempSync(path.join(tmpRoot(env), 'ploinky-npm-'));
            fs.chmodSync(privateDir, 0o700);
            const userconfig = path.join(privateDir, 'npmrc');
            const globalconfig = path.join(privateDir, 'global-npmrc');
            fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
            try {
                fs.writeFileSync(userconfig, renderNpmrc(policy, transport), { mode: 0o600 });
                fs.writeFileSync(globalconfig, '', { mode: 0o600 });
                const args = [toolchain.npm.realpath, ...policy.args,
                    ...(options.linkAgentLib || options.linkBoxMcpSdk ? ['--install-links=false'] : [])];
                const run = runBounded(toolchain.node.realpath, args, {
                    cwd: payloadDir,
                    env: buildHostNpmEnv({
                        env, policy, transport,
                        nodeBinDir: path.dirname(toolchain.node.realpath),
                        cacheDir, userconfig, globalconfig,
                        ceilingDirectories: [payloadDir, ...ceilingDirectories],
                    }),
                    timeoutMs,
                    outputLimitBytes,
                    logFile: path.join(privateDir, 'install.log'),
                    spawn,
                    secrets: transportSecrets(transport),
                });
                if (run.result?.error || run.result?.status !== 0) throw installFailure('host npm install', run, timeoutMs);
                return { durationMs: run.durationMs, outputTail: run.outputTail };
            } finally {
                fs.rmSync(privateDir, { recursive: true, force: true });
            }
        },
    });
}

export function containerInstallName(objectId) {
    return `ploinky-deps-${String(objectId).replace(/[^a-z0-9-]/gi, '')}`;
}

/**
 * @param {{ engine: string, imageId: string, timeoutMs?: number, outputLimitBytes?: number,
 *   spawn?: Function, detectShell?: Function }} options
 */
export function createContainerNpmInstaller({
    engine,
    imageId,
    timeoutMs = DEFAULT_INSTALL_TIMEOUT_MS,
    outputLimitBytes = DEFAULT_OUTPUT_LIMIT_BYTES,
    spawn = spawnSync,
    detectShell = detectShellForImage,
}) {
    if (!/^sha256:[0-9a-f]{64}$/.test(String(imageId || ''))) {
        throw dependencyStoreError('PLOINKY_DEPS_IMAGE_IDENTITY_REQUIRED', 'container installer requires an immutable image ID');
    }
    return Object.freeze({
        kind: 'container-npm',
        describe({ objectId }) {
            return { kind: 'container-npm', engine, imageId, containerName: containerInstallName(objectId) };
        },
        buildArgs({ payloadDir, objectId, options = {}, shellPath }) {
            const args = buildContainerInstallRunArgs({
                cwd: payloadDir,
                image: imageId,
                runtime: engine,
                shellPath,
                installScript: buildContainerInstallScript({
                    linkBoxMcpSdk: Boolean(options.linkBoxMcpSdk),
                    linkAgentLib: Boolean(options.linkAgentLib),
                }),
                agentLibSourceDir: options.agentLibSourceDir || null,
            });
            if (args[0] !== 'run') throw new Error('unexpected container install argv');
            return ['run', '--name', containerInstallName(objectId), ...args.slice(1)];
        },
        install({ payloadDir, workDir, objectId, options = {} }) {
            const shellPath = detectShell('deps-cache', imageId, engine);
            if (!shellPath || shellPath === SHELL_FALLBACK_DIRECT) {
                throw dependencyStoreError('PLOINKY_DEPS_INSTALL_FAILED', `could not determine a shell for image ${imageId}`);
            }
            const privateDir = fs.mkdtempSync(path.join(tmpRoot(process.env), 'ploinky-npm-'));
            let run;
            try {
                run = runBounded(engine, this.buildArgs({ payloadDir, objectId, options, shellPath }), {
                    cwd: workDir, env: process.env, timeoutMs, outputLimitBytes,
                    logFile: path.join(privateDir, 'install.log'), spawn, secrets: [],
                });
            } finally {
                fs.rmSync(privateDir, { recursive: true, force: true });
            }
            if (run.result?.error || run.result?.status !== 0) {
                // The client may die while the container keeps running; stop it
                // best effort. The build receipt still records the name, so the
                // object is retained until the engine reports it absent.
                spawn(engine, ['rm', '-f', containerInstallName(objectId)], { stdio: 'ignore', timeout: 30_000 });
                throw installFailure('container npm install', run, timeoutMs);
            }
            return { durationMs: run.durationMs, outputTail: run.outputTail };
        },
    });
}
