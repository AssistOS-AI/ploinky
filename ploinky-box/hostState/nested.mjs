import fs from 'node:fs';
import path from 'node:path';

import { BOX_LABELS, BOX_ROLES } from '../constants.mjs';
import { PloinkyBoxError } from '../errors.mjs';
import { workspacePathHash } from '../identity.mjs';
import { realpathOfNearestExisting, strictlyInside } from './paths.mjs';

// Nested workspaces (plan D7, D-C). A Box's mask covers only its own
// `.ploinky-box`, so an outer Box can write the host state of any workspace
// inside its own, and an inner Box's writable data can reach an outer one.
// Evidence comes from the engine only: a `role=box` container whose workspace
// bind is a strict ancestor or a strict descendant of this root. A bare
// `.ploinky-box` skeleton never counts.

const DIAGNOSE_FIXTURE_PREFIX = '.ploinky-diagnose-';

/**
 * The workspace-bind source of a Box container: among its read-write binds
 * whose destination equals its source (the workspace, and the checkout's
 * parent directories bound onto themselves), the one that contains all the
 * others. Null when there is none or no single one does.
 */
export function boxWorkspaceBindSource(container) {
    if (String(container?.labels?.[BOX_LABELS.role] || '') !== BOX_ROLES.container) return null;
    const binds = (container.mounts || []).filter((mount) => mount.rw === true
        && (mount.type === 'bind' || mount.type === '')
        && mount.source && mount.source === mount.destination);
    const roots = binds.filter((candidate) => binds.every((other) => other === candidate
        || strictlyInside(candidate.source, other.source)));
    return roots.length === 1 ? roots[0].source : null;
}

/** Every Box container of the view with its workspace-bind source, resolved. */
export function boxWorkspaceRoots(view, { fsApi = fs } = {}) {
    const roots = [];
    for (const container of view || []) {
        const source = boxWorkspaceBindSource(container);
        if (!source || !path.isAbsolute(source)) continue;
        let real;
        try {
            real = realpathOfNearestExisting(source, fsApi);
        } catch (_) {
            real = path.resolve(source);
        }
        roots.push(Object.freeze({ container, source, real }));
    }
    return roots;
}

// The `ploinky diagnose` fixture Box of this workspace binds
// `W/.ploinky-diagnose-*/workspace`; it carries its own path-hash.
function isOwnDiagnoseFixture(workspaceReal, root) {
    const relative = path.relative(workspaceReal, root.real);
    const [first] = relative.split(path.sep);
    return strictlyInside(workspaceReal, root.real)
        && first.startsWith(DIAGNOSE_FIXTURE_PREFIX)
        && String(root.container.labels?.[BOX_LABELS.pathHash] || '') === workspacePathHash(root.source);
}

/**
 * Refuses with PLOINKY_BOX_NESTED_WORKSPACE when another Box's workspace is a
 * strict ancestor or a strict descendant of this one. Read-only.
 */
export function assertNotNestedWorkspace(identity, view, { fsApi = fs } = {}) {
    const workspaceReal = realpathOfNearestExisting(identity.workspaceRoot, fsApi);
    for (const root of boxWorkspaceRoots(view, { fsApi })) {
        if (root.real === workspaceReal) continue;
        const outer = strictlyInside(root.real, workspaceReal);
        const inner = strictlyInside(workspaceReal, root.real);
        if (!outer && !inner) continue;
        if (inner && isOwnDiagnoseFixture(workspaceReal, root)) continue;
        const relation = outer ? 'contains this workspace' : 'lies inside this workspace';
        throw new PloinkyBoxError(
            `The Box workspace ${root.source} (container ${root.container.name || root.container.id}) ${relation} `
            + `${identity.workspaceRoot}. Nested Box workspaces are not supported: a Box can write the host state `
            + 'of any workspace inside its own. Stop and destroy one of the two Boxes '
            + '(`ploinky stop` then `ploinky destroy` in that workspace), or use workspaces that do not contain each other.',
            { code: 'PLOINKY_BOX_NESTED_WORKSPACE' },
        );
    }
}
