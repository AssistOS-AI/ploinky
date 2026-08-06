import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

import { PloinkyBoxError } from '../errors.mjs';

const FULL_ID = /^[a-f0-9]{64}$/;
const ENGINE_ID = /^[a-f0-9]{64}$/;
const RESOURCE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const API_VERSION = 'v6.0.1';
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const RAW_STREAM_TYPE = /^application\/vnd\.docker\.raw-stream(?:\s*;|$)/i;
const MULTIPLEXED_STREAM_TYPE = /^application\/vnd\.docker\.multiplexed-stream(?:\s*;|$)/i;
const DEFAULT_DETACH_KEYS = 'ctrl-p,ctrl-q';
const MAX_TERMINAL_DIMENSION = 65_535;
const EXEC_HANDSHAKE_LIMIT = 64 * 1024;
const MAX_EXEC_FRAME_BYTES = 8 * 1024;
const EXEC_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const EXEC_USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u;
const TAR_TYPES = Object.freeze([
    /^application\/x-tar(?:\s*;|$)/i,
    /^application\/octet-stream(?:\s*;|$)/i,
    /^application\/octet(?:\s*;|$)/i,
]);
const SAFE_STOPPED_STATES = new Set(['configured', 'created', 'exited', 'stopped']);
const SAFE_START_STATES = new Set(['configured', 'created', 'exited', 'stopped']);
const LIST_OPTIONS = Object.freeze({
    all: true,
    sync: false,
    size: false,
    namespace: false,
});
const CREATE_KEYS = Object.freeze([
    'Networks',
    'command',
    'dependencyContainers',
    'devices',
    'env',
    'image',
    'image_volume_mode',
    'init',
    'labels',
    'mounts',
    'name',
    'netns',
    'networkOrder',
    'pod',
    'portmappings',
    'privileged',
    'raw_image_name',
    'remove',
    'removeImage',
    'selinux_opts',
    'unmask',
    'user',
    'volumes',
    'work_dir',
]);
const START_PHASES = new Set([
    'candidate-created',
    'predecessor-quiesced',
    'committed',
    'rolling-back',
]);
const MUTATION_PHASES = new Set([
    'candidate-created',
    'predecessor-quiescing',
    'predecessor-quiesced',
    'candidate-started',
    'dependencies-installed',
    'edge-staged',
    'core-started',
    'health-verified',
    'predecessor-deleting',
    'predecessor-deleted',
    'committed',
    'rolling-back',
    'destroying',
    'deletion-ambiguous',
    'retaining-resources',
]);

// This table records the offline audit boundary used by this client.  The
// sources are the official Podman v6.0.2 tag (peeled commit below):
// pkg/api/server/register_{containers,exec,archive,images,volumes}.go,
// pkg/api/handlers/{compat/exec,compat/containers_archive,libpod/containers_create,
// libpod/images,libpod/volumes}.go, libpod/container_{exec,copy_common}.go,
// libpod/runtime_{ctr,volume}.go, and pkg/domain/infra/abi/archive.go.
export const PODMAN_V6_SOURCE_CLOSURE = Object.freeze({
    version: '6.0.2',
    commit: 'b28edb9ad70ce4317dc762ee9ce0a6d081d154e9',
    archiveSha256: '0895a541aeb7aa8e99133ed2b328c1bb40fd397b7c3b01e083396c90e8628756',
    execSources: Object.freeze([
        'pkg/api/server/register_exec.go',
        'pkg/api/handlers/compat/exec.go',
        'libpod/container_exec.go',
        'libpod/oci_conmon_attach_common.go',
        'libpod/oci_conmon_exec_common.go',
        'libpod/oci_conmon_exec_linux.go',
        'libpod/define/container_inspect.go',
        'pkg/bindings/containers/exec.go',
        'pkg/bindings/containers/attach.go',
        'pkg/bindings/containers/types.go',
        'pkg/bindings/containers/types_execstartandattach_options.go',
        'pkg/bindings/containers/types_resizeexectty_options.go',
    ]),
    containers: Object.freeze({
        list: 'List(all=true,sync=false,size=false,namespace=false) skips Container.Sync()',
        create: 'CreateContainer -> CompleteSpec -> MakeContainer -> ExecuteCreate; pull-free raw image, explicit standalone podman network, no pod/dependencies/auto-remove/anonymous image volumes',
        start: 'LookupContainer(exact full ID) -> Start(ctx,true); allowed only with immutable dependencies=[] proof',
        stop: 'LookupContainer(exact full ID) -> StopWithTimeout; timeout=<bounded>&ignore=false and non-auto-remove proof',
        remove: 'Remove(depend=false,force=false,ignore=false,timeout=<bounded>,volumes=false) after stopped proof and followed by sync=false absence proof',
    }),
    exec: Object.freeze({
        create: 'LookupContainer(canonical full ID plus URL-encoded trailing SQL-LIKE sentinel %25) -> ExecCreate; the sentinel selects only the 64-hex ID and cannot equal a source-valid name; sync is confined to the exact selected container',
        start: 'GetExecSessionContainer(exact preflight-bound client-created session) -> ExecHTTPStartAndAttach -> ContainerExecStartAndAttach; lookup returns the session-owning container and only that container is locked/synced before the bounded upgraded stream',
        resize: 'GetExecSessionContainer(exact live bound session) -> ExecResize -> ContainerExecResize with positive uint16 h/w and running=false; lookup returns and syncs only the session-owning container',
        inspect: 'GetExecSessionContainer(exact client-created session) -> ExecSession.Inspect; exact session/container binding without container Inspect(), and lookup returns/syncs only the session-owning container',
        remove: 'GetExecSessionContainer(exact client-created session) -> ExecRemove(force=false) -> ContainerExecRemove; lookup returns and syncs only the session-owning container',
        detach: 'v6.0.2 server detach parsing is read-fragment-sensitive, so the client recognizes the exact local key sequence and accepts detach only after exact Running=true inspection',
    }),
    archive: Object.freeze({
        put: 'LookupContainer(exact full ID) -> CopyFromArchive; mount/sync is confined to the journal-owned target and its immutable named volumes',
    }),
    images: Object.freeze({
        inspect: 'GetImage(exact raw ID) -> libimage Inspect; no libpod container object is loaded or synchronized',
        export: 'ExportImage(exact raw ID,oci-archive,compress=false) -> image ABI Save; no libpod container object is loaded or synchronized',
    }),
    volumes: Object.freeze({
        find: 'ListVolumes with anchored exact name, driver=local, and unique immutable labels filters before Inspect; at most one exact result is accepted',
        create: 'CreateVolume creates one exact named, labelled local volume without container lookup',
        remove: 'RemoveVolume(exact positively-owned known-unused name,force=false) rejects in-use volumes; exact filtered absence is required',
    }),
});

function hostError(message, code = 'PLOINKY_BOX_HOST_TRANSPORT_FAILED', cause) {
    return new PloinkyBoxError(message, { code, cause });
}

function unsupported(operation, detail = 'has no accepted source-closed host transport') {
    return hostError(
        `Podman host ${operation} is unsupported because it ${detail}`,
        'PLOINKY_BOX_HOST_OPERATION_UNSUPPORTED',
    );
}

function exactObject(value) {
    return value !== null
        && typeof value === 'object'
        && !Array.isArray(value)
        && (Object.getPrototypeOf(value) === Object.prototype
            || Object.getPrototypeOf(value) === null);
}

function exactKeys(value, keys) {
    return exactObject(value)
        && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function boundedString(value, label, { allowEmpty = false, maxBytes = 131_072 } = {}) {
    if (typeof value !== 'string'
        || (!allowEmpty && value.length === 0)
        || Buffer.byteLength(value, 'utf8') > maxBytes
        || value.includes('\0')
        || /[\r\n]/u.test(label === 'HTTP path' ? value : '')) {
        throw hostError(`Podman host ${label} is invalid`, 'PLOINKY_BOX_HOST_INPUT_INVALID');
    }
    return value;
}

function fullId(value, label = 'container ID') {
    const id = String(value || '');
    if (!FULL_ID.test(id)) {
        throw hostError(
            `Podman host ${label} must be a full 64-hex immutable ID`,
            'PLOINKY_BOX_HOST_ID_INVALID',
        );
    }
    return id;
}

function boundedInteger(value, label, { minimum = 1, maximum = 600 } = {}) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw hostError(`Podman host ${label} is outside its accepted bounds`, 'PLOINKY_BOX_HOST_INPUT_INVALID');
    }
    return value;
}

function stringArray(value, label, { allowEmpty = true, maxEntries = 4096 } = {}) {
    if (!Array.isArray(value) || value.length > maxEntries || (!allowEmpty && value.length === 0)) {
        throw hostError(`Podman host ${label} must be a bounded string array`, 'PLOINKY_BOX_HOST_INPUT_INVALID');
    }
    return value.map((entry, index) => boundedString(entry, `${label}[${index}]`, { allowEmpty: false }));
}

function stringMap(value, label, { requireNonEmpty = false } = {}) {
    if (!exactObject(value) || (requireNonEmpty && Object.keys(value).length === 0)) {
        throw hostError(`Podman host ${label} must be a plain string map`, 'PLOINKY_BOX_HOST_INPUT_INVALID');
    }
    const entries = Object.entries(value).map(([key, entry]) => [
        boundedString(key, `${label} key`, { maxBytes: 1024 }),
        boundedString(entry, `${label}.${key}`, { allowEmpty: true }),
    ]);
    if (new Set(entries.map(([key]) => key)).size !== entries.length) {
        throw hostError(`Podman host ${label} contains duplicate keys`, 'PLOINKY_BOX_HOST_INPUT_INVALID');
    }
    return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

function canonicalJson(value, label, depth = 0) {
    if (depth > 12) throw hostError(`Podman host ${label} is too deeply nested`);
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') return boundedString(value, label, { allowEmpty: true });
    if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
    if (Array.isArray(value)) {
        if (value.length > 4096) throw hostError(`Podman host ${label} is too large`);
        return value.map((entry, index) => canonicalJson(entry, `${label}[${index}]`, depth + 1));
    }
    if (!exactObject(value) || Object.keys(value).length > 4096) {
        throw hostError(`Podman host ${label} is not canonical JSON`, 'PLOINKY_BOX_HOST_INPUT_INVALID');
    }
    return Object.fromEntries(Object.keys(value).sort().map((key) => [
        boundedString(key, `${label} key`, { maxBytes: 1024 }),
        canonicalJson(value[key], `${label}.${key}`, depth + 1),
    ]));
}

function freeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
    }
    return value;
}

function header(headers, name) {
    if (!headers || typeof headers !== 'object') return '';
    const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
    const value = found?.[1];
    return Array.isArray(value) ? value.join(', ') : String(value || '');
}

function contentTypeMatches(headers, patterns) {
    const observed = header(headers, 'content-type');
    return patterns.some((pattern) => pattern.test(observed));
}

function assertSelectedUnixSocket(socketPath) {
    let stat;
    try {
        stat = fs.lstatSync(socketPath);
    } catch (cause) {
        throw hostError(
            'Selected Podman host Unix socket is unavailable',
            'PLOINKY_BOX_HOST_SOCKET_INVALID',
            cause,
        );
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (!stat.isSocket()
        || stat.isSymbolicLink()
        || (uid !== null && stat.uid !== uid)
        || (stat.mode & 0o777) !== 0o600) {
        throw hostError(
            'Selected Podman host Unix socket is not one private current-user socket',
            'PLOINKY_BOX_HOST_SOCKET_INVALID',
        );
    }
}

function defaultUnixHttpRequest({
    socketPath,
    method,
    path: requestPath,
    headers,
    body,
    timeoutMs,
    maxResponseBytes,
    signal,
}) {
    assertSelectedUnixSocket(socketPath);
    return new Promise((resolve, reject) => {
        let settled = false;
        let deadlineTimer;
        let abortListener;
        const cleanup = () => {
            clearTimeout(deadlineTimer);
            if (abortListener && signal) signal.removeEventListener('abort', abortListener);
        };
        const fail = (error) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error instanceof PloinkyBoxError
                ? error
                : hostError('Podman host Unix-socket request failed', 'PLOINKY_BOX_HOST_REQUEST_FAILED', error));
        };
        const request = http.request({
            socketPath,
            host: 'd',
            method,
            path: requestPath,
            headers,
        }, (response) => {
            const chunks = [];
            let total = 0;
            response.on('data', (chunk) => {
                total += chunk.length;
                if (total > maxResponseBytes) {
                    response.destroy(hostError(
                        'Podman host response exceeded its response limit',
                        'PLOINKY_BOX_HOST_RESPONSE_TOO_LARGE',
                    ));
                    return;
                }
                chunks.push(chunk);
            });
            response.once('error', fail);
            response.once('end', () => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve({
                    statusCode: response.statusCode,
                    headers: response.headers,
                    body: Buffer.concat(chunks, total),
                });
            });
        });
        request.once('error', fail);
        request.setTimeout(timeoutMs, () => request.destroy(hostError(
            `Podman host request timed out after ${timeoutMs}ms`,
            'PLOINKY_BOX_HOST_TIMEOUT',
        )));
        deadlineTimer = setTimeout(() => request.destroy(hostError(
            `Podman host request timed out at its overall deadline of ${timeoutMs}ms`,
            'PLOINKY_BOX_HOST_TIMEOUT',
        )), timeoutMs);
        if (signal) {
            abortListener = () => {
                const error = hostError(
                    'Podman host request was cancelled by its caller',
                    'PLOINKY_BOX_HOST_CANCELLED',
                    signal.reason,
                );
                request.destroy(error);
                fail(error);
            };
            signal.addEventListener('abort', abortListener, { once: true });
            if (signal.aborted) abortListener();
        }
        if (!settled) {
            if (body.length > 0) request.write(body);
            request.end();
        }
    });
}

function execUser(value) {
    const user = boundedString(value, 'exec user', { maxBytes: 1024 });
    if (!EXEC_USER.test(user) || user.toLowerCase() === 'root') {
        throw hostError(
            'Podman host exec user must be explicitly non-privileged',
            'PLOINKY_BOX_HOST_INPUT_INVALID',
        );
    }
    return user;
}

function execCommand(value) {
    if (!Array.isArray(value) || value.length === 0 || value.length > 1024) {
        throw hostError(
            'Podman host exec argv must be one non-empty bounded string array',
            'PLOINKY_BOX_HOST_INPUT_INVALID',
        );
    }
    return value.map((entry, index) => boundedString(
        entry,
        `exec argv[${index}]`,
        { allowEmpty: index > 0 },
    ));
}

function terminalDimension(value, label, { tty }) {
    if (!tty && (value === undefined || value === null || value === 0)) return 0;
    return boundedInteger(value, label, { minimum: 1, maximum: MAX_TERMINAL_DIMENSION });
}

function detachBytes(value, { tty }) {
    if (!tty && (value === '' || value === undefined || value === null)) return Buffer.alloc(0);
    if (value !== DEFAULT_DETACH_KEYS) {
        throw hostError(
            `Podman host exec detach keys must be exactly ${DEFAULT_DETACH_KEYS}`,
            'PLOINKY_BOX_HOST_INPUT_INVALID',
        );
    }
    return Buffer.from([0x10, 0x11]);
}

function inputBuffer(value) {
    if (value === undefined || value === null) return null;
    if (Buffer.isBuffer(value)) return Buffer.from(value);
    if (value instanceof Uint8Array) return Buffer.from(value);
    if (typeof value === 'string') return Buffer.from(value);
    return null;
}

async function writeSocket(socket, bytes) {
    if (bytes.length === 0) return;
    if (!socket.write(bytes)) {
        await new Promise((resolve, reject) => {
            const cleanup = () => {
                socket.off('drain', onDrain);
                socket.off('error', onError);
                socket.off('close', onClose);
            };
            const onDrain = () => {
                cleanup();
                resolve();
            };
            const onError = (error) => {
                cleanup();
                reject(error);
            };
            const onClose = () => {
                cleanup();
                reject(hostError('Podman host exec stdin closed before backpressure drained'));
            };
            socket.once('drain', onDrain);
            socket.once('error', onError);
            socket.once('close', onClose);
        });
    }
}

async function writeSink(sink, bytes) {
    if (bytes.length === 0 || !sink) return;
    if (typeof sink.write !== 'function') {
        throw hostError('Podman host exec output sink is invalid', 'PLOINKY_BOX_HOST_INPUT_INVALID');
    }
    if (!sink.write(bytes)) {
        if (typeof sink.once !== 'function') {
            throw hostError(
                'Podman host exec output sink cannot report bounded backpressure settlement',
                'PLOINKY_BOX_HOST_INPUT_INVALID',
            );
        }
        await new Promise((resolve, reject) => {
            const cleanup = () => {
                sink.off?.('drain', onDrain);
                sink.off?.('error', onError);
                sink.off?.('close', onClose);
            };
            const onDrain = () => {
                cleanup();
                resolve();
            };
            const onError = (error) => {
                cleanup();
                reject(error);
            };
            const onClose = () => {
                cleanup();
                reject(hostError('Podman host exec output sink closed before backpressure drained'));
            };
            sink.once('drain', onDrain);
            sink.once('error', onError);
            sink.once('close', onClose);
        });
    }
}

function createOutputDecoder({ tty, stdout, stderr, maxOutputBytes, activity }) {
    let total = 0;
    let pending = Buffer.alloc(0);
    const account = (size) => {
        total += size;
        if (total > maxOutputBytes) {
            throw hostError(
                'Podman host exec output exceeded its response limit',
                'PLOINKY_BOX_HOST_RESPONSE_TOO_LARGE',
            );
        }
        activity();
    };
    return Object.freeze({
        async push(value) {
            const chunk = Buffer.from(value);
            if (tty) {
                account(chunk.length);
                await writeSink(stdout, chunk);
                return;
            }
            if (chunk.length > 0) pending = Buffer.concat([pending, chunk]);
            while (pending.length >= 8) {
                const stream = pending[0];
                if (![1, 2].includes(stream)
                    || pending[1] !== 0 || pending[2] !== 0 || pending[3] !== 0) {
                    throw hostError('Podman host exec returned an invalid multiplex frame');
                }
                const size = pending.readUInt32BE(4);
                if (size > MAX_EXEC_FRAME_BYTES) {
                    throw hostError(
                        'Podman host exec returned an oversized multiplex frame',
                        'PLOINKY_BOX_HOST_RESPONSE_TOO_LARGE',
                    );
                }
                if (size > maxOutputBytes - total) {
                    throw hostError(
                        'Podman host exec output exceeded its response limit',
                        'PLOINKY_BOX_HOST_RESPONSE_TOO_LARGE',
                    );
                }
                if (pending.length < 8 + size) return;
                const payload = pending.subarray(8, 8 + size);
                pending = pending.subarray(8 + size);
                account(size);
                await writeSink(stream === 1 ? stdout : stderr, payload);
            }
            if (pending.length > maxOutputBytes + 8) {
                throw hostError(
                    'Podman host exec output exceeded its response limit',
                    'PLOINKY_BOX_HOST_RESPONSE_TOO_LARGE',
                );
            }
        },
        finish() {
            if (!tty && pending.length !== 0) {
                throw hostError('Podman host exec returned a truncated multiplex frame');
            }
            return total;
        },
    });
}

function defaultUnixHttpDuplex({
    socketPath,
    method,
    path: requestPath,
    headers,
    body,
    timeoutMs,
    inactivityTimeoutMs,
    maxOutputBytes,
    maxInputBytes,
    maxHandshakeBytes = EXEC_HANDSHAKE_LIMIT,
    tty,
    stdin,
    stdout,
    stderr,
    detachSequence,
    signal,
    onUpgraded,
}) {
    assertSelectedUnixSocket(socketPath);
    return new Promise((resolve, reject) => {
        let settled = false;
        let upgradedSocket = null;
        let overallTimer = null;
        let inactivityTimer = null;
        let signalListener = null;
        let localDetach = false;

        const cleanup = () => {
            clearTimeout(overallTimer);
            clearTimeout(inactivityTimer);
            if (signalListener && signal) signal.removeEventListener('abort', signalListener);
        };
        const settle = (error, result) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (error) reject(error instanceof PloinkyBoxError
                ? error
                : hostError('Podman host upgraded exec request failed', 'PLOINKY_BOX_HOST_REQUEST_FAILED', error));
            else resolve(result);
        };
        const fail = (error) => {
            upgradedSocket?.destroy();
            request.destroy();
            settle(error);
        };
        const resetInactivity = () => {
            clearTimeout(inactivityTimer);
            inactivityTimer = setTimeout(() => fail(hostError(
                `Podman host exec stream was inactive for ${inactivityTimeoutMs}ms`,
                'PLOINKY_BOX_HOST_TIMEOUT',
            )), inactivityTimeoutMs);
        };
        const request = http.request({
            socketPath,
            host: 'd',
            method,
            path: requestPath,
            headers,
        });

        request.once('response', (response) => {
            const chunks = [];
            let total = 0;
            response.on('data', (chunk) => {
                total += chunk.length;
                if (total > maxHandshakeBytes) {
                    response.destroy(hostError(
                        'Podman host exec upgrade error body exceeded its response limit',
                        'PLOINKY_BOX_HOST_RESPONSE_TOO_LARGE',
                    ));
                    return;
                }
                chunks.push(chunk);
            });
            response.once('error', (error) => settle(error));
            response.once('end', () => settle(hostError(
                `Podman host exec attach returned HTTP ${response.statusCode}, not 101 Upgrade: ${Buffer.concat(chunks, total).toString('utf8')}`,
            )));
        });
        request.once('upgrade', (response, socket, head) => {
            upgradedSocket = socket;
            try {
                if (response.statusCode !== 101
                    || !/^upgrade$/i.test(header(response.headers, 'connection').trim())
                    || !/^tcp$/i.test(header(response.headers, 'upgrade').trim())
                    || !(tty ? RAW_STREAM_TYPE : MULTIPLEXED_STREAM_TYPE)
                        .test(header(response.headers, 'content-type'))) {
                    throw hostError('Podman host exec attach returned an invalid upgrade response');
                }
            } catch (error) {
                fail(error);
                return;
            }

            resetInactivity();
            const decoder = createOutputDecoder({
                tty,
                stdout,
                stderr,
                maxOutputBytes,
                activity: resetInactivity,
            });

            const consume = (async () => {
                try {
                    if (head.length > 0) await decoder.push(head);
                    for await (const chunk of socket) await decoder.push(chunk);
                    decoder.finish();
                } catch (error) {
                    if (!localDetach) throw error;
                }
            })();

            const pump = new Promise((pumpResolve, pumpReject) => {
                let inputBytes = 0;
                let detachOffset = 0;
                let pending = [];
                let queue = Promise.resolve();
                let inputDone = false;
                const buffered = inputBuffer(stdin);
                const stream = buffered === null ? stdin : null;
                const detach = Buffer.from(detachSequence || Buffer.alloc(0));

                const flushPending = async () => {
                    if (pending.length > 0) {
                        await writeSocket(socket, Buffer.from(pending));
                        pending = [];
                    }
                    detachOffset = 0;
                };
                const send = async (value) => {
                    const size = Buffer.byteLength(value);
                    if (size > maxInputBytes - inputBytes) {
                        throw hostError(
                            'Podman host exec stdin exceeded its input limit',
                            'PLOINKY_BOX_HOST_INPUT_INVALID',
                        );
                    }
                    const bytes = Buffer.from(value);
                    inputBytes += size;
                    resetInactivity();
                    if (detach.length === 0) {
                        await writeSocket(socket, bytes);
                        return;
                    }
                    for (const byte of bytes) {
                        if (byte === detach[detachOffset]) {
                            pending.push(byte);
                            detachOffset += 1;
                            if (detachOffset === detach.length) {
                                localDetach = true;
                                pending = [];
                                socket.destroy();
                                return;
                            }
                            continue;
                        }
                        await flushPending();
                        if (byte === detach[0]) {
                            pending.push(byte);
                            detachOffset = 1;
                        } else {
                            await writeSocket(socket, Buffer.of(byte));
                        }
                    }
                };
                const finishInput = async () => {
                    if (inputDone || localDetach) return;
                    inputDone = true;
                    await flushPending();
                    socket.end();
                };
                const closePump = () => {
                    stream?.off?.('data', onData);
                    stream?.off?.('end', onEnd);
                    stream?.off?.('error', onError);
                    pumpResolve();
                };
                const onData = (chunk) => {
                    stream.pause?.();
                    queue = queue.then(() => send(chunk)).then(() => {
                        if (!localDetach) stream.resume?.();
                    });
                    queue.catch(pumpReject);
                };
                const onEnd = () => {
                    queue = queue.then(finishInput);
                    queue.then(closePump, pumpReject);
                };
                const onError = (error) => pumpReject(error);
                socket.once('close', closePump);

                if (buffered !== null) {
                    queue = queue.then(() => send(buffered)).then(finishInput);
                    queue.then(closePump, pumpReject);
                } else if (!stream) {
                    queue = queue.then(finishInput);
                    queue.then(closePump, pumpReject);
                } else if (typeof stream.on !== 'function') {
                    pumpReject(hostError(
                        'Podman host exec stdin is not a supported bounded stream',
                        'PLOINKY_BOX_HOST_INPUT_INVALID',
                    ));
                } else {
                    stream.on('data', onData);
                    stream.once('end', onEnd);
                    stream.once('error', onError);
                    stream.resume?.();
                }
            });

            try {
                onUpgraded?.();
            } catch (error) {
                fail(error);
                return;
            }
            Promise.all([consume, pump]).then(() => settle(null, {
                statusCode: response.statusCode,
                headers: response.headers,
                detached: localDetach,
            }), fail);
        });
        request.once('error', (error) => settle(error));
        request.setTimeout(timeoutMs, () => fail(hostError(
            `Podman host exec upgrade handshake timed out after ${timeoutMs}ms`,
            'PLOINKY_BOX_HOST_TIMEOUT',
        )));
        overallTimer = setTimeout(() => fail(hostError(
            `Podman host exec stream timed out at its overall deadline of ${timeoutMs}ms`,
            'PLOINKY_BOX_HOST_TIMEOUT',
        )), timeoutMs);
        if (signal) {
            signalListener = () => fail(hostError(
                'Podman host exec stream was cancelled by its caller',
                'PLOINKY_BOX_HOST_CANCELLED',
                signal.reason,
            ));
            signal.addEventListener('abort', signalListener, { once: true });
            if (signal.aborted) signalListener();
        }
        if (!settled) request.end(body);
    });
}

async function defaultUnixHttpStreamToFile({
    socketPath,
    method,
    path: requestPath,
    headers,
    body,
    timeoutMs,
    maxResponseBytes,
    destinationPath,
}) {
    assertSelectedUnixSocket(socketPath);
    const handle = await fs.promises.open(destinationPath, 'wx', 0o600);
    try {
        return await new Promise((resolve, reject) => {
            let settled = false;
            let deadlineTimer;
            const fail = (error) => {
                if (settled) return;
                settled = true;
                clearTimeout(deadlineTimer);
                reject(error instanceof PloinkyBoxError
                    ? error
                    : hostError('Podman host streaming request failed', 'PLOINKY_BOX_HOST_REQUEST_FAILED', error));
            };
            const request = http.request({
                socketPath,
                host: 'd',
                method,
                path: requestPath,
                headers,
            }, (response) => {
                (async () => {
                    if (response.statusCode !== 200) {
                        response.resume();
                        throw hostError(`Podman host image export returned HTTP ${response.statusCode}`);
                    }
                    if (!contentTypeMatches(response.headers, TAR_TYPES)) {
                        response.resume();
                        throw hostError('Podman host image export returned an invalid content-type');
                    }
                    let total = 0;
                    for await (const chunk of response) {
                        total += chunk.length;
                        if (total > maxResponseBytes) {
                            response.destroy();
                            throw hostError(
                                'Podman host image export exceeded its response limit',
                                'PLOINKY_BOX_HOST_RESPONSE_TOO_LARGE',
                            );
                        }
                        await handle.write(chunk);
                    }
                    await handle.sync();
                    if (total === 0) throw hostError('Podman host image export returned an empty archive');
                    if (!settled) {
                        settled = true;
                        clearTimeout(deadlineTimer);
                        resolve({
                            statusCode: response.statusCode,
                            headers: response.headers,
                            bytesWritten: total,
                        });
                    }
                })().catch(fail);
            });
            request.once('error', fail);
            request.setTimeout(timeoutMs, () => request.destroy(hostError(
                `Podman host image export timed out after ${timeoutMs}ms`,
                'PLOINKY_BOX_HOST_TIMEOUT',
            )));
            deadlineTimer = setTimeout(() => request.destroy(hostError(
                `Podman host image export timed out at its overall deadline of ${timeoutMs}ms`,
                'PLOINKY_BOX_HOST_TIMEOUT',
            )), timeoutMs);
            if (body.length > 0) request.write(body);
            request.end();
        });
    } finally {
        await handle.close();
    }
}

function tarOctal(value, width, label) {
    const encoded = value.toString(8).padStart(width - 1, '0');
    if (encoded.length !== width - 1) {
        throw hostError(`Podman host archive ${label} does not fit the ustar field`);
    }
    return `${encoded}\0`;
}

function singleFileUstarHeader(name, size) {
    const fileName = boundedString(name, 'archive file name', { maxBytes: 100 });
    if (!RESOURCE_NAME.test(fileName) || path.posix.basename(fileName) !== fileName) {
        throw hostError('Podman host archive file name must be one safe basename');
    }
    const header = Buffer.alloc(512);
    header.write(fileName, 0, 100, 'utf8');
    header.write(tarOctal(0o644, 8, 'mode'), 100, 8, 'ascii');
    header.write(tarOctal(0, 8, 'uid'), 108, 8, 'ascii');
    header.write(tarOctal(0, 8, 'gid'), 116, 8, 'ascii');
    header.write(tarOctal(size, 12, 'size'), 124, 12, 'ascii');
    header.write(tarOctal(0, 12, 'mtime'), 136, 12, 'ascii');
    header.fill(0x20, 148, 156);
    header[156] = '0'.charCodeAt(0);
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    header.write('root', 265, 32, 'ascii');
    header.write('root', 297, 32, 'ascii');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    const checksumText = checksum.toString(8).padStart(6, '0');
    if (checksumText.length !== 6) throw hostError('Podman host archive checksum overflowed');
    header.write(`${checksumText}\0 `, 148, 8, 'ascii');
    return header;
}

function defaultUnixHttpPutFileArchive({
    socketPath,
    method,
    path: requestPath,
    headers,
    timeoutMs,
    maxResponseBytes,
    sourceHandle,
    sourceSize,
    archiveName,
}) {
    assertSelectedUnixSocket(socketPath);
    return new Promise((resolve, reject) => {
        let settled = false;
        let deadlineTimer;
        const fail = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(deadlineTimer);
            reject(error instanceof PloinkyBoxError
                ? error
                : hostError('Podman host file archive request failed', 'PLOINKY_BOX_HOST_REQUEST_FAILED', error));
        };
        const request = http.request({
            socketPath,
            host: 'd',
            method,
            path: requestPath,
            headers,
        }, (response) => {
            const chunks = [];
            let total = 0;
            response.on('data', (chunk) => {
                total += chunk.length;
                if (total > maxResponseBytes) {
                    response.destroy(hostError(
                        'Podman host file archive response exceeded its response limit',
                        'PLOINKY_BOX_HOST_RESPONSE_TOO_LARGE',
                    ));
                    return;
                }
                chunks.push(chunk);
            });
            response.once('error', fail);
            response.once('end', () => {
                if (settled) return;
                settled = true;
                clearTimeout(deadlineTimer);
                resolve({
                    statusCode: response.statusCode,
                    headers: response.headers,
                    body: Buffer.concat(chunks, total),
                });
            });
        });
        request.once('error', fail);
        request.setTimeout(timeoutMs, () => request.destroy(hostError(
            `Podman host file archive request timed out after ${timeoutMs}ms`,
            'PLOINKY_BOX_HOST_TIMEOUT',
        )));
        deadlineTimer = setTimeout(() => request.destroy(hostError(
            `Podman host file archive request timed out at its overall deadline of ${timeoutMs}ms`,
            'PLOINKY_BOX_HOST_TIMEOUT',
        )), timeoutMs);
        (async () => {
            request.write(singleFileUstarHeader(archiveName, sourceSize));
            for await (const chunk of sourceHandle.createReadStream({ autoClose: false })) {
                if (!request.write(chunk)) await new Promise((resume) => request.once('drain', resume));
            }
            const padding = (512 - (sourceSize % 512)) % 512;
            if (padding > 0) request.write(Buffer.alloc(padding));
            request.end(Buffer.alloc(1024));
        })().catch((error) => request.destroy(error));
    });
}

function validateTransportResult(result, maxResponseBytes) {
    if (!exactObject(result)
        || !Number.isSafeInteger(result.statusCode)
        || result.statusCode < 100
        || result.statusCode > 599
        || !exactObject(result.headers)
        || !Buffer.isBuffer(result.body)) {
        throw hostError('Podman host transport returned an invalid response envelope');
    }
    if (result.body.length > maxResponseBytes) {
        throw hostError(
            'Podman host response exceeded its response limit',
            'PLOINKY_BOX_HOST_RESPONSE_TOO_LARGE',
        );
    }
    return result;
}

function parseJsonResponse(result, status, label) {
    if (result.statusCode !== status) {
        throw hostError(`Podman host ${label} returned HTTP ${result.statusCode}`);
    }
    if (!contentTypeMatches(result.headers, [JSON_TYPE])) {
        throw hostError(`Podman host ${label} returned an invalid content-type`);
    }
    let parsed;
    try {
        parsed = JSON.parse(result.body.toString('utf8'));
    } catch (error) {
        throw hostError(`Podman host ${label} returned malformed JSON`, 'PLOINKY_BOX_HOST_SCHEMA_INVALID', error);
    }
    return parsed;
}

function requireEmptyResponse(result, status, label, { allowNewline = false } = {}) {
    if (result.statusCode !== status) {
        throw hostError(`Podman host ${label} returned HTTP ${result.statusCode}`);
    }
    if (result.body.length !== 0 && !(allowNewline && /^\r?\n$/u.test(result.body.toString()))) {
        throw hostError(`Podman host ${label} returned an unexpected response body`);
    }
}

function validateContainerRecord(value, index) {
    if (!exactObject(value)) throw hostError(`Podman host container list record ${index} is invalid`);
    const id = fullId(value.Id ?? value.ID, `container list record ${index} ID`);
    if (!Array.isArray(value.Names)
        || value.Names.length === 0
        || value.Names.some((name) => typeof name !== 'string' || name.length === 0)) {
        throw hostError(`Podman host container list record ${index} has invalid names`);
    }
    const state = String(value.State ?? value.state ?? '').toLowerCase();
    if (!['configured', 'created', 'dead', 'exited', 'paused', 'removing', 'running', 'stopped'].includes(state)) {
        throw hostError(`Podman host container list record ${index} has an invalid state`);
    }
    if (typeof value.AutoRemove !== 'boolean') {
        throw hostError(`Podman host container list record ${index} lacks auto-remove state`);
    }
    stringMap(value.Labels ?? {}, `container list record ${index} labels`);
    return freeze({ ...value, Id: id });
}

function validateVolumeRecord(value, index) {
    if (!exactObject(value) || !RESOURCE_NAME.test(String(value.Name || ''))) {
        throw hostError(`Podman host volume list record ${index} is invalid`);
    }
    if (value.Driver !== undefined && value.Driver !== 'local') {
        throw hostError(`Podman host volume list record ${index} has an unsupported driver`);
    }
    stringMap(value.Labels ?? {}, `volume list record ${index} labels`);
    if (value.MountCount !== undefined
        && (!Number.isSafeInteger(value.MountCount) || value.MountCount < 0)) {
        throw hostError(`Podman host volume list record ${index} has an invalid mount count`);
    }
    return freeze({ ...value });
}

function exactStringMap(left, right) {
    return JSON.stringify(Object.fromEntries(Object.entries(left).sort()))
        === JSON.stringify(Object.fromEntries(Object.entries(right).sort()));
}

function exactVolumeFilter(name, labels) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    return JSON.stringify({
        name: [`^${escapedName}$`],
        driver: ['local'],
        label: Object.entries(labels).map(([key, value]) => `${key}=${value}`),
    });
}

function validateCreateSpec(value) {
    if (!exactKeys(value, CREATE_KEYS)) {
        throw hostError('Podman host create spec has an invalid or unsupported key set');
    }
    const spec = canonicalJson(value, 'create spec');
    if (!RESOURCE_NAME.test(spec.name)) throw hostError('Podman host create spec has an invalid exact name');
    fullId(spec.image, 'create image ID');
    if (spec.raw_image_name !== spec.image) {
        throw hostError('Podman host create spec must use the same immutable raw image ID');
    }
    if (spec.remove !== false) throw hostError('Podman host create spec must disable auto-remove');
    if (spec.removeImage !== false) throw hostError('Podman host create spec must disable implicit image removal');
    if (spec.privileged !== false) throw hostError('Podman host create spec must be unprivileged');
    if (spec.init !== true) throw hostError('Podman host create spec must enable init');
    if (spec.pod !== '') throw hostError('Podman host create spec must be standalone without a pod');
    if (!Array.isArray(spec.dependencyContainers) || spec.dependencyContainers.length !== 0) {
        throw hostError('Podman host create spec must be standalone with no dependencies');
    }
    if (spec.image_volume_mode !== 'ignore') {
        throw hostError('Podman host create spec must forbid implicit anonymous image volumes');
    }
    stringArray(spec.command, 'create command');
    stringMap(spec.env, 'create environment', { requireNonEmpty: true });
    stringMap(spec.labels, 'create labels', { requireNonEmpty: true });
    boundedString(spec.user, 'create user');
    if (!path.posix.isAbsolute(boundedString(spec.work_dir, 'create working directory'))) {
        throw hostError('Podman host create working directory must be absolute');
    }
    if (!Array.isArray(spec.mounts) || spec.mounts.length === 0
        || !Array.isArray(spec.volumes) || spec.volumes.length === 0
        || !Array.isArray(spec.devices) || spec.devices.length === 0
        || !Array.isArray(spec.portmappings) || spec.portmappings.length === 0) {
        throw hostError('Podman host create spec has an incomplete immutable resource tuple');
    }
    for (const [index, volume] of spec.volumes.entries()) {
        if (!exactObject(volume)
            || !RESOURCE_NAME.test(String(volume.Name || ''))
            || volume.IsAnonymous !== false
            || typeof volume.Dest !== 'string'
            || !path.posix.isAbsolute(volume.Dest)
            || !Array.isArray(volume.Options)) {
            throw hostError(`Podman host create spec volume ${index} is invalid or anonymous`);
        }
    }
    for (const [index, mount] of spec.mounts.entries()) {
        if (!exactObject(mount)
            || !path.posix.isAbsolute(String(mount.destination || ''))
            || !['bind', 'tmpfs'].includes(mount.type)
            || !Array.isArray(mount.options)) {
            throw hostError(`Podman host create spec mount ${index} is invalid`);
        }
    }
    const acceptedDevices = new Set([
        '/dev/fuse:/dev/fuse:rwm',
        '/dev/net/tun:/dev/net/tun:rwm',
    ]);
    for (const [index, device] of spec.devices.entries()) {
        if (!exactKeys(device, ['path']) || !acceptedDevices.has(String(device.path || ''))) {
            throw hostError(`Podman host create spec device ${index} is invalid`);
        }
    }
    if (spec.devices.length !== acceptedDevices.size
        || new Set(spec.devices.map((device) => device.path)).size !== acceptedDevices.size) {
        throw hostError('Podman host create spec must contain the exact immutable device set');
    }
    for (const [index, port] of spec.portmappings.entries()) {
        if (!exactObject(port)
            || !['tcp', 'udp'].includes(port.protocol)
            || !Number.isSafeInteger(port.host_port)
            || !Number.isSafeInteger(port.container_port)
            || port.host_port < 1 || port.host_port > 65535
            || port.container_port < 1 || port.container_port > 65535
            || port.range !== 1
            || !['127.0.0.1', '0.0.0.0'].includes(port.host_ip)) {
            throw hostError(`Podman host create spec port mapping ${index} is invalid`);
        }
    }
    if (!exactObject(spec.netns) || spec.netns.nsmode !== 'bridge' || Object.keys(spec.netns).length !== 1) {
        throw hostError('Podman host create spec must use an exact standalone bridge network');
    }
    if (!exactKeys(spec.Networks, ['podman'])
        || !exactObject(spec.Networks.podman)
        || Object.keys(spec.Networks.podman).length !== 0
        || !Array.isArray(spec.networkOrder)
        || spec.networkOrder.length !== 1
        || spec.networkOrder[0] !== 'podman') {
        throw hostError('Podman host create spec must use only the explicit immutable podman network');
    }
    if (!Array.isArray(spec.unmask) || !spec.unmask.includes('ALL')) {
        throw hostError('Podman host create spec must retain the immutable unmask policy');
    }
    return spec;
}

function selectedJournalContainer(journal, id) {
    if (journal?.container?.id === id) return { kind: 'candidate', value: journal.container };
    if (journal?.predecessor?.id === id) return { kind: 'predecessor', value: journal.predecessor.container };
    throw hostError('Podman host mutation ID does not match its exact ownership journal');
}

function proveArchiveDestination(creation, destination) {
    const names = new Set(Array.isArray(creation?.volumes) ? creation.volumes : []);
    const mounts = Array.isArray(creation?.mounts) ? creation.mounts : [];
    const ownedMount = mounts.find((mount) => {
        if (!exactObject(mount) || mount.type !== 'volume') return false;
        const volumeName = String(mount.name || mount.source || '');
        const mountPoint = String(mount.destination || '');
        if (!names.has(volumeName) || !path.posix.isAbsolute(mountPoint)) return false;
        const relative = path.posix.relative(mountPoint, destination);
        return relative === ''
            || (relative !== '..' && !relative.startsWith('../') && !path.posix.isAbsolute(relative));
    });
    if (!ownedMount) {
        throw hostError('Podman host archive destination is not inside a journaled exact named volume');
    }
}

function journalProof(client, journal, id, operation) {
    const targetId = fullId(id);
    if (!exactObject(journal)
        || !exactObject(journal.transaction)
        || !FULL_ID.test(String(journal.transaction.generation || ''))
        || typeof journal.transaction.id !== 'string'
        || journal.transaction.id.length === 0
        || typeof journal.phase !== 'string') {
        throw hostError('Podman host mutation requires an exact-generation ownership journal');
    }
    const selected = selectedJournalContainer(journal, targetId);
    const creation = selected.value?.creation;
    if (!exactObject(creation)
        || !Array.isArray(creation.dependencies)
        || creation.dependencies.length !== 0) {
        throw hostError('Podman host mutation rejects journaled container dependencies');
    }
    if (creation.autoRemove !== false) {
        throw hostError('Podman host mutation rejects an auto-remove journal target');
    }
    if (!RESOURCE_NAME.test(String(selected.value?.name || ''))
        || !exactObject(selected.value?.labels)
        || !exactObject(selected.value?.image)) {
        throw hostError('Podman host mutation journal lacks immutable name/labels/image identity');
    }
    const labels = stringMap(selected.value.labels, 'journal container labels', { requireNonEmpty: true });
    const imageId = fullId(selected.value.image.rawId, 'journal image ID');
    const engine = journal.engine;
    if (!exactObject(engine)
        || engine.name !== 'podman'
        || engine.identity !== client.identity.engineIdentity
        || engine.apiVersion !== client.identity.apiVersion
        || engine.hostKind !== client.identity.hostKind
        || !exactObject(engine.connection)
        || engine.connection.name !== client.identity.connectionIdentity
        || engine.connection.identity !== client.identity.connectionIdentity
        || engine.connection.uri !== client.identity.connectionUri
        || engine.connection.socketPath !== client.identity.socketPath) {
        throw hostError('Podman host mutation journal engine/socket identity does not match the selected client');
    }
    const phases = operation === 'start' ? START_PHASES : MUTATION_PHASES;
    if (!phases.has(journal.phase)) {
        throw hostError(`Podman host ${operation} rejects journal phase ${journal.phase || '<missing>'}`);
    }
    if (operation === 'start' && selected.kind === 'predecessor'
        && journal.phase !== 'rolling-back') {
        throw hostError('Podman host predecessor start is allowed only during exact rollback restoration');
    }
    return {
        id: targetId,
        creation,
        kind: selected.kind,
        name: selected.value.name,
        labels,
        imageId,
    };
}

function validateJournalContainerRecord(record, proof) {
    if (!record) return null;
    const names = record.Names.map((name) => name.replace(/^\//u, ''));
    const observedImage = String(record.ImageID ?? '').replace(/^sha256:/u, '');
    if (names.length !== 1
        || names[0] !== proof.name
        || observedImage !== proof.imageId
        || !exactStringMap(record.Labels ?? {}, proof.labels)
        || record.AutoRemove !== false) {
        throw hostError('Podman host list record does not match the exact journal name/labels/image identity');
    }
    return record;
}

function execLookupResource(containerId) {
    // Gorilla preserves `%25`; GetName decodes it once to `%`. Podman v6.0.2
    // then queries Name='<id>%' OR ID LIKE '<id>%%'. Canonical IDs are exactly
    // 64 hex characters and `%` is forbidden by the libpod name grammar, so the
    // token cannot be captured by the exact-name precedence in LookupContainer.
    return `/containers/${fullId(containerId)}%25/exec`;
}

function validateExecInspection(value, {
    sessionId,
    containerId,
    command,
    user,
    tty,
    attachStdin,
    phase,
}) {
    if (!exactObject(value)
        || value.ID !== sessionId
        || value.ContainerID !== containerId
        || typeof value.Running !== 'boolean'
        || !Number.isSafeInteger(value.ExitCode)
        || !Number.isSafeInteger(value.Pid)
        || typeof value.CanRemove !== 'boolean'
        || value.OpenStdin !== attachStdin
        || value.OpenStdout !== true
        || value.OpenStderr !== true
        || !exactObject(value.ProcessConfig)
        || value.ProcessConfig.entrypoint !== command[0]
        || (command.length === 1
            ? value.ProcessConfig.arguments !== null
            : (!Array.isArray(value.ProcessConfig.arguments)
                || JSON.stringify(value.ProcessConfig.arguments) !== JSON.stringify(command.slice(1))))
        || value.ProcessConfig.privileged !== false
        || value.ProcessConfig.tty !== tty
        || value.ProcessConfig.user !== user) {
        throw hostError(`Podman host exec ${phase} inspection did not prove the exact session binding`);
    }
    return value;
}

function collectingSink(chunks) {
    return Object.freeze({
        write(value) {
            chunks.push(Buffer.from(value));
            return true;
        },
    });
}

export class PodmanHostClient {
    #requestImpl;
    #duplexImpl;
    #execEvidenceStore;
    #streamImpl;
    #putFileArchiveImpl;

    constructor({
        engine,
        socketPath = engine?.connection?.socketPath,
        engineIdentity = engine?.identity,
        connectionIdentity = engine?.connection?.identity ?? engine?.connection?.name,
        connectionUri = engine?.connection?.uri,
        hostKind = engine?.hostKind,
        apiVersion = engine?.apiVersion ?? API_VERSION,
        timeoutMs = 10_000,
        maxResponseBytes = 4 * 1024 * 1024,
        maxRequestBytes = 32 * 1024 * 1024,
        maxArchiveBytes = 2 ** 31 - 1,
        requestImpl = defaultUnixHttpRequest,
        duplexImpl = defaultUnixHttpDuplex,
        execEvidenceStore = null,
        streamImpl = defaultUnixHttpStreamToFile,
        putFileArchiveImpl = defaultUnixHttpPutFileArchive,
    } = {}) {
        if (!path.isAbsolute(String(socketPath || '')) || String(socketPath).includes('\0')) {
            throw hostError('Podman host socket identity must be an absolute Unix-socket path');
        }
        if (!ENGINE_ID.test(String(engineIdentity || ''))) {
            throw hostError('Podman host engine identity must be a full 64-hex value');
        }
        boundedString(connectionIdentity, 'connection identity', { maxBytes: 4096 });
        boundedString(connectionUri, 'connection URI', { maxBytes: 16_384 });
        if (!['native-linux', 'podman-machine'].includes(hostKind)) {
            throw hostError('Podman host kind must be exactly native-linux or podman-machine');
        }
        if (apiVersion !== API_VERSION) {
            throw hostError(`Podman host API version must be exactly ${API_VERSION}`);
        }
        this.timeoutMs = boundedInteger(timeoutMs, 'request timeout', { minimum: 1, maximum: 1_800_000 });
        this.maxResponseBytes = boundedInteger(maxResponseBytes, 'response limit', { minimum: 1, maximum: 2 ** 31 - 1 });
        this.maxRequestBytes = boundedInteger(maxRequestBytes, 'request limit', { minimum: 1, maximum: 2 ** 31 - 1 });
        this.maxArchiveBytes = boundedInteger(maxArchiveBytes, 'archive response limit', { minimum: 1, maximum: 2 ** 31 - 1 });
        if (typeof requestImpl !== 'function'
            || typeof duplexImpl !== 'function'
            || typeof streamImpl !== 'function'
            || typeof putFileArchiveImpl !== 'function') {
            throw hostError('Podman host transport implementations must be functions');
        }
        if (execEvidenceStore !== null
            && (!exactObject(execEvidenceStore)
                || ['begin', 'created', 'retain', 'removed'].some((name) => (
                    typeof execEvidenceStore[name] !== 'function'
                )))) {
            throw hostError('Podman host exec evidence store is invalid');
        }
        this.#requestImpl = requestImpl;
        this.#duplexImpl = duplexImpl;
        this.#execEvidenceStore = execEvidenceStore;
        this.#streamImpl = streamImpl;
        this.#putFileArchiveImpl = putFileArchiveImpl;
        this.identity = freeze({
            engine: 'podman',
            engineIdentity: String(engineIdentity),
            connectionIdentity,
            connectionUri,
            socketPath: String(socketPath),
            hostKind,
            apiVersion,
        });
    }

    #apiPath(resource) {
        if (typeof resource !== 'string' || !resource.startsWith('/') || /[\r\n\0]/u.test(resource)) {
            throw hostError('Podman host HTTP path is invalid');
        }
        return `/${this.identity.apiVersion}/libpod${resource}`;
    }

    async #request(method, resource, {
        body = Buffer.alloc(0),
        contentType,
        maxResponseBytes = this.maxResponseBytes,
        timeoutMs = this.timeoutMs,
        signal,
    } = {}) {
        if (!Buffer.isBuffer(body) || body.length > this.maxRequestBytes) {
            throw hostError('Podman host request body exceeded its request limit');
        }
        const headers = {
            Accept: 'application/json',
            ...(contentType ? { 'Content-Type': contentType } : {}),
            ...(body.length > 0 ? { 'Content-Length': String(body.length) } : {}),
        };
        const result = await this.#requestImpl({
            socketPath: this.identity.socketPath,
            method,
            path: this.#apiPath(resource),
            headers,
            body,
            timeoutMs,
            maxResponseBytes,
            signal,
        });
        return validateTransportResult(result, maxResponseBytes);
    }

    async #requestJson(method, resource, body, status, label, options = {}) {
        const encoded = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
        return parseJsonResponse(await this.#request(method, resource, {
            body: encoded,
            contentType: body === undefined ? undefined : 'application/json',
            ...options,
        }), status, label);
    }

    async listContainers(options = LIST_OPTIONS) {
        if (!exactKeys(options, Object.keys(LIST_OPTIONS))
            || options.all !== true
            || options.sync !== false
            || options.size !== false
            || options.namespace !== false) {
            throw hostError('Podman host container discovery requires exactly all=true and sync=false with size/namespace disabled');
        }
        const parsed = await this.#requestJson(
            'GET',
            '/containers/json?all=true&sync=false&size=false&namespace=false',
            undefined,
            200,
            'container list',
        );
        if (!Array.isArray(parsed)) throw hostError('Podman host container list schema must be an array');
        const records = parsed.map(validateContainerRecord);
        const ids = records.map((entry) => entry.Id);
        if (new Set(ids).size !== ids.length) throw hostError('Podman host container list contains duplicate full IDs');
        return freeze(records);
    }

    async findContainerById(id) {
        const target = fullId(id);
        const matches = (await this.listContainers()).filter((entry) => entry.Id === target);
        if (matches.length > 1) throw hostError('Podman host exact container match is ambiguous');
        return matches[0] || null;
    }

    async #requireJournalTarget(proof, { running = false } = {}) {
        const record = validateJournalContainerRecord(await this.findContainerById(proof.id), proof);
        if (!record) throw hostError('Podman host journal target is absent');
        if (running && String(record.State).toLowerCase() !== 'running') {
            throw hostError('Podman host journal target is not proven running');
        }
        return record;
    }

    async createContainer(value) {
        const spec = validateCreateSpec(value);
        const parsed = await this.#requestJson('POST', '/containers/create', spec, 201, 'container create');
        if (!exactKeys(parsed, ['Id', 'Warnings'])
            || !Array.isArray(parsed.Warnings)
            || parsed.Warnings.some((warning) => typeof warning !== 'string')) {
            throw hostError('Podman host container create returned an invalid response schema');
        }
        const id = fullId(parsed.Id, 'created container ID');
        return freeze({ id, warnings: [...parsed.Warnings] });
    }

    async startContainer({ id, journal }) {
        const proof = journalProof(this, journal, id, 'start');
        const before = await this.#requireJournalTarget(proof);
        if (!before) throw hostError('Podman host start target is absent');
        if (before.AutoRemove !== false || !SAFE_START_STATES.has(String(before.State).toLowerCase())) {
            throw hostError('Podman host start target is not a proven stopped, non-auto-remove container');
        }
        const result = await this.#request('POST', `/containers/${proof.id}/start`);
        requireEmptyResponse(result, 204, 'container start');
        const after = await this.#requireJournalTarget(proof);
        if (!after || String(after.State).toLowerCase() !== 'running' || after.AutoRemove !== false) {
            throw hostError('Podman host start could not prove the exact target running');
        }
        return freeze({ started: true, id: proof.id });
    }

    async stopContainer({ id, timeout = 10, journal }) {
        const proof = journalProof(this, journal, id, 'stop');
        const seconds = boundedInteger(timeout, 'stop timeout', { minimum: 1, maximum: 120 });
        const before = await this.#requireJournalTarget(proof);
        if (!before) throw hostError('Podman host stop target is absent');
        if (before.AutoRemove !== false) throw hostError('Podman host stop rejects an auto-remove target');
        const state = String(before.State).toLowerCase();
        if (SAFE_STOPPED_STATES.has(state)) return freeze({ stopped: false, id: proof.id, state });
        if (state !== 'running') throw hostError('Podman host stop target state is ambiguous');
        const result = await this.#request(
            'POST',
            `/containers/${proof.id}/stop?timeout=${seconds}&ignore=false`,
        );
        requireEmptyResponse(result, 204, 'container stop');
        const after = await this.#requireJournalTarget(proof);
        if (!after || !SAFE_STOPPED_STATES.has(String(after.State).toLowerCase())) {
            throw hostError('Podman host stop could not prove the exact target stopped');
        }
        return freeze({ stopped: true, id: proof.id, state: String(after.State).toLowerCase() });
    }

    async deleteContainer({ id, timeout = 10, journal }) {
        const proof = journalProof(this, journal, id, 'delete');
        const seconds = boundedInteger(timeout, 'delete timeout', { minimum: 1, maximum: 120 });
        const before = validateJournalContainerRecord(await this.findContainerById(proof.id), proof);
        if (!before) return freeze({ removed: false, id: proof.id, absent: true });
        if (before.AutoRemove !== false || !SAFE_STOPPED_STATES.has(String(before.State).toLowerCase())) {
            throw hostError('Podman host delete requires a proven stopped non-auto-remove exact target');
        }
        const parsed = await this.#requestJson(
            'DELETE',
            `/containers/${proof.id}?depend=false&force=false&ignore=false&timeout=${seconds}&volumes=false`,
            undefined,
            200,
            'container delete',
        );
        if (!Array.isArray(parsed)
            || parsed.length !== 1
            || !exactKeys(parsed[0], ['Id'])
            || parsed[0].Id !== proof.id) {
            throw hostError('Podman host container delete report did not identify only the exact owned target');
        }
        if (await this.findContainerById(proof.id)) {
            throw hostError('Podman host container delete absence proof failed');
        }
        return freeze({ removed: true, id: proof.id, absent: true });
    }

    async #execSession({
        id, argv, user, workdir, env, stdin, stdout, stderr, tty,
        detachKeys, rows, columns, signal, timeoutMs, inactivityTimeoutMs,
        maxOutputBytes, journal, onSession,
    }) {
        const proof = journalProof(this, journal, id, 'exec');
        const inventory = await this.listContainers();
        const matches = inventory.filter((entry) => entry.Id === proof.id);
        if (matches.length !== 1) {
            throw hostError('Podman host exec target is absent or ambiguous');
        }
        validateJournalContainerRecord(matches[0], proof);
        if (String(matches[0].State).toLowerCase() !== 'running') {
            throw hostError('Podman host exec target is not proven running');
        }
        for (const entry of inventory) {
            for (const observed of entry.Names) {
                const name = observed.replace(/^\//u, '');
                if (name.includes('%')) {
                    throw hostError('Podman host exec inventory contains a source-invalid container name');
                }
                if (entry.Id !== proof.id && name === proof.id) {
                    throw hostError('Podman host exec target ID is shadowed by a foreign exact container name');
                }
            }
        }
        const command = execCommand(argv);
        const selectedUser = execUser(user);
        const execWorkdir = boundedString(workdir, 'exec working directory');
        if (!path.posix.isAbsolute(execWorkdir)) throw hostError('Podman host exec working directory must be absolute');
        const environment = stringMap(env, 'exec environment');
        if (Object.keys(environment).some((key) => !EXEC_ENV_KEY.test(key))) {
            throw hostError(
                'Podman host exec environment contains an invalid variable name',
                'PLOINKY_BOX_HOST_INPUT_INVALID',
            );
        }
        if (typeof tty !== 'boolean') {
            throw hostError('Podman host exec TTY selection must be explicit', 'PLOINKY_BOX_HOST_INPUT_INVALID');
        }
        const execTimeout = boundedInteger(timeoutMs, 'exec timeout', { minimum: 1, maximum: 1_800_000 });
        const inactivity = boundedInteger(inactivityTimeoutMs, 'exec inactivity timeout', {
            minimum: 1,
            maximum: execTimeout,
        });
        const outputLimit = boundedInteger(maxOutputBytes, 'exec output limit', { minimum: 1, maximum: 512 * 1024 * 1024 });
        const initialRows = terminalDimension(rows, 'exec terminal height', { tty });
        const initialColumns = terminalDimension(columns, 'exec terminal width', { tty });
        const detachSequence = detachBytes(detachKeys, { tty });
        const attachStdin = stdin !== undefined && stdin !== null;
        if ((Buffer.isBuffer(stdin) || stdin instanceof Uint8Array || typeof stdin === 'string')
            && Buffer.byteLength(stdin) > this.maxRequestBytes) {
            throw hostError(
                'Podman host exec stdin exceeded its input limit',
                'PLOINKY_BOX_HOST_INPUT_INVALID',
            );
        }
        const bufferedInput = inputBuffer(stdin);
        if (attachStdin && bufferedInput === null && typeof stdin?.on !== 'function') {
            throw hostError(
                'Podman host exec stdin is not a supported bounded stream',
                'PLOINKY_BOX_HOST_INPUT_INVALID',
            );
        }
        if (!stdout || typeof stdout.write !== 'function'
            || !stderr || typeof stderr.write !== 'function') {
            throw hostError(
                'Podman host exec requires bounded stdout and stderr sinks',
                'PLOINKY_BOX_HOST_INPUT_INVALID',
            );
        }
        if (tty && (!attachStdin || !stdout || !stderr)) {
            throw hostError('Podman host interactive exec requires stdin/stdout/stderr streams');
        }
        if (signal !== undefined && signal !== null
            && typeof signal.addEventListener !== 'function') {
            throw hostError('Podman host exec caller cancellation signal is invalid');
        }
        if (onSession !== undefined && onSession !== null && typeof onSession !== 'function') {
            throw hostError('Podman host exec session observer is invalid');
        }
        const deadline = Date.now() + execTimeout;
        const remaining = () => {
            const value = deadline - Date.now();
            if (value < 1) {
                throw hostError(
                    `Podman host exec timed out at its overall deadline of ${execTimeout}ms`,
                    'PLOINKY_BOX_HOST_TIMEOUT',
                );
            }
            return value;
        };
        const requestOptions = () => ({
            timeoutMs: Math.min(this.timeoutMs, remaining()),
            signal,
        });
        const createSpec = {
            AttachStdin: attachStdin,
            AttachStdout: true,
            AttachStderr: true,
            DetachKeys: tty ? detachKeys : '',
            Tty: tty,
            Env: Object.entries(environment).map(([key, value]) => `${key}=${value}`),
            Cmd: command,
            Privileged: false,
            User: selectedUser,
            WorkingDir: execWorkdir,
        };
        const evidenceBinding = freeze({
            connectionIdentity: this.identity.connectionIdentity,
            containerId: proof.id,
            engineIdentity: this.identity.engineIdentity,
            generation: journal.transaction.generation,
        });
        const attemptId = randomBytes(32).toString('hex');
        const createdAt = Date.now();
        const commandHash = createHash('sha256').update(JSON.stringify({
            containerId: proof.id,
            createSpec,
        })).digest('hex');
        let sessionId = null;
        if (this.#execEvidenceStore) {
            await this.#execEvidenceStore.begin(evidenceBinding, {
                attemptId,
                commandHash,
                createdAt,
                tty,
            });
        }
        try {
            const created = await this.#requestJson(
                'POST',
                execLookupResource(proof.id),
                createSpec,
                201,
                'exec create',
                requestOptions(),
            );
            if (!exactKeys(created, ['Id'])) throw hostError('Podman host exec create returned an invalid schema');
            sessionId = fullId(created.Id, 'exec session ID');
            if (this.#execEvidenceStore) {
                await this.#execEvidenceStore.created(evidenceBinding, {
                    attemptId,
                    sessionId,
                    updatedAt: Date.now(),
                });
            }
            const preflight = validateExecInspection(await this.#requestJson(
                'GET',
                `/exec/${sessionId}/json`,
                undefined,
                200,
                'exec pre-start inspect',
                requestOptions(),
            ), {
                sessionId,
                containerId: proof.id,
                command,
                user: selectedUser,
                tty,
                attachStdin,
                phase: 'pre-start',
            });
            if (preflight.Running !== false
                || preflight.ExitCode !== 0
                || preflight.Pid !== 0
                || preflight.CanRemove !== false) {
                throw hostError('Podman host exec pre-start inspection returned an invalid Created state');
            }
            let live = false;
            let streamSettled = false;
            const resizeOperations = new Set();
            const controller = Object.freeze({
                sessionId,
                resize: (height, width) => {
                    if (!tty || !live || streamSettled) {
                        throw hostError('Podman host exec resize requires the exact live TTY session');
                    }
                    const operation = (async () => {
                    const selectedHeight = terminalDimension(height, 'exec resize height', { tty: true });
                    const selectedWidth = terminalDimension(width, 'exec resize width', { tty: true });
                    const inspected = validateExecInspection(await this.#requestJson(
                        'GET',
                        `/exec/${sessionId}/json`,
                        undefined,
                        200,
                        'exec resize inspect',
                        requestOptions(),
                    ), {
                        sessionId,
                        containerId: proof.id,
                        command,
                        user: selectedUser,
                        tty,
                        attachStdin,
                        phase: 'resize',
                    });
                    if (!inspected.Running || inspected.CanRemove) {
                        throw hostError('Podman host exec resize did not prove the exact session live');
                    }
                    if (!live || streamSettled) {
                        throw hostError('Podman host exec resize raced with stream settlement');
                    }
                    const resized = await this.#request(
                        'POST',
                        `/exec/${sessionId}/resize?h=${selectedHeight}&w=${selectedWidth}&running=false`,
                        requestOptions(),
                    );
                    requireEmptyResponse(resized, 201, 'exec resize');
                    return freeze({ rows: selectedHeight, columns: selectedWidth });
                    })();
                    resizeOperations.add(operation);
                    operation.finally(() => resizeOperations.delete(operation)).catch(() => {});
                    return operation;
                },
            });

            try {
                const body = Buffer.from(JSON.stringify({
                Detach: false,
                Tty: tty,
                h: initialRows,
                w: initialColumns,
            }));
            const upgraded = await this.#duplexImpl({
                socketPath: this.identity.socketPath,
                method: 'POST',
                path: this.#apiPath(`/exec/${sessionId}/start`),
                headers: {
                    Accept: tty
                        ? 'application/vnd.docker.raw-stream'
                        : 'application/vnd.docker.multiplexed-stream',
                    Connection: 'Upgrade',
                    Upgrade: 'tcp',
                    'Content-Type': 'application/json',
                    'Content-Length': String(body.length),
                },
                body,
                timeoutMs: remaining(),
                inactivityTimeoutMs: Math.min(inactivity, remaining()),
                maxOutputBytes: outputLimit,
                maxInputBytes: this.maxRequestBytes,
                maxHandshakeBytes: Math.min(EXEC_HANDSHAKE_LIMIT, this.maxResponseBytes),
                tty,
                stdin,
                stdout,
                stderr,
                detachSequence,
                signal,
                onUpgraded: () => {
                    live = true;
                    onSession?.(controller);
                },
            });
            streamSettled = true;
            live = false;
            if (resizeOperations.size > 0) {
                await Promise.all([...resizeOperations]);
            }
            if (!exactObject(upgraded)
                || upgraded.statusCode !== 101
                || typeof upgraded.detached !== 'boolean') {
                throw hostError('Podman host exec duplex transport returned an invalid settlement');
            }
            const inspected = validateExecInspection(await this.#requestJson(
                'GET',
                `/exec/${sessionId}/json`,
                undefined,
                200,
                'exec final inspect',
                requestOptions(),
            ), {
                sessionId,
                containerId: proof.id,
                command,
                user: selectedUser,
                tty,
                attachStdin,
                phase: 'final',
            });
            if (upgraded.detached) {
                if (!inspected.Running || inspected.CanRemove) {
                    throw hostError('Podman host exec detach did not prove the exact session still running');
                }
                if (this.#execEvidenceStore) {
                    await this.#execEvidenceStore.retain(evidenceBinding, {
                        attemptId,
                        sessionId,
                        state: 'detached',
                        updatedAt: Date.now(),
                    });
                }
                return freeze({ exitCode: 0, detached: true, sessionId });
            }
            if (inspected.Running || inspected.CanRemove !== true
                || inspected.Pid !== 0
                || inspected.ExitCode < 0 || inspected.ExitCode > 255) {
                throw hostError('Podman host exec inspect did not prove the exact session completed');
            }
            const removed = await this.#request(
                'POST',
                `/exec/${sessionId}/remove`,
                {
                    body: Buffer.from('{"Force":false}'),
                    contentType: 'application/json',
                    ...requestOptions(),
                },
            );
            requireEmptyResponse(removed, 200, 'exec remove');
            if (this.#execEvidenceStore) {
                await this.#execEvidenceStore.removed(evidenceBinding, {
                    attemptId,
                    sessionId,
                });
            }
                return freeze({ exitCode: inspected.ExitCode, detached: false, sessionId });
            } finally {
                streamSettled = true;
                live = false;
            }
        } catch (error) {
            if (this.#execEvidenceStore) {
                try {
                    await this.#execEvidenceStore.retain(evidenceBinding, {
                        attemptId,
                        sessionId,
                        state: 'ambiguous',
                        updatedAt: Date.now(),
                    });
                } catch {
                    // The earlier durable creating/created record is safer than
                    // masking the transport failure with a second journal error.
                }
            }
            throw error;
        }
    }

    async execContainer({
        id,
        argv,
        user = 'podman',
        workdir = '/workspace',
        env = {},
        input,
        timeoutMs = this.timeoutMs,
        inactivityTimeoutMs = Math.min(300_000, timeoutMs),
        maxOutputBytes = this.maxResponseBytes,
        journal,
        signal,
    }) {
        const stdout = [];
        const stderr = [];
        const result = await this.#execSession({
            id,
            argv,
            user,
            workdir,
            env,
            stdin: input,
            stdout: collectingSink(stdout),
            stderr: collectingSink(stderr),
            tty: false,
            detachKeys: '',
            rows: 0,
            columns: 0,
            signal,
            timeoutMs,
            inactivityTimeoutMs,
            maxOutputBytes,
            journal,
        });
        return freeze({
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
            exitCode: result.exitCode,
            sessionId: result.sessionId,
        });
    }

    async execContainerInteractive({
        id,
        argv,
        user = 'podman',
        workdir = '/workspace',
        env = {},
        journal,
        tty = true,
        detachKeys = DEFAULT_DETACH_KEYS,
        rows,
        columns,
        stdin,
        stdout,
        stderr,
        signal,
        timeoutMs = this.timeoutMs,
        inactivityTimeoutMs = Math.min(300_000, timeoutMs),
        maxOutputBytes = this.maxResponseBytes,
        onSession,
    }) {
        if (tty !== true) {
            throw hostError('Podman host interactive exec requires TTY=true');
        }
        const result = await this.#execSession({
            id,
            argv,
            user,
            workdir,
            env,
            journal,
            tty,
            detachKeys,
            rows,
            columns,
            stdin,
            stdout,
            stderr,
            signal,
            timeoutMs,
            inactivityTimeoutMs,
            maxOutputBytes,
            onSession,
        });
        return freeze({ exitCode: result.exitCode, detached: result.detached });
    }

    async putArchive({ id, path: containerPath, body, journal }) {
        const proof = journalProof(this, journal, id, 'archive put');
        await this.#requireJournalTarget(proof, { running: true });
        const destination = boundedString(containerPath, 'archive destination');
        if (!path.posix.isAbsolute(destination)) throw hostError('Podman host archive destination must be absolute');
        proveArchiveDestination(proof.creation, destination);
        if (!Buffer.isBuffer(body) || body.length === 0 || body.length > this.maxRequestBytes) {
            throw hostError('Podman host archive body must be a non-empty bounded Buffer');
        }
        const query = `path=${encodeURIComponent(destination)}&copyUIDGID=true&noOverwriteDirNonDir=true`;
        const result = await this.#request('PUT', `/containers/${proof.id}/archive?${query}`, {
            body,
            contentType: 'application/x-tar',
        });
        requireEmptyResponse(result, 200, 'archive put');
        return freeze({ copied: true, id: proof.id, path: destination, bytes: body.length });
    }

    async putFileArchive({
        id,
        path: containerPath,
        name,
        sourcePath,
        journal,
        maxBytes = this.maxArchiveBytes,
    }) {
        const proof = journalProof(this, journal, id, 'archive put');
        await this.#requireJournalTarget(proof, { running: true });
        const destination = boundedString(containerPath, 'archive destination');
        if (!path.posix.isAbsolute(destination)) throw hostError('Podman host archive destination must be absolute');
        proveArchiveDestination(proof.creation, destination);
        const archiveName = boundedString(name, 'archive file name', { maxBytes: 100 });
        if (!RESOURCE_NAME.test(archiveName) || path.posix.basename(archiveName) !== archiveName) {
            throw hostError('Podman host archive file name must be one safe basename');
        }
        const source = boundedString(sourcePath, 'archive source path');
        if (!path.isAbsolute(source)) throw hostError('Podman host archive source path must be absolute');
        const limit = boundedInteger(maxBytes, 'archive source limit', { minimum: 1, maximum: 2 ** 31 - 1 });
        const noFollow = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
        const sourceHandle = await fs.promises.open(source, noFollow);
        try {
            const stat = await sourceHandle.stat();
            if (!stat.isFile() || stat.nlink !== 1 || !Number.isSafeInteger(stat.size)
                || stat.size < 1 || stat.size > limit) {
                throw hostError('Podman host archive source must be one non-empty bounded regular file');
            }
            const padding = (512 - (stat.size % 512)) % 512;
            const contentLength = 512 + stat.size + padding + 1024;
            const query = `path=${encodeURIComponent(destination)}&copyUIDGID=true&noOverwriteDirNonDir=true`;
            const result = validateTransportResult(await this.#putFileArchiveImpl({
                socketPath: this.identity.socketPath,
                method: 'PUT',
                path: this.#apiPath(`/containers/${proof.id}/archive?${query}`),
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/x-tar',
                    'Content-Length': String(contentLength),
                },
                body: Buffer.alloc(0),
                timeoutMs: this.timeoutMs,
                maxResponseBytes: this.maxResponseBytes,
                sourceHandle,
                sourceSize: stat.size,
                archiveName,
            }), this.maxResponseBytes);
            requireEmptyResponse(result, 200, 'file archive put');
            return freeze({
                copied: true,
                id: proof.id,
                path: destination,
                name: archiveName,
                bytes: stat.size,
            });
        } finally {
            await sourceHandle.close();
        }
    }

    async inspectImage(id) {
        const imageId = fullId(id, 'image ID');
        const parsed = await this.#requestJson('GET', `/images/${imageId}/json`, undefined, 200, 'image inspect');
        if (!exactObject(parsed) || parsed.ID !== `sha256:${imageId}`) {
            throw hostError('Podman host image inspect did not return the exact raw image ID');
        }
        return freeze(parsed);
    }

    async exportImage(id, { maxBytes = this.maxResponseBytes } = {}) {
        const imageId = fullId(id, 'image ID');
        const limit = boundedInteger(maxBytes, 'image export limit', { minimum: 1, maximum: 2 ** 31 - 1 });
        const result = await this.#request(
            'GET',
            `/images/${imageId}/get?format=oci-archive&compress=false`,
            { maxResponseBytes: limit },
        );
        if (result.statusCode !== 200) throw hostError(`Podman host image export returned HTTP ${result.statusCode}`);
        if (!contentTypeMatches(result.headers, TAR_TYPES)) throw hostError('Podman host image export returned an invalid content-type');
        if (result.body.length === 0) throw hostError('Podman host image export returned an empty archive');
        return Buffer.from(result.body);
    }

    async exportImageToFile(id, destinationPath, { maxBytes = this.maxArchiveBytes } = {}) {
        const imageId = fullId(id, 'image ID');
        const destination = boundedString(destinationPath, 'image export destination');
        if (!path.isAbsolute(destination)) throw hostError('Podman host image export destination must be absolute');
        const parent = await fs.promises.lstat(path.dirname(destination));
        if (!parent.isDirectory() || parent.isSymbolicLink()) {
            throw hostError('Podman host image export parent must be a real directory');
        }
        try {
            await fs.promises.lstat(destination);
            throw hostError('Podman host image export refuses to overwrite an existing path');
        } catch (error) {
            if (error instanceof PloinkyBoxError) throw error;
            if (error?.code !== 'ENOENT') throw error;
        }
        const limit = boundedInteger(maxBytes, 'image archive limit', { minimum: 1, maximum: 2 ** 31 - 1 });
        const temporary = path.join(
            path.dirname(destination),
            `.${path.basename(destination)}.phase10x-${process.pid}-${randomBytes(8).toString('hex')}.tmp`,
        );
        try {
            const result = await this.#streamImpl({
                socketPath: this.identity.socketPath,
                method: 'GET',
                path: this.#apiPath(`/images/${imageId}/get?format=oci-archive&compress=false`),
                headers: { Accept: 'application/x-tar' },
                body: Buffer.alloc(0),
                timeoutMs: this.timeoutMs,
                maxResponseBytes: limit,
                destinationPath: temporary,
            });
            if (!exactObject(result)
                || result.statusCode !== 200
                || !Number.isSafeInteger(result.bytesWritten)
                || result.bytesWritten < 1
                || result.bytesWritten > limit
                || !contentTypeMatches(result.headers, TAR_TYPES)) {
                throw hostError('Podman host image export stream returned an invalid response');
            }
            await fs.promises.rename(temporary, destination);
            return freeze({ id: imageId, path: destination, bytes: result.bytesWritten });
        } catch (error) {
            await fs.promises.rm(temporary, { force: true });
            throw error;
        }
    }

    async findVolume({ name, labels }) {
        if (!RESOURCE_NAME.test(String(name || ''))) throw hostError('Podman host volume name is invalid');
        const exactLabels = stringMap(labels, 'volume labels', { requireNonEmpty: true });
        const filters = encodeURIComponent(exactVolumeFilter(name, exactLabels));
        const parsed = await this.#requestJson(
            'GET',
            `/volumes/json?filters=${filters}`,
            undefined,
            200,
            'exact filtered volume lookup',
        );
        if (!Array.isArray(parsed)) throw hostError('Podman host exact filtered volume lookup schema must be an array');
        const records = parsed.map(validateVolumeRecord);
        if (records.length > 1) throw hostError('Podman host exact filtered volume lookup is ambiguous');
        if (records.length === 0) return null;
        if (records[0].Name !== name
            || records[0].Driver !== 'local'
            || !exactStringMap(records[0].Labels ?? {}, exactLabels)
            || !exactStringMap(records[0].Options ?? {}, {})
            || Boolean(records[0].Anonymous ?? false)
            || String(records[0].StorageID ?? '') !== '') {
            throw hostError('Podman host exact filtered volume lookup returned a mismatched record');
        }
        return records[0];
    }

    async createVolume({ name, labels, uid = 1000, gid = 1000 }) {
        if (!RESOURCE_NAME.test(String(name || ''))) throw hostError('Podman host volume name is invalid');
        if (uid !== 1000 || gid !== 1000) {
            throw hostError('Podman host named volumes require the immutable podman UID/GID 1000:1000');
        }
        const exactLabels = stringMap(labels, 'volume labels', { requireNonEmpty: true });
        if (await this.findVolume({ name, labels: exactLabels })) {
            throw hostError('Podman host volume create requires exact filtered absence');
        }
        const parsed = await this.#requestJson('POST', '/volumes/create', {
            Name: name,
            Driver: 'local',
            Labels: exactLabels,
            Options: {},
            IgnoreIfExists: false,
            UID: uid,
            GID: gid,
        }, 201, 'volume create');
        const volume = validateVolumeRecord(parsed, 0);
        if (volume.Name !== name
            || volume.Driver !== 'local'
            || !exactStringMap(volume.Labels ?? {}, exactLabels)
            || !exactStringMap(volume.Options ?? {}, {})
            || Boolean(volume.Anonymous ?? false)
            || String(volume.StorageID ?? '') !== ''
            || volume.UID !== uid
            || volume.GID !== gid) {
            throw hostError('Podman host volume create did not return the exact owned volume');
        }
        return volume;
    }

    async deleteVolume({ name, labels, transactionOwned, knownUnused, timeout = 10 }) {
        if (!RESOURCE_NAME.test(String(name || ''))) throw hostError('Podman host volume name is invalid');
        if (transactionOwned !== true) throw hostError('Podman host volume delete requires a transaction-owned proof');
        if (knownUnused !== true) throw hostError('Podman host volume delete requires a known-unused proof');
        const seconds = boundedInteger(timeout, 'volume delete timeout', { minimum: 1, maximum: 120 });
        const exactLabels = stringMap(labels, 'volume labels', { requireNonEmpty: true });
        const before = await this.findVolume({ name, labels: exactLabels });
        if (!before || before.MountCount !== 0) {
            throw hostError('Podman host volume delete ownership/unused proof is missing or ambiguous');
        }
        const result = await this.#request('DELETE', `/volumes/${name}?force=false&timeout=${seconds}`);
        requireEmptyResponse(result, 204, 'volume delete');
        if (await this.findVolume({ name, labels: exactLabels })) {
            throw hostError('Podman host volume delete absence proof failed');
        }
        return freeze({ removed: true, name, absent: true });
    }

    async inspectContainer() { throw unsupported('container inspect', 'invokes target sync and is forbidden'); }
    async logsContainer() { throw unsupported('container logs'); }
    async waitContainer() { throw unsupported('container wait'); }
    async runContainer() { throw unsupported('run --rm', 'implies unproven create/start/wait/remove lifecycle'); }
    async copyContainer() { throw unsupported('generic copy'); }
    async killContainer() { throw unsupported('container kill'); }
    async restartContainer() { throw unsupported('container restart'); }
}

export function createPodmanHostClient(options) {
    return new PodmanHostClient(options);
}
