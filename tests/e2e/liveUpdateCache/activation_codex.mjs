import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AcceptanceError, need, LIMITS, parseStrictJson, smokeOrigin } from './manifest_codex.mjs';
import { OPTIONAL_ACTIVATION, CAMPAIGN_RESERVES_MS, admitActivationStart, admitCampaignImageReserve } from './contracts_codex.mjs';
import { runOwnedCommand, buildCommandEnvironment } from './host_command_codex.mjs';
import { activationEnvironment } from './gates_codex.mjs';
import { receiptInspectArgs, parseReceiptInspect } from './engine_codex.mjs';
import { readBoundedRegularFile } from './worker_codex.mjs';
import * as prerequisites from '../../integration/local-skills/deployed-prerequisites.mjs';

// UA: the one runner-owned optional-agent activation on R2. UA-0 prepares the workspace's own Explorer smoke checkout
// (owned `npm ci`, Playwright and Chromium pins, clean status); UA-1 runs the canonical Marketplace command once against the
// fresh Box and produces the receipt through the repository's own helpers; the receipt is then validated against R2's
// manifest. Nothing here reopens a freshness limit: every step is guarded by actual-time admission.
const RECEIPT_BYTES = 64 * 1024, GIT_BIN = '/usr/bin/git';
const iso = ms => new Date(ms).toISOString();
export const sameState = (left, right) => left.generation === right.generation && isDeepStrictEqual(left.runtimes, right.runtimes);
const baseName = row => row[0].split('/').at(-1);

// The workspace's deployed Explorer checkout, whose tests/smoke is the directory the receipt helper requires.
export function workspaceSmoke(manifest) {
    const checkout = path.join(manifest.workspace.path, '.ploinky', 'repos', 'AssistOSExplorer');
    return Object.freeze({ checkout, smoke: path.join(checkout, 'tests', 'smoke') });
}

const nodeTools = (manifest, processEnv) => {
    const nodeDir = path.dirname(manifest.host.node.path);
    return { node: manifest.host.node.path, npm: path.join(nodeDir, 'npm'), npx: path.join(nodeDir, 'npx'),
        env: buildCommandEnvironment(processEnv, { PATH: `${nodeDir}:${processEnv?.PATH ?? '/usr/bin:/bin'}`, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' }) };
};

// UA-0. Each failure has its own fixed code. A command that does not settle inside its deadline is a custody handoff.
export async function prepareWorkspaceSmoke({ release2, deps, io = fs, processEnv = process.env }) {
    const { checkout, smoke } = workspaceSmoke(release2), { node, npm, npx, env } = nodeTools(release2, processEnv), install = OPTIONAL_ACTIVATION.install;
    const exitMapped = async (spec, code) => { try { return await runOwnedCommand(spec, deps); } catch (error) { if (error?.code === 'command-exit-unexpected') throw new AcceptanceError(code); throw error; } };
    await exitMapped({ operation: 'ua-workspace-npm-ci', kind: 'mutation', cwd: smoke, env, argv: [npm, ...install.argv.slice(1)], deadlineMs: install.deadlineMs }, 'workspace-smoke-install-failed');
    let want; try { want = parseStrictJson(readBoundedRegularFile(path.join(smoke, 'package.json'), LIMITS.manifestBytes, io), LIMITS.manifestBytes)?.devDependencies?.['@playwright/test']; } catch { want = undefined; }
    const version = await exitMapped({ operation: 'ua-playwright-version', kind: 'read', cwd: smoke, env, argv: [npx, '--no-install', 'playwright', '--version'], deadlineMs: 60000, maxStdoutBytes: 4096 }, 'workspace-playwright-unpinned');
    const have = version.stdout.toString('utf8').split('\n')[0].trim().split(/\s+/).at(-1);
    need(typeof want === 'string' && want !== '' && have === want, 'workspace-playwright-unpinned');
    await exitMapped({ operation: 'ua-chromium-present', kind: 'read', cwd: smoke, env, deadlineMs: 60000, maxStdoutBytes: 4096, allowedExitCodes: [0],
        argv: [node, '-e', 'const p=require("playwright-core").chromium.executablePath(); process.exit(require("fs").existsSync(p)?0:1)'] }, 'workspace-chromium-missing');
    const status = await runOwnedCommand({ operation: 'ua-workspace-clean', kind: 'git', cwd: checkout, env, argv: [GIT_BIN, '-C', checkout, 'status', '--porcelain=v1'], deadlineMs: 30000 }, deps);
    need(status.stdout.length === 0, 'workspace-checkout-unclean');
    return Object.freeze({ exitCode: 0, clean: true });
}

// Read-only Box inspection through the owned runner, selecting only the fields the helper reads.
export function createInspectBox({ manifest, deps, env, cwd }) {
    return async container => {
        const result = await runOwnedCommand({ operation: 'ua-box-inspect', kind: 'read', cwd, env, argv: receiptInspectArgs(manifest.engine.path, container), deadlineMs: 30000, maxStdoutBytes: 1024 * 1024 }, deps);
        return parseReceiptInspect(result.stdout);
    };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const targetEnvironment = (release2, activationEnv) => ({ SMOKE_WORKSPACE_ROOT: release2.workspace.path, SMOKE_BASE_URL: activationEnv.SMOKE_BASE_URL, SMOKE_PLOINKY_BOX_CONTAINER: activationEnv.SMOKE_PLOINKY_BOX_CONTAINER });

// The receipt must be the receipt of THIS generation: validated by the repository's own helper, then re-bound to R2's manifest.
export async function assertActivationReceipt({ receiptPath, release2, u7dFinishedAt, postObservedAt, env, helper = prerequisites, inspectBox, io = fs }) {
    const invalid = () => new AcceptanceError('activation-receipt-invalid');
    let bytes, receipt; try { bytes = readBoundedRegularFile(receiptPath, RECEIPT_BYTES, io); receipt = parseStrictJson(bytes, RECEIPT_BYTES); } catch { throw invalid(); }
    try { await helper.assertMarketplacePrerequisite({ env: { ...targetEnvironment(release2, env), SMOKE_OPTIONAL_GATE_RECEIPT: receiptPath }, inspectBox, now: postObservedAt }); } catch { throw invalid(); }
    const port = release2.publications[0].hostPort, second = value => Math.floor(Date.parse(value) / 1000);
    const stats = receipt.stats;
    if (!(receipt.gate === 'optional' && receipt.result === 'passed' && receipt.exitCode === 0 && same(receipt.command, OPTIONAL_ACTIVATION.command)
        && receipt.boxId === release2.box.id && second(receipt.boxStartedAt) === second(release2.box.startedAt) && receipt.workspaceRoot === release2.workspace.path
        && receipt.baseURL === smokeOrigin(release2.publications[0]) && receipt.publication?.hostPort === String(port) && receipt.publication.hostIp === '127.0.0.1'
        && Date.parse(receipt.startedAt) >= u7dFinishedAt && Date.parse(receipt.finishedAt) <= postObservedAt && Date.parse(receipt.startedAt) <= Date.parse(receipt.finishedAt)
        && stats?.expected === 1 && stats.skipped === 0 && stats.unexpected === 0 && stats.flaky === 0)) throw invalid();
    return Object.freeze({ receiptSha256: createHash('sha256').update(bytes).digest('hex'), runId: receipt.runId, startedAt: receipt.startedAt, finishedAt: receipt.finishedAt });
}

// Every default row is unchanged and exactly the three declared optional runtimes appeared; the edge generation may differ.
export function assertActivationWindow({ before, after }) {
    const unchanged = Array.isArray(before?.runtimes) && Array.isArray(after?.runtimes) && before.runtimes.every(row => { const next = after.runtimes.find(item => item[0] === row[0]); return next && isDeepStrictEqual(row, next); });
    const added = Array.isArray(after?.runtimes) ? after.runtimes.filter(row => !before?.runtimes?.some(old => old[0] === row[0])) : [];
    need(unchanged && after.runtimes.length === before.runtimes.length + OPTIONAL_ACTIVATION.agents.length
        && isDeepStrictEqual(added.map(baseName).sort(), [...OPTIONAL_ACTIVATION.agents].sort()), 'activation-epoch-changed');
    return true;
}

export function createActivationPort({ deps, io = fs, processEnv = process.env, now = () => Date.now(), helper = prerequisites }) {
    need(deps, 'activation-port-adapters');
    const paths = release2 => { const stem = release2.runId.replace(/_codex$/, ''), runId = `${stem}-ua`.replace(/[^A-Za-z0-9_-]/g, '-');
        const directory = path.join(release2.evidence.root, 'gates', runId); return { runId, directory, receiptPath: path.join(directory, 'run.json') }; };
    const write = (file, value, flags) => { const fd = io.openSync(file, flags, 0o600);
        try { const bytes = Buffer.from(JSON.stringify(value, null, 2)); let offset = 0; while (offset < bytes.length) { const count = io.writeSync(fd, bytes, offset, bytes.length - offset); need(count > 0, 'evidence-write'); offset += count; } } finally { io.closeSync(fd); } };
    const envFor = (release2, { runId, directory }) => activationEnvironment({ manifest: release2, runId, artifactDir: directory, processEnv });
    return Object.freeze({
        prepare: release2 => prepareWorkspaceSmoke({ release2, deps, io, processEnv }),
        // The running receipt exists, with the safe target fields, before the command is launched. A second UA is refused here.
        async start(release2) {
            const place = paths(release2), env = envFor(release2, place), { smoke } = workspaceSmoke(release2);
            io.mkdirSync(path.dirname(place.directory), { recursive: true, mode: 0o700 });
            try { io.mkdirSync(place.directory, { mode: 0o700 }); } catch (error) { throw new AcceptanceError(error?.code === 'EEXIST' ? 'activation-already-run' : 'activation-artifact-dir'); }
            const inspectBox = createInspectBox({ manifest: release2, deps, env: buildCommandEnvironment(processEnv, {}), cwd: smoke });
            const target = await helper.inspectDeploymentTarget({ env: targetEnvironment(release2, env), inspectBox });
            write(place.receiptPath, { gate: 'optional', result: 'running', exitCode: null, runId: place.runId, directory: io.realpathSync(place.directory), cwd: io.realpathSync(smoke),
                command: [...OPTIONAL_ACTIVATION.command], ...target, startedAt: iso(now()), finishedAt: null, stats: null }, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW);
            return Object.freeze({ ...place });
        },
        // UA-1: the canonical command, once, from the workspace's own smoke directory.
        async execute(release2, place) {
            const { npm, env: base } = nodeTools(release2, processEnv), { smoke } = workspaceSmoke(release2), env = { ...envFor(release2, place), PATH: base.PATH };
            const result = await runOwnedCommand({ operation: 'ua-optional-activation', kind: 'mutation', cwd: smoke, env, argv: [npm, ...OPTIONAL_ACTIVATION.command.slice(1)],
                deadlineMs: OPTIONAL_ACTIVATION.deadlineMs, collect: false, tap: { push: () => true, end() {} }, allowedExitCodes: [0, 1] }, deps);
            return Object.freeze({ exitCode: result.code });
        },
        // The receipt is finished only after the command exited, with the authoritative report's stats; a failure is recorded as failed.
        async finish(release2, place, { exitCode }) {
            const running = parseStrictJson(readBoundedRegularFile(place.receiptPath, RECEIPT_BYTES, io), RECEIPT_BYTES); need(running.result === 'running', 'activation-receipt-invalid');
            let stats = null; try { stats = parseStrictJson(readBoundedRegularFile(path.join(place.directory, 'test-results', 'results.json'), LIMITS.readBytes, io), LIMITS.readBytes).stats ?? null; } catch { stats = null; }
            write(place.receiptPath, { ...running, exitCode, finishedAt: iso(now()), stats, result: exitCode === 0 && stats ? 'passed' : 'failed' }, fs.constants.O_WRONLY | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW);
            need(exitCode === 0 && stats, 'activation-failed');
        },
        verify({ release2, place, u7dFinishedAt, postObservedAt }) {
            const { smoke } = workspaceSmoke(release2), env = envFor(release2, place);
            return assertActivationReceipt({ receiptPath: place.receiptPath, release2, u7dFinishedAt, postObservedAt, env, helper, io,
                inspectBox: createInspectBox({ manifest: release2, deps, env: buildCommandEnvironment(processEnv, {}), cwd: smoke }) });
        },
    });
}

// The whole UA phase, in the SPEC order. `epoch(options)` observes R2 (options: generation, addedGraph); `port` is the activation port.
// Every guard runs before the command it protects, and the activation is never launched when one refuses.
export async function runActivationPhase({ release, known, u7dFinishedAt, epoch, port, wallNow, check }) {
    const at = () => ({ nowMs: wallNow(), boxStartedAt: release.box.startedAt });
    admitActivationStart({ ...at(), includeInstall: true });
    const install = await port.prepare(release); check();
    admitActivationStart({ ...at(), includeInstall: false });
    admitCampaignImageReserve({ nowMs: wallNow(), imageCreatedAt: release.box.imageCreatedAt, reserveMs: CAMPAIGN_RESERVES_MS.B3 });
    // Nothing may have moved since the fresh generation was admitted.
    const before = await epoch({ generation: known.generation }); need(sameState(before, known), 'canonical-epoch-changed'); check();
    const place = await port.start(release); check();
    const run = await port.execute(release, place); check();
    await port.finish(release, place, run);
    const receipt = await port.verify({ release2: release, place, u7dFinishedAt, postObservedAt: wallNow() }); check();
    const first = await epoch({ addedGraph: true }), after = await epoch({ addedGraph: true, generation: first.generation });
    need(sameState(first, after), 'canonical-epoch-changed'); assertActivationWindow({ before, after }); check();
    return { before, after, place, receipt, install };
}
