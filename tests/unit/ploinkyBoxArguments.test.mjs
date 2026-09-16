import assert from 'node:assert/strict';
import test from 'node:test';

import { parseOuterArguments } from '../../ploinky-box/command/parse.mjs';
import { routeOuterCommand } from '../../ploinky-box/command/route.mjs';
import { parseStartArgs } from '../../cli/utils/repos.js';

test('bare start reaches core without inventing an agent from the Router port', () => {
    for (const [argv, expected] of [
        [['start'], ['start']],
        [['--debug', 'start'], ['--debug', 'start']],
        [['--port', '9090', '--udp-port', '17891', 'start'], ['start']],
        [['start', '--branch', 'candidate'], ['start', '--branch', 'candidate']],
        [['start', '--profile', 'local'], ['start', '--profile', 'local']],
    ]) {
        const parsed = parseOuterArguments(argv);
        const route = routeOuterCommand(parsed);
        assert.equal(route.kind, 'start');
        assert.deepEqual(parsed.start.coreArgv, expected);
        const core = parseStartArgs(parsed.start.coreArgv.slice(parsed.start.coreArgv.indexOf('start') + 1));
        assert.equal(core.staticAgent, null);
        assert.equal(core.port, null);
    }
    const selected = parseOuterArguments(['--port', '9090', '--udp-port', '17891', 'start']);
    assert.equal(selected.start.hostPort, 9090);
    assert.equal(selected.start.mediaHostPort, 17891);
});

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
        [['restart'], 'restart'],
        [['restart', 'Agent'], 'restart'],
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

test('status accepts only verbose detail and preserves debug for read-only core forwarding', () => {
    assert.deepEqual(routeOuterCommand(parseOuterArguments(['status'])), {
        kind: 'status',
        coreArgv: ['status'],
    });
    assert.deepEqual(routeOuterCommand(parseOuterArguments(['status', '--verbose'])), {
        kind: 'status',
        coreArgv: ['status', '--verbose'],
    });
    assert.deepEqual(routeOuterCommand(parseOuterArguments(['--debug', 'status'])), {
        kind: 'status',
        coreArgv: ['--debug', 'status'],
    });
    for (const argv of [
        ['status', '--json'],
        ['status', '--verbose', '--verbose'],
    ]) {
        assert.throws(
            () => routeOuterCommand(parseOuterArguments(argv)),
            /Usage: status \[--verbose\]/,
        );
    }
});

test('diagnose accepts JSON and selected ports without forwarding or starting a deployment', () => {
    assert.deepEqual(routeOuterCommand(parseOuterArguments(['diagnose'])), { kind: 'diagnose', json: false });
    assert.deepEqual(routeOuterCommand(parseOuterArguments(['diagnose', '--json'])), { kind: 'diagnose', json: true });
    assert.deepEqual(routeOuterCommand(parseOuterArguments(['--debug', 'diagnose', '--json'])), { kind: 'diagnose', json: true });
    const selectedPorts = parseOuterArguments(['--port', '18080', '--udp-port', '17882', 'diagnose', '--json']);
    assert.equal(selectedPorts.explicitPort, 18080);
    assert.equal(selectedPorts.explicitMediaPort, 17882);
    assert.deepEqual(routeOuterCommand(selectedPorts), { kind: 'diagnose', json: true });
    for (const argv of [
        ['diagnose', 'Agent'],
        ['diagnose', '--json', '--json'],
        ['diagnose', '--port', '8080'],
        ['--dry-run', 'diagnose'],
    ]) {
        assert.throws(() => routeOuterCommand(parseOuterArguments(argv)), { code: 'PLOINKY_BOX_ARGUMENT_INVALID' });
    }
});

test('repair accepts explicit user repairs, dry-run plans, JSON, and deployment ports', () => {
    for (const [argv, dryRun, json] of [
        [['repair'], false, false],
        [['repair', '--json'], false, true],
        [['repair', '--dry-run'], true, false],
        [['repair', '--dry-run', '--json'], true, true],
        [['repair', '--json', '--dry-run'], true, true],
        [['--dry-run', 'repair'], true, false],
        [['--debug', '--dry-run', 'repair', '--json'], true, true],
        [['--', 'repair', '--dry-run', '--json'], true, true],
    ]) {
        assert.deepEqual(routeOuterCommand(parseOuterArguments(argv)), { kind: 'repair', dryRun, json });
    }
    const selectedPorts = parseOuterArguments(['--port', '18080', '--udp-port', '17882', 'repair', '--json']);
    assert.equal(selectedPorts.explicitPort, 18080);
    assert.equal(selectedPorts.explicitMediaPort, 17882);
    assert.deepEqual(routeOuterCommand(selectedPorts), { kind: 'repair', dryRun: false, json: true });
});

test('repair rejects ambiguous, malformed, and unsupported options before running fixes', () => {
    for (const argv of [
        ['repair', 'Agent'],
        ['repair', '--json', '--json'],
        ['repair', '--dry-run', '--dry-run'],
        ['--dry-run', 'repair', '--dry-run'],
        ['--dry-run', '--dry-run', 'repair'],
        ['repair', '--json=true'],
        ['repair', '--dry-run=true'],
        ['repair', '--force'],
        ['repair', '--sudo'],
        ['repair', '--port', '8080'],
        ['repair', '--udp-port', '17882'],
        ['--port', '0', 'repair'],
        ['--udp-port', '65536', 'repair'],
        ['--port', '18080', '--port', '18081', 'repair'],
        ['--udp-port', '17882', '--udp-port', '17883', 'repair'],
    ]) {
        assert.throws(
            () => routeOuterCommand(parseOuterArguments(argv)),
            { code: 'PLOINKY_BOX_ARGUMENT_INVALID' },
            argv.join(' '),
        );
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
    assert.deepEqual(routeOuterCommand(parseOuterArguments(['update', process.cwd()])), {
        kind: 'update',
        coreArgv: ['update', process.cwd()],
    });
    assert.deepEqual(routeOuterCommand(parseOuterArguments([
        'update', '--branch', 'candidate', 'all', '/workspace/projects',
    ])), {
        kind: 'update',
        coreArgv: ['update', '--branch', 'candidate', 'all', '/workspace/projects'],
    });
    assert.deepEqual(routeOuterCommand(parseOuterArguments(['update', 'repos'])), {
        kind: 'generic',
        coreArgv: ['update', 'repos'],
    });
    assert.deepEqual(routeOuterCommand(parseOuterArguments(['update', 'missing-managed-repo'])), {
        kind: 'generic',
        coreArgv: ['update', 'missing-managed-repo'],
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

test('bind routes one strict mapping or the bare wildcard form without core forwarding', () => {
    const mapping = (address, hostPort) => ({ address, hostPort, containerPort: 8080 });
    assert.deepEqual(routeOuterCommand(parseOuterArguments(['bind'])), { kind: 'bind', mapping: null });
    for (const [argv, expected] of [
        [['bind', '0:8083:8080'], mapping('0.0.0.0', 8083)],
        [['bind', '0.0.0.0:8083:8080'], mapping('0.0.0.0', 8083)],
        [['bind', '192.168.1.50:8083:8080'], mapping('192.168.1.50', 8083)],
        [['bind', '127.0.0.1:8083:8080'], mapping('127.0.0.1', 8083)],
        [['bind', '0:8081:8080'], mapping('0.0.0.0', 8081)],
        [['--debug', 'bind', '0:8083:8080'], mapping('0.0.0.0', 8083)],
        [['bind', '-d', '0:8083:8080'], mapping('0.0.0.0', 8083)],
    ]) {
        assert.deepEqual(routeOuterCommand(parseOuterArguments(argv)), { kind: 'bind', mapping: expected }, argv.join(' '));
    }
    assert.deepEqual(routeOuterCommand(parseOuterArguments(['--dry-run', 'bind', '0:8083:8080'])), {
        kind: 'bind-dry-run',
        mapping: mapping('0.0.0.0', 8083),
    });
    assert.deepEqual(routeOuterCommand(parseOuterArguments(['--dry-run', 'bind'])), {
        kind: 'bind-dry-run',
        mapping: null,
    });
});

test('bind rejects extra, option-like, conflicting, and invalid arguments before routing', () => {
    for (const [argv, pattern] of [
        [['bind', '0:8083:8080', 'extra'], /unexpected trailing argument 'extra'/],
        [['bind', '--dry-run', '0:8083:8080'], /does not accept option --dry-run/],
        [['bind', '--port', '9090'], /does not accept option --port/],
        [['--port', '9090', 'bind'], /--port is valid only before start/],
        [['--udp-port', '17891', 'bind', '0:8083:8080'], /--udp-port is valid only before start/],
        [['--dry-run', '--dry-run', 'bind'], /supplied more than once/],
        [['bind', '0:8083:8081'], /8081 is the private Router listener/],
        [['bind', '0:8083:7000'], /agent and service ports/],
        [['bind', 'localhost:8083:8080'], /host names are not resolved/],
        [['bind', '192.168.1.50:8083'], /exactly three fields/],
        [['bind', '0:0:8080'], /HOST_TCP_PORT/],
    ]) {
        assert.throws(
            () => routeOuterCommand(parseOuterArguments(argv)),
            (error) => error.code === 'PLOINKY_BOX_ARGUMENT_INVALID' && pattern.test(error.message),
            argv.join(' '),
        );
    }
});
