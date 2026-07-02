# Remote LLM Architecture Catalog Design

Date: 2026-07-02

## Problem

The previous Ploinky catalog-access design treated a sibling `local-llm-architectures/` checkout as the default source. That works in the local development workspace, but it is not valid for normal Ploinky installations because Ploinky is cloned or installed by itself. The architecture catalog must remain external, but Ploinky needs a real bootstrap path.

## Decision

Ploinky will treat the LLM architecture catalog as a remote, versioned data dependency.

The default source is:

```text
https://github.com/AssistOS-AI/local-llm-architectures.git
```

The default ref is:

```text
main
```

Ploinky will clone or fetch that repository into the existing workspace-local catalog cache:

```text
.ploinky/llm-catalog-cache/<hash-of-repo-and-ref>
```

The sibling checkout fallback is removed. Local development checkouts remain supported only through the explicit `PLOINKY_LLM_ARCHITECTURES_PATH` override.

## Source Resolution Order

| Priority | Source | Behavior |
| --- | --- | --- |
| 1 | `PLOINKY_LLM_ARCHITECTURES_PATH` | Use an absolute path or a path relative to `PLOINKY_WORKSPACE_ROOT`. |
| 2 | `PLOINKY_LLM_ARCHITECTURES_REPO` and optional `PLOINKY_LLM_ARCHITECTURES_REF` | Clone/fetch the configured repo/ref into `.ploinky/llm-catalog-cache`. |
| 3 | Built-in default remote repo and default ref | Clone/fetch `https://github.com/AssistOS-AI/local-llm-architectures.git` at `main` into `.ploinky/llm-catalog-cache`. |

There is no implicit sibling lookup of `../local-llm-architectures`.

## Cache Behavior

On first run, Ploinky fetches the configured or default remote catalog. If the fetch fails and no valid cached checkout exists for that source, startup fails with a clear error explaining the catalog source and the available overrides.

On later runs, Ploinky attempts to update the cached checkout before selection. If the update fails but the cache already contains a valid checkout, Ploinky may use that cached checkout. It must validate the catalog before selection and record the resolved cached commit SHA in selection metadata.

The cache key is derived from the repository URL and requested ref so different catalog sources do not overwrite each other.

## Selection Metadata

`selected-architecture.json` should include enough catalog provenance to explain what was selected:

| Field | Meaning |
| --- | --- |
| `catalog.id` | Catalog id from `catalog.json`. |
| `catalog.ref` | Resolved git commit SHA when available, otherwise a local snapshot hash for path-based catalogs. |
| `catalog.source` | `path`, `git`, or `default-remote`. |
| `catalog.repoUrl` | Remote URL for remote/default sources; `null` for path sources. |
| `catalog.requestedRef` | Requested git ref, such as `main`, a branch, tag, or commit. |

The selected state must not contain secrets.

## Validation and Security

The existing strict catalog validation remains the boundary:

- catalog files are JSON data only
- referenced paths must stay inside the catalog root
- unknown fields are rejected
- runtime policy is typed and allowlisted
- raw Docker/Podman args are rejected
- arbitrary mounts, privileged mode, and unsafe host devices are rejected
- catalog code is never executed

Remote fetching changes where the data comes from; it does not change what Ploinky is willing to consume.

## Environment Overrides

| Variable | Purpose |
| --- | --- |
| `PLOINKY_LLM_ARCHITECTURES_PATH` | Use a local catalog checkout. This is the development/offline override. |
| `PLOINKY_LLM_ARCHITECTURES_REPO` | Use a non-default remote catalog repository. |
| `PLOINKY_LLM_ARCHITECTURES_REF` | Pin a branch, tag, or commit for remote/default catalog sources. |
| `PLOINKY_LLM_CATALOG_CACHE_DIR` | Override the cache directory. |

## Operational Result

With this design, a normal Ploinky installation can start LLM runtime agents without requiring a sibling `local-llm-architectures` checkout. Operators still retain full control: they can pin a ref, point at a fork, or use a local path.

The clean ownership boundary is preserved:

| Component | Responsibility |
| --- | --- |
| `local-llm-architectures` | Publishes catalog data. |
| Ploinky | Fetches, caches, validates, selects, and records provenance. |
| `container-image-builds` | Publishes image tags referenced by the catalog. |
| `llm-runtime` | Runs the in-container control plane and launchers. |

