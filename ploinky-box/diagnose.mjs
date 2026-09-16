import dgram from 'node:dgram';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { buildImageSelection } from '../agentlib/source.mjs';
import { sanitizeAuthorityDiagnostic } from '../cli/sandbox/authorityCommandDiagnostics.mjs';
import { BOX_LABELS, BOX_MEDIA_PORT, resolveBoxImageReference } from './constants.mjs';
import { discoverBoxOwnership } from './engine/discovery.mjs';
import { buildWorkspaceIdentity, resolveWorkspaceIdentity } from './identity.mjs';
import { IMAGE_OBSERVATION_UNAVAILABLE, inspectAndValidateImage, normalizeImageInspect, validateImageContract } from './contract/image.mjs';
import { observeContainerRouterBinding, validateContainerConfiguration } from './contract/container.mjs';
import { agentLibContractFromContainer } from './contract/agentlib.mjs';
import { probeImageAgentLib } from './image-agentlib.mjs';
import { reconcileBoxContainer } from './lifecycle/transactions.mjs';
import { createMutationLockManager } from './locks.mjs';
import { preflightPublications, parseHostPort } from './ports.mjs';
import { buildEngineProcessEnvironment, createProcessRunner } from './process.mjs';
import { createRouterBindingStore, assertRouterBindingAssignable } from './routerBinding.mjs';
import { collectHostDiagnostics } from './diagnose/host.mjs';
import { collectCurrentWorkspaceDiagnostics } from './diagnose/current.mjs';
import { inspectWorkspaceDataPaths } from './workspace-data.mjs';
import { collectRepairAssessments } from './repair/automatic.mjs';
import { annotateRemediations, formatRemediationActions } from './diagnose/remediations.mjs';
import { distributionFamily } from './hostPrerequisites.mjs';

const LIMIT = 4000;
const clean = (value) => sanitizeAuthorityDiagnostic(String(value ?? ''), { limit: LIMIT });
// These wrappers deliberately summarize failed queries without retaining their
// stderr. A failed final query in the same stage supplies that missing evidence.
const QUERY_WRAPPER_FAILURE_CODES = new Set([
    IMAGE_OBSERVATION_UNAVAILABLE,
    'PLOINKY_BOX_IMAGE_CONTRACT_INVALID',
    'PLOINKY_BOX_WEBTTY_NATIVE_CONTRACT_INVALID',
    'PLOINKY_BOX_AGENTLIB_INCOMPATIBLE',
]);

export function diagnosticAdvice(value) {
    const message = String(value || '');
    if (/TCP.*already in use|UDP.*already in use/i.test(message)) {
        return 'Use ss -ltnu (or lsof -i on macOS) to identify the listener. Select an available --port/--udp-port or stop only the known conflicting service, then rerun diagnose with the same port options.';
    }
    if (/\b(?:crun|runc|OCI runtime)\b[\s\S]*\b(?:unknown|unsupported) version(?: specified)?\b/i.test(message)) {
        return 'Run podman info --format json to identify host.ociRuntime.path, run that selected executable with --version, and compare with podman --version. Upgrade the selected OCI runtime to a release compatible with the installed Podman using supported distribution packages or the runtime’s official release, then rerun ploinky diagnose.';
    }
    if (/network namespace.*Permission denied|apparmor|DENIED.*pasta/is.test(message)) {
        return 'Inspect journalctl -k for the matching AppArmor denial. Ask an administrator to review the pasta profile namespace-file and directory access; keep profiles enforced. Rerun this exact probe after the policy is reloaded.';
    }
    if (/fusermount|fuse-overlayfs|mount.*(?:denied|not permitted)/i.test(message)) {
        return 'Check /dev/fuse, podman info storage.graphOptions, and journalctl -k for the failing mount or unmount path. Review that exact AppArmor/SELinux denial; do not switch to privileged containers or disable security profiles.';
    }
    if (/mkdir.*(?:shared|code).*not permitted|overlay|storage driver|graphroot|force_mask/i.test(message)) {
        return 'Inspect the reported driver, graphroot, mount_program and force_mask in podman info and containers/storage.conf. Use the supported overlay configuration on this filesystem; preserve existing data and do not reset or prune the store.';
    }
    if (/uid_map|gid_map|newuidmap|newgidmap|user namespace|cannot clone/i.test(message)) {
        return 'Check newuidmap/newgidmap, /etc/subuid, /etc/subgid and the namespace policy for your login account. Allocate a valid non-overlapping mapping through an administrator; run Ploinky without sudo.';
    }
    if (/systemd|cgroup|dbus|XDG_RUNTIME_DIR/i.test(message)) {
        return 'Run the reported command in a real login session for this account and inspect its XDG_RUNTIME_DIR and Podman cgroup settings. Do not borrow another user’s runtime directory.';
    }
    if (/no space|ENOSPC|disk quota/i.test(message)) return 'Free space or quota on the reported graphroot/workspace filesystem. Do not prune another workspace’s containers or images.';
    if (/pull|registry|resolve|certificate|TLS|connection|timeout|timed out/i.test(message)) {
        return 'Retry the reported command and inspect DNS, registry access, proxy configuration and CA trust. Use podman login for a private registry; do not paste credentials into diagnostic reports.';
    }
    return 'Run the reported command as the same login user and inspect its stderr. Correct that step, then rerun ploinky diagnose; use ploinky logs last for application-level failures.';
}

function failureDetail(error) {
    const parts = [];
    for (let current = error, depth = 0; current && depth < 4; current = current.cause, depth += 1) {
        if (current.message) parts.push(current.message);
    }
    return clean(parts.join('\n'));
}

function failureCommand(error, commands, detail) {
    let wrappedQueryFailure = false;
    for (let cause = error, depth = 0; cause && depth < 5; cause = cause.cause, depth += 1) {
        if (commands.includes(cause.diagnosticCommand)) return cause.diagnosticCommand;
        wrappedQueryFailure ||= QUERY_WRAPPER_FAILURE_CODES.has(cause.code);
    }
    const matched = commands.findLast((entry) => entry.exitCode !== 0 && entry.detail && detail.includes(entry.detail));
    if (matched) return matched;
    // Do not infer a cause from incidental missing-image/container inspections,
    // or from an earlier failure after a later query succeeded. In particular,
    // filesystem errors must not inherit an unrelated command's exit status.
    const last = commands.at(-1);
    return wrappedQueryFailure && last && last.exitCode !== 0 ? last : undefined;
}

export function formatDiagnosticCommand(command) {
    if (!command) return '';
    const quote = (value) => /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
        ? value : `'${value.replaceAll("'", "'\\''")}'`;
    return clean([command.file, ...command.args].map((value) => quote(String(value))).join(' '));
}

export function formatDiagnosticReport(report) {
    const lines = [`Ploinky diagnose — ${clean(report.workspace || 'workspace unavailable')}`];
    for (const check of report.checks) {
        lines.push(`[${check.status.toUpperCase()}] ${clean(check.label)}`);
        if (check.command) lines.push(`  Command: ${formatDiagnosticCommand(check.command)}`);
        if (check.exitCode !== undefined && check.exitCode !== null) lines.push(`  Exit: ${check.exitCode}`);
        if (check.detail) lines.push(`  ${clean(check.detail).replaceAll('\n', '\n  ')}`);
        if (check.next) lines.push(`  Next: ${clean(check.next)}`);
        for (const id of check.actionIds || []) {
            const action = report.actions?.find((entry) => entry.id === id);
            if (!action) continue;
            const mode = action.mode === 'automatic' ? 'AUTO — no sudo'
                : action.requiresSudo === true ? 'SUDO REQUIRED'
                    : action.requiresSudo === false ? 'MANUAL — no sudo' : 'MANUAL — privilege undetermined';
            lines.push(`  Remedy: [${mode}] ${clean(action.title)}${action.required ? '' : ' (conditional/optional)'}`);
        }
    }
    const totals = Object.fromEntries(['pass', 'fail', 'warn', 'skip'].map((status) => [status, report.checks.filter((check) => check.status === status).length]));
    lines.push(`\n${totals.pass} passed, ${totals.fail} failed, ${totals.warn} warnings, ${totals.skip} skipped.`);
    lines.push(report.inspectionOnly
        ? 'Inspection only: full runtime probes are deferred until repair verification.'
        : report.exitCode === 0
        ? 'Deployment environment probes passed. Agent application behavior and external services still need their own checks.'
        : 'Diagnosis found failures or could not complete required probes. Follow the reported next steps and rerun ploinky diagnose.');
    lines.push('Commands referring to diagnostic container IDs record the completed attempt. Rerun ploinky diagnose to reproduce them in new isolated containers.');
    const actions = formatRemediationActions(report.actions || []);
    if (actions) lines.push(`\n${actions.trimEnd()}`);
    return `${lines.join('\n')}\n`;
}

export function createDiagnosticRunner(native, commands, { progress = () => {} } = {}) {
    const query = (file, args, options = {}) => {
        const timeoutMs = Math.min(options.timeoutMs || 30_000, 900_000);
        let result;
        try { result = native.query(file, args, { ...options, timeoutMs }); }
        catch (error) { result = { ok: false, status: 1, stdout: '', stderr: error.message, error }; }
        commands.push({ file: clean(file), args: args.map(clean), exitCode: result.status,
            ...(result.ok ? {} : { detail: clean(result.stderr || result.stdout || result.error?.message),
                ...(result.error?.code === 'ETIMEDOUT' ? { timedOut: true } : {}) }) });
        return result;
    };
    return {
        query,
        run(file, args, options) {
            const result = query(file, args, options);
            if (!result.ok) {
                const error = new Error(`${file} exited ${result.status}: ${result.stderr || result.stdout || result.error?.message || 'no diagnostic'}`);
                error.diagnosticCommand = commands.at(-1);
                throw error;
            }
            return result.stdout;
        },
        async stream(file, args, options = {}) {
            progress(`Running ${file} ${args.slice(0, 2).join(' ')}…`);
            if (typeof native.stream !== 'function') {
                const result = query(file, args, options);
                options.stdout?.write?.(result.stdout || '');
                options.stderr?.write?.(result.stderr || '');
                return result;
            }
            let pending = '';
            const result = await native.stream(file, args, { ...options,
                timeoutMs: Math.min(options.timeoutMs || 30_000, 900_000),
                stdout: { write(value) { options.stdout?.write?.(value); } },
                stderr: { write(value) {
                    options.stderr?.write?.(value);
                    pending += String(value);
                    const lines = pending.split('\n');
                    pending = lines.pop().slice(-4096);
                    for (const line of lines) if (line.startsWith('[diagnose] ')) progress(clean(line.slice(11)));
                } },
            });
            commands.push({ file: clean(file), args: args.map(clean), exitCode: result.status,
                ...(result.ok ? {} : { detail: clean(result.stderr || result.stdout || result.error?.message),
                    ...(result.error?.code === 'ETIMEDOUT' ? { timedOut: true } : {}) }) });
            return result;
        },
    };
}

async function unusedPort(udp = false) {
    const socket = udp ? dgram.createSocket('udp4') : net.createServer();
    try {
        await new Promise((resolve, reject) => {
            socket.once('error', reject);
            if (udp) socket.bind(0, '0.0.0.0', resolve);
            else socket.listen(0, '127.0.0.1', resolve);
        });
        return socket.address().port;
    } finally { await new Promise((resolve) => socket.close(resolve)); }
}

function inspectRecord(runner, id) {
    const result = runner.query('podman', ['container', 'inspect', id]);
    if (!result.ok) throw new Error(`Cannot revalidate diagnostic container ${id}: ${result.stderr}`);
    const records = JSON.parse(result.stdout);
    if (!Array.isArray(records) || records.length !== 1 || records[0].Id !== id) throw new Error('Diagnostic container identity changed');
    return records[0];
}

export function createVerifierScope(runner, runId = crypto.randomUUID()) {
    const probes = [];
    const label = 'io.assistos.ploinky.diagnose-probe';
    function argumentsFor(file, args) {
        if (file !== 'podman' || args[0] !== 'run' || !args.includes('--rm') || args.some((arg) => arg === '--name' || arg.startsWith('--name='))) return args;
        const imageId = args.find((arg) => /^(?:sha256:)?[a-f0-9]{64}$/.test(arg));
        if (!imageId) throw new Error('An isolated image verifier requires an immutable image ID');
        const name = `ploinky-diagnose-verify-${runId}-${probes.length}`;
        probes.push({ name, imageId });
        return ['run', '--name', name, '--label', `${label}=${runId}`, ...args.slice(1)];
    }
    return {
        runner: {
            query: (file, args, options) => runner.query(file, argumentsFor(file, args), options),
            run: (file, args, options) => runner.run(file, argumentsFor(file, args), options),
            stream: (file, args, options) => runner.stream(file, argumentsFor(file, args), options),
        },
        cleanup() {
            for (const probe of probes) {
                const result = runner.query('podman', ['container', 'inspect', probe.name]);
                if (!result.ok && !result.error && /no such container|does not exist|not found/i.test(result.stderr)) continue;
                if (!result.ok) throw new Error(`Unable to inspect diagnostic verifier ${probe.name}; retained for manual inspection`);
                const records = JSON.parse(result.stdout);
                const record = records?.[0];
                if (records.length !== 1 || !/^[a-f0-9]{64}$/.test(record?.Id)
                    || record.Name?.replace(/^\//, '') !== probe.name
                    || record.Config?.Labels?.[label] !== runId
                    || record.Image?.replace(/^sha256:/, '') !== probe.imageId.replace(/^sha256:/, '')) {
                    throw new Error(`Ownership changed for diagnostic verifier ${probe.name}; cleanup refused`);
                }
                runner.run('podman', ['container', 'rm', '--force', '--time', '0', record.Id]);
                const absent = runner.query('podman', ['container', 'inspect', record.Id]);
                if (absent.ok || absent.error || !/no such container|does not exist|not found/i.test(absent.stderr)) {
                    throw new Error(`Removal of diagnostic verifier ${record.Id} could not be verified`);
                }
            }
            return `${probes.length} image verifier(s) cleaned up or already removed.`;
        },
    };
}

export function validateInsideReport(report) {
    if (!report || ![0, 1].includes(report.exitCode) || !Array.isArray(report.checks) || !report.checks.length || report.checks.length > 250) {
        throw new Error('Inner diagnostics returned an empty, incomplete or malformed report');
    }
    const ids = new Set();
    for (const check of report.checks) {
        if (!check || typeof check.id !== 'string' || !check.id || ids.has(check.id)
            || typeof check.label !== 'string' || typeof check.detail !== 'string'
            || !['pass', 'fail', 'warn', 'skip'].includes(check.status)
            || (check.command && (typeof check.command.file !== 'string' || !Array.isArray(check.command.args)
                || check.command.args.some((value) => typeof value !== 'string')))) {
            throw new Error('Inner diagnostics returned an invalid check record');
        }
        if (!check.id.startsWith('inner.') && !check.id.startsWith('nested-engine.')) {
            throw new Error('Inner diagnostics cannot publish host or repair check identities');
        }
        ids.add(check.id);
    }
    if (report.exitCode === 0) {
        const passed = new Set(report.checks.filter((check) => check.status === 'pass').map((check) => check.id));
        const required = ['inner', 'nested-engine'].flatMap((prefix) => ['agent-create', 'agent-start', 'agent-exec', 'agent-filesystem', 'agent-remove'].map((id) => `${prefix}.${id}`));
        required.push('inner.engine-create', 'inner.engine-start', 'inner.engine-exec', 'inner.engine-remove');
        if (report.checks.some((check) => check.status === 'fail') || required.some((id) => !passed.has(id))) {
            throw new Error('Inner diagnostics claimed success without completing the required container probes');
        }
    } else if (!report.checks.some((check) => check.status === 'fail')) throw new Error('Inner diagnostic failure has no failed check');
    return report;
}

export function validateCurrentBox({ ownership, identity, repositoryRoot, runner }) {
    const container = ownership.handles?.container;
    if (!container) return;
    const imageRef = container.labels?.[BOX_LABELS.imageRef];
    // Check the selected filesystem boundary before running any process inside it.
    validateContainerConfiguration(container, {
        identity, repositoryRoot, imageRef, imageId: container.runtime?.imageId,
        dataFingerprints: inspectWorkspaceDataPaths({ identity }).fingerprints,
        agentLib: agentLibContractFromContainer(container),
        hostPort: Number(container.labels?.[BOX_LABELS.routerHostPort]),
        mediaHostPort: Number(container.labels?.[BOX_LABELS.mediaHostPort]),
        hostKind: ownership.engine?.hostKind,
    });
    const inspected = runner.query('podman', ['image', 'inspect', container.runtime.imageId]);
    if (!inspected.ok) throw new Error(`Cannot inspect the current Box image: ${inspected.stderr}`);
    const image = validateImageContract(normalizeImageInspect(inspected.stdout), imageRef);
    if (image.immutableId !== container.runtime.imageId) throw new Error('Current Box immutable image identity changed');
}

export async function collectRuntimeDiagnostics({ identity, repositoryRoot, env, platform, runner, checks, progress, stage }) {
    let scratch, fixture, lock, ownedId, imageId;
    const knownIds = new Set();
    const imageRef = resolveBoxImageReference(env);
    const silent = { write() {} };
    const verifiers = createVerifierScope(runner);
    runner = verifiers.runner;
    try {
        let inspection = runner.query('podman', ['image', 'inspect', imageRef]);
        if (!inspection.ok) {
            const pulled = await stage('image.pull', 'Pull the configured Box image', async () => {
                const result = await runner.stream('podman', ['pull', imageRef], { timeoutMs: 300_000 });
                if (!result.ok) throw new Error(`Image pull failed: ${result.stderr}`);
                return 'Configured Box image downloaded into the normal image cache.';
            });
            if (!pulled) return;
            inspection = runner.query('podman', ['image', 'inspect', imageRef]);
        }
        const image = await stage('image.contract', 'Validate the exact Box image and bundled tools', async () => inspectAndValidateImage('podman', imageRef, runner));
        if (!image) return;
        imageId = image.immutableId;
        const records = JSON.parse(inspection.stdout);
        const digest = records[0]?.RepoDigests?.find((value) => value.startsWith(imageRef.replace(/:[^/:]+$/, '').split('@')[0] + '@'));
        const runtimeImageRef = digest || imageRef;
        const bundle = await stage('image.agentlib', 'Verify the bundled AchillesAgentLib', async () => probeImageAgentLib('podman', imageId, runner));
        if (!bundle) return;
        scratch = fs.realpathSync(fs.mkdtempSync(path.join(identity.workspaceRoot, '.ploinky-diagnose-')));
        fs.chmodSync(scratch, 0o700);
        const workspace = path.join(scratch, 'workspace');
        fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true, mode: 0o700 });
        fixture = buildWorkspaceIdentity(workspace, { markerFound: true });
        const archive = path.join(workspace, 'diagnostic-image.tar');
        const exported = await stage('image.export', 'Export the verified image for isolated inner stores', async () => {
            const result = await runner.stream('podman', ['save', '--format', 'oci-archive', '--output', archive, imageId], { timeoutMs: 240_000 });
            if (!result.ok) throw new Error(`Image export failed: ${result.stderr}`);
            return 'Inner probes reuse the exact image without copying registry credentials.';
        });
        if (!exported) return;
        const ownership = discoverBoxOwnership(fixture, { runner, env, platform });
        if (ownership.state !== 'absent') throw new Error('Temporary diagnostic workspace is not unambiguously absent');
        fs.mkdirSync(path.join(scratch, 'state'), { mode: 0o700 });
        lock = await createMutationLockManager({ homeDirectory: path.join(scratch, 'state') }).acquire(fixture.instance);
        const wrapped = {
            ...runner,
            run(file, args, options) {
                const result = runner.run(file, args, options);
                if (args[0] === 'container' && args[1] === 'create') {
                    const id = String(result).trim();
                    if (/^[a-f0-9]{64}$/.test(id)) knownIds.add(id);
                }
                return result;
            },
        };
        const prepared = await stage('box.lifecycle', 'Create and start an isolated Box using the deployment lifecycle', async () => {
            const result = await reconcileBoxContainer({
                identity: fixture, ownership, engine: ownership.engine, runner: wrapped, lock,
                repositoryRoot, agentLib: buildImageSelection({ workspaceRoot: workspace, imageBundle: bundle }),
                explicitPort: await unusedPort(), explicitMediaPort: await unusedPort(true),
                imageRef: imageId, imagePolicy: 'preserve', stdout: silent, stderr: silent,
            });
            ownedId = result.ownership.handles.container.id;
            result.finalize();
            return result;
        });
        if (!prepared) return;
        await stage('box.inner', 'Exercise inner Podman storage, networking and nested-engine containers', async () => {
            const result = await runner.stream('podman', ['container', 'exec', '--user', 'podman', '--workdir', '/workspace',
                '--env', 'PLOINKY_DIAGNOSE_ISOLATED=1',
                ownedId, '/usr/local/bin/node', '/opt/ploinky/ploinky-box/diagnose/inside.mjs', runtimeImageRef,
                '--image-archive', '/workspace/diagnostic-image.tar', '--image-id', imageId],
            { timeoutMs: 900_000 });
            let report;
            try { report = JSON.parse(result.stdout); } catch { throw new Error(`Inner diagnostic report unavailable: ${result.stderr || result.stdout}`); }
            validateInsideReport(report);
            for (const check of report.checks) {
                checks.push({ id: clean(check.id), status: check.status, label: clean(check.label), detail: clean(check.detail), next: clean(check.next),
                    ...(Number.isInteger(check.exitCode) ? { exitCode: check.exitCode } : {}),
                    ...(check.command ? { command: { file: 'podman', args: ['container', 'exec', '--user', 'podman', ownedId, check.command.file, ...check.command.args] } } : {}) });
            }
            if (!result.ok || report.exitCode) throw new Error('One or more inner probes failed; see their exact commands and recovery steps above.');
            return 'Inner and nested-engine probes completed.';
        });
    } finally {
        await stage('cleanup.verifiers', 'Verify cleanup of temporary image-verification containers', async () => verifiers.cleanup());
        if (fixture) {
            await stage('cleanup.box', 'Remove only the temporary diagnostic Box', async () => {
                const discovered = discoverBoxOwnership(fixture, { runner, env, platform });
                if (discovered.state === 'absent') return 'No diagnostic container remains.';
                const id = discovered.handles?.container?.id;
                if (discovered.state !== 'owned' || !id || !knownIds.has(id)) throw new Error('Cannot prove ownership for cleanup; temporary resources retained for inspection');
                const record = inspectRecord(runner, id);
                if (record.Image.replace(/^sha256:/, '') !== imageId.replace(/^sha256:/, '')
                    || record.Config?.Labels?.[BOX_LABELS.pathHash] !== fixture.pathHash
                    || !record.Mounts?.some((mount) => mount.Source === fixture.workspaceRoot && mount.Destination === '/workspace')) {
                    throw new Error('Diagnostic container changed; cleanup refused');
                }
                runner.run('podman', ['container', 'rm', '--force', '--time', '0', id]);
                if (discoverBoxOwnership(fixture, { runner, env, platform }).state !== 'absent') throw new Error('Diagnostic container still exists after removal');
                return 'Temporary Box removed; existing workspace containers were not changed.';
            });
        }
        lock?.release();
        if (scratch && !checks.some((check) => check.id === 'cleanup.box' && check.status === 'fail')) {
            await stage('cleanup.files', 'Remove temporary diagnostic files', async () => {
                fs.rmSync(scratch, { recursive: true });
                return 'Temporary workspace removed.';
            });
        }
    }
}

export async function diagnoseWorkspace({
    env = process.env, cwd = process.cwd(), repositoryRoot = path.resolve(import.meta.dirname, '..'),
    platform = process.platform, explicitPort, explicitMediaPort,
    runner: suppliedRunner, progress = () => {}, hostChecks = collectHostDiagnostics,
    runtimeChecks = collectRuntimeDiagnostics, currentChecks = collectCurrentWorkspaceDiagnostics,
    discover = discoverBoxOwnership, checkPublications = preflightPublications,
    bindingStore = createRouterBindingStore(), admitCurrentBox = validateCurrentBox,
    inspectionOnly = false, repairAssessments = collectRepairAssessments,
    homeDirectory, fsApi = fs, uid = process.getuid?.(),
} = {}) {
    const checks = [], commands = [];
    const runner = createDiagnosticRunner(suppliedRunner || createProcessRunner({ env: buildEngineProcessEnvironment(env) }), commands, { progress });
    const stage = async (id, label, action) => {
        progress(label);
        const start = commands.length;
        try {
            const value = await action();
            checks.push({ id, label, status: 'pass', detail: typeof value === 'string' ? clean(value) : 'Verified.',
                ...(commands.length > start ? { command: { file: commands.at(-1).file, args: commands.at(-1).args }, exitCode: commands.at(-1).exitCode } : {}) });
            return value || true;
        } catch (error) {
            const wrapperDetail = failureDetail(error);
            const command = failureCommand(error, commands.slice(start), wrapperDetail);
            const detail = clean(command?.detail && !wrapperDetail.includes(command.detail)
                ? `${wrapperDetail}\n${command.detail}` : wrapperDetail);
            checks.push({ id, label, status: 'fail', detail, next: diagnosticAdvice(detail),
                ...(command && commands.length > start ? { command: { file: command.file, args: command.args }, exitCode: command.exitCode } : {}) });
            return null;
        }
    };
    const host = await stage('host.scan', 'Collect host prerequisites and settings', async () => hostChecks({ runner, env, platform, fsApi, uid }));
    if (host?.checks) checks.push(...host.checks);
    let identity;
    await stage('workspace.identity', 'Resolve the selected workspace', async () => {
        identity = resolveWorkspaceIdentity({ env, cwd: () => typeof cwd === 'function' ? cwd() : cwd });
        return identity.workspaceRoot;
    });
    let ownership;
    if (identity && (host?.engineUsable || host?.engineInfo?.host?.security?.rootless === true)) {
        ownership = await stage('workspace.ownership', 'Inspect the selected Box ownership', async () => {
            const found = discover(identity, { runner, platform, env });
            if (!['absent', 'owned'].includes(found.state)) throw new Error(found.message || `Workspace is ${found.state}`);
            if (found.handles?.container) admitCurrentBox({ ownership: found, identity, repositoryRoot, runner });
            return found;
        });
    }
    if (ownership) {
        await stage('workspace.publication', 'Check the selected workspace TCP and UDP publication', async () => {
            const box = ownership.handles?.container;
            const saved = bindingStore.read(identity);
            const hostPort = parseHostPort(explicitPort ?? saved?.hostPort ?? box?.labels?.[BOX_LABELS.routerHostPort] ?? 8080);
            const mediaHostPort = parseHostPort(explicitMediaPort ?? box?.labels?.[BOX_LABELS.mediaHostPort] ?? BOX_MEDIA_PORT);
            const observed = box ? observeContainerRouterBinding(box) : null;
            const address = saved?.address || observed?.address || '127.0.0.1';
            assertRouterBindingAssignable({ address, hostPort });
            await checkPublications({ hostPort, mediaHostPort, address, existingPublication: box ? {
                running: box.runtime?.running === true, address: observed.address,
                hostPort: Number(box.labels?.[BOX_LABELS.routerHostPort]), mediaHostPort: Number(box.labels?.[BOX_LABELS.mediaHostPort]),
            } : null });
            if (box?.runtime?.running) {
                const command = { file: 'podman', args: ['container', 'exec', '--user', 'podman', box.id, 'podman', 'info', '--format', 'json'] };
                const observed = runner.query(command.file, command.args);
                if (!observed.ok) {
                    checks.push({ id: 'workspace.storage', label: 'Current Box storage and network settings', status: 'fail', command,
                        exitCode: observed.status, detail: clean(observed.stderr), next: diagnosticAdvice(observed.stderr) });
                } else {
                    const info = JSON.parse(observed.stdout);
                    const detail = clean(JSON.stringify({ driver: info.store?.graphDriverName, graphRoot: info.store?.graphRoot,
                        runRoot: info.store?.runRoot, graphOptions: info.store?.graphOptions,
                        rootless: info.host?.security?.rootless, networkBackend: info.host?.networkBackend,
                        runtime: info.host?.ociRuntime?.path }));
                    const valid = info.store?.graphDriverName === 'overlay' && info.host?.security?.rootless === true;
                    checks.push({ id: 'workspace.storage', label: 'Current Box storage and network settings', status: valid ? 'pass' : 'fail', command, detail, exitCode: 0,
                        ...(valid ? {} : { next: 'The Box must use its supported rootless overlay configuration. Inspect the reported storage configuration; do not reset existing data.' }) });
                }
            }
            return `${address}:${hostPort}/tcp; 0.0.0.0:${mediaHostPort}/udp${box ? '; existing owned Box inspected without restarting it' : '; both ports available'}.`;
        });
        const current = ownership.handles?.container;
        if (current?.runtime?.running) {
            await stage('workspace.current', 'Inspect running graph and nested Podman settings', async () => {
                checks.push(...await currentChecks({ runner, containerId: current.id }));
                return 'Inspected the current workspace without changing workloads.';
            });
        }
    }
    if (!inspectionOnly && ownership && host?.engineUsable) {
        const before = checks.length;
        await stage('runtime.probes', 'Run isolated deployment command probes', async () => {
            await runtimeChecks({ identity, repositoryRoot, env, platform, runner, checks, progress, stage });
            return 'See the individual command results.';
        });
        const parent = checks.at(-1);
        if (parent.id === 'runtime.probes' && parent.status === 'pass' && checks.slice(before, -1).some((check) => check.status === 'fail')) {
            parent.status = 'fail';
            parent.detail = 'An isolated deployment step failed; see its command and next action above.';
            delete parent.command;
            delete parent.exitCode;
        }
    } else {
        checks.push({ id: 'runtime.probes', label: 'Isolated deployment command probes', status: 'skip',
            detail: inspectionOnly ? 'Deferred for the repair preview; no diagnostic containers are created.' : 'Required host or workspace checks failed.',
            next: inspectionOnly ? 'Full probes run after ploinky repair, or directly with ploinky diagnose.' : 'Fix the failed prerequisites and rerun ploinky diagnose.' });
    }
    if (identity) {
        try {
            checks.push(...await repairAssessments({ identity, host, runner, env, platform, homeDirectory, fsApi, uid }));
        } catch (error) {
            checks.push({ id: 'repair.assessment', label: 'Assess automatic user repairs', status: 'fail',
                detail: failureDetail(error), next: 'Inspect this assessment failure before attempting any automatic repair.' });
        }
    }
    const exitCode = checks.some((check) => check.status === 'fail') ? 1
        : !inspectionOnly && checks.some((check) => ['runtime.probes', 'box.inner'].includes(check.id) && check.status === 'skip') ? 2 : 0;
    return annotateRemediations({ version: 1, workspace: identity ? clean(identity.workspaceRoot) : null, platform, exitCode, inspectionOnly, checks, commands },
        { context: { packageFamily: platform === 'linux' ? distributionFamily(fsApi) : '' } });
}
import crypto from 'node:crypto';
