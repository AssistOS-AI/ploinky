import { createHash } from 'node:crypto';
import { assertLiveBefore } from './contracts_codex.mjs';
import { AcceptanceError, need } from './manifest_codex.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function applicationMarker(manifest) {
    const stem = manifest.runId.replace(/_codex$/, '');
    const name = `update-persistence-${stem}_codex.txt`;
    const bytes = Buffer.from(`update/cache persistence marker ${manifest.runId}\n`);
    return Object.freeze({ name, applicationPath: `/${name}`, workspacePath: `${manifest.workspace.path}/${name}`,
        bytes, text: bytes.toString('utf8'), sha256: hash(bytes), boxId: manifest.box.id });
}

// Use the ordinary Explorer controls. The runner owns the actual browser context and exact-ID storage observer.
export async function createApplicationMarker({ manifest, live, expected, page, openExplorer, assertExplorerDirectory,
    readMarker, retainMarker, check, actionTimeoutMs }) {
    // U1 creates a fixture only against the independently observed live deployment that U0 bound.
    assertLiveBefore({ expected, observed: live });
    manifest = structuredClone(manifest);
    need([openExplorer, assertExplorerDirectory, readMarker, retainMarker, check].every(value => typeof value === 'function')
        && page?.locator && page?.waitForResponse && page?.waitForFunction
        && Number.isSafeInteger(actionTimeoutMs) && actionTimeoutMs > 0 && actionTimeoutMs <= 30000, 'application-marker-adapters');
    const marker = applicationMarker(manifest); check();
    need((await readMarker(marker)).exists === false, 'application-marker-already-present'); check();
    retainMarker(Object.freeze({ ...marker, bytes: marker.bytes.length, identity: null, ownership: 'CREATION_PENDING_AFTER_PROVEN_ABSENCE' }));
    await openExplorer(page, { hash: 'file-exp/' }); check();
    await assertExplorerDirectory(page, '/'); check();
    const origin = new URL(page.url()).origin;
    const publication = manifest.publications.find(row => row.protocol === 'tcp' && row.containerPort === 8080);
    need(publication && origin === `http://${publication.hostIP}:${publication.hostPort}`, 'application-marker-origin');
    const response = page.waitForResponse(value => {
        const url = new URL(value.url());
        return url.origin === origin && url.pathname === '/upload' && url.searchParams.get('path') === marker.applicationPath
            && value.request().method() === 'POST';
    }, { timeout: actionTimeoutMs });
    // Retain the pending observer immediately, including when the browser operation fails.
    const observed = response.then(value => ({ value }), () => ({ failed: true }));
    check();
    try { await page.locator('file-exp #fileUploadInput').setInputFiles({ name: marker.name, mimeType: 'text/plain', buffer: marker.bytes }, { timeout: actionTimeoutMs }); }
    catch { await observed; throw new AcceptanceError('application-marker-browser'); }
    const upload = await observed; check();
    need(upload.value && upload.value.status() >= 200 && upload.value.status() < 300, 'application-marker-upload');
    await page.waitForFunction(({ path, markerText }) => {
        const component = document.querySelector('file-exp');
        return component?.webSkelPresenter?.state?.selectedPath === path
            && document.querySelector('#filePreview')?.textContent?.includes(markerText);
    }, { path: marker.applicationPath, markerText: marker.bytes.toString('utf8').trim() }, { timeout: actionTimeoutMs }); check();
    const stored = await readMarker(marker); check();
    need(stored.exists === true && stored.boxId === marker.boxId && stored.path === marker.workspacePath
        && stored.bytes === marker.bytes.length && stored.sha256 === marker.sha256
        && stored.regular === true && stored.links === 1 && stored.identity, 'application-marker-storage');
    retainMarker(Object.freeze({ ...marker, bytes: marker.bytes.length, identity: structuredClone(stored.identity) }));
    return Object.freeze({ phase: 'U1', markerPath: marker.applicationPath, byteCount: marker.bytes.length,
        sha256: marker.sha256, uploaded: true, previewed: true, storageProved: true });
}

export async function verifyApplicationMarker({ marker, page, openExplorer, assertExplorerDirectory, readMarker, check, actionTimeoutMs }) {
    check(); const stored = await readMarker(marker); check();
    need(stored.exists === true && stored.boxId === marker.boxId && stored.path === marker.workspacePath
        && stored.bytes === marker.bytes && stored.sha256 === marker.sha256, 'application-marker-not-preserved');
    await openExplorer(page, { hash: 'file-exp/' }); await assertExplorerDirectory(page, '/'); check();
    await page.locator(`tr[data-entry-path="${marker.applicationPath}"]`).click({ timeout: actionTimeoutMs });
    await page.waitForFunction(path => document.querySelector('file-exp')?.webSkelPresenter?.state?.selectedPath === path,
        marker.applicationPath, { timeout: actionTimeoutMs });
    const content = await page.locator('#filePreview').textContent({ timeout: actionTimeoutMs }); check();
    need(typeof content === 'string' && Buffer.byteLength(content) <= 4096
        && content.includes(marker.text.trim()), 'application-marker-preview-not-preserved');
    return Object.freeze({ phase: 'U7', markerPath: marker.applicationPath, sha256: marker.sha256, storageProved: true, previewed: true });
}
