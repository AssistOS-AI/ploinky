import fs from 'node:fs';
import path from 'node:path';
import { AcceptanceError, need } from './manifest_codex.mjs';
import { readBoundedRegularFile } from './worker_codex.mjs';

// U7b: remove exactly what this run created, in dependency order, and only while every owned command has settled.
// The repository key must carry the exact owned name and URL before the supported uninstall runs; the server and
// fixture files are removed by the fixture's own ownership proofs; the marker by its recorded identity.
const SOURCES_BYTES = 1024 * 1024;

export function createCleanupPort({ manifest, cache, fixture, markerFiles, marker, io = fs }) {
    need(manifest && cache && fixture && markerFiles && marker, 'cleanup-port-adapters');
    const sourcesFile = path.join(manifest.workspace.path, '.ploinky', 'repo_sources.json'), reposDir = path.join(manifest.workspace.path, '.ploinky', 'repos');
    function sourceEntry(name) {
        let bytes; try { bytes = readBoundedRegularFile(sourcesFile, SOURCES_BYTES, io); } catch (error) { if (error?.code === 'ENOENT') return undefined; throw new AcceptanceError('cleanup-sources-unreadable'); }
        let entries; try { entries = JSON.parse(bytes.toString('utf8')); } catch { throw new AcceptanceError('cleanup-sources-unreadable'); }
        need(entries && typeof entries === 'object' && !Array.isArray(entries), 'cleanup-sources-unreadable');
        const entry = entries[name]; return entry === undefined ? undefined : (typeof entry === 'string' ? entry : entry?.url);
    }
    return Object.freeze({
        async run({ writersQuiescent, names, state }) {
            need(writersQuiescent === true, 'cleanup-not-quiescent');
            const result = { repository: 'absent', server: 'absent', files: 'absent', marker: 'absent' };
            if (state.registered) {
                const url = sourceEntry(names.repoName);
                if (url !== undefined) {
                    need(url === fixture.agentUrl, 'cleanup-repository-not-owned');          // a same-name replacement never becomes owned
                    const run = await cache.cli('fixture-uninstall-repo', ['uninstall', 'repo', names.repoName]); need(run.code === 0, 'cleanup-uninstall-failed');
                    need(sourceEntry(names.repoName) === undefined, 'cleanup-repository-remains');
                    let remains = true; try { io.lstatSync(path.join(reposDir, names.repoName)); } catch (error) { if (error?.code === 'ENOENT') remains = false; else throw new AcceptanceError('cleanup-repository-unknown'); }
                    need(!remains, 'cleanup-repository-remains'); result.repository = 'uninstalled';
                }
                state.registered = false;
            }
            const owned = await fixture.cleanup({ writersQuiescent: true }); result.server = owned.server; result.files = owned.files;
            result.marker = markerFiles.remove(marker);
            return result;
        },
    });
}
