import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    ACTIVATION_MARKER_MAX_BYTES,
    activationMarkerPath,
    parseActivationBarrierMarker,
    readActivationBarrierMarker,
} from '../../cli/sandbox/activationRecords.mjs';
import { readBoxWorkspaceRoot } from '../contract/workspace-root.mjs';

// Runs inside the Box: the host installs, rewrites or removes the activation
// barrier marker here while a Box runs, under its workspace lock, so a Box
// process that swaps a workspace path can redirect this write only where the
// Box can already write. Only the host writes the marker; the in-Box lease
// point reads it (activationRecords.mjs).

async function readInput(input) {
    const chunks = [];
    let size = 0;
    for await (const chunk of input) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > ACTIVATION_MARKER_MAX_BYTES) throw new Error('The activation barrier marker is too large');
        chunks.push(bytes);
    }
    return Buffer.concat(chunks);
}

function fsyncDirectory(directory) {
    let fd;
    try {
        fd = fs.openSync(directory, fs.constants.O_RDONLY);
        fs.fsyncSync(fd);
    } catch (error) {
        if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF'].includes(error?.code)) throw error;
    } finally {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch (_) {}
        }
    }
}

function selectedRoot(workspaceRoot) {
    if (!path.isAbsolute(String(workspaceRoot || ''))) throw new Error('PLOINKY_WORKSPACE_ROOT must be an absolute path');
    return path.resolve(String(workspaceRoot));
}

export async function writeBoxActivationBarrierMarker({
    workspaceRoot = readBoxWorkspaceRoot(process.env),
    input = process.stdin,
} = {}) {
    const root = selectedRoot(workspaceRoot);
    const bytes = await readInput(input);
    const parsed = parseActivationBarrierMarker(bytes.toString('utf8'));
    if (parsed.state !== 'valid') throw new Error('The activation barrier marker is malformed');
    const file = activationMarkerPath(root);
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    let fd;
    try {
        fd = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        fs.renameSync(temporary, file);
        fsyncDirectory(directory);
    } catch (error) {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch (_) {}
        }
        try { fs.rmSync(temporary, { force: true }); } catch (_) {}
        throw error;
    }
    return Object.freeze({ digest: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length });
}

// Remove the marker only when it is the one of the named operation.
export async function removeBoxActivationBarrierMarker({
    workspaceRoot = readBoxWorkspaceRoot(process.env),
    input = process.stdin,
} = {}) {
    const root = selectedRoot(workspaceRoot);
    const request = JSON.parse((await readInput(input)).toString('utf8'));
    if (!/^[0-9a-f]{32}$/.test(String(request?.operationId || ''))) throw new Error('The marker removal requires an operation id');
    const current = readActivationBarrierMarker({ workspaceRoot: root });
    if (current.state === 'absent') return Object.freeze({ removed: false });
    if (current.state !== 'present' || current.marker.operationId !== request.operationId) {
        throw new Error('The activation barrier marker belongs to another operation; it was kept');
    }
    fs.unlinkSync(activationMarkerPath(root));
    fsyncDirectory(path.dirname(activationMarkerPath(root)));
    return Object.freeze({ removed: true });
}

// Node gives import.meta.url the real path, while argv[1] keeps a symlinked path
// as typed, so a run through a symlinked checkout also compares the real path.
function isDirectExecution() {
    if (!process.argv[1]) return false;
    const invokedPath = path.resolve(process.argv[1]);
    if (import.meta.url === pathToFileURL(invokedPath).href) return true;
    try { return import.meta.url === pathToFileURL(fs.realpathSync(invokedPath)).href; } catch { return false; }
}

if (isDirectExecution()) {
    try {
        const action = process.argv[2];
        if (action === 'write') {
            process.stdout.write(`${JSON.stringify(await writeBoxActivationBarrierMarker())}\n`);
        } else if (action === 'remove') {
            process.stdout.write(`${JSON.stringify(await removeBoxActivationBarrierMarker())}\n`);
        } else {
            throw new Error('Usage: activation-barrier-marker.mjs write|remove');
        }
    } catch (error) {
        process.stderr.write(`[ploinky-box] ACTIVATION BARRIER MARKER FAILED: ${error?.message || String(error)}\n`);
        process.exitCode = 1;
    }
}
