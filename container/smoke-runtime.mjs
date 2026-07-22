#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    BOX_MEDIA_PORT,
    BOX_ROUTER_PORT,
    IDENTITY_SCHEMA_LABEL,
    PATH_HASH_LABEL,
    REQUIRED_RUNTIME_IMAGE,
    VOLUME_ROLE_LABEL,
    VOLUME_ROLES,
    runtimeVolumeNames,
} from './runtime-contract.mjs';
import {
    assertManagedNetworkInventoryCurrent,
    assertBoxListenerCollectorContract,
    collectBoxListenerInventory,
    collectManagedNetworkInventory,
} from './listener-collector.mjs';
import {
    formatListenerInventory,
    loadListenerProfile,
    parseSsOutput,
    validateListenerInventory,
} from './listener-inventory.mjs';
import { normalizePublicMediaIPv4 } from '../cli/sandbox/edgeGeneration.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PLOINKY = path.join(ROOT, 'bin', 'ploinky');
const IMAGE = process.env.SMOKE_IMAGE || REQUIRED_RUNTIME_IMAGE;
const PORT = String(process.env.SMOKE_PORT || '18080');
const FULL_GRAPH_LISTENER_PROFILE = path.join(HERE, 'profiles', 'full-explorer-listeners.json');
const ROUTING_GRAPH_LISTENER_PROFILE = path.join(HERE, 'profiles', 'routing-graph-listeners.json');
const ROUTING_GRAPH_LISTENER_TIMEOUT_MS = Number(
    process.env.SMOKE_ROUTING_GRAPH_LISTENER_TIMEOUT_MS || 30000,
);
const FULL_GRAPH_LISTENER_TIMEOUT_MS = Number(
    process.env.SMOKE_FULL_GRAPH_LISTENER_TIMEOUT_MS || 180000,
);
const SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-runtime-smoke-')));
const HASH = crypto.createHash('sha256').update(TMP).digest('hex').slice(0, 12);
const SLUG = path.basename(TMP).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 48);
const INSTANCE = `ploinky-box-${SLUG}-${HASH}`;
const UDP_CONFLICT = `${INSTANCE}-udp-conflict`;
const VOLUMES = runtimeVolumeNames(INSTANCE);
const RETAINED_MARKERS = Object.freeze([
    ['/workspace/.runtime-smoke-marker', 'workspace'],
    ['/home/podman/.local/share/containers/.runtime-smoke-marker', 'containers'],
    ['/opt/ploinky/node_modules/.runtime-smoke-marker', 'ploinky-deps'],
]);
const EXPECTED_BINDINGS = Object.freeze({
    [`${BOX_ROUTER_PORT}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: PORT }],
    [`${BOX_MEDIA_PORT}/udp`]: [{ HostIp: '0.0.0.0', HostPort: String(BOX_MEDIA_PORT) }],
});
const FORBIDDEN_TARGETS = Object.freeze([
    '8081/tcp', '7880/tcp', '7881/tcp',
    '3478/tcp', '3478/udp', '5349/tcp', '5349/udp',
    '7980/tcp', '7981/tcp', '80/tcp', '443/tcp',
    '8082/tcp', '3000/tcp', '3001/tcp', '4369/tcp', '5432/tcp',
    '5672/tcp', '6379/tcp', '7000/tcp', '7301/tcp', '7681/tcp',
    '8000/tcp', '8888/tcp', '8890/tcp', '9000/tcp', '9100/tcp',
    '17000/tcp', '17001/tcp', '17002/tcp', '19000/tcp', '25672/tcp',
    ...Array.from({ length: 10 }, (_, index) => `${7883 + index}/udp`),
    ...Array.from({ length: 11 }, (_, index) => `${20000 + index}/udp`),
]);
const ENV = {
    ...process.env,
    PLOINKY_BOX_INSTALL_DEPS: '1',
    PLOINKY_BOX_SOURCE: ROOT,
    // The full-graph source map is the exact checkout authority for this gate.
    // Never project the developer's Ploinky branch onto independently pinned
    // or dirty dependency checkouts copied into the disposable box.
    PLOINKY_BOX_AUTO_BRANCH: '0',
    PLOINKY_MASTER_KEY: process.env.PLOINKY_MASTER_KEY || '5'.repeat(64),
};
delete ENV.PLOINKY_BOX_ENGINE;

function invoke(command, args, options = {}) {
    return spawnSync(command, args, {
        cwd: TMP,
        env: ENV,
        encoding: 'utf8',
        stdio: options.input === undefined
            ? ['ignore', 'pipe', 'pipe']
            : ['pipe', 'pipe', 'pipe'],
        input: options.input,
    });
}

function requireOk(label, result) {
    if (result.status === 0 && !result.error) return result;
    throw new Error(
        `${label} failed (${result.status}): ${result.stderr || result.stdout || result.error || ''}`,
    );
}

function requireFailure(label, result, pattern) {
    if (result.status === 0 || result.error) {
        throw new Error(`${label} unexpectedly succeeded: ${result.stdout || result.error || ''}`);
    }
    const diagnostic = String(result.stderr || result.stdout || '');
    if (!pattern.test(diagnostic)) {
        throw new Error(`${label} lacked ${pattern}: ${diagnostic}`);
    }
    return result;
}

function ploinky(args, options) {
    return invoke(PLOINKY, args, options);
}

function containerExists(name = INSTANCE) {
    return invoke('podman', ['container', 'inspect', name]).status === 0;
}

function volumeExists(name) {
    return invoke('podman', ['volume', 'inspect', name]).status === 0;
}

function normalizeBindings(bindings = {}) {
    return Object.fromEntries(Object.entries(bindings)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([target, values]) => [target, (values || []).map(value => ({
            HostIp: String(value?.HostIp || '0.0.0.0'),
            HostPort: String(value?.HostPort || ''),
        })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))]));
}

function inspectOuter(phase) {
    const result = requireOk(
        `${phase}: inspect outer container`,
        invoke('podman', ['container', 'inspect', INSTANCE]),
    );
    const record = JSON.parse(result.stdout)[0];
    const actual = normalizeBindings(record?.HostConfig?.PortBindings);
    const expected = normalizeBindings(EXPECTED_BINDINGS);
    assert.deepEqual(actual, expected, `${phase}: HostConfig.PortBindings drifted`);
    assert.equal(Object.keys(actual).length, 2, `${phase}: outer container must have two targets`);
    for (const target of FORBIDDEN_TARGETS) {
        assert.equal(Object.hasOwn(actual, target), false, `${phase}: forbidden ${target} publication`);
    }
    process.stdout.write(`PORT_BINDINGS ${phase} ${JSON.stringify(actual)}\n`);
    return actual;
}

function parsePodmanPort(stdout) {
    return String(stdout || '').split(/\r?\n/).map(value => value.trim()).filter(Boolean)
        .map(line => {
            const match = /^(\d+\/(?:tcp|udp))\s+->\s+(.+):(\d+)$/.exec(line);
            if (!match) throw new Error(`unrecognized podman port record: ${line}`);
            return {
                target: match[1],
                HostIp: match[2] || '0.0.0.0',
                HostPort: match[3],
            };
        })
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function assertPodmanPort(phase) {
    const actual = parsePodmanPort(requireOk(
        `${phase}: podman port`,
        invoke('podman', ['port', INSTANCE]),
    ).stdout);
    const expected = [
        { target: `${BOX_ROUTER_PORT}/tcp`, HostIp: '127.0.0.1', HostPort: PORT },
        { target: `${BOX_MEDIA_PORT}/udp`, HostIp: '0.0.0.0', HostPort: String(BOX_MEDIA_PORT) },
    ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    assert.deepEqual(actual, expected, `${phase}: podman port output drifted`);
    process.stdout.write(`PODMAN_PORT ${phase} ${JSON.stringify(actual)}\n`);
}

function assertExactOuterBoundary(phase) {
    inspectOuter(phase);
    assertPodmanPort(phase);
}

function assertRetainedVolumeLabels() {
    for (const [role, name] of Object.entries(VOLUMES)) {
        const raw = JSON.parse(requireOk(
            `inspect retained ${role} volume`,
            invoke('podman', ['volume', 'inspect', name]),
        ).stdout)[0];
        const labels = raw.Labels || raw.labels || {};
        assert.equal(labels[IDENTITY_SCHEMA_LABEL], '1', `${name} identity schema`);
        assert.equal(labels[PATH_HASH_LABEL], HASH, `${name} path hash`);
        assert.equal(labels[VOLUME_ROLE_LABEL], VOLUME_ROLES[role], `${name} volume role`);
    }
}

function installRoutingProbe() {
    const fixtureDir = path.join(TMP, 'routing-probe');
    const fixtureManifest = path.join(fixtureDir, 'manifest.json');
    const fixtureSources = path.join(fixtureDir, 'edge-sources');
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(fixtureManifest, JSON.stringify({
        container: 'docker.io/library/alpine:3.22',
        start: 'sleep 600',
        readiness: { protocol: 'none' },
        profiles: { default: {} },
    }, null, 2));
    requireOk(
        'create routing-probe repository',
        invoke('podman', ['exec', INSTANCE, 'mkdir', '-p', '/workspace/.ploinky/repos/smoke/routing-probe']),
    );
    requireOk(
        'copy routing-probe manifest',
        invoke('podman', ['cp', fixtureManifest, `${INSTANCE}:/workspace/.ploinky/repos/smoke/routing-probe/manifest.json`]),
    );

    // The release smoke is the explicit operator for this disposable workspace.
    // Stage all four v5 sources together so the routing probe cannot rely on a
    // missing-source initializer, migration, or partial-state fallback.
    fs.mkdirSync(path.join(fixtureSources, 'data', 'edge-routing'), { recursive: true });
    fs.mkdirSync(path.join(fixtureSources, 'data', 'router-security'), { recursive: true });
    const sources = [
        ['routing.json', { routes: {} }, '/workspace/.ploinky/routing.json'],
        ['agents.json', {}, '/workspace/.ploinky/agents.json'],
        [path.join('data', 'router-security', 'policy-state.json'), {
            schema: 'router-policy',
            httpRoutes: [],
            mcpTools: [],
        }, '/workspace/.ploinky/data/router-security/policy-state.json'],
        [path.join('data', 'edge-routing', 'desired.json'), {
            schemaVersion: 1,
            hosts: {},
            security: {
                hostNetworkAllowedInstances: [],
                internalServiceConsumers: {},
            },
        }, '/workspace/.ploinky/data/edge-routing/desired.json'],
    ];
    requireOk(
        'create routing-probe edge source directories',
        invoke('podman', ['exec', INSTANCE, 'mkdir', '-p',
            '/workspace/.ploinky/data/edge-routing',
            '/workspace/.ploinky/data/router-security']),
    );
    for (const [relativePath, document, target] of sources) {
        const source = path.join(fixtureSources, relativePath);
        fs.mkdirSync(path.dirname(source), { recursive: true });
        fs.writeFileSync(source, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
        requireOk(
            `stage routing-probe ${path.basename(relativePath)}`,
            invoke('podman', ['cp', source, `${INSTANCE}:${target}`]),
        );
        requireOk(
            `restrict routing-probe ${path.basename(relativePath)}`,
            invoke('podman', ['exec', INSTANCE, 'chmod', '600', target]),
        );
    }
}

async function assertLoopbackRouterWorks() {
    const response = await fetch(`http://127.0.0.1:${PORT}/status`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(3000),
    });
    const transportProof = response.status >= 200 && response.status < 400
        || response.status === 401
        || response.status === 403;
    assert.equal(
        transportProof,
        true,
        `loopback Router returned unexpected status ${response.status}`,
    );
    process.stdout.write(`LOOPBACK_ROUTER_RESPONSE 127.0.0.1:${PORT} ${response.status}\n`);
}

function physicalIpv4() {
    for (const records of Object.values(os.networkInterfaces())) {
        for (const record of records || []) {
            if (record.family === 'IPv4' && !record.internal && record.address !== '0.0.0.0') {
                return record.address;
            }
        }
    }
    return '';
}

async function assertPhysicalRouterRefused() {
    const address = physicalIpv4();
    if (!address) throw new Error('cannot prove LAN Router refusal: no non-loopback IPv4 interface');
    await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: address, port: Number(PORT) });
        const timer = setTimeout(() => {
            socket.destroy();
            resolve();
        }, 2000);
        socket.once('connect', () => {
            clearTimeout(timer);
            socket.destroy();
            reject(new Error(`Router unexpectedly accepted physical-interface TCP at ${address}:${PORT}`));
        });
        socket.once('error', () => {
            clearTimeout(timer);
            resolve();
        });
    });
    process.stdout.write(`LAN_ROUTER_REFUSED ${address}:${PORT}\n`);
}

function collectRoutingListenerInventory(phase) {
    if (phase !== 'routing-graph') throw new Error(`unsupported routing listener phase '${phase}'`);
    if (!Number.isSafeInteger(ROUTING_GRAPH_LISTENER_TIMEOUT_MS)
        || ROUTING_GRAPH_LISTENER_TIMEOUT_MS < 1000) {
        throw new Error('SMOKE_ROUTING_GRAPH_LISTENER_TIMEOUT_MS must be an integer of at least 1000');
    }
    const profile = loadListenerProfile(ROUTING_GRAPH_LISTENER_PROFILE);
    const deadline = Date.now() + ROUTING_GRAPH_LISTENER_TIMEOUT_MS;
    let lastValidation = null;
    let lastError = null;
    let lastRaw = '';
    let attempt = 0;
    do {
        try {
            const managedNetworks = collectManagedNetworkInventory({
                outerContainer: INSTANCE,
                run: args => invoke('podman', args),
            });
            const result = requireOk(
                `${phase}: in-box owner-aware listener inventory`,
                invoke('podman', ['exec', INSTANCE, 'ss', '-H', '-lntup']),
            );
            lastRaw = result.stdout;
            assertManagedNetworkInventoryCurrent({
                outerContainer: INSTANCE,
                run: args => invoke('podman', args),
                expected: managedNetworks,
            });
            lastValidation = validateListenerInventory({
                listeners: parseSsOutput(result.stdout, { namespace: 'outer' }),
                containers: [],
                managedNetworks,
            }, profile);
            lastError = null;
            if (lastValidation.ok) {
                for (const network of lastValidation.managedNetworks) {
                    process.stdout.write(
                        `IN_BOX_MANAGED_NETWORK ${phase} ${JSON.stringify(network)}\n`,
                    );
                }
                const report = formatListenerInventory(lastValidation);
                if (report) {
                    process.stdout.write(
                        `${report.split('\n').map(line => `IN_BOX_ROUTER_LISTENER ${phase} ${line}`).join('\n')}\n`,
                    );
                }
                process.stdout.write(`IN_BOX_LISTENERS ${phase}\n${result.stdout}`);
                if (!result.stdout.endsWith('\n')) process.stdout.write('\n');
                return lastValidation;
            }
        } catch (error) {
            lastError = error;
            lastValidation = null;
        }
        if (Date.now() >= deadline) break;
        attempt += 1;
        Atomics.wait(SLEEP_ARRAY, 0, 0, Math.min(250 + attempt * 100, 1000));
    } while (Date.now() < deadline);
    throw new Error(
        `routing listener profile '${profile.id}' did not converge in `
        + `${ROUTING_GRAPH_LISTENER_TIMEOUT_MS}ms:\n`
        + `${lastValidation?.errors.join('\n') || lastError?.message || 'no inventory result'}\n`
        + `last ss inventory:\n${lastRaw || '<empty>'}`,
    );
}

function printFullGraphListenerEvidence(validation) {
    for (const network of validation.managedNetworks) {
        process.stdout.write(`IN_BOX_MANAGED_NETWORK full-explorer ${JSON.stringify(network)}\n`);
    }
    for (const container of validation.containers) {
        process.stdout.write(`IN_BOX_NAMESPACE ${JSON.stringify({
            namespace: container.namespace,
            containerName: container.name,
            networkMode: container.networkMode,
            image: container.image,
            managed: container.managed,
            initPid: container.initPid,
            pidNamespace: container.pidNamespace,
            pids: container.pids,
            startedAt: container.startedAt,
        })}\n`);
    }
    const report = formatListenerInventory(validation);
    if (report) process.stdout.write(`${report.split('\n').map(line => `IN_BOX_LISTENER ${line}`).join('\n')}\n`);
}

function collectFullGraphListenerSnapshot() {
    const profile = loadListenerProfile(FULL_GRAPH_LISTENER_PROFILE);
    assertBoxListenerCollectorContract({
        outerContainer: INSTANCE,
        run: args => invoke('podman', args),
    });
    const inventory = collectBoxListenerInventory({
        outerContainer: INSTANCE,
        run: args => invoke('podman', args),
        verifyTools: false,
    });
    const validation = validateListenerInventory(inventory, profile);
    printFullGraphListenerEvidence(validation);
    process.stdout.write(
        `IN_BOX_LISTENER_PROFILE ${profile.id} ${validation.ok ? 'PASS' : 'FAIL'} `
        + `${validation.listeners.length} listeners\n`,
    );
    return validation;
}

function validateFullGraphListeners() {
    if (!Number.isSafeInteger(FULL_GRAPH_LISTENER_TIMEOUT_MS)
        || FULL_GRAPH_LISTENER_TIMEOUT_MS < 1000) {
        throw new Error('SMOKE_FULL_GRAPH_LISTENER_TIMEOUT_MS must be an integer of at least 1000');
    }
    const profile = loadListenerProfile(FULL_GRAPH_LISTENER_PROFILE);
    assertBoxListenerCollectorContract({
        outerContainer: INSTANCE,
        run: args => invoke('podman', args),
    });
    const deadline = Date.now() + FULL_GRAPH_LISTENER_TIMEOUT_MS;
    let lastValidation = null;
    let lastCollectionError = null;
    let attempt = 0;
    do {
        try {
            const inventory = collectBoxListenerInventory({
                outerContainer: INSTANCE,
                run: args => invoke('podman', args),
                verifyTools: false,
            });
            lastCollectionError = null;
            lastValidation = validateListenerInventory(inventory, profile);
            if (lastValidation.ok) {
                printFullGraphListenerEvidence(lastValidation);
                process.stdout.write(
                    `IN_BOX_LISTENER_PROFILE ${profile.id} PASS ${lastValidation.listeners.length} listeners\n`,
                );
                return lastValidation;
            }
        } catch (error) {
            lastCollectionError = error;
            lastValidation = null;
        }
        if (Date.now() >= deadline) break;
        attempt += 1;
        Atomics.wait(SLEEP_ARRAY, 0, 0, Math.min(1000 + attempt * 250, 5000));
    } while (Date.now() < deadline);

    if (lastValidation) printFullGraphListenerEvidence(lastValidation);
    throw new Error(
        `full Explorer listener profile '${profile.id}' did not converge in `
        + `${FULL_GRAPH_LISTENER_TIMEOUT_MS}ms:\n`
        + `${lastValidation?.errors.join('\n') || lastCollectionError?.message || 'no inventory result'}`,
    );
}

function runConfiguredFullGraph() {
    const encoded = String(process.env.SMOKE_FULL_GRAPH_ARGS_JSON || '').trim();
    if (!encoded) {
        throw new Error(
            'FULL_EXPLORER_GRAPH is a required runtime-v5 release gate; '
            + 'set SMOKE_FULL_GRAPH_ARGS_JSON to the exact JSON argv array for a fresh Explorer graph',
        );
    }
    let args;
    try {
        args = JSON.parse(encoded);
    } catch (error) {
        throw new Error(`SMOKE_FULL_GRAPH_ARGS_JSON is not valid JSON: ${error.message}`);
    }
    if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) {
        throw new Error('SMOKE_FULL_GRAPH_ARGS_JSON must be a JSON array of strings');
    }
    const repositoriesEncoded = String(
        process.env.SMOKE_FULL_GRAPH_REPOSITORIES_JSON || '',
    ).trim();
    if (!repositoriesEncoded) {
        throw new Error(
            'FULL_EXPLORER_GRAPH requires SMOKE_FULL_GRAPH_REPOSITORIES_JSON '
            + 'mapping repository names to explicit git checkout paths',
        );
    }
    let repositories;
    try {
        repositories = JSON.parse(repositoriesEncoded);
    } catch (error) {
        throw new Error(`SMOKE_FULL_GRAPH_REPOSITORIES_JSON is not valid JSON: ${error.message}`);
    }
    if (!repositories || typeof repositories !== 'object' || Array.isArray(repositories)
        || Object.keys(repositories).length === 0) {
        throw new Error('SMOKE_FULL_GRAPH_REPOSITORIES_JSON must be a non-empty object');
    }
    for (const [repoName, configuredPath] of Object.entries(repositories).sort()) {
        if (!/^[A-Za-z0-9._-]+$/.test(repoName) || repoName === '.' || repoName === '..') {
            throw new Error(`invalid full-graph repository name '${repoName}'`);
        }
        if (typeof configuredPath !== 'string' || !path.isAbsolute(configuredPath)) {
            throw new Error(`full-graph repository '${repoName}' path must be absolute`);
        }
        const repoPath = fs.realpathSync(configuredPath);
        if (repoPath.split(path.sep).includes('.ploinky')) {
            throw new Error(`full-graph repository '${repoName}' cannot use a Ploinky-managed shadow checkout`);
        }
        if (!fs.statSync(repoPath).isDirectory() || !fs.existsSync(path.join(repoPath, '.git'))) {
            throw new Error(`full-graph repository '${repoName}' must be an exact git checkout`);
        }
        const destination = `/workspace/.ploinky/repos/${repoName}`;
        requireOk(
            `create full-graph repository destination for ${repoName}`,
            invoke('podman', ['exec', INSTANCE, 'mkdir', '-p', destination]),
        );
        requireOk(
            `copy exact full-graph repository ${repoName}`,
            invoke('podman', ['cp', `${repoPath}/.`, `${INSTANCE}:${destination}`]),
        );
        const revision = requireOk(
            `resolve full-graph repository revision for ${repoName}`,
            invoke('git', ['-C', repoPath, 'rev-parse', 'HEAD']),
        ).stdout.trim();
        process.stdout.write(`FULL_GRAPH_REPOSITORY ${repoName} ${revision}\n`);
    }
    const desiredCandidatePath = String(process.env.SMOKE_EDGE_DESIRED_FILE || '').trim();
    const configuredPublicIPv4 = String(process.env.SMOKE_MEDIA_PUBLIC_IPV4 || '').trim();
    if (!desiredCandidatePath || !configuredPublicIPv4) {
        throw new Error(
            'FULL_EXPLORER_GRAPH requires both SMOKE_EDGE_DESIRED_FILE and '
            + 'SMOKE_MEDIA_PUBLIC_IPV4; no public-IP discovery or host-capability default is permitted',
        );
    }
    if (!path.isAbsolute(desiredCandidatePath)
        || !fs.existsSync(desiredCandidatePath)
        || !fs.statSync(desiredCandidatePath).isFile()) {
        throw new Error('SMOKE_EDGE_DESIRED_FILE must be an absolute path to a readable desired-state candidate');
    }
    let desiredCandidate;
    try {
        desiredCandidate = JSON.parse(fs.readFileSync(desiredCandidatePath, 'utf8'));
    } catch (error) {
        throw new Error(`SMOKE_EDGE_DESIRED_FILE is not valid JSON: ${error.message}`);
    }
    const validatedPublicIPv4 = normalizePublicMediaIPv4(configuredPublicIPv4);
    if (desiredCandidate?.media?.publicIPv4 !== validatedPublicIPv4) {
        throw new Error('SMOKE_EDGE_DESIRED_FILE media.publicIPv4 must exactly match SMOKE_MEDIA_PUBLIC_IPV4');
    }
    if (desiredCandidate.cloudflare !== undefined || Object.keys(desiredCandidate.hosts || {}).length) {
        throw new Error(
            'the local full-graph smoke requires local-only publication state; '
            + 'Cloudflare host/DNS mutation belongs to the separately authorized external gate',
        );
    }
    if (!Array.isArray(desiredCandidate?.security?.hostNetworkAllowedInstances)
        || desiredCandidate.security.hostNetworkAllowedInstances.length !== 1) {
        throw new Error('SMOKE_EDGE_DESIRED_FILE must select exactly one host-network capability owner');
    }

    const desiredDirectory = '/workspace/.ploinky/data/edge-routing';
    const desiredTarget = `${desiredDirectory}/desired.json`;
    const desiredCandidateTarget = `${desiredTarget}.smoke-candidate`;
    requireOk(
        'create full-graph desired-state directory',
        invoke('podman', ['exec', INSTANCE, 'mkdir', '-p', desiredDirectory]),
    );
    requireOk(
        'restrict full-graph desired-state directory',
        invoke('podman', ['exec', INSTANCE, 'chmod', '700', desiredDirectory]),
    );
    requireOk(
        'copy full-graph desired-state candidate',
        invoke('podman', ['cp', desiredCandidatePath, `${INSTANCE}:${desiredCandidateTarget}`]),
    );
    requireOk(
        'atomically stage full-graph desired-state candidate',
        invoke('podman', ['exec', INSTANCE, 'mv', desiredCandidateTarget, desiredTarget]),
    );
    requireOk(
        'restrict full-graph desired-state candidate',
        invoke('podman', ['exec', INSTANCE, 'chmod', '600', desiredTarget]),
    );
    process.stdout.write(`FULL_GRAPH_EDGE_CANDIDATE staged publicIPv4=${validatedPublicIPv4}\n`);

    const telemetryOrigin = `http://127.0.0.1:${PORT}`;
    requireOk(
        'persist Umami telemetry origin through ploinky var',
        ploinky(['var', 'UMAMI_TELEMETRY_ALLOWED_ORIGINS', telemetryOrigin]),
    );
    const originReadback = requireOk(
        'read back persisted Umami telemetry origin',
        // `echo NAME` intentionally emits `NAME=value`; `$NAME` is the CLI's
        // value-only readback form and lets this gate compare exact bytes.
        ploinky(['echo', '$UMAMI_TELEMETRY_ALLOWED_ORIGINS']),
    );
    assert.ok(
        String(originReadback.stdout || '').split(/\r?\n/).includes(telemetryOrigin),
        'ploinky echo did not return the exact persisted Umami telemetry origin',
    );
    process.stdout.write(`UMAMI_TELEMETRY_ORIGIN ${telemetryOrigin}\n`);

    const startResult = ploinky(args);
    // The physical boundary is graph-independent and remains authoritative even
    // when an inner dependency or listener gate fails during graph startup.
    assertExactOuterBoundary('full-explorer-graph');
    if (startResult.status !== 0 || startResult.error) {
        const stateSummary = invoke('podman', ['exec', INSTANCE, 'node', '-e', `
            const fs = require('node:fs');
            const read = (file, fallback) => {
                try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
            };
            const root = '/workspace/.ploinky';
            const routing = read(root + '/routing.json', {});
            const agents = read(root + '/agents.json', {});
            const selector = read(root + '/data/edge-routing/active.json', {});
            const lease = read(root + '/data/edge-routing/preparation-lease.json', null);
            const routes = Object.fromEntries(Object.entries(routing.routes || {}).sort()
                .map(([key, route]) => [key, {
                    repo: String(route?.repo || ''),
                    agent: String(route?.agent || ''),
                    container: String(route?.container || ''),
                    hasHostPort: Object.hasOwn(route || {}, 'hostPort'),
                    serviceTargetCount: Object.keys(route?.serviceTargets || {}).length,
                }]));
            const registry = Object.fromEntries(Object.entries(agents || {})
                .filter(([key, record]) => key !== '_config' && record?.type === 'agent')
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, record]) => [key, {
                    repoName: String(record.repoName || ''),
                    agentName: String(record.agentName || ''),
                    alias: String(record.alias || ''),
                    hasInstanceId: Boolean(record.instanceId),
                    hasEnableGeneration: Boolean(record.enableGeneration),
                    profile: String(record.profile || ''),
                }]));
            process.stdout.write(JSON.stringify({
                routing: { port: routing.port, static: routing.static || null, routes },
                registry,
                selector: {
                    state: selector.state || '',
                    generation: selector.generation || '',
                    reason: selector.reason || '',
                },
                preparationLease: lease ? {
                    preparedGeneration: lease.preparedGeneration || '',
                    reason: lease.reason || '',
                } : null,
            }));
        `]);
        let listenerDiagnostic = '';
        try {
            const snapshot = collectFullGraphListenerSnapshot();
            listenerDiagnostic = snapshot.ok
                ? 'partial listener snapshot unexpectedly matched the full profile'
                : snapshot.errors.join('\n');
        } catch (error) {
            listenerDiagnostic = `listener snapshot collection failed: ${error?.message || error}`;
        }
        throw new Error(
            `configured full Explorer graph failed (${startResult.status}): `
            + `stdout:\n${startResult.stdout || '<empty>'}\n`
            + `stderr:\n${startResult.stderr || startResult.error || '<empty>'}\n`
            + `redacted staged-state summary:\n${stateSummary.stdout || stateSummary.stderr || '<unavailable>'}\n`
            + `partial owner-aware listener evidence:\n${listenerDiagnostic}`,
        );
    }
    validateFullGraphListeners();
}

function assertRootlessPodman() {
    requireOk('answering Podman engine', invoke('podman', ['info']));
    const rootless = requireOk(
        'rootless Podman proof',
        invoke('podman', ['info', '--format', '{{json .Host.Security.Rootless}}']),
    ).stdout.trim();
    assert.equal(rootless, 'true', 'runtime smoke requires rootless Podman');
}

try {
    assertRootlessPodman();
    requireOk('host-local help', ploinky(['help']));
    assert.equal(containerExists(), false, 'help created the runtime');

    requireOk(
        'automatic empty-workspace runtime startup',
        ploinky(['--port', PORT, '--image', IMAGE, 'list', 'agents']),
    );
    assertExactOuterBoundary('empty-workspace-create');
    requireOk('nested podman version', invoke('podman', ['exec', INSTANCE, 'podman', 'version']));
    requireOk('nested podman info', invoke('podman', ['exec', INSTANCE, 'podman', 'info']));

    for (const [markerPath, markerValue] of RETAINED_MARKERS) {
        requireOk(
            `write retained-state marker for ${markerValue}`,
            invoke('podman', ['exec', INSTANCE, 'sh', '-lc', `printf '${markerValue}' > '${markerPath}'`]),
        );
    }
    const preStartStatus = requireFailure(
        'read-only status before initial workspace start',
        ploinky(['status']),
        /persisted router port is required.*initial workspace start first/s,
    );
    assert.match(preStartStatus.stdout, /contract: compatible \(expected 5, observed 5\)/);
    assert.match(preStartStatus.stdout, new RegExp(
        `publish: 127\\.0\\.0\\.1:${PORT} -> ${BOX_ROUTER_PORT}/tcp`,
    ));
    assert.match(preStartStatus.stdout, new RegExp(
        `publish: 0\\.0\\.0\\.0:${BOX_MEDIA_PORT} -> ${BOX_MEDIA_PORT}/udp`,
    ));
    requireOk('stop', ploinky(['stop']));
    requireOk('idempotent stop', ploinky(['stop']));
    requireOk('confirmed destroy', ploinky(['destroy'], { input: 'y\n' }));
    assert.equal(containerExists(), false, `destroy left ${INSTANCE}`);
    assertRetainedVolumeLabels();

    requireOk(
        'reserve fixed UDP with a conflicting owner',
        invoke('podman', [
            'run', '-d', '--name', UDP_CONFLICT,
            '-p', `0.0.0.0:${BOX_MEDIA_PORT}:${BOX_MEDIA_PORT}/udp`,
            '--entrypoint', '/usr/bin/sleep', IMAGE, '600',
        ]),
    );
    const conflict = requireFailure(
        'owner-aware fixed UDP conflict',
        ploinky(['--port', PORT, '--image', IMAGE, 'list', 'agents']),
        new RegExp(`UDP ${BOX_MEDIA_PORT}.*podman container '${UDP_CONFLICT}'.*stop/remove`),
    );
    process.stdout.write(
        `UDP_CONFLICT_DIAGNOSTIC ${String(conflict.stderr || conflict.stdout || '').trim().replace(/\s+/g, ' ')}\n`,
    );
    assert.equal(containerExists(), false, 'UDP conflict failure created the managed runtime');
    requireOk('remove fixed UDP conflict owner', invoke('podman', ['rm', '-f', UDP_CONFLICT]));

    requireOk(
        'recreate from retained state',
        ploinky(['--port', PORT, '--image', IMAGE, 'list', 'agents']),
    );
    assertExactOuterBoundary('retained-state-recreate');
    for (const [markerPath, markerValue] of RETAINED_MARKERS) {
        const marker = requireOk(
            `read retained-state marker for ${markerValue}`,
            invoke('podman', ['exec', INSTANCE, 'cat', markerPath]),
        );
        assert.equal(marker.stdout.trim(), markerValue, `${markerValue} state did not survive destroy`);
    }

    // Prove create/recreate independently of graph startup. A later graph or
    // listener failure must not hide whether retained-state recreation changed
    // the physical box boundary.
    installRoutingProbe();
    requireOk(
        'start routing probe',
        ploinky(['--image', IMAGE, 'start', 'smoke/routing-probe', PORT]),
    );
    assertExactOuterBoundary('routing-graph');
    await assertLoopbackRouterWorks();
    await assertPhysicalRouterRefused();
    const independentGateFailures = [];
    try {
        collectRoutingListenerInventory('routing-graph');
    } catch (error) {
        independentGateFailures.push(`routing listener gate:\n${error?.stack || error}`);
    }
    // The disposable probe is not part of the Explorer profile. Remove every
    // configured probe runtime before collecting the profile's owner-aware
    // inventory; otherwise rejectAdditionalContainers correctly rejects the
    // smoke harness itself rather than the tested graph.
    try {
        requireOk('remove routing-probe runtime before full Explorer graph', ploinky(['shutdown']));
        assertExactOuterBoundary('post-routing-probe-removal');
    } catch (error) {
        independentGateFailures.push(`routing probe cleanup gate:\n${error?.stack || error}`);
    }
    try {
        runConfiguredFullGraph();
    } catch (error) {
        independentGateFailures.push(`full Explorer graph gate:\n${error?.stack || error}`);
    }
    if (independentGateFailures.length) {
        throw new Error(
            `runtime-v5 release gates failed (${independentGateFailures.length}):\n\n`
            + independentGateFailures.join('\n\n'),
        );
    }

    process.stdout.write(`runtime smoke passed (podman, ${INSTANCE})\n`);
} finally {
    if (containerExists(UDP_CONFLICT)) invoke('podman', ['rm', '-f', UDP_CONFLICT]);
    if (containerExists()) invoke('podman', ['rm', '-f', '--volumes', INSTANCE]);
    for (const name of Object.values(VOLUMES)) {
        if (volumeExists(name)) invoke('podman', ['volume', 'rm', name]);
    }
    fs.rmSync(TMP, { recursive: true, force: true });
}
