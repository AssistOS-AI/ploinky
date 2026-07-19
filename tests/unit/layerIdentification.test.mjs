import test from 'node:test';
import assert from 'node:assert/strict';
import {
    formatAgentAttachmentBanner,
    resolveAgentAttachmentIdentity,
} from '../../cli/services/layerIdentification.js';

test('agent banner uses the post-start registry image', () => {
    const identity = resolveAgentAttachmentIdentity('explorer', 'nested-explorer', {
        'nested-explorer': {
            runtime: 'container',
            containerImage: 'docker.io/assistos/ploinky-node:24-bookworm-tools',
        },
    });
    assert.deepEqual(formatAgentAttachmentBanner(identity), [
        "[ploinky] Attaching to agent 'explorer'",
        '[ploinky] container=nested-explorer',
        '[ploinky] image=docker.io/assistos/ploinky-node:24-bookworm-tools',
    ]);
});

test('host sandbox attachments identify the selected host runtime', () => {
    const identity = resolveAgentAttachmentIdentity('local-agent', 'local-agent', {
        'local-agent': { runtime: 'bwrap' },
    });
    assert.equal(identity.image, 'host (bwrap)');
});
