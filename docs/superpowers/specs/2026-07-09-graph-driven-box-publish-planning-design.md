# Graph-Driven Box Publish Planning Design

Date: 2026-07-09
Status: implemented

## Summary

Boxed Explorer starts no longer carry an Explorer-specific publish list in `ploinky/container/ploinky-box.mjs`. The wrapper derives outer `-p` flags from the enabled Explorer dependency graph and each enabled agent's active-profile `openPorts` entries.

`openPorts` has one meaning for boxed public starts: a profile entry exposes that port inside the Ploinky box and the outer box publishes the same box-side port to the real host. Internal-only services must stay out of `openPorts` and use router-mediated routes, service networking, or explicit operator publishes.

## Runtime Boundary

The planner lives on the host side in `ploinky/container/box-publish-planner.mjs`. It resolves the Explorer start graph from manifests, follows enabled child agents recursively, applies profile overrides, and reads only active-profile `openPorts`.

The wrapper preserves explicit user `--publish` flags. Derived publishes are appended only when they do not duplicate or conflict with an explicit publish target. A duplicate target with the same protocol is suppressed; a conflicting publish for the same host-side port/protocol fails early with a clear error.

The planner rejects malformed specs, host port `0`, ranges outside `1..65535`, mismatched host/container range lengths, and protocol collisions. It keeps TCP as the default protocol and preserves UDP when declared.

The outer box runs with enough privilege for nested Podman to create and attach named networks. Without named networks, service aliases collapse back to isolated slirp networking and Web Publishing has no private path to OnlyOffice or LiveKit signaling.

## Explorer Default Shape

The default Explorer graph publishes:

- Web Publishing nginx: `127.0.0.1:8081:8081`
- LiveKit/TURN media plane: `127.0.0.1:7881:7881`, `127.0.0.1:3478:3478/tcp`, `127.0.0.1:3478:3478/udp`, `127.0.0.1:7882-7892:7882-7892/udp`, `127.0.0.1:20000-20010:20000-20010/udp`

The default graph does not publish WebTTY, OnlyOffice editor ports, LiveKit signaling, LiveKit health, Redis, WebMeet STT, WebMeet agent control, or raw AgentServer/MCP surfaces.

## Web Publishing

Web Publishing remains the HTTP/WebSocket consolidation layer. Its `8081` `openPorts` entry is the single default HTTP/WebSocket box-boundary entrypoint. Web Publishing joins the private `webmeet` service network and proxies managed upstreams internally:

- router: `http://host.containers.internal:8080`
- OnlyOffice editor proxy: `http://onlyoffice:8080`
- LiveKit signaling: `http://livekitserveragent:7880`

LiveKit/TURN UDP media ports cannot be proxied by nginx and remain explicit media-plane `openPorts` entries on `liveKitServerAgent`.

## Manifest Rules

Agents must put only intended box-boundary ports in profile `openPorts`. Internal-only surfaces such as Redis, health endpoints, storage listeners, raw MCP/application ports, and router-mediated HTTP services must not appear there.

OnlyOffice exposes its editor proxy to Web Publishing through the private service network, not through `openPorts`. WebMeet STT is also private service-network traffic and does not declare direct ports.

## Verification Contract

Focused verification should cover:

- planner graph traversal and profile override behavior
- duplicate and conflict suppression with explicit `--publish`
- invalid publish parsing and range validation
- wrapper dry-run output for public `start explorer`
- manifest tests proving default OnlyOffice/WebMeet STT internals stay out of `openPorts`
- Web Publishing route tests proving OnlyOffice and LiveKit signaling use private upstreams
- an Explorer stack smoke that reaches the router, Web Publishing nginx, OnlyOffice, and WebMeet paths without publishing stale direct HTTP/WebSocket ports
