import test from 'node:test';
import assert from 'node:assert/strict';

import { getCommandRegistry, isKnownCommand } from '../../cli/commands/commandRegistry.js';

test('core CLI exposes no research-specific enable command', () => {
    const commands = getCommandRegistry();
    assert.deepEqual(commands.enable, ['repo', 'agent', 'sandbox']);
    assert.equal(isKnownCommand('research'), false);
    assert.equal(commands.research, undefined);
    assert.equal(commands.enable.includes('research'), false);
    assert.equal(commands.enable.includes('research-agents'), false);
});
