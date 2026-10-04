import { createHash } from 'node:crypto';
import { AcceptanceError, need, exact } from './manifest_codex.mjs';

export const IMPORT_LIMITS = Object.freeze({ modules: 2048, edges: 8192, sourceBytes: 1048576, totalBytes: 33554432, calls: 16384 });
const hash = value => createHash('sha256').update(value).digest('hex');
const publicFailures = new Set(['import-after-failure', 'import-call-cap', 'import-conditions', 'import-attributes', 'import-edge-unqualified',
    'import-resolution-changed', 'import-builtin-changed', 'import-load-unqualified', 'import-source-shape', 'import-acquisition-cap',
    'import-source-changed', 'import-source-encoding', 'import-source-roundtrip', 'import-initial-closure-unproven', 'import-load-attributes']);
const fileURL = value => {
    if (typeof value !== 'string' || value.length > 4096) return false;
    try { const url = new URL(value); return url.protocol === 'file:' && url.hostname === '' && !url.search && !url.hash && url.href === value; }
    catch { return false; }
};
const word = value => typeof value === 'string' && /^[A-Za-z0-9_.:/@#-]{1,128}$/.test(value);
function dataArray(value, cap, code) {
    need(Array.isArray(value) && value.length <= cap && Reflect.ownKeys(value).length === value.length + 1, code);
    const result = [];
    for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        need(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true, code); result.push(descriptor.value);
    }
    return result;
}
function conditions(value) {
    const result = dataArray(value, 32, 'import-conditions');
    need(result.every(word) && new Set(result).size === result.length, 'import-conditions'); return result.sort();
}
function attributes(value) {
    need(value && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).length <= 8, 'import-attributes');
    const rows = [];
    const keys = Reflect.ownKeys(value); need(keys.every(key => typeof key === 'string'), 'import-attributes');
    for (const key of keys.sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        need(word(key) && Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true && word(descriptor.value), 'import-attributes'); rows.push([key, descriptor.value]);
    }
    return rows;
}
const edgeKey = (specifier, parentURL, conditionList, attributeObject) => JSON.stringify([specifier, parentURL, conditions(conditionList), attributes(attributeObject)]);

// These predicates do not register hooks or import product code. A qualified fresh worker must supply the bounded source reader.
export function createVerifiedImportHooks(catalog, { readSource, check }) {
    exact(catalog, ['schemaVersion', 'candidateCommit', 'apiURL', 'entryParentURL', 'builtins', 'modules', 'edges', 'initialModules']);
    need(catalog.schemaVersion === 1 && /^[a-f0-9]{40}$/.test(catalog.candidateCommit) && fileURL(catalog.apiURL)
        && fileURL(catalog.entryParentURL) && typeof readSource === 'function' && typeof check === 'function', 'import-catalog');
    need(Array.isArray(catalog.modules) && catalog.modules.length > 0 && catalog.modules.length <= IMPORT_LIMITS.modules
        && Array.isArray(catalog.edges) && catalog.edges.length > 0 && catalog.edges.length <= IMPORT_LIMITS.edges
        && Array.isArray(catalog.builtins) && catalog.builtins.length <= 128, 'import-catalog');
    const moduleRows = dataArray(catalog.modules, IMPORT_LIMITS.modules, 'import-catalog');
    const edgeRows = dataArray(catalog.edges, IMPORT_LIMITS.edges, 'import-catalog');
    const builtinRows = dataArray(catalog.builtins, 128, 'import-catalog');
    need(builtinRows.every(value => typeof value === 'string' && /^node:[a-z0-9_/-]{1,96}$/.test(value))
        && new Set(builtinRows).size === builtinRows.length, 'import-catalog');
    const modules = new Map(), edges = new Map(), builtins = new Set(builtinRows), loadPairs = new Set(); let admittedBytes = 0;
    for (const row of moduleRows) {
        exact(row, ['url', 'format', 'bytes', 'sha256']);
        need(fileURL(row.url) && !modules.has(row.url) && ['module', 'commonjs', 'json'].includes(row.format)
            && Number.isSafeInteger(row.bytes) && row.bytes >= 0 && row.bytes <= IMPORT_LIMITS.sourceBytes
            && /^[a-f0-9]{64}$/.test(row.sha256), 'import-module');
        admittedBytes += row.bytes; need(admittedBytes <= IMPORT_LIMITS.totalBytes, 'import-catalog-cap');
        modules.set(row.url, Object.freeze({ ...row }));
    }
    for (const edge of edgeRows) {
        exact(edge, ['specifier', 'parentURL', 'conditions', 'attributes', 'url', 'format']);
        need(typeof edge.specifier === 'string' && edge.specifier.length > 0 && edge.specifier.length <= 4096
            && (edge.parentURL === catalog.entryParentURL || modules.has(edge.parentURL))
            && (modules.has(edge.url) && modules.get(edge.url).format === edge.format || builtins.has(edge.url) && edge.format === 'builtin'), 'import-edge');
        const key = edgeKey(edge.specifier, edge.parentURL, edge.conditions, edge.attributes);
        const attributeRows = attributes(edge.attributes);
        need(!edges.has(key), 'import-edge-duplicate'); edges.set(key, Object.freeze({ url: edge.url, format: edge.format, attributeRows }));
        loadPairs.add(JSON.stringify([edge.url, edge.format, attributeRows]));
    }
    const initial = dataArray(catalog.initialModules, IMPORT_LIMITS.modules, 'import-initial-closure');
    need(initial.length > 0 && initial.length <= modules.size && initial.includes(catalog.apiURL) && initial.every(url => modules.has(url))
        && new Set(initial).size === initial.length, 'import-initial-closure');
    const apiURL = catalog.apiURL, loaded = new Set();
    let firstFailure = null, calls = 0, acquiredBytes = 0;
    function guarded(operation) {
        try { need(firstFailure === null, 'import-after-failure'); check(); need(++calls <= IMPORT_LIMITS.calls, 'import-call-cap');
            const result = operation(); check(); return result;
        } catch (error) { firstFailure ??= error instanceof AcceptanceError && publicFailures.has(error.code) ? error.code : 'import-binding-unknown'; throw new AcceptanceError(firstFailure); }
    }
    function resolve(specifier, context, nextResolve) {
        return guarded(() => {
            const expected = edges.get(edgeKey(specifier, context.parentURL, context.conditions, context.importAttributes));
            need(expected, 'import-edge-unqualified');
            const result = nextResolve(specifier, context);
            const builtinWithoutFormat = expected.format === 'builtin' && builtins.has(expected.url) && result?.format === undefined;
            need(result?.url === expected.url && (result.format === expected.format || builtinWithoutFormat), 'import-resolution-changed');
            if (Object.hasOwn(result, 'importAttributes')) {
                need(JSON.stringify(attributes(result.importAttributes)) === JSON.stringify(expected.attributeRows), 'import-resolution-changed');
                // Node accepts null-prototype data attributes; keep their prototype and privately copy the admitted values.
                const copied = Object.create(Object.getPrototypeOf(result.importAttributes));
                for (const [key, value] of expected.attributeRows) Object.defineProperty(copied, key, { value, enumerable: true });
                return { ...result, importAttributes: Object.freeze(copied) };
            }
            return result;
        });
    }
    function load(url, context, nextLoad) {
        return guarded(() => {
            const admittedFormat = modules.get(url)?.format ?? (builtins.has(url) ? 'builtin' : null);
            need(loadPairs.has(JSON.stringify([url, admittedFormat, attributes(context.importAttributes ?? {})])), 'import-load-attributes');
            if (builtins.has(url)) {
                need(context.format == null || context.format === 'builtin', 'import-load-unqualified');
                const result = nextLoad(url, context); need(result?.format === 'builtin' && result.source == null, 'import-builtin-changed'); return result;
            }
            const row = modules.get(url); need(row && (context.format == null || context.format === row.format), 'import-load-unqualified');
            need(row.bytes <= IMPORT_LIMITS.totalBytes - acquiredBytes, 'import-acquisition-cap');
            const value = readSource(row); need(Buffer.isBuffer(value) && value.length === row.bytes && value.length <= IMPORT_LIMITS.sourceBytes, 'import-source-shape');
            const bytes = Buffer.from(value); acquiredBytes += bytes.length; need(acquiredBytes <= IMPORT_LIMITS.totalBytes, 'import-acquisition-cap');
            need(hash(bytes) === row.sha256, 'import-source-changed');
            let source; try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
            catch { throw new AcceptanceError('import-source-encoding'); }
            need(hash(Buffer.from(source, 'utf8')) === row.sha256, 'import-source-roundtrip');
            loaded.add(url); return { format: row.format, source, shortCircuit: true };
        });
    }
    return Object.freeze({ resolve, load, assertInitialClosure() {
        return guarded(() => { need(initial.every(url => loaded.has(url)) && loaded.has(apiURL), 'import-initial-closure-unproven'); return true; });
    }, snapshot: () => ({ firstFailure, calls, acquiredBytes, loadedModules: loaded.size, actualRegistration: 'UNPROVEN', actualAPI: 'UNPROVEN' }) });
}
