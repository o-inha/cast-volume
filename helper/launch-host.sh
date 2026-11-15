#!/bin/sh
set -eu

helper_dir=$(CDPATH= cd "$(dirname "$0")" && pwd -P)
IFS= read -r python < "$helper_dir/python-path"
exec "$python" -I -B -u "$helper_dir/cast_volume_host.py" "$@"
