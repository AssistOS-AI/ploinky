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
const AUTHORITY_HELPER_USER = '65534:65534';
const AUTHORITY_HELPER_LABEL = 'io.assistos.ploinky.authority-helper';
const AUTHORITY_HELPER_NAME_PREFIX = 'ploinky-authority-';
export const ROUTER_AUTHORITY_HELPER_MAX_LIFETIME_MS = 60_000;
const AUTHORITY_HELPER_STALE_GRACE_MS = 15_000;
const AUTHORITY_HELPER_RECONCILE_ATTEMPTS = 5;
const AUTHORITY_HELPER_RECONCILE_DELAY_MS = 250;
const AUTHORITY_HELPER_IDLE_SCRIPT = `setTimeout(() => process.exit(0), ${ROUTER_AUTHORITY_HELPER_MAX_LIFETIME_MS});`;
export const ROUTER_AUTHORITY_HELPER_IMAGE = 'docker.io/library/node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d';
export const ROUTER_AUTHORITY_ATTESTATION_MAX_ATTEMPTS = 3;
export const ROUTER_AUTHORITY_OBSERVATION_EXPIRED = 'PLOINKY_ROUTER_ATTESTATION_OBSERVATION_EXPIRED';

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

function exactAuthRouteKey(value) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || !value || value !== value.trim()
        || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
        fail('PLOINKY_ROUTER_ATTESTATION_INVALID', 'authority authentication route key is invalid');
    }
    return value;
}

function exactUnauthenticatedHealthBodies(authRouteKey) {
    const routeKey = exactAuthRouteKey(authRouteKey);
    if (!routeKey) {
        fail('PLOINKY_ROUTER_ATTESTATION_INVALID', 'public authority attestation requires the generation-bound authentication route key');
    }
    const query = new URLSearchParams({ returnTo: '/health', agent: routeKey });
    // Authenticated route modes challenge before the admin-only health guard;
    // auth-free modes reach that guard directly. Both denials are exact.
    return Object.freeze([
        JSON.stringify({
            ok: false,
            error: 'not_authenticated',
            login: `/auth/login?${query.toString()}`,
        }),
        JSON.stringify({ ok: false, error: { code: 'AUTH_REQUIRED' } }),
    ]);
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
    authRouteKey,
} = {}) {
    const mode = String(networkMode || '').trim().toLowerCase();
    if (mode === 'none') return null;
    const publicAuthority = `127.0.0.1:${routerHostPort}`;
    const exactAuthenticationRoute = exactAuthRouteKey(authRouteKey);
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
            authRouteKey: exactAuthenticationRoute,
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
            authRouteKey: exactAuthenticationRoute,
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
        authRouteKey: exactAuthenticationRoute,
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

function externalBodyMetadata(value) {
    const bytes = Buffer.from(String(value ?? ''), 'utf8');
    return {
        actualBodyBytes: bytes.length,
        actualBodySha256: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
    };
}

function boundedFailureMetadata(result) {
    const stderr = Buffer.from(String(result?.stderr || ''), 'utf8');
    return JSON.stringify({
        status: Number.isInteger(result?.status) ? result.status : null,
        stderrBytes: stderr.length,
        stderrSha256: `sha256:${crypto.createHash('sha256').update(stderr).digest('hex')}`,
    });
}

function assertExternal(record, status, body) {
    const expectedBodies = Array.isArray(body) ? body : [body];
    if (record?.status !== status || !expectedBodies.includes(record?.body)) {
        fail(
            'PLOINKY_ROUTER_ATTESTATION_MISMATCH',
            `external status/body did not match the fixed topology cell (${JSON.stringify({
                host: record?.host,
                expectedStatus: status,
                actualStatus: record?.status,
                ...externalBodyMetadata(record?.body),
            })})`,
        );
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
        : (['host-public-loopback', 'bwrap-public-loopback', 'seatbelt-public-loopback', 'macos-remote-public-loopback'].includes(intent.topology)
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
            fail(
                'PLOINKY_ROUTER_ATTESTATION_MISMATCH',
                `internal socket/interface evidence did not match the fixed topology cell (${JSON.stringify({
                    expectedRawClass,
                    records: records.map((entry) => ({
                        rawInterfaceClass: entry?.rawInterfaceClass,
                        socketLocalAddress: entry?.socketLocalAddress,
                        socketRemoteAddress: entry?.socketRemoteAddress,
                    })),
                })})`,
            );
        }
        const expectsLoopback = expectedRawClass === 'loopback';
        const exactBoxNatHairpin = intent.topology === 'box-public-loopback'
            && expectedRawClass === 'unmanaged'
            && !isLoopbackAddress(local)
            && local === remote;
        if (isLoopbackAddress(local) !== expectsLoopback
            || (expectsLoopback ? !isLoopbackAddress(remote) : isLoopbackAddress(remote))
            || (local === remote && !expectsLoopback && !exactBoxNatHairpin)) {
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
        assertExternal(
            externalByHost(external, loopback),
            401,
            exactUnauthenticatedHealthBodies(intent.authRouteKey),
        );
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

const DEFAULT_AUTHORITY_COMMAND_RUNNER = Object.freeze({
    run(command, args, options) {
        return spawnSync(command, args, options);
    },
    now() {
        return Date.now();
    },
    sleep(milliseconds) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
    },
});

function resolveAuthorityCommandRunner(commandRunner) {
    if (commandRunner === undefined) return DEFAULT_AUTHORITY_COMMAND_RUNNER;
    if (!commandRunner || typeof commandRunner.run !== 'function') {
        fail('PLOINKY_ROUTER_ATTESTATION_INVALID', 'authority helper command runner must be callable');
    }
    return Object.freeze({
        run: commandRunner.run.bind(commandRunner),
        now: typeof commandRunner.now === 'function'
            ? commandRunner.now.bind(commandRunner)
            : DEFAULT_AUTHORITY_COMMAND_RUNNER.now,
        sleep: typeof commandRunner.sleep === 'function'
            ? commandRunner.sleep.bind(commandRunner)
            : DEFAULT_AUTHORITY_COMMAND_RUNNER.sleep,
    });
}

function runBounded(commandRunner, command, args, { timeout = HELPER_TIMEOUT_MS } = {}) {
    let result;
    try {
        result = commandRunner.run(command, args, {
            encoding: 'utf8',
            timeout,
            maxBuffer: MAX_OUTPUT_BYTES,
            killSignal: 'SIGKILL',
        });
    } catch (_) {
        fail('PLOINKY_ROUTER_ATTESTATION_HELPER', 'bounded helper operation failed');
    }
    if (!result || typeof result !== 'object') {
        fail('PLOINKY_ROUTER_ATTESTATION_HELPER', 'bounded helper operation returned no result');
    }
    if (result.error || result.status !== 0) {
        fail(
            'PLOINKY_ROUTER_ATTESTATION_HELPER',
            `bounded helper operation failed (${boundedFailureMetadata(result)})`,
        );
    }
    return String(result.stdout || '').trim();
}

function runStatusBounded(commandRunner, command, args, { timeout = HELPER_TIMEOUT_MS } = {}) {
    let result;
    try {
        result = commandRunner.run(command, args, {
            encoding: 'utf8',
            timeout,
            maxBuffer: MAX_OUTPUT_BYTES,
            killSignal: 'SIGKILL',
        });
    } catch (_) {
        fail('PLOINKY_ROUTER_ATTESTATION_HELPER', 'bounded helper status operation failed');
    }
    if (!result || typeof result !== 'object') {
        fail('PLOINKY_ROUTER_ATTESTATION_HELPER', 'bounded helper status operation returned no result');
    }
    if (result.error || !Number.isInteger(result.status)) {
        fail('PLOINKY_ROUTER_ATTESTATION_HELPER', 'bounded helper status operation failed', result.error);
    }
    return Object.freeze({
        status: result.status,
        stdout: String(result.stdout || '').slice(0, MAX_OUTPUT_BYTES),
        stderr: String(result.stderr || '').slice(0, MAX_OUTPUT_BYTES),
    });
}

function runProcessBounded(command, args, { timeout = HELPER_TIMEOUT_MS } = {}) {
    const result = spawnSync(command, args, {
        encoding: 'utf8',
        timeout,
        maxBuffer: MAX_OUTPUT_BYTES,
        killSignal: 'SIGKILL',
    });
    if (result.error || result.status !== 0) {
        fail(
            'PLOINKY_ROUTER_ATTESTATION_HELPER',
            `bounded helper operation failed (${boundedFailureMetadata(result)})`,
        );
    }
    return String(result.stdout || '').trim();
}

function privateSocketRequest(socketPath, method, requestPath, body = null) {
    const script = String.raw`
const http=require('node:http'); const [socketPath,method,path,body]=process.argv.slice(1);
const bytes=body ? Buffer.from(body) : Buffer.alloc(0);
const req=http.request({socketPath,method,path,headers:bytes.length?{'content-type':'application/json','content-length':bytes.length}:{}},res=>{const chunks=[];let size=0;res.on('data',c=>{size+=c.length;if(size>8192)req.destroy(new Error('response too large'));else chunks.push(c)});res.on('end',()=>process.stdout.write(JSON.stringify({status:res.statusCode,body:Buffer.concat(chunks).toString('utf8')})))});
req.setTimeout(3000,()=>req.destroy(new Error('request timed out')));req.on('error',e=>{process.stderr.write(String(e.message||e));process.exit(1)});req.end(bytes);
`;
    const raw = runProcessBounded(process.execPath, ['-e', script, socketPath, method, requestPath, body || ''], { timeout: REQUEST_TIMEOUT_MS + 1_000 });
    try { return JSON.parse(raw); } catch (error) { fail('PLOINKY_ROUTER_ATTESTATION_REGISTRY', 'private attestation response was malformed', error); }
}

export function createPrivateAuthorityRegistryClient({
    socketPath = process.env.PLOINKY_ROUTER_HEALTH_SOCKET || HEALTH_SOCKET,
    request = privateSocketRequest,
} = {}) {
    if (typeof request !== 'function') {
        fail('PLOINKY_ROUTER_ATTESTATION_INVALID', 'private authority registry request transport must be callable');
    }
    const rejectionDetail = (result) => {
        const status = Number.isInteger(result?.status) ? String(result.status) : 'unknown';
        let code = '';
        try {
            const parsed = JSON.parse(String(result?.body || ''));
            if (typeof parsed?.error === 'string' && /^[A-Z0-9_]{1,128}$/.test(parsed.error)) {
                code = parsed.error;
            }
        } catch (_) {}
        return `HTTP ${status}${code ? ` ${code}` : ''}`;
    };
    return Object.freeze({
        register(nonce, generationLeaseId) {
            const result = request(
                socketPath,
                'POST',
                '/authority-attestations',
                JSON.stringify({ nonce, generationLeaseId }),
            );
            if (result.status !== 201) {
                fail(
                    'PLOINKY_ROUTER_ATTESTATION_REGISTRY',
                    `authority nonce registration failed (${rejectionDetail(result)})`,
                );
            }
        },
        consume(nonce) {
            const result = request(socketPath, 'GET', `/authority-attestations/${nonce}`);
            if (result.status !== 200) {
                let rejectionCode = '';
                try { rejectionCode = String(JSON.parse(String(result?.body || ''))?.error || ''); } catch (_) {}
                fail(
                    result.status === 404 && rejectionCode === 'AUTHORITY_ATTESTATION_NOT_FOUND'
                        ? ROUTER_AUTHORITY_OBSERVATION_EXPIRED
                        : 'PLOINKY_ROUTER_ATTESTATION_REGISTRY',
                    `authority observation consumption failed (${rejectionDetail(result)})`,
                );
            }
            let parsed;
            try { parsed = JSON.parse(result.body); } catch (error) { fail('PLOINKY_ROUTER_ATTESTATION_REGISTRY', 'authority observation response was malformed', error); }
            if (parsed?.ok !== true || parsed?.nonce !== nonce || !Array.isArray(parsed.records)) {
                fail('PLOINKY_ROUTER_ATTESTATION_REGISTRY', 'authority observation response was incomplete');
            }
            return parsed.records;
        },
    });
}

const AUTHORITY_HELPER_INSPECT_FORMAT = String.raw`{"id":{{json .ID}},"name":{{json .Name}},"created":{{json .Created}},"image":{{json .Image}},"user":{{json .Config.User}},"entrypoint":{{json .Config.Entrypoint}},"init":{{json .HostConfig.Init}},"readonlyRootfs":{{json .HostConfig.ReadonlyRootfs}},"pidsLimit":{{json .HostConfig.PidsLimit}},"memory":{{json .HostConfig.Memory}},"nanoCpus":{{json .HostConfig.NanoCpus}},"networkMode":{{json .HostConfig.NetworkMode}},"extraHosts":{{json .HostConfig.ExtraHosts}},"mountCount":{{len .Mounts}},"bindCount":{{len .HostConfig.Binds}},"tmpfsCount":{{len .HostConfig.Tmpfs}},"portBindingCount":{{len .HostConfig.PortBindings}},"capDrop":{{json .HostConfig.CapDrop}},"capAdd":{{json .HostConfig.CapAdd}},"securityOpt":{{json .HostConfig.SecurityOpt}},"env":{{json .Config.Env}},"helperLabel":{{json (index .Config.Labels "io.assistos.ploinky.authority-helper")}},"networks":{{json .NetworkSettings.Networks}},"running":{{json .State.Running}},"status":{{json .State.Status}}}`;

function inspectAuthorityHelper(commandRunner, runtime, id) {
    const raw = runBounded(commandRunner, runtime, [
        'container', 'inspect', '--format', AUTHORITY_HELPER_INSPECT_FORMAT, id,
    ]);
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

function normalizedContainerName(value) {
    return String(value || '').replace(/^\/+/, '');
}

function proveAuthorityHelperIdentity(inspected, {
    expectedId = '',
    expectedName,
    expectedNonce,
    expectedImageId,
    expectedNetworks = null,
    expectedPrimaryNetwork = '',
    expectedHostMapping = '',
    failureCode = 'PLOINKY_ROUTER_ATTESTATION_HELPER',
} = {}) {
    const id = String(inspected?.id || '');
    const name = normalizedContainerName(inspected?.name);
    const helperLabel = String(inspected?.helperLabel || '');
    const inspectedNetworks = Object.keys(inspected?.networks || {}).sort();
    const extraHosts = [...(inspected?.extraHosts || [])].map(String);
    const capDrop = [...(inspected?.capDrop || [])].map((value) => String(value).toUpperCase());
    const capAdd = [...(inspected?.capAdd || [])];
    const securityOpt = [...(inspected?.securityOpt || [])].map(String);
    const helperEnv = [...(inspected?.env || [])].map(String);
    const portableCapDrop = capDrop.length > 0 && capDrop.every((value) => (
        value === 'ALL' || /^CAP_[A-Z0-9_]+$/.test(value)
    ));
    const expectedNetworkList = Array.isArray(expectedNetworks)
        ? [...expectedNetworks].map(String).sort()
        : null;
    const exactNetworkPlan = !expectedNetworkList
        || (JSON.stringify(inspectedNetworks) === JSON.stringify(expectedNetworkList)
            && ['bridge', expectedPrimaryNetwork].includes(String(inspected?.networkMode || ''))
            && extraHosts.length === 1
            && extraHosts[0] === expectedHostMapping);
    const genericNetworkPlan = expectedNetworkList
        || (inspectedNetworks.length > 0
            && extraHosts.length === 1
            && extraHosts[0].startsWith('host.containers.internal:'));

    if (!/^[a-f0-9]{64}$/.test(id)
        || (expectedId && id !== expectedId)
        || name !== expectedName
        || !/^[a-f0-9]{64}$/.test(helperLabel)
        || helperLabel !== expectedNonce
        || String(inspected?.image || '') !== expectedImageId
        || String(inspected?.user || '') !== AUTHORITY_HELPER_USER
        || JSON.stringify(inspected?.entrypoint || []) !== JSON.stringify(['node'])
        || inspected?.init !== true
        || inspected?.readonlyRootfs !== true
        || Number(inspected?.pidsLimit) !== 32
        || Number(inspected?.memory) !== 64 * 1024 * 1024
        || Number(inspected?.nanoCpus) !== 250_000_000
        || Number(inspected?.mountCount) !== 0
        || Number(inspected?.bindCount) !== 0
        || Number(inspected?.tmpfsCount) !== 0
        || Number(inspected?.portBindingCount) !== 0
        || !portableCapDrop
        || capAdd.length !== 0
        || securityOpt.length !== 1
        || !['no-new-privileges', 'no-new-privileges=true'].includes(securityOpt[0])
        || helperEnv.some((entry) => /^(?:PLOINKY_|AUTHORIZATION=|BEARER_)/i.test(entry))
        || !genericNetworkPlan
        || !exactNetworkPlan) {
        fail(failureCode, 'authority helper identity or confinement could not be proven');
    }
    return Object.freeze({ id, name, helperLabel });
}

function removeProvenAuthorityHelper(commandRunner, runtime, expected) {
    let inspected = inspectAuthorityHelper(commandRunner, runtime, expected.expectedId || expected.expectedName);
    const identity = proveAuthorityHelperIdentity(inspected, {
        ...expected,
        failureCode: 'PLOINKY_ROUTER_ATTESTATION_CLEANUP',
    });
    if (inspected.running === true || inspected.status === 'running') {
        runBounded(commandRunner, runtime, ['stop', '--time', '2', identity.id], { timeout: 4_000 });
        inspected = inspectAuthorityHelper(commandRunner, runtime, identity.id);
        proveAuthorityHelperIdentity(inspected, {
            ...expected,
            expectedId: identity.id,
            failureCode: 'PLOINKY_ROUTER_ATTESTATION_CLEANUP',
        });
        if (inspected.running === true || inspected.status === 'running') {
            fail('PLOINKY_ROUTER_ATTESTATION_CLEANUP', 'helper remained running after bounded exact-ID stop');
        }
    }
    runBounded(commandRunner, runtime, ['rm', identity.id], { timeout: 4_000 });
    const exists = runStatusBounded(commandRunner, runtime, ['container', 'exists', identity.id], { timeout: 4_000 });
    const nameExists = runStatusBounded(commandRunner, runtime, ['container', 'exists', expected.expectedName], { timeout: 4_000 });
    if (exists.status !== 1 || nameExists.status !== 1) {
        fail('PLOINKY_ROUTER_ATTESTATION_CLEANUP', 'helper removal was not proven by immutable ID and exact name');
    }
}

function reconcileAuthorityHelperByName(commandRunner, runtime, helperName) {
    for (let attempt = 0; attempt < AUTHORITY_HELPER_RECONCILE_ATTEMPTS; attempt += 1) {
        const named = runStatusBounded(
            commandRunner,
            runtime,
            ['container', 'exists', helperName],
            { timeout: 4_000 },
        );
        if (named.status === 0) return inspectAuthorityHelper(commandRunner, runtime, helperName);
        if (named.status !== 1) {
            fail('PLOINKY_ROUTER_ATTESTATION_CLEANUP', 'helper name reconciliation returned an ambiguous status');
        }
        if (attempt + 1 < AUTHORITY_HELPER_RECONCILE_ATTEMPTS) {
            commandRunner.sleep(AUTHORITY_HELPER_RECONCILE_DELAY_MS);
        }
    }
    return null;
}

function cleanupAuthorityHelper(commandRunner, runtime, helperId, expected) {
    let resolvedId = helperId;
    if (!resolvedId) {
        const inspected = reconcileAuthorityHelperByName(commandRunner, runtime, expected.expectedName);
        if (!inspected) return;
        resolvedId = proveAuthorityHelperIdentity(inspected, {
            ...expected,
            failureCode: 'PLOINKY_ROUTER_ATTESTATION_CLEANUP',
        }).id;
    }
    removeProvenAuthorityHelper(commandRunner, runtime, {
        ...expected,
        expectedId: resolvedId,
    });
}

function reapStaleAuthorityHelpers(commandRunner, runtime, helperImageId) {
    const raw = runBounded(commandRunner, runtime, [
        'ps', '-a', '--no-trunc',
        '--filter', `label=${AUTHORITY_HELPER_LABEL}`,
        '--format', '{{.ID}}',
    ], { timeout: 4_000 });
    const ids = raw.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    for (const id of ids) {
        if (!/^[a-f0-9]{64}$/.test(id)) {
            fail('PLOINKY_ROUTER_ATTESTATION_CLEANUP', 'stale helper listing returned a non-immutable ID');
        }
        const inspected = inspectAuthorityHelper(commandRunner, runtime, id);
        const nonce = String(inspected?.helperLabel || '');
        const expectedName = `${AUTHORITY_HELPER_NAME_PREFIX}${nonce.slice(0, 16)}`;
        proveAuthorityHelperIdentity(inspected, {
            expectedId: id,
            expectedName,
            expectedNonce: nonce,
            expectedImageId: helperImageId,
            failureCode: 'PLOINKY_ROUTER_ATTESTATION_CLEANUP',
        });
        const createdAt = Date.parse(String(inspected?.created || ''));
        if (!Number.isFinite(createdAt) || createdAt > commandRunner.now()) {
            fail('PLOINKY_ROUTER_ATTESTATION_CLEANUP', 'stale helper creation time could not be proven');
        }
        const oldEnough = commandRunner.now() - createdAt
            > ROUTER_AUTHORITY_HELPER_MAX_LIFETIME_MS + AUTHORITY_HELPER_STALE_GRACE_MS;
        // Parallel dependency waves can observe a peer helper after `create`
        // and before `start`.  Age, not transient runtime state, is the proof
        // that a helper is abandoned and therefore eligible for reaping.
        if (!oldEnough) continue;
        removeProvenAuthorityHelper(commandRunner, runtime, {
            expectedId: id,
            expectedName,
            expectedNonce: nonce,
            expectedImageId: helperImageId,
        });
    }
}

export function runContainerAuthorityProbe({
    runtime,
    plan,
    image,
    intent,
    nonce,
    registerObservation,
    consumeObservation,
    commandRunner: commandRunnerInput,
} = {}) {
    if (runtime !== 'podman') fail('PLOINKY_ROUTER_ATTESTATION_UNSUPPORTED', 'container attestation requires verified Podman');
    if (typeof registerObservation !== 'function' || typeof consumeObservation !== 'function') {
        fail('PLOINKY_ROUTER_ATTESTATION_INVALID', 'container attestation requires an exact observation lifecycle');
    }
    const commandRunner = resolveAuthorityCommandRunner(commandRunnerInput);
    const targetImageId = runBounded(commandRunner, runtime, ['image', 'inspect', '--format', '{{.Id}}', image]);
    if (!targetImageId || !/^(sha256:)?[a-f0-9]{64}$/.test(targetImageId)) fail('PLOINKY_ROUTER_ATTESTATION_HELPER', 'actual agent image did not resolve to an immutable image ID');
    const targetImageUser = runBounded(commandRunner, runtime, ['image', 'inspect', '--format', '{{.Config.User}}', targetImageId]);
    const helperImageId = runBounded(commandRunner, runtime, ['image', 'inspect', '--format', '{{.Id}}', ROUTER_AUTHORITY_HELPER_IMAGE]);
    if (!helperImageId || !/^(sha256:)?[a-f0-9]{64}$/.test(helperImageId)) fail('PLOINKY_ROUTER_ATTESTATION_HELPER', 'authority helper image did not resolve to an immutable image ID');
    const helperName = `${AUTHORITY_HELPER_NAME_PREFIX}${nonce.slice(0, 16)}`;
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
    const expectedIdentity = Object.freeze({
        expectedName: helperName,
        expectedNonce: nonce,
        expectedImageId: helperImageId,
        expectedNetworks,
        expectedPrimaryNetwork: primaryNetwork,
        expectedHostMapping,
    });
    reapStaleAuthorityHelpers(commandRunner, runtime, helperImageId);
    let helperId = '';
    try {
        helperId = runBounded(commandRunner, runtime, [
            'create', '--name', helperName,
            '--label', `${AUTHORITY_HELPER_LABEL}=${nonce}`,
            '--init',
            '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
            '--pids-limit', '32', '--memory', '64m', '--cpus', '0.25',
            '--user', AUTHORITY_HELPER_USER,
            '--entrypoint', 'node',
            ...(plan?.args || []),
            ...additionalNetworkArgs,
            helperImageId, '-e', AUTHORITY_HELPER_IDLE_SCRIPT,
        ]);
        if (!/^[a-f0-9]{64}$/.test(helperId)) fail('PLOINKY_ROUTER_ATTESTATION_HELPER', 'helper creation did not return an immutable ID');
        const inspected = inspectAuthorityHelper(commandRunner, runtime, helperId);
        proveAuthorityHelperIdentity(inspected, { ...expectedIdentity, expectedId: helperId });
        // Starting a cold remote Podman container can exceed the Router's
        // deliberately short nonce lifetime. Start the already inspected,
        // idle helper before registration, then execute only the confined live
        // observations inside that window. The probe independently verifies
        // its zero capability bounding/effective sets and no-new-privileges.
        runBounded(commandRunner, runtime, ['start', helperId]);
        const running = inspectAuthorityHelper(commandRunner, runtime, helperId);
        proveAuthorityHelperIdentity(running, { ...expectedIdentity, expectedId: helperId });
        if (running.running !== true || running.status !== 'running') {
            fail('PLOINKY_ROUTER_ATTESTATION_HELPER', 'helper did not enter the exact inspected running state');
        }
        registerObservation();
        const output = runBounded(commandRunner, runtime, [
            'exec', '--user', AUTHORITY_HELPER_USER,
            helperId, 'node', '-e', PROBE_SCRIPT,
            intent.physicalOrigin, firstHost, secondHost, nonce,
        ]);
        consumeObservation();
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
        cleanupAuthorityHelper(commandRunner, runtime, helperId, expectedIdentity);
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
    let lastExpiredError = null;
    for (let attempt = 0; attempt < ROUTER_AUTHORITY_ATTESTATION_MAX_ATTEMPTS; attempt += 1) {
        const nonce = crypto.randomBytes(32).toString('hex');
        let observationState = 'prepared';
        let records = null;
        const registerObservation = () => {
            if (observationState !== 'prepared') {
                fail('PLOINKY_ROUTER_ATTESTATION_INVALID', 'authority observation registration must occur exactly once');
            }
            registryClient.register(nonce, generationLease.id);
            observationState = 'registered';
        };
        const consumeObservation = () => {
            if (observationState !== 'registered') {
                fail('PLOINKY_ROUTER_ATTESTATION_INVALID', 'authority observation consumption must follow registration exactly once');
            }
            records = registryClient.consume(nonce);
            observationState = 'consumed';
            return records;
        };
        try {
            const probe = runProbe({
                intent,
                nonce,
                registerObservation,
                consumeObservation,
            });
            if (observationState !== 'consumed' || !Array.isArray(records)) {
                fail('PLOINKY_ROUTER_ATTESTATION_INVALID', 'authority probe did not complete its exact observation lifecycle');
            }
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
                target: probe.target,
                generationId: generationLease.id,
                observedAtUnixMs: now(),
            });
            return Object.freeze({
                ...intent,
                attestationId: digest(completeEvidence),
                evidence: completeEvidence,
            });
        } catch (error) {
            if (error?.code !== ROUTER_AUTHORITY_OBSERVATION_EXPIRED) throw error;
            lastExpiredError = error;
            if (attempt + 1 >= ROUTER_AUTHORITY_ATTESTATION_MAX_ATTEMPTS) throw error;
            if (typeof generationLease.isCurrent === 'function' && generationLease.isCurrent() !== true) {
                fail('PLOINKY_ROUTER_ATTESTATION_GENERATION', 'edge generation changed before authority observation retry');
            }
        }
    }
    throw lastExpiredError;
}

export default {
    buildRouterAuthorityTopologyIntent,
    validateRouterAuthorityObservation,
    createPrivateAuthorityRegistryClient,
    managedImageUserNamespace,
    ROUTER_AUTHORITY_HELPER_IMAGE,
    runContainerAuthorityProbe,
    attestRouterAuthority,
};
