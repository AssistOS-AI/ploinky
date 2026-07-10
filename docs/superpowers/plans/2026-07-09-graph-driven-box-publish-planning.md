# Graph-Driven Box Publish Planning Implementation Plan

Date: 2026-07-09
Status: implemented

## Goal

Replace the Explorer hardcoded outer publish list in `ploinky/container/ploinky-box.mjs` with graph-derived publishes from enabled agents' active-profile `openPorts`.

`openPorts` is the only manifest field for default boxed public publishing. A port listed there is exposed inside the Ploinky box and crosses the outer box boundary by default. Internal services must stay out of `openPorts`.

## Implementation Steps

1. Add `ploinky/container/box-publish-planner.mjs`.
   - Resolve the public Explorer graph from manifests.
   - Traverse enabled child agents recursively.
   - Apply active-profile overrides.
   - Collect active-profile `openPorts` entries.
   - Normalize publish specs to outer-box publishes using the box-side host port.
   - Reject malformed specs, host port `0`, out-of-range ports, bad ranges, and protocol conflicts.

2. Update `ploinky/container/ploinky-box.mjs`.
   - Remove the Explorer hardcoded publish constant.
   - Invoke the planner for public `start explorer`.
   - Preserve explicit user `--publish` flags.
   - Suppress duplicate derived publishes and fail on conflicting same-port/protocol publishes.
   - Validate explicit publishes before building the container command.

3. Update runtime networking.
   - Keep manifest-declared named networks as named networks inside the Ploinky box.
   - Preserve network aliases so service-to-service HTTP/WebSocket traffic can stay private.
   - Run the outer box with the privilege required for nested Podman named networks.

4. Update manifests.
   - `basic/web-publishing` keeps only `8081` in `openPorts` and joins the private `webmeet` network.
   - `AssistOSExplorer/onlyOffice` declares no `openPorts` and joins the private `webmeet` network as `onlyoffice`.
   - `webmeetInfra/liveKitServerAgent` keeps only media/TURN boundary ports in the default profile.
   - `basic/webtty` and `AssistOSExplorer/webmeetStt` declare no default box-boundary ports.

5. Update Web Publishing routes.
   - Keep router upstream on `host.containers.internal:8080`.
   - Use `http://onlyoffice:8080` for the OnlyOffice editor proxy.
   - Use `http://livekitserveragent:7880` for LiveKit signaling.
   - Continue rejecting raw AgentServer/MCP port `7000` and arbitrary upstream hosts.

6. Update tests.
   - Add planner unit coverage for graph traversal, profile replacement, duplicate suppression, conflict rejection, and invalid publish parsing.
   - Update wrapper dry-run tests for the derived Explorer publish set.
   - Update manifest tests for Web Publishing, WebTTY, OnlyOffice, WebMeet STT, and LiveKit.
   - Update Web Publishing route/nginx tests for private upstreams.
   - Update runtime network tests so boxed Podman named networks keep aliases.

7. Update docs.
   - Document that `openPorts` is the default box-boundary contract.
   - Document that Web Publishing owns the HTTP/WebSocket entrypoint.
   - Document that OnlyOffice and LiveKit signaling are private upstreams behind Web Publishing.
   - Remove stale direct-port statements for OnlyOffice, LiveKit signaling, WebTTY, Redis, and WebMeet STT.

8. Verify.
   - Run focused Node unit tests for the planner, wrapper, runtime networking, manifest invariants, and Web Publishing routes.
   - Validate edited manifests with `python3 -m json.tool`.
   - Run a real wrapper dry-run for public `start explorer` and confirm only Web Publishing `8081` plus LiveKit/TURN media ports appear.
   - Start a clean boxed Explorer stack and smoke Web Publishing, OnlyOffice, and WebMeet paths.
