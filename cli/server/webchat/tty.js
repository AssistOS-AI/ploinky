import { buildExecArgs } from '../../services/docker/index.js';
import { spawn } from 'child_process';

import fs from 'fs';
import os from 'os';

function safeProcessCwd() {
    try {
        const cwd = process.cwd();
        if (cwd && fs.existsSync(cwd)) return cwd;
    } catch (_) { }
    try {
        const home = os.homedir();
        if (home && fs.existsSync(home)) return home;
    } catch (_) { }
    return '/';
}

// Escape special characters for shell arguments
function shellEscape(str) {
    if (!str) return '';
    // If string contains spaces, quotes, or special chars, wrap in single quotes and escape internal quotes
    if (/[\s'"$`\\!]/.test(str)) {
        return "'" + String(str).replace(/'/g, "'\\''") + "'";
    }
    return String(str);
}

function buildRawTtyPrefix() {
    return 'command -v stty >/dev/null 2>&1 && stty -icanon -echo 2>/dev/null || true';
}

function shouldAppendIdentityArgs(command) {
    const raw = String(command || '').trim();
    if (!raw) {
        return false;
    }
    const firstToken = raw.split(/\s+/, 1)[0];
    return !/^(?:\/bin\/)?(?:ba)?sh$/i.test(firstToken);
}

function createTTYFactory({ runtime, containerName, workdir, entry }) {
    const DEBUG = process.env.WEBTTY_DEBUG === '1';
    const log = (...args) => { if (DEBUG) console.log('[webchat][tty]', ...args); };
    const factory = (ssoUser) => {
        const wd = workdir || safeProcessCwd();
        const env = { ...process.env, TERM: 'xterm-256color' };

        // Build SSO CLI arguments (no env vars)
        const ssoCliArgs = [];
        if (ssoUser) {
            if (ssoUser.username) {
                ssoCliArgs.push(`--sso-user=${shellEscape(ssoUser.username)}`);
            }
            if (ssoUser.id) {
                ssoCliArgs.push(`--sso-user-id=${shellEscape(ssoUser.id)}`);
            }
            if (ssoUser.email) {
                ssoCliArgs.push(`--sso-email=${shellEscape(ssoUser.email)}`);
            }
            if (Array.isArray(ssoUser.roles) && ssoUser.roles.length) {
                const rolesStr = ssoUser.roles.join(',');
                ssoCliArgs.push(`--sso-roles=${rolesStr}`);
            }
            if (ssoUser.sessionId) {
                ssoCliArgs.push(`--sso-session-id=${shellEscape(ssoUser.sessionId)}`);
            }
        }
        if (!ssoCliArgs.length) {
            ssoCliArgs.push('--sso-user=guest', '--sso-user-id=guest', '--sso-roles=guest');
        }

        // Append SSO args to entry command
        let shellCmd = entry && String(entry).trim()
            ? entry
            : "(command -v /bin/bash >/dev/null 2>&1 && exec /bin/bash) || exec /bin/sh";

        if (ssoCliArgs.length > 0 && shouldAppendIdentityArgs(shellCmd)) {
            shellCmd = `${shellCmd} ${ssoCliArgs.join(' ')}`;
        }

        shellCmd = `${buildRawTtyPrefix()}; ${shellCmd}`;

        // Use interactive mode but NO TTY allocation - this ensures stdin EOF propagates
        // to the container process when the host connection closes
        const execArgs = buildExecArgs(containerName, wd, shellCmd, true, false);
        let ptyProc = null;
        const outputHandlers = new Set();
        const closeHandlers = new Set();

        const emitOutput = (data) => {
            for (const h of outputHandlers) {
                try { h(data); } catch (_) { }
            }
        };
        const emitClose = () => {
            for (const h of closeHandlers) {
                try { h(); } catch (_) { }
            }
        };

        try {
            ptyProc = spawn(runtime, execArgs, {
                cwd: safeProcessCwd(),
                env,
                detached: true,                 // own process group: global.processKill(-pid) reaps the tree
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            // Deliver strings (not Buffers) so the handler's JSON.stringify(data) stays byte-correct.
            ptyProc.stdout.setEncoding('utf8');
            ptyProc.stderr.setEncoding('utf8');
            log('spawned child', { runtime, containerName, pid: ptyProc.pid });
            ptyProc.stdout.on('data', emitOutput);
            ptyProc.stderr.on('data', emitOutput);
            ptyProc.on('error', (e) => {
                log('child error', e?.message || e);
                emitClose();
            });
            ptyProc.on('close', () => {
                log('child close');
                emitClose();
            });
        } catch (e) {
            log('child spawn failed', e?.message || e);
            throw e;
        }

        return {
            get pid() { return ptyProc?.pid; },
            onOutput(handler) {
                if (handler) outputHandlers.add(handler);
                return () => outputHandlers.delete(handler);
            },
            onClose(handler) {
                if (handler) closeHandlers.add(handler);
                return () => closeHandlers.delete(handler);
            },
            write(data) {
                if (DEBUG) log('write', { bytes: Buffer.byteLength(data || '') });
                try { ptyProc?.stdin?.write?.(data); } catch (e) { log('write error', e?.message || e); }
            },
            kill() {
                const pid = ptyProc?.pid;
                try { ptyProc?.kill?.(); } catch (_) { }
                // Try to kill process group for thorough cleanup
                if (pid) {
                    try { global.processKill(-pid, 'SIGTERM'); } catch (_) { }
                }
            },
            dispose() {
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

export { createTTYFactory, createLocalTTYFactory };

function createLocalTTYFactory({ workdir, command }) {
    const DEBUG = process.env.WEBTTY_DEBUG === '1';
    const log = (...args) => { if (DEBUG) console.log('[webchat][tty-local]', ...args); };
    const factory = (ssoUser) => {
        const wd = workdir || process.cwd();
        // PLOINKY_NO_TTY=1 ensures stdin EOF propagates when webchat connection closes.
        const env = { ...process.env, TERM: 'xterm-256color', PLOINKY_NO_TTY: '1' };

        // Build SSO CLI arguments (no env vars)
        const ssoCliArgs = [];
        if (ssoUser) {
            if (ssoUser.username) {
                ssoCliArgs.push(`--sso-user=${shellEscape(ssoUser.username)}`);
            }
            if (ssoUser.id) {
                ssoCliArgs.push(`--sso-user-id=${shellEscape(ssoUser.id)}`);
            }
            if (ssoUser.email) {
                ssoCliArgs.push(`--sso-email=${shellEscape(ssoUser.email)}`);
            }
            if (Array.isArray(ssoUser.roles) && ssoUser.roles.length) {
                const rolesStr = ssoUser.roles.join(',');
                ssoCliArgs.push(`--sso-roles=${rolesStr}`);
            }
            if (ssoUser.sessionId) {
                ssoCliArgs.push(`--sso-session-id=${shellEscape(ssoUser.sessionId)}`);
            }
        }
        if (!ssoCliArgs.length) {
            ssoCliArgs.push('--sso-user=guest', '--sso-user-id=guest', '--sso-roles=guest');
        }

        let ptyProc = null;
        let disposed = false;
        const outputHandlers = new Set();
        const closeHandlers = new Set();
        const restartWindowMs = 60 * 1000;
        const maxRestartsInWindow = 5;
        const restartTimestamps = [];
        const emitOutput = (data) => {
            for (const h of outputHandlers) {
                try { h(data); } catch (_) { }
            }
        };
        const emitClose = () => {
            for (const h of closeHandlers) {
                try { h(); } catch (_) { }
            }
        };

        function canRestart() {
            const now = Date.now();
            while (restartTimestamps.length > 0 && (now - restartTimestamps[0]) > restartWindowMs) {
                restartTimestamps.shift();
            }
            if (restartTimestamps.length >= maxRestartsInWindow) {
                return false;
            }
            restartTimestamps.push(now);
            return true;
        }

        const hasCustom = !!(command && String(command).trim());
        const parentShell = process.env.WEBCHAT_SHELL || process.env.SHELL || '/bin/sh';
        const fallbackEntry = 'command -v /bin/bash >/dev/null 2>&1 && exec /bin/bash || exec /bin/sh';

        function startProc({ entry, isFallback } = {}) {
            let useEntry = entry && String(entry).trim() ? String(entry) : fallbackEntry;

            // Append SSO args to command
            if (ssoCliArgs.length > 0 && shouldAppendIdentityArgs(useEntry)) {
                useEntry = `${useEntry} ${ssoCliArgs.join(' ')}`;
            }

            const rawTtyPrefix = buildRawTtyPrefix();
            const shCmd = hasCustom
                ? `cd '${wd}' && ${rawTtyPrefix} && exec ${useEntry}`
                : `cd '${wd}' && ${rawTtyPrefix} && ${useEntry}`;
            try {
                ptyProc = spawn(parentShell, ['-lc', shCmd], {
                    cwd: wd,
                    env,
                    detached: true,                 // own process group: global.processKill(-pid) reaps the tree
                    stdio: ['pipe', 'pipe', 'pipe'],
                });
                ptyProc.stdout.setEncoding('utf8');
                ptyProc.stderr.setEncoding('utf8');
                ptyProc.stdout.on('data', emitOutput);
                ptyProc.stderr.on('data', emitOutput);
                ptyProc.on('error', (e) => {
                    log('local child error', e?.message || e);
                    emitClose();
                });
                ptyProc.on('close', () => {
                    log('local child close', { isFallback: !!isFallback });
                    if (disposed) {
                        emitClose();
                        return;
                    }
                    if (!isFallback && hasCustom) {
                        if (canRestart()) {
                            setTimeout(() => {
                                if (disposed) {
                                    emitClose();
                                    return;
                                }
                                try {
                                    startProc({ entry: String(command), isFallback: false });
                                } catch (_) {
                                    emitClose();
                                }
                            }, 250);
                            return;
                        }
                        emitOutput('[webchat] Agent process exited repeatedly. Closing session.\n');
                        emitClose();
                        return;
                    }
                    emitClose();
                });
            } catch (e) {
                log('local child spawn failed', e?.message || e);
                throw e;
            }
        }

        // Start with custom command if provided; otherwise open a local shell.
        startProc({ entry: hasCustom ? String(command) : fallbackEntry, isFallback: !hasCustom });

        return {
            get pid() { return ptyProc?.pid; },
            onOutput(handler) { if (handler) outputHandlers.add(handler); return () => outputHandlers.delete(handler); },
            onClose(handler) { if (handler) closeHandlers.add(handler); return () => closeHandlers.delete(handler); },
            write(data) { try { ptyProc?.stdin?.write?.(data); } catch (e) { log('write error', e?.message || e); } },
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
