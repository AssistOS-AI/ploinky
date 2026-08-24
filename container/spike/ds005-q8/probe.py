#!/usr/bin/env python3
"""DS005-Q8 architecture-decision spike (S0) -- Candidate N TCP probe.

Active contracts: docs/specs/DS006-runtime-execution-and-isolation.md and
docs/specs/DS012-testing-and-verification.md. Historical section and line
annotations below are retained only as provenance for this self-contained spike.

This module owns TCP probing plus the reference/decoy listener modes used to
populate the S0 probe matrix (main plan section 6.4). It has no knowledge of
SSH, journals, or the PASS acknowledgement contract -- those belong to
stage-source.sh and run-spike.sh respectively.

Client-probe argv (main plan lines 263-264):
  probe.py --destination-url http://<host>:<port> \
           --expected-payload-hex <hex> --source-ipv4 <ipv4>

Self-test argv (annex section 1):
  probe.py --self-test
"""

import argparse
import binascii
import ipaddress
import json
import math
import re
import socket
import sys
import threading
import time
from urllib.parse import urlsplit

# Fixed reference payload, main plan lines 263-264: "DS005-Q8-ROUTER-OK\n"
FIXED_PAYLOAD_HEX = "44533030352d51382d524f555445522d4f4b0a"

RESULT_CONNECTED = "CONNECTED"
RESULT_CONNECTED_UNEXPECTED_PAYLOAD = "CONNECTED_UNEXPECTED_PAYLOAD"
RESULT_REFUSED = "REFUSED"
RESULT_TIMEOUT = "TIMEOUT"
RESULT_DNS_ERROR = "DNS_ERROR"
RESULT_ERROR = "ERROR"

DEFAULT_TIMEOUT_SECONDS = 3.0
READ_BYTES_MAX = 4096
DNS_LABEL_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$")


def hex_to_bytes(hex_str):
    hex_str = hex_str.strip().lower()
    if not hex_str or any(c not in "0123456789abcdef" for c in hex_str) or len(hex_str) % 2 != 0:
        raise ValueError(f"not a well-formed lowercase-hex string: {hex_str!r}")
    return binascii.unhexlify(hex_str)


def bytes_to_hex(data):
    return binascii.hexlify(data).decode("ascii")


def validate_ipv4(value):
    try:
        ipaddress.IPv4Address(value)
    except ValueError as exc:
        raise ValueError(f"not a valid IPv4 address: {value!r}") from exc
    return value


def validate_host(value):
    if not value or len(value) > 253:
        raise ValueError(f"not a valid destination host: {value!r}")
    if all(c.isdigit() or c == "." for c in value):
        validate_ipv4(value)
        return value
    labels = value.rstrip(".").split(".")
    if not labels or any(not DNS_LABEL_RE.fullmatch(label) for label in labels):
        raise ValueError(f"not a valid destination host: {value!r}")
    return value.lower()


def validate_port(value, *, allow_zero=False):
    if value is None:
        raise ValueError("port is required")
    if not isinstance(value, int):
        raise ValueError(f"port must be an integer: {value!r}")
    lower = 0 if allow_zero else 1
    if value < lower or value > 65535:
        raise ValueError(f"port out of range: {value!r}")
    return value


def parse_destination_url(destination_url):
    parts = urlsplit(destination_url)
    if parts.scheme != "http":
        raise ValueError(f"destination-url must use http scheme: {destination_url!r}")
    if parts.username or parts.password:
        raise ValueError("destination-url must not include userinfo")
    if parts.path or parts.query or parts.fragment:
        raise ValueError("destination-url must be exactly http://<host>:<port>")
    host = validate_host(parts.hostname or "")
    try:
        port = parts.port
    except ValueError as exc:
        raise ValueError(f"destination-url port is invalid: {destination_url!r}") from exc
    validate_port(port)
    return host, port, f"http://{host}:{port}"


def validate_timeout(value):
    if not math.isfinite(value) or value <= 0:
        raise ValueError(f"timeout must be finite and positive: {value!r}")
    return value


def probe_once(destination_url, expected_payload, source_ipv4, timeout_seconds=DEFAULT_TIMEOUT_SECONDS):
    """Connect to destination_url from source_ipv4, classify the result.

    Returns a dict: result, destination_url, source_ipv4, expected_payload_hex,
    actual_payload_hex, errno, detail. Never raises for expected network
    conditions (refused/timeout/dns/other) -- those are classifications, not
    exceptions. Malformed input (bad URL scheme, bad host) is a programmer
    error and does raise ValueError before any socket is touched.
    """
    host, port, normalized_url = parse_destination_url(destination_url)
    validate_ipv4(source_ipv4)
    validate_timeout(timeout_seconds)

    record = {
        "destination_url": normalized_url,
        "source_ipv4": source_ipv4,
        "expected_payload_hex": bytes_to_hex(expected_payload),
        "actual_payload_hex": "",
        "errno": None,
        "detail": "",
    }

    try:
        addr_infos = socket.getaddrinfo(host, port, family=socket.AF_INET, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        record["result"] = RESULT_DNS_ERROR
        record["detail"] = str(exc)
        return record

    family, socktype, proto, _canonname, sockaddr = addr_infos[0]
    sock = socket.socket(family, socktype, proto)
    sock.settimeout(timeout_seconds)
    try:
        sock.bind((source_ipv4, 0))
    except OSError as exc:
        sock.close()
        record["result"] = RESULT_ERROR
        record["errno"] = exc.errno
        record["detail"] = f"bind to source-ipv4 failed: {exc}"
        return record

    try:
        sock.connect(sockaddr)
    except socket.timeout:
        record["result"] = RESULT_TIMEOUT
        record["detail"] = "connect timed out"
        sock.close()
        return record
    except ConnectionRefusedError as exc:
        record["result"] = RESULT_REFUSED
        record["errno"] = exc.errno
        record["detail"] = str(exc)
        sock.close()
        return record
    except OSError as exc:
        record["result"] = RESULT_ERROR
        record["errno"] = exc.errno
        record["detail"] = str(exc)
        sock.close()
        return record

    try:
        data = b""
        deadline = time.monotonic() + timeout_seconds
        while len(data) < len(expected_payload) and time.monotonic() < deadline:
            sock.settimeout(max(0.01, deadline - time.monotonic()))
            try:
                chunk = sock.recv(READ_BYTES_MAX)
            except socket.timeout:
                break
            if not chunk:
                break
            data += chunk
    except OSError as exc:
        record["result"] = RESULT_ERROR
        record["errno"] = exc.errno
        record["detail"] = str(exc)
        sock.close()
        return record
    finally:
        sock.close()

    record["actual_payload_hex"] = bytes_to_hex(data)
    if data == expected_payload:
        record["result"] = RESULT_CONNECTED
    else:
        record["result"] = RESULT_CONNECTED_UNEXPECTED_PAYLOAD
        record["detail"] = "connected but payload did not match expectation"
    return record


class _ReferenceListener:
    """Reference server mode: on every connection, write the fixed payload and close."""

    def __init__(self, bind_ip, payload, port=0):
        bind_ip = validate_ipv4(bind_ip)
        port = validate_port(port, allow_zero=True)
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind((bind_ip, port))
        self._sock.listen(8)
        self._sock.settimeout(0.25)
        self.port = self._sock.getsockname()[1]
        self._payload = payload
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def _serve(self):
        while not self._stop.is_set():
            try:
                conn, _addr = self._sock.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            try:
                conn.sendall(self._payload)
            except OSError:
                pass
            finally:
                conn.close()

    def stop(self):
        self._stop.set()
        self._thread.join(timeout=2)
        self._sock.close()


class _DecoyListener:
    """Decoy server mode: accept and immediately close without sending payload."""

    def __init__(self, bind_ip, port=0):
        bind_ip = validate_ipv4(bind_ip)
        port = validate_port(port, allow_zero=True)
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind((bind_ip, port))
        self._sock.listen(8)
        self._sock.settimeout(0.25)
        self.port = self._sock.getsockname()[1]
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def _serve(self):
        while not self._stop.is_set():
            try:
                conn, _addr = self._sock.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            conn.close()

    def stop(self):
        self._stop.set()
        self._thread.join(timeout=2)
        self._sock.close()


def _find_closed_port(bind_ip):
    """Return a port on bind_ip that is guaranteed not to be listening."""
    probe_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe_sock.bind((bind_ip, 0))
    port = probe_sock.getsockname()[1]
    probe_sock.close()
    return port


def run_self_test():
    """Exercise reference/decoy listener modes and the client-probe classifier
    without any native/root/container dependency. Returns 0 on success."""
    bind_ip = "127.0.0.1"
    expected = hex_to_bytes(FIXED_PAYLOAD_HEX)
    assert bytes_to_hex(expected) == FIXED_PAYLOAD_HEX, "hex round-trip must be stable"
    assert expected == b"DS005-Q8-ROUTER-OK\n", "fixed payload must decode to the documented ASCII string"

    failures = []

    reference = _ReferenceListener(bind_ip, expected)
    decoy = _DecoyListener(bind_ip)
    closed_port = _find_closed_port(bind_ip)
    try:
        ref_result = probe_once(f"http://{bind_ip}:{reference.port}", expected, bind_ip, timeout_seconds=2.0)
        if ref_result["result"] != RESULT_CONNECTED:
            failures.append(f"reference listener expected CONNECTED, got {ref_result}")
        if ref_result["actual_payload_hex"] != FIXED_PAYLOAD_HEX:
            failures.append(f"reference listener payload mismatch: {ref_result}")

        decoy_result = probe_once(f"http://{bind_ip}:{decoy.port}", expected, bind_ip, timeout_seconds=2.0)
        if decoy_result["result"] != RESULT_CONNECTED_UNEXPECTED_PAYLOAD:
            failures.append(f"decoy listener expected CONNECTED_UNEXPECTED_PAYLOAD, got {decoy_result}")

        closed_result = probe_once(f"http://{bind_ip}:{closed_port}", expected, bind_ip, timeout_seconds=2.0)
        if closed_result["result"] != RESULT_REFUSED:
            failures.append(f"closed port expected REFUSED, got {closed_result}")
    finally:
        reference.stop()
        decoy.stop()

    try:
        validate_ipv4("127.0.0.1")
        bad = False
        try:
            validate_ipv4("not-an-ip")
            bad = True
        except ValueError:
            pass
        if bad:
            failures.append("validate_ipv4 must reject non-IPv4 input")
    except ValueError as exc:
        failures.append(f"validate_ipv4 rejected a valid address: {exc}")

    if failures:
        for f in failures:
            print(f"SELF-TEST FAILURE: {f}", file=sys.stderr)
        return 1

    print(json.dumps({"self_test": "ok"}))
    return 0


def build_arg_parser():
    parser = argparse.ArgumentParser(description="DS005-Q8 Candidate N TCP probe")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--self-test", action="store_true", help="run the local self-test suite and exit")
    mode.add_argument("--destination-url", help="http://<host>:<port> destination to probe")
    mode.add_argument("--listen-reference", action="store_true", help="run as a reference listener (foreground)")
    mode.add_argument("--listen-decoy", action="store_true", help="run as a decoy listener (foreground)")
    parser.add_argument("--expected-payload-hex", default=FIXED_PAYLOAD_HEX)
    parser.add_argument("--source-ipv4", help="source IPv4 address to bind before connecting")
    parser.add_argument("--bind", default="127.0.0.1", help="bind address for --listen-reference/--listen-decoy")
    parser.add_argument("--port", type=int, help="bind port for --listen-reference/--listen-decoy")
    parser.add_argument("--timeout-seconds", type=float, default=DEFAULT_TIMEOUT_SECONDS)
    return parser


def main(argv):
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    if args.self_test:
        return run_self_test()

    if args.listen_reference or args.listen_decoy:
        try:
            bind_ip = validate_ipv4(args.bind)
            listener_port = validate_port(args.port if args.port is not None else 0, allow_zero=True)
            expected_payload = hex_to_bytes(args.expected_payload_hex)
        except ValueError as exc:
            print(f"ERROR: {exc}", file=sys.stderr)
            return 2
        if args.listen_reference:
            listener = _ReferenceListener(bind_ip, expected_payload, port=listener_port)
        else:
            listener = _DecoyListener(bind_ip, port=listener_port)
        print(json.dumps({"listening": True, "bind": bind_ip, "port": listener.port}))
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
        finally:
            listener.stop()
        return 0

    if not args.destination_url or not args.source_ipv4:
        print("ERROR: --destination-url and --source-ipv4 are required for a client probe", file=sys.stderr)
        return 2

    try:
        validate_ipv4(args.source_ipv4)
        expected_payload = hex_to_bytes(args.expected_payload_hex)
        validate_timeout(args.timeout_seconds)
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    try:
        result = probe_once(args.destination_url, expected_payload, args.source_ipv4, args.timeout_seconds)
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(result))
    return 0 if result["result"] in (RESULT_CONNECTED, RESULT_REFUSED) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
