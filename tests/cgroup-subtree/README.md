# Selected-fixture cgroup verification

Run this observer only after the selected task fixture has been refreshed to the approved committed candidate. It creates no Box, agent or image and performs no pull, restart or direct cgroup filesystem write. It checks exact source and runtime identities, private namespaces, the writable native-root view, the read-only sysfs view and supported exec after startup processes moved into `core`. Workload limit, OOM, escape and removal scenarios remain separate acceptance checks.

```sh
node tests/cgroup-subtree/verify.mjs --manifest /absolute/task/evidence/cgroup-fixture.json
```

The manifest uses this schema. Replace each placeholder with an observed exact value; IDs and image digests require 64 lowercase hex characters, commits and trees require 40. The host UID must be nonzero. Repository roots and the workspace must be canonical paths. The evidence directory must already exist.

```json
{
  "schemaVersion": 1,
  "purpose": "cgroup-subtree-acceptance",
  "host": { "hostname": "selected-host", "uid": 1000 },
  "workspaceRoot": "/absolute/task/workspace",
  "evidenceDirectory": "/absolute/task/evidence",
  "repositories": [
    { "name": "ploinky", "root": "/absolute/source/ploinky", "commit": "<40hex>", "tree": "<40hex>" },
    { "name": "consumer", "root": "/absolute/source/consumer", "commit": "<40hex>", "tree": "<40hex>" }
  ],
  "box": { "id": "<64hex>", "imageId": "sha256:<64hex>" },
  "agent": { "id": "<64hex>", "imageId": "sha256:<64hex>" },
  "peer": { "id": "<64hex>", "imageId": "sha256:<64hex>" }
}
```

All listed repositories must be clean at their pinned commits and trees before the observer touches the runtime. Both selected agents must opt into `containerSecurity.cgroupSubtree`. The Box must carry the expected workspace identity and mount the pinned Ploinky checkout read-only. A missing pin, changed source, wrong Box, image mismatch or incomplete cgroup proof exits nonzero. Successful observation writes a new mode-0600 JSON report without copying engine inspection or credentials into evidence.
