#!/bin/sh
set -eu
umask 077

host_name=jp.inha.cast_volume
: "${HOME:?HOME is required}"

case $(uname -s) in
    Linux)
        case ${XDG_CONFIG_HOME:-} in
            /*) config_home=$XDG_CONFIG_HOME ;;
            *) config_home=$HOME/.config ;;
        esac
        case ${XDG_DATA_HOME:-} in
            /*) data_home=$XDG_DATA_HOME ;;
            *) data_home=$HOME/.local/share ;;
        esac
        manifest_dir=$config_home/google-chrome/NativeMessagingHosts
        install_dir=$data_home/cast-volume
        ;;
    Darwin)
        manifest_dir="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
        install_dir="$HOME/Library/Application Support/CastVolume"
        ;;
    *)
        printf '%s\n' 'This command supports Linux and macOS. On Windows, run install-helper.cmd.' >&2
        exit 1
        ;;
esac

manifest_path=$manifest_dir/$host_name.json

if [ "${1:-}" = --uninstall ] && [ "$#" -eq 1 ]; then
    rm -f "$manifest_path"
    rm -rf "$install_dir"
    printf '%s\n' 'Cast Volume helper removed.'
    exit 0
fi

if [ "$#" -ne 0 ]; then
    printf '%s\n' 'Usage: sh ./install-helper.sh [--uninstall]' >&2
    exit 1
fi

if [ -n "${CAST_VOLUME_PYTHON:-}" ]; then
    python_command=$CAST_VOLUME_PYTHON
    case $python_command in
        /*) ;;
        *)
            printf '%s\n' 'CAST_VOLUME_PYTHON must be an absolute path to a Python executable.' >&2
            exit 1
            ;;
    esac
else
    python_command=$(command -v python3 || :)
fi

if [ -z "$python_command" ]; then
    printf '%s\n' 'Python 3.10 or newer is required. Install it, then run this command again.' >&2
    exit 1
fi

if ! python=$("$python_command" -I -B - <<'PY'
import sys

if sys.version_info < (3, 10):
    sys.exit('Found Python ' + sys.version.split()[0] + '. Cast Volume requires Python 3.10 or newer.')

import os
import ssl

if not os.path.isabs(sys.executable) or '\n' in sys.executable:
    sys.exit('Python did not report a usable executable path.')
print(sys.executable)
PY
); then
    printf '%s\n' 'Use Python 3.10 or newer with SSL support, then run this command again.' >&2
    exit 1
fi

package_dir=$(CDPATH= cd "$(dirname "$0")" && pwd -P)
mkdir -p "$install_dir" "$manifest_dir"
stage=$(mktemp -d "$install_dir/version.XXXXXXXX")

cleanup() {
    if [ -n "$stage" ] && [ ! -e "$stage/.registering" ]; then
        rm -rf "$stage"
    fi
}

trap cleanup EXIT
trap 'exit 1' HUP INT TERM

cp "$package_dir/source/cast_discovery.py" \
    "$package_dir/source/cast_protocol.py" \
    "$package_dir/source/cast_volume_host.py" \
    "$package_dir/helper/launch-host.sh" "$stage/"
chmod u+x "$stage/launch-host.sh"
printf '%s\n' "$python" > "$stage/python-path"

if ! "$python" -I -B - "$stage" "$manifest_path" <<'PY'
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile

stage = Path(sys.argv[1]).resolve()
manifest = Path(sys.argv[2])
sys.path.insert(0, str(stage))
import cast_volume_host  # Verify the installed helper and its required modules.

previous_host = None
try:
    previous = json.loads(manifest.read_text(encoding='utf-8'))
    if isinstance(previous, dict) and isinstance(previous.get('path'), str):
        previous_host = Path(previous['path'])
except (OSError, ValueError):
    pass

configuration = {
    'name': 'jp.inha.cast_volume',
    'description': 'Local receiver volume control for the Cast Volume extension',
    'path': str(stage / 'launch-host.sh'),
    'type': 'stdio',
    'allowed_origins': ['chrome-extension://elhhnnbjjnhfgncifdfaeibfofkiapap/'],
}

temporary_path = None
registering = stage / '.registering'
try:
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=manifest.parent,
                                     prefix='.' + manifest.name + '.', delete=False) as temporary:
        temporary_path = Path(temporary.name)
        json.dump(configuration, temporary)
        temporary.write('\n')
    # Keep this directory even if the setup command is interrupted during the rename.
    registering.touch()
    os.replace(temporary_path, manifest)
except OSError:
    registering.unlink(missing_ok=True)
    raise
finally:
    if temporary_path is not None:
        temporary_path.unlink(missing_ok=True)

if previous_host and previous_host.name == 'launch-host.sh':
    previous_stage = previous_host.parent
    if (previous_stage.parent == stage.parent and previous_stage.name.startswith('version.')
            and previous_stage != stage):
        shutil.rmtree(previous_stage, ignore_errors=True)
PY
then
    printf '%s\n' 'Cast Volume helper setup failed. The previous helper registration was preserved.' >&2
    exit 1
fi

installed_stage=$stage
stage=
rm -f "$installed_stage/.registering"
printf '%s\n' 'Cast Volume helper ready for this account.' \
    'Open chrome://extensions, enable Developer mode, and load the extension folder.'
