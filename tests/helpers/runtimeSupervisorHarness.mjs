import {
    createRuntimeSupervisor,
    runSupervisorWithBoundary,
} from '../../container/runtime-supervisor.mjs';
import {
    REQUIRED_RUNTIME_IMAGE,
    RUNTIME_CONTRACT_LABEL,
} from '../../container/runtime-contract.mjs';

function writableBuffer() {
    let value = '';
    return {
        stream: {
            write(chunk) {
                value += String(chunk);
                return true;
            },
        },
        text() {
            return value;
        },
    };
}

function contractV1Image(id = 'sha256:runtime-v1') {
    return {
        Id: id,
        Config: {
            Labels: { [RUNTIME_CONTRACT_LABEL]: '1' },
        },
    };
}

function failureCode(failures, signature) {
    const asCode = (value) => {
        if (value === undefined || value === null || value === false) return 0;
        if (value === true) return 1;
        const code = Number(value);
        return Number.isFinite(code) && code > 0 ? code : 0;
    };
    if (failures instanceof Map) {
        return asCode(failures.get(signature));
    }
    if (failures instanceof Set) return failures.has(signature) ? 1 : 0;
    if (Array.isArray(failures)) return failures.includes(signature) ? 1 : 0;
    if (failures && Object.hasOwn(failures, signature)) {
        return asCode(failures[signature]);
    }
    return 0;
}

function clone(value) {
    return value == null ? value : structuredClone(value);
}

function publishedBinding(spec) {
    const slash = spec.lastIndexOf('/');
    const protocol = slash === -1 ? 'tcp' : spec.slice(slash + 1);
    const address = slash === -1 ? spec : spec.slice(0, slash);
    const parts = address.split(':');
    const containerPort = parts.at(-1);
    const hostPort = parts.length >= 2 ? parts.at(-2) : containerPort;
    const hostIp = parts.length >= 3 ? parts.slice(0, -2).join(':') : '';
    return {
        target: `${containerPort}/${protocol}`,
        value: { HostIp: hostIp, HostPort: hostPort },
    };
}

function inspectFromRunArgs(engine, args, images, volumes) {
    const inspect = {
        Id: 'container-id-created',
        Name: '',
        Image: '',
        Config: { Image: args.at(-1), User: '', Env: [] },
        State: { Status: 'running', Running: true },
        HostConfig: {
            Privileged: false,
            Binds: [],
            PortBindings: {},
            Devices: [],
            SecurityOpt: [],
        },
        Mounts: [],
    };
    for (let index = 1; index < args.length - 1; index += 1) {
        const arg = args[index];
        if (arg === '--name') {
            inspect.Name = args[++index];
            continue;
        }
        if (arg === '--privileged') {
            inspect.HostConfig.Privileged = true;
            continue;
        }
        if (arg === '--user') {
            inspect.Config.User = args[++index];
            continue;
        }
        if (arg === '--device') {
            const [PathOnHost, PathInContainer, CgroupPermissions = 'rwm'] =
                args[++index].split(':');
            inspect.HostConfig.Devices.push({
                PathOnHost,
                PathInContainer,
                CgroupPermissions,
            });
            continue;
        }
        if (arg === '--security-opt') {
            inspect.HostConfig.SecurityOpt.push(args[++index]);
            continue;
        }
        if (arg === '-p') {
            const binding = publishedBinding(args[++index]);
            inspect.HostConfig.PortBindings[binding.target] ||= [];
            inspect.HostConfig.PortBindings[binding.target].push(binding.value);
            continue;
        }
        if (arg === '-e') {
            inspect.Config.Env.push(args[++index]);
            continue;
        }
        if (arg === '-v') {
            const value = args[++index];
            const [source, destination, ...options] = value.split(':');
            const mode = options.join(':');
            const isNamedVolume = !source.startsWith('/');
            if (isNamedVolume) {
                volumes.add(source);
                inspect.Mounts.push({
                    Type: 'volume',
                    Name: source,
                    Source: source,
                    Destination: destination,
                    Mode: mode,
                    RW: !mode.split(',').includes('ro'),
                });
            } else {
                inspect.HostConfig.Binds.push(value);
                inspect.Mounts.push({
                    Type: 'bind',
                    Source: source,
                    Destination: destination,
                    Mode: mode,
                    RW: !mode.split(',').includes('ro'),
                });
            }
        }
    }
    const image = images[inspect.Config.Image];
    inspect.Image = image?.Id || image?.ID || 'sha256:runtime-v1';
    if (engine === 'podman') inspect.ImageName = inspect.Config.Image;
    return inspect;
}

export function createFakeEngine({
    engine = 'podman',
    container = null,
    images = {},
    pullImages = {},
    volumes = [],
    failures = {},
    stdout = { write() { return true; } },
    stderr = { write() { return true; } },
} = {}) {
    const calls = [];
    const configuredVolumes = volumes instanceof Set
        ? [...volumes]
        : (Array.isArray(volumes)
            ? volumes
            : Object.values(volumes || {}));
    const state = {
        container: clone(container),
        images: clone(images) || {},
        volumes: new Set(configuredVolumes),
    };
    const inspectedMounts = state.container?.inspect?.Mounts;
    for (const mount of Array.isArray(inspectedMounts) ? inspectedMounts : []) {
        if (mount.Type === 'volume' && mount.Name) {
            state.volumes.add(mount.Name);
        }
    }
    let inspectedOld = false;
    let reconciliationRunState = 'idle';

    const fail = (signature, options = {}) => {
        const code = failureCode(failures, signature);
        if (code === 0) return 0;
        if (options.allowFail) return code;
        throw new Error(`${engine} ${signature} exited ${code}`);
    };

    const engineClient = {
        name: engine,
        query(args) {
            calls.push({ kind: 'query', args: [...args], options: {} });
            if (args[0] === 'machine' && args[1] === 'inspect') {
                return { ok: true, status: 0, stdout: 'running\n', stderr: '' };
            }
            if (args[0] === 'info') {
                const stdoutValue = args.includes('{{json .SecurityOptions}}')
                    ? '[]\n'
                    : (args.includes('{{.Host.Security.SELinuxEnabled}}')
                        ? 'false\n'
                        : '{}\n');
                return { ok: true, status: 0, stdout: stdoutValue, stderr: '' };
            }
            if (args[0] === 'container' && args[1] === 'inspect') {
                if (!state.container) {
                    return { ok: false, status: 1, stdout: '', stderr: 'missing' };
                }
                if (args.includes('--format')) {
                    return {
                        ok: true,
                        status: 0,
                        stdout: `${state.container.inspect.State.Status}\n`,
                        stderr: '',
                    };
                }
                if (reconciliationRunState === 'replacement-created') {
                    reconciliationRunState = 'idle';
                }
                inspectedOld = true;
                return {
                    ok: true,
                    status: 0,
                    stdout: JSON.stringify([state.container.inspect]),
                    stderr: '',
                };
            }
            if (args[0] === 'image' && args[1] === 'inspect') {
                const image = state.images[args[2]];
                return image
                    ? {
                        ok: true,
                        status: 0,
                        stdout: JSON.stringify([image]),
                        stderr: '',
                    }
                    : { ok: false, status: 1, stdout: '', stderr: 'missing' };
            }
            if (args[0] === 'volume' && args[1] === 'inspect') {
                const ok = state.volumes.has(args[2]);
                return { ok, status: ok ? 0 : 1, stdout: '', stderr: '' };
            }
            if (args[0] === 'port') {
                const binding = state.container?.inspect?.HostConfig
                    ?.PortBindings?.['8080/tcp']?.[0];
                const value = binding
                    ? `${binding.HostIp || '0.0.0.0'}:${binding.HostPort}\n`
                    : '';
                return {
                    ok: Boolean(binding),
                    status: binding ? 0 : 1,
                    stdout: value,
                    stderr: '',
                };
            }
            if (args[0] === 'exec') {
                const installed = state.container?.depsInstalled !== false;
                return {
                    ok: installed,
                    status: installed ? 0 : 1,
                    stdout: '',
                    stderr: '',
                };
            }
            return { ok: false, status: 1, stdout: '', stderr: 'unsupported query' };
        },
        run(args, options = {}) {
            calls.push({ kind: 'run', args: [...args], options: { ...options } });
            if (args[0] === 'pull') {
                const failed = fail('pull', options);
                if (failed) return failed;
                const reference = args[1];
                const image = reference === REQUIRED_RUNTIME_IMAGE
                    ? contractV1Image()
                    : clone(pullImages[reference]);
                if (!image) {
                    if (options.allowFail) return 1;
                    throw new Error(`${engine} pull exited 1`);
                }
                state.images[reference] = image;
                state.images[image.Id || image.ID] = image;
                return 0;
            }
            if (args[0] === 'run') {
                const signature = reconciliationRunState === 'rollback-ready'
                    ? 'run rollback'
                    : (reconciliationRunState === 'replacement-ready'
                        ? 'run replacement'
                        : 'run create');
                const code = failureCode(failures, signature);
                if (code !== 0) {
                    if (signature === 'run replacement') {
                        reconciliationRunState = 'rollback-ready';
                    }
                    if (options.allowFail) return code;
                    throw new Error(`${engine} ${signature} exited ${code}`);
                }
                state.container = {
                    inspect: inspectFromRunArgs(
                        engine,
                        args,
                        state.images,
                        state.volumes,
                    ),
                    logs: '[ploinky-box] self-check OK\n',
                    coreStatus: 0,
                    coreStdout: 'core: running\n',
                    depsInstalled: true,
                };
                if (signature === 'run replacement') {
                    reconciliationRunState = 'replacement-created';
                } else if (signature === 'run rollback') {
                    reconciliationRunState = 'idle';
                }
                return 0;
            }
            if (args[0] === 'start') {
                const failed = fail('start', options);
                if (failed) return failed;
                if (state.container) {
                    state.container.inspect.State.Status = 'running';
                    state.container.inspect.State.Running = true;
                }
                return 0;
            }
            if (args[0] === 'stop') {
                const failed = fail('stop', options);
                if (failed) return failed;
                if (state.container) {
                    state.container.inspect.State.Status = 'exited';
                    state.container.inspect.State.Running = false;
                }
                return 0;
            }
            if (args[0] === 'rm') {
                const failed = fail('rm container', options);
                if (failed) return failed;
                if (state.container) {
                    if (reconciliationRunState === 'replacement-created') {
                        reconciliationRunState = 'rollback-ready';
                    } else if (
                        reconciliationRunState === 'idle'
                        && inspectedOld
                    ) {
                        reconciliationRunState = 'replacement-ready';
                    }
                }
                inspectedOld = false;
                state.container = null;
                return 0;
            }
            if (args[0] === 'volume' && args[1] === 'rm') {
                const failed = fail('volume rm', options);
                if (failed) return failed;
                for (const name of args.slice(2)) state.volumes.delete(name);
                return 0;
            }
            if (args[0] === 'exec') {
                const stopIndex = args.indexOf('ploinky');
                if (stopIndex !== -1 && args[stopIndex + 1] === 'stop') {
                    return fail('exec ploinky stop', options);
                }
                if (stopIndex !== -1 && args[stopIndex + 1] === 'status') {
                    const code = state.container?.coreStatus || 0;
                    if (state.container?.coreStdout) {
                        stdout.write(state.container.coreStdout);
                    }
                    if (code !== 0 && !options.allowFail) {
                        throw new Error(`${engine} exec ploinky status exited ${code}`);
                    }
                    return code;
                }
                return 0;
            }
            return 0;
        },
        streamContains(args, needle) {
            calls.push({
                kind: 'streamContains',
                args: [...args],
                options: { needle },
            });
            return Promise.resolve(
                String(state.container?.logs || '').includes(needle),
            );
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
    const failures = options.failures || {};
    const waitHealthy = async (_cfg, phase) => {
        fake.calls.push({
            kind: 'health',
            phase,
            args: [],
            options: { phase },
        });
        const code = failureCode(failures, `health ${phase}`);
        if (code !== 0) {
            throw new Error(`health ${phase} exited ${code}`);
        }
    };
    const dependencies = {
        stdout: Object.assign(stdout.stream, {
            isTTY: Boolean(options.stdoutIsTTY),
        }),
        stderr: stderr.stream,
        stdin,
        cwd: options.cwd || '/workspace/demo',
        env: {
            PLOINKY_BOX_BRANCH: 'main',
            ...(options.env || {}),
        },
        detectEngine: () => engine,
        engineClient: fake.engineClient,
        sleep: async () => {},
        waitHealthy,
        portInUse: async () => false,
        askLine: async (text) => {
            prompt += text;
            stdout.stream.write(text);
            return options.answer ?? null;
        },
        fetch: async () => options.fetchResponse || { ok: false },
    };
    const rawSupervisor = createRuntimeSupervisor(dependencies);
    const supervisor = {
        run(argv) {
            return runSupervisorWithBoundary(
                rawSupervisor,
                argv,
                stderr.stream,
            );
        },
    };
    return {
        supervisor,
        rawSupervisor,
        calls: fake.calls,
        state: fake.state,
        get stdout() {
            return stdout.text();
        },
        get stderr() {
            return stderr.text();
        },
        get prompt() {
            return prompt;
        },
    };
}
