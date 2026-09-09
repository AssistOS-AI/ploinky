import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sanitizeDiagnosticText } from './diagnosticText.js';

const MAX_DIAGNOSTIC_LENGTH = 8192;

export function sanitizeGitDiagnostic(value) {
    const text = String(value || '')
        .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[redacted]@')
        .replace(/([?&](?:access_token|token|password|secret|key)=)[^\s&#]+/gi, '$1[redacted]')
        .replace(/(authorization:\s*(?:basic|bearer)\s+)\S+/gi, '$1[redacted]');
    return sanitizeDiagnosticText(text, { limit: Number.MAX_SAFE_INTEGER, fallback: '' });
}

function diagnosticTail(fd) {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - MAX_DIAGNOSTIC_LENGTH);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    let tail = buffer.toString('utf8');
    // Discard the first partial line: truncating inside a credential could hide
    // its identifying prefix from the sanitizer.
    if (start) {
        const boundary = tail.search(/[\r\n]/);
        tail = boundary < 0 ? '' : tail.slice(boundary + 1);
    }
    const text = sanitizeGitDiagnostic(tail).trim();
    return start ? `[earlier output omitted]\n${text}`.trim() : text;
}

// Capture stderr even for inherited output so a bulk update can repeat Git's
// actual reason in its final summary. Keep stdout and stdin behavior unchanged.
export function runGitCommand(args, { stdio = 'inherit', ...options } = {}) {
    const streams = Array.isArray(stdio) ? [...stdio] : [stdio, stdio, stdio];
    const stderrTarget = streams[2];
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-git-'));
    const stderrPath = path.join(tempDir, 'stderr');
    let fd;
    let result;
    let detail;
    try {
        fd = fs.openSync(stderrPath, 'wx+', 0o600);
        // An anonymous file keeps raw Git output out of persisted logs and
        // avoids killing otherwise successful commands on a pipe buffer limit.
        fs.unlinkSync(stderrPath);
        streams[2] = fd;
        result = spawnSync('git', args, { ...options, stdio: streams });
        detail = diagnosticTail(fd);
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
    if (detail && (stderrTarget === 'inherit' || stderrTarget === 2)) {
        process.stderr.write(`${detail}\n`);
    }
    if (result.error || result.status !== 0) {
        const command = sanitizeGitDiagnostic(['git', ...args].join(' '));
        const reason = result.error
            ? sanitizeGitDiagnostic(result.error.message)
            : result.signal ? `terminated by ${result.signal}` : `exited with status ${result.status}`;
        const error = new Error(`${command}: ${reason}${detail ? `\n${detail}` : ''}`);
        error.status = result.status;
        error.signal = result.signal;
        error.code = result.error?.code;
        error.stderr = detail;
        throw error;
    }
    return result.stdout;
}
