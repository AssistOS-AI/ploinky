# Mutable Runtime Image Hard-Cut Design

Date: 2026-07-11
Status: approved in conversation; awaiting written-spec review

## Summary

Ploinky will use one mutable multi-architecture runtime-image channel:
`docker.io/assistos/ploinky-box:runtime`. Creating a missing runtime or
replacing a current-contract runtime will always pull this reference. A pull
failure is fatal and never falls back to a cached image.

The replacement image contract fixes two defects in the published runtime:
the process account is selected as `podman` but `USER` is absent from the
environment, and the image inherits `/var/lib/containers` as an undeclared
anonymous runtime volume. The corrected image explicitly records the process
identity and environment while declaring no image volumes. The supervisor
remains the sole owner of the three persistent Ploinky volumes.

This is a hard cut. Contract-1 images and existing legacy containers are not
migrated, reconciled, or supported. An incompatible existing container blocks
ordinary commands with instructions to destroy it explicitly and create a new
runtime.

This specification supersedes the immutable runtime tag, contract-1 adoption,
and automatic legacy-runtime reconciliation decisions in
`2026-07-10-simplified-runtime-supervisor-cli-design.md`. Other decisions from
that design remain in force.

## Goals and Non-Goals

| Area | Decision |
| --- | --- |
| Default image | Use `docker.io/assistos/ploinky-box:runtime` |
| Publication model | Intentionally move one mutable multi-architecture tag |
| Image identity | Set both `Config.User=podman` and `USER=podman` |
| Persistent storage | Keep exactly the three supervisor-managed named volumes |
| Image-declared storage | Require an absent or logically empty `Config.Volumes` |
| Pull policy | Always pull the selected image reference before create or current-contract replacement |
| Pull failure | Block startup; never use a cached fallback |
| Existing compatible runtime | Start or reuse without registry traffic |
| Legacy runtime | Refuse ordinary reconciliation and require explicit destruction |
| Migration | Do not migrate containers, image references, or stored data |
| Backward compatibility | Do not accept contract 1 or retain legacy image aliases |
| Agent containers | Do not change their images, privileges, or storage model |

## Component Boundaries

| Component | Responsibility |
| --- | --- |
| `container-image-builds/images/ploinky-box/Dockerfile` | Assemble the Podman and Node filesystem, then produce clean final OCI image metadata |
| `container-image-builds/.github/workflows/publish-ploinky-box-image.yml` | Build and verify both architectures, then publish the mutable runtime manifest |
| `ploinky/container/runtime-contract.mjs` | Define contract 2, normalize image inspection, and validate the complete image contract |
| `ploinky/container/runtime-supervisor.mjs` | Apply the pull policy, reject legacy containers, manage current-contract reconciliation, and own resource cleanup |
| Supervisor test harness | Model pulls, image metadata, anonymous volumes, named volumes, and removal semantics for Docker and Podman |

The image repository owns filesystem and OCI-image correctness. Ploinky owns
runtime creation and persistent resources. Neither component compensates for a
known defect in the other.

## Clean Image Construction

The existing `quay.io/podman/stable` image remains the filesystem source, but
it cannot remain the final stage because a child Dockerfile cannot remove an
inherited `VOLUME`. The Dockerfile will therefore prepare the runtime in an
intermediate stage and copy that complete filesystem into a clean `FROM
scratch` final stage.

The final stage will explicitly restore every required piece of image
configuration rather than inheriting incidental base-image metadata:

| Configuration | Required value |
| --- | --- |
| Contract label | `io.assistos.ploinky.runtime-contract=2` |
| User | `podman` |
| Environment identity | `USER=podman`, `HOME=/home/podman` |
| Runtime environment | `PLOINKY_WORKSPACE_ROOT=/workspace` |
| Podman environment | `container=oci`, `_CONTAINERS_USERNS_CONFIGURED=`, `BUILDAH_ISOLATION=chroot` |
| Path | `/opt/ploinky/bin:/usr/local/bin:/usr/bin` |
| Working directory | `/workspace` |
| Entrypoint | `/usr/local/bin/ploinky-box-entrypoint` |
| Default command | None |
| Declared volumes | None |

The final filesystem still contains the Podman user and group, Node, npm, Git,
Podman, the Ploinky marker, prepared directories, and the entrypoint. Directory
ownership remains `podman:podman` where required. The Dockerfile does not add a
replacement `VOLUME` for rootless storage because the supervisor always mounts
that destination explicitly.

Reconstructing the final filesystem may lose incidental image history or
extended metadata. The release tests therefore treat user/group ownership,
setuid helpers, Podman information, and a nested container execution as
mandatory behavior rather than assuming the copy preserved them.

## Runtime Image Contract 2

The image label is necessary but not sufficient. Image validation must require
all of the following before a container is created or an existing
current-contract container is stopped:

| Field | Validation |
| --- | --- |
| Contract label | Equals `2` |
| `Config.User` | Equals `podman` |
| `Config.Env` | Contains the required `USER`, `HOME`, and workspace values |
| `Config.WorkingDir` | Equals `/workspace` |
| `Config.Entrypoint` | Equals the Ploinky box entrypoint |
| `Config.Volumes` | Absent, null, or empty |
| Image identifier | Resolves to a non-empty local image ID after pull |

The supervisor runs the validated local image ID, not the mutable tag string.
This prevents a local tag change between validation and container creation. The
requested reference remains available for configuration reporting, while the
container's inspected image ID provides the exact deployed identity.

Changing the contract label from 1 to 2 is an invalidation marker, not a
compatibility layer. Contract 1 is removed from the accepted set.

## Pull and Reconciliation Flow

| Observed state | Required behavior |
| --- | --- |
| No outer runtime | Pull `:runtime`, inspect and validate it, check creation preconditions, then create the runtime from the resolved image ID |
| Running compatible runtime with matching configuration | Validate health and reuse it without pulling |
| Stopped compatible runtime with matching configuration | Start and validate it without pulling |
| Compatible runtime with an intentional creation-configuration change | Pull and validate first, then use the existing transactional replacement path |
| Incompatible or contract-1 runtime | Return nonzero without pulling, stopping, renaming, or removing it; instruct the user to run `ploinky destroy` |

`pull` is unconditional on create and current-contract replacement even when a
local image already has the requested tag. The engine may reuse cached layers,
but registry availability and successful tag resolution are required. The
default selected reference is `:runtime`; an explicit custom image must also be
registry-pullable and satisfy contract 2. Local-only custom images are not a
supported startup path.

A pull or image-validation failure occurs before container or volume mutation.
For current-contract replacement, the existing runtime is not stopped until
the new image has been pulled and validated. If creation or health validation
then fails, the current transactional rollback restores the previous
current-contract container and preserves all named volumes. This rollback is
failure recovery within contract 2; it is not legacy migration.

Read-only `status`, explicit `stop`, and explicit `destroy` never pull or
upgrade an image. Status reports an incompatible legacy runtime as unsupported
and returns nonzero. Stop and destroy remain usable so an operator can remove
unsupported state explicitly.

## Volume Ownership and Cleanup

The runtime container has exactly these persistent named mounts:

| Destination | Owner |
| --- | --- |
| `/workspace` | Supervisor-managed workspace volume |
| `/home/podman/.local/share/containers` | Supervisor-managed rootless Podman storage volume |
| `/opt/ploinky/node_modules` | Supervisor-managed dependency volume |

The image declares no volumes and the supervisor does not mount
`/var/lib/containers`. Running as `podman` uses the rootless graph root, so the
rootful path is unnecessary.

Creation-failure and replacement-cleanup paths remove the failed container with
its anonymous volumes. The explicit destroy confirmation identifies the target
container, any attached anonymous volume identifiers, and the exact three named
Ploinky volumes. Approval removes the container with its anonymous volumes and
then removes those three named volumes. Engine `rm --volumes` does not replace
the explicit named-volume deletion. No path performs a broad volume prune or
removes resources belonging to another instance.

Using `rm --volumes` also cleans an inherited anonymous volume when an operator
explicitly destroys a legacy runtime. This is cleanup attached to the approved
destructive command, not a migration guarantee.

## Error Handling

| Failure | Required outcome |
| --- | --- |
| Registry unavailable or pull rejected | Return nonzero; do not use a cached image |
| Pulled image violates any contract field | Report the failed field and expected value; do not create or replace |
| Existing runtime uses contract 1 or has an invalid image contract | Report it as unsupported and instruct explicit destroy |
| Current-contract replacement image cannot be obtained | Leave the existing runtime untouched |
| Current-contract replacement fails after old-container removal | Restore the previous current-contract container and preserve named volumes |
| Failed new container allocated an unexpected anonymous volume | Remove that volume with the failed container |
| Explicit destroy is declined | Mutate nothing |
| One destroy phase fails | Continue the scoped cleanup phases, report each failure, and return nonzero |

Errors must distinguish pull failure, image-contract failure, unsupported
existing runtime, container creation failure, health failure, rollback failure,
and resource-cleanup failure. They must not describe a contract-1 runtime as
upgradeable.

## Publication Workflow

The workflow will replace the immutable tag and unused-tag guard with
`IMAGE_TAG=runtime`. Publication jobs remain serialized so two workflow runs
cannot race to move the channel.

Each architecture is built as a candidate and passes the metadata, entrypoint,
Podman, and nested-container gates before the multi-architecture manifest is
moved. The final publication contains `linux/amd64` and `linux/arm64`. Updating
the `:runtime` manifest occurs only after both candidates pass, and the workflow
prints the resulting manifest digest for traceability.

The mutable tag is a release channel, not the identity of an already-created
container. Existing compatible containers continue using their inspected image
ID until a deliberate current-contract replacement or explicit destroy/create
cycle.

## Verification Contract

| Boundary | Required proof |
| --- | --- |
| Static metadata | Both architectures satisfy every contract-2 image field and have no declared volumes |
| Outer identity | An interactive outer shell reports `outer:podman:/workspace` |
| Entrypoint | The image self-check reaches `[ploinky-box] self-check OK` |
| Nested Podman | `podman version`, `podman info`, and nested Alpine execution succeed on both architectures |
| Missing runtime | Supervisor invokes pull even when the tag exists locally and creates from the validated image ID |
| Pull failure | No cached fallback, container creation, volume creation, or existing-container mutation occurs |
| Reuse and start | A matching compatible runtime causes no registry request |
| Current replacement | Pull and validation precede shutdown; named volumes survive; post-removal failure rolls back |
| Legacy hard cut | Contract-1 runtime is reported unsupported and ordinary commands do not mutate it |
| Image volume modeling | The fake engine allocates image-declared anonymous volumes so a future inherited `VOLUME` regression fails tests |
| Real resource audit | Creation introduces exactly three named volumes and no anonymous volume; destroy returns the scoped inventory to baseline |
| Engine parity | Docker and Podman command construction and inspect normalization have equivalent semantics |
| Regression | Focused supervisor tests and the complete repository test suite pass before Ploinky publication |

The public-image smoke test must inspect the actual container mounts rather than
infer correctness from named-volume deletion alone. Cleanup audits compare
before and after inventories and never prune unrelated host resources.

## Rollout

The image change is built, verified, and published to `:runtime` with contract
2 first. Existing released Ploinky versions continue referencing their old
immutable tag and are unaffected.

Ploinky then changes its required image and contract, removes legacy aliases
and automatic contract migration, and adopts the strict pull and full image
validation rules. A public-image smoke test validates the published manifest
through the updated supervisor before the Ploinky branch is released.

Operators with an existing contract-1 runtime explicitly run `ploinky destroy`
and then any ordinary Ploinky command to pull and create the new runtime. No
workspace, dependency, or nested-container-storage migration is offered or
promised.

## Alternatives Considered

| Approach | Decision |
| --- | --- |
| Clean final stage reconstructed from the prepared root filesystem | Selected because it removes inherited image configuration using the existing Dockerfile and Buildx toolchain |
| Post-process OCI metadata with Buildah or `regctl` | Rejected because it adds per-platform manifest tooling and publication complexity; the relevant `regctl` mutation path is experimental |
| Inject `USER` and mount tmpfs over `/var/lib/containers` in the supervisor | Rejected because it hides defective image metadata and adds lifecycle state that is unnecessary without backward compatibility |
| Add a fourth named volume for `/var/lib/containers` | Rejected because the path is unused for rootless Podman and violates the exact-three-volume ownership contract |
| Preserve immutable versioned runtime tags | Rejected because the selected release model is an always-pulled mutable channel for actual create and replacement operations |
