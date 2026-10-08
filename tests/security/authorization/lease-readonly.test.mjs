// Step-1 precondition for the U7 live positive control (plan rev4): the
// marketplace POST path calls routePlan.lease.commit() before the action check
// (cli/server/authHandlers/marketplaceRoutes.js:786). For HTTP requests that
// lease comes from captureEdgeRoutingLease() (cli/server/edgeRoutePlan.js:716-719),
// whose commit is isCurrent() -> loadActiveEdgeRoutingGeneration()
// (cli/sandbox/edgeGeneration.js:3282-3311). This proves the call is
// synchronously write-free on a real generation. Not covered here: the
// hardware-availability latcher, which only exists in the Router process and
// is signalled by every lease capture with terminal slots (not just U7).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { makeWorld } from '../../unit/hardwareAvailabilityResolverFixtures.mjs';
import { captureEdgeRoutingLease } from '../../../cli/sandbox/edgeGeneration.js';

function tree(root) {
    const out = {};
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const file = path.join(dir, entry.name);
            const stat = fs.lstatSync(file, { bigint: true });
            if (entry.isDirectory()) { out[file] = `dir:${stat.ino}:${stat.mtimeNs}`; walk(file); }
            else out[file] = `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${entry.isFile() ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : 'link'}`;
        }
    };
    walk(root);
    return out;
}

const WRITE_OPS = ['writeFileSync', 'writeFile', 'appendFileSync', 'renameSync', 'rename', 'mkdirSync', 'mkdtempSync', 'unlinkSync', 'rmSync', 'rmdirSync', 'copyFileSync', 'symlinkSync', 'linkSync', 'truncateSync', 'ftruncateSync', 'writeSync', 'utimesSync', 'chmodSync', 'chownSync', 'createWriteStream'];
function spyWrites() {
    const calls = [];
    const original = {};
    for (const op of WRITE_OPS) {
        if (typeof fs[op] !== 'function') continue;
        original[op] = fs[op];
        fs[op] = (...args) => { calls.push({ op, target: String(args[0]) }); return original[op](...args); };
    }
    original.openSync = fs.openSync;
    fs.openSync = (file, flags = 'r', ...rest) => {
        const writes = typeof flags === 'number'
            ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) !== 0
            : flags !== 'r';
        if (writes) calls.push({ op: 'openSync', target: String(file) });
        return original.openSync(file, flags, ...rest);
    };
    return { calls, restore() { for (const [op, fn] of Object.entries(original)) fs[op] = fn; } };
}

test('request-path lease commit() writes nothing to the workspace', (t) => {
    const world = makeWorld(t);
    world.apply('fixture');
    const lease = captureEdgeRoutingLease(world.options);
    const before = tree(world.root);
    const spy = spyWrites();
    let results;
    try { results = Array.from({ length: 5 }, () => lease.commit()); }
    finally { spy.restore(); }
    assert.deepEqual(results, [true, true, true, true, true], 'commit() must report the still-current generation');
    assert.deepEqual(spy.calls, [], 'commit() issued a filesystem write');
    assert.deepEqual(tree(world.root), before, 'commit() changed the workspace tree');
    assert.ok(Object.keys(before).length > 10, 'the fixture must contain a real generation');
});

test('negative control: the write spy and tree comparison detect a write', (t) => {
    const world = makeWorld(t);
    world.apply('fixture');
    const before = tree(world.root);
    const spy = spyWrites();
    try { fs.writeFileSync(path.join(world.root, 'probe.txt'), 'x'); } finally { spy.restore(); }
    assert.equal(spy.calls.length, 1);
    assert.notDeepEqual(tree(world.root), before);
});
