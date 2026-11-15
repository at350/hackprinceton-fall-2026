"""HTTP face of the device bridge, for the dashboard (browser) and the agent's read_scan.

    GET  /status            is a probe there, is it calibrated, where the scan stands
    GET  /samples?since=N   calibrated samples after sequence N, for the live charts
    GET  /scan              the spots captured so far, and whether all 8 are in
    POST /scan/start        begin a scan; body {"spots": [5, 6]} reads only those spots again
    POST /calibrate         take the last two seconds as the healthy reference

Standard library only. Bound to localhost; CORS is open because the dashboard is on another port.
"""
from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from .bridge import Bridge

DEFAULT_PORT = 2025


def make_handler(bridge: Bridge) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_: object) -> None:  # quiet: the charts poll several times a second
            pass

        def _send(self, code: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def _body(self) -> dict:
            n = int(self.headers.get("Content-Length") or 0)
            if not n:
                return {}
            got = json.loads(self.rfile.read(n) or b"{}")
            return got if isinstance(got, dict) else {}

        def do_OPTIONS(self) -> None:
            self._send(204, {})

        def do_GET(self) -> None:
            url = urlparse(self.path)
            if url.path == "/status":
                return self._send(200, bridge.status())
            if url.path == "/samples":
                q = parse_qs(url.query)
                try:
                    since = int(q.get("since", ["0"])[0])
                except ValueError:
                    since = 0
                return self._send(200, {"samples": bridge.samples(since)})
            if url.path == "/scan":
                return self._send(200, bridge.scan())
            self._send(404, {"error": "Not found"})

        def do_POST(self) -> None:
            url = urlparse(self.path)
            try:
                body = self._body()
                if url.path == "/scan/start":
                    spots = body.get("spots")
                    if spots is not None and not (isinstance(spots, list) and all(isinstance(s, int) for s in spots)):
                        raise ValueError("spots must be a list of spot numbers.")
                    return self._send(200, bridge.start_scan(spots))
                if url.path == "/calibrate":
                    cal = bridge.calibrate()
                    return self._send(200, {"taken_at": cal.taken_at, "coil_v_ref": cal.coil_v_ref, "nir_v_ref": cal.nir_v_ref, "samples": cal.samples})
            except (ValueError, json.JSONDecodeError) as e:
                return self._send(409, {"error": str(e)})
            self._send(404, {"error": "Not found"})

    return Handler


def serve(bridge: Bridge, port: int = DEFAULT_PORT, host: str = "127.0.0.1") -> ThreadingHTTPServer:
    return ThreadingHTTPServer((host, port), make_handler(bridge))
