export const HTTP_ROUTE_ACCESS_VALUES = new Set(['public', 'guest', 'authenticated']);

const RANK = new Map([
    ['none', 0],
    ['public', 1],
    ['guest', 2],
    ['authenticated', 3],
    ['deny', 4],
]);

export function noHttpRouteAccess() {
    return { access: 'none', routeKey: '', source: '' };
}

export function normalizeHttpRouteAccess(value) {
    const access = String(value || '').trim().toLowerCase();
    return HTTP_ROUTE_ACCESS_VALUES.has(access) ? access : '';
}

export function moreRestrictiveHttpRouteDecision(left, right) {
    const leftRank = RANK.get(left?.access || 'none') || 0;
    const rightRank = RANK.get(right?.access || 'none') || 0;
    return rightRank > leftRank ? right : left;
}
