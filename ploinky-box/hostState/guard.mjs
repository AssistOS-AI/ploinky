import fs from 'node:fs';

import { INCOMPATIBLE_BOX_GUIDANCE } from '../constants.mjs';
import { assertCheckoutPlacement } from '../contract/checkoutAlias.mjs';
import { discoverEngineView } from '../engine/discovery.mjs';
import { PloinkyBoxError } from '../errors.mjs';
import { createLockLiveness } from '../lockLiveness.mjs';
import {
    adoptWorkspaceHostState,
    quarantineHostStateEntries,
    readWorkspaceRecord,
    sweepStaleHostStaging,
} from './adoption.mjs';
import { assertNotNestedWorkspace } from './nested.mjs';
import { createQuiescenceGate } from './quiescence.mjs';
import { hostStateMaskMount } from './root.mjs';

// The host-state checks every locked Box transaction runs (plan D3, D6, D7,
// r3 trust), in the order the lock requires:
// - before the lock, which creates `.ploinky-box`: the workspace is not the
//   invoking checkout and does not lie inside it, and no Box workspace
//   contains this one or lies inside it;
// - under the lock: the nested check again, first-use adoption behind the
//   quiescence gate, and the sweep of stale host staging directories;
// - inside the Box reconciliation: the quiescence gate before any data path
//   or Box is created (`quiescence`).
// `configure` is the policy of every transaction that may write host state or
// create a Box. Stop and destroy use `restrict`: they write no record, never
// adopt, and keep working on a Box that a configuring command refuses.

export const HOST_STATE_POLICY = Object.freeze({ configure: 'configure', restrict: 'restrict' });

// An owned Box without the read-only host state mask was created by a Ploinky
// that kept host state elsewhere. It is never adopted: configuring commands get
// the contract's own destroy-and-recreate guidance before anything is written
// into `.ploinky-box`. Stop and destroy still work on it.
export function ownedBoxIsMasked(identity, container) {
    const mask = hostStateMaskMount(identity.workspaceRoot);
    const mounts = Array.isArray(container?.runtime?.mounts) ? container.runtime.mounts : [];
    return mounts.some((mount) => mount.destination === mask.destination && mount.source === mask.source && mount.rw === false);
}

// The residual an operator must handle by hand: an older Ploinky that
// destroyed the old Box itself leaves no evidence of it for this version.
export const UNMASKED_BOX_RESIDUAL = ' If an older Ploinky already destroyed that Box, remove the workspace\'s '
    + '.ploinky-box directory before the next start.';

function assertOwnedBoxMasked(identity, ownership) {
    const container = ownership?.handles?.container;
    if (!container || ownedBoxIsMasked(identity, container)) return;
    throw new PloinkyBoxError(`Owned Box mount set is incompatible${INCOMPATIBLE_BOX_GUIDANCE}.${UNMASKED_BOX_RESIDUAL}`, {
        code: 'PLOINKY_BOX_PUBLICATION_INCOMPATIBLE',
    });
}

function assertPolicy(policy) {
    if (!Object.values(HOST_STATE_POLICY).includes(policy)) {
        throw new TypeError(`Unknown host state policy ${String(policy)}`);
    }
    return policy;
}

export function createHostStateGuard({
    runner,
    platform = process.platform,
    repositoryRoot,
    allowHostProcesses = [],
    fsApi = fs,
    observeEngine = (engine) => discoverEngineView(engine, runner),
    gate = createQuiescenceGate({ platform, fsApi, allowHostProcesses }),
    liveness = createLockLiveness({ platform }),
    stderr = process.stderr,
} = {}) {
    function quiescence({ identity, engine, excludeContainerIds = [] }) {
        const view = observeEngine(engine);
        gate.assert(identity, { view, excludeContainerIds });
        return view;
    }

    function beforeLock(identity, { policy = HOST_STATE_POLICY.configure, engine = null } = {}) {
        if (assertPolicy(policy) === HOST_STATE_POLICY.restrict) return;
        assertCheckoutPlacement(identity.workspaceRoot, repositoryRoot, { fsApi });
        if (engine) assertNotNestedWorkspace(identity, observeEngine(engine), { fsApi });
    }

    function underLock(identity, lock, ownership, { policy = HOST_STATE_POLICY.configure } = {}) {
        if (assertPolicy(policy) === HOST_STATE_POLICY.restrict) {
            // Hygiene only: stop and destroy are recovery paths, so an
            // unreadable host state directory never blocks them.
            try {
                if (readWorkspaceRecord(identity, { fsApi }).state === 'valid') {
                    sweepStaleHostStaging(identity, lock, { fsApi, liveness });
                }
            } catch (_) {}
            return Object.freeze({ adopted: false, quarantine: null, moved: Object.freeze([]) });
        }
        assertOwnedBoxMasked(identity, ownership);
        const view = observeEngine(ownership.engine);
        assertNotNestedWorkspace(identity, view, { fsApi });
        const adoption = adoptWorkspaceHostState(identity, lock, {
            view,
            fsApi,
            assertQuiescent: () => gate.assert(identity, { view }),
        });
        if (adoption.quarantine) {
            stderr?.write?.(
                `[ploinky] Moved ${adoption.moved.length} entr${adoption.moved.length === 1 ? 'y' : 'ies'} that existed before `
                + `this workspace's host state was adopted (${adoption.moved.join(', ')}) into ${adoption.quarantine}. `
                + 'They are not used; inspect them and delete that directory when done. Re-apply any `ploinky bind`, '
                + '`ploinky gpu` or limits settings you still want.\n',
            );
        }
        sweepStaleHostStaging(identity, lock, { fsApi, liveness });
        return adoption;
    }

    // Stop and destroy of an owned Box without the mask (created by a Ploinky
    // that kept host state elsewhere): that Box could write `.ploinky-box`,
    // including a forged `workspace.json`. Once it no longer runs, and still
    // under the lock, everything but the skeleton is quarantined, so the next
    // configuring command adopts the workspace from scratch behind the gate.
    // A Box that still runs, or an engine that cannot be read, leaves the
    // directory as it is and is reported; a live bind source is never moved.
    function retireUnmaskedHostState(identity, lock, { container, observe, engine = null } = {}) {
        if (!container || ownedBoxIsMasked(identity, container)) return null;
        const report = (message) => stderr?.write?.(`[ploinky] ${message}\n`);
        let current;
        let view;
        try {
            const after = observe();
            current = after?.handles?.container || null;
            view = observeEngine(after?.engine || engine);
        } catch (error) {
            report(`The host state of this workspace was not quarantined: the engine could not be read (${error.message}). `
                + `Remove ${identity.hostStateRoot} by hand before the next start.`);
            return Object.freeze({ quarantined: false, reason: 'engine-unreadable' });
        }
        if (current?.runtime?.running === true) {
            report(`The host state of this workspace was not quarantined: the old Box ${current.id.slice(0, 12)} still runs. `
                + 'Stop it, then run `ploinky stop` again.');
            return Object.freeze({ quarantined: false, reason: 'box-running' });
        }
        const result = quarantineHostStateEntries(identity, lock, { view, fsApi, strict: false });
        if (result.quarantine || result.kept.length) {
            report(`The old Box could write ${identity.hostStateRoot}; its entries `
                + `(${result.moved.join(', ') || 'none'}) were moved to ${result.quarantine || 'nowhere'} and are not used.`
                + (result.kept.length ? ` Kept, because still in use: ${result.kept.join(', ')}.` : ''));
        }
        return Object.freeze({ quarantined: Boolean(result.quarantine), ...result });
    }

    return Object.freeze({ beforeLock, underLock, quiescence, retireUnmaskedHostState });
}
