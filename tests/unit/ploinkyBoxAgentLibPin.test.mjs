import assert from 'node:assert/strict';
import test from 'node:test';

import {
    AGENTLIB_STRICT_PIN_ENV,
    agentLibPinError,
    agentLibPinPolicy,
    assessAgentLibPin,
    formatAgentLibPinWarning,
    readCheckoutPinContext,
} from '../../ploinky-box/agentlib-pin.mjs';

const I = 'ef515b2d88a817eea60d1a3a6d3dc6c5f406bfca';
const L = '214ba4c3d64fd857361bf8ab56a5640c5efb30e0';
const OTHER = '3'.repeat(40);
const IMAGE_ID = 'sha256:740bd90d924ed335be06de6276d66cddf33edcdbc1bfcff8c83d11e7b994bf28';
const REF = 'docker.io/assistos/ploinky-box:latest';
const DIGEST_REF = `docker.io/assistos/ploinky-box@sha256:${'7'.repeat(64)}`;
const ROOT = '/Users/danielsava/work/file-parser/ploinky';
const REPO = '/repo';
const SUMMARY = `The Box image ${REF} (image 740bd90d924e) bundles AchillesAgentLib ef515b2d, `
    + 'but this Ploinky pins 214ba4c3 in ploinky-box/dependencies.lock.json.';
const WHERE = `${ROOT} (master at a23cc198)`;
const V3 = Object.freeze({
    git: true, root: ROOT, branch: 'master', head: 'a23cc198', headCommit: L, shallow: false, upstream: 'origin/master',
    upstreamCommit: I, ahead: 0, behind: 10, replacedIn: null,
});
const GIT_QUERIES = Object.freeze({
    G0: ['rev-parse', '--show-toplevel'],
    G1: ['rev-parse', '--abbrev-ref', 'HEAD'],
    G2: ['rev-parse', '--short=8', 'HEAD'],
    GH: ['show', 'HEAD:ploinky-box/dependencies.lock.json'],
    GS: ['rev-parse', '--is-shallow-repository'],
    G3: ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    G4: ['show', '@{upstream}:ploinky-box/dependencies.lock.json'],
    G5: ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'],
    G6: ['log', '--no-show-signature', '-n', '1', '--format=%h%x09%cs', '-S', I, 'HEAD', '--', 'ploinky-box/dependencies.lock.json'],
});
const ok = (stdout) => ({ status: 0, stdout, stderr: '' });
const lockText = (commit) => JSON.stringify({ repositories: { achillesAgentLib: { url: 'https://example.invalid/a.git', commit } } });
const V3_OUTPUTS = Object.freeze({
    G0: ok(`${REPO}\n`), G1: ok('master\n'), G2: ok('a23cc198\n'), GH: ok(lockText(L)), GS: ok('false\n'),
    G3: ok('origin/master\n'), G4: ok(lockText(I)),
    G5: ok('0\t10\n'), G6: ok(''),
});

function recordingSpawn(overrides = {}) {
    const calls = [];
    const outputs = { ...V3_OUTPUTS, ...overrides };
    const spawn = (command, args, options) => {
        assert.equal(command, 'git');
        assert.deepEqual(args.slice(0, 2), ['-C', REPO]);
        const id = Object.keys(GIT_QUERIES).find((key) => JSON.stringify(GIT_QUERIES[key]) === JSON.stringify(args.slice(2)));
        assert.ok(id, `unexpected git query ${args.join(' ')}`);
        calls.push({ id, options });
        return outputs[id];
    };
    return { spawn, calls };
}

const readContext = (overrides) => {
    const recorder = recordingSpawn(overrides);
    const context = readCheckoutPinContext(REPO, { imageCommit: I, spawn: recorder.spawn, realpath: (value) => value });
    return { context, calls: recorder.calls.map((call) => call.id), options: recorder.calls.map((call) => call.options) };
};

const assess = (context, extra = {}) => assessAgentLibPin({
    lockCommit: L, bundle: { commit: I, fingerprint: 'f'.repeat(64), imageId: IMAGE_ID },
    imageRef: REF, refreshed: false, engineName: 'podman', context, ...extra,
});
const outputLines = (assessment) => formatAgentLibPinWarning(assessment).split('\n').slice(0, -1);

test('T1 the strict-pin policy accepts only unset, empty, 0 and 1', () => {
    assert.equal(agentLibPinPolicy({}), 'warn');
    assert.equal(agentLibPinPolicy({ [AGENTLIB_STRICT_PIN_ENV]: '' }), 'warn');
    assert.equal(agentLibPinPolicy({ [AGENTLIB_STRICT_PIN_ENV]: '0' }), 'warn');
    assert.equal(agentLibPinPolicy({ [AGENTLIB_STRICT_PIN_ENV]: '1' }), 'strict');
    for (const value of ['true', ' 1', '2', 'x'.repeat(10_000)]) {
        assert.throws(() => agentLibPinPolicy({ [AGENTLIB_STRICT_PIN_ENV]: value }), (error) => {
            assert.equal(error.code, 'PLOINKY_BOX_ARGUMENT_INVALID');
            assert.match(error.message, /^PLOINKY_AGENTLIB_STRICT_PIN must be 0 or 1/);
            assert.ok(error.message.length <= 200, `${error.message.length} characters`);
            return true;
        });
    }
    assert.throws(() => agentLibPinPolicy({ [AGENTLIB_STRICT_PIN_ENV]: ' 1' }), { message: /\(got " 1"\)$/ });
});

test('T2 the checkout reader runs the nine read-only queries and parses them', () => {
    const { context, calls, options } = readContext();
    assert.deepEqual(context, {
        git: true, root: REPO, branch: 'master', head: 'a23cc198', headCommit: L, shallow: false,
        upstream: 'origin/master', upstreamCommit: I, ahead: 0, behind: 10, replacedIn: null,
    });
    assert.deepEqual(calls, ['G0', 'G1', 'G2', 'GH', 'GS', 'G3', 'G4', 'G5', 'G6']);
    for (const option of options) {
        assert.equal(option.env.GIT_TERMINAL_PROMPT, '0');
        assert.equal(option.env.GIT_OPTIONAL_LOCKS, '0');
        for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) assert.equal(name in option.env, false);
        assert.equal(typeof option.timeout, 'number');
        assert.ok(option.timeout > 0 && option.timeout <= 5_000);
    }
});

test('T3 missing Git stops after one spawn', () => {
    const recorder = recordingSpawn({ G0: { error: { code: 'ENOENT' } } });
    const context = readCheckoutPinContext(REPO, { imageCommit: I, spawn: recorder.spawn, realpath: (value) => value });
    assert.equal(context.git, false);
    assert.equal(recorder.calls.length, 1);
});

test('T4 a copy inside another repository is not treated as a checkout', () => {
    const { context, calls } = readContext({ G0: ok('/somewhere/else\n') });
    assert.equal(context.git, false);
    assert.deepEqual(calls, ['G0']);
});

test('T5 a branch without an upstream still reads its own pin history', () => {
    const { context, calls } = readContext({ G3: { status: 128, stdout: '', stderr: 'fatal: no upstream' } });
    assert.equal(context.git, true);
    for (const field of ['upstream', 'upstreamCommit', 'ahead', 'behind']) assert.equal(context[field], null);
    assert.deepEqual(calls, ['G0', 'G1', 'G2', 'GH', 'GS', 'G3', 'G6']);
});

test('T6 a Git timeout stops every later query', () => {
    const { context, calls } = readContext({ G4: { error: { code: 'ETIMEDOUT' } } });
    assert.deepEqual(calls, ['G0', 'G1', 'G2', 'GH', 'GS', 'G3', 'G4']);
    assert.equal(context.git, true);
    for (const field of ['upstreamCommit', 'ahead', 'behind', 'replacedIn']) assert.equal(context[field], null);
});

test('T7 an unreadable upstream lock removes only the upstream pin', () => {
    const { context, calls } = readContext({ G4: ok('not json') });
    assert.equal(context.upstreamCommit, null);
    assert.equal(context.behind, 10);
    assert.deepEqual(calls, ['G0', 'G1', 'G2', 'GH', 'GS', 'G3', 'G4', 'G5', 'G6']);
});

test('T7b the committed pin and shallow state are read, and a missing committed lock is null', () => {
    assert.equal(readContext({ GH: ok(lockText(I)), GS: ok('true\n') }).context.headCommit, I);
    assert.equal(readContext({ GS: ok('true\n') }).context.shallow, true);
    const missing = readContext({ GH: { status: 128, stdout: '', stderr: 'fatal: path does not exist' } });
    assert.equal(missing.context.headCommit, null);
    assert.equal(missing.calls.length, 9);
});

test('T7c an exhausted time budget stops the remaining queries', () => {
    let clock = 0;
    const recorder = recordingSpawn();
    const spawn = (...args) => { clock += 4_000; return recorder.spawn(...args); };
    const context = readCheckoutPinContext(REPO, { imageCommit: I, spawn, realpath: (value) => value, now: () => clock });
    assert.deepEqual(recorder.calls.map((call) => call.id), ['G0', 'G1', 'G2']);
    assert.ok(recorder.calls.every((call) => call.options.timeout <= 5_000));
    assert.equal(recorder.calls.at(-1).options.timeout, 2_000);
    assert.equal(context.git, true);
    assert.equal(context.upstream, null);
});

test('T8 a detached HEAD has no branch and renders as detached', () => {
    const { context } = readContext({ G1: ok('HEAD\n'), G3: { status: 128, stdout: '' } });
    assert.equal(context.branch, null);
    assert.match(assess(context).explanation, /\(detached HEAD at a23cc198\)/);
});

test('T9 matching commits need no assessment', () => {
    assert.equal(assessAgentLibPin({ lockCommit: I, bundle: { commit: I, imageId: IMAGE_ID }, imageRef: REF, context: V3 }), null);
});

test('T10 the V3 checkout produces the exact target warning', () => {
    assert.equal(formatAgentLibPinWarning(assess(V3)), [
        `[ploinky] Warning: ${SUMMARY}`,
        `[ploinky] This Ploinky checkout is older than origin/master: ${WHERE} is 10 commits behind origin/master `
            + 'as of the last fetch, and origin/master pins ef515b2d like the image.',
        `[ploinky] Fix: git -C ${ROOT} pull --ff-only`,
        "[ploinky] Continuing with the image's AchillesAgentLib ef515b2d.",
        '',
    ].join('\n'));
    assert.equal(assess(V3).kind, 'checkout-behind');
});

const REPLACED = Object.freeze({ commit: '4b44dd67', date: '2026-09-22' });
const PROBABLY = `This Ploinky checkout is probably older than the Box image: ${WHERE} has never pinned ef515b2d.`;
const CASES = [
    ['checkout-behind, 1 behind', { ...V3, behind: 1 }, {}, 'checkout-behind',
        `This Ploinky checkout is older than origin/master: ${WHERE} is 1 commit behind origin/master as of the last fetch, and origin/master pins ef515b2d like the image.`,
        `git -C ${ROOT} pull --ff-only`],
    ['checkout-behind, 2 behind', { ...V3, behind: 2 }, {}, 'checkout-behind',
        `This Ploinky checkout is older than origin/master: ${WHERE} is 2 commits behind origin/master as of the last fetch, and origin/master pins ef515b2d like the image.`,
        `git -C ${ROOT} pull --ff-only`],
    ['checkout-behind and ahead', { ...V3, behind: 2, ahead: 1 }, {}, 'checkout-behind',
        `This Ploinky checkout is older than origin/master: ${WHERE} is 2 commits behind and 1 commit ahead of origin/master as of the last fetch, and origin/master pins ef515b2d like the image.`,
        `git -C ${ROOT} pull --rebase --autostash`],
    ['checkout-local-pin', { ...V3, behind: 0 }, {}, 'checkout-local-pin',
        `origin/master pins ef515b2d like the image; the 214ba4c3 pin is a local change in ${WHERE} that origin/master does not have.`,
        'publish or select (PLOINKY_BOX_IMAGE) a Box image built for 214ba4c3, or revert the local change to ploinky-box/dependencies.lock.json.'],
    ['checkout-local-pin, unknown distance', { ...V3, ahead: null, behind: null }, {}, 'checkout-local-pin',
        `origin/master pins ef515b2d like the image; the 214ba4c3 pin is a local change in ${WHERE} that origin/master does not have.`,
        'publish or select (PLOINKY_BOX_IMAGE) a Box image built for 214ba4c3, or revert the local change to ploinky-box/dependencies.lock.json.'],
    ['image-older, tag', { ...V3, upstreamCommit: L, behind: 0, replacedIn: REPLACED }, {}, 'image-older',
        `The Box image is older than this Ploinky checkout: ${WHERE} replaced the ef515b2d pin in commit 4b44dd67 (2026-09-22).`,
        `podman pull ${REF}, then rerun this command; the Box is recreated from the refreshed image.`],
    ['image-older, refreshed tag', { ...V3, upstreamCommit: L, behind: 0, replacedIn: REPLACED }, { refreshed: true }, 'image-older',
        `The Box image is older than this Ploinky checkout: ${WHERE} replaced the ef515b2d pin in commit 4b44dd67 (2026-09-22).`,
        `${REF} was just pulled and still bundles ef515b2d; wait for a Box image built for 214ba4c3 or select one with PLOINKY_BOX_IMAGE.`],
    ['image-older, digest', { ...V3, upstreamCommit: L, behind: 0, replacedIn: REPLACED }, { imageRef: DIGEST_REF }, 'image-older',
        `The Box image is older than this Ploinky checkout: ${WHERE} replaced the ef515b2d pin in commit 4b44dd67 (2026-09-22).`,
        `${DIGEST_REF} is pinned by digest; select a Box image built for 214ba4c3 with PLOINKY_BOX_IMAGE.`],
    ['checkout-probably-behind, upstream pins the lock', { ...V3, upstreamCommit: L, behind: 0 }, {}, 'checkout-probably-behind',
        `${PROBABLY} origin/master also pins 214ba4c3 as of the last fetch; the pull below fetches newer commits.`,
        `git -C ${ROOT} pull --ff-only`],
    ['checkout-probably-behind, upstream pins another commit', { ...V3, upstreamCommit: OTHER }, {}, 'checkout-probably-behind',
        `${PROBABLY} origin/master pins 33333333 as of the last fetch.`,
        `git -C ${ROOT} pull --ff-only`],
    ['checkout-probably-behind, unreadable upstream pin', { ...V3, upstreamCommit: null }, {}, 'checkout-probably-behind',
        `${PROBABLY} origin/master has no readable pin as of the last fetch.`,
        `git -C ${ROOT} pull --ff-only`],
    ['checkout-probably-behind, no upstream', { ...V3, upstream: null, upstreamCommit: null, ahead: null, behind: null }, {}, 'checkout-probably-behind',
        `${PROBABLY} It has no upstream branch.`,
        'update this checkout from its remote, or select a Box image built for 214ba4c3 with PLOINKY_BOX_IMAGE.'],
    ['checkout-probably-behind, diverged from a stale upstream', { ...V3, upstreamCommit: L, ahead: 1, behind: 0 }, {}, 'checkout-probably-behind',
        `${PROBABLY} origin/master also pins 214ba4c3 as of the last fetch; the pull below fetches newer commits.`,
        `git -C ${ROOT} pull --rebase --autostash`],
    ['uncommitted-pin, no upstream', { ...V3, headCommit: I, upstream: null, upstreamCommit: null, ahead: null, behind: null, replacedIn: REPLACED }, {}, 'uncommitted-pin',
        `The 214ba4c3 pin is an uncommitted change to ploinky-box/dependencies.lock.json in ${WHERE}; its last commit pins ef515b2d like the image.`,
        `git -C ${ROOT} checkout HEAD -- ploinky-box/dependencies.lock.json to drop the change, or select a Box image built for 214ba4c3 with PLOINKY_BOX_IMAGE.`],
    ['uncommitted-pin, upstream pins the image', { ...V3, headCommit: I, behind: 0 }, {}, 'uncommitted-pin',
        `The 214ba4c3 pin is an uncommitted change to ploinky-box/dependencies.lock.json in ${WHERE}; its last commit pins ef515b2d like the image.`,
        `git -C ${ROOT} checkout HEAD -- ploinky-box/dependencies.lock.json to drop the change, or select a Box image built for 214ba4c3 with PLOINKY_BOX_IMAGE.`],
    ['shallow-unknown', { ...V3, shallow: true, upstreamCommit: L, behind: 0 }, {}, 'shallow-unknown',
        `${WHERE} is a shallow clone, so its history cannot show whether this checkout or the Box image is out of date.`,
        `git -C ${ROOT} fetch --unshallow, then rerun this command; if the checkout is simply outdated, git -C ${ROOT} pull --ff-only fixes it.`],
    ['shallow-unknown, ahead', { ...V3, shallow: true, upstreamCommit: L, ahead: 2, behind: 0 }, {}, 'shallow-unknown',
        `${WHERE} is a shallow clone, so its history cannot show whether this checkout or the Box image is out of date.`,
        `git -C ${ROOT} fetch --unshallow, then rerun this command; if the checkout is simply outdated, git -C ${ROOT} pull --rebase --autostash fixes it.`],
    ['shallow-unknown, no upstream', { ...V3, shallow: true, upstream: null, upstreamCommit: null, ahead: null, behind: null }, {}, 'shallow-unknown',
        `${WHERE} is a shallow clone, so its history cannot show whether this checkout or the Box image is out of date.`,
        `git -C ${ROOT} fetch --unshallow, then rerun this command; if the checkout is simply outdated, update it from its remote.`],
    ['checkout-behind wins over a pin found in history (M9)', { ...V3, behind: 3, replacedIn: REPLACED }, {}, 'checkout-behind',
        `This Ploinky checkout is older than origin/master: ${WHERE} is 3 commits behind origin/master as of the last fetch, and origin/master pins ef515b2d like the image.`,
        `git -C ${ROOT} pull --ff-only`],
    ['no-git', { git: false, root: ROOT }, {}, 'no-git',
        `Ploinky at ${ROOT} is not a Git checkout that Ploinky can inspect, so it cannot tell which side is out of date; the Ploinky pin and the Box image normally change together.`,
        `update Ploinky, or refresh the image with podman pull ${REF}.`],
];

for (const [name, context, extra, kind, explanation, fix] of CASES) {
    test(`T10 ${name}`, () => {
        const assessment = assess(context, extra);
        assert.equal(assessment.kind, kind);
        assert.equal(assessment.explanation, explanation);
        assert.equal(assessment.fix, fix);
        const lines = outputLines(assessment);
        assert.equal(lines.length, 4);
        assert.ok(lines[0].startsWith('[ploinky] Warning: The Box image '));
        assert.equal(lines[1], `[ploinky] ${explanation}`);
        assert.equal(lines[2], `[ploinky] Fix: ${fix}`);
        assert.equal(lines[3], "[ploinky] Continuing with the image's AchillesAgentLib ef515b2d.");
    });
}

test('T11 benign lines are unchanged and hostile inputs stay bounded and redacted', () => {
    for (const [, context, extra] of CASES) {
        const assessment = assess(context, extra);
        assert.equal(formatAgentLibPinWarning(assessment), [
            `Warning: ${assessment.summary}`, assessment.explanation, `Fix: ${assessment.fix}`,
            "Continuing with the image's AchillesAgentLib ef515b2d.",
        ].map((line) => `[ploinky] ${line}\n`).join(''));
    }
    const sensitive = /(?:token|secret|password|passwd|credential|api[_-]?key|private[_-]?key|authorization|cookie)/i;
    for (const [, context, extra] of CASES) {
        const { summary, explanation, fix } = assess(context, extra);
        assert.doesNotMatch(`${summary} ${explanation} ${fix}`, sensitive);
    }
    const credential = formatAgentLibPinWarning(assess({ git: false, root: ROOT },
        { imageRef: 'docker://user:hunter2@registry.example/box:tag' }));
    assert.doesNotMatch(credential, /hunter2/);
    const quoted = assess({ ...V3, root: "/tmp/a b/it's" });
    assert.equal(quoted.fix, "git -C '/tmp/a b/it'\\''s' pull --ff-only");
    assert.ok(formatAgentLibPinWarning(quoted).includes("git -C '/tmp/a b/it'\\''s' pull --ff-only"));
    assert.ok(formatAgentLibPinWarning(assess({ ...V3, branch: 'fix/ünïcødé' })).includes('(fix/ünïcødé at a23cc198)'));
    const token = formatAgentLibPinWarning(assess({ ...V3, branch: 'feature/token-refresh' }));
    assert.ok(token.endsWith("[ploinky] Continuing with the image's AchillesAgentLib ef515b2d.\n"));
    const long = formatAgentLibPinWarning(assess({ ...V3, branch: 'b'.repeat(5_000) }));
    const lines = long.split('\n').slice(0, -1);
    assert.equal(lines.length, 4);
    for (const line of lines) assert.ok(line.length <= 510, `${line.length} characters`);
});

test('T12 strict mode fails with one line naming both commits', () => {
    const error = agentLibPinError(assess(V3));
    assert.equal(error.code, 'PLOINKY_BOX_AGENTLIB_INCOMPATIBLE');
    assert.match(error.message, /PLOINKY_AGENTLIB_STRICT_PIN=1 requires an exact match/);
    assert.match(error.message, /ef515b2d/);
    assert.match(error.message, /214ba4c3/);
    assert.equal(error.message.includes('\n'), false);
});
