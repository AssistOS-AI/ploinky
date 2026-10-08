// The JSON-RPC error the Router's MCP proxy answers, with HTTP 200, for a
// request whose MCP session it does not hold: never initialized, expired, or
// lost when the Router restarted. A client that receives it must initialize a
// new session. Browser modules cannot import this file; they keep a copy that
// tests/unit/slashAutocomplete.test.mjs compares with it.
export const MCP_SESSION_INVALID_ERROR = Object.freeze({
    code: -32000,
    message: 'Missing or invalid MCP session',
});
