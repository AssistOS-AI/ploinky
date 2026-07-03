#!/usr/bin/env bash
# Engine-free tests for the ploinky-box wrapper. Uses --dry-run, which prints
# the engine command instead of executing it, so no podman/docker is needed.
set -u

BOX="$(cd "$(dirname "$0")" && pwd)/ploinky-box"
PASS=0
FAIL=0

check() { # <description> <expected-grep-pattern> <haystack>
    if printf '%s\n' "$3" | grep -qF -- "$2"; then
        PASS=$((PASS + 1)); echo "PASS: $1"
    else
        FAIL=$((FAIL + 1)); echo "FAIL: $1"; echo "  wanted: $2"; echo "  in: $3"
    fi
}

check_absent() { # <description> <forbidden-grep-pattern> <haystack>
    if printf '%s\n' "$3" | grep -qF -- "$2"; then
        FAIL=$((FAIL + 1)); echo "FAIL: $1 (found forbidden '$2')"
    else
        PASS=$((PASS + 1)); echo "PASS: $1"
    fi
}

if bash -n "$BOX"; then
    PASS=$((PASS + 1)); echo "PASS: bash -n syntax check"
else
    FAIL=$((FAIL + 1)); echo "FAIL: bash -n syntax check"
fi

DEFAULT_UP="$(PLOINKY_BOX_ENGINE=podman "$BOX" --dry-run up 2>&1)"
check "default up uses podman"                 "DRY-RUN: podman"                                          "$DEFAULT_UP"
check "default up runs rootless user"          "--user podman"                                            "$DEFAULT_UP"
check "default up passes /dev/fuse"            "--device /dev/fuse"                                       "$DEFAULT_UP"
check "default up passes /dev/net/tun"         "--device /dev/net/tun"                                    "$DEFAULT_UP"
check "default up unconfines seccomp"          "seccomp=unconfined"                                       "$DEFAULT_UP"
check "default up publishes loopback 8080"     "127.0.0.1:8080:8080"                                      "$DEFAULT_UP"
check "default up mounts workspace volume"     "ploinky-box-workspace:/workspace"                         "$DEFAULT_UP"
check "default up mounts containers volume"    "ploinky-box-containers:/home/podman/.local/share/containers" "$DEFAULT_UP"
check "default up marks box runtime"           "-e PLOINKY_BOX=1"                                         "$DEFAULT_UP"
check "default up uses default image"          "docker.io/assistos/ploinky-box:podman-node24"             "$DEFAULT_UP"
check "default up reaps zombies"               "--init"                                                   "$DEFAULT_UP"
check_absent "no --privileged, ever"           "--privileged"                                             "$DEFAULT_UP"

NAMED_UP="$(PLOINKY_BOX_ENGINE=docker "$BOX" --dry-run --name qa --port 9090 --listen-lan up 2>&1)"
check "named up uses docker when forced"       "DRY-RUN: docker"                                          "$NAMED_UP"
check "named up names the instance"            "--name ploinky-box-qa"                                    "$NAMED_UP"
check "named up prefixes volumes"              "ploinky-box-qa-workspace:/workspace"                      "$NAMED_UP"
check "lan flag binds all interfaces"          "0.0.0.0:9090:8080"                                        "$NAMED_UP"
check_absent "named up still not privileged"   "--privileged"                                             "$NAMED_UP"

IMG_UP="$(PLOINKY_BOX_ENGINE=podman "$BOX" --dry-run --image example.org/x/y:z up 2>&1)"
check "image override respected"               "example.org/x/y:z"                                        "$IMG_UP"

PUBLISH_UP="$(PLOINKY_BOX_ENGINE=podman "$BOX" --dry-run --publish 127.0.0.1:7880:7880 up 2>&1)"
check "publish flag adds extra port"           "-p 127.0.0.1:7880:7880"                                  "$PUBLISH_UP"

WEBMEET_UP="$(PLOINKY_BOX_ENGINE=podman "$BOX" --dry-run --webmeet-ports up 2>&1)"
check "webmeet ports publish livekit websocket" "-p 127.0.0.1:7880:7880"                                 "$WEBMEET_UP"
check "webmeet ports publish livekit tcp"      "-p 127.0.0.1:7881:7881"                                  "$WEBMEET_UP"
check "webmeet ports publish livekit udp"      "-p 127.0.0.1:7882-7892:7882-7892/udp"                    "$WEBMEET_UP"
check "webmeet ports publish turn tcp"         "-p 127.0.0.1:3478:3478/tcp"                              "$WEBMEET_UP"
check "webmeet ports publish turn udp"         "-p 127.0.0.1:3478:3478/udp"                              "$WEBMEET_UP"
check "webmeet ports publish turn relay"       "-p 127.0.0.1:20000-20010:20000-20010/udp"                "$WEBMEET_UP"

RUN_OUT="$(PLOINKY_BOX_ENGINE=podman "$BOX" --dry-run run start demo 8080 2>&1)"
check "run passes through to ploinky"          "exec -w /workspace ploinky-box ploinky start demo 8080"   "$RUN_OUT"

CP_OUT="$(PLOINKY_BOX_ENGINE=podman "$BOX" --dry-run cp /tmp/f box:/workspace/f 2>&1)"
check "cp maps box: prefix to instance"        "cp /tmp/f ploinky-box:/workspace/f"                       "$CP_OUT"

echo
echo "wrapper-tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
