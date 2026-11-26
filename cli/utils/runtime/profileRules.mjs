// The manifest profile rules shared by `ploinky profile check` and the
// standalone checker (`cli/tools/checkManifestProfiles.mjs`). Pure: no
// workspace, no filesystem.

export const ENVIRONMENT_PROFILES = Object.freeze(['default', 'dev', 'qa', 'prod']);

export function parseRequiredProfiles(value) {
    if (value === undefined || value === null) return [...ENVIRONMENT_PROFILES];
    const names = String(value).split(',').map((name) => name.trim().toLowerCase());
    if (!names.length || names.some((name) => !name)) {
        throw new Error('--require needs a comma-separated list of profile names.');
    }
    return [...new Set(names)];
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Returns the list of issues for one manifest text (empty list = pass). A
// manifest that does not parse, `profiles` that is not an object, and a
// required profile that is missing, null or not an object all fail.
export function checkManifestProfiles(manifest, required = ENVIRONMENT_PROFILES) {
    if (!isPlainObject(manifest)) return ['manifest is not a JSON object'];
    if (!isPlainObject(manifest.profiles)) return ["'profiles' is missing or not an object"];
    const issues = [];
    for (const name of required) {
        if (!Object.hasOwn(manifest.profiles, name)) issues.push(`profile '${name}' is missing`);
        else if (!isPlainObject(manifest.profiles[name])) issues.push(`profile '${name}' is not an object`);
    }
    return issues;
}

export function checkManifestText(text, required = ENVIRONMENT_PROFILES) {
    let manifest;
    try {
        manifest = JSON.parse(text);
    } catch (error) {
        return [`manifest is not valid JSON (${String(error?.message || error).slice(0, 120)})`];
    }
    return checkManifestProfiles(manifest, required);
}
