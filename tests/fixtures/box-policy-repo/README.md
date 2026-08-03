# Box policy negative fixture

This repository fixture is test data only. Its privileged manifest must never
be registered as a production repository or copied into a deployed candidate
checkout. Tests copy these exact bytes into a temporary, test-owned Git
repository and verify that in-Box admission rejects it before mutation.
