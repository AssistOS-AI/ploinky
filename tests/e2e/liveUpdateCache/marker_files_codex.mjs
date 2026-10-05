import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { AcceptanceError, need } from './manifest_codex.mjs';

// The runner's storage observer for the owned application marker. The marker lives in the selected workspace, which is
// the same directory the Box mounts at the same path; reads are bounded, no-follow and identity-checked, and the
// guarded removal refuses anything that is not exactly the file this run created.
const MARKER_BYTES = 4096;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function createMarkerFiles({ manifest, io = fs }) {
    need(manifest, 'marker-files-adapters'); const retained = []; let created = null;
    const absent = error => error?.code === 'ENOENT';
    function read(marker) {
        let fd; try { fd = io.openSync(marker.workspacePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch (error) { if (absent(error)) return { exists: false }; throw new AcceptanceError('marker-unreadable'); }
        try {
            const stat = io.fstatSync(fd); need(stat.isFile() && stat.size <= MARKER_BYTES, 'marker-shape');
            const buffer = Buffer.alloc(MARKER_BYTES + 1); let offset = 0;
            for (;;) { const count = io.readSync(fd, buffer, offset, buffer.length - offset, null); if (!count) break; offset += count; need(offset <= MARKER_BYTES, 'marker-shape'); }
            const bytes = buffer.subarray(0, offset), after = io.fstatSync(fd); need(after.size === offset && after.ino === stat.ino && after.dev === stat.dev, 'marker-changed');
            return { exists: true, boxId: manifest.box.id, path: marker.workspacePath, bytes: offset, sha256: hash(bytes), regular: stat.isFile(), links: stat.nlink, identity: { dev: stat.dev, ino: stat.ino, uid: stat.uid } };
        } finally { io.closeSync(fd); }
    }
    return Object.freeze({
        readMarker: async marker => read(marker),
        retainMarker: row => { retained.push(row); if (row.identity) created = row; },
        retained: () => retained.map(row => ({ ...row, bytes: Buffer.isBuffer(row.bytes) ? row.bytes.length : row.bytes })),
        // Exactly the created file: the retained identity, size and hash must all still match.
        remove(marker) {
            need(created && created.workspacePath === marker.workspacePath, 'marker-not-owned');
            const current = read(marker); if (!current.exists) return 'absent';
            need(current.regular && current.links === 1 && current.identity.dev === created.identity.dev && current.identity.ino === created.identity.ino
                && current.bytes === created.bytes && current.sha256 === marker.sha256, 'marker-ownership-changed');
            io.unlinkSync(marker.workspacePath); need(!read(marker).exists, 'marker-remove-unproven'); return 'removed';
        },
    });
}
