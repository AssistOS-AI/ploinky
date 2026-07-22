const runtimeShellSource = `
export function runOuterRuntimeShell() {
    const configuredStatus = process.env.PLOINKY_TEST_RUNTIME_SHELL_STATUS;
    if (configuredStatus !== undefined && Number.isInteger(Number(configuredStatus))) {
        return Number(configuredStatus);
    }
    throw new Error(
        "cli: parameterless 'cli' requires the managed Ploinky runtime. "
        + "Run it through the host 'ploinky cli' command."
    );
}
`;
const runtimeShellStub =
    'data:text/javascript;charset=utf-8,' + encodeURIComponent(runtimeShellSource);

export async function resolve(specifier, context, nextResolve) {
    const resolved = await nextResolve(specifier, context);
    const pathname = new URL(resolved.url).pathname;
    if (pathname.endsWith('/cli/sandbox/runtimeShell.js')) {
        return { url: runtimeShellStub, shortCircuit: true };
    }
    const isHelpModule = pathname.endsWith('/cli/commands/help.js');
    if (pathname.endsWith('/cli/main.js')
        || (pathname.includes('/cli/commands/') && !isHelpModule)) {
        throw new Error('FORBIDDEN_CORE_MODULE:' + pathname);
    }
    return resolved;
}
