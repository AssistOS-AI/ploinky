import test from 'node:test';
import assert from 'node:assert/strict';

import {
    readManifestAgentCommand,
    readManifestStartCommand,
    resolveAgentExecutionMode,
    resolveAgentReadinessPort,
    resolveAgentReadinessProtocol,
    resolveAgentReadinessWaitOptions,
} from '../../cli/utils/runtime/startupReadiness.js';

test('read manifest commands trims explicit start and agent values', () => {
    const manifest = {
        start: '  postgres  ',
        agent: '  sh /code/start.sh  '
    };

    assert.equal(readManifestStartCommand(manifest), 'postgres');
    assert.equal(readManifestAgentCommand(manifest), 'sh /code/start.sh');
});

test('resolveAgentExecutionMode detects start-only services as tcp-style entrypoints', () => {
    const executionMode = resolveAgentExecutionMode({
        start: 'postgres'
    });

    assert.equal(executionMode.type, 'start_only');
    assert.equal(resolveAgentReadinessProtocol({ start: 'postgres' }), 'tcp');
});

test('resolveAgentExecutionMode detects explicit agent commands as MCP by default', () => {
    const executionMode = resolveAgentExecutionMode({
        agent: 'node /code/server.mjs'
    });

    assert.equal(executionMode.type, 'agent_only');
    assert.equal(resolveAgentReadinessProtocol({ agent: 'node /code/server.mjs' }), 'mcp');
});

test('a declared readiness script overrides agent-command MCP inference', () => {
    const manifest = {
        agent: 'bash /code/startup.sh',
        health: {
            readiness: { script: 'healthcheck.sh' }
        }
    };

    assert.equal(resolveAgentExecutionMode(manifest).type, 'agent_only');
    assert.equal(resolveAgentReadinessProtocol(manifest), 'script');
});

test('resolveAgentExecutionMode falls back to implicit AgentServer when no explicit entrypoint exists', () => {
    const executionMode = resolveAgentExecutionMode({
        container: 'node:20-alpine'
    });

    assert.equal(executionMode.type, 'implicit_agent_server');
    assert.equal(executionMode.usesImplicitAgentServer, true);
    assert.equal(resolveAgentReadinessProtocol({ container: 'node:20-alpine' }), 'mcp');
});

test('resolveAgentReadinessProtocol honors explicit manifest overrides', () => {
    assert.equal(resolveAgentReadinessProtocol({
        agent: 'node /code/http-server.mjs',
        readiness: { protocol: 'tcp' }
    }), 'tcp');

    assert.equal(resolveAgentReadinessProtocol({
        agent: 'node /code/http-server.mjs',
        readiness: { protocol: 'tcp' },
        health: { readiness: { script: 'healthcheck.sh' } }
    }), 'tcp');

    assert.equal(resolveAgentReadinessProtocol({
        start: 'postgres',
        readiness: { protocol: 'mcp' }
    }), 'mcp');
});

test('resolveAgentReadinessPort accepts only an explicit valid container port', () => {
    assert.equal(resolveAgentReadinessPort({}), null);
    assert.equal(resolveAgentReadinessPort({ readiness: { port: 7000 } }), 7000);
    assert.equal(resolveAgentReadinessPort({ readiness: { port: '8080' } }), 8080);
    assert.throws(
        () => resolveAgentReadinessPort({ readiness: { port: 0 } }),
        /integer from 1 through 65535/,
    );
    assert.throws(
        () => resolveAgentReadinessPort({ readiness: { port: 65536 } }),
        /integer from 1 through 65535/,
    );
    assert.throws(
        () => resolveAgentReadinessPort({ readiness: { port: '7000/tcp' } }),
        /integer from 1 through 65535/,
    );
});

test('manifest startup timeout raises a short caller budget without shortening broader callers', () => {
    const manifest = {
        readiness: {
            protocol: 'mcp',
            timeoutSeconds: 45,
        },
    };

    assert.deepEqual(resolveAgentReadinessWaitOptions(manifest, {
        timeoutMs: 15000,
        intervalMs: 125,
        probeTimeoutMs: 750,
    }), {
        timeoutMs: 45000,
        intervalMs: 125,
        probeTimeoutMs: 750,
    });
    assert.equal(resolveAgentReadinessWaitOptions(manifest, {
        timeoutMs: 120000,
    }).timeoutMs, 120000);
});

test('manifest startup timeout is an explicit positive integer contract', () => {
    for (const timeoutSeconds of [0, -1, 1.5, '45', Number.MAX_SAFE_INTEGER]) {
        assert.throws(
            () => resolveAgentReadinessWaitOptions({
                readiness: { protocol: 'mcp', timeoutSeconds },
            }),
            /readiness\.timeoutSeconds must be a positive integer number of seconds/,
        );
    }
});

test('targeted recovery can preserve legacy health probe timing in the shared resolver', () => {
    assert.deepEqual(resolveAgentReadinessWaitOptions({
        readiness: { protocol: 'mcp', timeoutSeconds: 18 },
        health: {
            readiness: {
                interval: 2,
                timeout: 3,
                failureThreshold: 4,
            },
        },
    }, {
        timeoutMs: 15000,
        intervalMs: 250,
        probeTimeoutMs: 1000,
        includeHealthProbeTiming: true,
    }), {
        timeoutMs: 20000,
        intervalMs: 2000,
        probeTimeoutMs: 3000,
    });
});

test('top-level manifest.run does not affect startup readiness inference', () => {
    const manifest = {
        run: 'node',
        container: 'node:20-bullseye'
    };

    const executionMode = resolveAgentExecutionMode(manifest);
    assert.equal(executionMode.type, 'implicit_agent_server');
    assert.equal(resolveAgentReadinessProtocol(manifest), 'mcp');
});

test('manifests with both start and agent still default to MCP unless overridden', () => {
    const executionMode = resolveAgentExecutionMode({
        start: 'service-start.sh',
        agent: 'sh /Agent/server/AgentServer.sh'
    });

    assert.equal(executionMode.type, 'start_and_agent');
    assert.equal(resolveAgentReadinessProtocol({
        start: 'service-start.sh',
        agent: 'sh /Agent/server/AgentServer.sh'
    }), 'mcp');
});
