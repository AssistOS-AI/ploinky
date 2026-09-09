import fsDefault from 'node:fs';
import pathDefault from 'node:path';

export const VERIFIED_JSON_MAX_DEPTH = 64;
export const VERIFIED_JSON_MAX_NODES = 100_000;

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function verifiedFileError(message) {
    const error = new Error(message);
    error.code = 'VERIFIED_FILE_INVALID';
    return error;
}

export function assertSafeRelativeSegment(segment, label = 'file path component') {
    const value = String(segment ?? '');
    if (!SAFE_PATH_SEGMENT.test(value)) {
        throw verifiedFileError(`${label} '${value}' is not one safe path component`);
    }
    return value;
}

function lstatOrAbsent(fsApi, target) {
    try {
        return fsApi.lstatSync(target);
    } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
        throw verifiedFileError(`verified path '${target}' is unreadable`);
    }
}

// Creates only the final expected directory. Directory permissions, ownership,
// and symlinks follow normal filesystem behavior; missing parents are not created.
export function ensureVerifiedProducerDirectory({
    trustedRoot,
    relativeSegments = [],
    mode = 0o700,
    fsApi = fsDefault,
    pathApi = pathDefault,
} = {}) {
    const rootInput = String(trustedRoot || '').trim();
    if (!rootInput || !Array.isArray(relativeSegments) || relativeSegments.length === 0) {
        throw verifiedFileError('a producer directory requires one trusted root and relative path');
    }
    const segments = relativeSegments.map((segment) => {
        const value = String(segment ?? '');
        return value === '.ploinky' ? value : assertSafeRelativeSegment(value, 'producer path component');
    });
    const root = pathApi.resolve(rootInput);
    const rootStat = lstatOrAbsent(fsApi, root);
    if (!rootStat) throw verifiedFileError(`producer root '${root}' does not exist`);

    let current = root;
    for (let index = 0; index < segments.length; index += 1) {
        current = pathApi.join(current, segments[index]);
        const stat = lstatOrAbsent(fsApi, current);
        if (!stat) {
            if (index !== segments.length - 1) {
                throw verifiedFileError(`producer parent '${current}' does not exist`);
            }
            try {
                fsApi.mkdirSync(current, { mode });
            } catch (error) {
                throw verifiedFileError(`producer directory '${current}' could not be created safely: ${error?.message || error}`);
            }
        }
    }

    return current;
}

// Follows normal directory paths and pins the final regular inode. Missing
// components return null; symlinked files and file replacement are rejected.
export function openVerifiedRegularFile({
    trustedRoot,
    relativeSegments = [],
    fsApi = fsDefault,
    pathApi = pathDefault,
} = {}) {
    const rootInput = String(trustedRoot || '').trim();
    if (!rootInput) throw verifiedFileError('a verified file requires one trusted root');
    if (!Array.isArray(relativeSegments) || relativeSegments.length === 0) {
        throw verifiedFileError('a verified file requires at least one path component');
    }
    const segments = relativeSegments.map((segment) => assertSafeRelativeSegment(segment));
    const root = pathApi.resolve(rootInput);

    const rootStat = lstatOrAbsent(fsApi, root);
    if (!rootStat) return null;

    let current = root;
    for (const segment of segments.slice(0, -1)) {
        current = pathApi.join(current, segment);
        const stat = lstatOrAbsent(fsApi, current);
        if (!stat) return null;
    }

    const filePath = pathApi.join(current, segments.at(-1));
    const fileStat = lstatOrAbsent(fsApi, filePath);
    if (!fileStat) return null;
    if (!fileStat.isFile() || fileStat.isSymbolicLink?.()) {
        throw verifiedFileError(`verified file '${filePath}' is not one regular file`);
    }

    const flags = (fsApi.constants?.O_RDONLY ?? 0) | (fsApi.constants?.O_NOFOLLOW ?? 0);
    let descriptor;
    try {
        descriptor = fsApi.openSync(filePath, flags);
    } catch (_) {
        throw verifiedFileError(`verified file '${filePath}' could not be opened safely`);
    }
    try {
        const opened = fsApi.fstatSync(descriptor);
        if (!opened.isFile()
            || opened.dev !== fileStat.dev
            || opened.ino !== fileStat.ino) {
            throw verifiedFileError(`verified file '${filePath}' was replaced during validation`);
        }
        return Object.freeze({
            descriptor,
            path: filePath,
            dev: opened.dev,
            ino: opened.ino,
        });
    } catch (error) {
        try { fsApi.closeSync(descriptor); } catch (_) {}
        throw error;
    }
}

function validateAndFreezeJsonTree(root, { maxDepth, maxNodes }) {
    const stack = [{ value: root, depth: 1 }];
    const objects = [];
    let nodes = 0;
    while (stack.length) {
        const { value, depth } = stack.pop();
        if (!value || typeof value !== 'object') continue;
        nodes += 1;
        if (nodes > maxNodes) {
            throw verifiedFileError(`verified JSON exceeds the ${maxNodes}-node limit`);
        }
        if (depth > maxDepth) {
            throw verifiedFileError(`verified JSON exceeds the depth limit of ${maxDepth}`);
        }
        objects.push(value);
        const children = Array.isArray(value) ? value : Object.values(value);
        for (const child of children) {
            if (child && typeof child === 'object') stack.push({ value: child, depth: depth + 1 });
        }
    }
    for (let index = objects.length - 1; index >= 0; index -= 1) Object.freeze(objects[index]);
    return root;
}

export function readVerifiedJsonObject({
    trustedRoot,
    relativeSegments,
    byteLimit,
    absent = null,
    maxDepth = VERIFIED_JSON_MAX_DEPTH,
    maxNodes = VERIFIED_JSON_MAX_NODES,
    fsApi = fsDefault,
    pathApi = pathDefault,
} = {}) {
    if (!Number.isSafeInteger(byteLimit) || byteLimit < 1) {
        throw verifiedFileError('verified JSON requires one positive byte limit');
    }
    const opened = openVerifiedRegularFile({ trustedRoot, relativeSegments, fsApi, pathApi });
    if (!opened) return absent;

    let bytes;
    try {
        const before = fsApi.fstatSync(opened.descriptor);
        if (!before.isFile() || before.size > byteLimit) {
            throw verifiedFileError(`verified JSON exceeds the ${byteLimit}-byte limit`);
        }
        if (!Number.isSafeInteger(before.size) || before.size < 1) {
            throw verifiedFileError('verified JSON is empty or has an invalid size');
        }

        bytes = Buffer.allocUnsafe(before.size);
        let offset = 0;
        while (offset < before.size) {
            const count = fsApi.readSync(
                opened.descriptor,
                bytes,
                offset,
                Math.min(64 * 1024, before.size - offset),
                offset,
            );
            if (count <= 0) break;
            offset += count;
        }

        const after = fsApi.fstatSync(opened.descriptor);
        const currentPath = lstatOrAbsent(fsApi, opened.path);
        if (offset !== before.size
            || after.size !== before.size
            || after.dev !== before.dev
            || after.ino !== before.ino
            || !currentPath
            || currentPath.dev !== before.dev
            || currentPath.ino !== before.ino) {
            throw verifiedFileError('verified JSON changed during read');
        }
    } finally {
        try { fsApi.closeSync(opened.descriptor); } catch (_) {}
    }

    let parsed;
    try {
        parsed = JSON.parse(bytes.toString('utf8'));
    } catch (_) {
        throw verifiedFileError('verified JSON is not one valid JSON document');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw verifiedFileError('verified JSON must contain one top-level object');
    }
    return validateAndFreezeJsonTree(parsed, { maxDepth, maxNodes });
}
