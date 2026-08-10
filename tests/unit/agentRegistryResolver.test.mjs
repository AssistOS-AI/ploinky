import assert from 'node:assert/strict';
import test from 'node:test';

import {
    enabledAgentLogSuggestionsFromMap,
    explainAgentReferenceFailure,
    parseQualifiedAgentReference,
    resolveEnabledAgentRecordFromMap,
} from '../../cli/utils/agentRegistryResolver.js';

function agent(repoName, agentName, extra = {}) {
    return { type: 'agent', repoName, agentName, ...extra };
}

const REGISTRY = Object.freeze({
    _config: { static: { agent: 'demo/shared' } },
    blue_container: agent('demo', 'shared', { alias: 'blue', profile: 'dev' }),
    green_container: agent('demo', 'shared', { alias: 'green', profile: 'prod' }),
    solo_container: agent('demo', 'solo', { profile: 'prod' }),
    other_container: agent('other', 'solo', { alias: 'otherSolo' }),
    disabled_container: { type: 'skill', repoName: 'demo', agentName: 'shared' },
});

test('an exact registry key resolves before any alias or name search', () => {
    assert.equal(resolveEnabledAgentRecordFromMap('blue_container', REGISTRY).containerName, 'blue_container');
    assert.equal(resolveEnabledAgentRecordFromMap('solo_container', REGISTRY).containerName, 'solo_container');
    // A reserved key is never an agent record even when spelled exactly.
    assert.equal(resolveEnabledAgentRecordFromMap('_config', REGISTRY), null);
    // A non-agent record under an exact key is not selectable.
    assert.equal(resolveEnabledAgentRecordFromMap('disabled_container', REGISTRY), null);
});

test('a unique unqualified alias resolves and a duplicate alias fails closed', () => {
    assert.equal(resolveEnabledAgentRecordFromMap('blue', REGISTRY).record.profile, 'dev');
    assert.equal(resolveEnabledAgentRecordFromMap('green', REGISTRY).record.profile, 'prod');

    const duplicated = {
        first_container: agent('repoA', 'one', { alias: 'shared' }),
        second_container: agent('repoB', 'two', { alias: 'shared' }),
    };
    assert.throws(
        () => resolveEnabledAgentRecordFromMap('shared', duplicated),
        (error) => error.code === 'AGENT_ALIAS_AMBIGUOUS'
            && /Use one of: repoA\/one, repoB\/two/.test(error.message),
    );
});

test('a qualified reference matches repo plus agent and never falls back to an alias', () => {
    assert.equal(resolveEnabledAgentRecordFromMap('demo/solo', REGISTRY).containerName, 'solo_container');
    assert.equal(resolveEnabledAgentRecordFromMap('demo:solo', REGISTRY).containerName, 'solo_container');
    assert.equal(resolveEnabledAgentRecordFromMap('other/solo', REGISTRY).containerName, 'other_container');

    // The former resolver stripped the qualifier and searched the bare alias
    // across every repository, so `repoA/foo` could select repoB's alias `foo`.
    const crossRepo = {
        a_container: agent('repoA', 'alpha'),
        b_container: agent('repoB', 'beta', { alias: 'alpha' }),
    };
    assert.equal(resolveEnabledAgentRecordFromMap('repoB/alpha', crossRepo), null);
    assert.equal(resolveEnabledAgentRecordFromMap('repoA/alpha', crossRepo).containerName, 'a_container');
});

test('a duplicate qualified identity is ambiguous rather than first-match', () => {
    assert.throws(
        () => resolveEnabledAgentRecordFromMap('demo/shared', REGISTRY),
        (error) => error.code === 'AGENT_ALIAS_AMBIGUOUS'
            && /Use one of: blue, green/.test(error.message),
    );
});

test('a unique bare agent name resolves and a duplicate bare name fails closed', () => {
    const unique = { only_container: agent('demo', 'unique') };
    assert.equal(resolveEnabledAgentRecordFromMap('unique', unique).containerName, 'only_container');
    // `solo` exists in two repositories, so the bare name must not select one.
    assert.throws(
        () => resolveEnabledAgentRecordFromMap('solo', REGISTRY),
        (error) => error.code === 'AGENT_ALIAS_AMBIGUOUS',
    );
});

test('malformed qualified spellings never fall through to a bare-name search', () => {
    for (const malformed of ['demo/', '/solo', 'demo//solo', 'demo/other/solo', 'demo:other:solo', 'demo/other:solo']) {
        assert.equal(parseQualifiedAgentReference(malformed).malformed, true, malformed);
        assert.equal(resolveEnabledAgentRecordFromMap(malformed, REGISTRY), null, malformed);
    }
    assert.deepEqual(parseQualifiedAgentReference('demo/solo'), {
        qualified: true, malformed: false, repoName: 'demo', agentName: 'solo',
    });
    assert.deepEqual(parseQualifiedAgentReference('solo'), { qualified: false, malformed: false });
});

test('ambiguity diagnostics are sorted and never depend on map insertion order', () => {
    const forward = {
        z_container: agent('demo', 'dup', { alias: 'zeta' }),
        a_container: agent('demo', 'dup', { alias: 'alpha' }),
    };
    const reversed = {
        a_container: agent('demo', 'dup', { alias: 'alpha' }),
        z_container: agent('demo', 'dup', { alias: 'zeta' }),
    };
    const messages = [forward, reversed].map((registry) => {
        try {
            resolveEnabledAgentRecordFromMap('demo/dup', registry);
            return null;
        } catch (error) {
            return error.message;
        }
    });
    assert.equal(messages[0], messages[1]);
    assert.match(messages[0], /Use one of: alpha, zeta/);
});

test('an agent named router stays reachable through a qualified reference', () => {
    const registry = {
        router_container: agent('demo', 'router', { alias: 'edgeRouter' }),
        plain_container: agent('demo', 'plain'),
    };
    assert.equal(resolveEnabledAgentRecordFromMap('demo/router', registry).containerName, 'router_container');
    assert.equal(resolveEnabledAgentRecordFromMap('edgeRouter', registry).containerName, 'router_container');
    // The bare spelling is reserved by the log grammar, so completion must not
    // advertise it even though the resolver itself would match the name.
    const suggestions = enabledAgentLogSuggestionsFromMap(registry);
    assert.equal(suggestions.includes('router'), false);
    assert.equal(suggestions.includes('demo/router'), false);
    assert.equal(suggestions.includes('edgeRouter'), true);
});

test('completion never offers a bare alias named router', () => {
    const registry = { reserved_container: agent('demo', 'gateway', { alias: 'router' }) };
    const suggestions = enabledAgentLogSuggestionsFromMap(registry);
    assert.equal(suggestions.includes('router'), false);
    assert.deepEqual(suggestions, ['demo/gateway']);
});

test('completion offers only references that resolve to exactly one record', () => {
    const suggestions = enabledAgentLogSuggestionsFromMap(REGISTRY);
    assert.deepEqual(suggestions, ['blue', 'demo/solo', 'green', 'otherSolo']);
    for (const suggestion of suggestions) {
        assert.ok(resolveEnabledAgentRecordFromMap(suggestion, REGISTRY), `unusable suggestion: ${suggestion}`);
    }
    // Ambiguous short forms are excluded, and no reserved or non-agent key leaks.
    assert.equal(suggestions.includes('demo/shared'), false);
    assert.equal(suggestions.includes('solo'), false);
    assert.equal(suggestions.includes('_config'), false);
});

test('completion falls back to the exact registry key when no short form is unique', () => {
    const registry = {
        first_container: agent('demo', 'twin'),
        second_container: agent('demo', 'twin'),
    };
    assert.deepEqual(enabledAgentLogSuggestionsFromMap(registry), ['first_container', 'second_container']);
});

test('completion rejects registry spellings the log grammar cannot consume verbatim', () => {
    const registry = {
        dash_container: agent('safe', 'dash', { alias: '--startup' }),
        whitespace_container: agent('safe repo', 'space agent', { alias: 'two words' }),
        numeric_container: agent('9repo', '9agent', { alias: '42' }),
        control_container: agent('safe\u009b', 'control\u0000name', { alias: 'bad\nvalue' }),
        unicode_space_container: agent('safe\u00a0repo', 'space\u2028agent', { alias: 'bad\u2003value' }),
    };
    const suggestions = enabledAgentLogSuggestionsFromMap(registry);
    assert.deepEqual(suggestions, [
        'control_container',
        'numeric_container',
        'safe/dash',
        'unicode_space_container',
        'whitespace_container',
    ]);
    for (const suggestion of suggestions) {
        assert.equal(suggestion.startsWith('-'), false);
        assert.equal(/^[+.]?[0-9]/.test(suggestion), false);
        assert.equal(/[\s\u0000-\u001f\u007f-\u009f]/u.test(suggestion), false);
        assert.ok(resolveEnabledAgentRecordFromMap(suggestion, registry));
    }
});

test('preferred references round-trip through exact-key and router collisions', () => {
    const registry = {
        blue: agent('repoA', 'owner'),
        second_container: agent('repoB', 'second', { alias: 'blue' }),
        router: agent('repoC', 'router'),
    };
    const suggestions = enabledAgentLogSuggestionsFromMap(registry);
    assert.deepEqual(suggestions, ['repoA/owner', 'repoB/second', 'repoC/router']);
    const expected = new Map([
        ['repoA/owner', 'blue'],
        ['repoB/second', 'second_container'],
        ['repoC/router', 'router'],
    ]);
    for (const suggestion of suggestions) {
        assert.equal(
            resolveEnabledAgentRecordFromMap(suggestion, registry).containerName,
            expected.get(suggestion),
        );
    }
});

test('reference failures are explained without selecting a record', () => {
    assert.equal(explainAgentReferenceFailure('blue', REGISTRY), null);

    const malformed = explainAgentReferenceFailure('demo/other/solo', REGISTRY);
    assert.equal(malformed.reason, 'malformed-qualified-reference');
    assert.match(malformed.message, /not one exact 'repo\/agent' reference/);

    const unknown = explainAgentReferenceFailure('absent', REGISTRY);
    assert.equal(unknown.reason, 'unknown-reference');
    assert.deepEqual(unknown.suggestions, ['blue', 'demo/solo', 'green', 'otherSolo']);

    const ambiguous = explainAgentReferenceFailure('demo/shared', REGISTRY);
    assert.equal(ambiguous.reason, 'ambiguous-reference');
    assert.deepEqual(ambiguous.suggestions, ['blue', 'green']);
});

test('completion builds one registry index instead of rescanning per candidate', () => {
    const records = Object.fromEntries(Array.from({ length: 2_000 }, (_, index) => [
        `container_${index}`,
        agent(`repo_${index}`, `agent_${index}`, { alias: `alias_${index}` }),
    ]));
    let ownKeyScans = 0;
    const registry = new Proxy(records, {
        ownKeys(target) {
            ownKeyScans += 1;
            return Reflect.ownKeys(target);
        },
    });

    const suggestions = enabledAgentLogSuggestionsFromMap(registry);
    assert.equal(suggestions.length, 2_000);
    assert.equal(ownKeyScans, 1, 'the registry must be enumerated exactly once');
});
