/**
 * PolicyStateStore — the persistence port (Strategy/Adapter seam, DS014) for the
 * router policy document (`policy-state.json`, schema `router-policy`).
 *
 * `PolicyStateRepository` owns ALL domain logic — schema validation, indexing, the
 * read cache, the `mutate` read-modify-write transaction, and the fail-closed
 * semantics — and delegates only the raw load/store of the opaque state document to
 * a concrete store. Swapping the filesystem for a database (or anything else) is a
 * new subclass, with no security-critical logic re-implemented.
 *
 * Contract (all three methods are synchronous):
 *
 *   currentVersion(): string | null
 *     A cheap probe of the persisted version. Returns an opaque, NON-EMPTY token, or
 *     `null` when nothing has been persisted yet (which the repository treats as a
 *     valid empty state). Two probes that return the same token MUST describe the
 *     same persisted bytes; a successful `write` MUST change the token. The token is
 *     used only as a cache key for the parsed+indexed state — it is never parsed.
 *
 *   read(): { found: boolean, document?: object }
 *     Returns the persisted document, already deserialized to a plain object, under
 *     `document` (with `found: true`). `found: false` means nothing is persisted yet.
 *     MUST THROW on an undecodable or corrupt payload so the repository can fail
 *     closed rather than serve a partial/garbage policy.
 *
 *   write(document): string
 *     Atomically replace the persisted document with `document` (a plain object) and
 *     return the new version token. "Atomically" means a concurrent reader observes
 *     either the previous document or the new one in full, never a partial write.
 */
export class PolicyStateStore {
    currentVersion() {
        throw new Error('PolicyStateStore.currentVersion() not implemented');
    }

    read() {
        throw new Error('PolicyStateStore.read() not implemented');
    }

    write(_document) {
        throw new Error('PolicyStateStore.write() not implemented');
    }
}

export default PolicyStateStore;
