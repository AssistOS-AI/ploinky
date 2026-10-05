import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';

let blockedCalls = 0;
const block = () => { blockedCalls += 1; throw new Error('logger-control-runtime-forbidden'); };
const guarded = [[childProcess, 'spawn'], [childProcess, 'spawnSync'], [childProcess, 'exec'],
    [childProcess, 'execSync'], [childProcess, 'execFile'], [childProcess, 'execFileSync'], [childProcess, 'fork'],
    [net.Socket.prototype, 'connect'], [http, 'request'], [http, 'get'], [https, 'request'], [https, 'get'],
    [dgram, 'createSocket'], [process, 'kill'], [globalThis, 'fetch']].map(([owner, name]) => {
    const original = owner[name]; owner[name] = block; return { owner, name, original };
});
syncBuiltinESMExports();
after(() => {
    for (const { owner, name, original } of guarded) owner[name] = original;
    syncBuiltinESMExports(); assert.equal(blockedCalls, 0);
});
const { reportDependencyCollection } = await import('../../cli/utils/dependencies/store/collector.mjs');
const { isDebugMode, setDebugMode } = await import('../../cli/utils/config.js');
const { parseOuterArguments } = await import('../../ploinky-box/command/parse.mjs');
const { routeOuterCommand } = await import('../../ploinky-box/command/route.mjs');

const result = () => ({ skipped: null, removed: ['selected-object'], retained: [], retainedBytesByReason: { 'container-mount': 12 } });

function capture({ debugMode, environment, operation }) {
    const previousMode = isDebugMode(), previousEnvironment = process.env.PLOINKY_DEBUG, previousLog = console.log;
    const messages = [];
    try {
        setDebugMode(debugMode);
        if (environment === undefined) delete process.env.PLOINKY_DEBUG;
        else process.env.PLOINKY_DEBUG = environment;
        console.log = (...values) => { messages.push(values.join(' ')); };
        const returned = operation();
        return { messages, returned };
    } finally {
        console.log = previousLog; setDebugMode(previousMode);
        if (previousEnvironment === undefined) delete process.env.PLOINKY_DEBUG;
        else process.env.PLOINKY_DEBUG = previousEnvironment;
    }
}

test('supported CLI debug mode emits ordinary GC summary without an environment override', () => {
    const value = result();
    const observed = capture({ debugMode: true, operation: () => reportDependencyCollection(value) });
    assert.equal(observed.returned, value);
    assert.equal(observed.messages.length, 1);
    assert.match(observed.messages[0], /^\[DEBUG\] \[deps-gc\] removed 1 object\(s\); retained bytes by reason /);
});

test('non-debug mode stays quiet; existing environment and injected logger behavior are preserved', () => {
    const value = result();
    const quiet = capture({ debugMode: false, operation: () => reportDependencyCollection(value) });
    assert.equal(quiet.returned, value); assert.deepEqual(quiet.messages, []);
    const environment = capture({ debugMode: false, environment: '1', operation: () => reportDependencyCollection(value) });
    assert.equal(environment.messages.length, 1);
    const messages = [];
    const supplied = capture({ debugMode: false, operation: () => reportDependencyCollection(value, message => messages.push(message)) });
    assert.equal(supplied.returned, value); assert.deepEqual(supplied.messages, []); assert.equal(messages.length, 1);
    assert.equal(reportDependencyCollection(null, () => { throw new Error('null result must not log'); }), null);
});

test('supported outer debug reinstall forwards the debug flag to the actual generic core command', () => {
    const argv = ['--debug', 'reinstall', 'owned-probe-alias'];
    const route = routeOuterCommand(parseOuterArguments(argv), { cwd: '/home/operator/work/testExplorerFresh' });
    assert.equal(route.kind, 'generic');
    assert.deepEqual(route.coreArgv, argv);
});
