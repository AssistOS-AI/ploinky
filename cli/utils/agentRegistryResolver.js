// One deterministic enabled-agent resolver shared by every operator surface.
//
// This module is pure: it takes an already-loaded registry map and never
// touches the filesystem, so a read-only command can use the same precedence as
// the loading command handlers. It replaces two earlier copies whose qualified
// branch fell back to a global bare alias and whose duplicate handling silently
// selected the first map entry.
//
// Precedence for one operator reference:
//   1. an exact registry key holding an enabled agent record;
//   2. an unqualified exact alias, when exactly one record carries it;
//   3. a qualified `repo/agent` or `repo:agent`, matched on repoName plus
//      agentName only, never falling back to an alias;
//   4. a remaining unqualified bare agent name, when exactly one record matches.
//
// Duplicates, ambiguity, and malformed qualified spellings never select a
// record.

export const RESERVED_AGENT_REGISTRY_KEYS = Object.freeze(new Set(['_config']));

// The log grammar reserves this literal for Router logs, so it is never offered
// as a bare agent completion even when an agent or alias uses the spelling.
export const RESERVED_LOG_TARGET = 'router';

export const AGENT_REFERENCE_MALFORMED = 'malformed-qualified-reference';
export const AGENT_REFERENCE_UNKNOWN = 'unknown-reference';
export const AGENT_REFERENCE_AMBIGUOUS = 'ambiguous-reference';
export const MAX_DIAGNOSTIC_AGENT_REFERENCES = 20;

// Completion is whitespace-tokenized by both REPL entry points, leading '-'
// is flag syntax, and a number-shaped sole target is parsed as `logs last`'s
// line count. Registry state is observational input, so tampered values must
// not be advertised when the command grammar cannot consume them verbatim.
const UNSAFE_LOG_REFERENCE_CHARACTERS = /[\s\u0000-\u001f\u007f-\u009f]/u;
const COUNT_SHAPED_LOG_REFERENCE = /^[+.]?[0-9]/;

function isUsableLogReferenceCandidate(candidate) {
    return Boolean(candidate)
        && candidate !== RESERVED_LOG_TARGET
        && !candidate.startsWith('-')
        && !COUNT_SHAPED_LOG_REFERENCE.test(candidate)
        && !UNSAFE_LOG_REFERENCE_CHARACTERS.test(candidate);
}

function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function enabledAgentEntries(registry) {
    if (!registry || typeof registry !== 'object') return [];
    return Object.entries(registry).filter(([key, record]) => (
        !RESERVED_AGENT_REGISTRY_KEYS.has(key)
        && record
        && typeof record === 'object'
        && record.type === 'agent'
    ));
}

function appendIndex(index, key, entry) {
    if (!key) return;
    const matches = index.get(key);
    if (matches) matches.push(entry);
    else index.set(key, [entry]);
}

function buildReferenceIndex(registry) {
    const entries = enabledAgentEntries(registry);
    const byContainer = new Map(entries);
    const aliases = new Map();
    const qualified = new Map();
    const names = new Map();
    for (const entry of entries) {
        const [, record] = entry;
        const alias = text(record.alias);
        const repoName = text(record.repoName);
        const agentName = text(record.agentName);
        appendIndex(aliases, alias, entry);
        if (repoName && agentName) appendIndex(qualified, `${repoName}\0${agentName}`, entry);
        appendIndex(names, agentName, entry);
    }
    return Object.freeze({ registry, entries, byContainer, aliases, qualified, names });
}

function boundedDiagnosticReferences(references) {
    const unique = Array.from(new Set(references)).sort();
    return Object.freeze({
        references: Object.freeze(unique.slice(0, MAX_DIAGNOSTIC_AGENT_REFERENCES)),
        omitted: Math.max(0, unique.length - MAX_DIAGNOSTIC_AGENT_REFERENCES),
    });
}

function ambiguityError(agentRef, matches, index, { concise = false } = {}) {
    const bounded = concise
        ? { references: Object.freeze([]), omitted: 0 }
        : boundedDiagnosticReferences(matches
            .map(([containerName, record]) => preferredReferenceFromIndex(
                containerName,
                record,
                index,
            ))
            .filter(Boolean));
    const usable = bounded.references;
    const suffix = concise
        ? ''
        : (usable.length
            ? ` Use one of: ${usable.join(', ')}${bounded.omitted ? ` … (+${bounded.omitted} more)` : ''}`
            : ' No usable log reference is configured for the matching records.');
    const error = new Error(`Multiple containers found for agent '${agentRef}'.${suffix}`);
    error.code = 'AGENT_ALIAS_AMBIGUOUS';
    error.usableReferences = Object.freeze(usable);
    error.omittedSuggestionCount = bounded.omitted;
    return error;
}

// A qualified reference carries exactly one separator and two nonempty
// components. Everything else -- `a/`, `/b`, `a//b`, `a/b/c`, `a:b:c`, `a/b:c`
// -- is malformed and must never fall through to a bare-name search.
export function parseQualifiedAgentReference(input) {
    const separators = (input.match(/[:/]/g) || []).length;
    if (separators === 0) return { qualified: false, malformed: false };
    if (separators > 1) return { qualified: true, malformed: true };
    const [repoName, agentName] = input.split(/[:/]/);
    if (!repoName || !agentName) return { qualified: true, malformed: true };
    return { qualified: true, malformed: false, repoName, agentName };
}

function resolveFromIndex(agentRef, index, {
    conciseAmbiguity = false,
} = {}) {
    const input = text(agentRef);
    if (!input) return null;

    if (!RESERVED_AGENT_REGISTRY_KEYS.has(input)) {
        const direct = index.byContainer.get(input);
        if (direct) {
            return { containerName: input, record: direct };
        }
    }

    const qualification = parseQualifiedAgentReference(input);
    if (qualification.malformed) return null;

    if (qualification.qualified) {
        const matches = index.qualified.get(
            `${qualification.repoName}\0${qualification.agentName}`,
        ) || [];
        if (!matches.length) return null;
        if (matches.length > 1) throw ambiguityError(agentRef, matches, index, { concise: conciseAmbiguity });
        return { containerName: matches[0][0], record: matches[0][1] };
    }

    const aliasMatches = index.aliases.get(input) || [];
    if (aliasMatches.length === 1) {
        return { containerName: aliasMatches[0][0], record: aliasMatches[0][1] };
    }
    if (aliasMatches.length > 1) {
        throw ambiguityError(agentRef, aliasMatches, index, { concise: conciseAmbiguity });
    }

    const nameMatches = index.names.get(input) || [];
    if (!nameMatches.length) return null;
    if (nameMatches.length > 1) {
        throw ambiguityError(agentRef, nameMatches, index, { concise: conciseAmbiguity });
    }
    return { containerName: nameMatches[0][0], record: nameMatches[0][1] };
}

export function resolveEnabledAgentRecordFromMap(agentRef, registry = {}, options = {}) {
    return resolveFromIndex(agentRef, buildReferenceIndex(registry), options);
}

function usableReferencesFromIndex(containerName, record, index) {
    const alias = text(record?.alias);
    const repoName = text(record?.repoName);
    const agentName = text(record?.agentName);
    const candidates = [
        alias,
        repoName && agentName ? `${repoName}/${agentName}` : '',
        agentName,
        text(containerName),
    ];
    const usable = [];
    for (const candidate of candidates) {
        if (!isUsableLogReferenceCandidate(candidate) || usable.includes(candidate)) continue;
        try {
            const resolved = resolveFromIndex(candidate, index, {
                conciseAmbiguity: true,
            });
            if (resolved?.containerName === containerName) usable.push(candidate);
        } catch (_) {}
    }
    return Object.freeze(usable);
}

export function usableAgentLogReferencesForRecord(containerName, record, registry = {}) {
    return usableReferencesFromIndex(containerName, record, buildReferenceIndex(registry));
}

function preferredReferenceFromIndex(containerName, record, index) {
    return usableReferencesFromIndex(containerName, record, index)[0] || null;
}

export function preferredUsableAgentLogReference(containerName, record, registry = {}) {
    return preferredReferenceFromIndex(containerName, record, buildReferenceIndex(registry));
}

// Every suggestion must be a reference that resolves to exactly one record, so
// completion never advertises a spelling the resolver rejects.
export function enabledAgentLogSuggestionsFromMap(registry = {}) {
    const index = buildReferenceIndex(registry);
    const suggestions = new Set();
    for (const [containerName, record] of index.entries) {
        const preferred = preferredReferenceFromIndex(containerName, record, index);
        if (preferred) suggestions.add(preferred);
    }
    return Object.freeze(Array.from(suggestions).sort());
}

// Diagnostics only. The resolver itself returns null for anything it cannot
// select so its established caller contract stays unchanged; this explains why.
export function explainAgentReferenceFailure(agentRef, registry = {}) {
    const input = text(agentRef);
    const index = buildReferenceIndex(registry);
    const qualification = parseQualifiedAgentReference(input);
    if (qualification.malformed) {
        const bounded = boundedDiagnosticReferences(index.entries
            .map(([containerName, record]) => preferredReferenceFromIndex(containerName, record, index))
            .filter(Boolean));
        return Object.freeze({
            reason: AGENT_REFERENCE_MALFORMED,
            message: `'${agentRef}' is not one exact 'repo/agent' reference`,
            suggestions: bounded.references,
            omittedSuggestionCount: bounded.omitted,
        });
    }
    try {
        const resolved = resolveFromIndex(input, index);
        if (resolved) return null;
    } catch (error) {
        if (error?.code === 'AGENT_ALIAS_AMBIGUOUS') {
            return Object.freeze({
                reason: AGENT_REFERENCE_AMBIGUOUS,
                message: error.message,
                suggestions: error.usableReferences || Object.freeze([]),
                omittedSuggestionCount: error.omittedSuggestionCount || 0,
            });
        }
        throw error;
    }
    const bounded = boundedDiagnosticReferences(index.entries
        .map(([containerName, record]) => preferredReferenceFromIndex(containerName, record, index))
        .filter(Boolean));
    return Object.freeze({
        reason: AGENT_REFERENCE_UNKNOWN,
        message: `'${agentRef}' is not one enabled agent`,
        suggestions: bounded.references,
        omittedSuggestionCount: bounded.omitted,
    });
}
