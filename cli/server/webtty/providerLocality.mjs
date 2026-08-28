export function probeNestedPodmanRuntime({ execFileSync, environment }) {
    if (typeof execFileSync !== 'function' || !environment || typeof environment !== 'object') {
        throw new Error('nested Podman probe dependencies are invalid');
    }
    const version = execFileSync(
        '/usr/bin/podman',
        ['version', '--format', '{{.Client.Version}}'],
        {
            cwd: '/tmp',
            env: environment,
            encoding: 'utf8',
            timeout: 2_000,
            killSignal: 'SIGKILL',
            maxBuffer: 64 * 1024,
        },
    ).trim();
    if (!/^\d+\.\d+(?:\.\d+)?(?:[-.][0-9A-Za-z.-]+)?$/.test(version)) {
        throw new Error('nested Podman version is invalid');
    }
    return 'podman';
}

export function resolveWebttyProviderLocality({
    boxProviderAvailable,
    isPloinkyBoxRuntime,
    probeRuntime,
}) {
    if (boxProviderAvailable !== true) {
        return Object.freeze({
            surfaceAvailable: false,
            boxAvailable: false,
            agentAvailable: false,
            agentReason: 'box-provider-unavailable',
        });
    }
    if (isPloinkyBoxRuntime !== true) {
        return Object.freeze({
            surfaceAvailable: true,
            boxAvailable: true,
            agentAvailable: false,
            agentReason: 'router-not-in-ploinky-box',
        });
    }
    let runtime;
    try {
        runtime = probeRuntime();
    } catch (_) {
        return Object.freeze({
            surfaceAvailable: true,
            boxAvailable: true,
            agentAvailable: false,
            agentReason: 'nested-runtime-probe-failed',
        });
    }
    return Object.freeze({
        surfaceAvailable: true,
        boxAvailable: true,
        agentAvailable: runtime === 'podman',
        agentReason: runtime === 'podman' ? 'nested-podman-local' : 'nested-podman-unavailable',
    });
}
