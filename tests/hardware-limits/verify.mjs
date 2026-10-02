#!/usr/bin/env node
// Hardware-limits verification runner (plan §15.1, §18).
//
//   configure     record exact candidate/baseline identities and write a config
//   self-test     run the harness self-tests (no container or network activity)
//   baseline      run scoped existing suites against the baseline staging copies
//   offline       run one phase's required tests and affected regressions
//   prepare-live  write a proposed run manifest for one live block (no engine
//                 or SSH); mac-cpu and apparatus-cpu get concrete pins and a
//                 human approval summary beside the manifest. A mac block's
//                 workspace lives under pins.workspaceParentRoot, which must be
//                 short enough for the CLI's Unix sockets (a session scratch
//                 root is not): pin a canonical task-owned /private/tmp/<name>
//   provision/live/cleanup
//                 APPROVAL REQUIRED; each needs its own exact authorization
//                 binding. Unsupported cases remain BLOCKED.
//
// Exit codes: PASS=0, FAIL=1, BLOCKED=2, SKIPPED=3. Child processes are
// spawned with argument arrays, explicit cwd/environment and deadlines.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runBoundedProcess } from './liveProcess.mjs';
import { fileURLToPath } from 'node:url';
import { runLiveCommand, LIVE_CASES, UNSUPPORTED, validateProfile } from './liveHarness.mjs';
import { liveSourceDigest, workspaceSocketProblem } from './liveCommon.mjs';
import { CONCRETE_BLOCKS, buildConcreteManifest, explorerFixtureImage, proposedWorkspace, renderSummary, selectPorts, summaryPathFor, validatePins } from './liveManifest.mjs';
import { validateStage, writeUstar } from './liveStage.mjs';

import {
    EXIT,
    SchemaError,
    buildRequiredCaseManifest,
    createOwnedShortTemp,
    evaluateSuiteRun,
    randomRunId,
    removeOwnedShortTemp,
    sha256Hex,
    validateCaseManifest,
    validateConfig,
    validateReport,
    validateRunManifest,
    writePrivateJson,
} from './fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLOINKY_ROOT = path.resolve(HERE, '..', '..');
const REPORTER = path.join(HERE, 'reporter.mjs');
const DEFAULT_SUITE_DEADLINE_MS = 20 * 60 * 1000;
const PLAN_PINS = Object.freeze({
    ploinky: '5b3a94a94b4f8fb0ffca4a09a6653ffd3c31aeca',
    explorer: '5867fb66fdb23da88496e2f7e4bcfa7e9d6dd7ba',
    localLlms: '5770e12b0799213cb35a0de422fd10acbc65057e',
    images: '62d313bfb2a6cd28e01e41feb78385fadad77468',
});

// Existing suites whose behavior a phase can affect. Required feature files
// come from the case manifest; these are additional regressions.
const PHASE_REGRESSIONS = Object.freeze({
    s0: { ploinky: ['tests/unit/hardwareLimitsLiveHarness.test.mjs'] },
    p0: {
        ploinky: [
            'tests/unit/agentEnableBatch.test.mjs',
            'tests/unit/workspaceDependencyGraph.test.mjs',
            'tests/unit/runtimeCapabilities.test.mjs',
            'tests/unit/containerRuntimePolicy.test.mjs',
            'tests/unit/noWaitLoadingEvidence.test.mjs',
            'tests/unit/noWaitMarkerLifecycle.test.mjs',
            'tests/unit/noWaitRunScopedLogs.test.mjs',
            'tests/unit/containerMonitorMaintenance.test.mjs',
            'tests/unit/containerMonitorNetworkRecovery.test.mjs',
            'tests/unit/containerMonitorProbeOverlap.test.mjs',
            'tests/unit/containerMonitorPublication.test.mjs',
            'tests/unit/edgeGenerationHardCut.test.mjs',
            'tests/unit/edgeRoutePlanInterface.test.mjs',
            'tests/unit/cliExitCodes.test.mjs',
            'tests/unit/cliLifecycleInactivation.test.mjs',
            'tests/unit/enableAgentStartup.test.mjs',
            'tests/unit/manifestEnableModes.test.mjs',
            'tests/unit/routerDependentEnableOrdering.test.mjs',
            'tests/unit/marketplacePublicAdmin.test.mjs',
            'tests/unit/sandboxRuntime.test.mjs',
        ],
    },
    p1: {
        ploinky: [
            'tests/unit/ploinkyBoxSupervisor.test.mjs',
            'tests/unit/ploinkyBoxCli.test.mjs',
            'tests/unit/ploinkyBoxGpuGrant.test.mjs',
            'tests/unit/ploinkyBoxHostPrerequisites.test.mjs',
            'tests/unit/ploinkyBoxDiagnoseHost.test.mjs',
            'tests/unit/ploinkyBoxTransactions.test.mjs',
            'tests/unit/ploinkyBoxLocks.test.mjs',
            'tests/unit/ploinkyBoxArguments.test.mjs',
            'tests/unit/ploinkyBoxImageContract.test.mjs',
            'tests/unit/ploinkyBoxRouterBinding.test.mjs',
            'tests/unit/ploinkyBoxBindLifecycle.test.mjs',
            'tests/unit/runtimeCapabilities.test.mjs',
            'tests/unit/containerRuntimePolicy.test.mjs',
            'tests/unit/routerAuthorityProducer.test.mjs',
            'tests/unit/routerAuthorityNonceLifetime.test.mjs',
            'tests/unit/ploinkyBoxAuthority.test.mjs',
            'tests/unit/llmRuntimeIntegration.test.mjs',
            'tests/unit/agentRegistryResolver.test.mjs',
        ],
    },
    'p1-ram': {
        localLlms: [
            'local-llm/tests/cpu-profile.test.mjs',
            'local-llm/tests/gpu-profiles-unchanged.test.mjs',
            'local-llm/tests/vllm.test.mjs',
            'local-llm/tests/catalog-admission.test.mjs',
            'local-llm/tests/hardware-profile.test.mjs',
            'local-llm/tests/memory-guard.test.mjs',
            'local-llm/tests/unified-profile.test.mjs',
            'local-llm/tests/controller.test.mjs',
            'local-llm/tests/dashboard-plugin.test.mjs',
        ],
    },
    p2: {
        ploinky: [
            'tests/unit/agentRegistryResolver.test.mjs',
            'tests/unit/marketplaceEnableWorker.test.mjs',
            // npm run test:authorization:harness: the Router inventory rows
            // for the hardware-limits and marketplace handlers.
            'tests/security/authorization/core.test.mjs',
            'tests/security/authorization/inventory-probes.test.mjs',
            'tests/security/authorization/resource-probes.test.mjs',
            'tests/security/authorization/router-probes.test.mjs',
            'tests/security/authorization/safety.test.mjs',
        ],
    },
    p3: { explorer: ['explorer/tests/unit/settingsAccount.test.js', 'workspaceMonitorAgent/tests/currentSnapshot.test.mjs', 'tests/smoke/lib/box-evidence.test.mjs'] },
    p4: { ploinky: ['tests/unit/ploinkyBoxGpuGrant.test.mjs'] },
    p5: { localLlms: ['local-llm/tests/gpu-profiles-unchanged.test.mjs', 'local-llm/tests/vllm.test.mjs'] },
});
const REPO_KEYS = Object.freeze({ ploinky: 'ploinky', explorer: 'explorer', 'local-llms': 'localLlms' });

class UsageError extends Error {}

function parseArgs(argv) {
    const [command, ...rest] = argv;
    const options = {};
    for (let index = 0; index < rest.length; index += 1) {
        const token = rest[index];
        if (!token.startsWith('--')) throw new UsageError(`unexpected argument '${token}'`);
        const key = token.slice(2);
        const value = rest[index + 1];
        if (value === undefined || value.startsWith('--')) throw new UsageError(`option --${key} needs a value`);
        options[key] = value;
        index += 1;
    }
    return { command, options };
}

function requireAbsolute(value, label) {
    if (!value || !path.isAbsolute(value)) throw new UsageError(`--${label} must be an absolute path`);
    return path.normalize(value);
}

function git(cwd, args) {
    const result = spawnSync('git', ['-C', cwd, ...args], {
        encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr || result.error?.message}`);
    return result.stdout.trim();
}

function fileDigest(filePath) {
    return `sha256:${sha256Hex(fs.readFileSync(filePath))}`;
}

function instructionDigests(root) {
    const digests = {};
    for (const name of ['CLAUDE.md', 'AGENTS.md']) {
        const candidate = path.join(root, name);
        if (fs.existsSync(candidate)) digests[name] = fileDigest(candidate);
    }
    return digests;
}

// Bounded deterministic tree digest over regular files, never following
// symlinks. Used for dependencies that are not git checkouts.
function treeDigest(root, { maxFiles = 20000 } = {}) {
    const entries = [];
    const walk = (directory, relative) => {
        for (const name of fs.readdirSync(directory).sort()) {
            if (name === '.git') continue;
            const absolute = path.join(directory, name);
            const rel = relative ? `${relative}/${name}` : name;
            const stat = fs.lstatSync(absolute);
            if (stat.isDirectory()) walk(absolute, rel);
            else if (stat.isFile()) {
                entries.push(`${rel}\0${sha256Hex(fs.readFileSync(absolute))}`);
                if (entries.length > maxFiles) throw new Error(`${root} exceeds ${maxFiles} files`);
            } else if (stat.isSymbolicLink()) {
                entries.push(`${rel}\0link:${fs.readlinkSync(absolute)}`);
            }
        }
    };
    walk(root, '');
    return `sha256:${sha256Hex(entries.join('\n'))}`;
}

function dependencyIdentity(name, linkPath) {
    const realpath = fs.realpathSync(linkPath);
    let revision = null;
    let digest;
    try {
        const top = git(realpath, ['rev-parse', '--show-toplevel']);
        if (fs.realpathSync(top) === realpath) {
            const dirty = git(realpath, ['status', '--porcelain']);
            if (!dirty) {
                revision = git(realpath, ['rev-parse', 'HEAD']);
                digest = `git-tree:${git(realpath, ['rev-parse', 'HEAD^{tree}'])}`;
            }
        }
    } catch (_) {
        revision = null;
    }
    return { name, realpath, revision, treeDigest: digest || treeDigest(realpath) };
}

function candidateDigest(root) {
    const dirty = git(root, ['status', '--porcelain', '--untracked-files=all']);
    if (dirty) return treeDigest(root);
    return `git-tree:${git(root, ['rev-parse', 'HEAD^{tree}'])}`;
}

function assertPinnedSourceLinks(root, dependencies) {
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(root) !== root) throw new SchemaError('candidate source root is not canonical: ' + root);
    const pinned = new Set(dependencies.map(value => value.realpath));
    let count = 0;
    function walk(directory) {
        for (const name of fs.readdirSync(directory)) {
            if (name === '.git') continue;
            if (++count > 100000) throw new SchemaError('candidate source inventory exceeds bound');
            const target = path.join(directory, name); const entry = fs.lstatSync(target);
            if (entry.isSymbolicLink()) {
                if (!pinned.has(fs.realpathSync(target))) throw new SchemaError('candidate source contains an unpinned symlink: ' + path.relative(root, target));
            } else if (entry.isDirectory()) walk(target);
        }
    }
    walk(root);
}

export function verifyCandidateSources(config) {
    const verified = {};
    for (const repo of ['ploinky', 'localLlms', 'explorer']) {
        const entry = config.repos[repo];
        assertPinnedSourceLinks(entry.candidateRoot, config.dependencies);
        const actual = entry.sourceDigest.startsWith('sha256:') ? treeDigest(entry.candidateRoot) : candidateDigest(entry.candidateRoot);
        if (actual !== entry.sourceDigest) throw new SchemaError('candidate source changed since configure: ' + repo);
        verified[repo] = actual;
    }
    return verified;
}

// Create a task-owned baseline staging copy of `revision` with `git archive`,
// then verify every extracted regular file against the revision's blob list.
function createBaselineStage(candidateRoot, revision, stageRoot) {
    if (fs.existsSync(stageRoot)) throw new Error(`refusing existing baseline stage ${stageRoot}`);
    fs.mkdirSync(stageRoot, { recursive: true, mode: 0o700 });
    const archive = spawnSync('git', ['-C', candidateRoot, 'archive', '--format=tar', revision], {
        timeout: 120000, maxBuffer: 1024 * 1024 * 1024,
    });
    if (archive.status !== 0) throw new Error(`git archive ${revision} failed`);
    const extract = spawnSync('tar', ['-x', '-f', '-', '-C', stageRoot], { input: archive.stdout, timeout: 120000 });
    if (extract.status !== 0) throw new Error(`tar extraction into ${stageRoot} failed`);
    const listing = git(candidateRoot, ['ls-tree', '-r', '-z', '--full-tree', revision]).split('\0').filter(Boolean);
    let checked = 0;
    for (const line of listing) {
        const [meta, file] = line.split('\t');
        const [mode, type, object] = meta.split(' ');
        if (type !== 'blob' || mode === '120000') continue;
        const bytes = fs.readFileSync(path.join(stageRoot, file));
        const hash = spawnSync('git', ['hash-object', '--stdin'], { input: bytes, encoding: 'utf8' }).stdout.trim();
        if (hash !== object) throw new Error(`baseline stage file ${file} does not match ${revision}`);
        checked += 1;
    }
    return { checked };
}

function linkDependencies(stageRoot, dependencies) {
    const directory = path.join(stageRoot, 'node_modules');
    fs.mkdirSync(directory, { recursive: true });
    for (const dependency of dependencies) {
        const target = path.join(directory, dependency.name);
        if (!fs.existsSync(target)) fs.symlinkSync(dependency.realpath, target);
    }
}

function writeCases(evidenceRoot) {
    const manifest = buildRequiredCaseManifest();
    const casesPath = path.join(evidenceRoot, 'cases.json');
    writePrivateJson(casesPath, manifest);
    return { casesPath, casesDigest: fileDigest(casesPath) };
}

function readJsonBounded(filePath, maxBytes) {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new SchemaError(`${filePath} is not a regular file`);
    if (stat.size > maxBytes) throw new SchemaError(`${filePath} exceeds ${maxBytes} bytes`);
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadConfig(configPath) {
    const config = validateConfig(readJsonBounded(configPath, 128 * 1024));
    const cases = validateCaseManifest(readJsonBounded(config.casesPath, 1024 * 1024));
    if (fileDigest(config.casesPath) !== config.casesDigest) throw new SchemaError('case manifest digest changed');
    return { config, cases };
}

function verifyDependenciesUnchanged(config) {
    for (const dependency of config.dependencies) {
        const current = dependencyIdentity(dependency.name, dependency.realpath);
        if (current.revision !== dependency.revision || current.treeDigest !== dependency.treeDigest) {
            throw new SchemaError(`dependency ${dependency.name} changed since configure`);
        }
    }
}

async function configure(options) {
    const ploinky = requireAbsolute(options.ploinky, 'ploinky');
    const explorer = requireAbsolute(options.explorer, 'explorer');
    const localLlms = requireAbsolute(options['local-llms'], 'local-llms');
    const images = requireAbsolute(options.images, 'images');
    const baseline = requireAbsolute(options.baseline, 'baseline');
    const evidenceRoot = requireAbsolute(options['evidence-root'], 'evidence-root');
    const output = requireAbsolute(options.output, 'output');
    const documentSuffix = options['document-suffix'] || 'claude';
    if (!fs.existsSync(evidenceRoot)) fs.mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
    if (path.dirname(output) !== evidenceRoot) throw new UsageError('--output must be inside --evidence-root');
    const revisions = {
        ploinky: options['ploinky-base'] || PLAN_PINS.ploinky,
        explorer: options['explorer-base'] || PLAN_PINS.explorer,
        localLlms: options['local-llms-base'] || PLAN_PINS.localLlms,
        images: PLAN_PINS.images,
    };
    const dependencies = [
        dependencyIdentity('achillesAgentLib', path.join(ploinky, 'node_modules', 'achillesAgentLib')),
        dependencyIdentity('mcp-sdk', path.join(ploinky, 'node_modules', 'mcp-sdk')),
    ];
    const stageRoot = path.join(evidenceRoot, 'baseline-stage');
    const repo = (key, root, exportName, stage) => {
        const revision = revisions[key];
        git(root, ['cat-file', '-e', `${revision}^{commit}`]);
        return {
            baselineRevision: revision,
            baselineExport: path.join(baseline, exportName),
            baselineStage: stage,
            candidateRoot: key === 'images' ? null : root,
            sourceDigest: key === 'images' ? `git-tree:${git(root, ['rev-parse', `${revision}^{tree}`])}` : candidateDigest(root),
            instructionDigests: key === 'images' ? {} : instructionDigests(root),
        };
    };
    const { casesPath, casesDigest } = writeCases(evidenceRoot);
    const config = validateConfig({
        schema: 1,
        runId: randomRunId(),
        createdAt: new Date().toISOString(),
        documentSuffix,
        node: { absoluteExecutable: process.execPath, version: process.version },
        repos: {
            ploinky: repo('ploinky', ploinky, 'ploinky', path.join(stageRoot, 'ploinky')),
            explorer: repo('explorer', explorer, 'AssistOSExplorer', path.join(stageRoot, 'explorer')),
            localLlms: repo('localLlms', localLlms, 'local-llms', path.join(stageRoot, 'local-llms')),
            images: repo('images', images, 'container-image-builds', null),
        },
        dependencies,
        evidenceRoot,
        casesPath,
        casesDigest,
        engine: null,
        ssh: null,
    });
    writePrivateJson(output, config);
    console.log(JSON.stringify({ output, runId: config.runId, cases: casesPath }, null, 2));
    return EXIT.PASS;
}

async function spawnSuite({ cwd, files, env, eventsPath, deadlineMs = DEFAULT_SUITE_DEADLINE_MS }) {
    const result = await runBoundedProcess(process.execPath, [
        '--test', '--test-reporter=' + REPORTER, '--test-reporter-destination=' + eventsPath,
        '--test-reporter=dot', '--test-reporter-destination=stderr', ...files,
    ], { cwd, env, deadlineMs, maxBytes: 256 * 1024 });
    return { exitCode: result.status,
        signal: result.signal || (result.timedOut ? 'deadline' : result.truncated ? 'output-bound' : result.cancelled ? 'cancelled' : result.errorCode || result.settlementForced ? 'transport-incomplete' : null),
        stderr: result.stderr };
}

// Run one suite with the native reporter in an owned short temp directory.
export async function runSuite({
    root,
    files,
    runId,
    childId,
    eventsPath,
    agentLibDir,
    extraEnv = {},
    deadlineMs,
    required = [],
    baseline = null,
    knownBaselineFailures = new Map(),
}) {
    // The owned temp directory lives outside the candidate root: a worktree
    // nested in another Ploinky workspace would otherwise let test
    // workspaces discover the parent `.ploinky` (see S0 evidence), and a
    // relative TMPDIR breaks suites that change directory.
    const tempParent = fs.realpathSync(process.env.PLOINKY_HWL_TEMP_PARENT || os.tmpdir());
    const temp = createOwnedShortTemp(tempParent, { name: `hwl-${childId.replace(/[^A-Za-z0-9-]/g, '-')}-${randomRunId().slice(0, 8)}` });
    let run;
    try {
        // Test children never see the real HOME (~/.ploinky-box host
        // records, locks): it is a fresh directory inside the owned temp tree.
        const home = path.join(temp.path, 'home');
        fs.mkdirSync(home, { mode: 0o700 });
        const env = {
            PATH: process.env.PATH || '/usr/bin:/bin',
            HOME: home,
            TMPDIR: temp.path,
            PLOINKY_ROOT: root,
            PLOINKY_HWL_RUN_ID: runId,
            PLOINKY_HWL_CHILD_ID: childId,
            PLOINKY_HWL_TEST_ROOT: root,
            ...(agentLibDir ? { PLOINKY_AGENTLIB_DIR: agentLibDir } : {}),
            ...extraEnv,
        };
        run = await spawnSuite({ cwd: root, files, env, eventsPath, deadlineMs });
    } finally {
        removeOwnedShortTemp(temp);
    }
    let eventText = '';
    try {
        eventText = fs.readFileSync(eventsPath, 'utf8');
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
    const evaluation = evaluateSuiteRun({
        exitCode: run.exitCode,
        signal: run.signal,
        eventText,
        runId,
        childId,
        files,
        required,
        baseline,
        knownBaselineFailures,
    });
    return { ...evaluation, exitCode: run.exitCode, signal: run.signal, stderrTail: run.stderr.slice(-4096) };
}

// Explorer's tests import Ploinky as the sibling '../ploinky' of the Explorer
// root (for example explorer/tests/unit/hardwareLimitsPanel.test.js). Run them
// in place only when that sibling is exactly the configured Ploinky candidate;
// otherwise stage the verified Explorer candidate beside a 'ploinky' link to
// that candidate. Any other resulting sibling is refused, never tested.
export function assertExplorerPloinkySibling(explorerRoot, ploinkyRoot) {
    const sibling = path.join(path.dirname(explorerRoot), 'ploinky');
    let actual = null;
    try { actual = fs.realpathSync(sibling); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (actual !== fs.realpathSync(ploinkyRoot)) {
        throw new SchemaError(`Explorer's sibling ${sibling} is ${actual || 'absent'}, not the configured Ploinky candidate ${ploinkyRoot}`);
    }
    return sibling;
}

export function prepareExplorerLayout({ explorerRoot, explorerDigest, ploinkyRoot, stageParent, runId }) {
    try {
        assertExplorerPloinkySibling(explorerRoot, ploinkyRoot);
        return { root: explorerRoot, staged: false, stage: null };
    } catch (error) {
        if (!(error instanceof SchemaError)) throw error;
    }
    const stage = path.join(stageParent, `explorer-layout-${runId}`);
    if (fs.existsSync(stage)) throw new SchemaError(`refusing existing Explorer layout stage ${stage}`);
    fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
    const root = path.join(stage, path.basename(explorerRoot) === 'ploinky' ? 'explorer' : path.basename(explorerRoot));
    try {
        if (explorerDigest.startsWith('git-tree:')) {
            // A clean candidate: its exact committed tree, every blob verified.
            createBaselineStage(explorerRoot, 'HEAD', root);
            if (`git-tree:${git(explorerRoot, ['rev-parse', 'HEAD^{tree}'])}` !== explorerDigest) throw new SchemaError('Explorer candidate tree changed while staging');
        } else {
            const copy = (from, to) => {
                fs.mkdirSync(to, { mode: 0o700 });
                for (const name of fs.readdirSync(from).sort()) {
                    if (name === '.git') continue;
                    const entry = fs.lstatSync(path.join(from, name));
                    if (entry.isDirectory()) copy(path.join(from, name), path.join(to, name));
                    else if (entry.isFile()) fs.copyFileSync(path.join(from, name), path.join(to, name), fs.constants.COPYFILE_EXCL);
                    else if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(path.join(from, name)), path.join(to, name));
                }
            };
            copy(explorerRoot, root);
            if (treeDigest(root) !== explorerDigest) throw new SchemaError('staged Explorer copy differs from the configured candidate digest');
        }
        fs.symlinkSync(fs.realpathSync(ploinkyRoot), path.join(stage, 'ploinky'));
        assertExplorerPloinkySibling(root, ploinkyRoot);
    } catch (error) {
        fs.rmSync(stage, { recursive: true, force: true });
        throw error;
    }
    // The staged copy is what the suite runs; a suite that mutates it
    // invalidates the run exactly like a mutation of the candidate itself.
    return { root, staged: true, stage, stageDigest: treeDigest(root) };
}

export function assertExplorerLayoutUnchanged(layout) {
    if (layout?.staged && treeDigest(layout.root) !== layout.stageDigest) throw new SchemaError('candidate source changed during the suite: explorer (staged layout)');
}

function phaseFiles(cases, phase, repo) {
    const required = cases.cases.filter((entry) => entry.phase === phase && REPO_KEYS[entry.repo] === repo);
    const regressions = PHASE_REGRESSIONS[phase]?.[repo] || [];
    const files = [...new Set([...required.map((entry) => entry.file), ...regressions])].sort();
    return { required, files };
}

function inventoryPath(evidenceRoot, repo) {
    return path.join(evidenceRoot, `baseline-inventory-${repo}.json`);
}

function summarize(report) {
    return {
        verdict: report.verdict,
        counts: report.counts,
        problems: report.suites.flatMap((suite) => suite.problems).slice(0, 50),
        failedCases: report.cases.filter((entry) => entry.result !== 'pass').slice(0, 50),
        newFailures: report.suites.flatMap((suite) => suite.newFailures).slice(0, 50),
    };
}

function buildReport({ runId, command, phase, suites, cases, sources, verdict }) {
    const counts = {
        discovered: suites.reduce((sum, suite) => sum + suite.discovered, 0),
        completed: suites.reduce((sum, suite) => sum + suite.completed, 0),
        failed: suites.reduce((sum, suite) => sum + suite.newFailures.length + suite.baselineFailures.length, 0),
        newFailures: suites.reduce((sum, suite) => sum + suite.newFailures.length, 0),
        baselineFailures: suites.reduce((sum, suite) => sum + suite.baselineFailures.length, 0),
        requiredCases: cases.length,
        requiredPassed: cases.filter((entry) => entry.result === 'pass').length,
    };
    return validateReport({
        schema: 1,
        runId,
        command,
        phase,
        verdict,
        exitCode: EXIT[verdict],
        sources,
        environment: { node: process.version, platform: process.platform, arch: process.arch },
        counts,
        cases,
        suites: suites.map((suite) => ({
            repo: suite.repo,
            files: suite.files,
            exitCode: suite.exitCode,
            signal: suite.signal,
            streamComplete: suite.streamComplete,
            discovered: suite.discovered,
            completed: suite.completed,
            problems: suite.problems.slice(0, 200),
            newFailures: suite.newFailures.slice(0, 200),
            baselineFailures: suite.baselineFailures.slice(0, 200),
            removed: (suite.removed || []).slice(0, 200),
            newlySkipped: (suite.newlySkipped || []).slice(0, 200),
        })),
        streamComplete: suites.length > 0 && suites.every((suite) => suite.streamComplete),
        cleanup: { state: 'complete', steps: [], failures: [] },
        artifacts: suites.map((suite) => suite.eventsPath),
    });
}

function agentLibFor(config) {
    return config.dependencies.find((entry) => entry.name === 'achillesAgentLib')?.realpath || '';
}

async function baselineCommand(options) {
    const { config, cases } = loadConfig(requireAbsolute(options.config, 'config'));
    verifyDependenciesUnchanged(config);
    const phases = (options.phases || 's0,p0,p1,p1-ram').split(',');
    const suites = [];
    for (const repo of ['ploinky', 'localLlms', 'explorer']) {
        const entry = config.repos[repo];
        if (!fs.existsSync(entry.baselineStage)) {
            const { checked } = createBaselineStage(entry.candidateRoot, entry.baselineRevision, entry.baselineStage);
            console.error(`[baseline] staged ${repo} ${entry.baselineRevision} (${checked} files verified)`);
            if (repo === 'ploinky') linkDependencies(entry.baselineStage, config.dependencies);
        }
        const files = [...new Set(phases.flatMap((phase) => phaseFiles(cases, phase, repo).files))]
            .filter((file) => fs.existsSync(path.join(entry.baselineStage, file)))
            .sort();
        if (!files.length) continue;
        const eventsPath = path.join(config.evidenceRoot, `baseline-events-${repo}.jsonl`);
        const result = await runSuite({
            root: entry.baselineStage,
            files,
            runId: config.runId,
            childId: `baseline-${repo}`,
            eventsPath,
            agentLibDir: agentLibFor(config),
        });
        if (result.streamComplete && !result.signal && !result.problems.length && result.discovered > 0) writePrivateJson(inventoryPath(config.evidenceRoot, repo), {
            schema: 1,
            revision: entry.baselineRevision,
            files,
            tests: Object.fromEntries(result.inventory),
            failureSignatures: Object.fromEntries(result.failureSignatures || []),
        });
        suites.push({ ...result, repo, files, eventsPath });
    }
    verifyDependenciesUnchanged(config);
    // Baseline assertion failures are recorded, not converted to passes. A
    // harness failure (signal, incomplete stream, load failure) is BLOCKED.
    const harnessBroken = suites.length === 0 || suites.some((suite) => !suite.streamComplete || suite.signal || suite.problems.length > 0 || suite.discovered === 0);
    const verdict = harnessBroken ? 'BLOCKED' : 'PASS';
    const report = buildReport({
        runId: config.runId, command: 'baseline', phase: phases.join(','), suites, cases: [], verdict,
        sources: Object.fromEntries(Object.entries(config.repos).map(([key, value]) => [key, value.baselineRevision])),
    });
    writePrivateJson(path.join(config.evidenceRoot, `report_baseline_${config.documentSuffix}.json`), report);
    console.log(JSON.stringify(summarize(report), null, 2));
    return report.exitCode;
}

async function offlineCommand(options) {
    const { config, cases } = loadConfig(requireAbsolute(options.config, 'config'));
    let verifiedSources = verifyCandidateSources(config);
    const phase = options.phase;
    if (!phase) throw new UsageError('offline needs --phase');
    verifyDependenciesUnchanged(config);
    const suites = [];
    const allCases = [];
    for (const repo of ['ploinky', 'localLlms', 'explorer']) {
        const { required, files } = phaseFiles(cases, phase, repo);
        if (!required.length && !files.length) continue;
        verifiedSources = verifyCandidateSources(config);
        const layout = repo === 'explorer' ? prepareExplorerLayout({
            explorerRoot: config.repos.explorer.candidateRoot, explorerDigest: config.repos.explorer.sourceDigest,
            ploinkyRoot: config.repos.ploinky.candidateRoot, stageParent: config.evidenceRoot, runId: randomRunId(),
        }) : null;
        const root = layout?.root || config.repos[repo].candidateRoot;
        const existing = files.filter((file) => fs.existsSync(path.join(root, file)));
        const missing = files.filter((file) => !existing.includes(file));
        let inventory = null;
        const knownBaselineFailures = new Map();
        try {
            const recorded = readJsonBounded(inventoryPath(config.evidenceRoot, repo), 16 * 1024 * 1024);
            if (recorded.revision !== config.repos[repo].baselineRevision) throw new SchemaError('baseline inventory revision changed: ' + repo);
            inventory = new Map(Object.entries(recorded.tests)
                .filter(([testId]) => existing.some((file) => testId.startsWith(`${file}::`))));
            for (const [testId, result] of inventory) {
                if (result === 'fail' && recorded.failureSignatures?.[testId]) knownBaselineFailures.set(testId, recorded.failureSignatures[testId]);
            }
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
        const eventsPath = path.join(config.evidenceRoot, `offline-${phase}-events-${repo}.jsonl`);
        const result = existing.length
            ? await runSuite({
                root,
                files: existing,
                runId: config.runId,
                childId: `offline-${phase}-${repo}`,
                eventsPath,
                agentLibDir: repo === 'ploinky' ? agentLibFor(config) : '',
                required,
                baseline: inventory,
                knownBaselineFailures,
            })
            : evaluateSuiteRun({ exitCode: 1, eventText: '', files: [], required });
        // The staged Explorer layout is a runner-owned copy; the events file
        // and report are the evidence.
        try { assertExplorerLayoutUnchanged(layout); }
        finally { if (layout?.staged) fs.rmSync(layout.stage, { recursive: true, force: true }); }
        verifiedSources = verifyCandidateSources(config);
        for (const file of missing) result.problems.push(`required test file is missing: ${file}`);
        if (missing.length) result.verdict = 'FAIL';
        suites.push({ ...result, repo, files: existing, eventsPath });
        allCases.push(...result.cases);
    }
    verifiedSources = verifyCandidateSources(config);
    if (!suites.length) throw new UsageError(`phase '${phase}' has no required cases`);
    verifyDependenciesUnchanged(config);
    const verdict = suites.some((suite) => suite.verdict !== 'PASS') ? 'FAIL' : 'PASS';
    const report = buildReport({
        runId: config.runId, command: 'offline', phase, suites, cases: allCases, verdict,
        sources: verifiedSources,
    });
    writePrivateJson(path.join(config.evidenceRoot, `report_offline-${phase}_${config.documentSuffix}.json`), report);
    console.log(JSON.stringify(summarize(report), null, 2));
    return report.exitCode;
}

async function selfTest(options) {
    const evidenceRoot = options['evidence-root'] ? requireAbsolute(options['evidence-root'], 'evidence-root') : '';
    const manifest = buildRequiredCaseManifest();
    const required = manifest.cases.filter((entry) => entry.phase === 's0');
    const files = [...new Set(required.map((entry) => entry.file))];
    const runId = randomRunId();
    const outputRoot = evidenceRoot || fs.mkdtempSync(path.join(PLOINKY_ROOT, '.hwl-self-'));
    const eventsPath = path.join(outputRoot, 'self-test-events.jsonl');
    try {
        const result = await runSuite({ root: PLOINKY_ROOT, files, runId, childId: 'self-test', eventsPath, required });
        const report = buildReport({
            runId, command: 'self-test', phase: 's0', suites: [{ ...result, repo: 'ploinky', files, eventsPath }],
            cases: result.cases, verdict: result.verdict, sources: {},
        });
        if (evidenceRoot) writePrivateJson(path.join(evidenceRoot, 'report_self-test_claude.json'), report);
        console.log(JSON.stringify(summarize(report), null, 2));
        return report.exitCode;
    } finally {
        if (!evidenceRoot) fs.rmSync(outputRoot, { recursive: true, force: true });
    }
}

// A frozen candidate for live use: the committed revision through git
// archive (every blob verified) plus real copies of the pinned dependencies,
// so the live source digest needs no symlink and cannot follow a changing one.
function buildFrozenCandidate(config, runId) {
    const source = config.repos.ploinky.candidateRoot;
    if (git(source, ['status', '--porcelain', '--untracked-files=no'])) throw new UsageError('the Ploinky candidate has uncommitted tracked changes; commit before prepare-live');
    const revision = git(source, ['rev-parse', 'HEAD']);
    const stage = path.join(config.evidenceRoot, `candidate-${runId}`);
    createBaselineStage(source, revision, stage);
    verifyDependenciesUnchanged(config);
    const modules = path.join(stage, 'node_modules');
    if (!fs.existsSync(modules)) fs.mkdirSync(modules, { mode: 0o755 });
    for (const dependency of config.dependencies) {
        const target = path.join(modules, dependency.name);
        if (dependency.revision) {
            createBaselineStage(dependency.realpath, dependency.revision, target);
            continue;
        }
        const copy = (from, to) => {
            fs.mkdirSync(to, { mode: 0o755 });
            for (const name of fs.readdirSync(from).sort()) {
                if (name === '.git') continue;
                const entry = fs.lstatSync(path.join(from, name));
                if (entry.isDirectory()) copy(path.join(from, name), path.join(to, name));
                else if (entry.isFile()) fs.copyFileSync(path.join(from, name), path.join(to, name), fs.constants.COPYFILE_EXCL);
                else throw new SchemaError(`dependency ${dependency.name} contains a link or special file; it cannot be frozen`);
            }
        };
        copy(dependency.realpath, target);
        if (treeDigest(target) !== dependency.treeDigest) throw new SchemaError(`dependency ${dependency.name} copy differs from its pinned digest`);
    }
    const root = fs.realpathSync(stage);
    return { root, revision, digest: liveSourceDigest(root) };
}

function writePrivateText(target, text) {
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomRunId()}.tmp`);
    fs.writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, target);
}

function prepareLive(options) {
    const { config } = loadConfig(requireAbsolute(options.config, 'config'));
    const block = options.block;
    const runPath = requireAbsolute(options.run, 'run');
    if (path.dirname(runPath) !== config.evidenceRoot) throw new UsageError('--run must be inside the evidence root');
    const configDigest = fileDigest(requireAbsolute(options.config, 'config'));
    const runId = randomRunId();
    const unsupported = Object.fromEntries((LIVE_CASES[block] || []).filter(id => UNSUPPORTED[id]).map(id => [id, UNSUPPORTED[id]]));
    if (CONCRETE_BLOCKS[block]) {
        if (!options.pins) throw new UsageError(`prepare-live --block ${block} needs --pins PATH with the observed host, node, engine, Box image and route pins`);
        const pins = validatePins(readJsonBounded(requireAbsolute(options.pins, 'pins'), 16 * 1024), block);
        // Refuse before anything is staged when the workspace leaves no room
        // for the CLI's Unix sockets (pins.workspaceParentRoot selects it).
        const socketProblem = workspaceSocketProblem(proposedWorkspace(block, pins, runId).path);
        if (socketProblem) { console.error(`[prepare-live] BLOCKED: ${socketProblem}`); return EXIT.BLOCKED; }
        const candidate = buildFrozenCandidate(config, runId);
        if (CONCRETE_BLOCKS[block].remote) {
            const payloadPath = path.join(config.evidenceRoot, `candidate-${runId}.tar`);
            candidate.payload = { path: payloadPath, ...writeUstar(candidate.root, payloadPath) };
        }
        const manifest = validateRunManifest(buildConcreteManifest({
            block, runId, configDigest, casesDigest: config.casesDigest, documentSuffix: config.documentSuffix, pins, candidate,
            image: explorerFixtureImage(config.repos.explorer.candidateRoot), ports: selectPorts(pins), unsupported,
        }));
        validateProfile(manifest, { partial: true });
        if (manifest.target.remote) validateStage(manifest);
        writePrivateJson(runPath, manifest);
        const summaryPath = summaryPathFor(runPath);
        writePrivateText(summaryPath, renderSummary(manifest, runPath));
        console.log(JSON.stringify({ run: runPath, summary: summaryPath, block, state: manifest.state }, null, 2));
        return EXIT.PASS;
    }
    const manifest = validateRunManifest({
        schema: 1,
        runId,
        configDigest,
        casesDigest: config.casesDigest,
        block,
        target: { engine: config.engine, ssh: config.ssh, note: 'Unsupported block: no case in it has an implemented live executor, so this proposal cannot be provisioned or run. No file grants permission.', cases: LIVE_CASES[block], unsupported },
        state: 'proposed',
        workspace: { proposedParent: null, instance: null },
        ports: { tcp: null, udp: null },
        deadlines: { coreMs: 30000, fullGraphMs: 20 * 60 * 1000, modelLoadMs: 20 * 60 * 1000, cleanupMs: 5 * 60 * 1000 },
        images: [],
        ownedBoxes: [],
        ownedProcesses: [],
        ownedPaths: [],
        preInventory: {},
        operations: [],
        cleanup: { state: 'not-started', steps: [], failures: [] },
    });
    writePrivateJson(runPath, manifest);
    console.log(JSON.stringify({ run: runPath, block, state: manifest.state }, null, 2));
    return EXIT.PASS;
}

async function runLive(options, command) {
    const runPath = requireAbsolute(options.run, 'run');
    if (!options.authorization) {
        console.error('[live] APPROVAL REQUIRED: no execution-time authorization binding supplied. Nothing was run.');
        return EXIT.BLOCKED;
    }
    try {
        const report = await runLiveCommand({ runPath, authorizationPath: requireAbsolute(options.authorization, 'authorization'), action: command, remoteLocal: options['remote-local'] || null, expectedManifestDigest: options['expected-manifest-digest'] || null });
        console.log(JSON.stringify(report, null, 2));
        return report.exitCode;
    } catch (error) {
        console.error('[live] BLOCKED: ' + error.message);
        return EXIT.BLOCKED;
    }
}

export async function main(argv = process.argv.slice(2)) {
    const { command, options } = parseArgs(argv);
    switch (command) {
    case 'configure': return configure(options);
    case 'self-test': return selfTest(options);
    case 'baseline': return baselineCommand(options);
    case 'offline': return offlineCommand(options);
    case 'prepare-live': return prepareLive(options);
    case 'provision': return runLive(options, 'provision');
    case 'live': return runLive(options, 'live');
    case 'cleanup': return runLive(options, 'cleanup');
    default: throw new UsageError(`unknown command '${command || ''}'`);
    }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().then((code) => {
        process.exitCode = code;
    }, (error) => {
        console.error(`[verify] ${error?.message || error}`);
        process.exitCode = error instanceof UsageError || error instanceof SchemaError ? EXIT.BLOCKED : EXIT.FAIL;
    });
}
