import fs from 'node:fs';
import path from 'node:path';
import module from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AcceptanceError, need } from './manifest_codex.mjs';
import { IMPORT_LIMITS } from './import_binding_codex.mjs';
import { importProduct } from './product_import_codex.mjs';

// Source-qualification channel for the verified import binding: Node's own synchronous resolve/load hooks record the
// exact resolution edges and source bytes of one finite import of the pinned candidate. No source is parsed here.
// Edges that the recorded imports do not reach are absent from the catalog and are refused by the verified worker.
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const rows = value => Object.keys(value ?? {}).sort().map(key => [key, value[key]]);
export const PRODUCT_API_RELATIVE = 'ploinky-box/bin/ploinky-box.mjs';
export const DEFAULT_EXTRA_ENTRIES = Object.freeze(['ploinky-box/supervisor.mjs']);

export function createCatalogRecorder({ entryParentURL, io = fs }) {
    const modules = new Map(), edges = [], builtins = new Set(); let total = 0, failure = null, initial = null;
    const fail = code => { failure ??= code; throw new AcceptanceError(failure); };
    // The first refusal latches: no later resolution or load is recorded or delegated.
    const latched = operation => (...args) => {
        need(failure === null, 'catalog-after-failure');
        try { return operation(...args); } catch (error) { failure ??= error instanceof AcceptanceError ? error.code : 'catalog-failed'; throw error instanceof AcceptanceError ? error : new AcceptanceError(failure); }
    };
    const resolve = latched(function resolveEdge(specifier, context, nextResolve) {
        const result = nextResolve(specifier, context);
        need(edges.length < IMPORT_LIMITS.edges, 'catalog-edge-cap');
        // A builtin already cached by this process never reaches the load hook, so builtins are taken from resolution.
        if (result.url.startsWith('node:')) { need(/^node:[a-z0-9_/-]{1,96}$/.test(result.url) && builtins.size < 128, 'catalog-builtin'); builtins.add(result.url); }
        else need(result.url.startsWith('file:'), 'catalog-url');
        edges.push({ specifier, parentURL: context.parentURL, conditions: [...context.conditions].sort(), attributes: Object.fromEntries(rows(context.importAttributes)),
            url: result.url, format: result.format ?? null, resultAttributes: result.importAttributes === undefined ? undefined : Object.fromEntries(rows(result.importAttributes)) });
        return result;
    });
    const load = latched(function loadModule(url, context, nextLoad) {
        if (url.startsWith('node:')) { const result = nextLoad(url, context); need(result?.format === 'builtin', 'catalog-builtin'); return result; }
        let filename;
        try { const parsed = new URL(url); need(parsed.protocol === 'file:' && !parsed.hostname && !parsed.search && !parsed.hash && parsed.href === url, 'catalog-url'); filename = fileURLToPath(parsed); }
        catch (error) { if (error instanceof AcceptanceError) fail(error.code); fail('catalog-url'); }
        // Bound the size before the normal loader reads the file; the descriptor view is only used to hash exact bytes.
        const stat = io.lstatSync(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > IMPORT_LIMITS.sourceBytes) fail('catalog-source-shape');
        const result = nextLoad(url, context);
        need(['module', 'commonjs', 'json'].includes(result?.format), 'catalog-format');
        const bytes = io.readFileSync(filename);
        need(bytes.length === stat.size, 'catalog-source-changed');
        if (!modules.has(url)) { need(modules.size < IMPORT_LIMITS.modules, 'catalog-module-cap'); total += bytes.length; need(total <= IMPORT_LIMITS.totalBytes, 'catalog-byte-cap'); }
        modules.set(url, { url, format: result.format, bytes: bytes.length, sha256: hash(bytes) });
        return result;
    });
    return Object.freeze({ resolve, load,
        markInitial() { initial = [...modules.keys()].sort(); },
        finish({ candidateCommit, apiURL }) {
            need(failure === null && initial && /^[a-f0-9]{40}$/.test(candidateCommit) && modules.has(apiURL), failure ?? 'catalog-incomplete');
            const unique = new Map();
            for (const edge of edges) {
                const format = edge.url.startsWith('node:') ? 'builtin' : modules.get(edge.url)?.format;
                need(format, 'catalog-edge-unloaded');
                const key = JSON.stringify([edge.specifier, edge.parentURL, edge.conditions, rows(edge.attributes)]);
                const row = { specifier: edge.specifier, parentURL: edge.parentURL, conditions: edge.conditions, attributes: edge.attributes, url: edge.url, format };
                if (unique.has(key)) { need(JSON.stringify(unique.get(key)) === JSON.stringify(row), 'catalog-edge-ambiguous'); continue; }
                unique.set(key, row);
            }
            return { schemaVersion: 1, candidateCommit, apiURL, entryParentURL, builtins: [...builtins].sort(),
                modules: [...modules.values()].sort((a, b) => a.url.localeCompare(b.url)), edges: [...unique.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), initialModules: initial };
        } });
}

export function parseBuilderArguments(argv) {
    need(Array.isArray(argv) && argv.length >= 6 && argv.length <= 40 && argv.length % 2 === 0, 'catalog-arguments');
    const values = { extra: [] };
    for (let index = 0; index < argv.length; index += 2) {
        const [name, value] = [argv[index], argv[index + 1]]; need(typeof value === 'string' && !value.startsWith('--'), 'catalog-arguments');
        if (name === '--extra') values.extra.push(value); else { need(['--candidate', '--commit', '--out'].includes(name) && !Object.hasOwn(values, name), 'catalog-arguments'); values[name] = value; }
    }
    need(path.isAbsolute(values['--candidate']) && path.normalize(values['--candidate']) === values['--candidate'] && /^[a-f0-9]{40}$/.test(values['--commit'] ?? '')
        && path.isAbsolute(values['--out']) && /_codex\.json$/.test(values['--out']), 'catalog-arguments');
    for (const extra of values.extra) need(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.(?:mjs|js|cjs)$/.test(extra) && !extra.split('/').includes('..') && !extra.split('/').includes('.'), 'catalog-arguments');
    return { candidate: values['--candidate'], commit: values['--commit'], out: values['--out'], extra: values.extra };
}

// Run only in a fresh process: hooks are process-global and the recorded import executes the candidate's module top levels.
export async function buildCatalogMain(argv, { io = fs, registerHooks = module.registerHooks, importer = importProduct, entryParentURL = new URL('./product_import_codex.mjs', import.meta.url).href } = {}) {
    const { candidate, commit, out, extra } = parseBuilderArguments(argv);
    need(typeof registerHooks === 'function', 'catalog-hooks-unavailable');
    const apiURL = pathToFileURL(path.join(candidate, PRODUCT_API_RELATIVE)).href;
    const recorder = createCatalogRecorder({ entryParentURL, io });
    registerHooks({ resolve: recorder.resolve, load: recorder.load });
    const api = await importer(apiURL); need(typeof api?.runOuterCli === 'function', 'catalog-api-missing');
    recorder.markInitial();
    for (const entry of [...new Set([...DEFAULT_EXTRA_ENTRIES, ...extra])]) await importer(pathToFileURL(path.join(candidate, entry)).href);
    const catalog = recorder.finish({ candidateCommit: commit, apiURL });
    const fd = io.openSync(out, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { io.writeSync(fd, JSON.stringify(catalog, null, 1) + '\n'); } finally { io.closeSync(fd); }
    return { modules: catalog.modules.length, edges: catalog.edges.length, builtins: catalog.builtins.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { process.stdout.write(JSON.stringify(await buildCatalogMain(process.argv.slice(2))) + '\n'); }
    catch (error) { process.stderr.write(JSON.stringify({ status: 'FAILED', reason: error instanceof AcceptanceError ? error.code : 'catalog-failed' }) + '\n'); process.exitCode = 1; }
}
