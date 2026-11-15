"""Receiver-level Cast V2 status and volume over a short-lived TLS connection."""

from contextlib import contextmanager
import json
import math
import secrets
import socket
import ssl
import struct
import time


_PLATFORM_RECEIVER = b"receiver-0"
_PLATFORM_SENDER = b"sender-0"
_CONNECTION = b"urn:x-cast:com.google.cast.tp.connection"
_HEARTBEAT = b"urn:x-cast:com.google.cast.tp.heartbeat"
_RECEIVER = b"urn:x-cast:com.google.cast.receiver"
_FRAME_LENGTH = struct.Struct(">I")
_MAX_FRAME_LENGTH = 65536

# Cast receivers present device certificates outside the system HTTPS trust store.
# This local controller uses TLS but does not perform Cast device authentication.
_TLS = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
_TLS.check_hostname = False
_TLS.verify_mode = ssl.CERT_NONE


class CastProtocolError(OSError):
    """The receiver returned an invalid response or declined the request."""


class CastVolumeFixedError(CastProtocolError):
    """The receiver reports a fixed output volume."""


class CastSessionChangedError(CastProtocolError):
    """The selected casting session has ended or changed."""


def _encode_varint(value: int) -> bytes:
    encoded = bytearray()
    while value > 127:
        encoded.append((value & 127) | 128)
        value >>= 7
    encoded.append(value)
    return bytes(encoded)


def _encode_bytes_field(number: int, data: bytes) -> bytes:
    return _encode_varint((number << 3) | 2) + _encode_varint(len(data)) + data


def _decode_varint(data: bytes, offset: int) -> tuple[int, int]:
    value = 0
    for shift in range(0, 64, 7):
        if offset >= len(data):
            break
        byte = data[offset]
        offset += 1
        value |= (byte & 127) << shift
        if byte < 128 and value < 1 << 64:
            return value, offset
    raise CastProtocolError("The Cast receiver sent an invalid message.")


def _decode_fields(data: bytes) -> dict[int, bytes | int]:
    fields = {}
    offset = 0
    while offset < len(data):
        tag, offset = _decode_varint(data, offset)
        field_number, wire_type = tag >> 3, tag & 7
        if wire_type == 0:
            fields[field_number], offset = _decode_varint(data, offset)
            continue
        if wire_type == 2:
            length, offset = _decode_varint(data, offset)
        elif wire_type == 1:
            length = 8
        elif wire_type == 5:
            length = 4
        else:
            raise CastProtocolError("The Cast receiver sent an invalid field type.")
        end = offset + length
        if end > len(data):
            raise CastProtocolError("The Cast receiver sent an incomplete message.")
        fields[field_number] = data[offset:end]
        offset = end
    return fields


def _remaining(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("The Cast receiver did not respond in time.")
    return remaining


class _CastConnection:
    def __init__(self, stream: ssl.SSLSocket, deadline: float) -> None:
        self.stream = stream
        self.deadline = deadline
        self.sender = f"sender-{secrets.randbelow((1 << 31) - 1) + 1}".encode("ascii")
        self.request_id = 0

    def send(self, namespace: bytes, body: dict, *, sender: bytes | None = None) -> None:
        # CastMessage uses protobuf fields 1–6 for the version, addresses,
        # namespace, payload type, and UTF-8 payload respectively.
        data = b"".join((
            b"\x08\x00",
            _encode_bytes_field(2, sender or self.sender),
            _encode_bytes_field(3, _PLATFORM_RECEIVER),
            _encode_bytes_field(4, namespace),
            b"\x28\x00",
            _encode_bytes_field(6, json.dumps(body, separators=(",", ":")).encode("utf-8")),
        ))
        self.stream.settimeout(_remaining(self.deadline))
        self.stream.sendall(_FRAME_LENGTH.pack(len(data)) + data)

    def _read_exactly(self, size: int) -> bytes:
        data = bytearray()
        while len(data) < size:
            self.stream.settimeout(_remaining(self.deadline))
            chunk = self.stream.recv(size - len(data))
            if not chunk:
                raise ConnectionError("The Cast receiver closed the connection.")
            data.extend(chunk)
        return bytes(data)

    def _read_frame(self) -> dict[int, bytes | int]:
        (size,) = _FRAME_LENGTH.unpack(self._read_exactly(_FRAME_LENGTH.size))
        if not 0 < size <= _MAX_FRAME_LENGTH:
            raise CastProtocolError("The Cast receiver sent an invalid frame size.")
        return _decode_fields(self._read_exactly(size))

    def request(self, command: str, **body: object) -> dict:
        self.request_id += 1
        request_id = self.request_id
        self.send(_RECEIVER, {"type": command, "requestId": request_id, **body})

        while True:
            fields = self._read_frame()
            destination = fields.get(3)
            namespace = fields.get(4)
            payload = fields.get(6)
            if fields.get(2) != _PLATFORM_RECEIVER or fields.get(5) != 0:
                continue
            if namespace not in (_CONNECTION, _HEARTBEAT, _RECEIVER) or not isinstance(payload, bytes):
                continue
            if destination not in (self.sender, _PLATFORM_SENDER, b"*"):
                continue

            try:
                response = json.loads(payload.decode("utf-8"))
            except (ValueError, RecursionError) as error:
                raise CastProtocolError("The Cast receiver sent invalid JSON.") from error
            if not isinstance(response, dict):
                continue
            message_type = response.get("type")
            if namespace == _HEARTBEAT and message_type == "PING":
                heartbeat_sender = _PLATFORM_SENDER if destination == _PLATFORM_SENDER else self.sender
                self.send(_HEARTBEAT, {"type": "PONG"}, sender=heartbeat_sender)
            if namespace == _CONNECTION and message_type == "CLOSE":
                raise ConnectionError("The Cast receiver closed the connection.")
            if namespace != _RECEIVER or response.get("requestId") != request_id:
                continue

            if isinstance(message_type, str) and (
                message_type == "ERROR"
                or message_type.startswith("INVALID_")
                or message_type.endswith(("_ERROR", "_FAILED"))
            ):
                raise CastProtocolError(f"The Cast receiver declined {command} ({message_type}).")
            return response

    def get_status(self) -> dict:
        response = self.request("GET_STATUS")
        status = response.get("status")
        if response.get("type") != "RECEIVER_STATUS" or not isinstance(status, dict):
            raise CastProtocolError("The Cast receiver did not return its status.")
        return status

    def set_volume(self, volume: dict) -> dict:
        response = self.request("SET_VOLUME", volume=volume)
        status = response.get("status")
        if response.get("type") == "RECEIVER_STATUS" and isinstance(status, dict):
            reported_volume = status.get("volume")
            if (
                isinstance(status.get("applications"), list)
                and isinstance(reported_volume, dict)
                and isinstance(reported_volume.get("level"), (int, float))
                and ("muted" not in volume or isinstance(reported_volume.get("muted"), bool))
            ):
                return status
        # The receiver may acknowledge a write with only part of its status.
        return self.get_status()


@contextmanager
def _open_connection(host: str, port: int, timeout: float):
    if not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("The Cast receiver timeout must be a positive number.")

    deadline = time.monotonic() + timeout
    with socket.create_connection((host, port), timeout=_remaining(deadline)) as tcp:
        with _TLS.wrap_socket(tcp, do_handshake_on_connect=False) as stream:
            stream.settimeout(_remaining(deadline))
            stream.do_handshake()
            connection = _CastConnection(stream, deadline)
            connection.send(_CONNECTION, {"type": "CONNECT", "origin": {}, "userAgent": "Cast Volume"})
            yield connection


def get_status(host: str, port: int, timeout: float = 2.0) -> dict:
    """Read the current receiver status without joining the playback session."""
    with _open_connection(host, port, timeout) as connection:
        return connection.get_status()


def _check_volume_target(status: dict, expected_session_id: str | None) -> dict:
    applications = status.get("applications")
    if expected_session_id is not None and not (
        isinstance(applications, list)
        and any(
            isinstance(app, dict)
            and app.get("sessionId") == expected_session_id
            and app.get("isIdleScreen") is not True
            for app in applications
        )
    ):
        raise CastSessionChangedError("The selected Cast session has ended or changed.")

    volume = status.get("volume")
    if not isinstance(volume, dict):
        raise CastProtocolError("The Cast receiver did not report its volume.")
    if str(volume.get("controlType", "")).lower() == "fixed":
        raise CastVolumeFixedError("This Cast receiver reports a fixed volume.")
    return volume


def set_volume(
    host: str,
    port: int,
    level: float,
    timeout: float = 2.0,
    *,
    expected_session_id: str | None = None,
) -> dict:
    """Set receiver volume and return the receiver's resulting status."""
    if isinstance(level, bool) or not isinstance(level, (int, float)) or not 0 <= level <= 1:
        raise ValueError("Cast volume must be a number between 0 and 1.")

    with _open_connection(host, port, timeout) as connection:
        volume = _check_volume_target(connection.get_status(), expected_session_id)
        unmute = level > 0 and volume.get("muted") is True
        change = {"level": level}
        if unmute:
            change["muted"] = False
        status = connection.set_volume(change)

        if unmute and _check_volume_target(status, expected_session_id).get("muted") is True:
            # Some implementations only apply one property per request.
            status = connection.set_volume({"muted": False})
        return status
