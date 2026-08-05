import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import test from 'node:test';

import { LOGS_DIR } from '../../cli/utils/config.js';
import {
    logsTail,
    parseLogTarget,
    resolveOwnedLogPath,
    resolveOwnedLogSource,
    showLast,
} from '../../cli/commands/logUtils.js';
import { parseLogsCommandOptions } from '../../cli/commands/cli.js';

const runtimeKey = 'ploinky_agents_codex_workspace_deadbeef';
const taskId = 'task-phase9';

function dependencies(overrides = {}) {
    return {
        readServiceOwner: () => ({
            role: 'service',
            runtimeKey,
            logPath: path.join(LOGS_DIR, 'agents', 'instance-phase9', 'service-bwrap.log'),
        }),
        readProviderTaskOwner: () => ({
            role: 'provider-task',
            runtimeKey,
            taskId,
            logPath: path.join(
                LOGS_DIR,
                'agents',
                'instance-phase9',
                'tasks',
                `${taskId}-provider.log`,
            ),
        }),
        readContainerServiceOwner: () => null,
        ...overrides,
    };
}

test('log resolution separates Router, exact service, and exact provider-task logs', () => {
    assert.equal(
        resolveOwnedLogPath({ kind: 'router' }, dependencies()),
        path.join(LOGS_DIR, 'router.log'),
    );
    assert.equal(
        resolveOwnedLogPath({ kind: 'service', runtimeKey }, dependencies()),
        path.join(LOGS_DIR, 'agents', 'instance-phase9', 'service-bwrap.log'),
    );
    assert.equal(
        resolveOwnedLogPath({ kind: 'task', runtimeKey, taskId }, dependencies()),
        path.join(LOGS_DIR, 'agents', 'instance-phase9', 'tasks', `${taskId}-provider.log`),
    );
});

test('log resolution fails closed for missing, mismatched, or escaping owner paths', () => {
    for (const [request, overrides] of [
        [{ kind: 'unknown' }, {}],
        [{ kind: 'service', runtimeKey }, { readServiceOwner: () => null }],
        [{ kind: 'service', runtimeKey }, {
            readServiceOwner: () => ({ role: 'provider-task', runtimeKey, logPath: path.join(LOGS_DIR, 'wrong.log') }),
        }],
        [{ kind: 'task', runtimeKey, taskId }, {
            readProviderTaskOwner: () => ({ role: 'provider-task', runtimeKey, taskId: 'other', logPath: path.join(LOGS_DIR, 'wrong.log') }),
        }],
        [{ kind: 'task', runtimeKey, taskId }, {
            readProviderTaskOwner: () => ({ role: 'provider-task', runtimeKey, taskId, logPath: '/tmp/secret-canary.log' }),
        }],
    ]) {
        assert.throws(
            () => resolveOwnedLogPath(request, dependencies(overrides)),
            (error) => error?.code === 'PLOINKY_LOG_TARGET_INVALID',
        );
    }
});

test('service log resolution selects an exact immutable coding container without sandbox fallback', async () => {
    const containerId = 'a'.repeat(64);
    const sourceDependencies = dependencies({
        readServiceOwner: () => null,
        readContainerServiceOwner: undefined,
        getAgentsRegistry: () => ({
            [runtimeKey]: {
                type: 'agent',
                runtime: 'podman',
                containerId,
                instanceId: 'instance-phase9',
                enableGeneration: 'generation-phase9',
            },
        }),
        collectLiveAgentContainers: () => [{
            containerName: runtimeKey,
            runtime: 'podman',
            containerId,
            instanceId: 'instance-phase9',
            enableGeneration: 'generation-phase9',
        }],
    });
    assert.deepEqual(
        resolveOwnedLogSource({ kind: 'service', runtimeKey }, sourceDependencies),
        { kind: 'container', runtime: 'podman', runtimeKey, containerId },
    );
    assert.throws(
        () => resolveOwnedLogPath({ kind: 'service', runtimeKey }, sourceDependencies),
        (error) => error?.code === 'PLOINKY_LOG_TARGET_INVALID',
    );

    const calls = [];
    const child = new EventEmitter();
    const tailPromise = logsTail({ kind: 'service', runtimeKey }, {
        ...sourceDependencies,
        spawn: (command, args, options) => {
            calls.push({ command, args, options });
            queueMicrotask(() => child.emit('exit', 0));
            return child;
        },
    });
    await tailPromise;
    showLast(25, { kind: 'service', runtimeKey }, {
        ...sourceDependencies,
        spawnSync: (command, args, options) => {
            calls.push({ command, args, options });
            return { status: 0 };
        },
    });
    assert.deepEqual(calls.map(({ command, args }) => ({ command, args })), [
        { command: 'podman', args: ['logs', '--follow', '--tail', '0', containerId] },
        { command: 'podman', args: ['logs', '--tail', '25', containerId] },
    ]);
});

test('log command targets require exact service/task identities', () => {
    assert.deepEqual(parseLogTarget([]), { kind: 'router' });
    assert.deepEqual(parseLogTarget(['router']), { kind: 'router' });
    assert.deepEqual(parseLogTarget(['service', runtimeKey]), { kind: 'service', runtimeKey });
    assert.deepEqual(parseLogTarget(['task', runtimeKey, taskId]), {
        kind: 'task', runtimeKey, taskId,
    });
    for (const value of [
        ['service'],
        ['task', runtimeKey],
        ['task', runtimeKey, taskId, 'ignored'],
        ['container', runtimeKey],
        ['service', '../escape'],
    ]) {
        assert.throws(
            () => parseLogTarget(value),
            (error) => error?.code === 'PLOINKY_LOG_TARGET_INVALID',
        );
    }
});

test('CLI log grammar routes exact tail and last targets through parsed target objects', () => {
    assert.deepEqual(parseLogsCommandOptions(['tail']), {
        action: 'tail',
        target: { kind: 'router' },
    });
    assert.deepEqual(parseLogsCommandOptions(['tail', 'service', runtimeKey]), {
        action: 'tail',
        target: { kind: 'service', runtimeKey },
    });
    assert.deepEqual(parseLogsCommandOptions(['last', '25', 'task', runtimeKey, taskId]), {
        action: 'last',
        count: 25,
        target: { kind: 'task', runtimeKey, taskId },
    });
    for (const args of [
        [],
        ['tail', 'service'],
        ['last'],
        ['last', '0'],
        ['last', '2x'],
        ['last', '2', 'task', runtimeKey],
        ['unknown'],
    ]) {
        assert.throws(
            () => parseLogsCommandOptions(args),
            (error) => error?.code === 'PLOINKY_LOG_COMMAND_INVALID'
                || error?.code === 'PLOINKY_LOG_TARGET_INVALID',
        );
    }
});
