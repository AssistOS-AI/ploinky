import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildServiceAgentPath,
    collectHttpServiceRoutes,
    resolveHttpServiceRoute,
} from '../../cli/server/httpServiceRoutes.js';
import { stripRouterIdentityHeaders } from '../../cli/server/routerHandlers.js';
import { compileGeneration } from '../../cli/server/generation/compileGeneration.js';
import { generationInput } from './routingProxyTestFixtures.mjs';

function generationWithService() {
    return compileGeneration(generationInput({ route: {
        httpServices: [{
            slug: 'files',
            access: 'authenticated',
            externalPrefix: '/services/files/',
            internalPrefix: '/internal/files/',
        }],
    } }));
}

test('HTTP service definitions are captured in the immutable generation', () => {
    const generation = generationWithService();
    const definitions = collectHttpServiceRoutes({ routes: generation.routes });
    assert.equal(definitions.length, 1);
    assert.equal(definitions[0].routeKey, 'alpha');
    assert.equal(definitions[0].access, 'authenticated');
    const resolved = resolveHttpServiceRoute('/services/files/list', { routes: generation.routes });
    assert.equal(resolved.routeKey, definitions[0].routeKey);
    assert.equal(resolved.externalPrefix, definitions[0].externalPrefix);
    assert.equal(buildServiceAgentPath(
        '/services/files/list',
        '?page=1',
        definitions[0].externalPrefix,
        definitions[0].internalPrefix,
    ), '/internal/files/list?page=1');
});

test('HTTP service routing strips all caller-supplied Router identity carriers', () => {
    const headers = stripRouterIdentityHeaders({
        authorization: 'Bearer application',
        'x-ploinky-auth-info': 'spoof',
        'x-ploinky-user-id': 'spoof',
        'x-ploinky-machine-assertion': 'spoof',
        'x-application-header': 'ok',
    });
    assert.equal(headers.authorization, 'Bearer application');
    assert.equal(headers['x-application-header'], 'ok');
    assert.equal(headers['x-ploinky-auth-info'], undefined);
    assert.equal(headers['x-ploinky-user-id'], undefined);
    assert.equal(headers['x-ploinky-machine-assertion'], undefined);
});
