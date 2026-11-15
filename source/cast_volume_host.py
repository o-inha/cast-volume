"""Chrome Native Messaging bridge for local Google Cast receivers."""

from concurrent.futures import ThreadPoolExecutor
import json
import os
import struct
import sys

# The embeddable Windows runtime does not add the entry script's directory.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from cast_discovery import discover
from cast_protocol import CastProtocolError, CastSessionChangedError, get_status, set_volume


LENGTH = struct.Struct('<I')
MAX_REQUEST = 16 * 1024
IDLE_APPS = {'E8C28D3C'}  # Chromecast Backdrop


def active_session(status):
    applications = status.get('applications')
    if not isinstance(applications, list):
        return None
    for app in applications:
        if not isinstance(app, dict):
            continue
        session = app.get('sessionId')
        if (
            isinstance(session, str) and 0 < len(session) <= 256
            and app.get('isIdleScreen') is not True
            and str(app.get('appId', '')).upper() not in IDLE_APPS
        ):
            return session
    return None


def receiver_view(device, session, status):
    volume = status.get('volume')
    if not isinstance(volume, dict):
        volume = {}
    level = volume.get('level')
    has_level = type(level) in (int, float) and 0 <= level <= 1
    fixed = str(volume.get('controlType', '')).lower() == 'fixed'
    return {
        'id': device['id'],
        'name': device['name'],
        'session': session,
        'level': round(level * 100) if has_level else None,
        'muted': volume.get('muted') is True,
        'fixed': fixed,
        'adjustable': has_level and not fixed,
    }


def probe(device):
    try:
        status = get_status(device['host'], device['port'], timeout=1.5)
    except OSError:
        return None
    session = active_session(status)
    return receiver_view(device, session, status) if session else None


class CastVolume:
    def __init__(self):
        self.devices = {}
        self.scanned = False
        self.active = {}

    def scan(self, refresh):
        if refresh or not self.scanned:
            devices = discover()
            self.devices = {device['id']: device for device in devices[:48]}
            self.scanned = True
        with ThreadPoolExecutor(max_workers=12) as executor:
            receivers = list(filter(None, executor.map(probe, self.devices.values())))
        self.active = {receiver['id']: receiver for receiver in receivers}
        return {'ok': True, 'found': len(self.devices), 'receivers': receivers}

    def change_volume(self, request):
        device_id = request.get('id')
        session = request.get('session')
        level = request.get('level')
        if not isinstance(device_id, str) or not isinstance(session, str):
            raise ValueError('Choose an active Cast receiver.')
        if type(level) is not int or not 0 <= level <= 100:
            raise ValueError('Volume must be a whole number from 0 to 100.')

        device = self.devices.get(device_id)
        receiver = self.active.get(device_id)
        if not device or not receiver or receiver['session'] != session:
            raise ValueError('The selected Cast session has ended or changed.')
        if not receiver['adjustable']:
            raise ValueError('Volume is unavailable on this receiver.')
        status = set_volume(device['host'], device['port'], level / 100, expected_session_id=session)
        if active_session(status) != session:
            self.active.pop(device_id, None)
            raise CastSessionChangedError('The selected Cast session has ended or changed.')
        updated = receiver_view(device, session, status)
        self.active[device_id] = updated
        return {'ok': True, 'receiver': updated}

    def handle(self, request):
        if not isinstance(request, dict):
            raise ValueError('Invalid request.')
        if request.get('op') == 'scan':
            return self.scan(request.get('discover') is True)
        if request.get('op') == 'volume':
            return self.change_volume(request)
        raise ValueError('Unknown request.')


def main():
    if sys.platform == 'win32':
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    reader, writer = sys.stdin.buffer, sys.stdout.buffer
    controller = CastVolume()
    while len(header := reader.read(LENGTH.size)) == LENGTH.size:
        (size,) = LENGTH.unpack(header)
        if not 0 < size <= MAX_REQUEST:
            return
        body = reader.read(size)
        if len(body) != size:
            return
        try:
            response = controller.handle(json.loads(body))
        except (CastProtocolError, ValueError) as error:
            response = {'ok': False, 'error': str(error)}
        except OSError:
            response = {'ok': False, 'error': 'The Cast receiver or local network did not respond.'}
        payload = json.dumps(response, ensure_ascii=True, separators=(',', ':')).encode('ascii')
        try:
            writer.write(LENGTH.pack(len(payload)) + payload)
            writer.flush()
        except BrokenPipeError:
            return


if __name__ == '__main__':
    main()
