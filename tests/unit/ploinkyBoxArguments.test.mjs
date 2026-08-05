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
    assert.equal(routeOuterCommand(ordinary).kind, 'generic');
    assert.deepEqual(ordinary.forwardingArgv, ['logs', '--debug', 'tail']);

    const duplicate = parseOuterArguments(['--debug', 'logs', '-d', 'tail']);
    assert.deepEqual(duplicate.classificationArgv, ['logs', '-d', 'tail']);
    assert.deepEqual(duplicate.forwardingArgv, ['--debug', 'logs', '-d', 'tail']);
});

test('prefix and positional start ports normalize only the in-box port', () => {
    const prefix = parseOuterArguments(['--debug', '--port', '9090', 'start', 'Agent']);
    assert.equal(prefix.start.hostPort, 9090);
    assert.deepEqual(prefix.start.coreArgv, ['--debug', 'start', 'Agent', '8080']);

    const positional = parseOuterArguments(['start', 'Agent', '--debug', '9090']);
    assert.equal(positional.start.hostPort, 9090);
    assert.deepEqual(positional.start.coreArgv, ['start', 'Agent', '--debug', '8080']);
    assert.equal(routeOuterCommand(positional).kind, 'start');
});

test('port boundaries are accepted and malformed or ambiguous forms reject', () => {
    for (const value of ['1', '65535']) {
        assert.equal(parseOuterArguments(['--port', value, 'start', 'Agent']).start.hostPort, Number(value));
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
        ['--port', '9090', 'start', 'Agent', '9091'],
        ['start', 'Agent', '9090', 'tail'],
        ['start', 'Agent', 'not-a-port'],
    ];
    for (const argv of invalid) {
        assert.throws(() => parseOuterArguments(argv), { code: 'PLOINKY_BOX_ARGUMENT_INVALID' });
    }
});

test('post-command lookalikes and terminator-led commands retain spelling and order', () => {
    const ordinary = parseOuterArguments(['run', '--port', '9090', '--image=inside']);
    assert.deepEqual(ordinary.forwardingArgv, ['run', '--port', '9090', '--image=inside']);
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
        [[], 'repl'],
        [['cli'], 'bash'],
        [['bash'], 'bash'],
        [['cli', 'Agent', '--workdir', 'project', '--'], 'agent-cli'],
        [['logs'], 'generic'],
    ];
    for (const [argv, kind] of cases) {
        assert.equal(routeOuterCommand(parseOuterArguments(argv)).kind, kind);
    }
});

test('destroy accepts only one explicit trailing volume-deletion flag', () => {
    assert.deepEqual(routeOuterCommand(parseOuterArguments(['destroy'])), {
        kind: 'destroy',
        deleteVolumes: false,
    });
    assert.deepEqual(routeOuterCommand(parseOuterArguments(['destroy', '--delete-volumes'])), {
        kind: 'destroy',
        deleteVolumes: true,
    });
    assert.throws(
        () => routeOuterCommand(parseOuterArguments(['destroy', '--delete-volumes', '--delete-volumes'])),
        /supplied more than once/,
    );
    assert.throws(
        () => routeOuterCommand(parseOuterArguments(['destroy', '--volumes'])),
        /unexpected trailing argument/,
    );
    assert.throws(
        () => routeOuterCommand(parseOuterArguments(['--dry-run', 'destroy', '--delete-volumes'])),
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
