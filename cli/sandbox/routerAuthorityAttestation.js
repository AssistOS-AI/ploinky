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

const HEALTH_SOCKET = path.join(PLOINKY_DIR, 'run', 'router-health.sock');
const REQUEST_TIMEOUT_MS = 3_000;
const HELPER_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 8 * 1024;
const LOOPBACK_LOGIN_BODY = '{"ok":false,"error":"not_authenticated","login":"/auth/login?returnTo=%2Fhealth&agent=explorer"}';

const PROBE_SCRIPT = String.raw`
const http = require('node:http');
const https = require('node:https');
const [originText, firstHost, secondHost, nonce] = process.argv.slice(1);
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
    constructor(code, message, options) {
        super(message, options);
        this.name = 'RouterAuthorityAttestationError';
        this.code = code;
    }
}

function fail(code, message, cause) {
    throw new RouterAuthorityAttestationError(code, message, cause ? { cause } : undefined);
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

function isLoopbackAddress(value) {
    const address = String(value || '').toLowerCase();
    if (address === '::1') return true;
    return net.isIP(address) === 4 && address.startsWith('127.');
}

function assertExactSocketEvidence(intent, records) {
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
        if (isLoopbackAddress(local) !== expectsLoopback
            || (expectsLoopback ? !isLoopbackAddress(remote) : isLoopbackAddress(remote))
            || local === remote) {
            fail('PLOINKY_ROUTER_ATTESTATION_MISMATCH', 'internal socket address class did not match the fixed topology cell');
        }
    }
}

export function validateRouterAuthorityObservation({ intent, nonce, records, external, generationId } = {}) {
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
        assertExternal(externalByHost(external, loopback), 401, LOOPBACK_LOGIN_BODY);
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

function runBounded(command, args, { timeout = HELPER_TIMEOUT_MS } = {}) {
    const result = spawnSync(command, args, {
        encoding: 'utf8',
        timeout,
        maxBuffer: MAX_OUTPUT_BYTES,
        killSignal: 'SIGKILL',
    });
    if (result.error || result.status !== 0) {
        fail(
            'PLOINKY_ROUTER_ATTESTATION_HELPER',
            `bounded helper operation failed (${String(result.stderr || result.error?.message || '').slice(0, 512)})`,
            result.error,
        );
    }
    return String(result.stdout || '').trim();
}

function runStatusBounded(command, args, { timeout = HELPER_TIMEOUT_MS } = {}) {
    const result = spawnSync(command, args, {
        encoding: 'utf8',
        timeout,
        maxBuffer: MAX_OUTPUT_BYTES,
        killSignal: 'SIGKILL',
    });
    if (result.error || !Number.isInteger(result.status)) {
        fail('PLOINKY_ROUTER_ATTESTATION_HELPER', 'bounded helper status operation failed', result.error);
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
    const raw = runBounded(process.execPath, ['-e', script, socketPath, method, requestPath, body || ''], { timeout: REQUEST_TIMEOUT_MS + 1_000 });
    try { return JSON.parse(raw); } catch (error) { fail('PLOINKY_ROUTER_ATTESTATION_REGISTRY', 'private attestation response was malformed', error); }
}

export function createPrivateAuthorityRegistryClient({
    socketPath = process.env.PLOINKY_ROUTER_HEALTH_SOCKET || HEALTH_SOCKET,
} = {}) {
    return Object.freeze({
        register(nonce) {
            const result = privateSocketRequest(socketPath, 'POST', '/authority-attestations', JSON.stringify({ nonce }));
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

function inspectJson(runtime, id) {
    const raw = runBounded(runtime, ['container', 'inspect', id]);
    let parsed;
    try { parsed = JSON.parse(raw); } catch (error) { fail('PLOINKY_ROUTER_ATTESTATION_HELPER', 'helper inspection returned malformed JSON', error); }
    const record = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!record || typeof record !== 'object') fail('PLOINKY_ROUTER_ATTESTATION_HELPER', 'helper inspection returned no record');
    return record;
}

export function runContainerAuthorityProbe({ runtime, plan, image, intent, nonce } = {}) {
    if (runtime !== 'podman') fail('PLOINKY_ROUTER_ATTESTATION_UNSUPPORTED', 'container attestation requires verified Podman');
    const imageId = runBounded(runtime, ['image', 'inspect', '--format', '{{.Id}}', image]);
    if (!imageId || !/^(sha256:)?[a-f0-9]{64}$/.test(imageId)) fail('PLOINKY_ROUTER_ATTESTATION_HELPER', 'actual agent image did not resolve to an immutable image ID');
    const imageRecordRaw = runBounded(runtime, ['image', 'inspect', imageId]);
    let imageRecord;
    try { imageRecord = (JSON.parse(imageRecordRaw) || [])[0]; } catch (error) { fail('PLOINKY_ROUTER_ATTESTATION_HELPER', 'image inspection was malformed', error); }
    const finalUser = String(imageRecord?.Config?.User || '').trim();
    if (!finalUser || finalUser === '0' || finalUser === 'root' || finalUser.startsWith('0:')) {
        fail('PLOINKY_ROUTER_ATTESTATION_UNSUPPORTED', 'actual agent image does not declare a final unprivileged user for the confined helper');
    }
    const helperName = `ploinky-authority-${nonce.slice(0, 16)}`;
    const firstHost = intent.requestAuthority;
    const secondHost = firstHost === intent.publicAuthority ? 'host.containers.internal:8080' : intent.publicAuthority;
    const expectedNetworks = (plan?.attachments || []).map((entry) => String(entry?.name || '')).filter(Boolean).sort();
    if (expectedNetworks.length < 1 || !plan?.alias || !Array.isArray(plan?.args)) {
        fail('PLOINKY_ROUTER_ATTESTATION_HELPER', 'helper requires the exact prepared managed-network plan');
    }
    const primaryNetwork = String((plan.attachments || []).find((entry) => entry.primary)?.name || expectedNetworks[0]);
    const additionalNetworkArgs = (plan.attachments || [])
        .filter((entry) => String(entry?.name || '') !== primaryNetwork)
        .flatMap((entry) => ['--network', String(entry.name), '--network-alias', String(plan.alias)]);
    const addHostIndex = plan.args.indexOf('--add-host');
    const expectedHostMapping = addHostIndex >= 0 ? String(plan.args[addHostIndex + 1] || '') : '';
    if (!expectedHostMapping.startsWith('host.containers.internal:')) {
        fail('PLOINKY_ROUTER_ATTESTATION_HELPER', 'helper managed-network plan lacks the exact HCI mapping');
    }
    let helperId = '';
    try {
        helperId = runBounded(runtime, [
            'create', '--name', helperName,
            '--label', `io.assistos.ploinky.authority-helper=${nonce}`,
            '--init',
            '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
            '--pids-limit', '32', '--memory', '64m', '--cpus', '0.25',
            '--user', finalUser,
            ...(plan?.args || []),
            ...additionalNetworkArgs,
            imageId, 'node', '-e', PROBE_SCRIPT,
            intent.physicalOrigin, firstHost, secondHost, nonce,
        ]);
        if (!helperId) fail('PLOINKY_ROUTER_ATTESTATION_HELPER', 'helper creation did not return an immutable ID');
        const inspected = inspectJson(runtime, helperId);
        const inspectedNetworks = Object.keys(inspected.NetworkSettings?.Networks || {}).sort();
        const extraHosts = [...(inspected.HostConfig?.ExtraHosts || [])].map(String);
        const capDrop = [...(inspected.HostConfig?.CapDrop || [])].map((value) => String(value).toUpperCase());
        const capAdd = [...(inspected.HostConfig?.CapAdd || [])];
        const securityOpt = [...(inspected.HostConfig?.SecurityOpt || [])].map(String);
        const helperEnv = [...(inspected.Config?.Env || [])].map(String);
        if (String(inspected.Id || inspected.ID || '') !== helperId
            || String(inspected.Image || inspected.ImageID || '') !== imageId
            || String(inspected.Config?.User || '') !== finalUser
            || inspected.HostConfig?.Init !== true
            || inspected.HostConfig?.ReadonlyRootfs !== true
            || Number(inspected.HostConfig?.PidsLimit) !== 32
            || Number(inspected.HostConfig?.Memory) !== 64 * 1024 * 1024
            || Number(inspected.HostConfig?.NanoCpus) !== 250_000_000
            || JSON.stringify(inspectedNetworks) !== JSON.stringify(expectedNetworks)
            || String(inspected.HostConfig?.NetworkMode || '') !== primaryNetwork
            || extraHosts.length !== 1 || extraHosts[0] !== expectedHostMapping
            || !Array.isArray(inspected.Mounts) || inspected.Mounts.length !== 0
            || (inspected.HostConfig?.Binds || []).length !== 0
            || Object.keys(inspected.HostConfig?.Tmpfs || {}).length !== 0
            || Object.keys(inspected.HostConfig?.PortBindings || {}).length !== 0
            || capDrop.length !== 1 || capDrop[0] !== 'ALL'
            || capAdd.length !== 0
            || securityOpt.length !== 1 || !['no-new-privileges', 'no-new-privileges=true'].includes(securityOpt[0])
            || helperEnv.some((entry) => /^(?:PLOINKY_|AUTHORIZATION=|BEARER_)/i.test(entry))
            || String(inspected.Config?.Labels?.['io.assistos.ploinky.authority-helper'] || '') !== nonce) {
            fail('PLOINKY_ROUTER_ATTESTATION_HELPER', 'helper confinement inspection failed');
        }
        const output = runBounded(runtime, ['start', '--attach', helperId]);
        let external;
        try { external = JSON.parse(output); } catch (error) { fail('PLOINKY_ROUTER_ATTESTATION_HELPER', 'helper probe output was malformed', error); }
        if (!Array.isArray(external) || external.length !== 2) fail('PLOINKY_ROUTER_ATTESTATION_HELPER', 'helper did not produce exactly two observations');
        return Object.freeze({ external, helper: Object.freeze({ id: helperId, image: imageId, user: finalUser }) });
    } finally {
        if (helperId) {
            const inspected = inspectJson(runtime, helperId);
            if (String(inspected.Id || inspected.ID || '') !== helperId
                || String(inspected.Config?.Labels?.['io.assistos.ploinky.authority-helper'] || '') !== nonce) {
                fail('PLOINKY_ROUTER_ATTESTATION_CLEANUP', 'helper cleanup could not prove exact immutable ID and nonce ownership');
            }
            if (inspected.State?.Running === true || inspected.State?.Status === 'running') {
                runBounded(runtime, ['stop', '--time', '2', helperId], { timeout: 4_000 });
                const stopped = inspectJson(runtime, helperId);
                if (String(stopped.Id || stopped.ID || '') !== helperId
                    || String(stopped.Config?.Labels?.['io.assistos.ploinky.authority-helper'] || '') !== nonce
                    || stopped.State?.Running === true || stopped.State?.Status === 'running') {
                    fail('PLOINKY_ROUTER_ATTESTATION_CLEANUP', 'helper remained running after bounded exact-ID stop');
                }
            }
            runBounded(runtime, ['rm', helperId], { timeout: 4_000 });
            const exists = runStatusBounded(runtime, ['container', 'exists', helperId], { timeout: 4_000 });
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
    const nonce = crypto.randomBytes(32).toString('hex');
    registryClient.register(nonce);
    const probe = runProbe({ intent, nonce });
    const records = registryClient.consume(nonce);
    const evidence = validateRouterAuthorityObservation({
        intent,
        nonce,
        records,
        external: probe.external,
        generationId: generationLease.id,
    });
    if (generationLease.commit() !== true) fail('PLOINKY_ROUTER_ATTESTATION_GENERATION', 'edge generation changed after authority observation');
    const completeEvidence = Object.freeze({
        nonce,
        records: evidence.records,
        external: evidence.external,
        helper: probe.helper,
        generationId: generationLease.id,
        observedAtUnixMs: now(),
    });
    return Object.freeze({
        ...intent,
        attestationId: digest(completeEvidence),
        evidence: completeEvidence,
    });
}

export default {
    buildRouterAuthorityTopologyIntent,
    validateRouterAuthorityObservation,
    createPrivateAuthorityRegistryClient,
    runContainerAuthorityProbe,
    attestRouterAuthority,
};
