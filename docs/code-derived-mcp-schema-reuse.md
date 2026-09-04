# MCP input-schema reuse

This note describes executable behavior in `Agent/server/AgentServer.mjs`,
`Agent/server/toolInputSchemaCache.mjs`, and their unit tests.

## Lifetime and ownership

AgentServer loads its MCP configuration once and creates a fresh MCP server,
transport and tool callback for every initialized session. Tool callbacks still
verify the Router Request signature, audience, method, path, tool, argument hash
and replay identifier on every invocation before dispatching the agent command.
Caller identity and downstream agent authorization are not cached.

The configuration/tool-object pair now owns one compiled input schema, including
the empty fallback for a tool without an input schema. The cache is weakly keyed
by configuration identity. Its entries are limited to the exact tool objects in
that configuration when first used; a client-provided tool name, actor or argument
cannot add cache entries. Distinct configurations and tool objects never share a
cache entry, even when their names match.

Only configuration-derived schema data is shared. The JSON input specification
is copied and deeply frozen before compilation. Standard JSON Schema listings
use that same immutable snapshot so refinements and listings cannot diverge.
The descriptor is frozen, while the private Zod graph remains writable for the
SDK's internal shape memoization. Validation results and errors are local to
each parse, not retained in the cache.

There is no configuration hot reload: change the configuration through the
normal agent lifecycle. A new configuration identity has a separate cache.
There is no timer, client-controlled cache key, cross-process shared cache or
session/token reuse.

## Preserved schema behavior

Legacy field-map schemas use the existing compiler without semantic changes.
Optional/nullable fields, nested objects, enums and array constraints retain
their prior behavior. Unknown legacy object properties are stripped unless a
nested object explicitly permits them. Legacy `default` metadata does not
insert a value.

Standard JSON Schema uses the existing strict supported-keyword compiler.
Required fields, enum refinements, integer and string constraints, nested
properties and boolean `additionalProperties` retain their prior behavior.
Unsupported standard keywords, including `default`, still fail initialization
closed. An invalid schema is never replaced with an empty or permissive schema.
Missing input schemas keep the previous empty-object validation behavior.

## Verification and measurement

`tests/unit/toolInputSchemaCache.test.mjs` checks object reuse, bounded declared
keys, distinct configuration/tool identities, cold/warm validation equivalence,
immutable snapshots, concurrent independent parses and repeated invalid input.
`tests/unit/agentServerSessionLifecycle.test.mjs` exercises fresh real MCP
sessions, overlapping calls from different actors, actor changes within a
session, signed validation failures, missing authorization, tampering and
cross-session replay rejection.

Run the relevant tests with the repository's explicit AgentLib preload:

```sh
node --import ./tests/helpers/agentlibTestContract.mjs --test tests/unit/toolInputSchemaCache.test.mjs tests/unit/agentInputSchema.test.mjs tests/unit/agentServerSessionLifecycle.test.mjs tests/unit/invocationAuth.test.mjs tests/unit/invocationAuthInfo.test.mjs tests/unit/mcpToolArguments.test.mjs tests/unit/mcpToolPolicy.test.mjs
```

The bounded synthetic benchmark compares cold compilation with warm lookup
through the same production helper:

```sh
node --expose-gc tests/benchmarks/toolInputSchemaCache.mjs 200
```

It uses 40 mixed standard/legacy tools, reports elapsed time and sampled total
allocation bytes (including collected allocations), and asserts 8,000 distinct
schemas for cold configurations versus 40 for one reused configuration.
Timings and allocation samples are observations, not test thresholds. Cold
measurements include snapshot copying/freezing introduced by the cache. This
benchmark isolates schema construction; it does not measure full MCP request
latency, steady-state RSS, authorization cost or prove the cause of HTTP 503s.
