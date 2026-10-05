#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if (( $# > 0 )); then
    if [[ $# -ne 2 || "$1" != "--acceptance" || "$2" != /*_codex.json || "$2" == *$'\n'* || "$2" == *$'\r'* ]]; then
        echo '[test] Refused: use --acceptance /absolute/manifest_codex.json.' >&2
        exit 64
    fi
fi
exec "$SCRIPT_DIR/test_all.sh" "$@"
