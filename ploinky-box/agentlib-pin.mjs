// Host-side policy for a Box image whose bundled AchillesAgentLib commit
// differs from this checkout's `ploinky-box/dependencies.lock.json` pin.
//
// Only the commit-versus-lock comparison is policy: integrity checks on the
// bundle bytes stay fatal elsewhere. By default the difference is reported
// once on stderr and the image's own commit is used; the strict variable makes
// it fatal. Which side is out of date is decided offline from the checkout's
// Git metadata as of its last fetch.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { sanitizeAuthorityDiagnostic } from '../cli/sandbox/authorityCommandDiagnostics.mjs';
import { PloinkyBoxError } from './errors.mjs';

export const AGENTLIB_STRICT_PIN_ENV = 'PLOINKY_AGENTLIB_STRICT_PIN';

const LOCK_RELATIVE_PATH = 'ploinky-box/dependencies.lock.json';
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const WARNING_LINE_LIMIT = 500;
// An inherited repository selection would make every query inspect another
// repository than the checkout at `repositoryRoot`.
const REPOSITORY_SELECTION_ENV = Object.freeze([
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_SHALLOW_FILE',
]);

/** Resolve the pin policy; only unset, '', '0' and '1' are accepted. */
export function agentLibPinPolicy(env = process.env) {
    const raw = env?.[AGENTLIB_STRICT_PIN_ENV];
    if (raw === undefined || raw === '' || raw === '0') return 'warn';
    if (raw === '1') return 'strict';
    const shown = sanitizeAuthorityDiagnostic(JSON.stringify(String(raw)), { limit: 80 });
    throw new PloinkyBoxError(`${AGENTLIB_STRICT_PIN_ENV} must be 0 or 1 (got ${shown})`,
        { code: 'PLOINKY_BOX_ARGUMENT_INVALID' });
}

function lockCommitOf(text) {
    if (text === null) return null;
    try {
        const commit = JSON.parse(text)?.repositories?.achillesAgentLib?.commit;
        return COMMIT_PATTERN.test(String(commit ?? '')) ? commit : null;
    } catch {
        return null;
    }
}

function gitEnvironment() {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
    for (const name of REPOSITORY_SELECTION_ENV) delete env[name];
    return env;
}

function resolveReal(realpath, target) {
    try {
        return realpath(target);
    } catch {
        return path.resolve(target);
    }
}

/**
 * Read which revision this checkout and its upstream pin, without network
 * access or writes. Never throws: any unavailable fact is null, and a spawn
 * error or an exhausted time budget stops every later query.
 */
export function readCheckoutPinContext(repositoryRoot, {
    imageCommit, spawn = spawnSync, realpath = fs.realpathSync,
    callTimeoutMs = 5_000, budgetMs = 10_000, now = Date.now,
} = {}) {
    const root = resolveReal(realpath, repositoryRoot);
    const context = {
        git: false, root, branch: null, head: null, headCommit: null, shallow: false, upstream: null,
        upstreamCommit: null, ahead: null, behind: null, replacedIn: null,
    };
    const env = gitEnvironment();
    const deadline = now() + budgetMs;
    let stopped = false;
    const run = (args) => {
        if (stopped) return null;
        const remaining = deadline - now();
        if (remaining <= 0) {
            stopped = true;
            return null;
        }
        let result;
        try {
            result = spawn('git', ['-C', root, ...args], {
                encoding: 'utf8',
                timeout: Math.min(callTimeoutMs, remaining),
                env,
            });
        } catch {
            result = null;
        }
        if (!result || result.error) {
            stopped = true;
            return null;
        }
        return result.status === 0 ? String(result.stdout ?? '') : null;
    };

    // A copy inside another repository must not borrow that repository's history.
    const topLevel = run(['rev-parse', '--show-toplevel']);
    if (topLevel === null || !topLevel.trim() || resolveReal(realpath, topLevel.trim()) !== root) return context;
    const branch = run(['rev-parse', '--abbrev-ref', 'HEAD'])?.trim();
    if (!branch) return context;
    const head = run(['rev-parse', '--short=8', 'HEAD'])?.trim();
    if (!head) return context;
    Object.assign(context, { git: true, branch: branch === 'HEAD' ? null : branch, head });
    // The committed pin tells an uncommitted lock edit apart from history.
    context.headCommit = lockCommitOf(run(['show', `HEAD:${LOCK_RELATIVE_PATH}`]));
    context.shallow = run(['rev-parse', '--is-shallow-repository'])?.trim() === 'true';

    const upstream = run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])?.trim();
    if (upstream) {
        context.upstream = upstream;
        // An unreadable upstream lock only removes one fact.
        context.upstreamCommit = lockCommitOf(run(['show', `@{upstream}:${LOCK_RELATIVE_PATH}`]));
        const counts = /^(\d+)\s+(\d+)$/.exec(run(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])?.trim() ?? '');
        if (counts) {
            context.ahead = Number(counts[1]);
            context.behind = Number(counts[2]);
        }
    }
    if (COMMIT_PATTERN.test(String(imageCommit ?? ''))) {
        const history = run(['log', '--no-show-signature', '-n', '1', '--format=%h%x09%cs',
            '-S', imageCommit, 'HEAD', '--', LOCK_RELATIVE_PATH]);
        for (const line of String(history ?? '').split(/\r?\n/)) {
            const match = /^([0-9a-f]{4,40})\t(\d{4}-\d{2}-\d{2})$/.exec(line.trim());
            if (match) {
                context.replacedIn = { commit: match[1], date: match[2] };
                break;
            }
        }
    }
    return context;
}

const short = (commit) => String(commit ?? '').slice(0, 8);
const commits = (count) => `${count} commit${count === 1 ? '' : 's'}`;
const quote = (value) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
    ? value : `'${value.replaceAll("'", "'\\''")}'`);

/**
 * Explain a bundled-commit difference, or return null when the image matches
 * the lock. Returns plain, unsanitized strings.
 */
export function assessAgentLibPin({ lockCommit, bundle, imageRef, refreshed = false, engineName = 'podman', context }) {
    const imageCommit = bundle?.commit;
    if (imageCommit === lockCommit) return null;
    const ctx = context || { git: false, root: '' };
    const ref = String(imageRef ?? '');
    const imageId = String(bundle?.imageId ?? '');
    const I8 = short(imageCommit);
    const L8 = short(lockCommit);
    const U = ctx.upstreamCommit ?? null;
    const UP = ctx.upstream ?? null;
    const root = String(ctx.root ?? '');
    const where = `${root} (${ctx.branch ?? 'detached HEAD'} at ${ctx.head})`;
    const summary = `The Box image ${ref} (image ${imageId.replace(/^sha256:/, '').slice(0, 12)}) bundles `
        + `AchillesAgentLib ${I8}, but this Ploinky pins ${L8} in ${LOCK_RELATIVE_PATH}.`;
    const pull = `git -C ${quote(root)} ${ctx.ahead > 0 ? 'pull --rebase --autostash' : 'pull --ff-only'}`;
    let kind;
    let explanation;
    let fix;
    if (ctx.git && ctx.headCommit === imageCommit) {
        kind = 'uncommitted-pin';
        explanation = `The ${L8} pin is an uncommitted change to ${LOCK_RELATIVE_PATH} in ${where}; `
            + `its last commit pins ${I8} like the image.`;
        fix = `git -C ${quote(root)} checkout HEAD -- ${LOCK_RELATIVE_PATH} to drop the change, `
            + `or select a Box image built for ${L8} with PLOINKY_BOX_IMAGE.`;
    } else if (ctx.git && U === imageCommit && ctx.behind > 0) {
        kind = 'checkout-behind';
        const position = ctx.ahead > 0
            ? `${commits(ctx.behind)} behind and ${commits(ctx.ahead)} ahead of ${UP}`
            : `${commits(ctx.behind)} behind ${UP}`;
        explanation = `This Ploinky checkout is older than ${UP}: ${where} is ${position} as of the last fetch, `
            + `and ${UP} pins ${I8} like the image.`;
        fix = pull;
    } else if (ctx.git && U === imageCommit) {
        kind = 'checkout-local-pin';
        explanation = `${UP} pins ${I8} like the image; the ${L8} pin is a local change in ${where} that ${UP} does not have.`;
        fix = `publish or select (PLOINKY_BOX_IMAGE) a Box image built for ${L8}, `
            + `or revert the local change to ${LOCK_RELATIVE_PATH}.`;
    } else if (ctx.git && ctx.replacedIn) {
        // HEAD does not pin the image commit here, so the most recent commit
        // that adds or removes it in the lock can only be the one removing it.
        kind = 'image-older';
        explanation = `The Box image is older than this Ploinky checkout: ${where} replaced the ${I8} pin `
            + `in commit ${ctx.replacedIn.commit} (${ctx.replacedIn.date}).`;
        if (ref.includes('@')) {
            fix = `${ref} is pinned by digest; select a Box image built for ${L8} with PLOINKY_BOX_IMAGE.`;
        } else if (refreshed) {
            fix = `${ref} was just pulled and still bundles ${I8}; wait for a Box image built for ${L8} `
                + 'or select one with PLOINKY_BOX_IMAGE.';
        } else {
            fix = `${engineName} pull ${quote(ref)}, then rerun this command; the Box is recreated from the refreshed image.`;
        }
    } else if (ctx.git && ctx.shallow) {
        kind = 'shallow-unknown';
        explanation = `${where} is a shallow clone, so its history cannot show whether this checkout `
            + 'or the Box image is out of date.';
        fix = `git -C ${quote(root)} fetch --unshallow, then rerun this command; if the checkout is simply outdated, `
            + (UP ? `${pull} fixes it.` : 'update it from its remote.');
    } else if (ctx.git) {
        // Box images are published from the default branch, so a commit this
        // checkout never pinned almost always means the checkout is behind.
        kind = 'checkout-probably-behind';
        explanation = `This Ploinky checkout is probably older than the Box image: ${where} has never pinned ${I8}.`;
        if (!UP) explanation += ' It has no upstream branch.';
        else if (U === lockCommit) explanation += ` ${UP} also pins ${L8} as of the last fetch; the pull below fetches newer commits.`;
        else if (U) explanation += ` ${UP} pins ${short(U)} as of the last fetch.`;
        else explanation += ` ${UP} has no readable pin as of the last fetch.`;
        fix = UP
            ? pull
            : `update this checkout from its remote, or select a Box image built for ${L8} with PLOINKY_BOX_IMAGE.`;
    } else {
        kind = 'no-git';
        explanation = `Ploinky at ${root} is not a Git checkout that Ploinky can inspect, so it cannot tell which side `
            + 'is out of date; the Ploinky pin and the Box image normally change together.';
        fix = `update Ploinky, or refresh the image with ${engineName} pull ${quote(ref)}.`;
    }
    return Object.freeze({ kind, lockCommit, imageCommit, imageRef: ref, imageId, summary, explanation, fix });
}

/** Four sanitized stderr lines, ending with the commit that will be used. */
export function formatAgentLibPinWarning(assessment) {
    const lines = [
        `Warning: ${assessment.summary}`,
        assessment.explanation,
        `Fix: ${assessment.fix}`,
        `Continuing with the image's AchillesAgentLib ${short(assessment.imageCommit)}.`,
    ];
    return lines.map((line) => `[ploinky] ${sanitizeAuthorityDiagnostic(line, { limit: WARNING_LINE_LIMIT })}\n`).join('');
}

/** The single-line strict-mode failure. */
export function agentLibPinError(assessment) {
    const message = sanitizeAuthorityDiagnostic(
        `${assessment.summary} ${AGENTLIB_STRICT_PIN_ENV}=1 requires an exact match. `
        + `${assessment.explanation} Fix: ${assessment.fix}`,
        { limit: 2_000 },
    );
    return new PloinkyBoxError(message, { code: 'PLOINKY_BOX_AGENTLIB_INCOMPATIBLE' });
}
