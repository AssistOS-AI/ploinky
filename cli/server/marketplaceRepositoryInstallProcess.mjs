import { fileURLToPath } from 'node:url';
import { readInstallFrames, writeInstallFrame, installUnitError } from './marketplaceRepositoryInstallUnit.mjs';

export function startRepositoryInstallProcess({ input = process.stdin, output = process.stdout,
    operationId = process.env.PLOINKY_MARKETPLACE_REPOSITORY_OPERATION,
    load = () => import('../utils/repos.js'), environment = process.env,
    finish = code => { process.exitCode = code; input.destroy(); } } = {}) {
    let state = 'ready';
    const send = frame => writeInstallFrame(output, { ...frame, operationId });
    const fail = () => { if (state !== 'closed') { state = 'closed'; finish(1); } };
    if (!/^[a-f0-9-]{36}$/.test(operationId || '')) { fail(); return; }
    readInstallFrames(input, frame => {
        if (frame.operationId !== operationId) throw installUnitError();
        if (frame.type === 'release' && ['ready', 'barrier'].includes(state) && Object.keys(frame).length === 2) {
            state = 'closed'; finish(0); return;
        }
        if (frame.type !== 'run' || state !== 'ready' || Object.keys(frame).length !== 5
            || frame.operation?.action !== 'install_repo' || typeof frame.workspaceRoot !== 'string'
            || !frame.environment || typeof frame.environment !== 'object' || Array.isArray(frame.environment)
            || Object.entries(frame.environment).some(([key, value]) => typeof value !== 'string' || key.includes('\0') || value.includes('\0'))) {
            throw installUnitError();
        }
        state = 'running';
        // Environment and repository imports become available only after the
        // outer lease owner has received the Router's authorization.
        for (const [key, value] of Object.entries(frame.environment)) {
            if (!['NODE_OPTIONS', 'NODE_PATH', 'NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE'].includes(key)) environment[key] = value;
        }
        environment.PLOINKY_WORKSPACE_ROOT = frame.workspaceRoot;
        environment.TMPDIR = '/tmp';
        environment.TMP = '/tmp';
        environment.TEMP = '/tmp';
        void (async () => {
            let outcome;
            try {
                const { installRepo } = await load();
                const { sanitizeGitDiagnostic } = await import('../utils/gitCommand.js');
                const { url, name, branch } = frame.operation;
                const result = await installRepo(url, name, branch, { stdio: 'pipe' });
                const safe = value => typeof value === 'string' ? sanitizeGitDiagnostic(value)
                    : Array.isArray(value) ? value.map(safe)
                        : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, safe(entry)])) : value;
                outcome = { ok: true, result: safe(result) };
            } catch (error) {
                const { sanitizeGitDiagnostic } = await import('../utils/gitCommand.js');
                outcome = { ok: false, error: {
                    message: sanitizeGitDiagnostic(error?.message || 'Repository operation failed.').slice(0, 8192),
                    ...(typeof error?.code === 'string' && /^[A-Za-z0-9_]{1,96}$/.test(error.code) ? { code: error.code } : {}),
                } };
            }
            if (state !== 'running') return;
            state = 'barrier'; send({ type: 'barrier', outcome });
        })().catch(fail);
    }, fail);
    input.on('end', () => { if (state !== 'closed') fail(); });
    send({ type: 'ready' });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    // Reserve stdout for the fixed protocol; repository logging is drained by
    // the outer supervisor and never interpreted as a control frame.
    const output = { writable: true, destroyed: false, write: process.stdout.write.bind(process.stdout) };
    process.stdout.write = process.stderr.write.bind(process.stderr);
    startRepositoryInstallProcess({ output });
}
