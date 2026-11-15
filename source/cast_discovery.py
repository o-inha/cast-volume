"""Discover Google Cast receivers with one-shot multicast DNS queries."""

import ipaddress
import secrets
import select
import socket
import struct
import sys
import time


SERVICE = (b"_googlecast", b"_tcp", b"local")
MDNS_PORT = 5353
A, PTR, TXT, AAAA, SRV = 1, 12, 16, 28, 33
IN = 1


def _read_name(packet, offset):
    labels = []
    end = None
    size = 1
    pointer_limit = offset
    while offset < len(packet):
        length = packet[offset]
        if length & 0xC0 == 0xC0:
            if offset + 1 >= len(packet):
                break
            target = ((length & 0x3F) << 8) | packet[offset + 1]
            if target >= pointer_limit:
                raise ValueError("Invalid DNS compression pointer")
            if end is None:
                end = offset + 2
            pointer_limit = target
            offset = target
            continue
        offset += 1
        if not length:
            return tuple(labels), end if end is not None else offset
        size += length + 1
        if length > 63 or size > 255 or offset + length > len(packet):
            break
        labels.append(packet[offset:offset + length])
        offset += length
    raise ValueError("Invalid DNS name")


def _records(packet, pending):
    """Parse the answer and additional records of a response to our query."""
    ident, flags, questions, answers, authority, additional = struct.unpack_from("!6H", packet)
    if ident not in pending or flags & 0xF80F != 0x8000:
        return []

    offset = 12
    for _ in range(questions):
        _, offset = _read_name(packet, offset)
        offset += 4

    records = []
    for _ in range(answers + authority + additional):
        name, offset = _read_name(packet, offset)
        record_type, record_class, ttl, length = struct.unpack_from("!HHIH", packet, offset)
        offset += 10
        end = offset + length
        if end > len(packet):
            raise ValueError("Truncated DNS resource record")
        if ttl and (record_class & 0x7FFF) == IN:
            records.append((name, record_type, offset, end))
        offset = end
    return records


def _read_txt(packet, offset, end):
    fields = {}
    while offset < end:
        length = packet[offset]
        offset += 1
        if offset + length > end:
            raise ValueError("Truncated DNS TXT record")
        key, _, value = packet[offset:offset + length].partition(b"=")
        fields[key.lower()] = value.decode("utf-8", errors="replace")
        offset += length
    return fields


def _key(name):
    return tuple(label.lower() for label in name)


def _is_instance(name):
    return len(name) == len(SERVICE) + 1 and name[1:] == SERVICE


def _receiver_id(instance, fields):
    advertised = fields.get(b"id", "").strip().lower()
    compact = advertised.replace("-", "")
    if len(compact) == 32 and all(character in "0123456789abcdef" for character in compact):
        return compact
    return advertised or "mdns-" + instance[0].hex()


class _Discovery:
    def __init__(self):
        self.instances = {}
        self.services = {}
        self.text = {}
        self.addresses = {}
        self.pending = set()

    def absorb(self, packet, source):
        records = _records(packet, self.pending)
        for owner, record_type, offset, end in records:
            name = _key(owner)
            if record_type == PTR and name == SERVICE:
                labels, next_offset = _read_name(packet, offset)
                instance = _key(labels)
                if next_offset == end and _is_instance(instance):
                    self.instances[instance] = labels
            elif record_type == SRV and _is_instance(name) and end - offset >= 7:
                port = struct.unpack_from("!H", packet, offset + 4)[0]
                target, next_offset = _read_name(packet, offset + 6)
                if port and target and next_offset == end:
                    self.services[name] = (port, _key(target))
            elif record_type == TXT and _is_instance(name):
                self.text[name] = _read_txt(packet, offset, end)
            elif (record_type, end - offset) in ((A, 4), (AAAA, 16)):
                self._add_address(name, packet[offset:end], source)

    def _add_address(self, name, data, source):
        address = ipaddress.ip_address(data)
        if address.is_unspecified or address.is_multicast or address.is_loopback:
            return
        host = str(address)
        matches_source = host == source[0].partition("%")[0]
        if address.version == 6 and address.is_link_local:
            scope = source[3] if len(source) == 4 else 0
            if not scope:
                return
            host = f"{host}%{scope}"
        rank = (not matches_source, address.version)
        addresses = self.addresses.setdefault(name, {})
        addresses[host] = min(addresses.get(host, rank), rank)

    def follow_ups(self):
        queries = set()
        for instance, original in self.instances.items():
            if instance not in self.services:
                queries.add((original, SRV))
            if instance not in self.text:
                queries.add((original, TXT))
        for _, target in self.services.values():
            if target not in self.addresses:
                queries.update(((target, A), (target, AAAA)))
        return queries

    def receivers(self):
        devices = {}
        for instance, original in self.instances.items():
            service = self.services.get(instance)
            if not service:
                continue
            port, target = service
            addresses = self.addresses.get(target)
            if not addresses:
                continue
            host = min(addresses, key=lambda address: (addresses[address], address))
            fields = self.text.get(instance, {})
            device_id = _receiver_id(instance, fields)
            name = fields.get(b"fn", "").strip() or original[0].decode("utf-8", errors="replace")
            device = {"id": device_id, "name": name, "host": host, "port": port}
            rank = (addresses[host], not bool(fields.get(b"fn")), host)
            if device_id not in devices or rank < devices[device_id][0]:
                devices[device_id] = (rank, device)
        return sorted((device for _, device in devices.values()), key=lambda device: device["name"].casefold())


def _windows_ipv4_interfaces():
    import ctypes

    get_table = ctypes.windll.iphlpapi.GetIpAddrTable
    get_table.argtypes = (ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32), ctypes.c_int)
    get_table.restype = ctypes.c_uint32
    size = ctypes.c_uint32()
    if get_table(None, ctypes.byref(size), 0) != 122:  # ERROR_INSUFFICIENT_BUFFER
        return []
    table = ctypes.create_string_buffer(size.value)
    if get_table(table, ctypes.byref(size), 0) != 0:
        return []

    # MIB_IPADDRTABLE starts with a DWORD count, then one MIB_IPADDRROW per entry.
    row = struct.Struct("=4sIIIIHH")
    count = struct.unpack_from("=I", table)[0]
    return [socket.inet_ntoa(row.unpack_from(table, 4 + index * row.size)[0]) for index in range(count)]


def _ipv4_interfaces():
    if sys.platform == "win32":
        addresses = _windows_ipv4_interfaces()
    else:
        try:
            addresses = [result[4][0] for result in socket.getaddrinfo(
                socket.gethostname(), None, socket.AF_INET, socket.SOCK_DGRAM
            )]
        except OSError:
            addresses = []
    return sorted({address for address in addresses if address != "0.0.0.0" and not address.startswith("127.")})


def _ipv6_interfaces():
    try:
        return [index for index, _ in socket.if_nameindex()]
    except (OSError, AttributeError):
        return []


def _query_sockets():
    sockets = {}
    for family, bind_address in ((socket.AF_INET, "0.0.0.0"), (socket.AF_INET6, "::")):
        try:
            connection = socket.socket(family, socket.SOCK_DGRAM)
        except OSError:
            continue
        try:
            if family == socket.AF_INET:
                connection.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 255)
            else:
                connection.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
                connection.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_MULTICAST_HOPS, 255)
            connection.bind((bind_address, 0))
            sockets[family] = connection
        except OSError:
            connection.close()
    return sockets


def _query(sockets, interfaces, discovery, name, record_type):
    ident = secrets.randbelow(65535) + 1
    while ident in discovery.pending:
        ident = secrets.randbelow(65535) + 1
    discovery.pending.add(ident)
    labels = b"".join(bytes([len(label)]) + label for label in name) + b"\0"
    packet = struct.pack("!6H", ident, 0, 1, 0, 0, 0) + labels + struct.pack("!HH", record_type, IN)

    # RFC 6762 §5.1. A query from an ephemeral port requests a unicast response
    # without contending with Chrome or the OS for the local multicast port.
    connection = sockets.get(socket.AF_INET)
    if connection is not None:
        for interface in interfaces[socket.AF_INET]:
            try:
                connection.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(interface))
                connection.sendto(packet, ("224.0.0.251", MDNS_PORT))
            except OSError:
                continue

    connection = sockets.get(socket.AF_INET6)
    if connection is not None:
        for interface in interfaces[socket.AF_INET6]:
            try:
                connection.sendto(packet, ("ff02::fb", MDNS_PORT, 0, interface))
            except OSError:
                continue


def discover(timeout: float = 1.5) -> list[dict]:
    """Return each discovered receiver's id, friendly name, IP address and port."""
    sockets = _query_sockets()
    if not sockets:
        return []

    interfaces = {
        socket.AF_INET: ["0.0.0.0", *_ipv4_interfaces()],
        socket.AF_INET6: _ipv6_interfaces(),
    }
    discovery = _Discovery()
    requested = set()
    start = time.monotonic()
    deadline = start + max(0, timeout)
    retry = start + timeout * 0.45
    try:
        _query(sockets, interfaces, discovery, SERVICE, PTR)
        while (remaining := deadline - time.monotonic()) > 0:
            wait = min(remaining, max(0, retry - time.monotonic()))
            ready, _, _ = select.select(sockets.values(), [], [], wait)
            for connection in ready:
                try:
                    packet, source = connection.recvfrom(65535)
                    if source[1] == MDNS_PORT:
                        discovery.absorb(packet, source)
                except (OSError, ValueError, struct.error):
                    continue
            now = time.monotonic()
            if now >= deadline:
                break
            if now >= retry:
                _query(sockets, interfaces, discovery, SERVICE, PTR)
                retry = deadline
                requested.clear()
            for question in discovery.follow_ups() - requested:
                _query(sockets, interfaces, discovery, *question)
                requested.add(question)
    finally:
        for connection in sockets.values():
            connection.close()
    return discovery.receivers()
