import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
    lsRemoteQuery,
    parseGitDependencySpec,
    parseLsRemoteOutput,
    parseResolvedGitSource,
    resolveRefFromLsRemote,
    rewriteSpecToCommit,
} from '../../cli/utils/dependencies/cacheV4/gitSpec.mjs';
import {
    PIN_VERIFICATION,
    buildPin,
    collectGitInputs,
    commitPinState,
    defaultRunGit,
    desiredPinsFor,
    discoverGitPins,
    gitLookupEnv,
    mergeDiscoveredPins,
    readPinState,
    recordObservedPins,
} from '../../cli/utils/dependencies/cacheV4/gitPins.mjs';
import { git, gitEnv, hasCommand, markerRemote, tempRoot } from './cacheV4Fixtures.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

test('cache-v4 git: supported URL forms normalize to one canonical source', () => {
    const forms = [
        'git+https://github.com/AssistOS-AI/MCPSDK.git#main',
        'github:AssistOS-AI/MCPSDK#main',
        'AssistOS-AI/MCPSDK#main',
        'git+ssh://git@github.com/AssistOS-AI/MCPSDK.git#main',
        'git+ssh://git@github.com:AssistOS-AI/MCPSDK.git#main',
        'git@github.com:AssistOS-AI/MCPSDK.git#main',
        'https://github.com/AssistOS-AI/MCPSDK#main',
    ];
    const parsed = forms.map(parseGitDependencySpec);
    for (const item of parsed) {
        assert.equal(item.supported, true, item.original);
        assert.equal(item.source, 'github.com/assistos-ai/mcpsdk');
        assert.equal(item.fetchUrl, 'https://github.com/AssistOS-AI/MCPSDK.git');
        assert.deepEqual(item.ref, { kind: 'name', name: 'main' });
    }
    assert.equal(new Set(parsed.map((item) => item.identity)).size, 1, 'spelling variants share one spec identity');
    // npm records hosted GitHub dependencies as git+ssh in its lock (not verified live here).
    assert.deepEqual(parseResolvedGitSource(`git+ssh://git@github.com/AssistOS-AI/MCPSDK.git#${SHA_A}`),
        { source: 'github.com/assistos-ai/mcpsdk', commit: SHA_A });
    const file = parseGitDependencySpec('git+file:///srv/x/../remote.git#refs/tags/v1');
    assert.equal(file.source, 'file:///srv/remote.git');
    assert.deepEqual(file.ref, { kind: 'tag', name: 'v1' });
    assert.equal(parseGitDependencySpec('git+https://git.example.com:8443/team/lib.git').source, 'git.example.com:8443/team/lib');
    assert.deepEqual(parseGitDependencySpec(`git+https://host.example/a.git#${SHA_A.toUpperCase()}`).ref, { kind: 'sha', sha: SHA_A });
    assert.equal(rewriteSpecToCommit(parseGitDependencySpec('github:o/r#main'), SHA_B), `github:o/r#${SHA_B}`);
    assert.throws(() => rewriteSpecToCommit(parseGitDependencySpec('github:o/r#main'), 'abc1234'), /full 40-character/);
});

test('cache-v4 git: non-Git specs are ignored and unsupported Git syntax is named, not guessed', () => {
    for (const spec of ['^1.2.3', 'latest', 'file:../x', 'npm:other@1', 'https://example.com/x.tgz', '']) {
        assert.equal(parseGitDependencySpec(spec), null, spec);
    }
    const cases = {
        'git+https://host.example/a.git#abc1234': /abbreviated commit/,
        'github:o/r#semver:^1.0.0': /semver/,
        'git+https://host.example/a.git#main::path:sub': /::/,
        'git+https://host.example/a.git#path:sub': /path:/,
        'gitlab:o/r': /hosted shorthand/,
        'bitbucket:o/r#main': /hosted shorthand/,
        'git+https://user:pw@host.example/a.git': /credentials/,
        'git+https://host.example/a.git#refs/pull/1/head': /not supported/,
        'git+https://host.example/a.git#bad..name': /invalid ref/,
    };
    for (const [spec, reason] of Object.entries(cases)) {
        const parsed = parseGitDependencySpec(spec);
        assert.equal(parsed.supported, false, spec);
        assert.match(parsed.reason, reason, spec);
    }
});

test('cache-v4 git: ls-remote rows resolve HEAD, branches, peeled tags and reject ambiguous names', () => {
    const refs = parseLsRemoteOutput([
        `${SHA_A}\tHEAD`,
        `${SHA_A}\trefs/heads/main`,
        `${SHA_B}\trefs/heads/dup`,
        `${'c'.repeat(40)}\trefs/tags/dup`,
        `${'d'.repeat(40)}\trefs/tags/v1`,
        `${'e'.repeat(40)}\trefs/tags/v1^{}`,
    ].join('\n'));
    const resolve = (spec) => resolveRefFromLsRemote(parseGitDependencySpec(spec), refs);
    assert.equal(resolve('github:o/r').commit, SHA_A);
    assert.equal(resolve('github:o/r#main').commit, SHA_A);
    assert.deepEqual(resolve('github:o/r#v1'), { status: 'resolved', commit: 'e'.repeat(40), resolvedRef: 'refs/tags/v1', peeled: true });
    assert.equal(resolve('github:o/r#refs/tags/v1').commit, 'e'.repeat(40));
    assert.equal(resolve('github:o/r#dup').status, 'ambiguous');
    assert.equal(resolve('github:o/r#refs/heads/dup').commit, SHA_B);
    assert.equal(resolve('github:o/r#refs/tags/dup').commit, 'c'.repeat(40));
    assert.equal(resolve('github:o/r#missing').status, 'not-found');
    assert.throws(() => parseLsRemoteOutput('not a row'), /malformed/);
    assert.deepEqual(lsRemoteQuery(parseGitDependencySpec('github:o/r#v1')).patterns, ['refs/heads/v1', 'refs/tags/v1', 'refs/tags/v1^{}']);
    assert.equal(lsRemoteQuery(parseGitDependencySpec(`github:o/r#${SHA_A}`)), null, 'a full SHA bypasses lookup');
});

test('cache-v4 git: discovery against a real local remote peels annotated tags and rejects ambiguity', { skip: !hasCommand('git') && 'git not installed' }, (t) => {
    const root = tempRoot(t);
    const env = gitEnv(root);
    const remote = markerRemote(root, env);
    git(remote.work, ['tag', '-a', 'v1', '-m', 'v1', remote.first], env);
    git(remote.work, ['tag', 'dup', remote.second], env);
    git(remote.work, ['branch', 'dup', remote.first], env);
    git(remote.work, ['push', '-q', remote.remote, 'refs/tags/v1', 'refs/tags/dup', 'refs/heads/dup'], env);
    const manifest = {
        dependencies: {
            head: remote.url,
            main: `${remote.url}#main`,
            tagged: `${remote.url}#v1`,
            ambiguous: `${remote.url}#dup`,
            exact: `${remote.url}#${remote.second}`,
            short: `${remote.url}#${remote.second.slice(0, 7)}`,
        },
        devDependencies: { dev: `${remote.url}#refs/heads/main` },
    };
    const { entries, unsupported } = collectGitInputs(manifest, { scope: 'global' });
    const calls = [];
    const runGit = (argv, options) => {
        calls.push(argv);
        assert.equal(options.env.GIT_TERMINAL_PROMPT, '0');
        return defaultRunGit(argv, options);
    };
    const { results, queriesRun } = discoverGitPins(entries, { unsupported, runGit, env });
    const byName = Object.fromEntries(results.map((result) => [entries.find((entry) => entry.pinId === result.pinId)?.name
        || unsupported.find((item) => item.pinId === result.pinId)?.name, result]));
    assert.equal(byName.head.commit, remote.first, 'bare remote HEAD follows main');
    assert.equal(byName.main.commit, remote.first);
    assert.equal(byName.dev.commit, remote.first);
    assert.equal(byName.tagged.commit, remote.first, 'annotated tag peeled to its commit');
    assert.equal(byName.tagged.peeled, true);
    assert.equal(byName.ambiguous.status, 'ambiguous');
    assert.equal(byName.exact.status, 'fixed');
    assert.equal(byName.short.status, 'unsupported');
    assert.ok(calls.every((argv) => argv[0] === 'ls-remote' && argv[1] === '--'), 'structured argv');
    assert.ok(!calls.some((argv) => argv.some((arg) => arg.includes(remote.second.slice(0, 7)))), 'abbreviated SHA never queried');
    assert.equal(queriesRun, calls.length);
    assert.equal(queriesRun, 5, 'identical (URL, patterns) queries are deduplicated: HEAD, main, refs/heads/main, v1, dup');
});

test('cache-v4 git: identical queries are deduplicated and the deadline bounds lookups', () => {
    const manifest = { dependencies: { a: 'github:o/r#main', b: 'git+https://github.com/o/r.git#main' }, devDependencies: { c: 'github:o/r#other' } };
    const { entries } = collectGitInputs(manifest, { scope: 'global' });
    let calls = 0;
    const runGit = () => { calls += 1; return { status: 0, stdout: `${SHA_A}\trefs/heads/main\n`, stderr: '', error: null }; };
    const discovered = discoverGitPins(entries, { runGit });
    assert.equal(calls, 2, 'a and b share one query; c needs its own');
    let clock = 0;
    const slow = () => { clock += 1000; return { status: 0, stdout: `${SHA_A}\trefs/heads/main\n`, stderr: '', error: null }; };
    const bounded = discoverGitPins(entries, { runGit: slow, deadlineMs: 500, now: () => clock });
    assert.deepEqual(bounded.results.map((result) => result.status).sort(), ['deadline-exceeded', 'resolved', 'resolved']);
    const failed = discoverGitPins(entries, { runGit: () => ({ status: null, stdout: '', stderr: '', error: 'ETIMEDOUT' }) });
    assert.ok(failed.results.every((result) => result.status === 'failed'));
    assert.equal(discovered.results.find((r) => r.status === 'not-found') !== undefined, true, 'c has no matching ref');
    assert.equal(gitLookupEnv({}).GIT_TERMINAL_PROMPT, '0');
});

test('cache-v4 git: pin merge keeps same-spec pins after failures and never inherits across specs', () => {
    const binding = { scope: 'registration', registration: 'repo/agent', packageSource: 'repo/agent/package.json' };
    const oldManifest = { dependencies: { a: 'github:o/r#main', b: 'github:o/r#dev', gone: 'github:o/r#x' } };
    const old = collectGitInputs(oldManifest, binding).entries;
    let pins = {};
    for (const entry of old) pins[entry.pinId] = buildPin(entry, { commit: SHA_A, verification: PIN_VERIFICATION.remote });
    const otherBinding = collectGitInputs({ dependencies: { a: 'github:o/r#main' } }, { scope: 'global' }).entries[0];
    pins[otherBinding.pinId] = buildPin(otherBinding, { commit: SHA_A, verification: PIN_VERIFICATION.remote });

    const newManifest = { dependencies: { a: 'github:o/r#main', b: 'github:o/r#release' } };
    const { entries } = collectGitInputs(newManifest, binding);
    const failures = entries.map((entry) => ({ pinId: entry.pinId, status: 'failed', reason: 'offline' }));
    const merged = mergeDiscoveredPins(pins, entries, failures, { bindings: [binding] });
    const a = entries.find((entry) => entry.name === 'a');
    const b = entries.find((entry) => entry.name === 'b');
    assert.equal(merged.pins[a.pinId].commit, SHA_A, 'same original spec keeps its pin after lookup failure');
    assert.equal(merged.pins[b.pinId], undefined, 'changed spec cannot inherit the old pin');
    assert.ok(merged.changes.some((change) => change.action === 'removed-undeclared'));
    assert.ok(merged.pins[otherBinding.pinId], 'other bindings are untouched');

    const resolved = mergeDiscoveredPins(merged.pins, entries, [
        { pinId: a.pinId, status: 'resolved', commit: SHA_B, resolvedRef: 'refs/heads/main' },
        { pinId: b.pinId, status: 'ambiguous', reason: 'both' },
    ], { bindings: [binding] });
    assert.equal(resolved.pins[a.pinId].commit, SHA_B);
    assert.equal(resolved.pins[a.pinId].verification, 'remote-verified');
    assert.equal(resolved.pins[b.pinId], undefined);
    assert.deepEqual(desiredPinsFor(resolved.pins, entries).map((pin) => [pin.name, pin.commit]), [['a', SHA_B]]);
});

test('cache-v4 git: first start records observed-at-install; update records remote-verified', () => {
    const binding = { scope: 'global' };
    const { entries } = collectGitInputs({ dependencies: { tool: 'git+file:///srv/r.git#main' } }, binding);
    const observed = recordObservedPins({}, entries, [{ pinId: entries[0].pinId, source: 'file:///srv/r.git', commit: SHA_A }]);
    assert.equal(observed[entries[0].pinId].verification, 'observed-at-install');
    assert.deepEqual(desiredPinsFor(observed, entries), [], 'observed provenance is not a desired pin');
    const missing = recordObservedPins({}, entries, []);
    assert.deepEqual(missing, {}, 'missing metadata is never stamped');
    const wrongSource = recordObservedPins({}, entries, [{ pinId: entries[0].pinId, source: 'file:///elsewhere.git', commit: SHA_A }]);
    assert.deepEqual(wrongSource, {});
    const updated = mergeDiscoveredPins(observed, entries, [{ pinId: entries[0].pinId, status: 'resolved', commit: SHA_A }], { bindings: [binding] });
    assert.equal(updated.pins[entries[0].pinId].verification, 'remote-verified');
    const kept = recordObservedPins(updated.pins, entries, [{ pinId: entries[0].pinId, source: 'file:///srv/r.git', commit: SHA_B }]);
    assert.equal(kept[entries[0].pinId].commit, SHA_A, 'a remote-verified pin is not overwritten by observation');
});

test('cache-v4 git: pin state commits atomically with compare-and-replace', (t) => {
    const root = tempRoot(t);
    const file = path.join(root, 'state', 'pins.json');
    assert.deepEqual(readPinState(file), { revision: 0, pins: {} });
    const { entries } = collectGitInputs({ dependencies: { tool: 'github:o/r#main' } }, { scope: 'global' });
    const pin = buildPin(entries[0], { commit: SHA_A, verification: PIN_VERIFICATION.remote });
    const first = commitPinState(file, { expectedRevision: 0, pins: { [pin.pinId]: pin } });
    assert.equal(first.revision, 1);
    assert.throws(() => commitPinState(file, { expectedRevision: 0, pins: {} }), { code: 'PLOINKY_DEPS_PIN_CONFLICT' });
    assert.equal(readPinState(file).pins[pin.pinId].commit, SHA_A);
    assert.throws(() => commitPinState(file, { expectedRevision: 1, pins: { [pin.pinId]: { ...pin, commit: 'abc' } } }), { code: 'PLOINKY_DEPS_PIN_INVALID' });
    fs.writeFileSync(file, '{broken');
    assert.throws(() => readPinState(file), { code: 'PLOINKY_DEPS_PIN_STATE_CORRUPT' });
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp')), []);
});
