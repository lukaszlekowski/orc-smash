#!/bin/sh
[ "$#" -ge 2 ] || exit 64
cgroup_path=$1
shift
printf '%s\n' "$$" > "$cgroup_path/cgroup.procs" || exit 65
printf 'READY\t%s\t%s\t%s\t%s\n' "$$" "$$" "$$" "$cgroup_path" >&3
IFS= read -r ack <&4 || exit 66
[ "$ack" = ACK ] || exit 66
exec "$@"
