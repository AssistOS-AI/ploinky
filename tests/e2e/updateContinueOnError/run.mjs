#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { sanitizeGitDiagnostic } from '../../../cli/utils/gitCommand.js';
import { buildWorkspaceIdentity } from '../../../ploinky-box/identity.mjs';
import { createMutationLockManager } from '../../../ploinky-box/locks.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const expectedWorkspace = path.join(os.homedir(), 'work', 'testExplorerFresh');
const usage = 'Usage: node tests/e2e/updateContinueOnError/run.mjs --workspace ~/work/testExplorerFresh --artifacts /absolute/new/artifact-directory [--ploinky /absolute/candidate/bin/ploinky] [--timeout-ms 1200000]';

function parseArgs(args) {
    if (args.length === 1 && args[0] === '--help') return null;
    const values = {};
    for (let index = 0; index < args.length; index += 2) {
        const name = args[index];
        if (!['--workspace', '--artifacts', '--ploinky', '--timeout-ms'].includes(name)
            || Object.hasOwn(values, name) || !args[index + 1] || args[index + 1].startsWith('--')) {
            throw new Error(usage);
        }
        values[name] = args[index + 1];
    }
    if (!values['--workspace'] || !values['--artifacts']) throw new Error(usage);
    const timeoutMs = Number(values['--timeout-ms'] || 1_200_000);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 3_600_000) {
        throw new Error('--timeout-ms must be an integer between 1000 and 3600000.');
    }
    return { workspace: values['--workspace'], artifacts: values['--artifacts'],
        ploinky: values['--ploinky'] || path.join(sourceRoot, 'bin', 'ploinky'), timeoutMs };
}

function exists(target) {
    try { fs.lstatSync(target); return true; } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
    }
}

function realDirectory(target) {
    const stat = fs.lstatSync(target);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Expected a real directory: ' + target);
    assert.equal(fs.realpathSync(target), target, 'Directory path must have no symlink aliases: ' + target);
    return stat;
}

function validatePaths(options) {
    const workspace = path.resolve(options.workspace);
    assert.equal(workspace, expectedWorkspace, 'This E2E may run only in ' + expectedWorkspace);
    realDirectory(workspace);
    realDirectory(path.join(workspace, '.ploinky'));
    realDirectory(path.join(workspace, '.ploinky', 'repos'));
    assert.ok(path.isAbsolute(options.artifacts), '--artifacts must be an absolute path');
    const requestedArtifacts = path.resolve(options.artifacts);
    const artifactParent = fs.realpathSync(path.dirname(requestedArtifacts));
    realDirectory(artifactParent);
    const artifacts = path.join(artifactParent, path.basename(requestedArtifacts));
    const relativeArtifacts = path.relative(workspace, artifacts);
    assert.ok(relativeArtifacts === '..' || relativeArtifacts.startsWith('..' + path.sep),
        'Artifacts must be outside the selected workspace');
    assert.equal(exists(artifacts), false, 'Artifact directory already exists: ' + artifacts);
    const ploinky = fs.realpathSync(path.resolve(options.ploinky));
    assert.equal(path.basename(ploinky), 'ploinky', 'Use the outer bin/ploinky executable');
    assert.ok(fs.statSync(ploinky).isFile(), 'The selected outer CLI must be a file');
    fs.accessSync(ploinky, fs.constants.X_OK);
    const cliRoot = path.dirname(path.dirname(ploinky));
    assert.equal(path.dirname(ploinky), path.join(cliRoot, 'bin'), 'Select a candidate bin/ploinky executable');
    return { ...options, workspace, artifacts, ploinky, cliRoot };
}

function git(repoPath, args) {
    const result = spawnSync('git', ['-C', repoPath, ...args], {
        encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' },
    });
    if (result.error || result.status !== 0) {
        throw new Error(sanitizeGitDiagnostic('Fixture git ' + args.join(' ') + ': '
            + (result.error?.message || result.stderr || result.status)));
    }
    return result.stdout.trim();
}

function readSources(metadataPath) {
    if (!exists(metadataPath)) return { text: null, entries: {}, mode: 0o600 };
    const stat = fs.lstatSync(metadataPath);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Repository source metadata must be a regular file');
    const text = fs.readFileSync(metadataPath, 'utf8');
    const entries = JSON.parse(text);
    assert.ok(entries && typeof entries === 'object' && !Array.isArray(entries), 'Invalid repository source metadata');
    return { text, entries, mode: stat.mode & 0o777 };
}

async function main(rawOptions) {
    const options = validatePaths(rawOptions);
    const { workspace, artifacts, ploinky, cliRoot, timeoutMs } = options;
    const runId = new Date().toISOString().replace(/[^0-9]/g, '') + '-' + crypto.randomBytes(4).toString('hex');
    const token = crypto.randomBytes(24).toString('hex');
    const sourceParent = path.join(workspace, '.update-e2e-' + runId);
    const reposRoot = path.join(workspace, '.ploinky', 'repos');
    const metadataPath = path.join(workspace, '.ploinky', 'repo_sources.json');
    const sourcePaths = Object.fromEntries(['advance', 'branch', 'alternate'].map(name => [name, path.join(sourceParent, name)]));
    const sourceUrls = Object.fromEntries(Object.entries(sourcePaths).map(([name, localPath]) => (
        [name, '/workspace/' + path.relative(workspace, localPath).split(path.sep).join('/')]
    )));
    const cacheNames = { failed: 'AAUpdateE2EFailed-' + runId, branch: 'MMUpdateE2EBranch-' + runId,
        conflict: 'MMUpdateE2EConflict-' + runId, later: 'ZZUpdateE2ELater-' + runId };
    const cachePaths = Object.fromEntries(Object.entries(cacheNames).map(([name, repoName]) => [name, path.join(reposRoot, repoName)]));
    const folders = Object.fromEntries(['10-branch', '20-conflict', '30-missing', '90-good'].map(name => (
        [name.split('-')[1], path.join(workspace, 'UpdateE2E-' + runId + '-' + name)]
    )));
    const expectedOrigins = { [cacheNames.failed]: sourceUrls.advance, [cacheNames.later]: sourceUrls.advance,
        [cacheNames.branch]: sourceUrls.branch, [cacheNames.conflict]: sourceUrls.branch };
    const owned = [];
    const identity = buildWorkspaceIdentity(workspace, { markerFound: true });
    const locks = createMutationLockManager({ timeoutMs: 30_000 });
    const observations = { runId, workspace, instance: identity.instance, ploinky,
        candidateCommit: git(cliRoot, ['rev-parse', 'HEAD']),
        runnerCommit: git(sourceRoot, ['rev-parse', 'HEAD']),
        invocation: [ploinky, 'update'], expectedErrors: 3, before: {}, after: {}, cleanup: {} };
    let runError;
    let childResult;
    let sourceMapGuarded = false;
    fs.mkdirSync(artifacts, { mode: 0o700 });
    const artifact = (name, content) => fs.writeFileSync(path.join(artifacts, name), sanitizeGitDiagnostic(content), { mode: 0o600 });
    const progress = message => {
        const line = new Date().toISOString() + ' ' + message;
        console.log(line);
        fs.appendFileSync(path.join(artifacts, 'progress.log'), line + '\n', { mode: 0o600 });
    };
    const writeObservations = () => artifact('observations.json', JSON.stringify(observations, null, 2) + '\n');
    const revalidate = () => {
        const current = buildWorkspaceIdentity(workspace, { markerFound: true });
        assert.deepEqual(current.rootFingerprint, identity.rootFingerprint, 'Workspace identity changed');
        realDirectory(path.join(workspace, '.ploinky'));
        realDirectory(reposRoot);
    };
    const writeFile = (target, content) => {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
    };
    const ownDirectory = target => {
        assert.equal(exists(target), false, 'Refusing fixture collision: ' + target);
        fs.mkdirSync(target, { mode: 0o700 });
        const stat = fs.lstatSync(target);
        const record = { path: target, dev: stat.dev, ino: stat.ino, marker: path.join(target, '.update-e2e-owner') };
        owned.push(record);
        fs.writeFileSync(record.marker, token, { flag: 'wx', mode: 0o600 });
        return record;
    };
    const head = repoPath => git(repoPath, ['rev-parse', 'HEAD']);
    const manifestPath = folder => path.join(folder, 'ploinky-skills-manifest.json');
    const writeManifest = (folder, name, url, branch, skills) => writeFile(manifestPath(folder), JSON.stringify([{ name, url, branch, skills }], null, 2) + '\n');
    const sharedSkill = 'shared-' + runId;
    const copiedSkill = folder => path.join(folder, '.agents', 'skills', sharedSkill, 'SKILL.md');
    const mainContent = '# Shared skill on main\n';
    const featureContent = '# Shared skill on feature\n';

    try {
        progress('Validating exclusive fixture paths and preparing local Git sources.');
        const lock = await locks.acquire(identity.instance);
        try {
            revalidate();
            for (const target of [sourceParent, ...Object.values(cachePaths), ...Object.values(folders)]) {
                assert.equal(exists(target), false, 'Refusing fixture collision: ' + target);
            }
            const metadata = readSources(metadataPath);
            for (const name of Object.values(cacheNames)) {
                assert.equal(Object.hasOwn(metadata.entries, name), false, 'Repository source key already exists: ' + name);
            }
            sourceMapGuarded = true;
            const authorName = git(cliRoot, ['config', 'user.name']);
            const authorEmail = git(cliRoot, ['config', 'user.email']);
            assert.ok(authorName && authorEmail, 'Configure the candidate repository with the human Git author identity');
            ownDirectory(sourceParent);
            for (const localPath of Object.values(sourcePaths)) {
                fs.mkdirSync(localPath);
                git(localPath, ['init', '--quiet', '--initial-branch=main']);
                git(localPath, ['config', 'user.name', authorName]);
                git(localPath, ['config', 'user.email', authorEmail]);
                git(localPath, ['config', 'commit.gpgsign', 'false']);
                git(localPath, ['config', 'core.hooksPath', path.join(sourceParent, 'empty-hooks')]);
                writeFile(path.join(localPath, 'skills', sharedSkill, 'SKILL.md'), mainContent);
                git(localPath, ['add', '.']);
                git(localPath, ['commit', '--quiet', '-m', 'Initial update fixture']);
            }
            const clone = (name, sourceName) => {
                const record = ownDirectory(cachePaths[name]);
                // Git requires an empty destination; retain the inode guard while relocating the marker into .git.
                fs.unlinkSync(record.marker);
                try {
                    git(workspace, ['clone', '--quiet', sourcePaths[sourceName], cachePaths[name]]);
                } catch (error) {
                    // Restore the ownership proof after a partial clone only if the original directory survived.
                    if (exists(record.path)) {
                        const stat = fs.lstatSync(record.path);
                        if (stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === record.dev && stat.ino === record.ino) {
                            fs.writeFileSync(record.marker, token, { flag: 'wx', mode: 0o600 });
                        }
                    }
                    throw error;
                }
                record.marker = path.join(cachePaths[name], '.git', 'update-e2e-owner');
                fs.writeFileSync(record.marker, token, { flag: 'wx', mode: 0o600 });
                git(cachePaths[name], ['remote', 'set-url', 'origin', sourceUrls[sourceName]]);
            };
            clone('failed', 'advance');
            clone('later', 'advance');
            clone('branch', 'branch');
            clone('conflict', 'branch');
            git(cachePaths.failed, ['checkout', '--quiet', '--detach']);
            observations.before.advanceHead = head(sourcePaths.advance);
            writeFile(path.join(sourcePaths.advance, 'upstream.txt'), 'Later repository updated by the real CLI.\n');
            git(sourcePaths.advance, ['add', 'upstream.txt']);
            git(sourcePaths.advance, ['commit', '--quiet', '-m', 'Advance update fixture']);
            observations.before.expectedAdvanceHead = head(sourcePaths.advance);
            observations.before.mainHead = head(sourcePaths.branch);
            git(sourcePaths.branch, ['checkout', '--quiet', '-b', 'feature']);
            writeFile(path.join(sourcePaths.branch, 'skills', sharedSkill, 'SKILL.md'), featureContent);
            git(sourcePaths.branch, ['add', '.']);
            git(sourcePaths.branch, ['commit', '--quiet', '-m', 'Change shared skill on feature']);
            observations.before.featureHead = head(sourcePaths.branch);
            git(sourcePaths.branch, ['checkout', '--quiet', 'main']);
            for (const folder of Object.values(folders)) ownDirectory(folder);
            writeManifest(folders.branch, cacheNames.branch, sourceUrls.branch, 'main', [sharedSkill]);
            writeFile(copiedSkill(folders.branch), mainContent);
            observations.before.branch = { cachedBranch: git(cachePaths.branch, ['branch', '--show-current']),
                installedContent: fs.readFileSync(copiedSkill(folders.branch), 'utf8'), requestedBranch: 'main' };
            writeManifest(folders.branch, cacheNames.branch, sourceUrls.branch, 'feature', [sharedSkill]);
            writeManifest(folders.conflict, cacheNames.conflict, sourceUrls.alternate, 'main', [sharedSkill]);
            writeManifest(folders.missing, cacheNames.branch, sourceUrls.branch, 'feature', ['removed-' + runId]);
            writeManifest(folders.good, cacheNames.branch, sourceUrls.branch, 'feature', [sharedSkill]);
            observations.sources = Object.fromEntries(Object.entries(sourcePaths).map(([name, localPath]) => (
                [name, { hostPath: localPath, inBoxPath: sourceUrls[name], head: head(localPath) }]
            )));
            observations.caches = Object.fromEntries(Object.entries(cachePaths).map(([name, localPath]) => (
                [name, { name: cacheNames[name], hostPath: localPath,
                    origin: git(localPath, ['remote', 'get-url', 'origin']), head: head(localPath) }]
            )));
            observations.manifests = Object.fromEntries(Object.entries(folders).map(([name, folder]) => (
                [name, { hostPath: manifestPath(folder), inBoxPath: '/workspace/' + path.relative(workspace, manifestPath(folder)),
                    contents: JSON.parse(fs.readFileSync(manifestPath(folder), 'utf8')) }]
            )));
            writeObservations();
        } finally { lock.release(); }

        progress('Running the actual outer ploinky update once; timeout ' + timeoutMs + ' ms.');
        childResult = await runOuterUpdate({ ploinky, workspace, timeoutMs, progress, artifact });
        observations.command = { exitCode: childResult.code, signal: childResult.signal,
            timedOut: childResult.timedOut, durationMs: childResult.durationMs };
        progress('Outer update exited; checking Git identities, copied content, and final diagnostics.');
        revalidate();
        observations.after.caches = Object.fromEntries(Object.entries(cachePaths).map(([name, localPath]) => (
            [name, { head: head(localPath), branch: git(localPath, ['branch', '--show-current']),
                origin: git(localPath, ['remote', 'get-url', 'origin']) }]
        )));
        observations.after.branchContent = fs.existsSync(copiedSkill(folders.branch)) ? fs.readFileSync(copiedSkill(folders.branch), 'utf8') : null;
        observations.after.goodContent = fs.existsSync(copiedSkill(folders.good)) ? fs.readFileSync(copiedSkill(folders.good), 'utf8') : null;
        writeObservations();
        assert.equal(childResult.timedOut, false, 'Outer update timed out');
        assert.equal(childResult.code, 0, 'Individual update failures must not fail the outer update');
        const output = childResult.stdout + '\n' + childResult.stderr;
        assert.doesNotMatch(output, /In-box update failed/);
        const summaryIndex = childResult.stderr.lastIndexOf('Update completed with 3 error(s):');
        assert.ok(summaryIndex >= 0, 'Expected exactly the three injected errors in final stderr; inspect logs for unrelated failures');
        const summary = childResult.stderr.slice(summaryIndex);
        assert.ok(summary.includes(cacheNames.failed));
        assert.match(summary, /not currently on a branch/);
        assert.match(summary, /git .*pull .*exited with status [1-9]/);
        assert.ok(summary.includes(observations.manifests.conflict.inBoxPath));
        assert.ok(summary.includes(sourceUrls.branch) && summary.includes(sourceUrls.alternate));
        assert.match(summary, /Cached origin URL .* does not match requested URL/);
        assert.ok(summary.includes(observations.manifests.missing.inBoxPath));
        assert.ok(summary.includes("Skill 'removed-" + runId + "' was not found"));
        assert.match(summary, /Available skills:/);
        assert.equal(observations.after.caches.failed.head, observations.before.advanceHead);
        assert.equal(observations.after.caches.later.head, observations.before.expectedAdvanceHead);
        assert.equal(fs.readFileSync(path.join(cachePaths.later, 'upstream.txt'), 'utf8'), 'Later repository updated by the real CLI.\n');
        assert.equal(observations.before.branch.cachedBranch, 'main');
        assert.equal(observations.before.branch.installedContent, mainContent);
        assert.equal(observations.after.caches.branch.branch, 'feature');
        assert.equal(observations.after.caches.branch.head, observations.before.featureHead);
        assert.equal(observations.after.branchContent, featureContent);
        assert.equal(observations.after.goodContent, featureContent, 'A later valid manifest must still install');
        assert.equal(observations.after.caches.conflict.origin, sourceUrls.branch, 'A conflicting manifest must not repoint the cache');
        assert.equal(observations.after.caches.conflict.head, observations.before.mainHead);
        assert.equal(fs.existsSync(path.join(folders.conflict, '.agents')), false);
        observations.result = 'passed';
        progress('All update continuation and skill-cache assertions passed.');
    } catch (error) {
        runError = error;
        observations.result = 'failed';
        observations.error = sanitizeGitDiagnostic(error.stack || error.message);
        progress('E2E failed: ' + sanitizeGitDiagnostic(error.message));
    } finally {
        writeObservations();
        progress('Acquiring the workspace lock to clean only verified test-owned paths and source keys.');
        let cleanupLock;
        try {
            cleanupLock = await locks.acquire(identity.instance);
            revalidate();
            if (sourceMapGuarded) {
                const metadata = readSources(metadataPath);
                const deletedKeys = [];
                for (const name of Object.values(cacheNames)) {
                    if (!Object.hasOwn(metadata.entries, name)) continue;
                    const entry = metadata.entries[name];
                    const url = typeof entry === 'string' ? entry : entry?.url;
                    assert.equal(url, expectedOrigins[name], 'Refusing to remove a source key with unexpected ownership: ' + name);
                    delete metadata.entries[name];
                    deletedKeys.push(name);
                }
                if (deletedKeys.length) {
                    assert.equal(fs.readFileSync(metadataPath, 'utf8'), metadata.text, 'Source map changed during cleanup');
                    const stagingPath = metadataPath + '.update-e2e-' + runId + '.tmp';
                    fs.writeFileSync(stagingPath, JSON.stringify(metadata.entries, null, 2), { flag: 'wx', mode: metadata.mode });
                    fs.renameSync(stagingPath, metadataPath);
                }
                observations.cleanup.sourceKeys = deletedKeys;
            }
            observations.cleanup.paths = [];
            for (const record of [...owned].reverse()) {
                if (!exists(record.path)) {
                    observations.cleanup.paths.push(record.path);
                    continue;
                }
                const stat = realDirectory(record.path);
                assert.equal(stat.dev, record.dev, 'Fixture device changed: ' + record.path);
                assert.equal(stat.ino, record.ino, 'Fixture inode changed: ' + record.path);
                assert.equal(fs.readFileSync(record.marker, 'utf8'), token, 'Fixture ownership marker changed: ' + record.path);
                fs.rmSync(record.path, { recursive: true });
                observations.cleanup.paths.push(record.path);
            }
            observations.cleanup.result = 'passed';
        } catch (error) {
            observations.cleanup.result = 'failed';
            observations.cleanup.error = sanitizeGitDiagnostic(error.message);
            progress('Cleanup stopped at an ownership/lock guard: ' + sanitizeGitDiagnostic(error.message));
            runError ||= error;
        } finally {
            if (cleanupLock) cleanupLock.release();
            writeObservations();
        }
    }
    if (runError) throw new Error('Update E2E failed; evidence: ' + artifacts + '\n' + sanitizeGitDiagnostic(runError.message));
    progress('PASS. Evidence: ' + artifacts);
}

function runOuterUpdate({ ploinky, workspace, timeoutMs, progress, artifact }) {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let failure;
        let killTimer;
        const child = spawn(ploinky, ['update'], {
            cwd: workspace, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, PLOINKY_WORKSPACE_ROOT: workspace, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' },
        });
        const signalGroup = signal => {
            if (!child.pid) return;
            try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') failure ||= error; }
        };
        const stop = () => {
            signalGroup('SIGTERM');
            killTimer ||= setTimeout(() => signalGroup('SIGKILL'), 5_000);
        };
        const append = (channel, data) => {
            if (failure) return;
            const remaining = 64 * 1024 * 1024 - stdout.length - stderr.length;
            const accepted = data.slice(0, Math.max(remaining, 0));
            if (channel === 'stdout') stdout += accepted;
            else stderr += accepted;
            if (data.length > remaining) {
                failure ||= new Error('Outer update exceeded the 64 MiB evidence limit');
                stop();
            }
        };
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', data => append('stdout', data));
        child.stderr.on('data', data => append('stderr', data));
        child.on('error', error => { failure = error; });
        const timer = setTimeout(() => { timedOut = true; progress('Outer update timed out; terminating its host process group.'); stop(); }, timeoutMs);
        const heartbeat = setInterval(() => {
            progress('Outer update is still running (' + Math.round((Date.now() - started) / 1000) + ' seconds).');
            artifact('stdout.log', stdout);
            artifact('stderr.log', stderr);
        }, 30_000);
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            clearTimeout(killTimer);
            clearInterval(heartbeat);
            artifact('stdout.log', stdout);
            artifact('stderr.log', stderr);
            if (failure) reject(failure);
            else resolve({ code, signal, timedOut, stdout: sanitizeGitDiagnostic(stdout),
                stderr: sanitizeGitDiagnostic(stderr), durationMs: Date.now() - started });
        });
    });
}

try {
    const options = parseArgs(process.argv.slice(2));
    if (options) await main(options);
    else console.log(usage);
} catch (error) {
    console.error(sanitizeGitDiagnostic(error.message));
    process.exitCode = 1;
}
