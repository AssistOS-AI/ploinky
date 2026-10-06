import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { AcceptanceError, need, smokeOrigin } from './manifest_codex.mjs';
import { applicationMarker, createApplicationMarker, verifyApplicationMarker } from './application_marker_codex.mjs';

// U1/U7 browser port. It drives the repository's own Explorer smoke helpers (ordinary provisioned-account login, the
// real Explorer upload and preview) from the pinned AssistOSExplorer checkout; this harness adds no login, cookie or
// token handling. Every browser context it opens is retained and closed here, in reverse order.
const ACTION_TIMEOUT_MS = 20000;

export function smokeEnvironment(manifest, runStem) {
    const publication = manifest.publications[0];
    // Loopback sign-in is canonicalized to `localhost` and the smoke helper refuses an origin change, so the origin is `localhost` (as in the gates).
    return { SMOKE_BASE_URL: smokeOrigin(publication), SMOKE_RUN_ID: `${runStem}-browser`.replace(/[^A-Za-z0-9_-]/g, '-'),
        SMOKE_ARTIFACT_DIR: path.join(manifest.evidence.root, 'browser'), SMOKE_WORKSPACE_ROOT: manifest.workspace.path };
}

export function createBrowserPort({ manifest, markerFiles, check, processEnv = process.env, importModule = specifier => import(specifier), requireFrom = createRequire }) {
    need(manifest && markerFiles && typeof check === 'function', 'browser-port-adapters');
    const explorer = manifest.candidate.repositories.find(repo => repo.name === 'AssistOSExplorer');
    need(explorer, 'browser-explorer-repository');
    const smoke = path.join(explorer.path, 'tests', 'smoke'), contexts = []; let modules = null, browser = null, createdMarker = null;
    async function load() {
        if (modules) return modules;
        // The smoke configuration reads its environment once at import; set it before the first import.
        Object.assign(processEnv, smokeEnvironment(manifest, manifest.runId.replace(/_codex$/, '')));
        const playwright = requireFrom(path.join(smoke, 'package.json'))('@playwright/test');
        const helpers = await importModule(pathToFileURL(path.join(smoke, 'lib', 'explorer.mjs')).href);
        need(typeof playwright?.chromium?.launch === 'function' && typeof helpers.openExplorer === 'function' && typeof helpers.assertExplorerDirectory === 'function', 'browser-modules-unqualified');
        modules = { chromium: playwright.chromium, openExplorer: helpers.openExplorer, assertExplorerDirectory: helpers.assertExplorerDirectory }; return modules;
    }
    async function newPage() {
        const { chromium } = await load();
        if (!browser) browser = await chromium.launch({ headless: true });
        const context = await browser.newContext(); contexts.push(context);      // retained before any fallible step
        const page = await context.newPage(); page.setDefaultTimeout?.(ACTION_TIMEOUT_MS); return page;
    }
    return Object.freeze({
        async createMarker({ live, expected }) {
            const { openExplorer, assertExplorerDirectory } = await load(); const page = await newPage();
            const receipt = await createApplicationMarker({ manifest, live, expected, page, openExplorer, assertExplorerDirectory, readMarker: markerFiles.readMarker, retainMarker: markerFiles.retainMarker, check, actionTimeoutMs: ACTION_TIMEOUT_MS });
            createdMarker = Object.freeze({ ...applicationMarker(manifest), bytes: applicationMarker(manifest).bytes.length }); return receipt;
        },
        // A fresh context after the updates: nothing of the earlier page, cookies or storage is reused.
        async verifyMarker() {
            need(createdMarker, 'browser-marker-absent'); const { openExplorer, assertExplorerDirectory } = await load(); const page = await newPage();
            return verifyApplicationMarker({ marker: createdMarker, page, openExplorer, assertExplorerDirectory, readMarker: markerFiles.readMarker, check, actionTimeoutMs: ACTION_TIMEOUT_MS });
        },
        marker: () => createdMarker,
        async close() {
            const failures = [];
            for (const context of contexts.splice(0).reverse()) { try { await context.close(); } catch { failures.push('context'); } }
            if (browser) { try { await browser.close(); } catch { failures.push('browser'); } browser = null; }
            need(failures.length === 0, 'browser-close-unproven');
            return Object.freeze({ closed: true });
        },
        openContexts: () => contexts.length,
    });
}
