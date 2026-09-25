// Git dependency spec normalization for the immutable dependency cache.
//
// Supported forms: git+https, git+http, git+ssh (URL and scp-like), git+file,
// git://, plain https/http URLs ending in .git, GitHub https URLs, `github:`
// shorthand and bare `owner/repo` GitHub shorthand. Supported committish forms:
// none (remote HEAD), `HEAD`, a full 40-hex SHA, `refs/heads/<branch>`,
// `refs/tags/<tag>` and a short name that must resolve to exactly one branch
// or tag. Everything else that is recognizably Git (npm `semver:`/`path:`
// selectors, `::` combinations, abbreviated SHAs, gitlab/bitbucket/gist
// shorthand, URLs with embedded passwords) is reported as unsupported with a
// named reason. It is never passed to `git ls-remote` as an ordinary ref.

import path from 'node:path';

import { canonicalDigest, isFullGitSha } from './canonical.mjs';

export const GIT_SPEC_UNSUPPORTED = 'PLOINKY_DEPS_GIT_SPEC_UNSUPPORTED';

const UNSUPPORTED_HOSTED_SHORTHAND = /^(gitlab|bitbucket|gist|sourcehut):/i;
const GITHUB_SHORTHAND = /^github:/i;
const BARE_GITHUB_SHORTHAND = /^[A-Za-z0-9][\w.-]*\/[\w.-]+(?:#.*)?$/;
const SCP_LIKE = /^(?:git\+ssh:\/\/)?([A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+):(?!\/\/)([^#]+)(#.*)?$/;
const ABBREVIATED_HEX = /^[0-9a-fA-F]{4,39}$/;
const FORBIDDEN_REF_CHARACTERS = /[\s~^:?*[\\\x00-\x1f\x7f]/;

function unsupported(original, reason) {
    return Object.freeze({ git: true, supported: false, original, reason, code: GIT_SPEC_UNSUPPORTED });
}

function validRefName(name) {
    if (!name || name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return false;
    if (name.includes('..') || name.includes('//') || name.includes('@{') || name.endsWith('.lock')) return false;
    return !FORBIDDEN_REF_CHARACTERS.test(name);
}

/**
 * Parse an npm committish fragment into one supported ref selector.
 * Returns `{ ref }` or `{ reason }`.
 */
export function parseCommittish(fragment) {
    const raw = String(fragment ?? '');
    if (raw === '') return { ref: { kind: 'head' } };
    let decoded;
    try { decoded = decodeURIComponent(raw); } catch { return { reason: 'undecodable committish' }; }
    if (decoded.includes('::')) return { reason: 'combined npm committish selectors (::) are not supported' };
    if (/^semver:/i.test(decoded)) return { reason: 'npm semver: committish ranges have no defined resolver' };
    if (/^path:/i.test(decoded)) return { reason: 'npm path: subdirectory selectors are not supported' };
    if (decoded === 'HEAD') return { ref: { kind: 'head' } };
    if (/^[0-9a-fA-F]{40}$/.test(decoded)) return { ref: { kind: 'sha', sha: decoded.toLowerCase() } };
    if (ABBREVIATED_HEX.test(decoded)) {
        return { reason: `abbreviated commit '${decoded}' is ambiguous; use the full 40-character SHA or refs/heads/<name>` };
    }
    const branch = /^refs\/heads\/(.+)$/.exec(decoded);
    if (branch) return validRefName(branch[1]) ? { ref: { kind: 'branch', name: branch[1] } } : { reason: `invalid branch name '${branch[1]}'` };
    const tag = /^refs\/tags\/(.+)$/.exec(decoded);
    if (tag) return validRefName(tag[1]) ? { ref: { kind: 'tag', name: tag[1] } } : { reason: `invalid tag name '${tag[1]}'` };
    if (decoded.startsWith('refs/')) return { reason: `ref namespace '${decoded}' is not supported` };
    if (!validRefName(decoded)) return { reason: `invalid ref name '${decoded}'` };
    return { ref: { kind: 'name', name: decoded } };
}

function splitFragment(value) {
    const index = value.indexOf('#');
    return index < 0 ? [value, ''] : [value.slice(0, index), value.slice(index + 1)];
}

function githubIdentity(owner, repo) {
    const cleanRepo = repo.replace(/\.git$/i, '');
    if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(cleanRepo) || !cleanRepo) return null;
    return {
        host: 'github',
        source: `github.com/${owner.toLowerCase()}/${cleanRepo.toLowerCase()}`,
        fetchUrl: `https://github.com/${owner}/${cleanRepo}.git`,
    };
}

function githubFromPath(pathname) {
    const parts = String(pathname || '').replace(/^\/+/, '').replace(/\/+$/, '').split('/');
    if (parts.length !== 2) return null;
    return githubIdentity(parts[0], parts[1]);
}

function genericIdentity(url) {
    const host = url.hostname.toLowerCase();
    const port = url.port ? `:${url.port}` : '';
    const pathname = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
    if (!host || !pathname) return null;
    return { host: null, source: `${host}${port}/${pathname}` };
}

function fileIdentity(url) {
    if (url.hostname && url.hostname !== 'localhost') return null;
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { return null; }
    if (!path.posix.isAbsolute(pathname)) return null;
    const normalized = path.posix.normalize(pathname).replace(/\/+$/, '') || '/';
    return { host: null, source: `file://${normalized}`, fetchUrl: `file://${normalized}` };
}

function finish(original, specUrl, fragment, identity) {
    const committish = parseCommittish(fragment);
    if (committish.reason) return unsupported(original, committish.reason);
    const ref = committish.ref;
    return Object.freeze({
        git: true,
        supported: true,
        original,
        specUrl,
        host: identity.host,
        source: identity.source,
        fetchUrl: identity.fetchUrl,
        ref: Object.freeze(ref),
        identity: canonicalDigest({ source: identity.source, fetchUrl: identity.fetchUrl, ref }),
    });
}

/**
 * Classify one dependency spec.
 *
 * @returns {null | {git: true, supported: false, original: string, reason: string, code: string}
 *   | {git: true, supported: true, original: string, specUrl: string, host: string|null, source: string,
 *      fetchUrl: string, ref: {kind: 'head'|'sha'|'branch'|'tag'|'name', name?: string, sha?: string}, identity: string}}
 *   null when the spec is not a Git dependency (registry ranges, tags, file:, npm:, tarballs).
 */
export function parseGitDependencySpec(spec) {
    if (typeof spec !== 'string') return null;
    const original = spec;
    const value = spec.trim();
    if (!value) return null;
    if (/^(npm|file|link|workspace|portal):/i.test(value)) return null;
    if (UNSUPPORTED_HOSTED_SHORTHAND.test(value)) {
        return unsupported(original, `hosted shorthand '${value.split(':')[0]}:' is not supported; use a git+https URL`);
    }
    if (GITHUB_SHORTHAND.test(value)) {
        const [body, fragment] = splitFragment(value.slice('github:'.length));
        const identity = githubFromPath(body);
        if (!identity) return unsupported(original, 'malformed github: shorthand');
        return finish(original, splitFragment(value)[0], fragment, identity);
    }
    if (!splitFragment(value)[0].includes(':') && BARE_GITHUB_SHORTHAND.test(value) && !value.startsWith('@')) {
        const [body, fragment] = splitFragment(value);
        const identity = githubFromPath(body);
        if (!identity) return unsupported(original, 'malformed owner/repo shorthand');
        return finish(original, body, fragment, identity);
    }

    const isGitPrefixed = /^git\+/i.test(value);
    const withoutPrefix = value.replace(/^git\+/i, '');
    // npm also accepts `git+ssh://user@host:owner/repo` (scp path after ssh://).
    const scpCandidate = /^ssh:\/\/[^/]*:(?!\d+\/)/.test(withoutPrefix)
        ? withoutPrefix.slice('ssh://'.length)
        : (withoutPrefix.startsWith('ssh://') ? '' : withoutPrefix);
    const scp = SCP_LIKE.exec(scpCandidate);
    if (scp && (isGitPrefixed || scp[1])) {
        const [, user = '', hostName, rawPath, rawFragment = ''] = scp;
        if (withoutPrefix.startsWith('-')) return unsupported(original, 'URL must not start with -');
        const fragment = rawFragment.slice(1);
        const host = hostName.toLowerCase();
        const specUrl = value.slice(0, value.length - rawFragment.length);
        const identity = host === 'github.com'
            ? githubFromPath(rawPath)
            : { host: null, source: `${host}/${rawPath.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '')}` };
        if (!identity) return unsupported(original, 'malformed scp-like Git URL');
        return finish(original, specUrl, fragment, {
            ...identity,
            fetchUrl: identity.fetchUrl || `${user}${hostName}:${rawPath}`,
        });
    }

    let url;
    try { url = new URL(withoutPrefix); } catch { return isGitPrefixed ? unsupported(original, 'malformed Git URL') : null; }
    const protocol = url.protocol.toLowerCase();
    const [specUrl, fragment] = splitFragment(value);
    const looksGit = isGitPrefixed
        || protocol === 'git:'
        || ((protocol === 'https:' || protocol === 'http:')
            && (/\.git$/i.test(url.pathname) || (url.hostname.toLowerCase() === 'github.com' && githubFromPath(url.pathname))));
    if (!looksGit) return null;
    if (url.password) return unsupported(original, 'credentials embedded in a Git URL cannot be keyed or logged');
    if (url.search) return unsupported(original, 'query strings in Git URLs are not supported');
    if (!['https:', 'http:', 'ssh:', 'file:', 'git:'].includes(protocol)) {
        return unsupported(original, `Git transport '${protocol}' is not supported`);
    }
    if (protocol === 'file:') {
        const identity = fileIdentity(url);
        if (!identity) return unsupported(original, 'git+file URLs must name an absolute local path');
        return finish(original, specUrl, fragment, identity);
    }
    if (url.hostname.toLowerCase() === 'github.com') {
        const identity = githubFromPath(url.pathname);
        if (!identity) return unsupported(original, 'GitHub URL must name exactly owner/repo');
        return finish(original, specUrl, fragment, identity);
    }
    const identity = genericIdentity(url);
    if (!identity) return unsupported(original, 'Git URL has no repository path');
    const fetchUrl = `${protocol}//${url.username ? `${url.username}@` : ''}${url.host}${url.pathname}`;
    return finish(original, specUrl, fragment, { ...identity, fetchUrl });
}

/** The same dependency with its committish replaced by an exact full SHA. */
export function rewriteSpecToCommit(parsed, commit) {
    if (!parsed?.supported) throw new Error('only supported Git specs can be pinned');
    if (!isFullGitSha(commit)) throw new Error('a Git pin must be a full 40-character SHA');
    return `${parsed.specUrl}#${commit}`;
}

/**
 * Parse an installer `resolved` value (for example npm's hidden-lock
 * `git+ssh://git@github.com/o/r.git#<sha>`) into a canonical source and SHA.
 */
export function parseResolvedGitSource(resolved) {
    const parsed = parseGitDependencySpec(String(resolved || ''));
    if (!parsed?.supported || parsed.ref.kind !== 'sha') return null;
    return { source: parsed.source, commit: parsed.ref.sha };
}

/** The structured `git ls-remote` patterns needed for one supported moving ref. */
export function lsRemoteQuery(parsed) {
    if (!parsed?.supported) throw new Error('unsupported Git specs cannot be queried');
    const { ref } = parsed;
    let patterns;
    switch (ref.kind) {
    case 'sha': return null;
    case 'head': patterns = ['HEAD']; break;
    case 'branch': patterns = [`refs/heads/${ref.name}`]; break;
    case 'tag': patterns = [`refs/tags/${ref.name}`, `refs/tags/${ref.name}^{}`]; break;
    default: patterns = [`refs/heads/${ref.name}`, `refs/tags/${ref.name}`, `refs/tags/${ref.name}^{}`];
    }
    return { fetchUrl: parsed.fetchUrl, patterns, key: canonicalDigest({ fetchUrl: parsed.fetchUrl, patterns }) };
}

export function parseLsRemoteOutput(text) {
    const refs = new Map();
    for (const line of String(text || '').split('\n')) {
        if (!line.trim()) continue;
        if (line.startsWith('ref: ')) continue;
        const match = /^([0-9a-f]{40})\t(\S+)$/.exec(line.trim());
        if (!match) throw new Error(`malformed ls-remote line: ${line.slice(0, 120)}`);
        refs.set(match[2], match[1]);
    }
    return refs;
}

/**
 * Pick the one commit a ref denotes from exact ls-remote rows.
 * Annotated tags are peeled; a short name matching both a branch and a tag is
 * ambiguous and never resolved by row order.
 */
export function resolveRefFromLsRemote(parsed, refs) {
    const { ref } = parsed;
    const tagCommit = (name) => refs.get(`refs/tags/${name}^{}`) || refs.get(`refs/tags/${name}`) || null;
    if (ref.kind === 'head') {
        const commit = refs.get('HEAD');
        return commit ? { status: 'resolved', commit, resolvedRef: 'HEAD' } : { status: 'not-found' };
    }
    if (ref.kind === 'branch') {
        const commit = refs.get(`refs/heads/${ref.name}`);
        return commit ? { status: 'resolved', commit, resolvedRef: `refs/heads/${ref.name}` } : { status: 'not-found' };
    }
    if (ref.kind === 'tag') {
        const commit = tagCommit(ref.name);
        return commit
            ? { status: 'resolved', commit, resolvedRef: `refs/tags/${ref.name}`, peeled: refs.has(`refs/tags/${ref.name}^{}`) }
            : { status: 'not-found' };
    }
    const branch = refs.get(`refs/heads/${ref.name}`) || null;
    const tag = tagCommit(ref.name);
    if (branch && tag) {
        return { status: 'ambiguous', candidates: [`refs/heads/${ref.name}`, `refs/tags/${ref.name}`] };
    }
    if (branch) return { status: 'resolved', commit: branch, resolvedRef: `refs/heads/${ref.name}` };
    if (tag) return { status: 'resolved', commit: tag, resolvedRef: `refs/tags/${ref.name}`, peeled: refs.has(`refs/tags/${ref.name}^{}`) };
    return { status: 'not-found' };
}
