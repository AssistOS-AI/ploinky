import fs from 'node:fs';
import path from 'node:path';

import { BOX_IMAGE_REFERENCE } from '../../../ploinky-box/constants.mjs';
import { PloinkyBoxError } from '../../../ploinky-box/errors.mjs';

function proxyError(message) {
    return new PloinkyBoxError(message, { code: 'PLOINKY_BOX_TEST_PROXY_INVALID' });
}

export function writeCandidatePodmanProxy({
    directory,
    realPodman,
    candidateReference,
    logicalReference = BOX_IMAGE_REFERENCE,
    localCandidate = false,
    tracePath,
    fsApi = fs,
} = {}) {
    if (!path.isAbsolute(directory) || !path.isAbsolute(realPodman) || !path.isAbsolute(tracePath)) {
        throw proxyError('Candidate proxy paths must be absolute');
    }
    if (!/^docker\.io\/assistos\/ploinky-box@sha256:[a-f0-9]{64}$/.test(candidateReference)) {
        throw proxyError('Candidate proxy requires one immutable Ploinky Box digest reference');
    }
    if (typeof logicalReference !== 'string' || !logicalReference || /\s/u.test(logicalReference)) {
        throw proxyError('Candidate proxy requires one logical Ploinky Box image reference');
    }
    if (typeof localCandidate !== 'boolean') {
        throw proxyError('Candidate proxy local-candidate mode must be boolean');
    }
    const podman = path.join(directory, 'podman');
    fsApi.mkdirSync(directory, { recursive: false, mode: 0o700 });
    fsApi.chmodSync(directory, 0o700);
    const source = `#!/usr/bin/env node
const fs = require('node:fs');
const child = require('node:child_process');
const real = ${JSON.stringify(realPodman)};
const logical = ${JSON.stringify(logicalReference)};
const candidate = ${JSON.stringify(candidateReference)};
const localCandidate = ${JSON.stringify(localCandidate)};
const trace = ${JSON.stringify(tracePath)};
const original = process.argv.slice(2);
const append = (record) => fs.appendFileSync(trace, Buffer.from(record.join('\\0') + '\\0\\0'));
append(['argv', ...original]);
const args = [...original];
const allowedPull = args.length === 2 && args[0] === 'pull' && args[1] === logical;
const allowedInspect = args.length === 3 && args[0] === 'image' && args[1] === 'inspect' && args[2] === logical;
const allowedImmutableInspect = args.length === 3 && args[0] === 'image' && args[1] === 'inspect'
    && /^(?:sha256:)?[a-f0-9]{64}$/.test(args[2]);
const unsupportedImageCall = args.includes(logical) || args.includes(candidate)
    || args[0] === 'pull'
    || (args[0] === 'image' && args[1] === 'inspect');
if (!allowedPull && !allowedInspect && !allowedImmutableInspect && unsupportedImageCall) {
    append(['reject', ...original]);
    process.stderr.write('candidate proxy rejected unsupported image-bearing Podman argv\\n');
    process.exit(64);
}
if (allowedPull && localCandidate) {
    args.splice(0, args.length, 'image', 'inspect', candidate);
    append(['local-candidate', candidate]);
} else if (allowedPull) args[1] = candidate;
if (allowedInspect) args[2] = candidate;
if (allowedPull || allowedInspect) append(['rewrite', logical, candidate]);
const result = child.spawnSync(real, args, { stdio: 'inherit', env: process.env });
if (Number.isInteger(result.status)) process.exit(result.status);
if (result.signal) process.kill(process.pid, result.signal);
process.exit(1);
`;
    fsApi.writeFileSync(podman, source, { flag: 'wx', mode: 0o700 });
    fsApi.chmodSync(podman, 0o700);
    return Object.freeze({
        directory,
        podman,
        tracePath,
        candidateReference,
        localCandidate,
    });
}

export function readProxyTrace(tracePath, fsApi = fs) {
    const bytes = fsApi.readFileSync(tracePath);
    return Object.freeze(bytes.toString('utf8').split('\0\0')
        .filter(Boolean)
        .map((record) => Object.freeze(record.split('\0'))));
}
