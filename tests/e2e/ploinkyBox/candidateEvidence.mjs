import fs from 'node:fs';
import path from 'node:path';

const CANDIDATE_REFERENCE = /^docker\.io\/assistos\/ploinky-box@(sha256:[a-f0-9]{64})$/;
const CONTAINER_ID = /^[a-f0-9]{64}$/;
const EVIDENCE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function evidenceError(message) {
    const error = new Error(message);
    error.code = 'PLOINKY_BOX_CANDIDATE_EVIDENCE_INVALID';
    return error;
}

function queryJson(runner, argv, label) {
    const result = runner.query('podman', argv);
    if (!result?.ok) {
        throw evidenceError(`Candidate evidence could not query ${label}`);
    }
    try {
        return JSON.parse(String(result.stdout || ''));
    } catch (_) {
        throw evidenceError(`Candidate evidence received malformed ${label} JSON`);
    }
}

function versionProjection(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
    return Object.freeze({
        apiVersion: String(record.APIVersion || ''),
        version: String(record.Version || ''),
        os: String(record.Os || ''),
        osArch: String(record.OsArch || ''),
    });
}

function repeatedArgument(argv, option) {
    if (!Array.isArray(argv)) return [];
    return argv.flatMap((value, index) => value === option ? [String(argv[index + 1] || '')] : []);
}

function tmpfsMountProjection(mount) {
    return Object.freeze({
        Type: String(mount?.Type || ''),
        Destination: String(mount?.Destination || ''),
        Driver: String(mount?.Driver || ''),
        Mode: String(mount?.Mode || ''),
        Options: Array.isArray(mount?.Options)
            ? Object.freeze(mount.Options.map((option) => String(option)))
            : Object.freeze([]),
        RW: mount?.RW === true,
        Propagation: String(mount?.Propagation || ''),
    });
}

export function buildCandidateEvidence({
    name,
    candidateReference,
    beforeContainerId,
    afterContainerId,
    inspected,
    restartTrace,
    version,
    info,
    verified = {},
    platform = process.platform,
    architecture = process.arch,
} = {}) {
    if (!EVIDENCE_NAME.test(String(name || ''))) {
        throw evidenceError('Candidate evidence requires one filesystem-safe test name');
    }
    const referenceMatch = CANDIDATE_REFERENCE.exec(String(candidateReference || ''));
    if (!referenceMatch) {
        throw evidenceError('Candidate evidence requires one immutable Ploinky Box reference');
    }
    if (!CONTAINER_ID.test(String(beforeContainerId || ''))
        || !CONTAINER_ID.test(String(afterContainerId || ''))
        || String(inspected?.Id || inspected?.ID || '') !== afterContainerId) {
        throw evidenceError('Candidate evidence requires exact before, after, and inspected container IDs');
    }
    if (!Array.isArray(restartTrace)) {
        throw evidenceError('Candidate evidence requires the bounded restart proxy trace');
    }
    const verifiedEntries = Object.entries(verified);
    if (verifiedEntries.some(([key, value]) => (
        !/^[a-z][A-Za-z0-9]*$/.test(key) || typeof value !== 'boolean'
    ))) {
        throw evidenceError('Candidate evidence accepts only named boolean verification results');
    }

    const versionRecord = version && typeof version === 'object' ? version : {};
    const host = info?.host || info?.Host || {};
    const restartArgv = restartTrace.filter((record) => Array.isArray(record) && record[0] === 'argv')
        .map((record) => record.slice(1));
    const forbiddenPull = restartArgv.some((argv) => argv[0] === 'pull');
    const forbiddenCreate = restartArgv.some((argv) => (
        argv[0] === 'container' && argv[1] === 'create'
    ));
    const forbiddenRemove = restartArgv.some((argv) => (
        argv[0] === 'container' && ['rm', 'remove'].includes(argv[1])
    ));
    const tmpfsMounts = (Array.isArray(inspected?.Mounts) ? inspected.Mounts : [])
        .filter((mount) => String(mount?.Destination || '') === '/tmp')
        .map(tmpfsMountProjection);

    return Object.freeze({
        kind: 'ploinky-box-candidate-evidence',
        test: name,
        candidateDigest: referenceMatch[1],
        controller: Object.freeze({
            platform: String(platform || ''),
            architecture: String(architecture || ''),
        }),
        podman: Object.freeze({
            client: versionProjection(versionRecord.Client || versionRecord.client),
            server: versionProjection(versionRecord.Server || versionRecord.server || info?.version),
            rootless: (host?.security?.rootless ?? host?.Security?.Rootless) === true,
            networkBackend: String(host?.networkBackend || host?.NetworkBackend || ''),
            pastaVersion: String(host?.pasta?.version || host?.Pasta?.Version || '').split('\n')[0],
        }),
        outerContainer: Object.freeze({
            beforeId: beforeContainerId,
            afterId: afterContainerId,
            sameId: beforeContainerId === afterContainerId,
            createTmpfs: Object.freeze(repeatedArgument(
                inspected?.Config?.CreateCommand,
                '--tmpfs',
            )),
            hostConfigTmpfs: Object.freeze({
                '/tmp': String(inspected?.HostConfig?.Tmpfs?.['/tmp'] || ''),
            }),
            mounts: Object.freeze(tmpfsMounts),
        }),
        restart: Object.freeze({
            argvRecordCount: restartArgv.length,
            pullObserved: forbiddenPull,
            createObserved: forbiddenCreate,
            removeObserved: forbiddenRemove,
        }),
        verified: Object.freeze(Object.fromEntries(verifiedEntries.sort(([left], [right]) => (
            left.localeCompare(right)
        )))),
    });
}

export function captureCandidateEvidence({
    runner,
    evidenceDirectory = process.env.PLOINKY_BOX_EVIDENCE_DIR,
    diagnostic,
    fsApi = fs,
    ...inputs
} = {}) {
    if (!runner || typeof runner.query !== 'function') {
        throw evidenceError('Candidate evidence requires a Podman process runner');
    }
    const evidence = buildCandidateEvidence({
        ...inputs,
        version: queryJson(runner, ['version', '--format', 'json'], 'Podman version'),
        info: queryJson(runner, ['info', '--format', 'json'], 'Podman info'),
    });
    const bytes = `${JSON.stringify(evidence, null, 2)}\n`;
    if (typeof diagnostic === 'function') {
        diagnostic(`candidate evidence: ${JSON.stringify(evidence)}`);
    }
    if (!String(evidenceDirectory || '')) {
        return Object.freeze({ evidence, path: null });
    }
    if (!path.isAbsolute(evidenceDirectory)) {
        throw evidenceError('PLOINKY_BOX_EVIDENCE_DIR must be an absolute path');
    }
    fsApi.mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
    const directoryStat = fsApi.lstatSync(evidenceDirectory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        throw evidenceError('PLOINKY_BOX_EVIDENCE_DIR must be a real directory');
    }
    const realDirectory = fsApi.realpathSync(evidenceDirectory);
    const target = path.join(
        realDirectory,
        `${evidence.test}-${evidence.controller.platform}-${evidence.controller.architecture}.json`,
    );
    fsApi.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
    return Object.freeze({ evidence, path: target });
}
