import assert from 'node:assert/strict';
import test from 'node:test';

import { parseOuterArguments } from '../../ploinky-box/command/parse.mjs';
import {
    ALLOW_HOST_PROCESSES_ENV,
    allowHostProcessArgs,
    allowHostProcessesFromEnv,
    parseAllowHostProcesses,
} from '../helpers/allowHostProcesses.mjs';

test('PLOINKY_TEST_ALLOW_HOST_PROCESSES accepts only positive integer PIDs and is never defaulted', () => {
    assert.deepEqual(allowHostProcessesFromEnv({}), [], 'unset: no allowance');
    assert.deepEqual(parseAllowHostProcesses('4242'), [4242]);
    assert.deepEqual(parseAllowHostProcesses('4242,17,4242'), [4242, 17]);
    assert.deepEqual(allowHostProcessesFromEnv({ [ALLOW_HOST_PROCESSES_ENV]: '1,2' }), [1, 2]);
    for (const malformed of ['', ',', '0', '-1', '+1', '1.5', '1e3', ' 1', '1 ', '1,,2', '1,', ',1', '1;2', '0x10', '01',
        'abc', '12345678901', '99999999999999999999']) {
        assert.throws(() => parseAllowHostProcesses(malformed), new RegExp(ALLOW_HOST_PROCESSES_ENV), JSON.stringify(malformed));
    }
    assert.throws(() => parseAllowHostProcesses(42), new RegExp(ALLOW_HOST_PROCESSES_ENV));
});

test('the forwarded allowance is exactly what `ploinky --allow-host-process PID` parses', () => {
    const pids = parseAllowHostProcesses('4242,17');
    const parsed = parseOuterArguments([...allowHostProcessArgs(pids), 'start']);
    assert.deepEqual([...parsed.allowHostProcesses], [4242, 17]);
});
