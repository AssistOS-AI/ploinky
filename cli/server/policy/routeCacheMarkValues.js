// The values a manifest route may carry in `cache`. This file has no imports on purpose:
// deployment gates load it from an installed runtime, with plain Node and no AgentLib, to
// ask whether that runtime understands a manifest's cache marks before handing it one.

// The classes a response can be cached under.
export function isRouteCacheClass(value) {
    return value === 'page' || value === 'immutable';
}

// Every value a manifest may carry in `cache`. `never` forbids caching a route.
export function isRouteCacheMark(value) {
    return isRouteCacheClass(value) || value === 'never';
}
