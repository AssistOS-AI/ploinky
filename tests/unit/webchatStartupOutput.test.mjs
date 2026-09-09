import test from 'node:test';
import assert from 'node:assert/strict';
import { CLI_OUTPUT_BOUNDARY, createStartupOutputFilter } from '../../cli/server/webchat/startupOutput.js';

test('launcher output is discarded while agent greetings and errors survive every split boundary', () => {
    for (let split = 0; split <= CLI_OUTPUT_BOUNDARY.length; split++) {
        const output = [];
        const receive = createStartupOutputFilter((chunk) => output.push(chunk));
        receive('[deps-cache] npm install\nnpm warn noise\ncontainer-id\n');
        receive(CLI_OUTPUT_BOUNDARY.slice(0, split));
        receive(CLI_OUTPUT_BOUNDARY.slice(split) + 'greeting\n');
        receive('agent error\n');
        assert.equal(output.join(''), 'greeting\nagent error\n');
    }
});

test('late installer stderr is not emitted after stdout has crossed its boundary', () => {
    const output = [];
    const stdout = createStartupOutputFilter((chunk) => output.push(chunk));
    const stderr = createStartupOutputFilter((chunk) => output.push(chunk));
    stdout(CLI_OUTPUT_BOUNDARY + 'hello\n');
    stderr('npm notices\n');
    stderr(CLI_OUTPUT_BOUNDARY + 'runtime error\n');
    assert.deepEqual(output, ['hello\n', 'runtime error\n']);
});
