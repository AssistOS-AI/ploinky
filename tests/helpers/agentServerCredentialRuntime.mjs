const DEFAULT_MASTER_KEY = '8'.repeat(64);
const DEFAULT_AGENT_SECRET = 'a'.repeat(64);
const DEFAULT_PRIVATE_SECRET = 'b'.repeat(64);

export async function createAgentServerContainerEnvironment({
    tempDir,
    agentPrincipal,
    agentSecret = DEFAULT_AGENT_SECRET,
    privateSecret = DEFAULT_PRIVATE_SECRET,
    masterKey = DEFAULT_MASTER_KEY,
    origin = 'http://127.0.0.1:8080',
    publicAuthority = '127.0.0.1:8080',
} = {}) {
    if (typeof tempDir !== 'string' || !tempDir) {
        throw new TypeError('tempDir is required');
    }
    if (typeof agentPrincipal !== 'string' || !agentPrincipal) {
        throw new TypeError('agentPrincipal is required');
    }

    process.env.PLOINKY_MASTER_KEY = masterKey;
    process.env.PLOINKY_WORKSPACE_ROOT = tempDir;
    const previousCwd = process.cwd();
    let runtime;
    try {
        process.chdir(tempDir);
        const { installGeneratedRouterRuntime } = await import('./generatedRouterRuntime.mjs');
        runtime = installGeneratedRouterRuntime({
            origin,
            publicAuthority,
            tempDir,
            agentPrincipal,
        });
    } finally {
        process.chdir(previousCwd);
    }

    return Object.freeze({
        ...runtime.env,
        PLOINKY_RUNTIME: 'container',
        PLOINKY_MASTER_KEY: masterKey,
        PLOINKY_WORKSPACE_ROOT: tempDir,
        PLOINKY_AGENT_SECRET: agentSecret,
        PLOINKY_AGENT_PRIVATE_SECRET: privateSecret,
    });
}
