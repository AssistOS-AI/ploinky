import crypto from 'node:crypto';

import { PLOINKY_WORKSPACE_ROOT } from '../../utils/config.js';
import { NETWORK_SCHEMA_VERSION } from '../networkContract.js';
import {
    NETWORK_LABELS,
    workspaceNetworkIdentity,
} from '../networkLifecycle.js';

const RAW_IMAGE_ID = /^[a-f0-9]{64}$/;
const RELEASE_GENERATION = /^[a-f0-9]{64}$/;
const PURPOSE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PROBE_LABELS = Object.freeze({
    purpose: 'io.assistos.ploinky.probe-purpose',
    owner: 'io.assistos.ploinky.probe-owner',
    image: 'io.assistos.ploinky.probe-image',
});

function digest(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function exactText(value, label) {
    const text = typeof value === 'string' ? value : '';
    if (!text || text !== text.trim() || /[\u0000-\u001f\u007f]/u.test(text)) {
        throw new Error(`managed probe ${label} must be one exact nonempty text value`);
    }
    return text;
}

export function buildManagedProbeIdentity({
    purpose,
    owner,
    imageId,
    releaseGeneration,
    workspacePath = PLOINKY_WORKSPACE_ROOT,
} = {}) {
    const exactPurpose = exactText(purpose, 'purpose');
    const exactOwner = exactText(owner, 'owner');
    const exactImageId = exactText(imageId, 'image identity').replace(/^sha256:/, '');
    const exactRelease = exactText(releaseGeneration, 'release generation');
    if (!PURPOSE.test(exactPurpose)) {
        throw new Error('managed probe purpose must be a lowercase hyphenated identifier');
    }
    if (!RAW_IMAGE_ID.test(exactImageId)) {
        throw new Error('managed probe image identity must be one raw lowercase 64-hex image ID');
    }
    if (!RELEASE_GENERATION.test(exactRelease)) {
        throw new Error('managed probe release generation must be one lowercase 64-hex digest');
    }
    const workspaceHash = workspaceNetworkIdentity(workspacePath).hash;
    const contract = digest(JSON.stringify({
        schema: NETWORK_SCHEMA_VERSION,
        workspaceHash,
        purpose: exactPurpose,
        owner: exactOwner,
        imageId: exactImageId,
        releaseGeneration: exactRelease,
    }));
    const instanceId = digest(`probe-instance\0${workspaceHash}\0${exactOwner}`);
    const enableGeneration = digest(`probe-generation\0${contract}`);
    const name = `ploinky-probe-${workspaceHash}-${contract.slice(0, 16)}`;
    const labels = Object.freeze({
        [NETWORK_LABELS.managed]: '1',
        [NETWORK_LABELS.resource]: 'probe',
        [NETWORK_LABELS.schema]: NETWORK_SCHEMA_VERSION,
        [NETWORK_LABELS.workspace]: workspaceHash,
        [NETWORK_LABELS.contract]: contract,
        [NETWORK_LABELS.instanceId]: instanceId,
        [NETWORK_LABELS.enableGeneration]: enableGeneration,
        [NETWORK_LABELS.releaseGeneration]: exactRelease,
        [PROBE_LABELS.purpose]: exactPurpose,
        [PROBE_LABELS.owner]: exactOwner,
        [PROBE_LABELS.image]: exactImageId,
    });
    return Object.freeze({
        name,
        labels,
        purpose: exactPurpose,
        owner: exactOwner,
        imageId: exactImageId,
        releaseGeneration: exactRelease,
        workspaceHash,
        contract,
        instanceId,
        enableGeneration,
    });
}

export function buildManagedProbeRunArgs(options = {}) {
    const identity = buildManagedProbeIdentity(options);
    return Object.freeze([
        '--name', identity.name,
        '--pull=never',
        ...Object.entries(identity.labels)
            .sort(([left], [right]) => left.localeCompare(right))
            .flatMap(([key, value]) => ['--label', `${key}=${value}`]),
    ]);
}

export { PROBE_LABELS };
