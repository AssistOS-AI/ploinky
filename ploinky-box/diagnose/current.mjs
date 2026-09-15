import { sanitizeAuthorityDiagnostic } from '../../cli/sandbox/authorityCommandDiagnostics.mjs';

const TIMEOUT_MS = 10_000;
const MAX_AGENTS = 128;
const ID_PATTERN = /^[a-f0-9]{64}$/;
const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/;
const STATUS_PATH = '/opt/ploinky/ploinky-box/inbox/readStatus.mjs';

// Only registry keys and immutable container IDs leave the Box. Never print
// complete agent records, configuration, environment variables, or credentials.
export const CURRENT_REGISTRY_SCRIPT = `
const fs = require('node:fs');
let fd;
try {
    const root = '/workspace/.ploinky';
    const parent = fs.lstatSync(root);
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw Error('Registry directory is not a regular directory');
    const filename = root + '/agents.json';
    const before = fs.lstatSync(filename);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 1048576) throw Error('Registry is not a regular file of at most 1 MiB');
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw Error('Registry changed while opening');
    const bytes = Buffer.alloc(1048577);
    let size = 0, count;
    do { count = fs.readSync(fd, bytes, size, bytes.length - size, null); size += count; } while (count && size < bytes.length);
    if (size > 1048576) throw Error('Registry exceeds 1 MiB');
    const registry = JSON.parse(bytes.subarray(0, size).toString('utf8'));
    if (!registry || typeof registry !== 'object' || Array.isArray(registry)) throw Error('Registry is not an object');
    const records = Object.entries(registry).filter(([name, record]) => record && ['agent', 'agentCore'].includes(record.type)
        && record.runtime === 'podman' && /^[a-f0-9]{64}$/.test(record.containerId)
        && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/.test(name))
        .map(([name, record]) => ({ name, containerId: record.containerId }));
    if (records.length > ${MAX_AGENTS}) throw Error('Registry exceeds the ${MAX_AGENTS}-agent diagnostic limit');
    console.log(JSON.stringify(records));
} catch (error) {
    console.error('Registry snapshot failed: ' + (error.code || error.message));
    process.exitCode = 1;
} finally { if (fd !== undefined) fs.closeSync(fd); }
`.trim().replace(/\s*\n\s*/g, ' ');

// Go templates constrain the subprocess output before it crosses the Box
// boundary, excluding container Config.Env, credentials, and healthcheck logs.
export const CURRENT_CONTAINER_TEMPLATE = '{{$fuse := false}}{{$device := false}}{{range .Config.CreateCommand}}{{if and $device (eq . "/dev/fuse")}}{{$fuse = true}}{{end}}{{if eq . "--device=/dev/fuse"}}{{$fuse = true}}{{end}}{{$device = eq . "--device"}}{{end}}{"Id":{{json .ID}},"Name":{{json .Name}},"Image":{{json .Image}},"State":{"Status":{{json .State.Status}},"Running":{{json .State.Running}},"ExitCode":{{json .State.ExitCode}}},"CapAdd":{{json .HostConfig.CapAdd}},"Devices":{{json .HostConfig.Devices}},"DeclaredFuse":{{$fuse}}}';

const clean = (value) => sanitizeAuthorityDiagnostic(String(value ?? ''), { limit: 2_000 });

function parseJson(text) {
    if (typeof text !== 'string' || text.length > 1_048_576) return null;
    try { return JSON.parse(text); } catch { return null; }
}

function hasNestedPodmanSettings(record) {
    const caps = new Set((Array.isArray(record.CapAdd) ? record.CapAdd : [])
        .filter((value) => typeof value === 'string').map((value) => value.toUpperCase().replace(/^CAP_/, '')));
    // Rootless Podman can report an empty Devices array for a declared --device.
    // The inspected creation arguments contribute only this filtered boolean.
    const fuse = record.DeclaredFuse === true || Array.isArray(record.Devices) && record.Devices.some((device) => (
        device?.PathOnHost === '/dev/fuse' && device?.PathInContainer === '/dev/fuse'
    ));
    return caps.has('SYS_ADMIN') && caps.has('NET_ADMIN') && fuse;
}

/** Inspect an already-owned Box without starting/stopping its graph or agents. */
export function collectCurrentWorkspaceDiagnostics({ runner, containerId } = {}) {
    if (!ID_PATTERN.test(containerId || '')) throw new TypeError('Current workspace diagnostics require one canonical Box container ID');
    const checks = [];
    const prefix = ['container', 'exec', '--user', 'podman', '--workdir', '/workspace', containerId];
    const query = (args) => {
        const command = { file: 'podman', args: [...prefix, ...args] };
        let result;
        try { result = runner.query(command.file, command.args, { timeoutMs: TIMEOUT_MS }); }
        catch (error) { result = { ok: false, status: 1, error }; }
        return { command, result };
    };
    const failure = (result) => {
        const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(result?.error?.code || '') ? result.error.code : '';
        return clean([code, result.stderr || result.stdout || 'Command failed without diagnostic output.'].filter(Boolean).join(': '));
    };
    const add = (id, label, status, detail, { command, result, next } = {}) => {
        checks.push({ id, label: clean(label), status, detail: clean(detail),
            ...(command ? { command: { file: clean(command.file), args: command.args.map(clean) } } : {}),
            ...(Number.isInteger(result?.status) ? { exitCode: result.status } : {}),
            ...(next ? { next: clean(next) } : {}) });
    };

    const observed = query(['node', STATUS_PATH]);
    const status = observed.result.ok ? parseJson(observed.result.stdout) : null;
    const validStatus = status && typeof status.state === 'string' && typeof status.initialized === 'boolean'
        && typeof status.routingConfigured === 'boolean' && Number.isSafeInteger(status.trackedAgents)
        && Number.isSafeInteger(status.runningAgents) && status.trackedAgents >= 0 && status.runningAgents >= 0
        && status.runningAgents <= status.trackedAgents && Array.isArray(status.warnings)
        && status.warnings.every((value) => typeof value === 'string');
    if (!validStatus) add('current.graph', 'Current workspace graph', 'fail',
        observed.result.ok ? 'Workspace status returned malformed or incomplete JSON.' : failure(observed.result),
        { ...observed, next: 'Inspect the current Box status command and correct the reported state or runtime failure; diagnose does not restart the graph.' });
    else {
        const active = status.initialized && status.routingConfigured && status.trackedAgents > 0;
        const unhealthy = status.trackedAgents > status.runningAgents || (status.trackedAgents > 0 && !active);
        add('current.graph', 'Current workspace graph', unhealthy ? 'fail' : !active || status.warnings.length ? 'warn' : 'pass',
            `state=${status.state}; routing=${status.routingConfigured ? 'configured' : 'not configured'}; ${status.runningAgents}/${status.trackedAgents} tracked agents running.`,
            { ...observed, ...(!active ? { next: 'No active routed graph is confirmed. Run your intended ploinky start command when ready; diagnose does not start application agents.' }
                : unhealthy ? { next: 'Inspect the per-agent status below and ploinky logs last; isolated environment probes cannot establish application health.' } : {}) });
        for (const [index, warning] of status.warnings.slice(0, MAX_AGENTS).entries()) add(`current.graph.warning.${index}`, 'Current graph status warning', 'warn', warning,
            { next: 'Resolve the recorded status warning before treating the deployment as ready.' });
        if (status.warnings.length > MAX_AGENTS) add('current.graph.warnings.truncated', 'Additional graph warnings', 'warn', `Only the first ${MAX_AGENTS} of ${status.warnings.length} warnings are shown.`);
    }

    const snapshot = query(['node', '-e', CURRENT_REGISTRY_SCRIPT]);
    const records = snapshot.result.ok ? parseJson(snapshot.result.stdout) : null;
    if (!snapshot.result.ok && validStatus && status.trackedAgents === 0 && !status.routingConfigured
        && /Registry snapshot failed: ENOENT\b/.test(String(snapshot.result.stderr || ''))) {
        add('current.registry', 'Current tracked container identities', 'skip', 'No agents registry exists for this inactive workspace; there are no recorded agents to inspect.', snapshot);
        return checks;
    }
    const validRecords = Array.isArray(records) && records.length <= MAX_AGENTS
        && records.every((record) => record && Object.keys(record).sort().join(',') === 'containerId,name'
            && NAME_PATTERN.test(record.name) && ID_PATTERN.test(record.containerId))
        && new Set(records.map((record) => record.name)).size === records.length
        && new Set(records.map((record) => record.containerId)).size === records.length;
    if (!validRecords) {
        add('current.registry', 'Current tracked container identities', 'fail',
            snapshot.result.ok ? 'Filtered agent identity snapshot was malformed, duplicated, or exceeded its bound.' : failure(snapshot.result),
            { ...snapshot, next: 'Inspect the regular /workspace/.ploinky/agents.json registry and its access permissions; no guessed agent container will be inspected.' });
        return checks;
    }
    add('current.registry', 'Current tracked container identities', 'pass', `${records.length} complete Podman identities were selected; agent configuration and environment values were not emitted.`, snapshot);
    let nestedCount = 0;
    for (const [index, record] of records.entries()) {
        const id = `current.agent.${index}`;
        const inspect = () => query(['podman', 'container', 'inspect', '--format', CURRENT_CONTAINER_TEMPLATE, record.containerId]);
        const observation = inspect();
        const value = observation.result.ok ? parseJson(observation.result.stdout) : null;
        const exact = value?.Id === record.containerId && String(value?.Name || '').replace(/^\//, '') === record.name;
        if (!exact) {
            add(`${id}.identity`, `${record.name}: current container`, 'fail',
                observation.result.ok ? 'Container name or immutable ID differs from the registry; further inspection is refused.' : failure(observation.result),
                { ...observation, next: 'Inspect this recorded agent and the registry identity. Do not substitute a similarly named container.' });
            continue;
        }
        const running = value.State?.Running === true && value.State?.Status === 'running';
        add(`${id}.state`, `${record.name}: current state`, running ? 'pass' : 'fail',
            `state=${value.State?.Status || 'not reported'}; running=${value.State?.Running ?? 'not reported'}; exitCode=${value.State?.ExitCode ?? 'not reported'}; image=${value.Image || 'not reported'}; container=${record.containerId}.`,
            { ...observation, ...(running ? {} : { next: 'Inspect this agent’s startup failure with ploinky logs last. Diagnose leaves its current state unchanged.' }) });
        if (!hasNestedPodmanSettings(value)) continue;
        nestedCount += 1;
        if (!running) {
            add(`${id}.podman`, `${record.name}: actual nested Podman settings`, 'skip', 'The selected nested-Podman agent is not running; executing its engine query is blocked.');
            continue;
        }
        // Agent ownership/configuration may change after status collection.
        const revalidated = inspect();
        const current = revalidated.result.ok ? parseJson(revalidated.result.stdout) : null;
        if (current?.Id !== record.containerId || String(current?.Name || '').replace(/^\//, '') !== record.name
            || current.State?.Running !== true || !hasNestedPodmanSettings(current)) {
            add(`${id}.podman`, `${record.name}: actual nested Podman settings`, 'fail',
                revalidated.result.ok ? 'Agent identity, state, or nested-Podman configuration changed before its engine query.' : failure(revalidated.result),
                { ...revalidated, next: 'Rerun diagnose after the current agent lifecycle operation finishes; no changed agent was entered.' });
            continue;
        }
        const probe = query(['podman', 'container', 'exec', record.containerId, 'podman', 'info', '--format', 'json']);
        const info = probe.result.ok ? parseJson(probe.result.stdout) : null;
        if (!info?.store || typeof info.store.graphDriverName !== 'string' || typeof info.host?.security?.rootless !== 'boolean') {
            add(`${id}.podman`, `${record.name}: actual nested Podman settings`, 'fail',
                probe.result.ok ? 'Agent Podman returned malformed or incomplete driver/security information.' : failure(probe.result),
                { ...probe, next: 'Inspect this exact existing agent’s Podman storage.conf, device access, and host AppArmor/SELinux denials; the isolated probe uses its own store and cannot prove this store is healthy.' });
            continue;
        }
        const settings = {
            driver: info.store.graphDriverName, graphRoot: info.store.graphRoot,
            runRoot: info.store.runRoot, configFile: info.store.configFile,
            graphOptions: info.store.graphOptions, rootless: info.host.security.rootless,
            networkBackend: info.host.networkBackend,
        };
        const differs = settings.driver !== 'overlay';
        add(`${id}.podman`, `${record.name}: actual nested Podman settings`, differs ? 'warn' : 'pass', JSON.stringify(settings),
            { ...probe, ...(differs ? { next: 'This agent’s driver differs from the isolated overlay probe. Review its own selected storage.conf and observed failure; do not change or reset an existing store based only on the driver name.' } : {}) });
    }
    if (!nestedCount) add('current.nested', 'Actual nested-Podman agent settings', 'skip', 'No tracked agent with the nested-Podman capability and device settings was found.');
    return checks;
}
