#!/bin/sh
# AgentServer.sh
# Behavior:
# - If a command (the agent app) is provided as arguments, set CHILD_CMD to that command
#   and supervise AgentServer.mjs which will invoke CHILD_CMD on each request with a base64 payload.
# - If no command is provided, supervise AgentServer.mjs which replies with {ok:false, error:'not implemented'}.

if [ $# -gt 0 ]; then
  export CHILD_CMD="$@"
  echo "[AgentServer.sh] Supervising AgentServer.mjs with child command: $CHILD_CMD"
else
  echo "[AgentServer.sh] No custom app provided. Supervising default AgentServer.mjs on port ${PORT:-7000}"
fi

server_pid=''
termination_fallback_status=''
forward_termination() {
  signal_status="$1"
  # Preserve only the server's own clean shutdown result. A server that does
  # not acknowledge the forwarded termination retains the signal-style status
  # so the managed targeted-restart path fails closed.
  trap '' HUP INT TERM
  if [ -z "$server_pid" ]; then
    exit "$signal_status"
  fi
  termination_fallback_status="$signal_status"
  kill -TERM "$server_pid" 2>/dev/null || true
}

trap 'forward_termination 129' HUP
trap 'forward_termination 130' INT
trap 'forward_termination 143' TERM

while :; do
  node ${PLOINKY_AGENT_LIB_DIR:-/Agent}/server/AgentServer.mjs &
  server_pid="$!"
  wait "$server_pid"
  code=$?

  # A signal trap interrupts wait(1). Reap the exact server again so its zero
  # result is the in-band graceful-drain acknowledgement and every non-zero
  # result remains a failed acknowledgement.
  if [ -n "$termination_fallback_status" ]; then
    wait "$server_pid"
    acknowledged_status=$?
    if [ "$acknowledged_status" -ne 127 ]; then
      code="$acknowledged_status"
    elif [ "$code" -eq 127 ]; then
      code="$termination_fallback_status"
    fi
    exit "$code"
  fi

  server_pid=''
  echo "[AgentServer.sh] AgentServer.mjs exited with code $code. Restarting in 60s..."
  sleep 60
done
