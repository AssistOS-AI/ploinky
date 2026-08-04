import test from 'node:test';
import assert from 'node:assert/strict';

import { waitForAgentRedirectReady } from '../../cli/server/authHandlers/authContext.js';

test('bwrap auth redirect revalidates the captured owner without an anonymous readiness dial', async () => {
    const routePlan = Object.freeze({
        ownerAttestation: Object.freeze({ role: 'service', pid: 1234 }),
        lease: Object.freeze({
            snapshot: Object.freeze({
                routing: Object.freeze({
                    routes: Object.freeze({
                        alpha: Object.freeze({ hostPort: 43101 }),
                    }),
                }),
            }),
        }),
    });
    let ownerCommits = 0;
    const ready = await waitForAgentRedirectReady('alpha', {
        routePlan,
        commitRoutePlan(captured) {
            ownerCommits += 1;
            assert.equal(captured, routePlan);
            return true;
        },
        waitForAgentReady() {
            throw new Error('bwrap redirect must not open an anonymous readiness socket');
        },
    });

    assert.equal(ready, true);
    assert.equal(ownerCommits, 1);
});
test('bwrap auth redirect fails closed when the captured owner generation is stale', async () => {
    const routePlan = Object.freeze({
        ownerAttestation: Object.freeze({ role: 'service', pid: 1234 }),
        lease: Object.freeze({ snapshot: Object.freeze({ routing: Object.freeze({ routes: {} }) }) }),
    });
    assert.equal(await waitForAgentRedirectReady('alpha', {
        routePlan,
        commitRoutePlan: () => false,
        waitForAgentReady() {
            throw new Error('stale bwrap redirect must not fall through to an anonymous dial');
        },
    }), false);
});
