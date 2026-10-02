import test from 'node:test';
import assert from 'node:assert/strict';
import { assertKnownMpsClients } from '../../cli/sandbox/hardwareLimits/mpsInventory.mjs';
const a = 'a'.repeat(64), b = 'b'.repeat(64);
test('MPS inventory accepts only exact registered and journaled clients', () => {
    const seen = [];
    const ids = assertKnownMpsClients({ runtime: 'podman', registry: { a: {containerId:a} }, state: {pendingClients:[{containerId:b}]}, query: (command,args,options) => { seen.push({command,args,options}); return {status:0,stdout:`${a}\n${b}\n`}; } });
    assert.deepEqual(ids,[a,b]); assert.equal(seen[0].options.timeout,5000); assert.ok(seen[0].args.includes('--no-trunc'));
});
for (const [name, reply] of Object.entries({ unknown:{status:0,stdout:b}, truncated:{status:0,stdout:a.slice(0,12)}, duplicate:{status:0,stdout:`${a}\n${a}`}, failed:{status:1,stdout:a}, signaled:{status:0,stdout:a,signal:'SIGTERM'} })) {
    test(`MPS inventory refuses ${name} before daemon mutation`, () => {
        assert.throws(()=>assertKnownMpsClients({runtime:'podman',registry:{a:{containerId:a}},query:()=>reply}));
    });
}

import { inspectMpsClient } from '../../cli/sandbox/hardwareLimits/mpsInventory.mjs';
import { networkContractHash } from '../../cli/sandbox/networkContract.js';
import { effectiveInstanceKey } from '../../cli/utils/workspaceDependencyGraph.js';
test('MPS cohort inspection binds immutable ID and full alias network contract', () => {
    const network = { mode: 'default' };
    const client = { key: 'opaque', ref: 'repo/gpu', alias: 'router', containerId: a, instanceId: 'instance', enableGeneration: 'generation' };
    let observed;
    const result = inspectMpsClient(client, { network, runtime: 'podman', createAdapter: () => ({ inspectContainerContract(...args) { observed = args; return { state: 'exact', id: a }; } }) });
    assert.equal(result.id, a); assert.equal(observed[0], a);
    assert.equal(observed[3].contractHash, networkContractHash(network));
    assert.equal(observed[3].instanceKey, effectiveInstanceKey('repo', 'gpu', 'router'));
    assert.equal(observed[3].requireRuntimeIdentity, true);
});
