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
