import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { PLOINKY_DIR } from '../utils/config.js';
import { isInsideBox } from '../../ploinky-box/lib/boxMarker.mjs';
import { selectedRouterHostPort } from './routerPort.js';
import { canonicalJsonBytes } from '../utils/security/generatedRouterDescriptor.js';
import {
    buildManagedProbeIdentity,
    buildManagedProbeRunArgs,
} from './docker/probeOwnership.js';

const HEALTH_SOCKET = path.join(PLOINKY_DIR, 'run', 'router-health.sock');
const REQUEST_TIMEOUT_MS = 3_000;
const HELPER_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 8 * 1024;
const MACOS_REMOTE_LOOPBACK_BODY = '{"ok":false,"error":{"code":"AUTH_REQUIRED"}}';
const AUTHORITY_HELPER_USER = '65534:65534';
export const ROUTER_AUTHORITY_EXTERNAL_PROBE_TIMEOUT = 'PLOINKY_ROUTER_ATTESTATION_EXTERNAL_PROBE_TIMEOUT';

const BOUNDED_OPERATION = Object.freeze({
    PRIVATE_REGISTRY_REQUEST: 'private-registry-request',
    TARGET_IMAGE_ID: 'target-image-id',
    TARGET_IMAGE_USER: 'target-image-user',
    HELPER_IMAGE_ID: 'helper-image-id',
    HELPER_CREATE: 'helper-create',
    HELPER_INSPECT: 'helper-inspect',
    EXTERNAL_HELPER_PROBE: 'external-helper-probe',
    HELPER_STOP: 'helper-stop',
    HELPER_REMOVE: 'helper-remove',
    HELPER_EXISTS: 'helper-exists',
});

const PROBE_SCRIPT = String.raw`
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const [originText, firstHost, secondHost, nonce] = process.argv.slice(1);
const processStatus = fs.readFileSync('/proc/self/status', 'utf8');
const statusField = (name) => new RegExp('^' + name + ':\\s+(.+)$', 'm').exec(processStatus)?.[1]?.trim() || '';
if (!/^0+$/.test(statusField('CapBnd'))
    || !/^0+$/.test(statusField('CapEff'))
    || statusField('NoNewPrivs') !== '1') {
  throw new Error('helper process confinement proof failed');
}
const origin = new URL(originText);
const client = origin.protocol === 'https:' ? https : http;
const run = (host) => new Promise((resolve, reject) => {
  const req = client.request({
    hostname: origin.hostname,
    port: origin.port || (origin.protocol === 'https:' ? 443 : 80),
    method: 'GET',
    path: '/health',
    headers: { Host: host, Accept: 'application/json', Connection: 'close', 'X-Ploinky-Authority-Probe': nonce },
    timeout: 3000,
  }, (res) => {
    const chunks = []; let size = 0;
    res.on('data', (chunk) => { size += chunk.length; if (size > 8192) req.destroy(new Error('response too large')); else chunks.push(chunk); });
    res.on('end', () => resolve({ host, status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('timeout', () => req.destroy(new Error('request timed out')));
  req.on('error', reject);
  req.end();
});
(async () => { const out = [await run(firstHost), await run(secondHost)]; process.stdout.write(JSON.stringify(out)); })()
  .catch((error) => { process.stderr.write(String(error && error.message || error).slice(0, 8192)); process.exit(1); });
`;

export class RouterAuthorityAttestationError extends Error {
    constructor(code, message, { cause, context } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = 'RouterAuthorityAttestationError';
        Object.defineProperties(this, {
            code: {
                value: code,
                enumerable: true,
                writable: false,
                configurable: false,
            },
            context: {
                value: context && typeof context === 'object'
                    ? Object.freeze({ ...context })
                    : undefined,
                enumerable: context !== undefined,
                writable: false,
                configurable: false,
            },
        });
    }
}

function fail(code, message, cause, context) {
    throw new RouterAuthorityAttestationError(code, message, {
        ...(cause ? { cause } : {}),
        ...(context ? { context } : {}),
    });
}

function digest(value) {
    return `sha256:${crypto.createHash('sha256').update(canonicalJsonBytes(value)).digest('hex')}`;
}

function exactRuntimeProof(runtimeProof) {
    if (!runtimeProof || typeof runtimeProof !== 'object' || Array.isArray(runtimeProof)) {
        fail('PLOINKY_ROUTER_ATTESTATION_UNSUPPORTED', 'verified runtime proof is required');
    }
    if (runtimeProof.engine !== 'podman' || runtimeProof.rootless !== true
        || runtimeProof.backend !== 'netavark' || typeof runtimeProof.remote !== 'boolean') {
        fail('PLOINKY_ROUTER_ATTESTATION_UNSUPPORTED', 'generated-local requires verified rootless Podman with Netavark');
    }
    return runtimeProof;
}

export function buildRouterAuthorityTopologyIntent({
    networkMode,
    runtimeProof,
    networkFingerprint,
    runtimeKind = 'container',
    fsApi = fs,
    markerPath,
    platform = process.platform,
    routerHostPort = selectedRouterHostPort(),
    edgeTopologyFile,
} = {}) {
    const mode = String(networkMode || '').trim().toLowerCase();
    if (mode === 'none') return null;
    const publicAuthority = `127.0.0.1:${routerHostPort}`;
    const markerOptions = { fsApi };
    if (markerPath) markerOptions.markerPath = markerPath;
    const insideBox = isInsideBox(markerOptions);

    if (runtimeKind === 'bwrap' || runtimeKind === 'seatbelt') {
        if (mode !== 'host') fail('PLOINKY_ROUTER_ATTESTATION_UNSUPPORTED', `${runtimeKind} attestation requires the exact host network contract`);
        return Object.freeze({
            topology: `${runtimeKind}-public-loopback`,
            listenerClass: 'public',
            socketLocalAddressClass: 'public',
            physicalOrigin: 'http://127.0.0.1:8080',
            publicAuthority,
            requestAuthority: publicAuthority,
            routerHost: '127.0.0.1',
            routerPort: '8080',
            internalRouterUrl: 'http://127.0.0.1:8081',
            edgeTopologyFile,
            runtimeProof: Object.freeze({ runtime: runtimeKind, platform }),
            networkFingerprint: digest({ runtime: runtimeKind, mode, platform }),
        });
    }

    if (mode === 'host') {
        return Object.freeze({
            topology: 'host-public-loopback',
            listenerClass: 'public',
            socketLocalAddressClass: 'public',
            physicalOrigin: 'http://127.0.0.1:8080',
            publicAuthority,
            requestAuthority: publicAuthority,
            routerHost: '127.0.0.1',
            routerPort: '8080',
            internalRouterUrl: 'http://127.0.0.1:8081',
            edgeTopologyFile,
            runtimeProof: Object.freeze({ runtime: 'host', platform }),
            networkFingerprint: digest({ runtime: 'host', mode, platform }),
        });
    }
    if (!['default', 'bridge'].includes(mode)) {
        fail('PLOINKY_ROUTER_ATTESTATION_UNSUPPORTED', `network mode '${mode}' is not certified for generated-local routing`);
    }
    const proof = exactRuntimeProof(runtimeProof);
    if (!/^sha256:[a-f0-9]{64}$/.test(String(networkFingerprint || ''))) {
        fail('PLOINKY_ROUTER_ATTESTATION_UNSUPPORTED', 'an exact verified network fingerprint is required');
    }
    const publicLane = insideBox || proof.remote === true;
    const topology = insideBox
        ? 'box-public-loopback'
        : (proof.remote === true
            ? (platform === 'darwin' ? 'macos-remote-public-loopback' : 'remote-public-loopback')
            : 'native-linux-rootless-managed');
    return Object.freeze({
        topology,
        listenerClass: publicLane ? 'public' : 'managed',
        socketLocalAddressClass: publicLane ? 'public' : 'managed',
        physicalOrigin: 'http://host.containers.internal:8080',
        publicAuthority,
        requestAuthority: publicLane ? publicAuthority : 'host.containers.internal:8080',
        routerHost: 'host.containers.internal',
        routerPort: '8080',
        internalRouterUrl: 'http://host.containers.internal:8081',
        edgeTopologyFile,
        runtimeProof: proof,
        networkFingerprint,
    });
}

function recordByHost(records, host) {
    const matches = records.filter((record) => record?.rawHost === host);
    if (matches.length !== 1) fail('PLOINKY_ROUTER_ATTESTATION_MISMATCH', `expected exactly one internal observation for Host ${host}`);
    return matches[0];
}

function externalByHost(external, host) {
    const matches = external.filter((record) => record?.host === host);
    if (matches.length !== 1) fail('PLOINKY_ROUTER_ATTESTATION_MISMATCH', `expected exactly one external result for Host ${host}`);
    return matches[0];
}

function assertRecord(record, expected) {
    for (const [field, value] of Object.entries(expected)) {
        if (record?.[field] !== value) {
            fail('PLOINKY_ROUTER_ATTESTATION_MISMATCH', `internal observation ${field} did not match the fixed topology cell`);
        }
    }
}

function assertExternal(record, status, body) {
    if (record?.status !== status || record?.body !== body) {
        fail('PLOINKY_ROUTER_ATTESTATION_MISMATCH', 'external status/body did not match the fixed topology cell');
    }
}

function exactStaticRouteIdentity(generationSnapshot, generationId) {
    if (!generationSnapshot || typeof generationSnapshot !== 'object' || Array.isArray(generationSnapshot)) {
        fail('PLOINKY_ROUTER_ATTESTATION_INVALID', 'public-loopback attestation requires its immutable generation snapshot');
    }
    if (generationSnapshot.generation !== generationId) {
        fail('PLOINKY_ROUTER_ATTESTATION_GENERATION', 'authority attestation snapshot generation changed');
    }
    const routeIdentity = generationSnapshot.routing?.static?.agent;
    if (typeof routeIdentity !== 'string' || !routeIdentity || routeIdentity !== routeIdentity.trim()) {
        fail('PLOINKY_ROUTER_ATTESTATION_INVALID', 'public-loopback attestation requires one exact static route identity');
    }
    return routeIdentity;
}

function exactLoopbackLoginBody(generationSnapshot, generationId) {
    const query = new URLSearchParams({ returnTo: '/health' });
    query.set('agent', exactStaticRouteIdentity(generationSnapshot, generationId));
    return JSON.stringify({
        ok: false,
        error: 'not_authenticated',
        login: `/auth/login?${query.toString()}`,
    });
}

function isLoopbackAddress(value) {
    const address = String(value || '').toLowerCase();
    if (address === '::1') return true;
    return net.isIP(address) === 4 && address.startsWith('127.');
}

function assertExactMacosRemoteSocketEvidence(intent, records) {
    if (intent.listenerClass !== 'public'
        || intent.socketLocalAddressClass !== 'public'
        || intent.runtimeProof?.remote !== true) {
        fail('PLOINKY_ROUTER_ATTESTATION_MISMATCH', 'macOS remote intent did not match the fixed public topology cell');
    }
    for (const record of records) {
        if (record?.rawInterfaceClass !== 'loopback'
            || record?.socketLocalAddress !== '127.0.0.1'
            || record?.socketRemoteAddress !== '127.0.0.1') {
            fail('PLOINKY_ROUTER_ATTESTATION_MISMATCH', 'macOS remote socket/interface evidence did not match the exact VM proxy cell');
        }
    }
}

function assertExactSocketEvidence(intent, records) {
    if (intent.topology === 'macos-remote-public-loopback') {
        assertExactMacosRemoteSocketEvidence(intent, records);
        return;
    }
    const expectedRawClass = intent.listenerClass === 'managed'
        ? 'managed'
        : (['host-public-loopback', 'bwrap-public-loopback', 'seatbelt-public-loopback'].includes(intent.topology)
            ? 'loopback'
            : 'unmanaged');
    const first = records[0];
    for (const record of records) {
        const local = String(record?.socketLocalAddress || '');
        const remote = String(record?.socketRemoteAddress || '');
        if (record?.rawInterfaceClass !== expectedRawClass
            || net.isIP(local) === 0
            || net.isIP(remote) === 0
            || local !== first.socketLocalAddress
            || remote !== first.socketRemoteAddress) {
            fail('PLOINKY_ROUTER_ATTESTATION_MISMATCH', 'internal socket/interface evidence did not match the fixed topology cell');
        }
        const expectsLoopback = expectedRawClass === 'loopback';
        const exactBoxNatHairpin = intent.topology === 'box-public-loopback'
            && expectedRawClass === 'unmanaged'
            && !isLoopbackAddress(local)
            && local === remote;
        if (isLoopbackAddress(local) !== expectsLoopback
            || (expectsLoopback ? !isLoopbackAddress(remote) : isLoopbackAddress(remote))
            || (local === remote && !exactBoxNatHairpin)) {
            fail(
                'PLOINKY_ROUTER_ATTESTATION_MISMATCH',
                `internal socket address class did not match the fixed topology cell (${JSON.stringify({
                    expectedRawClass,
                    rawInterfaceClass: record?.rawInterfaceClass,
                    local,
                    remote,
                })})`,
            );
        }
    }
}

export function validateRouterAuthorityObservation({
    intent,
    nonce,
    records,
    external,
    generationId,
    generationSnapshot,
} = {}) {
    if (!intent || !/^[a-f0-9]{64}$/.test(String(nonce || ''))
        || !Array.isArray(records) || records.length !== 2
        || !Array.isArray(external) || external.length !== 2
        || !generationId) {
        fail('PLOINKY_ROUTER_ATTESTATION_INVALID', 'authority attestation evidence is incomplete');
    }
    const loopback = intent.publicAuthority;
    const hci = 'host.containers.internal:8080';
    const loopbackRecord = recordByHost(records, loopback);
    const hciRecord = recordByHost(records, hci);
    for (const record of records) {
        if (record.generationLeaseId !== generationId) fail('PLOINKY_ROUTER_ATTESTATION_GENERATION', 'authority observation generation changed');
    }
    assertExactSocketEvidence(intent, records);
    if (intent.listenerClass === 'public') {
        assertRecord(loopbackRecord, {
            normalizedHost: '127.0.0.1',
            effectiveListener: 'public',
            routePlanOk: false,
            routePlanStatus: 404,
            routePlanCode: 'ROUTE_NOT_FOUND',
            hostSelectionKind: 'control',
            controlMiss: true,
        });
        assertRecord(hciRecord, {
            normalizedHost: 'host.containers.internal',
            effectiveListener: 'public',
            routePlanOk: false,
            routePlanStatus: 421,
            routePlanCode: 'UNKNOWN_HOST',
            hostSelectionKind: null,
            controlMiss: false,
        });
        const loopbackBody = intent.topology === 'macos-remote-public-loopback'
            ? MACOS_REMOTE_LOOPBACK_BODY
            : exactLoopbackLoginBody(generationSnapshot, generationId);
        assertExternal(externalByHost(external, loopback), 401, loopbackBody);
        assertExternal(externalByHost(external, hci), 421, '{"error":"UNKNOWN_HOST"}');
    } else {
        assertRecord(hciRecord, {
            normalizedHost: 'host.containers.internal',
            effectiveListener: 'managed',
            routePlanOk: false,
            routePlanStatus: 404,
            routePlanCode: 'ROUTE_SURFACE_DENIED',
            hostSelectionKind: 'managed-agent',
            controlMiss: false,
        });
        assertRecord(loopbackRecord, {
            normalizedHost: '127.0.0.1',
            effectiveListener: 'managed',
            routePlanOk: false,
            routePlanStatus: 421,
            routePlanCode: 'UNKNOWN_HOST',
            hostSelectionKind: null,
            controlMiss: false,
        });
        assertExternal(externalByHost(external, hci), 404, '{"error":"ROUTE_SURFACE_DENIED"}');
        assertExternal(externalByHost(external, loopback), 421, '{"error":"UNKNOWN_HOST"}');
    }
    return Object.freeze({ nonce, records: Object.freeze([...records]), external: Object.freeze([...external]) });
}

function runBounded(command, args, { timeout = HELPER_TIMEOUT_MS, operation } = {}) {
    if (!Object.values(BOUNDED_OPERATION).includes(operation)) {
        fail('PLOINKY_ROUTER_ATTESTATION_INVALID', 'bounded helper operation requires an exact operation label');
    }
    const result = spawnSync(command, args, {
        encoding: 'utf8',
        timeout,
        maxBuffer: MAX_OUTPUT_BYTES,
        killSignal: 'SIGKILL',
    });
    if (result.error || result.status !== 0) {
        const stderr = String(result.stderr || '').trim();
        const timedOut = result.error?.code === 'ETIMEDOUT'
            || (operation === BOUNDED_OPERATION.EXTERNAL_HELPER_PROBE && stderr === 'request timed out');
        const code = operation === BOUNDED_OPERATION.EXTERNAL_HELPER_PROBE && timedOut
            ? ROUTER_AUTHORITY_EXTERNAL_PROBE_TIMEOUT
            : 'PLOINKY_ROUTER_ATTESTATION_HELPER_OPERATION_FAILED';
        fail(
            code,
            `bounded helper operation '${operation}' failed (${String(result.stderr || result.error?.message || '').slice(0, 512)})`,
            result.error,
            {
                operation,
                timeoutMs: timeout,
                timedOut,
            },
        );
    }
    return String(result.stdout || '').trim();
}

function runStatusBounded(command, args, { timeout = HELPER_TIMEOUT_MS, operation } = {}) {
    if (!Object.values(BOUNDED_OPERATION).includes(operation)) {
        fail('PLOINKY_ROUTER_ATTESTATION_INVALID', 'bounded helper status operation requires an exact operation label');
    }
    const result = spawnSync(command, args, {
        encoding: 'utf8',
        timeout,
        maxBuffer: MAX_OUTPUT_BYTES,
        killSignal: 'SIGKILL',
    });
    if (result.error || !Number.isInteger(result.status)) {
        fail(
            'PLOINKY_ROUTER_ATTESTATION_HELPER_STATUS_OPERATION_FAILED',
            `bounded helper status operation '${operation}' failed`,
            result.error,
            {
                operation,
                timeoutMs: timeout,
                timedOut: result.error?.code === 'ETIMEDOUT',
            },
        );
    }
    return Object.freeze({
        status: result.status,
        stdout: String(result.stdout || '').slice(0, MAX_OUTPUT_BYTES),
        stderr: String(result.stderr || '').slice(0, MAX_OUTPUT_BYTES),
    });
}

function privateSocketRequest(socketPath, method, requestPath, body = null) {
    const script = String.raw`
const http=require('node:http'); const [socketPath,method,path,body]=process.argv.slice(1);
const bytes=body ? Buffer.from(body) : Buffer.alloc(0);
const req=http.request({socketPath,method,path,headers:bytes.length?{'content-type':'application/json','content-length':bytes.length}:{}},res=>{const chunks=[];let size=0;res.on('data',c=>{size+=c.length;if(size>8192)req.destroy(new Error('response too large'));else chunks.push(c)});res.on('end',()=>process.stdout.write(JSON.stringify({status:res.statusCode,body:Buffer.concat(chunks).toString('utf8')})))});
req.setTimeout(3000,()=>req.destroy(new Error('request timed out')));req.on('error',e=>{process.stderr.write(String(e.message||e));process.exit(1)});req.end(bytes);
`;
    const raw = runBounded(process.execPath, ['-e', script, socketPath, method, requestPath, body || ''], {
        timeout: REQUEST_TIMEOUT_MS + 1_000,
        operation: BOUNDED_OPERATION.PRIVATE_REGISTRY_REQUEST,
    });
    try { return JSON.parse(raw); } catch (error) { fail('PLOINKY_ROUTER_ATTESTATION_REGISTRY', 'private attestation response was malformed', error); }
}

export function createPrivateAuthorityRegistryClient({
    socketPath = process.env.PLOINKY_ROUTER_HEALTH_SOCKET || HEALTH_SOCKET,
} = {}) {
    return Object.freeze({
        register(nonce, generationLeaseId) {
            const result = privateSocketRequest(
                socketPath,
                'POST',
                '/authority-attestations',
                JSON.stringify({ nonce, generationLeaseId }),
            );
            if (result.status !== 201) fail('PLOINKY_ROUTER_ATTESTATION_REGISTRY', 'authority nonce registration failed');
        },
        consume(nonce) {
            const result = privateSocketRequest(socketPath, 'GET', `/authority-attestations/${nonce}`);
            if (result.status !== 200) fail('PLOINKY_ROUTER_ATTESTATION_REGISTRY', 'authority observation consumption failed');
            let parsed;
            try { parsed = JSON.parse(result.body); } catch (error) { fail('PLOINKY_ROUTER_ATTESTATION_REGISTRY', 'authority observation response was malformed', error); }
            if (parsed?.ok !== true || parsed?.nonce !== nonce || !Array.isArray(parsed.records)) {
                fail('PLOINKY_ROUTER_ATTESTATION_REGISTRY', 'authority observation response was incomplete');
            }
            return parsed.records;
        },
    });
}

const AUTHORITY_HELPER_INSPECT_FORMAT = String.raw`{"id":{{json .ID}},"image":{{json .Image}},"user":{{json .Config.User}},"entrypoint":{{json .Config.Entrypoint}},"init":{{json .HostConfig.Init}},"readonlyRootfs":{{json .HostConfig.ReadonlyRootfs}},"pidsLimit":{{json .HostConfig.PidsLimit}},"memory":{{json .HostConfig.Memory}},"nanoCpus":{{json .HostConfig.NanoCpus}},"networkMode":{{json .HostConfig.NetworkMode}},"extraHosts":{{json .HostConfig.ExtraHosts}},"mountCount":{{len .Mounts}},"bindCount":{{len .HostConfig.Binds}},"tmpfsCount":{{len .HostConfig.Tmpfs}},"portBindingCount":{{len .HostConfig.PortBindings}},"capDrop":{{json .HostConfig.CapDrop}},"capAdd":{{json .HostConfig.CapAdd}},"securityOpt":{{json .HostConfig.SecurityOpt}},"env":{{json .Config.Env}},"labels":{{json .Config.Labels}},"networks":{{json .NetworkSettings.Networks}},"running":{{json .State.Running}},"status":{{json .State.Status}}}`;

function inspectAuthorityHelper(runtime, id) {
    const raw = runBounded(runtime, [
        'container', 'inspect', '--format', AUTHORITY_HELPER_INSPECT_FORMAT, id,
    ], { operation: BOUNDED_OPERATION.HELPER_INSPECT });
    let parsed;
    try { parsed = JSON.parse(raw); } catch (error) { fail('PLOINKY_ROUTER_ATTESTATION_HELPER', 'helper projected inspection returned malformed JSON', error); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        fail('PLOINKY_ROUTER_ATTESTATION_HELPER', 'helper projected inspection returned no record');
    }
    return parsed;
}

export function managedImageUserNamespace(imageUser) {
    const match = /^([1-9][0-9]*):([1-9][0-9]*)$/.exec(String(imageUser || ''));
    const maxLinuxId = 4_294_967_294n;
    if (!match
        || BigInt(match[1]) > maxLinuxId
        || BigInt(match[2]) > maxLinuxId) {
        return '';
    }
    return `keep-id:uid=${match[1]},gid=${match[2]}`;
}

function authorityPlanContract(plan) {
    const expectedNetworks = (plan?.attachments || [])
        .map((entry) => String(entry?.name || ''))
        .filter(Boolean)
        .sort();
    if (expectedNetworks.length < 1 || !plan?.alias || !Array.isArray(plan?.args)) {
        fail('PLOINKY_ROUTER_ATTESTATION_HELPER', 'helper requires the exact prepared managed-network plan');
    }
    const primaryNetwork = String(
        (plan.attachments || []).find((entry) => entry.primary)?.name
        || expectedNetworks[0],
    );
    const additionalNetworkArgs = (plan.attachments || [])
        .filter((entry) => String(entry?.name || '') !== primaryNetwork)
        .flatMap((entry) => ['--network', String(entry.name), '--network-alias', String(plan.alias)]);
    const addHostIndex = plan.args.indexOf('--add-host');
    const expectedHostMapping = addHostIndex >= 0 ? String(plan.args[addHostIndex + 1] || '') : '';
    if (!expectedHostMapping.startsWith('host.containers.internal:')) {
        fail('PLOINKY_ROUTER_ATTESTATION_HELPER', 'helper managed-network plan lacks the exact HCI mapping');
    }
    return Object.freeze({
        expectedNetworks,
        primaryNetwork,
        additionalNetworkArgs,
        expectedHostMapping,
    });
}

export function buildContainerAuthorityHelperCreateArgs({
    plan,
    helperImageId,
    intent,
    nonce,
    probeOwnership,
} = {}) {
    const exactHelperImageId = String(helperImageId || '').replace(/^sha256:/, '');
    if (!/^[a-f0-9]{64}$/.test(exactHelperImageId)) {
        fail('PLOINKY_ROUTER_ATTESTATION_HELPER', 'authority helper requires one exact raw image ID');
    }
    const firstHost = intent.requestAuthority;
    const secondHost = firstHost === intent.publicAuthority ? 'host.containers.internal:8080' : intent.publicAuthority;
    const { additionalNetworkArgs } = authorityPlanContract(plan);
    return [
        'create',
        ...buildManagedProbeRunArgs({
            ...probeOwnership,
            purpose: 'router-authority',
            imageId: exactHelperImageId,
        }),
        '--label', `io.assistos.ploinky.authority-helper=${nonce}`,
        '--init',
        '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
        '--pids-limit', '32', '--memory', '64m', '--cpus', '0.25',
        '--user', AUTHORITY_HELPER_USER,
        '--entrypoint', 'node',
        ...(plan?.args || []),
        ...additionalNetworkArgs,
        exactHelperImageId, '-e', PROBE_SCRIPT,
        intent.physicalOrigin, firstHost, secondHost, nonce,
    ];
}

function exactProbeLabels(observed, expected, nonce) {
    if (!observed || typeof observed !== 'object' || Array.isArray(observed)) return false;
    const exact = {
        ...expected,
        'io.assistos.ploinky.authority-helper': nonce,
    };
    // Podman carries immutable image metadata labels into Config.Labels. Probe
    // ownership is exact when every controller label is present with the
    // expected value; inherited provenance labels are not ownership authority.
    return Object.entries(exact)
        .every(([key, value]) => String(observed[key]) === value);
}

export function runContainerAuthorityProbe({
    runtime,
    plan,
    image,
    helperImage,
    intent,
    nonce,
    probeOwnership,
} = {}) {
    if (runtime !== 'podman') fail('PLOINKY_ROUTER_ATTESTATION_UNSUPPORTED', 'container attestation requires verified Podman');
    const targetImageId = runBounded(runtime, ['image', 'inspect', '--format', '{{.Id}}', image], {
        operation: BOUNDED_OPERATION.TARGET_IMAGE_ID,
    }).replace(/^sha256:/, '');
    if (!/^[a-f0-9]{64}$/.test(targetImageId)) fail('PLOINKY_ROUTER_ATTESTATION_HELPER', 'actual agent image did not resolve to an immutable image ID');
    const targetImageUser = runBounded(runtime, ['image', 'inspect', '--format', '{{.Config.User}}', targetImageId], {
        operation: BOUNDED_OPERATION.TARGET_IMAGE_USER,
    });
    const helperImageId = runBounded(runtime, ['image', 'inspect', '--format', '{{.Id}}', helperImage], {
        operation: BOUNDED_OPERATION.HELPER_IMAGE_ID,
    }).replace(/^sha256:/, '');
    if (!/^[a-f0-9]{64}$/.test(helperImageId) || helperImageId !== String(helperImage || '').replace(/^sha256:/, '')) {
        fail('PLOINKY_ROUTER_ATTESTATION_HELPER', 'descriptor authority helper image did not resolve to its exact raw image ID');
    }
    const expectedProbeIdentity = buildManagedProbeIdentity({
        ...probeOwnership,
        purpose: 'router-authority',
        imageId: helperImageId,
    });
    const {
        expectedNetworks,
        primaryNetwork,
        expectedHostMapping,
    } = authorityPlanContract(plan);
    let helperId = '';
    try {
        helperId = runBounded(runtime, buildContainerAuthorityHelperCreateArgs({
            plan,
            helperImageId,
            intent,
            nonce,
            probeOwnership,
        }), { operation: BOUNDED_OPERATION.HELPER_CREATE }).replace(/^sha256:/, '');
        if (!helperId) fail('PLOINKY_ROUTER_ATTESTATION_HELPER', 'helper creation did not return an immutable ID');
        const inspected = inspectAuthorityHelper(runtime, helperId);
        const inspectedNetworks = Object.keys(inspected.networks || {}).sort();
        const extraHosts = [...(inspected.extraHosts || [])].map(String);
        const capDrop = [...(inspected.capDrop || [])].map((value) => String(value).toUpperCase());
        const capAdd = [...(inspected.capAdd || [])];
        const securityOpt = [...(inspected.securityOpt || [])].map(String);
        const helperEnv = [...(inspected.env || [])].map(String);
        const portableCapDrop = capDrop.length > 0 && capDrop.every((value) => (
            value === 'ALL' || /^CAP_[A-Z0-9_]+$/.test(value)
        ));
        if (String(inspected.id || '') !== helperId
            || String(inspected.image || '') !== helperImageId
            || String(inspected.user || '') !== AUTHORITY_HELPER_USER
            || JSON.stringify(inspected.entrypoint || []) !== JSON.stringify(['node'])
            || inspected.init !== true
            || inspected.readonlyRootfs !== true
            || Number(inspected.pidsLimit) !== 32
            || Number(inspected.memory) !== 64 * 1024 * 1024
            || Number(inspected.nanoCpus) !== 250_000_000
            || JSON.stringify(inspectedNetworks) !== JSON.stringify(expectedNetworks)
            || !['bridge', primaryNetwork].includes(String(inspected.networkMode || ''))
            || extraHosts.length !== 1 || extraHosts[0] !== expectedHostMapping
            || Number(inspected.mountCount) !== 0
            || Number(inspected.bindCount) !== 0
            || Number(inspected.tmpfsCount) !== 0
            || Number(inspected.portBindingCount) !== 0
            || !portableCapDrop
            || capAdd.length !== 0
            || securityOpt.length !== 1 || !['no-new-privileges', 'no-new-privileges=true'].includes(securityOpt[0])
            || helperEnv.some((entry) => /^(?:PLOINKY_|AUTHORIZATION=|BEARER_)/i.test(entry))
            || !exactProbeLabels(inspected.labels, expectedProbeIdentity.labels, nonce)) {
            fail('PLOINKY_ROUTER_ATTESTATION_HELPER', 'helper confinement inspection failed');
        }
        const output = runBounded(runtime, ['start', '--attach', helperId], {
            operation: BOUNDED_OPERATION.EXTERNAL_HELPER_PROBE,
        });
        let external;
        try { external = JSON.parse(output); } catch (error) { fail('PLOINKY_ROUTER_ATTESTATION_HELPER', 'helper probe output was malformed', error); }
        if (!Array.isArray(external) || external.length !== 2) fail('PLOINKY_ROUTER_ATTESTATION_HELPER', 'helper did not produce exactly two observations');
        return Object.freeze({
            external,
            helper: Object.freeze({
                id: helperId,
                image: helperImageId,
                user: AUTHORITY_HELPER_USER,
            }),
            target: Object.freeze({ image: targetImageId, user: targetImageUser }),
        });
    } finally {
        if (helperId) {
            const inspected = inspectAuthorityHelper(runtime, helperId);
            if (String(inspected.id || '') !== helperId
                || !exactProbeLabels(inspected.labels, expectedProbeIdentity.labels, nonce)) {
                fail('PLOINKY_ROUTER_ATTESTATION_CLEANUP', 'helper cleanup could not prove exact immutable ID and nonce ownership');
            }
            if (inspected.running === true || inspected.status === 'running') {
                runBounded(runtime, ['stop', '--time', '2', helperId], {
                    timeout: 4_000,
                    operation: BOUNDED_OPERATION.HELPER_STOP,
                });
                const stopped = inspectAuthorityHelper(runtime, helperId);
                if (String(stopped.id || '') !== helperId
                    || !exactProbeLabels(stopped.labels, expectedProbeIdentity.labels, nonce)
                    || stopped.running === true || stopped.status === 'running') {
                    fail('PLOINKY_ROUTER_ATTESTATION_CLEANUP', 'helper remained running after bounded exact-ID stop');
                }
            }
            runBounded(runtime, ['rm', helperId], {
                timeout: 4_000,
                operation: BOUNDED_OPERATION.HELPER_REMOVE,
            });
            const exists = runStatusBounded(runtime, ['container', 'exists', helperId], {
                timeout: 4_000,
                operation: BOUNDED_OPERATION.HELPER_EXISTS,
            });
            if (exists.status !== 1) {
                fail('PLOINKY_ROUTER_ATTESTATION_CLEANUP', 'helper removal was not proven by immutable ID');
            }
        }
    }
}

export function attestRouterAuthority({
    intent,
    generationLease,
    registryClient = createPrivateAuthorityRegistryClient(),
    runProbe,
    now = () => Date.now(),
} = {}) {
    if (!intent || !generationLease?.id || typeof generationLease.commit !== 'function' || typeof runProbe !== 'function') {
        fail('PLOINKY_ROUTER_ATTESTATION_INVALID', 'attestation requires fixed intent, generation lease, registry, and exact probe runner');
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const nonce = crypto.randomBytes(32).toString('hex');
        registryClient.register(nonce, generationLease.id);
        let probe;
        try {
            probe = runProbe({ intent, nonce });
        } catch (error) {
            const retryableTransportTimeout = error instanceof RouterAuthorityAttestationError
                && error.code === ROUTER_AUTHORITY_EXTERNAL_PROBE_TIMEOUT
                && error.context?.operation === BOUNDED_OPERATION.EXTERNAL_HELPER_PROBE
                && error.context?.timeoutMs === HELPER_TIMEOUT_MS
                && error.context?.timedOut === true;
            if (attempt === 0 && retryableTransportTimeout) continue;
            throw error;
        }
        const records = registryClient.consume(nonce);
        const evidence = validateRouterAuthorityObservation({
            intent,
            nonce,
            records,
            external: probe.external,
            generationId: generationLease.id,
            generationSnapshot: generationLease.snapshot,
        });
        if (generationLease.commit() !== true) fail('PLOINKY_ROUTER_ATTESTATION_GENERATION', 'edge generation changed after authority observation');
        const completeEvidence = Object.freeze({
            nonce,
            records: evidence.records,
            external: evidence.external,
            helper: probe.helper,
            target: probe.target,
            generationId: generationLease.id,
            observedAtUnixMs: now(),
        });
        return Object.freeze({
            ...intent,
            attestationId: digest(completeEvidence),
            evidence: completeEvidence,
        });
    }
    fail('PLOINKY_ROUTER_ATTESTATION_INVALID', 'authority attestation exhausted without a terminal result');
}

export default {
    buildRouterAuthorityTopologyIntent,
    validateRouterAuthorityObservation,
    createPrivateAuthorityRegistryClient,
    managedImageUserNamespace,
    ROUTER_AUTHORITY_EXTERNAL_PROBE_TIMEOUT,
    runContainerAuthorityProbe,
    attestRouterAuthority,
};
