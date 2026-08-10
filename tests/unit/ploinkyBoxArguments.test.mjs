import assert from 'node:assert/strict';
import test from 'node:test';

import { parseOuterArguments } from '../../ploinky-box/command/parse.mjs';
import { routeOuterCommand } from '../../ploinky-box/command/route.mjs';

test('first debug token is removed only from classification and preserved for core forwarding', () => {
    const stop = parseOuterArguments(['--debug', 'stop']);
    assert.deepEqual(stop.classificationArgv, ['stop']);
    assert.deepEqual(stop.forwardingArgv, ['--debug', 'stop']);
    assert.equal(routeOuterCommand(stop).kind, 'stop');

    const ordinary = parseOuterArguments(['logs', '--debug', 'tail']);
    const ordinaryRoute = routeOuterCommand(ordinary);
    assert.equal(ordinaryRoute.kind, 'logs');
    assert.deepEqual(ordinary.forwardingArgv, ['logs', '--debug', 'tail']);
    // The inspect-only logs route forwards the original Core argv unchanged.
    assert.deepEqual(ordinaryRoute.coreArgv, ['logs', '--debug', 'tail']);

    const generic = parseOuterArguments(['list', '--debug', 'agents']);
    assert.equal(routeOuterCommand(generic).kind, 'generic');
    assert.deepEqual(generic.forwardingArgv, ['list', '--debug', 'agents']);

    const duplicate = parseOuterArguments(['--debug', 'logs', '-d', 'tail']);
    assert.deepEqual(duplicate.classificationArgv, ['logs', '-d', 'tail']);
    assert.deepEqual(duplicate.forwardingArgv, ['--debug', 'logs', '-d', 'tail']);
});

test('prefix and positional start ports normalize only the in-box port', () => {
    const prefix = parseOuterArguments([
        '--debug', '--port', '9090', '--udp-port', '17891', 'start', 'Agent',
    ]);
    assert.equal(prefix.start.hostPort, 9090);
    assert.equal(prefix.start.mediaHostPort, 17891);
    assert.deepEqual(prefix.start.coreArgv, ['--debug', 'start', 'Agent', '8080']);
    assert.equal(routeOuterCommand(prefix).mediaHostPort, 17891);

    const positional = parseOuterArguments(['start', 'Agent', '--debug', '9090']);
    assert.equal(positional.start.hostPort, 9090);
    assert.deepEqual(positional.start.coreArgv, ['start', 'Agent', '--debug', '8080']);
    assert.equal(routeOuterCommand(positional).kind, 'start');
});

test('port boundaries are accepted and malformed or ambiguous forms reject', () => {
    for (const value of ['1', '65535']) {
        assert.equal(parseOuterArguments(['--port', value, 'start', 'Agent']).start.hostPort, Number(value));
        assert.equal(
            parseOuterArguments(['--udp-port', value, 'start', 'Agent']).start.mediaHostPort,
            Number(value),
        );
        assert.equal(parseOuterArguments(['start', 'Agent', value]).start.hostPort, Number(value));
    }
    const invalid = [
        ['--port'],
        ['--port', '0', 'start', 'Agent'],
        ['--port', '-1', 'start', 'Agent'],
        ['--port', '1.5', 'start', 'Agent'],
        ['--port', '１２', 'start', 'Agent'],
        ['--port', '65536', 'start', 'Agent'],
        ['--port=9090', 'start', 'Agent'],
        ['--port', '9090', '--port', '9091', 'start', 'Agent'],
        ['--udp-port'],
        ['--udp-port', '0', 'start', 'Agent'],
        ['--udp-port=17891', 'start', 'Agent'],
        ['--udp-port', '17891', '--udp-port', '17892', 'start', 'Agent'],
        ['--udp-port', '17891', 'status'],
        ['--media-port', '17891', 'start', 'Agent'],
        ['start', 'Agent', '--udp-port', '17891'],
        ['--port', '9090', 'start', 'Agent', '9091'],
        ['start', 'Agent', '9090', 'tail'],
        ['start', 'Agent', 'not-a-port'],
    ];
    for (const argv of invalid) {
        assert.throws(() => parseOuterArguments(argv), { code: 'PLOINKY_BOX_ARGUMENT_INVALID' });
    }
});

test('post-command lookalikes and terminator-led commands retain spelling and order', () => {
    const ordinary = parseOuterArguments(['run', '--port', '9090', '--udp-port', '17891', '--image=inside']);
    assert.deepEqual(ordinary.forwardingArgv, [
        'run', '--port', '9090', '--udp-port', '17891', '--image=inside',
    ]);
    assert.equal(routeOuterCommand(ordinary).kind, 'generic');

    const terminated = parseOuterArguments(['--', '--help', 'topic']);
    assert.equal(terminated.command, '--help');
    assert.deepEqual(terminated.forwardingArgv, ['--help', 'topic']);
    assert.equal(routeOuterCommand(terminated).kind, 'generic');
});

test('dispatch order keeps marker, built-ins, explicit start, REPL, bash, and generic distinct', () => {
    const cases = [
        [['status'], 'status'],
        [['stop'], 'stop'],
        [['destroy'], 'destroy'],
        [['start', 'Agent'], 'start'],
        [['update'], 'update'],
        [['update', 'all'], 'update'],
        [['update', 'repos'], 'generic'],
        [['update', 'repo', 'demo'], 'generic'],
        [[], 'repl'],
        [['cli'], 'bash'],
        [['bash'], 'bash'],
        [['cli', 'Agent'], 'agent-cli'],
        [['list', 'agents'], 'generic'],
        // Logs get their own inspect-only route so they never take the
        // generic path, which prepares (and can create or repair) the Box.
        [['logs'], 'logs'],
        [['logs', 'tail', 'someAgent'], 'logs'],
    ];
    for (const [argv, kind] of cases) {
        assert.equal(routeOuterCommand(parseOuterArguments(argv)).kind, kind);
    }
});

test('full update routes through the host while targeted update forms remain generic', () => {
    assert.deepEqual(routeOuterCommand(parseOuterArguments(['--debug', 'update'])), {
        kind: 'update',
        coreArgv: ['--debug', 'update'],
    });
    assert.deepEqual(routeOuterCommand(parseOuterArguments(['update', 'all', '/workspace/projects'])), {
        kind: 'update',
        coreArgv: ['update', 'all', '/workspace/projects'],
    });
    assert.deepEqual(routeOuterCommand(parseOuterArguments(['update', 'repos'])), {
        kind: 'generic',
        coreArgv: ['update', 'repos'],
    });
    assert.equal(routeOuterCommand(parseOuterArguments(['--dry-run', 'update'])).kind, 'dry-run');
});

test('destroy accepts only one explicit trailing cache-deletion flag', () => {
    assert.deepEqual(routeOuterCommand(parseOuterArguments(['destroy'])), {
        kind: 'destroy',
        deleteCache: false,
    });
    assert.deepEqual(routeOuterCommand(parseOuterArguments(['destroy', '--delete-cache'])), {
        kind: 'destroy',
        deleteCache: true,
    });
    assert.throws(
        () => routeOuterCommand(parseOuterArguments(['destroy', '--delete-cache', '--delete-cache'])),
        /supplied more than once/,
    );
    // The retired named-volume flag is rejected, not silently accepted.
    for (const retired of ['--delete-volumes', '--volumes']) {
        assert.throws(
            () => routeOuterCommand(parseOuterArguments(['destroy', retired])),
            new RegExp(`unexpected trailing argument '${retired}'`),
        );
    }
    assert.throws(
        () => routeOuterCommand(parseOuterArguments(['--dry-run', 'destroy', '--delete-cache'])),
        /--dry-run is not supported/,
    );
});

test('unsupported public override surfaces reject before routing', () => {
    for (const argv of [
        ['--image', 'candidate', 'start', 'Agent'],
        ['--engine=podman', 'status'],
        ['--name', 'foreign', 'status'],
        ['--rotate-master-key', 'start', 'Agent'],
    ]) {
        assert.throws(() => parseOuterArguments(argv), /not a supported public Box option/);
    }
});
