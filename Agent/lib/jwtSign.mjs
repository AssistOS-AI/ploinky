// Signing primitives from the one selected achillesAgentLib source, which is
// direct-mounted rather than installed.
//
// The exports stay synchronous because the Router security path calls them
// synchronously; top-level await resolves them once at module load. Callers
// therefore need the AgentLib runtime contract established before importing
// this module, which the CLI bootstrap and the agent runtime both do.
import { importAgentLibFile } from './agentlibResolve.mjs';

const jwtSign = await importAgentLibFile('jwt/jwtSign.mjs');

export const signHmacJwt = jwtSign.signHmacJwt;
export const bodyHashForRequest = jwtSign.bodyHashForRequest;
export const canonicalJson = jwtSign.canonicalJson;
