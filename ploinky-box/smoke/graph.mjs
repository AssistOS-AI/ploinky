import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { PloinkyBoxError } from '../errors.mjs';

export const SMOKE_GRAPH_REPOSITORIES = Object.freeze([
    'AssistOSExplorer',
    'webmeetInfra',
    'UmamiAgent',
    'AchillesCLI',
    'proxies',
    'basic',
    'container-image-builds',
]);

const SMOKE_GRAPH_DESTINATIONS = Object.freeze({
    AssistOSExplorer: 'AchillesIDE',
});

function smokeError(message, cause) {
    return new PloinkyBoxError(message, {
        code: 'PLOINKY_BOX_SMOKE_INPUT_INVALID',
        cause,
    });
}

function parseJson(value, name) {
    if (!String(value || '').trim()) throw smokeError(`${name} is required`);
    try {
        return JSON.parse(value);
    } catch (error) {
        throw smokeError(`${name} must be valid JSON`, error);
    }
}

function exactKeys(record, label) {
    const actual = Object.keys(record || {}).sort();
    const expected = [...SMOKE_GRAPH_REPOSITORIES].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw smokeError(`${label} must contain exactly the seven pinned graph repositories`);
    }
}

function readDesiredCandidate(value, fsApi) {
    const suppliedPath = String(value || '');
    if (!path.isAbsolute(suppliedPath)) {
        throw smokeError('SMOKE_GRAPH_EDGE_DESIRED_FILE must be an absolute path');
    }
    let realPath;
    let stat;
    let bytes;
    try {
        realPath = fsApi.realpathSync(suppliedPath);
        stat = fsApi.lstatSync(suppliedPath);
        bytes = fsApi.readFileSync(suppliedPath);
    } catch (error) {
        throw smokeError('SMOKE_GRAPH_EDGE_DESIRED_FILE must be a readable real file', error);
    }
    if (path.resolve(suppliedPath) !== realPath || !stat.isFile() || stat.isSymbolicLink()) {
        throw smokeError('SMOKE_GRAPH_EDGE_DESIRED_FILE must be a non-symlink regular real path');
    }
    let document;
    try {
        document = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
        throw smokeError('SMOKE_GRAPH_EDGE_DESIRED_FILE must contain valid JSON', error);
    }
    if (!document?.hosts
        || typeof document.hosts !== 'object'
        || Array.isArray(document.hosts)
        || Object.keys(document.hosts).length !== 0
        || document.cloudflare !== undefined) {
        throw smokeError('smoke desired state must be local-only with no selected hosts');
    }
    if (document.security !== undefined) {
        throw smokeError('smoke desired state must not duplicate manifest or HTTP route policy authority');
    }
    return Object.freeze({
        path: realPath,
        digest: crypto.createHash('sha256').update(bytes).digest('hex'),
    });
}

export function readSmokeGraphInputs(env = process.env, {
    fsApi = fs,
    runner,
} = {}) {
    const args = parseJson(env.SMOKE_GRAPH_ARGS_JSON, 'SMOKE_GRAPH_ARGS_JSON');
    const repositories = parseJson(
        env.SMOKE_GRAPH_REPOSITORIES_JSON,
        'SMOKE_GRAPH_REPOSITORIES_JSON',
    );
    const revisions = parseJson(
        env.SMOKE_GRAPH_REVISIONS_JSON,
        'SMOKE_GRAPH_REVISIONS_JSON',
    );
    const desiredCandidate = readDesiredCandidate(
        env.SMOKE_GRAPH_EDGE_DESIRED_FILE,
        fsApi,
    );
    if (!Array.isArray(args) || args.length < 2 || args.some((value) => typeof value !== 'string')) {
        throw smokeError('SMOKE_GRAPH_ARGS_JSON must be a nonempty string argv array');
    }
    if (!repositories || typeof repositories !== 'object' || Array.isArray(repositories)) {
        throw smokeError('SMOKE_GRAPH_REPOSITORIES_JSON must be an object');
    }
    if (!revisions || typeof revisions !== 'object' || Array.isArray(revisions)) {
        throw smokeError('SMOKE_GRAPH_REVISIONS_JSON must be an object');
    }
    exactKeys(repositories, 'SMOKE_GRAPH_REPOSITORIES_JSON');
    exactKeys(revisions, 'SMOKE_GRAPH_REVISIONS_JSON');
    const selected = {};
    for (const name of SMOKE_GRAPH_REPOSITORIES) {
        const suppliedPath = String(repositories[name] || '');
        const revision = String(revisions[name] || '');
        if (!path.isAbsolute(suppliedPath)) {
            throw smokeError(`${name} repository path must be absolute`);
        }
        let realPath;
        try {
            realPath = fsApi.realpathSync(suppliedPath);
        } catch (error) {
            throw smokeError(`${name} repository path is not a real checkout`, error);
        }
        if (path.resolve(suppliedPath) !== realPath) {
            throw smokeError(`${name} repository path must already be its absolute real path`);
        }
        if (!/^[a-f0-9]{40}$/.test(revision)) {
            throw smokeError(`${name} revision must be one exact 40-character SHA`);
        }
        if (!runner) throw smokeError('Smoke graph validation requires a process runner');
        const head = runner.query('git', ['-C', realPath, 'rev-parse', 'HEAD']);
        const status = runner.query('git', ['-C', realPath, 'status', '--porcelain=v1']);
        if (!head.ok || String(head.stdout || '').trim() !== revision) {
            throw smokeError(`${name} checkout HEAD does not equal its supplied revision`);
        }
        if (!status.ok || String(status.stdout || '').trim() !== '') {
            throw smokeError(`${name} checkout must be clean`);
        }
        selected[name] = Object.freeze({ path: realPath, revision });
    }
    return Object.freeze({
        args: Object.freeze([...args]),
        desiredCandidate,
        repositories: Object.freeze(selected),
    });
}

export function stageSmokeGraph({
    graph,
    engine = 'podman',
    containerId,
    runner,
} = {}) {
    if (!/^[a-f0-9]{12,64}$/.test(String(containerId || ''))) {
        throw smokeError('Smoke graph staging requires an immutable outer container ID');
    }
    runner.run(engine, [
        'container', 'exec', '--user', 'podman', containerId,
        'mkdir', '-p', '/workspace/.ploinky/repos',
    ]);
    for (const name of SMOKE_GRAPH_REPOSITORIES) {
        const repository = graph.repositories[name];
        const destinationName = SMOKE_GRAPH_DESTINATIONS[name] || name;
        const destination = `/workspace/.ploinky/repos/${destinationName}`;
        runner.run(engine, [
            'container', 'exec', '--user', 'podman', containerId,
            'mkdir', '-p', destination,
        ]);
        runner.run(engine, ['container', 'cp', `${repository.path}/.`, `${containerId}:${destination}`]);
        const head = runner.query(engine, [
            'container', 'exec', '--user', 'podman', containerId,
            'git', '-C', destination, 'rev-parse', 'HEAD',
        ]);
        if (!head.ok || String(head.stdout || '').trim() !== repository.revision) {
            throw smokeError(`${name} in-box HEAD changed during graph staging`);
        }
    }
    runner.run(engine, [
        'container', 'exec', '--user', 'podman', '--workdir', '/workspace',
        '--env', 'PLOINKY_WORKSPACE_ROOT=/workspace', containerId,
        'node', '/opt/ploinky/ploinky-box/entrypoint/initialize-edge-routing.mjs',
    ]);
    const desiredDirectory = '/workspace/.ploinky/data/edge-routing';
    const desiredTarget = `${desiredDirectory}/desired.json`;
    const desiredCandidateTarget = `${desiredTarget}.smoke-candidate`;
    runner.run(engine, [
        'container', 'exec', '--user', 'podman', containerId,
        'mkdir', '-p', desiredDirectory,
    ]);
    runner.run(engine, [
        'container', 'exec', '--user', 'podman', containerId,
        'chmod', '700', desiredDirectory,
    ]);
    runner.run(engine, [
        'container', 'cp', graph.desiredCandidate.path,
        `${containerId}:${desiredCandidateTarget}`,
    ]);
    runner.run(engine, [
        'container', 'exec', '--user', 'podman', containerId,
        'mv', desiredCandidateTarget, desiredTarget,
    ]);
    runner.run(engine, [
        'container', 'exec', '--user', 'podman', containerId,
        'chmod', '600', desiredTarget,
    ]);
    const desiredDigest = runner.query(engine, [
        'container', 'exec', '--user', 'podman', containerId,
        'sha256sum', desiredTarget,
    ]);
    if (!desiredDigest.ok
        || String(desiredDigest.stdout || '').trim().split(/\s+/)[0] !== graph.desiredCandidate.digest) {
        throw smokeError('in-box edge desired state changed during graph staging');
    }
}
