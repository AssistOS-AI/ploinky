import test from 'node:test';
import assert from 'node:assert/strict';

import {
    AgentPortSelectorError,
    parseAgentPortSelector,
} from '../../cli/server/agentPortConvention/parseSelector.js';

const PREFIX = '/base-agent-additional-server';

test('agent-port selector accepts canonical routes and preserves the raw query', () => {
    assert.deepEqual(parseAgentPortSelector(`${PREFIX}/alpha/7000`), {
        convention: 'base-agent-additional-server',
        agent: 'alpha',
        rawAgent: 'alpha',
        port: 7000,
        canonicalPort: '7000',
        suffix: '/',
        query: '',
        policyPath: `${PREFIX}/alpha/7000`,
        requestTarget: `${PREFIX}/alpha/7000`,
    });
    const selected = parseAgentPortSelector(`${PREFIX}/alpha/65535/api/items?q=a%2Fb`);
    assert.equal(selected.suffix, '/api/items');
    assert.equal(selected.query, 'q=a%2Fb');
    assert.equal(parseAgentPortSelector('/alpha/7000'), null);
    assert.equal(parseAgentPortSelector('/base-agent-additional-server-lookalike/alpha/7000'), null);
});

test('agent-port selector accepts RFC path characters and a trailing slash in the upstream suffix', () => {
    const asset = parseAgentPortSelector(
        `${PREFIX}/onlyOffice/8080/9.3.1-build/web-apps/resources/iconssmall@2.5x.svg`,
    );
    assert.equal(asset.suffix, '/9.3.1-build/web-apps/resources/iconssmall@2.5x.svg');

    const collaboration = parseAgentPortSelector(
        `${PREFIX}/onlyOffice/8080/9.3.1-build/doc/document-key/c/?shardkey=document-key&EIO=4&transport=websocket`,
    );
    assert.equal(collaboration.suffix, '/9.3.1-build/doc/document-key/c/');
    assert.equal(collaboration.query, 'shardkey=document-key&EIO=4&transport=websocket');
});
const invalidTargets = [
    PREFIX,
    `${PREFIX}/`,
    `${PREFIX}//7000`,
    `${PREFIX}/alpha`,
    `${PREFIX}/alpha/`,
    `${PREFIX}/alpha/0`,
    `${PREFIX}/alpha/00`,
    `${PREFIX}/alpha/07000`,
    `${PREFIX}/alpha/+7000`,
    `${PREFIX}/alpha/65536`,
    `${PREFIX}/alpha/999999`,
    `${PREFIX}/alpha/not-a-port`,
    `${PREFIX}/alpha//path`,
    `${PREFIX}/alpha/7000//path`,
    `${PREFIX}/alpha/7000/.`,
    `${PREFIX}/alpha/7000/..`,
    `${PREFIX}/alpha/7000/%2Fetc`,
    `${PREFIX}/alpha/7000/%252Fetc`,
    `${PREFIX}/alpha/7000/%5Cetc`,
    `${PREFIX}/alpha/7000/%00`,
    `${PREFIX}/alpha/7000/icon%40scale.svg`,
    `${PREFIX}/%61lpha/7000`,
    `${PREFIX}/alpha%2Fbeta/7000`,
    `${PREFIX}/alpha%5Cbeta/7000`,
    `${PREFIX}/alpha!/7000`,
    `${PREFIX}/alpha/7000#fragment`,
    `http://router${PREFIX}/alpha/7000`,
];

for (const target of invalidTargets) {
    test(`agent-port selector rejects ${JSON.stringify(target)}`, () => {
        assert.throws(() => parseAgentPortSelector(target), AgentPortSelectorError);
    });
}

test('agent-port selector enforces only the trusted denied-port set', () => {
    assert.throws(
        () => parseAgentPortSelector(`${PREFIX}/alpha/7000`, { deniedPorts: [7000] }),
        error => error.code === 'DENIED_PORT' && error.status === 403,
    );
    assert.equal(parseAgentPortSelector(`${PREFIX}/alpha/7001`, { deniedPorts: [7000] }).port, 7001);
});
