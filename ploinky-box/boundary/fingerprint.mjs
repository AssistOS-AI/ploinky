import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function assertRepositoryPath(relativePath) {
    if (typeof relativePath !== 'string' || relativePath.length === 0) {
        throw new TypeError('Repository paths must be nonempty strings');
    }
    if (path.isAbsolute(relativePath)) {
        throw new TypeError(`Repository path must be relative: ${relativePath}`);
    }

    const normalized = path.posix.normalize(relativePath.replaceAll(path.sep, '/'));
    if (normalized === '..' || normalized.startsWith('../')) {
        throw new TypeError(`Repository path escapes its root: ${relativePath}`);
    }
    return normalized;
}

export function fingerprintPath(repositoryRoot, relativePath) {
    const safePath = assertRepositoryPath(relativePath);
    const absolutePath = path.join(repositoryRoot, safePath);
    let stat;

    try {
        stat = fs.lstatSync(absolutePath);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return {
                kind: 'missing',
                mode: null,
                sha256: null,
            };
        }
        throw error;
    }

    let bytes = Buffer.alloc(0);
    let kind = 'other';
    if (stat.isSymbolicLink()) {
        bytes = Buffer.from(fs.readlinkSync(absolutePath));
        kind = 'symlink';
    } else if (stat.isFile()) {
        bytes = fs.readFileSync(absolutePath);
        kind = 'file';
    } else if (stat.isDirectory()) {
        kind = 'directory';
    }

    return {
        kind,
        mode: (stat.mode & 0o177777).toString(8).padStart(6, '0'),
        sha256: sha256(bytes),
    };
}

export function fingerprintsEqual(left, right) {
    return left?.kind === right?.kind
        && left?.mode === right?.mode
        && left?.sha256 === right?.sha256;
}
