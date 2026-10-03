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
import { syncManagedSkillExports } from '../../../cli/utils/skills/exportTransaction.mjs';
import { createUpdateHostState } from '../../../ploinky-box/update/hostState.mjs';

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

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function unverifiedRecords(output) {
    return output.split('\n').flatMap(line => {
        const match = /^\s*-\s+(\S+)\s+(.+?):\s+(failed|uncertain|skipped|deferred)\s+\(([^,]+),\s*(optional|required(?: \(membership unknown\))?)\)/.exec(line);
        return match ? [{ phase: match[1], id: match[2], outcome: match[3], code: match[4], membership: match[5] }] : [];
    });
}

async function main(rawOptions) {
    const { workspace, artifacts, ploinky, cliRoot, timeoutMs } = validatePaths(rawOptions);
    const runId = new Date().toISOString().replace(/[^0-9]/g, '') + '-' + crypto.randomBytes(4).toString('hex');
    const token = crypto.randomBytes(24).toString('hex');
    const sourceParent = path.join(workspace, '.update-e2e-' + runId);
    const scenarioRoot = path.join(workspace, 'UpdateE2E-' + runId);
    const reposRoot = path.join(workspace, '.ploinky', 'repos');
    const metadataPath = path.join(workspace, '.ploinky', 'repo_sources.json');
    const activeManifest = path.join(workspace, 'ploinky-skills-manifest.json');
    const sourcePaths = Object.fromEntries(['advance', 'branch', 'alternate'].map(name => [name, path.join(sourceParent, name)]));
    const names = ['detached', 'staged', 'unstaged', 'diverged', 'collision', 'branch', 'origin', 'later'];
    const cacheNames = Object.fromEntries(names.map((name, index) => [name, `${index === names.length - 1 ? 'ZZ' : 'AA'}UpdateE2E${index}-${name}-${runId}`]));
    const cachePaths = Object.fromEntries(names.map(name => [name, path.join(reposRoot, cacheNames[name])]));
    const folders = Object.fromEntries(['10-bad', '20-branch', '30-origin', '40-prune', '90-good'].map(name => [name.split('-')[1], path.join(scenarioRoot, name)]));
    const sourceFor = name => ['branch', 'origin'].includes(name) ? 'branch' : 'advance';
    const expectedOrigins = Object.fromEntries(names.map(name => [cacheNames[name], sourcePaths[sourceFor(name)]]));
    const identity = buildWorkspaceIdentity(workspace, { markerFound: true });
    const locks = createMutationLockManager({ timeoutMs: 30_000 });
    const hostState = createUpdateHostState();
    const owned = [];
    const observations = {
        runId, workspace, instance: identity.instance, ploinky,
        candidateCommit: git(cliRoot, ['rev-parse', 'HEAD']), runnerCommit: git(sourceRoot, ['rev-parse', 'HEAD']),
        invocation: [ploinky, 'update', 'all', scenarioRoot], before: {}, passes: {}, cleanup: {},
    };
    let runError;
    let sourceMapGuarded = false;
    let activeManifestBackup = null;
    let unsafeToClean = false;
    fs.mkdirSync(artifacts, { mode: 0o700 });
    const artifact = (name, content) => fs.writeFileSync(path.join(artifacts, name), sanitizeGitDiagnostic(content), { mode: 0o600 });
    const progress = message => {
        const line = new Date().toISOString() + ' ' + message;
        console.log(line);
        fs.appendFileSync(path.join(artifacts, 'progress.log'), line + '\n', { mode: 0o600 });
    };
    const writeObservations = () => artifact('observations_codex.json', JSON.stringify(observations, null, 2) + '\n');
    const revalidate = () => {
        const current = buildWorkspaceIdentity(workspace, { markerFound: true });
        assert.deepEqual(current.rootFingerprint, identity.rootFingerprint, 'Workspace identity changed');
        realDirectory(path.join(workspace, '.ploinky'));
        realDirectory(reposRoot);
    };
    const locked = async operation => {
        const lock = await locks.acquire(identity.instance);
        try { revalidate(); return await operation(); } finally { lock.release(); }
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
    const snapshot = repoPath => ({
        head: head(repoPath), branch: git(repoPath, ['branch', '--show-current']),
        origin: git(repoPath, ['remote', 'get-url', 'origin']),
        staged: digest(git(repoPath, ['diff', '--cached', '--binary'])),
        unstaged: digest(git(repoPath, ['diff', '--binary'])),
        stash: git(repoPath, ['stash', 'list', '--format=%H']),
    });
    const manifestPath = folder => path.join(folder, 'ploinky-skills-manifest.json');
    const writeManifest = (folder, name, url, branch, skills) => writeFile(manifestPath(folder), JSON.stringify([{ name, url, branch, skills }], null, 2) + '\n');
    const sharedSkill = 'shared-' + runId;
    const removedSkill = 'removed-' + runId;
    const copiedSkill = (folder, name = sharedSkill) => path.join(folder, '.agents', 'skills', name, 'SKILL.md');
    const mainContent = '# Shared skill on main\n';
    const updatedContent = '# Shared skill advanced on main\n';
    const seed = (folder, skillName, source) => syncManagedSkillExports({ folder, owner: 'manifest',
        sources: [{ name: skillName, path: source }], claude: 'root-or-skills' });
    const recordFor = (records, phase, id) => {
        const record = records.find(item => item.phase === phase && item.id === id);
        assert.ok(record, `Missing named ${phase} outcome for ${id}`);
        return record;
    };
    const assertUnchanged = name => assert.deepEqual(snapshot(cachePaths[name]), observations.before.caches[name], `${name} checkout/index/worktree/stashes changed`);
    const assertSafety = () => {
        for (const name of names.filter(name => name !== 'later')) assertUnchanged(name);
        assert.equal(fs.readFileSync(path.join(cachePaths.collision, 'incoming.txt'), 'utf8'), 'Untracked local content must survive.\n');
        assert.equal(fs.readFileSync(copiedSkill(folders.branch), 'utf8'), mainContent);
        assert.equal(fs.readFileSync(copiedSkill(folders.origin), 'utf8'), mainContent);
        assert.equal(fs.readFileSync(copiedSkill(folders.good), 'utf8'), updatedContent);
        assert.equal(exists(path.dirname(copiedSkill(folders.prune, removedSkill))), false, 'Verified missing skill was not pruned');
        assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath(folders.prune), 'utf8'))[0].skills, []);
    };
    const executePass = async label => {
        progress(`Running ${label}: actual outer ploinky update all in the dedicated workspace.`);
        unsafeToClean = true;
        const command = await runOuterUpdate({ ploinky, workspace, args: ['update', 'all', scenarioRoot], timeoutMs,
            progress, artifact: (name, bytes) => artifact(`${label}-${name}`, bytes) });
        unsafeToClean = command.timedOut || command.signal !== null;
        const output = command.stdout + '\n' + command.stderr;
        const result = { exitCode: command.code, signal: command.signal, timedOut: command.timedOut,
            durationMs: command.durationMs, unverified: unverifiedRecords(output),
            caches: Object.fromEntries(names.map(name => [name, snapshot(cachePaths[name])])) };
        observations.passes[label] = result;
        writeObservations();
        assert.equal(command.timedOut, false, 'Outer update timed out; leave fixtures until writer termination is proven');
        assert.equal(command.signal, null, 'Outer update did not exit normally');
        assert.equal(command.code, 1, 'Actual failures must produce a truthful nonzero exit status');
        assertSafety();
        return { ...result, output };
    };

    try {
        progress('Preparing isolated local Git histories and skill consumers under the workspace lock.');
        await locked(() => {
            for (const target of [sourceParent, scenarioRoot, ...Object.values(cachePaths)]) assert.equal(exists(target), false, 'Refusing fixture collision: ' + target);
            const metadata = readSources(metadataPath);
            for (const name of Object.values(cacheNames)) assert.equal(Object.hasOwn(metadata.entries, name), false, 'Repository source key already exists: ' + name);
            sourceMapGuarded = true;
            const authorName = git(cliRoot, ['config', 'user.name']);
            const authorEmail = git(cliRoot, ['config', 'user.email']);
            assert.ok(authorName && authorEmail, 'Configure the candidate checkout with the human Git author identity');
            ownDirectory(sourceParent);
            ownDirectory(scenarioRoot);
            const configure = target => {
                git(target, ['config', 'user.name', authorName]);
                git(target, ['config', 'user.email', authorEmail]);
                git(target, ['config', 'commit.gpgsign', 'false']);
                git(target, ['config', 'core.hooksPath', path.join(sourceParent, 'empty-hooks')]);
            };
            for (const source of Object.values(sourcePaths)) {
                fs.mkdirSync(source);
                git(source, ['init', '--quiet', '--initial-branch=main']);
                configure(source);
                writeFile(path.join(source, 'skills', sharedSkill, 'SKILL.md'), mainContent);
                writeFile(path.join(source, 'tracked.txt'), 'Original tracked content.\n');
                git(source, ['add', '.']);
                git(source, ['commit', '--quiet', '-m', 'Create update fixture']);
            }
            for (const name of names) {
                const record = ownDirectory(cachePaths[name]);
                fs.unlinkSync(record.marker);
                try { git(workspace, ['clone', '--quiet', sourcePaths[sourceFor(name)], cachePaths[name]]); }
                catch (error) {
                    const stat = fs.lstatSync(record.path, { throwIfNoEntry: false });
                    if (stat?.isDirectory() && !stat.isSymbolicLink() && stat.dev === record.dev && stat.ino === record.ino) fs.writeFileSync(record.marker, token, { flag: 'wx', mode: 0o600 });
                    throw error;
                }
                record.marker = path.join(cachePaths[name], '.git', 'update-e2e-owner');
                fs.writeFileSync(record.marker, token, { flag: 'wx', mode: 0o600 });
                configure(cachePaths[name]);
            }
            git(cachePaths.detached, ['checkout', '--quiet', '--detach']);
            writeFile(path.join(cachePaths.staged, 'tracked.txt'), 'Staged local content.\n');
            git(cachePaths.staged, ['add', 'tracked.txt']);
            fs.appendFileSync(path.join(cachePaths.staged, 'tracked.txt'), 'Additional unstaged content.\n');
            writeFile(path.join(cachePaths.unstaged, 'tracked.txt'), 'Unstaged local content.\n');
            writeFile(path.join(cachePaths.diverged, 'local-only.txt'), 'Local branch history.\n');
            git(cachePaths.diverged, ['add', 'local-only.txt']);
            git(cachePaths.diverged, ['commit', '--quiet', '-m', 'Keep local history for divergence case']);
            writeFile(path.join(cachePaths.collision, 'incoming.txt'), 'Untracked local content must survive.\n');
            writeFile(path.join(sourcePaths.advance, 'incoming.txt'), 'Incoming tracked content.\n');
            writeFile(path.join(sourcePaths.advance, 'skills', sharedSkill, 'SKILL.md'), updatedContent);
            git(sourcePaths.advance, ['add', '.']);
            git(sourcePaths.advance, ['commit', '--quiet', '-m', 'Advance upstream update fixture']);
            observations.before.expectedAdvanceHead = head(sourcePaths.advance);
            git(sourcePaths.branch, ['checkout', '--quiet', '-b', 'feature']);
            writeFile(path.join(sourcePaths.branch, 'skills', sharedSkill, 'SKILL.md'), '# Feature content must not be selected automatically\n');
            git(sourcePaths.branch, ['add', '.']);
            git(sourcePaths.branch, ['commit', '--quiet', '-m', 'Create alternate branch fixture']);
            git(sourcePaths.branch, ['checkout', '--quiet', 'main']);
            for (const folder of Object.values(folders)) fs.mkdirSync(folder);
            writeFile(manifestPath(folders.bad), '{ invalid optional manifest\n');
            writeManifest(folders.branch, cacheNames.branch, sourcePaths.branch, 'feature', [sharedSkill]);
            writeManifest(folders.origin, cacheNames.origin, sourcePaths.alternate, 'main', [sharedSkill]);
            writeManifest(folders.prune, cacheNames.later, sourcePaths.advance, 'main', [removedSkill]);
            writeManifest(folders.good, cacheNames.later, sourcePaths.advance, 'main', [sharedSkill]);
            for (const name of ['branch', 'origin']) seed(folders[name], sharedSkill, path.join(cachePaths[name], 'skills', sharedSkill));
            const obsolete = path.join(sourceParent, 'obsolete');
            writeFile(path.join(obsolete, 'SKILL.md'), '# Formerly selected skill\n');
            seed(folders.prune, removedSkill, obsolete);
            observations.before.caches = Object.fromEntries(names.map(name => [name, snapshot(cachePaths[name])]));
            observations.manifests = Object.fromEntries(Object.entries(folders).map(([name, folder]) => [name, manifestPath(folder)]));
            writeObservations();
        });

        const optional = await executePass('optional-errors');
        assert.equal(head(cachePaths.later), observations.before.expectedAdvanceHead, 'A later safe checkout did not fast-forward');
        for (const [name, code] of [['detached', 'detached-head'], ['staged', 'dirty-index'], ['unstaged', 'dirty-worktree'], ['diverged', 'diverged'], ['collision', 'untracked-would-be-overwritten']]) {
            const record = recordFor(optional.unverified, 'registered-repository', cacheNames[name]);
            assert.equal(record.code, code);
            assert.equal(record.membership, 'optional');
            assert.equal(record.outcome, name === 'collision' ? 'failed' : 'skipped');
        }
        const malformed = recordFor(optional.unverified, 'skills-manifest', folders.bad);
        assert.equal(malformed.outcome, 'failed');
        assert.equal(malformed.membership, 'optional');
        const errors = optional.unverified.filter(record => ['failed', 'uncertain'].includes(record.outcome));
        assert.deepEqual(errors.map(record => record.id).sort(), [cacheNames.collision, folders.bad].sort(), 'Unexpected core error invalidates this live run');
        assert.match(optional.output, /Update partially failed \(exit status 1\):/);
        assert.match(optional.output, /Activation: the workspace graph was restarted and the Router health check passed\.|Activation not required; no configured running workspace required a restart\./);
        assert.doesNotMatch(optional.output, /Activation was blocked by:/);

        progress('Injecting an unreadable active skill-scope manifest and advancing the safe checkout again.');
        await locked(() => {
            const stat = fs.lstatSync(activeManifest, { throwIfNoEntry: false });
            assert.ok(!stat || (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 1024 * 1024), 'Refusing a nonregular or oversized active scope manifest');
            const before = stat ? fs.readFileSync(activeManifest) : null;
            const injected = Buffer.from(`{ invalid scope fixture ${runId}\n`);
            const recoveryPath = path.join(sourceParent, 'active-scope-restore_codex.json');
            const backupPath = path.join(sourceParent, 'active-scope-before_codex.json');
            if (before !== null) fs.writeFileSync(backupPath, before, { flag: 'wx', mode: 0o600 });
            fs.writeFileSync(recoveryPath, JSON.stringify({ workspace, instance: identity.instance,
                target: activeManifest, priorAbsent: before === null, backupPath: before === null ? null : backupPath,
                mode: stat ? stat.mode & 0o777 : null, priorDigest: before === null ? null : digest(before),
                injectedDigest: digest(injected) }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
            observations.before.activeScopeRecovery = recoveryPath;
            activeManifestBackup = { bytes: before, mode: stat ? stat.mode & 0o777 : null, expected: injected, dev: stat?.dev, ino: stat?.ino };
            fs.writeFileSync(activeManifest, injected, { mode: stat ? stat.mode & 0o777 : 0o600, flag: stat ? 'w' : 'wx' });
            const written = fs.lstatSync(activeManifest);
            activeManifestBackup.dev = written.dev;
            activeManifestBackup.ino = written.ino;
            observations.before.activeScopeManifest = { path: activeManifest, priorDigest: before === null ? null : digest(before), injectedDigest: digest(injected) };
            const graphScope = path.join(workspace, '.ploinky', 'graph-skill-scope.json');
            observations.before.graphScopeDigest = exists(graphScope) ? digest(fs.readFileSync(graphScope)) : null;
            writeFile(path.join(sourcePaths.advance, 'second-update.txt'), 'A later checkout still advances with unknown membership.\n');
            git(sourcePaths.advance, ['add', 'second-update.txt']);
            git(sourcePaths.advance, ['commit', '--quiet', '-m', 'Advance fixture for blocked activation case']);
            observations.before.expectedSecondHead = head(sourcePaths.advance);
        });
        const unknown = await executePass('unknown-required-scope');
        assert.equal(head(cachePaths.later), observations.before.expectedSecondHead, 'Safe work stopped after unknown required membership');
        assert.equal(recordFor(unknown.unverified, 'registered-repository', cacheNames.detached).membership, 'required (membership unknown)');
        assert.match(unknown.output, /Update failed \(exit status 1\):/);
        assert.match(unknown.output, /Activation deferred; the running workspace graph was not restarted\./);
        assert.match(unknown.output, /Activation was blocked by:/);
        assert.doesNotMatch(unknown.output, /Activation: the workspace graph was restarted/);
        const pending = hostState.read('update-pending', identity.instance);
        assert.equal(pending?.workspaceRoot, workspace);
        assert.ok(pending.entries.at(-1).blockedBy.some(record => record.id === cacheNames.detached));
        observations.passes['unknown-required-scope'].pendingActivation = { reason: pending.reason, lastEntry: pending.entries.at(-1) };
        const graphScope = path.join(workspace, '.ploinky', 'graph-skill-scope.json');
        assert.equal(exists(graphScope) ? digest(fs.readFileSync(graphScope)) : null, observations.before.graphScopeDigest, 'Blocked update changed the admitted graph skill scope');
        observations.result = 'passed';
        progress('Real update continuation, preservation, pruning, exit status, and activation checks passed.');
    } catch (error) {
        runError = error;
        observations.result = 'failed';
        observations.error = sanitizeGitDiagnostic(error.stack || error.message);
        progress('E2E failed: ' + sanitizeGitDiagnostic(error.message));
    } finally {
        writeObservations();
        try {
            if (unsafeToClean) throw new Error('The outer command timed out or was signalled; retain fixtures until the owning in-Box writer is proven terminated.');
            await locked(() => {
                if (activeManifestBackup) {
                    const stat = fs.lstatSync(activeManifest);
                    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
                    assert.equal(stat.dev, activeManifestBackup.dev, 'Active manifest device changed; refusing restoration');
                    assert.equal(stat.ino, activeManifestBackup.ino, 'Active manifest inode changed; refusing restoration');
                    assert.ok(fs.readFileSync(activeManifest).equals(activeManifestBackup.expected), 'Active manifest changed; refusing restoration');
                    if (activeManifestBackup.bytes === null) fs.unlinkSync(activeManifest);
                    else { fs.writeFileSync(activeManifest, activeManifestBackup.bytes); fs.chmodSync(activeManifest, activeManifestBackup.mode); }
                    observations.cleanup.activeScopeManifest = 'restored';
                }
                if (sourceMapGuarded) {
                    const metadata = readSources(metadataPath);
                    const removed = [];
                    for (const name of Object.values(cacheNames)) {
                        if (!Object.hasOwn(metadata.entries, name)) continue;
                        const entry = metadata.entries[name];
                        assert.equal(typeof entry === 'string' ? entry : entry?.url, expectedOrigins[name], 'Refusing to remove an unowned source key: ' + name);
                        delete metadata.entries[name];
                        removed.push(name);
                    }
                    if (removed.length) {
                        assert.equal(fs.readFileSync(metadataPath, 'utf8'), metadata.text, 'Source map changed during cleanup');
                        const staging = metadataPath + '.update-e2e-' + runId + '.tmp';
                        fs.writeFileSync(staging, JSON.stringify(metadata.entries, null, 2), { flag: 'wx', mode: metadata.mode });
                        fs.renameSync(staging, metadataPath);
                    }
                    observations.cleanup.sourceKeys = removed;
                }
                observations.cleanup.paths = [];
                for (const record of [...owned].reverse()) {
                    if (!exists(record.path)) continue;
                    const stat = realDirectory(record.path);
                    assert.equal(stat.dev, record.dev, 'Fixture device changed: ' + record.path);
                    assert.equal(stat.ino, record.ino, 'Fixture inode changed: ' + record.path);
                    assert.equal(fs.readFileSync(record.marker, 'utf8'), token, 'Fixture ownership marker changed: ' + record.path);
                    fs.rmSync(record.path, { recursive: true });
                    observations.cleanup.paths.push(record.path);
                }
                observations.cleanup.result = 'passed';
                // Keep the pending-activation record as truthful evidence. A
                // subsequent verified restart/update or fixture redeploy settles it.
            });
        } catch (error) {
            observations.cleanup.result = 'failed';
            observations.cleanup.error = sanitizeGitDiagnostic(error.message);
            progress('Cleanup stopped at an ownership, quiescence, or lock guard: ' + sanitizeGitDiagnostic(error.message));
            runError ||= error;
        }
        writeObservations();
    }
    if (runError) throw new Error('Update E2E failed; evidence: ' + artifacts + '\n' + sanitizeGitDiagnostic(runError.message));
    progress('PASS. Evidence: ' + artifacts);
}

function runOuterUpdate({ ploinky, workspace, args, timeoutMs, progress, artifact }) {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let failure;
        let killTimer;
        const child = spawn(ploinky, args, {
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
