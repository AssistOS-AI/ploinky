#!/bin/sh
set -eu
[ "$#" = 3 ] && [ "$1" = -c ] && [ "$2" = '%f %t %T' ] || exit 1
case "$3" in
    "$PLOINKY_QUERY_ROOT"/dev/dri/*) cat "$PLOINKY_QUERY_ROOT/.stat/${3##*/}" ;;
    *) exit 1 ;;
esac
