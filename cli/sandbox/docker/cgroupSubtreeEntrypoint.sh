#!/bin/sh
set -eu
test "$#" -ge 2
cgroup_box_namespace=$1
pid_box_namespace=$2
shift 2
cgroup_node=/usr/local/bin/node
if test ! -x "$cgroup_node"; then cgroup_node=/usr/bin/node; fi
if test ! -x "$cgroup_node"; then
    printf '%s\n' 'cgroup delegation requires Node.js at /usr/local/bin/node or /usr/bin/node' >&2
    exit 1
fi
if test ! -x /bin/mount; then
    printf '%s\n' 'cgroup delegation requires /bin/mount in the agent image' >&2
    exit 1
fi
NODE_OPTIONS= NODE_PATH= "$cgroup_node" /run/ploinky-cgroup/cgroupSubtreePrepare.mjs "$cgroup_box_namespace" "$pid_box_namespace"
exec /Agent/server/AgentEntrypoint.sh "$@"
