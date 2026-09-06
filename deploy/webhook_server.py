#!/usr/bin/env python3
"""GitHub webhook receiver -> triggers /opt/consultancy/deploy/auto_deploy.sh"""
import hmac, hashlib, subprocess, os
from http.server import HTTPServer, BaseHTTPRequestHandler

SECRET = open("/opt/consultancy/deploy/webhook_secret").read().strip()
REPO = "bankithung/ConsultancyDev"
DEPLOY_SCRIPT = "/opt/consultancy/deploy/auto_deploy.sh"


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/webhook":
            self.send_response(404); self.end_headers(); return
        body = b""
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)

        sig = self.headers.get("X-Hub-Signature-256", "")
        expected = "sha256=" + hmac.new(SECRET.encode(), body, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected):
            self.send_response(403); self.end_headers(); return
        if self.headers.get("X-GitHub-Event") == "ping":
            self.send_response(200); self.end_headers(); return
        if self.headers.get("X-GitHub-Event") != "push":
            self.send_response(200); self.end_headers(); return
        if f'"{REPO}"' not in body.decode(errors="ignore"):
            self.send_response(200); self.end_headers(); return

        # fire-and-forget: deploy script has its own lock + logging
        subprocess.Popen(
            [DEPLOY_SCRIPT],
            stdout=open("/var/log/consultancy-autodeploy.log", "a"),
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        self.send_response(202)
        self.end_headers()
        self.wfile.write(b"deploy triggered")

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", 9000), Handler).serve_forever()
