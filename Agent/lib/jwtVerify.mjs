// Verification primitives come from the one selected achillesAgentLib source,
// which is direct-mounted rather than installed.
import { importAgentLibFile } from './agentlibResolve.mjs';

const jwtVerify = await importAgentLibFile('jwt/jwtVerify.mjs');

export const verifyJws = jwtVerify.verifyJws;
export const verifyInvocationToken = jwtVerify.verifyInvocationToken;
export const createMemoryReplayCache = jwtVerify.createMemoryReplayCache;
export const canonicalJson = jwtVerify.canonicalJson;
export const bodyHashForRequest = jwtVerify.bodyHashForRequest;
export const MAX_TTL_SECONDS = jwtVerify.MAX_TTL_SECONDS;
export const DEFAULT_CLOCK_SKEW_SECONDS = jwtVerify.DEFAULT_CLOCK_SKEW_SECONDS;
