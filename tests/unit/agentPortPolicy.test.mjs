import test from 'node:test';
import assert from 'node:assert/strict';

import { compileGeneration } from '../../cli/server/generation/compileGeneration.js';
import { evaluateGenerationAccess } from '../../cli/server/generation/evaluateGenerationAccess.js';
import { generationInput } from './routingProxyTestFixtures.mjs';

const conventionalPath = '/base-agent-additional-server/alpha/7000/public';

test('convention policy defaults to authenticated while primary routes retain their own default', () => {
    const generation = compileGeneration(generationInput());
    assert.equal(evaluateGenerationAccess({
        generation,
        pathname: conventionalPath,
        routeKey: 'alpha',
        surfaceKind: 'agent-port-convention',
    }).access, 'authenticated');
    assert.equal(evaluateGenerationAccess({
        generation,
        pathname: '/alpha/',
        routeKey: 'alpha',
        surfaceKind: 'agent-primary',
    }).access, 'guest');
});
test('complete-path policy matching is most restrictive and public writes fail closed', () => {
    const generation = compileGeneration(generationInput({ policy: { entries: [
        { path: '/base-agent-additional-server/alpha/*', access: 'public' },
        { path: '/base-agent-additional-server/alpha/7000/*', access: 'authenticated' },
    ] } }));
    assert.equal(evaluateGenerationAccess({
        generation,
        pathname: conventionalPath,
        method: 'GET',
        routeKey: 'alpha',
        surfaceKind: 'agent-port-convention',
    }).access, 'authenticated');
    const publicGeneration = compileGeneration(generationInput({ policy: { entries: [
        { path: '/base-agent-additional-server/alpha/7000/*', access: 'public' },
    ] } }));
    const denied = evaluateGenerationAccess({
        generation: publicGeneration,
        pathname: conventionalPath,
        method: 'POST',
        routeKey: 'alpha',
        surfaceKind: 'agent-port-convention',
    });
    assert.equal(denied.access, 'deny');
    assert.equal(denied.status, 403);
});
