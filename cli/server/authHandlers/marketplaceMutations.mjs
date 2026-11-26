// The Marketplace mutations that exist, and what each is while the captured
// PROD is true. The table is the single source of the handler's action lists:
// a request to `repos` or `agents` is checked against it right after the one
// body parse, and any other resource is checked by method and resource at the
// top of the handler. `cache` and `hardware-limits` keep their own body
// handling; they only have to be listed.
//
// Dispositions: `allowed` behaves as without PROD; `disabled` answers 403
// `disabled_in_production`. Repository operations (install, remove,
// install_repo, uninstall_repo) change which code a production workspace can
// run, so they are disabled; enabling and disabling an agent stay allowed. The
// restart and reinstall actions are added to `agents` as `disabled` by the
// feature that builds them, which must also use the `canRestart` and
// `canReinstall` permission fields.

export const MARKETPLACE_MUTATIONS = Object.freeze({
    repos: Object.freeze({
        install: 'disabled',
        remove: 'disabled',
        install_repo: 'disabled',
        uninstall_repo: 'disabled',
    }),
    agents: Object.freeze({
        enable_agent: 'allowed',
        disable_agent: 'allowed',
    }),
    cache: 'allowed',
    'hardware-limits': 'allowed',
});

// The actions a resource accepts at all, from the table keys.
export function marketplaceActions(resource) {
    const entry = MARKETPLACE_MUTATIONS[resource];
    return entry && typeof entry === 'object' ? Object.keys(entry) : [];
}

// Handler top, method and resource only: an unlisted resource is refused.
export function isProdAllowedResource(resource) {
    return typeof resource === 'string' && Object.hasOwn(MARKETPLACE_MUTATIONS, resource);
}

// After the single body parse, `repos` and `agents` only.
export function isProdAllowedAction(resource, action) {
    const entry = Object.hasOwn(MARKETPLACE_MUTATIONS, resource) ? MARKETPLACE_MUTATIONS[resource] : null;
    return Boolean(entry) && typeof entry === 'object'
        && typeof action === 'string' && Object.hasOwn(entry, action)
        && entry[action] === 'allowed';
}
