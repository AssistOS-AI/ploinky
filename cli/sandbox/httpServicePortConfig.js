const SERVICE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function own(value, key) {
    return Boolean(value && Object.prototype.hasOwnProperty.call(value, key));
}

function manifestContractError(message) {
    const error = new Error(message);
    error.code = 'PLOINKY_MANIFEST_HTTP_SERVICE_INVALID';
    return error;
}

const REMOVED_EXTRA_SERVICE_PORT_FIELD = ['additional', 'ServerPort'].join('');

function assertRemovedExtraServicePortAbsent(value, label) {
    if (own(value, REMOVED_EXTRA_SERVICE_PORT_FIELD)) {
        throw manifestContractError(`${label}.${REMOVED_EXTRA_SERVICE_PORT_FIELD} was removed; use httpServices[].port`);
    }
}

function normalizeHttpServiceSlug(value, label, { required = false } = {}) {
    if (value === undefined) {
        if (!required) return '';
        throw manifestContractError(`${label} is required and must match ${SERVICE_SLUG_PATTERN}`);
    }
    if (typeof value !== 'string' || value !== value.trim() || !SERVICE_SLUG_PATTERN.test(value)) {
        throw manifestContractError(`${label} must be an exact lower-case service slug matching ${SERVICE_SLUG_PATTERN}`);
    }
    return value;
}

function serviceSlug(spec, label, { required = false } = {}) {
    const hasSlug = own(spec, 'slug');
    const hasName = own(spec, 'name');
    const slug = hasSlug
        ? normalizeHttpServiceSlug(spec.slug, `${label}.slug`)
        : (hasName ? normalizeHttpServiceSlug(spec.name, `${label}.name`) : '');
    if (hasSlug && hasName) {
        const name = normalizeHttpServiceSlug(spec.name, `${label}.name`);
        if (slug !== name) {
            throw manifestContractError(`${label}.slug and ${label}.name must select the same service`);
        }
    }
    if (required && !slug) {
        throw manifestContractError(`${label}.slug is required for named service selection`);
    }
    return slug;
}

function normalizeHttpServicePort(value, label = 'httpServices[].port') {
    if (value === undefined) return null;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 65535) {
        throw manifestContractError(`${label} must be a JSON integer TCP port in 1..65535`);
    }
    return value;
}

function collectHttpServiceEntries(manifest = {}, { label = 'manifest' } = {}) {
    const raw = manifest?.httpServices;
    if (raw === undefined || raw === null) return [];
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'object') {
        return Object.entries(raw).map(([slug, value]) => (
            value && typeof value === 'object' && !Array.isArray(value)
                ? { slug, ...value }
                : { slug, internalPrefix: value }
        ));
    }
    throw manifestContractError(`${label}.httpServices must be an array or object`);
}

function validateHttpServiceEntries(manifest, { label = 'manifest' } = {}) {
    const entries = collectHttpServiceEntries(manifest, { label });
    for (const [index, service] of entries.entries()) {
        const serviceLabel = `${label}.httpServices[${index}]`;
        if (!service || typeof service !== 'object' || Array.isArray(service)) {
            throw manifestContractError(`${serviceLabel} must be an object`);
        }
        serviceSlug(service, serviceLabel);
        normalizeHttpServicePort(service.port, `${serviceLabel}.port`);
    }
    return entries;
}

function validateManifestHttpServices(manifest = {}, { label = 'manifest' } = {}) {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        throw manifestContractError(`${label} must be an object`);
    }
    assertRemovedExtraServicePortAbsent(manifest, label);
    validateHttpServiceEntries(manifest, { label });

    if (manifest.profiles !== undefined) {
        if (!manifest.profiles || typeof manifest.profiles !== 'object' || Array.isArray(manifest.profiles)) {
            throw manifestContractError(`${label}.profiles must be an object`);
        }
        for (const [profileName, profile] of Object.entries(manifest.profiles)) {
            const profileLabel = `${label}.profiles.${profileName}`;
            if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
                throw manifestContractError(`${profileLabel} must be an object`);
            }
            assertRemovedExtraServicePortAbsent(profile, profileLabel);
            validateHttpServiceEntries(profile, { label: profileLabel });
        }
    }
    return manifest;
}

function explicitHttpServicePorts(manifest = {}, options = {}) {
    validateManifestHttpServices(manifest, options);
    const label = options.label || 'manifest';
    const ports = new Set();
    for (const [index, service] of collectHttpServiceEntries(manifest, { label }).entries()) {
        const port = normalizeHttpServicePort(service.port, `${label}.httpServices[${index}].port`);
        if (port !== null) ports.add(port);
    }
    return [...ports].sort((left, right) => left - right);
}

function resolveHostHttpServiceTargets(manifest = {}, options = {}) {
    return Object.fromEntries(explicitHttpServicePorts(manifest, options).map((port) => [String(port), port]));
}

export {
    SERVICE_SLUG_PATTERN,
    collectHttpServiceEntries,
    explicitHttpServicePorts,
    normalizeHttpServicePort,
    normalizeHttpServiceSlug,
    resolveHostHttpServiceTargets,
    serviceSlug,
    validateManifestHttpServices,
};
