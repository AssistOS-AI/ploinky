import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { PloinkyBoxError } from '../errors.mjs';

export const LOCAL_AGENTLIB_DIRECTORY = '.ploinky-local-agentlib';
export const LOCAL_AGENTLIB_SHA_PATTERN = /^[a-f0-9]{64}$/;

function snapshotError(message, cause) {
    return new PloinkyBoxError(message, {
        code: 'PLOINKY_AGENTLIB_SNAPSHOT_INVALID',
        cause,
    });
}

export function sha256File(filePath, { fsApi = fs } = {}) {
    return crypto.createHash('sha256').update(fsApi.readFileSync(filePath)).digest('hex');
}

export function createLocalAgentlibSnapshot(checkoutPath, {
    fsApi = fs,
    spawn = spawnSync,
    npmCommand = 'npm',
    tempRoot = os.tmpdir(),
    env = process.env,
} = {}) {
    const selected = path.resolve(checkoutPath);
    let stat;
    try {
        stat = fsApi.lstatSync(selected);
    } catch (error) {
        throw snapshotError(`Snapshot source is missing: ${selected}`, error);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw snapshotError('Snapshot source is not a real directory');
    }
    const tempDirectory = fsApi.mkdtempSync(path.join(tempRoot, 'ploinky-agentlib-pack-'));
    fsApi.chmodSync(tempDirectory, 0o700);
    try {
        const result = spawn(npmCommand, [
            'pack', '--ignore-scripts', '--json', '--pack-destination', tempDirectory,
        ], {
            cwd: selected,
            env,
            encoding: 'utf8',
            shell: false,
        });
        if (result.error || result.status !== 0) {
            throw snapshotError(
                `npm pack failed: ${String(result.stderr || result.error?.message || '').trim()}`,
                result.error,
            );
        }
        let report;
        try {
            report = JSON.parse(String(result.stdout || ''));
        } catch (error) {
            throw snapshotError('npm pack returned malformed JSON', error);
        }
        if (!Array.isArray(report) || report.length !== 1
            || typeof report[0]?.filename !== 'string'
            || !report[0].filename.endsWith('.tgz')) {
            throw snapshotError('npm pack must describe exactly one .tgz archive');
        }
        const tempArchivePath = path.resolve(tempDirectory, report[0].filename);
        if (!tempArchivePath.startsWith(`${path.resolve(tempDirectory)}${path.sep}`)) {
            throw snapshotError('npm pack archive escaped its private temporary directory');
        }
        const archiveStat = fsApi.lstatSync(tempArchivePath);
        if (archiveStat.isSymbolicLink() || !archiveStat.isFile()) {
            throw snapshotError('npm pack archive is not a regular file');
        }
        return Object.freeze({
            sha256: sha256File(tempArchivePath, { fsApi }),
            tempArchivePath,
        });
    } catch (error) {
        try { fsApi.rmSync(tempDirectory, { recursive: true, force: true }); } catch {}
        throw error;
    }
}

export function publishLocalAgentlibSnapshot(snapshot, {
    dependenciesRoot,
    fsApi = fs,
    token = `${process.pid}-${crypto.randomBytes(8).toString('hex')}`,
} = {}) {
    if (!snapshot || !LOCAL_AGENTLIB_SHA_PATTERN.test(String(snapshot.sha256 || ''))) {
        throw snapshotError('Local AchillesAgentLib snapshot has an invalid SHA-256');
    }
    const source = path.resolve(String(snapshot.tempArchivePath || ''));
    let sourceStat;
    try {
        sourceStat = fsApi.lstatSync(source);
    } catch (error) {
        throw snapshotError('Local AchillesAgentLib temporary archive is missing', error);
    }
    if (sourceStat.isSymbolicLink() || !sourceStat.isFile()
        || sha256File(source, { fsApi }) !== snapshot.sha256) {
        throw snapshotError('Local AchillesAgentLib temporary archive failed integrity validation');
    }

    const store = path.join(path.resolve(dependenciesRoot), LOCAL_AGENTLIB_DIRECTORY);
    try {
        const storeStat = fsApi.lstatSync(store);
        if (storeStat.isSymbolicLink() || !storeStat.isDirectory()) {
            throw snapshotError('Local AchillesAgentLib archive store is not a real directory');
        }
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        fsApi.mkdirSync(store, { recursive: false, mode: 0o700 });
    }
    const destination = path.join(store, `${snapshot.sha256}.tgz`);
    const verifyExisting = () => {
        const existing = fsApi.lstatSync(destination);
        if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1
            || sha256File(destination, { fsApi }) !== snapshot.sha256) {
            throw snapshotError('Published local AchillesAgentLib archive is invalid or tampered');
        }
    };
    try {
        verifyExisting();
        return destination;
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }

    const temporary = path.join(store, `.${snapshot.sha256}.${token}.tmp`);
    try {
        fsApi.copyFileSync(source, temporary, fsApi.constants.COPYFILE_EXCL);
        const copied = fsApi.lstatSync(temporary);
        if (copied.isSymbolicLink() || !copied.isFile() || copied.nlink !== 1
            || sha256File(temporary, { fsApi }) !== snapshot.sha256) {
            throw snapshotError('Copied local AchillesAgentLib archive failed integrity validation');
        }
        try {
            verifyExisting();
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
            fsApi.renameSync(temporary, destination);
        }
        verifyExisting();
        return destination;
    } finally {
        try { fsApi.rmSync(temporary, { force: true }); } catch {}
    }
}

export function cleanupLocalAgentlibSnapshot(snapshot, { fsApi = fs } = {}) {
    const archive = String(snapshot?.tempArchivePath || '');
    if (!archive) return;
    const directory = path.dirname(path.resolve(archive));
    if (!path.basename(directory).startsWith('ploinky-agentlib-pack-')) return;
    try {
        const stat = fsApi.lstatSync(directory);
        if (!stat.isSymbolicLink() && stat.isDirectory()) {
            fsApi.rmSync(directory, { recursive: true, force: true });
        }
    } catch {}
}
