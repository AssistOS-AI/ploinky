# How should Ploinky config files look?

Ploinky agents are primarily controlled through `manifest.json`, `mcp-config.json`, and router policy state. These files must be valid JSON. They should express runtime intent, exposed capabilities, and access rules explicitly enough that a reviewer can understand the security posture without reading every tool implementation.

## How should `manifest.json` be written?

The manifest is the runtime contract. It should describe the image or runtime command, readiness behavior, dependency agents, service exposure, optional agent-card metadata, optional chat completions behavior, profiles, environment behavior, ports, and resource requests. The manifest should not contain raw master keys, raw agent secrets, raw user session tokens, raw router request tokens, raw agent assertion tokens, or passwords.

A safe MCP-first manifest usually lets the bundled AgentServer own `/mcp` and makes readiness explicit.

```json
{
  "image": "node:20-alpine",
  "readiness": {
    "protocol": "mcp"
  },
  "env": {
    "NODE_ENV": "production"
  },
  "enable": [
    {
      "agent": "dpu/dpu-agent",
      "alias": "dpu",
      "profile": "default"
    }
  ],
  "httpServices": [
    {
      "slug": "explorer-api",
      "externalPrefix": "/services/explorer-api/",
      "internalPrefix": "/api/",
      "auth": "authenticated"
    }
  ],
  "endpoints": {
    "agent-card": {
      "name": "Explorer",
      "description": "Searches and reads workspace documents.",
      "tags": ["documents", "search"]
    },
    "chatCompletions": {
      "command": "node",
      "args": ["tools/chat-completions.mjs"],
      "supportsStream": false
    }
  },
  "runtime": {
    "resources": {
      "memory": "512Mi",
      "cpu": "0.5"
    }
  }
}
```

A custom runtime manifest should be more explicit because a custom command can replace bundled AgentServer assumptions. When a custom command is present, set `readiness.protocol` deliberately and verify that the expected endpoints still exist.

```json
{
  "image": "node:20-alpine",
  "start": "node server/custom-agent.mjs",
  "readiness": {
    "protocol": "tcp"
  },
  "ports": ["7000"],
  "env": {
    "NODE_ENV": "production"
  }
}
```

## How should `mcp-config.json` be written?

The MCP config defines tools, resources, and prompts. Tool names should be stable and unique inside the agent. Tool commands should be explicit. Tool input schemas should be narrow and should usually reject unknown input fields with `additionalProperties: false`. Tool tags should be omitted for authenticated-user tools, set to `internal` for agent-to-agent tools, or set to `admin` for user-admin tools. Do not combine `internal` and `admin`.

```json
{
  "tools": [
    {
      "name": "docs_search",
      "title": "Search documents",
      "description": "Search workspace documents visible to the authenticated user.",
      "command": "node",
      "args": ["tools/docs-search.mjs"],
      "cwd": "/code",
      "timeoutMs": 60000,
      "inputSchema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "string",
            "minLength": 1
          },
          "limit": {
            "type": "integer",
            "minimum": 1,
            "maximum": 20
          }
        },
        "required": ["query"],
        "additionalProperties": false
      }
    },
    {
      "name": "index_refresh_internal",
      "title": "Refresh search index",
      "description": "Internal agent-to-agent index refresh. Users and admins should not call this tool.",
      "command": "node",
      "args": ["tools/index-refresh.mjs"],
      "cwd": "/code",
      "timeoutMs": 300000,
      "inputSchema": {
        "type": "object",
        "properties": {
          "scope": {
            "type": "string",
            "enum": ["changed", "full"]
          }
        },
        "required": ["scope"],
        "additionalProperties": false
      },
      "tags": ["internal"],
      "async": true
    },
    {
      "name": "agent_policy_get",
      "title": "Get agent policy metadata",
      "description": "Returns administrative policy metadata for this agent.",
      "command": "node",
      "args": ["tools/policy-get.mjs"],
      "cwd": "/code",
      "timeoutMs": 30000,
      "inputSchema": {
        "type": "object",
        "properties": {},
        "additionalProperties": false
      },
      "tags": ["admin"]
    }
  ],
  "resources": [
    {
      "name": "agent_status",
      "title": "Agent status",
      "uri": "ploinky://agent/status",
      "command": "node",
      "args": ["tools/status-resource.mjs"],
      "cwd": "/code"
    }
  ],
  "prompts": [
    {
      "name": "search-docs",
      "description": "Prompt for using docs_search safely.",
      "arguments": [
        {
          "name": "query",
          "required": true
        }
      ],
      "messages": [
        {
          "role": "user",
          "content": {
            "type": "text",
            "text": "Search for: {{query}}"
          }
        }
      ]
    }
  ]
}
```

## How should tool tags be interpreted?

A missing `tags` field or an empty `tags` array means the tool defaults to `authenticated`. The tool is intended for authenticated users when router policy permits it. A tag array containing `internal` means the tool is intended for authenticated Ploinky agents through the router-mediated internal MCP flow. A tag array containing `admin` means the tool is intended for authenticated users with the admin role. A tag array containing both `internal` and `admin` is invalid because it blurs user-admin access and agent-internal access.

The tags in `mcp-config.json` are default policy hints. They are not the permanent source of truth after a persisted policy entry exists. If router policy state already contains an entry for the same `agent + tool`, the persisted entry wins.

## How should router policy state look?

Router policy state uses a `router-policy` schema. `httpRoutes` controls guest readonly HTTP access by normalized path. `mcpTools` controls MCP access by `agent + tool`. Missing MCP policy means deny.

```json
{
  "schema": "router-policy",
  "httpRoutes": [
    {
      "path": "/explorer/public-view/folder/*",
      "enabled": true,
      "createdAt": "2026-06-03T10:00:00.000Z",
      "createdBy": "user:admin-user-id",
      "updatedAt": "2026-06-03T10:00:00.000Z",
      "updatedBy": "user:admin-user-id"
    }
  ],
  "mcpTools": [
    {
      "agent": "explorer",
      "tool": "docs_search",
      "access": "authenticated",
      "source": "mcp-config",
      "enabled": true,
      "createdAt": "2026-06-03T10:00:00.000Z",
      "createdBy": "router:boot",
      "updatedAt": "2026-06-03T10:00:00.000Z",
      "updatedBy": "router:boot"
    },
    {
      "agent": "explorer",
      "tool": "index_refresh_internal",
      "access": "internal",
      "source": "admin",
      "enabled": true,
      "createdAt": "2026-06-03T10:00:00.000Z",
      "createdBy": "router:boot",
      "updatedAt": "2026-06-03T10:15:00.000Z",
      "updatedBy": "user:admin-user-id"
    }
  ]
}
```

Policy writes should be atomic. The router should write a temporary file, rename it over the active file, and rebuild in-memory indexes. If the file is corrupt or fails validation, the router should not silently overwrite it and should fail closed until the state is repaired.

The audit log should be JSONL append-only. It should log identifiers and decisions, not raw secrets or complete tokens.

```jsonl
{"ts":"2026-06-03T10:00:00.000Z","user":"user:admin-user-id","command":"mcp.policy.set","agent":"explorer","tool":"index_refresh_internal","ok":true}
```

## How should HTTP service declarations be written?

`httpServices` is for protected or authenticated service routes. It defaults to protected auth and public path prefix `/services/<slug>/`. Use it when the router should authenticate the caller and intentionally inject router auth context into the upstream agent request.

```json
{
  "httpServices": [
    {
      "slug": "explorer-api",
      "externalPrefix": "/services/explorer-api/",
      "internalPrefix": "/api/",
      "auth": "authenticated",
      "includeAuthInfo": true
    }
  ]
}
```

`publicServices` is for anonymous service routes. It defaults to public path prefix `/public-services/<slug>/`. Use it only when anonymous exposure is safe. Prefer `includeAuthInfo: false` unless the anonymous auth context is intentionally needed.

```json
{
  "publicServices": [
    {
      "slug": "public-docs",
      "externalPrefix": "/public-services/public-docs/",
      "internalPrefix": "/public-view/",
      "auth": "anonymous",
      "includeAuthInfo": false
    }
  ]
}
```

## How should HTTP whitelist paths be written?

A whitelist path must start with `/`, must be normalized, and must not include URL schemes, fragments, backslashes, null bytes, double slashes, encoded slashes, encoded backslashes, or path traversal. Query strings do not participate in the whitelist decision. A wildcard may appear only at the end as `/*`.

These paths are valid examples.

```text
/explorer/public-view/folder/*
/explorer/public-view/stuff/sdocid124324
```

These paths are invalid examples.

```text
explorer/public-view/file.md
/explorer/public-view/../secret
/explorer/public-view/%2Fsecret
/explorer/*/file
/explorer/public-view/folder/**
/explorer/public-view/folder/*/edit
```

Internal routes must not be whitelisted at write time or at match time. This rule prevents a corrupted policy file from accidentally opening a private route.

```text
/whitelist/command
/auth/*
/admin/*
/__agent/*
/<agent>/__agent/*
/metrics
/health/internal
```

## Which config patterns are dangerous?

A manifest is dangerous when it hardcodes a master key, user session token, agent assertion token, router request token, password, or agent secret. A manifest is also risky when it uses `guest: true`, `publicServices`, or a custom startup command without clear readiness and exposure semantics.

```json
{
  "env": {
    "PLOINKY_MASTER_KEY": "do-not-put-this-here",
    "PLOINKY_AGENT_SECRET": "do-not-put-this-here"
  },
  "guest": true
}
```

An MCP config is dangerous when a tool combines `internal` and `admin`, uses unknown tags, has an overly broad schema, lacks a command, or hides privileged behavior behind an authenticated or chat-completions surface.

```json
{
  "tools": [
    {
      "name": "dangerous_policy_mutation",
      "command": "node",
      "args": ["tools/mutate-policy.mjs"],
      "inputSchema": {
        "type": "object"
      },
      "tags": ["internal", "admin"]
    }
  ]
}
```

A policy state is dangerous when it silently grants access to tools that have no deliberate policy, marks internal tools as admin for convenience, allows agents to call admin tools, or whitelists internal routes.
