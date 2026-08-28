#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SAFE_STEP = /^[a-z0-9][a-z0-9-]*$/;
const FULL_SHA = /^[a-f0-9]{40}$/;
const SENSITIVE_ENVIRONMENT_NAME = /(?:auth|cookie|credential|key|pass|secret|token)/i;

const FEATURE_REQUIRED_FILES = Object.freeze([
    'fixture-state.env',
    'fixture-state.env.command.txt',
    'cleanup-state.env',
    'cleanup-state.env.command.txt',
    'playwright/command.txt',
    'playwright/runner-state.txt',
    'playwright/gate-result.json',
    'playwright/console.log',
    'playwright/test-results/results.json',
]);

const RELEASE_REQUIRED_FILES = Object.freeze([
    'fixture-state.env',
    'fixture-state.env.command.txt',
    'cleanup-state.env',
    'cleanup-state.env.command.txt',
    'attestation-readiness.txt',
    'attestation-readiness.txt.command.txt',
    'release-manifest.json',
    'post-gate-cleanup-audit.txt',
    ...['deployment', 'onlyoffice', 'copilot', 'webmeet'].flatMap((step) => [
        `${step}/command.txt`,
        `${step}/runner-state.txt`,
        `${step}/gate-result.json`,
        `${step}/console.log`,
    ]),
    ...['onlyoffice', 'copilot', 'webmeet'].map(
        (step) => `${step}/test-results/results.json`,
    ),
]);

function evidenceError(message) {
    const error = new Error(message);
    error.code = 'NO_WAIT_EVIDENCE_INVALID';
    return error;
}

function exactAbsolutePath(value, label) {
    const text = String(value || '').trim();
    if (!text || !path.isAbsolute(text)) {
        throw evidenceError(`${label} must be one absolute path`);
    }
    return path.resolve(text);
}

function exactRelativePath(value, label) {
    const text = String(value || '').trim();
    if (!text || path.isAbsolute(text) || text === '..' || text.startsWith(`..${path.sep}`)) {
        throw evidenceError(`${label} must stay inside the evidence bundle`);
    }
    const normalized = path.normalize(text);
    if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
        throw evidenceError(`${label} must stay inside the evidence bundle`);
    }
    return normalized;
}

function ensureDirectory(target) {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw evidenceError(`evidence directory '${target}' is not one real directory`);
    }
}

function writeExclusive(target, content) {
    const output = exactAbsolutePath(target, 'evidence output');
    ensureDirectory(path.dirname(output));
    let descriptor;
    try {
        descriptor = fs.openSync(output, 'wx', 0o600);
        fs.writeFileSync(descriptor, content, { encoding: 'utf8' });
        fs.fsyncSync(descriptor);
    } catch (error) {
        if (error?.code === 'EEXIST') {
            throw evidenceError(`evidence output '${output}' already exists`);
        }
        throw error;
    } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
    }
    return output;
}

function publishTemporaryFile(temporary, output) {
    try {
        fs.linkSync(temporary, output);
    } catch (error) {
        if (error?.code === 'EEXIST') {
            throw evidenceError(`evidence output '${output}' already exists`);
        }
        throw error;
    } finally {
        fs.unlinkSync(temporary);
    }
}

function assertNonEmptyFile(target, label = 'evidence artifact') {
    let stat;
    try {
        stat = fs.lstatSync(target);
    } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
            throw evidenceError(`${label} '${target}' is missing`);
        }
        throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
        throw evidenceError(`${label} '${target}' must be one non-empty regular file`);
    }
    const content = fs.readFileSync(target);
    const hasNonWhitespace = content.some((byte) => ![9, 10, 13, 32].includes(byte));
    if (!hasNonWhitespace) {
        throw evidenceError(`${label} '${target}' must not contain only whitespace`);
    }
    return stat;
}

function sanitizeRemoteOutput(value) {
    return String(value).replace(
        /https?:\/\/[^/@\s]+@/gi,
        (match) => `${match.slice(0, match.indexOf('//') + 2)}<redacted>@`,
    );
}

function environmentRecord(env) {
    const selected = {};
    const redactedNames = [];
    const sensitiveValues = [];
    for (const name of Object.keys(env).sort()) {
        const value = String(env[name] ?? '');
        if (SENSITIVE_ENVIRONMENT_NAME.test(name)) {
            if (value.length >= 4) sensitiveValues.push(value);
            if (name.startsWith('SMOKE_')) {
                selected[name] = '<redacted>';
                redactedNames.push(name);
            }
        } else if (name.startsWith('SMOKE_')) {
            selected[name] = value;
        }
    }
    return { selected, redactedNames, sensitiveValues };
}

function redactCommand(command, sensitiveValues) {
    return command.map((rawArgument) => {
        let argument = String(rawArgument);
        for (const value of sensitiveValues) {
            argument = argument.split(value).join('<redacted>');
        }
        return argument;
    });
}

function commandRecord({ command, cwd, env = process.env }) {
    if (!Array.isArray(command) || command.length === 0 || !String(command[0]).trim()) {
        throw evidenceError('evidence capture requires one exact command argv');
    }
    const environment = environmentRecord(env);
    return `${JSON.stringify({
        schemaVersion: 1,
        kind: 'no-wait-gate-command',
        recordedAt: new Date().toISOString(),
        cwd: exactAbsolutePath(cwd, 'command cwd'),
        argv: redactCommand(command, environment.sensitiveValues),
        smokeEnvironment: environment.selected,
        redactedEnvironmentNames: environment.redactedNames,
    }, null, 2)}\n`;
}

function runGit(repositoryRoot, args) {
    const result = spawnSync('git', ['-C', repositoryRoot, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw evidenceError(
            `git ${args.join(' ')} failed for '${repositoryRoot}': ${String(result.stderr || '').trim()}`,
        );
    }
    return String(result.stdout || '').replace(/\s+$/, '');
}

export function inspectRunnerState({
    runnerRoot,
    expectedSha,
    remoteName,
    expectedRemoteUrl,
    expectedRef,
}) {
    const root = exactAbsolutePath(runnerRoot, 'runner root');
    if (!FULL_SHA.test(String(expectedSha || ''))) {
        throw evidenceError('expected runner SHA must be one full lowercase commit SHA');
    }
    const exactRemoteName = String(remoteName || '').trim();
    const exactRemoteUrl = String(expectedRemoteUrl || '').trim();
    const exactExpectedRef = String(expectedRef || '').trim();
    if (!exactRemoteName || !exactRemoteUrl) {
        throw evidenceError('runner evidence requires one named canonical remote and exact URL');
    }
    if (/https?:\/\/[^/@\s]+@/i.test(exactRemoteUrl)) {
        throw evidenceError('expected canonical remote URL must not contain credentials');
    }
    if (!exactExpectedRef.startsWith(`refs/remotes/${exactRemoteName}/`)) {
        throw evidenceError('expected runner ref must be one canonical remote-tracking ref');
    }
    const inside = runGit(root, ['rev-parse', '--is-inside-work-tree']);
    if (inside !== 'true') throw evidenceError(`runner root '${root}' is not a Git worktree`);

    const head = runGit(root, ['rev-parse', 'HEAD']);
    const branch = runGit(root, ['branch', '--show-current']);
    const statusShort = runGit(root, ['status', '--short']);
    const actualRemoteUrl = runGit(root, ['remote', 'get-url', exactRemoteName]);
    const remoteDefaultSha = runGit(root, ['rev-parse', exactExpectedRef]);
    const remotes = runGit(root, ['remote', '-v']);
    const failures = [];
    if (head !== expectedSha) failures.push(`HEAD '${head}' does not equal expected SHA '${expectedSha}'`);
    if (statusShort) failures.push('runner worktree is not clean');
    if (actualRemoteUrl !== exactRemoteUrl) {
        failures.push(`remote '${exactRemoteName}' does not equal expected URL '${exactRemoteUrl}'`);
    }
    if (remoteDefaultSha !== expectedSha) {
        failures.push(`remote-default ref '${exactExpectedRef}' is '${remoteDefaultSha}', not '${expectedSha}'`);
    }
    const text = [
        'schema-version=1',
        `recorded-at=${new Date().toISOString()}`,
        `repository-root=${root}`,
        `expected-sha=${expectedSha}`,
        `expected-remote-name=${exactRemoteName}`,
        `expected-remote-url=${exactRemoteUrl}`,
        `expected-remote-ref=${exactExpectedRef}`,
        `verdict=${failures.length === 0 ? 'PASS' : 'FAIL'}`,
        '',
        '$ git rev-parse HEAD',
        head,
        '',
        '$ git branch --show-current',
        branch || '<detached>',
        '',
        '$ git status --short',
        statusShort,
        '',
        `$ git rev-parse ${exactExpectedRef}`,
        remoteDefaultSha,
        '',
        '$ git remote -v',
        sanitizeRemoteOutput(remotes),
        '',
    ].join('\n');
    return Object.freeze({
        root,
        head,
        branch,
        statusShort,
        actualRemoteUrl,
        remoteDefaultSha,
        failures,
        text,
    });
}

function waitForChild(child) {
    return new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code: code ?? 1, signal: signal || '' }));
    });
}

async function runCapturedCommand({
    command,
    cwd,
    env,
    outputPath,
    forward = true,
    combineStderr = true,
}) {
    const output = exactAbsolutePath(outputPath, 'captured command output');
    ensureDirectory(path.dirname(output));
    if (fs.existsSync(output)) throw evidenceError(`evidence output '${output}' already exists`);
    const temporary = `${output}.tmp-${process.pid}-${Date.now()}`;
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    let result;
    try {
        const child = spawn(String(command[0]), command.slice(1).map(String), {
            cwd,
            env,
            stdio: ['inherit', 'pipe', 'pipe'],
        });
        child.stdout.on('data', (chunk) => {
            fs.writeSync(descriptor, chunk);
            if (forward) process.stdout.write(chunk);
        });
        child.stderr.on('data', (chunk) => {
            if (combineStderr) fs.writeSync(descriptor, chunk);
            if (forward) process.stderr.write(chunk);
        });
        result = await waitForChild(child);
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
    return { ...result, output, temporary };
}

export async function captureRequiredState({
    outputPath,
    command,
    cwd = process.cwd(),
    env = process.env,
}) {
    const output = exactAbsolutePath(outputPath, 'state evidence output');
    const commandPath = `${output}.command.txt`;
    if (fs.existsSync(output) || fs.existsSync(commandPath)) {
        throw evidenceError(`state evidence '${output}' already exists`);
    }
    writeExclusive(commandPath, commandRecord({ command, cwd, env }));
    const result = await runCapturedCommand({
        command,
        cwd,
        env,
        outputPath: output,
        forward: true,
        combineStderr: false,
    });
    if (result.code !== 0 || result.signal) {
        const failedPath = `${output}.failed.txt`;
        publishTemporaryFile(result.temporary, failedPath);
        throw evidenceError(
            `state capture command failed with ${result.signal ? `signal ${result.signal}` : `exit ${result.code}`}`,
        );
    }
    const stat = fs.lstatSync(result.temporary);
    const captured = stat.isFile() && stat.size > 0
        ? fs.readFileSync(result.temporary, 'utf8')
        : '';
    if (!stat.isFile() || stat.size === 0 || !captured.trim()) {
        fs.unlinkSync(result.temporary);
        throw evidenceError(`state capture for '${output}' produced an empty artifact`);
    }
    publishTemporaryFile(result.temporary, output);
    assertNonEmptyFile(output, 'state evidence');
    return output;
}

function requiredBundleArtifact(bundleDir, relative) {
    const root = exactAbsolutePath(bundleDir, 'evidence bundle directory');
    const safeRelative = exactRelativePath(relative, 'required artifact');
    const target = path.join(root, safeRelative);
    assertNonEmptyFile(target, 'required evidence artifact');
    return target;
}

export async function runEvidenceStep({
    bundleDir,
    kind,
    step,
    runnerRoot,
    expectedSha,
    remoteName,
    expectedRemoteUrl,
    expectedRef,
    requiredArtifacts = [],
    command,
    cwd = process.cwd(),
    env = process.env,
}) {
    const root = exactAbsolutePath(bundleDir, 'evidence bundle directory');
    const automaticRequirements = kind === 'feature'
        ? ['fixture-state.env']
        : kind === 'release'
            ? ['fixture-state.env', 'attestation-readiness.txt']
            : kind === 'deployment' ? ['fixture-state.env'] : null;
    if (!automaticRequirements) {
        throw evidenceError("evidence step kind must be 'feature', 'deployment', or 'release'");
    }
    if (!SAFE_STEP.test(String(step || ''))) {
        throw evidenceError('evidence step must use lowercase letters, digits, and hyphens');
    }
    ensureDirectory(root);
    const allRequiredArtifacts = [...new Set([...automaticRequirements, ...requiredArtifacts])];
    for (const relative of allRequiredArtifacts) requiredBundleArtifact(root, relative);

    const stepDirectory = path.join(root, step);
    ensureDirectory(stepDirectory);
    const commandPath = path.join(stepDirectory, 'command.txt');
    const runnerPath = path.join(stepDirectory, 'runner-state.txt');
    const consolePath = path.join(stepDirectory, 'console.log');
    const resultPath = path.join(stepDirectory, 'gate-result.json');
    for (const target of [commandPath, runnerPath, consolePath, resultPath]) {
        if (fs.existsSync(target)) throw evidenceError(`evidence output '${target}' already exists`);
    }

    if (kind !== 'deployment') {
        const runId = String(env.SMOKE_RUN_ID || '').trim();
        const smokeArtifactDirectory = exactAbsolutePath(
            env.SMOKE_ARTIFACT_DIR,
            'SMOKE_ARTIFACT_DIR',
        );
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
            throw evidenceError('SMOKE_RUN_ID must be one non-secret run identifier');
        }
        if (smokeArtifactDirectory !== stepDirectory) {
            throw evidenceError(
                `SMOKE_ARTIFACT_DIR '${smokeArtifactDirectory}' must equal gate evidence directory '${stepDirectory}'`,
            );
        }
    }

    writeExclusive(commandPath, commandRecord({ command, cwd, env }));
    const runner = inspectRunnerState({
        runnerRoot,
        expectedSha,
        remoteName,
        expectedRemoteUrl,
        expectedRef,
    });
    writeExclusive(runnerPath, runner.text);
    if (runner.failures.length > 0) {
        throw evidenceError(`runner assertion failed: ${runner.failures.join('; ')}`);
    }

    const startedAt = new Date().toISOString();
    const result = await runCapturedCommand({
        command,
        cwd: exactAbsolutePath(cwd, 'gate command cwd'),
        env,
        outputPath: consolePath,
        forward: true,
    });
    publishTemporaryFile(result.temporary, consolePath);
    writeExclusive(resultPath, `${JSON.stringify({
        schemaVersion: 1,
        kind: 'no-wait-evidence-step-result',
        step,
        startedAt,
        completedAt: new Date().toISOString(),
        exitCode: result.code,
        signal: result.signal || null,
        runnerSha: runner.head,
    }, null, 2)}\n`);

    assertNonEmptyFile(commandPath, 'gate command evidence');
    assertNonEmptyFile(runnerPath, 'gate runner evidence');
    for (const relative of allRequiredArtifacts) requiredBundleArtifact(root, relative);
    if (result.code !== 0 || result.signal) {
        throw evidenceError(
            `evidence step '${step}' failed with ${result.signal ? `signal ${result.signal}` : `exit ${result.code}`}`,
        );
    }
    assertNonEmptyFile(consolePath, 'gate console evidence');
    return Object.freeze({ stepDirectory, runnerSha: runner.head, exitCode: result.code });
}

function assertPassingResult(target) {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (parsed?.kind !== 'no-wait-evidence-step-result' || parsed.exitCode !== 0 || parsed.signal) {
        throw evidenceError(`gate result '${target}' is not one passing evidence-step result`);
    }
}

export function verifyNoWaitEvidenceBundle({ bundleDir, kind }) {
    const root = exactAbsolutePath(bundleDir, 'evidence bundle directory');
    const required = kind === 'feature'
        ? FEATURE_REQUIRED_FILES
        : kind === 'release' ? RELEASE_REQUIRED_FILES : null;
    if (!required) throw evidenceError("evidence bundle kind must be 'feature' or 'release'");
    const resolved = required.map((relative) => requiredBundleArtifact(root, relative));
    for (const target of resolved.filter((entry) => entry.endsWith(`${path.sep}gate-result.json`))) {
        assertPassingResult(target);
    }
    return Object.freeze({ kind, bundleDir: root, requiredFiles: [...required] });
}

export function recordLatchedIntegrationPass({ outputPath, repositoryRoot }) {
    const root = exactAbsolutePath(repositoryRoot, 'repository root');
    const head = runGit(root, ['rev-parse', 'HEAD']);
    const branch = runGit(root, ['branch', '--show-current']);
    const statusShort = runGit(root, ['status', '--short']);
    if (!FULL_SHA.test(head)) throw evidenceError(`repository HEAD '${head}' is not one full commit SHA`);
    if (statusShort) {
        throw evidenceError('latched integration pass evidence requires a clean repository status');
    }
    return writeExclusive(outputPath, `${JSON.stringify({
        schemaVersion: 1,
        kind: 'no-wait-live-latched-integration-pass',
        recordedAt: new Date().toISOString(),
        repositoryRoot: root,
        branch: branch || null,
        gitRevParseHead: head,
        gitStatusShort: statusShort,
        test: 'fast_test_latched_no_wait_loading_transition',
        result: 'PASS',
    }, null, 2)}\n`);
}

function parseOptions(args) {
    const options = new Map();
    const commandIndex = args.indexOf('--');
    const optionArgs = commandIndex === -1 ? args : args.slice(0, commandIndex);
    const command = commandIndex === -1 ? [] : args.slice(commandIndex + 1);
    for (let index = 0; index < optionArgs.length; index += 2) {
        const name = optionArgs[index];
        const value = optionArgs[index + 1];
        if (!name?.startsWith('--') || value === undefined) {
            throw evidenceError(`invalid option near '${name || ''}'`);
        }
        const values = options.get(name) || [];
        values.push(value);
        options.set(name, values);
    }
    return {
        one(name, fallback = '') {
            const values = options.get(name) || [];
            if (values.length > 1) throw evidenceError(`option '${name}' may be supplied only once`);
            return values[0] ?? fallback;
        },
        many(name) {
            return [...(options.get(name) || [])];
        },
        command,
    };
}

async function main(argv) {
    const [subcommand, ...rest] = argv;
    const parsed = parseOptions(rest);
    if (subcommand === 'capture') {
        if (parsed.command.length === 0) throw evidenceError("'capture' requires a command after '--'");
        const output = await captureRequiredState({
            outputPath: parsed.one('--output'),
            cwd: parsed.one('--cwd', process.cwd()),
            command: parsed.command,
        });
        process.stdout.write(`captured=${output}\n`);
        return;
    }
    if (subcommand === 'run') {
        if (parsed.command.length === 0) throw evidenceError("'run' requires a gate command after '--'");
        const result = await runEvidenceStep({
            bundleDir: parsed.one('--bundle-dir'),
            kind: parsed.one('--kind'),
            step: parsed.one('--step'),
            runnerRoot: parsed.one('--runner-root'),
            expectedSha: parsed.one('--expected-sha'),
            remoteName: parsed.one('--remote-name'),
            expectedRemoteUrl: parsed.one('--expected-remote-url'),
            expectedRef: parsed.one('--expected-ref'),
            requiredArtifacts: parsed.many('--require'),
            cwd: parsed.one('--cwd', process.cwd()),
            command: parsed.command,
        });
        process.stdout.write(`runner-sha=${result.runnerSha}\n`);
        return;
    }
    if (subcommand === 'verify') {
        const result = verifyNoWaitEvidenceBundle({
            bundleDir: parsed.one('--bundle-dir'),
            kind: parsed.one('--kind'),
        });
        process.stdout.write(`verified=${result.kind}:${result.requiredFiles.length}\n`);
        return;
    }
    if (subcommand === 'record-latch-pass') {
        const output = recordLatchedIntegrationPass({
            outputPath: parsed.one('--output'),
            repositoryRoot: parsed.one('--repo-root'),
        });
        process.stdout.write(`recorded=${output}\n`);
        return;
    }
    throw evidenceError(
        "usage: noWaitLoadingEvidence.mjs <capture|run|verify|record-latch-pass> [options]",
    );
}

const isMain = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
    main(process.argv.slice(2)).catch((error) => {
        process.stderr.write(`no-wait evidence error: ${error?.message || String(error)}\n`);
        process.exitCode = 1;
    });
}
