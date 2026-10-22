import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { hostStateMaskMount } from '../../ploinky-box/hostState/root.mjs';
import {
    expectedHostStateMounts,
    expectedOuterMounts,
    observedOuterMounts,
} from '../e2e/ploinkyBox/nativeHelpers.mjs';

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-mounts-')));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const WORKSPACE = path.join(ROOT, 'ws');
const CHECKOUT = path.join(ROOT, 'checkout');
fs.mkdirSync(path.join(WORKSPACE, 'tools', 'ploinky'), { recursive: true });
fs.mkdirSync(CHECKOUT);

const base = [
    { type: 'bind', source: CHECKOUT, destination: '/opt/ploinky', rw: false },
    { type: 'bind', source: WORKSPACE, destination: WORKSPACE, rw: true },
];

// An engine inspect record carrying exactly the given mounts.
function record(mounts) {
    return {
        Mounts: [
            { Type: 'tmpfs', Source: '', Destination: '/tmp', RW: true },
            ...mounts.map((mount) => ({
                Type: 'bind', Source: mount.source, Destination: mount.destination, RW: mount.rw,
            })),
        ],
    };
}

function matches(mounts) {
    try {
        assert.deepEqual(observedOuterMounts(record(mounts)), expectedOuterMounts(WORKSPACE, CHECKOUT, base));
        return true;
    } catch {
        return false;
    }
}

test('the expected host-state mount is the read-only mask over .ploinky-box', () => {
    const mask = hostStateMaskMount(WORKSPACE);
    assert.deepEqual(expectedHostStateMounts(WORKSPACE, CHECKOUT), [
        { type: 'bind', source: `${WORKSPACE}/.ploinky-box/empty`, destination: `${WORKSPACE}/.ploinky-box`, rw: false },
    ]);
    assert.equal(mask.rw, false);
});

test('a checkout inside the workspace adds its shadow and parent self-binds', () => {
    const checkout = path.join(WORKSPACE, 'tools', 'ploinky');
    assert.deepEqual(expectedHostStateMounts(WORKSPACE, checkout).map((mount) => [mount.destination, mount.rw]), [
        [`${WORKSPACE}/.ploinky-box`, false],
        [`${WORKSPACE}/tools`, true],
        [checkout, false],
    ]);
});

test('the exact comparison accepts the mask and rejects a missing or extra mount', () => {
    const mask = expectedHostStateMounts(WORKSPACE, CHECKOUT);
    assert.equal(matches([...base, ...mask]), true);
    assert.equal(matches(base), false, 'a Box without the mask must fail');
    assert.equal(matches([...base, ...mask, {
        type: 'bind', source: '/srv/extra', destination: '/extra', rw: false,
    }]), false, 'an extra mount must fail');
    assert.equal(matches([...base, { ...mask[0], rw: true }]), false, 'a writable mask must fail');
    assert.equal(matches([...base.slice(1), ...mask]), false, 'a missing base mount must fail');
});
