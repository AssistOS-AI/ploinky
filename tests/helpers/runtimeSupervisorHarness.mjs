import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    createRuntimeSupervisor,
    runSupervisorWithBoundary,
} from '../../container/runtime-supervisor.mjs';
import {
    PATH_HASH_LABEL,
    REQUESTED_IMAGE_LABEL,
    REQUIRED_IMAGE_ENTRYPOINT,
    REQUIRED_IMAGE_ENV,
    REQUIRED_IMAGE_USER,
    REQUIRED_IMAGE_WORKDIR,
    REQUIRED_RUNTIME_IMAGE,
    VOLUME_ROLE_LABEL,
    VOLUME_ROLES,
    runtimeVolumeNames,
} from '../../container/runtime-contract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');

function writableBuffer() {
    let value = '';
    return {
        stream: {
            write(chunk) {
                value += String(chunk);
                return true;
            },
        },
        text: () => value,
    };
}
function clone(value) {
    return value == null ? value : structuredClone(value);
}

function failureCode(failures, signature) {
    const raw = failures instanceof Map
        ? failures.get(signature)
        : failures instanceof Set
            ? failures.has(signature)
            : Array.isArray(failures)
                ? failures.includes(signature)
                : failures?.[signature];
    if (raw === undefined || raw === null || raw === false) return 0;
    if (raw === true) return 1;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : 0;
}

export function identityFor(cwd = '/workspace/demo') {
    const canonicalPath = path.resolve(cwd);
    const pathHash = crypto.createHash('sha256')
        .update(canonicalPath)
        .digest('hex')
        .slice(0, 12);
    const rawSlug = path.basename(canonicalPath)
        .replace(/[^a-zA-Z0-9_.-]/g, '_')
        .slice(0, 48);
    const slug = /[a-zA-Z0-9]/.test(rawSlug) ? rawSlug : 'workspace';
    return {
        canonicalPath,
        pathHash,
        slug,
        instance: `ploinky-box-${slug}-${pathHash}`,
    };
}

export function compatibleImage(id = 'sha256:runtime-current') {
    return {
        Id: id,
        Config: {
            User: REQUIRED_IMAGE_USER,
            Env: Object.entries(REQUIRED_IMAGE_ENV)
                .map(([key, value]) => `${key}=${value}`),
            WorkingDir: REQUIRED_IMAGE_WORKDIR,
            Entrypoint: [REQUIRED_IMAGE_ENTRYPOINT],
            Cmd: null,
            Volumes: null,
            Labels: {},
        },
    };
}

export function incompatibleImage(id = 'sha256:runtime-incompatible') {
    const image = compatibleImage(id);
    image.Config.Labels['io.assistos.ploinky.unexpected'] = 'retired';
    return image;
}

export function ownedVolume(name, pathHash, roleKey) {
    return {
        Name: name,
        Labels: {
            [PATH_HASH_LABEL]: pathHash,
            [VOLUME_ROLE_LABEL]: VOLUME_ROLES[roleKey],
        },
    };
}

export function ownedContainer({
    cwd = '/workspace/demo',
    engine = 'podman',
    state = 'running',
    imageId = 'sha256:runtime-current',
    requestedImage = REQUIRED_RUNTIME_IMAGE,
    sourceDir = REPO_ROOT,
    labels = {},
    env = {},
    publishes = {},
} = {}) {
    const identity = identityFor(cwd);
    const names = runtimeVolumeNames(identity.instance);
    const runtimeLabels = {
        [REQUESTED_IMAGE_LABEL]: requestedImage,
        [PATH_HASH_LABEL]: identity.pathHash,
        ...labels,
    };
    const raw = {
        Id: 'container-id-existing',
        Name: engine === 'docker' ? `/${identity.instance}` : identity.instance,
        Image: imageId,
        ImageName: imageId,
        Config: {
            Image: imageId,
            User: 'podman',
            Env: [
                ...Object.entries(REQUIRED_IMAGE_ENV)
                    .map(([key, value]) => `${key}=${value}`),
                `PLOINKY_RUNTIME_NAME=${identity.instance}`,
                ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
            ],
            Labels: runtimeLabels,
        },
        State: { Status: state, Running: state === 'running' },
        HostConfig: {
            Privileged: false,
            Binds: [`${sourceDir}:/opt/ploinky:ro`],
            PortBindings: {
                '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }],
                '7882/udp': [{ HostIp: '0.0.0.0', HostPort: '7882' }],
                ...publishes,
            },
            Devices: [
                {
                    PathOnHost: '/dev/fuse',
                    PathInContainer: '/dev/fuse',
                    CgroupPermissions: 'rwm',
                },
                {
                    PathOnHost: '/dev/net/tun',
                    PathInContainer: '/dev/net/tun',
                    CgroupPermissions: 'rwm',
                },
            ],
            SecurityOpt: ['unmask=ALL'],
        },
        Mounts: [
            {
                Type: 'volume', Name: names.workspace, Source: names.workspace,
                Destination: '/workspace', Mode: '', RW: true,
            },
            {
                Type: 'volume', Name: names.containers, Source: names.containers,
                Destination: '/home/podman/.local/share/containers', Mode: '', RW: true,
            },
            {
                Type: 'volume', Name: names.deps, Source: names.deps,
                Destination: '/opt/ploinky/node_modules', Mode: engine === 'podman' ? 'U' : '', RW: true,
            },
            {
                Type: 'bind', Source: sourceDir, Destination: '/opt/ploinky',
                Mode: 'ro', RW: false,
            },
        ],
    };
    return {
        inspect: raw,
        logs: '[ploinky-box] self-check OK\n',
        coreStatus: 0,
        coreStdout: 'core: running\n',
        depsInstalled: true,
    };
}

export function ownedRuntimeFixture(options = {}) {
    const cwd = options.cwd || '/workspace/demo';
    const identity = identityFor(cwd);
    const names = runtimeVolumeNames(identity.instance);
    const image = compatibleImage(options.imageId);
    const container = ownedContainer({ ...options, cwd, imageId: image.Id });
    return {
        container,
        images: {
            [image.Id]: image,
            [options.requestedImage || REQUIRED_RUNTIME_IMAGE]: image,
        },
        volumes: Object.fromEntries(Object.keys(VOLUME_ROLES).map(roleKey => {
            const volume = ownedVolume(names[roleKey], identity.pathHash, roleKey);
            return [volume.Name, volume];
        })),
        identity,
    };
}

function normalizeInputVolumes(volumes) {
    if (volumes instanceof Map) {
        return new Map([...volumes].map(([name, value]) => [name, clone(value)]));
    }
    if (Array.isArray(volumes)) {
        return new Map(volumes.map(value => {
            if (typeof value === 'string') return [value, { Name: value, Labels: {} }];
            return [value.Name, clone(value)];
        }));
    }
    return new Map(Object.entries(volumes || {}).map(([name, value]) => [
        name,
        value?.Name
            ? clone(value)
            : { Name: name, Labels: clone(value?.Labels || value || {}) },
    ]));
}

function parsePublishedBinding(spec) {
    const slash = spec.lastIndexOf('/');
    const protocol = slash === -1 ? 'tcp' : spec.slice(slash + 1);
    const address = slash === -1 ? spec : spec.slice(0, slash);
    const parts = address.split(':');
    const containerPort = parts.at(-1);
    const hostPort = parts.length >= 2 ? parts.at(-2) : containerPort;
    const hostIp = parts.length >= 3 ? parts.slice(0, -2).join(':') : '';
    return {
        target: `${containerPort}/${protocol}`,
        binding: { HostIp: hostIp, HostPort: hostPort },
    };
}

function inspectFromRunArgs(engine, args, images, anonymousVolumes) {
    const image = images[args.at(-1)] || {};
    const imageEnv = image.Config?.Env || [];
    const inspect = {
        Id: `container-id-${Date.now()}`,
        Name: '',
        Image: image.Id || image.ID || args.at(-1),
        ImageName: args.at(-1),
        Config: {
            Image: args.at(-1), User: '', Env: [...imageEnv],
            Labels: { ...(image.Config?.Labels || {}) },
        },
        State: { Status: 'running', Running: true },
        HostConfig: {
            Privileged: false, Binds: [], PortBindings: {}, Devices: [], SecurityOpt: [],
        },
        Mounts: [],
    };
    const inheritedVolumes = Object.keys(image.Config?.Volumes || {});
    for (const destination of inheritedVolumes) {
        const name = `anonymous-${anonymousVolumes.size + 1}`;
        anonymousVolumes.add(name);
        inspect.Mounts.push({
            Type: 'volume', Name: name, Source: name, Destination: destination,
            Mode: '', RW: true,
        });
    }
    for (let index = 1; index < args.length - 1; index += 1) {
        const arg = args[index];
        if (arg === '--name') inspect.Name = args[++index];
        else if (arg === '--privileged') inspect.HostConfig.Privileged = true;
        else if (arg === '--user') inspect.Config.User = args[++index];
        else if (arg === '--label') {
            const value = args[++index];
            const split = value.indexOf('=');
            inspect.Config.Labels[value.slice(0, split)] = value.slice(split + 1);
        } else if (arg === '--device') {
            const [PathOnHost, PathInContainer, CgroupPermissions = 'rwm'] = args[++index].split(':');
            inspect.HostConfig.Devices.push({ PathOnHost, PathInContainer, CgroupPermissions });
        } else if (arg === '--security-opt') inspect.HostConfig.SecurityOpt.push(args[++index]);
        else if (arg === '-p') {
            const parsed = parsePublishedBinding(args[++index]);
            inspect.HostConfig.PortBindings[parsed.target] ||= [];
            inspect.HostConfig.PortBindings[parsed.target].push(parsed.binding);
        } else if (arg === '-e') {
            const entry = args[++index];
            const key = entry.slice(0, entry.indexOf('='));
            inspect.Config.Env = inspect.Config.Env.filter(value => !value.startsWith(`${key}=`));
            inspect.Config.Env.push(entry);
        } else if (arg === '-v') {
            const value = args[++index];
            const [source, destination, ...rest] = value.split(':');
            const mode = rest.join(':');
            if (source.startsWith('/')) {
                inspect.HostConfig.Binds.push(value);
                inspect.Mounts.push({
                    Type: 'bind', Source: source, Destination: destination,
                    Mode: mode, RW: !mode.split(',').includes('ro'),
                });
            } else {
                inspect.Mounts.push({
                    Type: 'volume', Name: source, Source: source, Destination: destination,
                    Mode: mode, RW: !mode.split(',').includes('ro'),
                });
            }
        }
    }
    if (engine === 'docker') inspect.Name = `/${inspect.Name}`;
    return inspect;
}

function nextPullImage(pullImages, reference) {
    const configured = pullImages?.[reference];
    if (Array.isArray(configured)) {
        if (configured.length === 0) return null;
        return clone(configured.shift());
    }
    if (typeof configured === 'function') return clone(configured(reference));
    if (configured) return clone(configured);
    return reference === REQUIRED_RUNTIME_IMAGE ? compatibleImage() : null;
}

export function createFakeEngine({
    engine = 'podman',
    container = null,
    images = {},
    pullImages = {},
    volumes = {},
    anonymousVolumes = [],
    failures = {},
    replacementFailureCreatesContainer = false,
    createFailureCreatesContainer = false,
    rmFailureRemovesContainer = false,
    stdout = { write() { return true; } },
    stderr = { write() { return true; } },
} = {}) {
    const calls = [];
    const state = {
        container: clone(container),
        backups: new Map(),
        images: clone(images) || {},
        volumes: normalizeInputVolumes(volumes),
        anonymousVolumes: new Set(anonymousVolumes),
    };
    let inspectedOld = false;
    let reconciliationState = 'idle';

    const result = (ok, stdoutValue = '', stderrValue = '') => ({
        ok, status: ok ? 0 : 1, stdout: stdoutValue, stderr: stderrValue,
    });
    const fail = (signature, options = {}) => {
        const code = failureCode(failures, signature);
        if (!code) return 0;
        if (options.allowFail) return code;
        const error = new Error(`${engine} ${signature} exited ${code}`);
        error.exitCode = code;
        throw error;
    };
    const createdContainer = args => ({
        inspect: inspectFromRunArgs(engine, args, state.images, state.anonymousVolumes),
        logs: '[ploinky-box] self-check OK\n',
        coreStatus: 0,
        coreStdout: 'core: running\n',
        depsInstalled: true,
    });

    const engineClient = {
        name: engine,
        query(args, options = {}) {
            calls.push({ kind: 'query', args: [...args], options: { ...options } });
            if (args[0] === 'info') {
                if (failureCode(failures, 'info')) return result(false, '', 'engine unavailable');
                if (args.includes('{{json .Host.Security.Rootless}}')) return result(true, 'true\n');
                if (args.includes('{{json .SecurityOptions}}')) return result(true, '[]\n');
                if (args.includes('{{.Host.Security.SELinuxEnabled}}')) return result(true, 'false\n');
                return result(true, '{}\n');
            }
            if (args[0] === 'ps' && args.includes('--all')) {
                const names = [
                    String(state.container?.inspect?.Name || '').replace(/^\//, ''),
                    ...state.backups.keys(),
                ].filter(Boolean);
                return result(true, names.join('\n') + (names.length > 0 ? '\n' : ''));
            }
            if (args[0] === 'container' && args[1] === 'inspect') {
                if (failureCode(failures, 'container inspect')) {
                    return result(false, '', 'permission denied');
                }
                const formatted = args.includes('--format');
                const target = args.at(-1);
                const managedName = String(state.container?.inspect?.Name || '').replace(/^\//, '');
                const selected = target === managedName
                    ? state.container
                    : state.backups.get(target);
                if (!selected) {
                    if (!formatted) {
                        inspectedOld = false;
                        if (reconciliationState !== 'rollback-ready') reconciliationState = 'idle';
                    }
                    return result(false, '', 'container not found');
                }
                if (formatted) {
                    const format = args[args.indexOf('--format') + 1] || '';
                    const value = format.includes('State.Status')
                        ? selected.inspect.State.Status
                        : selected.inspect.Id;
                    return result(true, `${value}\n`);
                }
                inspectedOld = true;
                return result(true, JSON.stringify([selected.inspect]));
            }
            if (args[0] === 'image' && args[1] === 'inspect') {
                const image = state.images[args[2]];
                return image
                    ? result(true, JSON.stringify([image]))
                    : result(false, '', 'image not found');
            }
            if (args[0] === 'volume' && args[1] === 'inspect') {
                if (
                    failureCode(failures, `volume inspect ${args[2]}`)
                    || failureCode(failures, 'volume inspect')
                ) return result(false, '', 'permission denied');
                const volume = state.volumes.get(args[2]);
                return volume
                    ? result(true, JSON.stringify([volume]))
                    : result(false, '', 'volume not found');
            }
            if (args[0] === 'port') {
                const target = args.at(-1);
                const binding = state.container?.inspect?.HostConfig
                    ?.PortBindings?.[target]?.[0];
                return binding
                    ? result(true, `${binding.HostIp || '0.0.0.0'}:${binding.HostPort}\n`)
                    : result(false, '', 'port not found');
            }
            if (args[0] === 'exec') {
                if (args.includes('/proc/self/uid_map') || args.includes('/proc/self/gid_map')) {
                    return result(true, '0 1000 1\n1 100000 65534\n');
                }
                if (args.includes('{{json .Host.Security.Rootless}}')) {
                    return result(true, 'true\n');
                }
                const installed = state.container?.depsInstalled !== false;
                return result(installed, '', installed ? '' : 'dependencies missing');
            }
            if (args[0] === 'run' && args.includes('--network=none')) {
                if (failureCode(failures, 'image capability probe')) {
                    return result(false, '', 'image capability probe failed');
                }
                return result(true, [
                    '/usr/bin/node',
                    '/usr/bin/podman',
                    '/usr/bin/bash',
                    '/usr/sbin/ip',
                    '/usr/bin/fuse-overlayfs',
                    '/usr/local/bin/ploinky-box-entrypoint',
                    '/usr/bin/pasta',
                    '',
                ].join('\n'));
            }
            return result(false, '', 'unsupported query');
        },
        run(args, options = {}) {
            calls.push({ kind: 'run', args: [...args], options: { ...options } });
            if (args[0] === 'pull') {
                const code = fail('pull', options);
                if (code) return code;
                const image = nextPullImage(pullImages, args[1]);
                if (!image) return fail('pull unavailable', { ...options, allowFail: true }) || 1;
                state.images[args[1]] = image;
                state.images[image.Id || image.ID] = image;
                return 0;
            }
            if (args[0] === 'volume' && args[1] === 'create') {
                const code = fail('volume create', options);
                if (code) return code;
                const labels = {};
                for (let index = 2; index < args.length - 1; index += 1) {
                    if (args[index] !== '--label') continue;
                    const raw = args[++index];
                    const split = raw.indexOf('=');
                    labels[raw.slice(0, split)] = raw.slice(split + 1);
                }
                const name = args.at(-1);
                if (!state.volumes.has(name)) state.volumes.set(name, { Name: name, Labels: labels });
                return 0;
            }
            if (args[0] === 'run') {
                const signature = reconciliationState === 'rollback-ready'
                    ? 'run rollback'
                    : reconciliationState === 'replacement-ready'
                        ? 'run replacement'
                        : 'run create';
                if (state.container) return fail('run name conflict', { ...options, allowFail: true }) || 1;
                const code = failureCode(failures, signature);
                if (code) {
                    if (signature === 'run replacement') {
                        reconciliationState = 'rollback-ready';
                        if (replacementFailureCreatesContainer) {
                            state.container = createdContainer(args);
                            state.container.inspect.State.Status = 'exited';
                            state.container.inspect.State.Running = false;
                        }
                    } else if (signature === 'run create' && createFailureCreatesContainer) {
                        state.container = createdContainer(args);
                        state.container.inspect.State.Status = 'exited';
                        state.container.inspect.State.Running = false;
                    }
                    if (options.allowFail) return code;
                    const error = new Error(`${engine} ${signature} exited ${code}`);
                    error.exitCode = code;
                    throw error;
                }
                state.container = createdContainer(args);
                reconciliationState = signature === 'run replacement'
                    ? 'replacement-created'
                    : 'idle';
                return 0;
            }
            if (args[0] === 'rename') {
                const renameCode = fail('rename', options);
                if (renameCode) return renameCode;
                const [, from, to] = args;
                const managedName = String(state.container?.inspect?.Name || '').replace(/^\//, '');
                if (state.container && from === managedName) {
                    state.container.inspect.Name = engine === 'docker' ? `/${to}` : to;
                    state.backups.set(to, state.container);
                    state.container = null;
                    reconciliationState = 'replacement-ready';
                    return 0;
                }
                const backup = state.backups.get(from);
                if (backup && !state.container) {
                    state.backups.delete(from);
                    backup.inspect.Name = engine === 'docker' ? `/${to}` : to;
                    state.container = backup;
                    reconciliationState = 'idle';
                    return 0;
                }
                return fail('rename', { ...options, allowFail: true }) || 1;
            }
            if (args[0] === 'start') {
                const code = fail('start', options);
                if (code) return code;
                if (state.container) {
                    state.container.inspect.State.Status = 'running';
                    state.container.inspect.State.Running = true;
                }
                return 0;
            }
            if (args[0] === 'stop') {
                const code = fail('stop', options);
                if (code) return code;
                if (state.container) {
                    state.container.inspect.State.Status = 'exited';
                    state.container.inspect.State.Running = false;
                }
                return 0;
            }
            if (args[0] === 'rm') {
                const target = args.at(-1);
                if (state.backups.has(target)) {
                    const code = fail('rm backup', options);
                    if (code) return code;
                    state.backups.delete(target);
                    return 0;
                }
                const replacementCleanup = ['replacement-created', 'rollback-ready']
                    .includes(reconciliationState);
                const signature = args.includes('-f')
                    ? replacementCleanup
                        ? 'rm replacement cleanup'
                        : 'rm transaction cleanup'
                    : 'rm container';
                if (
                    signature === 'rm container'
                    && rmFailureRemovesContainer
                    && failureCode(failures, signature)
                ) {
                    state.container = null;
                    reconciliationState = 'rollback-ready';
                }
                const code = fail(signature, options);
                if (code) return code;
                if (args.includes('--volumes')) state.anonymousVolumes.clear();
                if (reconciliationState === 'replacement-created') reconciliationState = 'rollback-ready';
                else if (reconciliationState === 'idle' && inspectedOld) reconciliationState = 'replacement-ready';
                inspectedOld = false;
                state.container = null;
                return 0;
            }
            if (args[0] === 'volume' && args[1] === 'rm') {
                const code = fail('volume rm', options);
                if (code) return code;
                for (const name of args.slice(2)) state.volumes.delete(name);
                return 0;
            }
            if (args[0] === 'exec') {
                const coreIndex = args.indexOf('ploinky');
                if (coreIndex !== -1 && args[coreIndex + 1] === 'stop') {
                    return fail('exec ploinky stop', options);
                }
                if (coreIndex !== -1 && args[coreIndex + 1] === 'status') {
                    if (state.container?.coreStdout) stdout.write(state.container.coreStdout);
                    return state.container?.coreStatus || 0;
                }
                return fail('exec', options);
            }
            return 0;
        },
        streamContains(args, needle) {
            calls.push({ kind: 'streamContains', args: [...args], options: { needle } });
            return Promise.resolve(String(state.container?.logs || '').includes(needle));
        },
        streamToStderr(args) {
            calls.push({ kind: 'streamToStderr', args: [...args], options: {} });
            stderr.write(state.container?.logs || '');
            return Promise.resolve(0);
        },
    };
    return { engineClient, calls, state };
}

export function createSupervisorHarness(options = {}) {
    const stdout = writableBuffer();
    const stderr = writableBuffer();
    let prompt = '';
    const engine = options.engine || 'podman';
    const fake = createFakeEngine({
        ...options,
        engine,
        stdout: stdout.stream,
        stderr: stderr.stream,
    });
    const stdin = options.stdin || { isTTY: Boolean(options.stdoutIsTTY) };
    const waitHealthy = async (_cfg, phase) => {
        fake.calls.push({ kind: 'health', phase, args: [], options: { phase } });
        const code = failureCode(options.failures || {}, `health ${phase}`);
        if (code) throw new Error(`health ${phase} exited ${code}`);
    };
    const dependencies = {
        stdout: Object.assign(stdout.stream, { isTTY: Boolean(options.stdoutIsTTY) }),
        stderr: stderr.stream,
        stdin,
        cwd: options.cwd || '/workspace/demo',
        realpath: options.realpath || (value => path.resolve(value)),
        env: {
            PLOINKY_BOX_BRANCH: 'main',
            PLOINKY_BOX_SOURCE: REPO_ROOT,
            ...(options.env || {}),
        },
        engineClient: fake.engineClient,
        sleep: async () => {},
        waitHealthy,
        portInUse: options.portInUse || (async () => false),
        udpPortInUse: options.udpPortInUse || (async () => false),
        ...(options.fixedUdpOwners
            ? { fixedUdpOwners: options.fixedUdpOwners }
            : {}),
        askLine: async text => {
            prompt += text;
            stdout.stream.write(text);
            return options.answer ?? null;
        },
        fetch: async url => {
            fake.calls.push({ kind: 'fetch', url, args: [], options: {} });
            return options.fetchResponse || { ok: false };
        },
        withHostRuntimeLock: options.withHostRuntimeLock
            || (async (_invocation, callback) => callback()),
        showHelp: options.showHelp || (() => {}),
    };
    const rawSupervisor = createRuntimeSupervisor(dependencies);
    const supervisor = {
        run(argv) {
            return runSupervisorWithBoundary(rawSupervisor, argv, stderr.stream);
        },
    };
    return {
        supervisor,
        rawSupervisor,
        engineClient: fake.engineClient,
        calls: fake.calls,
        state: fake.state,
        get stdout() { return stdout.text(); },
        get stderr() { return stderr.text(); },
        get prompt() { return prompt; },
    };
}
