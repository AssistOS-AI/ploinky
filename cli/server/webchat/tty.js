import { spawn } from 'child_process';

import path from 'node:path';

function isWritableChild(child) {
    return Boolean(
        child
        && child.exitCode === null
        && child.signalCode === null
        && child.stdin
        && child.stdin.writable
        && !child.stdin.destroyed
    );
}

function withoutWebchatSessionEnv(baseEnv) {
    const env = { ...baseEnv };
    for (const key of Object.keys(env)) {
        if (key.startsWith('PLOINKY_WEBCHAT_')) delete env[key];
    }
    return env;
}

export { createLocalTTYFactory };

function exactIdentityValue(value) {
    const text = String(value ?? '');
    if (!text || text.includes('\0') || Buffer.byteLength(text) > 4096) {
        return '';
    }
    return text;
}

function createLocalTTYFactory({ workdir, executable, argv, spawnImpl = spawn }) {
    const exactExecutable = typeof executable === 'string' ? executable : '';
    const exactArgv = Array.isArray(argv) ? [...argv] : [];
    if (!exactExecutable
        || exactExecutable.includes('\0')
        || !path.isAbsolute(exactExecutable)
        || !workdir
        || workdir.includes('\0')
        || exactArgv.some((argument) => typeof argument !== 'string' || argument.includes('\0'))
        || !exactArgv.includes('--')) {
        const error = new Error('WebChat direct CLI launch is unavailable');
        error.code = 'PLOINKY_WEBCHAT_DIRECT_CLI_UNAVAILABLE';
        error.status = 503;
        throw error;
    }
    const DEBUG = process.env.WEBTTY_DEBUG === '1';
    const log = (...args) => { if (DEBUG) console.log('[webchat][tty-local]', ...args); };
    const factory = (ssoUser) => {
        const wd = workdir;
        // PLOINKY_NO_TTY=1 ensures stdin EOF propagates when webchat connection closes.
        const env = withoutWebchatSessionEnv({
            ...process.env,
            TERM: 'xterm-256color',
            PLOINKY_NO_TTY: '1'
        });

        // Build SSO CLI arguments (no env vars)
        const ssoCliArgs = [];
        if (ssoUser) {
            const username = exactIdentityValue(ssoUser.username);
            const id = exactIdentityValue(ssoUser.id);
            const email = exactIdentityValue(ssoUser.email);
            const sessionId = exactIdentityValue(ssoUser.sessionId);
            if (username) ssoCliArgs.push(`--sso-user=${username}`);
            if (id) ssoCliArgs.push(`--sso-user-id=${id}`);
            if (email) ssoCliArgs.push(`--sso-email=${email}`);
            if (Array.isArray(ssoUser.roles) && ssoUser.roles.length) {
                const rolesStr = exactIdentityValue(ssoUser.roles.join(','));
                if (rolesStr) ssoCliArgs.push(`--sso-roles=${rolesStr}`);
            }
            if (sessionId) ssoCliArgs.push(`--sso-session-id=${sessionId}`);
        }
        if (!ssoCliArgs.length) {
            ssoCliArgs.push('--sso-user=guest', '--sso-user-id=guest', '--sso-roles=guest');
        }

        let ptyProc = null;
        let disposed = false;
        const outputHandlers = new Set();
        const closeHandlers = new Set();
        let closeEmitted = false;
        const emitOutput = (data) => {
            for (const h of outputHandlers) {
                try { h(data); } catch (_) { }
            }
        };
        const emitClose = () => {
            if (closeEmitted) return;
            closeEmitted = true;
            for (const h of closeHandlers) {
                try { h(); } catch (_) { }
            }
        };
        function startProc() {
            try {
                ptyProc = spawnImpl(exactExecutable, [...exactArgv, ...ssoCliArgs], {
                    cwd: wd,
                    env,
                    detached: true,                 // own process group: global.processKill(-pid) reaps the tree
                    stdio: ['pipe', 'pipe', 'pipe'],
                });
                ptyProc.stdout.setEncoding('utf8');
                ptyProc.stderr.setEncoding('utf8');
                ptyProc.stdout.on('data', emitOutput);
                ptyProc.stderr.on('data', emitOutput);
                ptyProc.stdin.on('error', (e) => {
                    log('local child stdin error', e?.message || e);
                });
                ptyProc.on('error', (e) => {
                    log('local child error', e?.message || e);
                    emitClose();
                });
                ptyProc.on('close', () => {
                    log('local child close');
                    emitClose();
                });
            } catch (e) {
                log('local child spawn failed', e?.message || e);
                throw e;
            }
        }

        startProc();

        return {
            get pid() { return ptyProc?.pid; },
            onOutput(handler) { if (handler) outputHandlers.add(handler); return () => outputHandlers.delete(handler); },
            onClose(handler) { if (handler) closeHandlers.add(handler); return () => closeHandlers.delete(handler); },
            isAlive() { return !disposed && isWritableChild(ptyProc); },
            write(data) {
                if (disposed || !isWritableChild(ptyProc)) return false;
                try {
                    ptyProc.stdin.write(data);
                    return true;
                } catch (e) {
                    log('write error', e?.message || e);
                    return false;
                }
            },
            kill() {
                disposed = true;
                const pid = ptyProc?.pid;
                try { ptyProc?.kill?.(); } catch (_) { }
                // Try to kill process group for thorough cleanup
                if (pid) {
                    try { global.processKill(-pid, 'SIGTERM'); } catch (_) { }
                }
            },
            dispose() {
                disposed = true;
                const pid = ptyProc?.pid;
                // First try graceful termination
                try { ptyProc?.kill?.(); } catch (_) { }
                // Kill process group
                if (pid) {
                    try { global.processKill(-pid, 'SIGTERM'); } catch (_) { }
                    // Force kill after short delay
                    setTimeout(() => {
                        try { global.processKill(-pid, 'SIGKILL'); } catch (_) { }
                        try { global.processKill(pid, 'SIGKILL'); } catch (_) { }
                    }, 500);
                }
            },
            close() { this.kill(); }
        };
    };

    return { create: factory };
}
