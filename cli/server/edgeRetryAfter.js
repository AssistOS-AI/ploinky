// Seconds a client should wait before retrying a request refused while the
// edge generation is inactive or a drained agent awaits its replacement. Kept
// dependency-free so response writers can import it without the workspace
// configuration.
export const EDGE_DENIAL_RETRY_AFTER_SECONDS = 2;
