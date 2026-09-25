// Resolve hooks for dependencyStoreBwrapHostShim.mjs (not a test file).

const TARGET = '/cli/sandbox/bwrap/bwrapServiceManager.js';
const SHIMS = {
    child_process: new URL('./dependencyStoreBwrapChildProcessShim.mjs', import.meta.url).href,
    fs: new URL('./dependencyStoreBwrapFsShim.mjs', import.meta.url).href,
};

export async function resolve(specifier, context, nextResolve) {
    const bare = specifier.replace(/^node:/, '');
    if (context.parentURL && context.parentURL.endsWith(TARGET) && SHIMS[bare]) {
        return { url: SHIMS[bare], shortCircuit: true };
    }
    return nextResolve(specifier, context);
}
