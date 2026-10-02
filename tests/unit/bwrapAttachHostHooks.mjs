// Test-only module hooks (not a test file) that let the production
// attachBwrapInteractive build its arguments on a host without Bubblewrap.
// A test registers them from its child process with
// `register(new URL('./bwrapAttachHostHooks.mjs', import.meta.url))`.
//
// Only for imports whose parent is bwrapServiceManager.js:
//   - `child_process` resolves to a module whose spawnSync of the absolute
//     /usr/bin/bwrap appends its argv to $BWRAP_ATTACH_CAPTURE and reports a
//     clean exit instead of launching anything;
//   - the edge-generation module resolves to a module identical to the real
//     one except that assertHostModeGenerationCapability does nothing, so the
//     interactive path can run without an active routing generation. Capability
//     denial is covered by sandboxRuntime.test.mjs.
// Every other module and every other call uses the real implementation.

const TARGET = '/cli/sandbox/bwrap/bwrapServiceManager.js';
const CHILD_PROCESS = 'ploinky-test-shim:child_process';
const EDGE_GENERATION = 'ploinky-test-shim:edge-generation';

export async function resolve(specifier, context, nextResolve) {
    if (context.parentURL && context.parentURL.endsWith(TARGET)) {
        if (specifier === 'child_process' || specifier === 'node:child_process') {
            return { url: CHILD_PROCESS, shortCircuit: true };
        }
        if (specifier === '../edgeGeneration.js') {
            const real = await nextResolve(specifier, context);
            return { url: `${EDGE_GENERATION}?real=${encodeURIComponent(real.url)}`, shortCircuit: true };
        }
    }
    return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
    if (url === CHILD_PROCESS) {
        return {
            format: 'module',
            shortCircuit: true,
            source: `
                import childProcess from 'node:child_process';
                import fs from 'node:fs';
                export * from 'node:child_process';
                export default childProcess;
                export function spawnSync(command, args, options) {
                    if (command === '/usr/bin/bwrap') {
                        fs.appendFileSync(process.env.BWRAP_ATTACH_CAPTURE, JSON.stringify({ command, args }) + '\\n');
                        return { status: 0, signal: null, output: [], pid: 0 };
                    }
                    return childProcess.spawnSync(command, args, options);
                }
            `,
        };
    }
    if (url.startsWith(`${EDGE_GENERATION}?`)) {
        const real = new URL(url).searchParams.get('real');
        return {
            format: 'module',
            shortCircuit: true,
            source: `
                export * from ${JSON.stringify(real)};
                export function assertHostModeGenerationCapability() {}
            `,
        };
    }
    return nextLoad(url, context);
}
