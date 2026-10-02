// Concrete run manifests and their human approval summaries for the blocks
// with implemented executors (mac-cpu: LIVE-C1/C2; apparatus-cpu: LIVE-A1).
// Building a manifest reads local files only: no engine, SSH or network call.
// A manifest is a proposal; only separate execution-time authorization
// bindings (provision, live, cleanup) let the runner act on it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { WANTED_CONTROLLERS } from '../../ploinky-box/entrypoint/cgroupDelegation.mjs';
import { ENGINE_CONNECTIONS_ARGV, ENGINE_INFO_ARGV, HOST_RECORD_DIRECTORIES, IMAGE_REF, OWNER_MARKER, UNIX_SOCKET_PATH_LIMIT, WORKSPACE_SOCKET_NAME, digest, keys, AGENT_INSPECT, INSPECT } from './liveCommon.mjs';
import { FIXTURE_REPOSITORY, fixtureContainerName, fixtureManifest, fixturePlan, proposedWorkspaceIdentity, startArgs } from './liveFixture.mjs';
import { remoteRoot, remoteReportName } from './liveStage.mjs';
import { DOCUMENT_SUFFIXES } from './fixtures.mjs';
import { sshOptions } from './liveRemote.mjs';

export const CONCRETE_BLOCKS = Object.freeze({
    'mac-cpu': { platform: 'darwin', remote: false, cases: ['LIVE-C1', 'LIVE-C2'] },
    'apparatus-cpu': { platform: 'linux', remote: true, cases: ['LIVE-A1'] },
});
export const DEADLINES = Object.freeze({
    coreMs: 30000, startMs: 20 * 60 * 1000, destroyMs: 5 * 60 * 1000, fullGraphMs: 20 * 60 * 1000,
    modelLoadMs: 20 * 60 * 1000, cleanupMs: 5 * 60 * 1000, stagingMs: 10 * 60 * 1000, blockMs: 20 * 60 * 1000,
});
const HASH = /^sha256:[a-f0-9]{64}$/;
const SAFE = /^\/[A-Za-z0-9/_.-]+$/;
const canonicalFile = file => path.isAbsolute(file) && fs.realpathSync(file) === file && fs.statSync(file).isFile();

// Operator-supplied pins from earlier read-only observation. prepare-live
// verifies every local file pin it can read; remote and engine-service pins
// are rechecked by the runner on arrival, before any mutation.
export function validatePins(value, block) {
    const spec = CONCRETE_BLOCKS[block];
    keys(value, ['schema', 'host', 'node', 'engine', 'boxImage'], 'pins', ['ssh', 'workspaceParentRoot', 'ports']);
    if (value.schema !== 1) throw new Error('Unsupported pins schema');
    keys(value.host, ['hostname', 'platform', 'home'], 'pinned host');
    keys(value.node, ['path', 'digest'], 'pinned node');
    keys(value.engine, ['path', 'digest', 'identityDigest'], 'pinned engine');
    if (!/^[A-Za-z0-9.-]{1,255}$/.test(value.host.hostname) || value.host.platform !== spec.platform || !SAFE.test(value.host.home)
        || !SAFE.test(value.node.path) || !SAFE.test(value.engine.path) || ![value.node.digest, value.engine.digest, value.engine.identityDigest].every(item => HASH.test(item))
        || !IMAGE_REF.test(value.boxImage)) throw new Error('Invalid pins');
    if (value.ports !== undefined) {
        keys(value.ports, ['tcp', 'udp'], 'pinned ports');
        if (![value.ports.tcp, value.ports.udp].every(port => Number.isInteger(port) && port >= 1024 && port <= 65535) || value.ports.tcp === value.ports.udp) throw new Error('Invalid pinned ports');
    }
    if (spec.remote) {
        if (value.workspaceParentRoot !== undefined) throw new Error('Apparatus workspaces live under the remote run root');
        keys(value.ssh, ['alias', 'sshBinary', 'address', 'hostKeyAlias', 'user', 'knownHosts', 'identityFile'], 'pinned SSH');
        if (!/^[A-Za-z0-9.-]{1,64}$/.test(value.ssh.alias) || !canonicalFile(value.ssh.sshBinary) || !canonicalFile(value.ssh.knownHosts)
            || !(value.ssh.identityFile === null || SAFE.test(value.ssh.identityFile))) throw new Error('Invalid SSH pins');
    } else {
        if (value.ssh !== undefined && value.ssh !== null) throw new Error('A local block has no SSH target');
        if (!SAFE.test(value.workspaceParentRoot || '') || fs.realpathSync(value.workspaceParentRoot) !== value.workspaceParentRoot) throw new Error('The workspace parent root must be canonical');
        // Local pins are verified now; the runner rechecks them before acting.
        if (value.host.hostname !== os.hostname() || value.host.platform !== process.platform || value.host.home !== fs.realpathSync(os.homedir())) throw new Error('Pinned host is not this host');
        for (const [file, expected] of [[value.node.path, value.node.digest], [value.engine.path, value.engine.digest]]) {
            if (!canonicalFile(file) || digest(fs.readFileSync(file)) !== expected) throw new Error(`Local pin does not match ${file}`);
        }
    }
    return value;
}

// The immutable fixture image: the ploinky-node digest on line 2 of
// Explorer's explorer/manifest.json.
export function explorerFixtureImage(explorerRoot) {
    const file = path.join(explorerRoot, 'explorer', 'manifest.json');
    const text = fs.readFileSync(file, 'utf8');
    const image = JSON.parse(text).container;
    if (!/^docker\.io\/assistos\/ploinky-node@sha256:[a-f0-9]{64}$/.test(image) || !text.split('\n')[1]?.includes(`"${image}"`)) {
        throw new Error('Explorer manifest line 2 does not pin the ploinky-node image digest');
    }
    return image;
}

export function selectPorts(pins) {
    if (pins.ports) return { tcp: pins.ports.tcp, udp: pins.ports.udp };
    return { tcp: crypto.randomInt(20000, 30000), udp: crypto.randomInt(30000, 40000) };
}

// The run's workspace: under the remote run root for a staged block, else
// under the pinned short task-owned workspaceParentRoot.
export function proposedWorkspace(block, pins, runId) {
    const spec = CONCRETE_BLOCKS[block];
    if (!spec) throw new Error(`Block ${block} has no implemented executor`);
    const parent = spec.remote ? remoteRoot(pins.host.home, runId) : path.join(pins.workspaceParentRoot, `ploinky-hwl-${runId}`);
    return { parent, path: path.join(parent, 'workspace') };
}

export function buildConcreteManifest({ block, runId, configDigest, casesDigest, documentSuffix, pins, candidate, image, ports, unsupported }) {
    const spec = CONCRETE_BLOCKS[block];
    if (!spec) throw new Error(`Block ${block} has no implemented executor`);
    const remote = spec.remote;
    const root = remote ? remoteRoot(pins.host.home, runId) : null;
    const { parent, path: workspacePath } = proposedWorkspace(block, pins, runId);
    const identity = proposedWorkspaceIdentity(workspacePath);
    const sourceRoot = remote ? `${root}/source` : candidate.root;
    const candidateFile = path.join(candidate.root, 'ploinky-box', 'bin', 'ploinky-box.mjs');
    const agents = fixturePlan(spec.cases);
    const execution = {
        protocol: 'owned-fixture-v1',
        host: { ...pins.host },
        node: { ...pins.node },
        candidate: { path: path.join(sourceRoot, 'ploinky-box', 'bin', 'ploinky-box.mjs'), digest: digest(fs.readFileSync(candidateFile)) },
        engine: { ...pins.engine },
        source: { root: sourceRoot, digest: candidate.digest },
        workspace: null,
        box: null,
        agents: [],
        cases: [...spec.cases],
        fixtures: { cpu: { ref: `${FIXTURE_REPOSITORY}/${agents[0].name}` } },
        provision: {
            revision: candidate.revision, repository: FIXTURE_REPOSITORY, image, boxImage: pins.boxImage, agents,
            workspace: { parent, parentMode: remote ? 'staged' : 'create', path: workspacePath },
        },
    };
    const target = {
        engine: { binary: pins.engine.path, kind: 'podman', identity: pins.engine.identityDigest },
        ssh: remote ? { alias: pins.ssh.alias, expectedAddress: pins.ssh.address, expectedHostKeyAlias: pins.ssh.hostKeyAlias } : null,
        note: 'Proposal only. Each action (provision, live, cleanup) needs its own separate execution-time authorization binding over the exact manifest bytes; no file grants permission.',
        cases: [...spec.cases],
        unsupported,
        execution,
    };
    if (remote) {
        target.remote = {
            sshBinary: pins.ssh.sshBinary, sshDigest: digest(fs.readFileSync(pins.ssh.sshBinary)), address: pins.ssh.address,
            hostKeyAlias: pins.ssh.hostKeyAlias, user: pins.ssh.user, knownHosts: pins.ssh.knownHosts,
            knownHostsDigest: digest(fs.readFileSync(pins.ssh.knownHosts)), identityFile: pins.ssh.identityFile,
            runPath: `${root}/run/run_${documentSuffix}.json`, authorizationPath: `${root}/run/authorization_provision.json`,
        };
        target.stage = { root, payloadPath: candidate.payload.path, payloadDigest: candidate.payload.digest, payloadBytes: candidate.payload.bytes };
    }
    const run = {
        schema: 1, runId, configDigest, casesDigest, block, target, state: 'proposed',
        workspace: { proposedParent: parent, proposedPath: workspacePath, instance: identity.instance, pathHash: identity.pathHash },
        ports: { tcp: ports.tcp, udp: ports.udp },
        deadlines: { ...DEADLINES },
        images: [
            { role: 'fixture-agent', ref: image, source: 'AssistOSExplorer explorer/manifest.json line 2' },
            { role: 'box', ref: pins.boxImage, source: 'operator pins' },
        ],
        ownedBoxes: [], ownedProcesses: [], ownedPaths: [], preInventory: {}, operations: [],
        cleanup: { state: 'not-started', steps: [], failures: [] },
    };
    target.plan = plannedCommands(run);
    return run;
}

// The full planned command list. Identifiers known only after provisioning
// appear as placeholders; the runner builds each argv from the same helpers.
export function plannedCommands(run) {
    const profile = run.target.execution;
    const plan = profile.provision;
    const engine = profile.engine.path;
    const node = profile.node.path;
    const workspace = plan.workspace.path;
    const box = '<BOX_ID>';
    const core = ['container', 'exec', '--user', 'podman', box];
    const nested = [...core, 'podman', '--cgroup-manager=cgroupfs'];
    const env = { PLOINKY_BOX_HARDWARE_LIMITS: 'on', PLOINKY_BOX_IMAGE: plan.boxImage };
    const ps = ['container', 'ps', '--all', '--no-trunc', '--format', '{{.ID}}'];
    const provision = [
        { id: 'engine-identity', binary: engine, argv: [...ENGINE_INFO_ARGV], deadlineMs: run.deadlines.coreMs, note: 'Stable facts only: host arch/os/hostname/kernel, engine version, store graphRoot/runRoot and the service socket; a remote client adds its one default connection (name and URI). A missing fact refuses the run.' },
        { id: 'engine-connection', binary: engine, argv: [...ENGINE_CONNECTIONS_ARGV], deadlineMs: run.deadlines.coreMs, note: 'Only when the service is remote.' },
        { id: 'host-records-absent', action: `Refuse unless ${HOST_RECORD_DIRECTORIES.map(name => `~/.ploinky-box/${name}/${run.workspace.instance}{,.json}`).join(', ')} are all absent` },
        ...(plan.workspace.parentMode === 'create'
            ? [{ id: 'workspace-parent-create', action: `mkdir ${plan.workspace.parent} (0700, refuse if it exists) and write ${OWNER_MARKER}=${run.runId}` }]
            : [{ id: 'workspace-parent-staged', action: `Require the staged private root ${plan.workspace.parent} (0700, marker ${run.runId})` }]),
        { id: 'workspace-create', action: `mkdir ${workspace} (0755, refuse if it exists), write ${OWNER_MARKER}, record uid/dev/ino` },
        { id: 'port-preflight', action: `Bind-test TCP 127.0.0.1:${run.ports.tcp} and 0.0.0.0:${run.ports.tcp}, UDP 0.0.0.0:${run.ports.udp}; any collision aborts` },
        { id: 'pre-inventory', binary: engine, argv: ps, deadlineMs: run.deadlines.coreMs },
        { id: 'pre-inventory-inspect', binary: engine, argv: ['container', 'inspect', '--format', INSPECT, '<CONTAINER_ID>'], deadlineMs: run.deadlines.coreMs },
        ...plan.agents.map(agent => ({ id: `fixture-write-${agent.name}`, action: `Write ${workspace}/.ploinky/repos/${FIXTURE_REPOSITORY}/${agent.name}/manifest.json`, content: fixtureManifest(agent, { image: plan.image, agents: plan.agents }) })),
        { id: 'fixture-start', binary: node, argv: startArgs(profile, run.ports), cwd: workspace, env, deadlineMs: run.deadlines.startMs,
            note: 'Production start creates the gate-on Box and runs its bounded root preparation before graph work; this is the declared provisioning step that may change cgroup state.' },
        { id: 'box-inventory', binary: engine, argv: ps, deadlineMs: run.deadlines.coreMs },
        { id: 'box-inspect', binary: engine, argv: ['container', 'inspect', '--format', INSPECT, '<NEW_CONTAINER_ID>'], deadlineMs: run.deadlines.coreMs },
        ...plan.agents.map(agent => ({ id: `agent-inspect-${agent.name}`, binary: engine, argv: [...nested, 'container', 'inspect', '--format', AGENT_INSPECT, fixtureContainerName(workspace, agent.name)], deadlineMs: run.deadlines.coreMs })),
        { id: 'host-records', action: 'Record the exact host records of this instance that now exist (path, type, uid, dev, ino)' },
    ];
    const live = [];
    const ports = ['--port', String(run.ports.tcp), '--udp-port', String(run.ports.udp)];
    if (profile.cases.includes('LIVE-C1')) live.push(
        { id: 'C1-repeat-gate-on-start', binary: node, argv: [profile.candidate.path, ...ports, 'start', profile.fixtures.cpu.ref], cwd: workspace, env, deadlineMs: run.deadlines.startMs },
        { id: 'C1-repeat-saved-gate-start', binary: node, argv: [profile.candidate.path, ...ports, 'start', profile.fixtures.cpu.ref], cwd: workspace, env: { PLOINKY_BOX_IMAGE: plan.boxImage }, deadlineMs: run.deadlines.startMs },
        { id: 'C1-core-layout', binary: engine, argv: [...core, 'node', '-e', '<CORE_LAYOUT>'], deadlineMs: run.deadlines.coreMs, note: `Read-only observation as uid 1000, persisted before assertion; required controllers = ${WANTED_CONTROLLERS.join('/')} offered by the root cgroup.controllers` },
        { id: 'C1-placement-and-leaf', binary: engine, argv: [...core, 'node', '-e', '<MEMBERSHIP|LEAF_OBSERVATION>', '<PID|LEAF>'], deadlineMs: run.deadlines.coreMs },
    );
    if (profile.cases.includes('LIVE-C2')) for (const role of ['memory', 'cpu', 'pids']) live.push(
        { id: `C2-${role}-pressure`, binary: engine, argv: [...nested, 'container', 'exec', `<${role.toUpperCase()}_AGENT_ID>`, 'node', '-e', `<${role.toUpperCase()}_PRESSURE>`], deadlineMs: 15000 },
        { id: `C2-${role}-observer`, binary: engine, argv: [...core, 'node', '-e', '<LEAF_OBSERVER>', '<VERIFIED_LEAF>'], deadlineMs: 5000 },
    );
    if (profile.cases.includes('LIVE-A1')) live.push(
        { id: 'A1-held-allocation', binary: engine, argv: [...nested, 'container', 'exec', '<MEMORY_AGENT_ID>', 'node', '-e', '<HELD_ALLOCATION>', run.runId], deadlineMs: 25000 },
        { id: 'A1-handshake', binary: engine, argv: [...nested, 'container', 'exec', '<MEMORY_AGENT_ID>', 'node', '-e', '<ALLOCATION_HANDSHAKE>', run.runId, 'observe|release'], deadlineMs: 5000 },
        { id: 'A1-leaf-observer', binary: engine, argv: [...core, 'node', '-e', '<LEAF_OBSERVATION>', '<VERIFIED_LEAF>'], deadlineMs: 5000 },
    );
    const cleanup = [
        { id: 'revalidate-identity', binary: engine, argv: [...ENGINE_INFO_ARGV], action: 'Recheck engine identity (with its default connection when remote), workspace receipt and marker, or the run-derived quarantine' },
        { id: 'destroy-box', binary: node, argv: [profile.candidate.path, 'destroy', '--delete-cache'], cwd: workspace, deadlineMs: run.deadlines.destroyMs, action: 'Only when the recorded Box exists, or, when its receipt was never persisted, the one container found by the name and path-hash label recorded at fixture-start (`container ps --all --filter label=<path-hash label>=<hash> --format "{{.ID}} {{.Names}}"`) that also proves the Box role and a mount of exactly this workspace; then prove it absent and compare the unrelated inventory' },
        { id: 'host-records', action: `Remove only recorded ~/.ploinky-box/{${HOST_RECORD_DIRECTORIES.join(',')}}/${run.workspace.instance}[.json]; any unrecorded one refuses the step` },
        { id: 'workspace-removal', action: `Prove no container mounts ${workspace}; rename it to ${path.join(path.dirname(workspace), `.hwl-removing-${run.runId}`)}; reprove uid/dev/ino and marker; remove (marker last)` },
        ...(plan.workspace.parentMode === 'create' ? [{ id: 'workspace-parent-removal', action: `Remove ${plan.workspace.parent} only while it holds nothing but its marker` }] : []),
        { id: 'verify-absent', binary: engine, argv: ps, action: 'No owned Box, workspace, quarantine, parent or host record remains' },
    ];
    const result = { provision, live, cleanup };
    if (run.target.remote) {
        const ssh = [run.target.remote.sshBinary, ...sshOptions(run.target.remote), run.target.remote.address];
        const root = run.target.stage.root;
        result.staging = [
            { id: 'remote-host', argv: [...ssh, 'uname', '-n'], expect: profile.host.hostname },
            { id: 'remote-root', argv: [...ssh, 'mkdir', '-m', '0700', '--', root], action: 'Refuse if it exists; upload the owner marker; record dev/ino/uid' },
            { id: 'payload', argv: [...ssh, 'dd', `of=${root}/payload.tar`, 'conv=excl,fsync', 'status=none'], verify: `sha256sum == ${run.target.stage.payloadDigest}` },
            { id: 'extract', argv: [...ssh, 'tar', '-x', '--no-same-owner', '-f', `${root}/payload.tar`, '-C', `${root}/source`] },
            { id: 'manifest-and-authorization', action: `dd the exact authorized manifest bytes to ${run.target.remote.runPath} and the binding to ${root}/run/authorization_ACTION_DIGEST.json; chmod 0600; sha256sum verify` },
            { id: 'dispatch', argv: [...ssh, profile.node.path, `${profile.source.root}/tests/hardware-limits/verify.mjs`, 'ACTION', '--run', run.target.remote.runPath, '--authorization', '<STAGED_BINDING>', '--remote-local', run.runId, '--expected-manifest-digest', '<MANIFEST_DIGEST>'] },
            { id: 'fetch', action: `sha256sum then cat ${run.target.remote.runPath} and ${root}/run/${remoteReportName('ACTION')}; digests must match; the fetched manifest replaces the local one` },
            { id: 'remove-staging', argv: [...ssh, 'rm', '-rf', '--', root], action: 'Only after a fetched remote cleanup PASS, or when no remote run was ever dispatched; identity re-proved first' },
        ];
    }
    return result;
}

const list = values => values.map(value => `\`${value}\``).join(', ');

export function renderSummary(run, manifestPath) {
    const profile = run.target.execution;
    const plan = profile.provision;
    const remote = Boolean(run.target.remote);
    const line = (...parts) => parts.join('');
    // Long fixed values are named, never truncated, so every argument that
    // varies between runs (ports, refs, IDs, paths) stays visible.
    const shown = value => (value === INSPECT ? '<INSPECT_FORMAT>' : value === AGENT_INSPECT ? '<AGENT_INSPECT_FORMAT>'
        : value.startsWith(`${profile.source.root}/`) ? `$SOURCE/${value.slice(profile.source.root.length + 1)}` : value);
    const commands = [...run.target.plan.provision, ...run.target.plan.live].filter(entry => entry.argv)
        .map(entry => {
            const env = Object.entries(entry.env || {}).map(([key, value]) => `${key}=${value}`);
            const text = [...env, entry.binary, ...entry.argv].map(shown).join(' ').replaceAll('|', '\\|');
            return `| ${entry.id} | \`${text}\`${entry.cwd ? ` in \`${entry.cwd}\`` : ''} |`;
        });
    const lines = [
        `# Live run proposal ${run.runId} (${run.block})`,
        '',
        `Manifest: \`${manifestPath}\``,
        '',
        'This is a proposal for approval. Nothing has run. Each action needs its own execution-time authorization binding over the exact manifest bytes: `provision` first, then `live` over the provisioned manifest, then `cleanup` if a run was interrupted. Editing this file or the manifest grants nothing.',
        '',
        '## What would run',
        '',
        `| Case | Status |`,
        '| --- | --- |',
        ...profile.cases.map(id => `| ${id} | executed |`),
        ...Object.entries(run.target.unsupported).map(([id, reason]) => `| ${id} | not run: ${reason} |`),
        '',
        '## Where',
        '',
        '| Item | Value |',
        '| --- | --- |',
        `| Host | ${profile.host.hostname} (${profile.host.platform}), home \`${profile.host.home}\` |`,
        remote ? `| SSH route | ${run.target.remote.user}@${run.target.remote.address}, HostKeyAlias ${run.target.remote.hostKeyAlias}, known_hosts \`${run.target.remote.knownHosts}\` (${run.target.remote.knownHostsDigest}), BatchMode, strict host key, no forwarding |` : '| SSH route | none (local block) |',
        `| Engine | \`${profile.engine.path}\` ${profile.engine.digest}, service identity ${profile.engine.identityDigest} |`,
        `| Node | \`${profile.node.path}\` ${profile.node.digest} |`,
        `| Candidate | revision ${plan.revision}, source \`${profile.source.root}\` ${profile.source.digest} |`,
        remote ? `| Staged payload | \`${run.target.stage.payloadPath}\` ${run.target.stage.payloadDigest} (${run.target.stage.payloadBytes} bytes) into \`${run.target.stage.root}\` |` : '| Staged payload | none |',
        '',
        '## Resources',
        '',
        '| Resource | Value |',
        '| --- | --- |',
        `| New workspace | \`${plan.workspace.path}\` (instance ${run.workspace.instance}), refused if it exists |`,
        `| Workspace parent | \`${plan.workspace.parent}\` (${plan.workspace.parentMode === 'create' ? 'created by this run' : 'the staged private remote root'}) |`,
        `| Socket room | \`${path.join(plan.workspace.path, WORKSPACE_SOCKET_NAME)}\` is ${Buffer.byteLength(path.join(plan.workspace.path, WORKSPACE_SOCKET_NAME))} bytes, under the ${UNIX_SOCKET_PATH_LIMIT - 1}-byte Unix socket limit; a longer workspace is refused, so pin a short task-owned workspaceParentRoot |`,
        `| Host ports | TCP ${run.ports.tcp} (Router, loopback), UDP ${run.ports.udp} (media); a collision aborts |`,
        `| Box image | \`${plan.boxImage}\` |`,
        `| Fixture image | \`${plan.image}\` |`,
        ...plan.agents.map(agent => `| Fixture agent ${FIXTURE_REPOSITORY}/${agent.name} | hardwareLimits memory ${agent.hardwareLimits.memory}, cpus ${agent.hardwareLimits.cpus}, pids ${agent.hardwareLimits.pidsLimit}, readiness none |`),
        `| Deadlines | core ${run.deadlines.coreMs} ms, start ${run.deadlines.startMs} ms, destroy ${run.deadlines.destroyMs} ms, cleanup ${run.deadlines.cleanupMs} ms${remote ? `, staging ${run.deadlines.stagingMs} ms` : ''} |`,
        '',
        '## Commands',
        '',
        'Every command runs as an argument array (shell:false) with a bounded deadline in its own process group. The full list, with environment and placeholders for identities known only after provisioning, is in `target.plan` of the manifest.',
        '',
        `\`$SOURCE\` is \`${profile.source.root}\`; \`<INSPECT_FORMAT>\` and \`<AGENT_INSPECT_FORMAT>\` are the fixed inspect templates in the manifest plan.`,
        '',
        '| Step | Command |',
        '| --- | --- |',
        ...commands,
        '',
        '## Cleanup',
        '',
        line('Cleanup runs in a finally block after `live`, after any provisioning failure, and as the standalone `cleanup` action. It is journaled in the manifest and resumes from it after a crash. Order: ',
            run.target.plan.cleanup.map(entry => entry.id).join(', '), '. '),
        `It destroys only the recorded Box with \`${path.basename(profile.candidate.path)} destroy --delete-cache\` from the workspace, proves it absent, removes only the recorded host records ${list(HOST_RECORD_DIRECTORIES.map(name => `~/.ploinky-box/${name}/${run.workspace.instance}[.json]`))}, then quarantines and removes the workspace after reproving its uid/dev/ino and marker. A failed destroy or identity proof preserves everything for a later \`cleanup\`. Unrelated containers are compared with the recorded inventory and never changed.`,
        remote ? `The remote staging root \`${run.target.stage.root}\` is removed only after a fetched remote cleanup PASS (or when no remote run was ever dispatched).` : null,
        '',
        '## Not covered',
        '',
        `${Object.keys(run.target.unsupported).length ? `Cases ${list(Object.keys(run.target.unsupported))} stay BLOCKED. ` : 'No case is unsupported on this target. '}${plan.workspace.parentMode === 'create' ? 'Production start may pull the pinned images and fetch the default agent repositories; that network use is part of the live run.' : 'The remote start may pull the pinned images and fetch the default agent repositories; that network use is part of the live run.'}`,
        '',
    ];
    return lines.filter(value => value !== null).join('\n');
}

// The summary beside a run manifest carries the configured document suffix
// (claude or codex, exactly once before the extension), like every evidence
// file the implementing agent writes.
export function summaryPathFor(runPath, documentSuffix) {
    if (!DOCUMENT_SUFFIXES.includes(documentSuffix)) throw new Error('The run summary needs the configured document suffix (claude or codex)');
    return `${runPath.replace(/(?:_claude|_codex)?\.json$/, '')}_summary_${documentSuffix}.md`;
}
