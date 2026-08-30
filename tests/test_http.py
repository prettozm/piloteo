"""Tests d'intégration HTTP de bout en bout.

Démarre une vraie instance ThreadingHTTPServer sur une base temporaire et
exerce les points d'entrée réels : login, CSRF, session, /api/state,
endpoints admin. Complète les tests unitaires de test_sync.py.
"""
import http.client
import json
import os
import tempfile
import threading
import unittest

_TMP = tempfile.mkdtemp(prefix="piloteo-http-")
os.environ["PILOTEO_DATA_DIR"] = _TMP
os.environ["PILOTEO_BACKUP_DIR"] = _TMP + "/backups"
os.environ["PILOTEO_ADMIN_USERNAME"] = "admin"
os.environ["PILOTEO_ADMIN_PASSWORD"] = "mot-de-passe-de-test-long"
os.environ["PILOTEO_ADMIN_CONSULTANT_ID"] = "SMR"
os.environ["PILOTEO_ADMIN_NAME"] = "Admin Test"

import server  # noqa: E402
from http.server import ThreadingHTTPServer  # noqa: E402

ADMIN_PW = "mot-de-passe-de-test-long"


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        server.init_db()
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.PilotHandler)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def call(self, method, path, body=None, headers=None, cookie=None, raw_body=None, ctype="application/json"):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        h = dict(headers or {})
        if cookie:
            h["Cookie"] = cookie
        if raw_body is not None:
            h["Content-Type"] = ctype
            data = raw_body
        elif body is not None:
            h.setdefault("Content-Type", "application/json")
            data = json.dumps(body).encode()
        else:
            data = None
        c.request(method, path, body=data, headers=h)
        r = c.getresponse()
        payload = r.read().decode()
        setcookie = r.getheader("Set-Cookie")
        c.close()
        try:
            parsed = json.loads(payload) if payload else {}
        except json.JSONDecodeError:
            parsed = {}
        return r.status, parsed, setcookie

    def login(self):
        st, body, sc = self.call("POST", "/api/login", {"username": "admin", "password": ADMIN_PW})
        self.assertEqual(st, 200)
        cookie = sc.split(";")[0]
        return cookie, body["user"]["csrf_token"]

    # --- authentification ---
    def test_health_no_auth(self):
        st, body, _ = self.call("GET", "/api/health")
        self.assertEqual(st, 200)
        self.assertEqual(body["status"], "ok")

    def test_login_success_sets_httponly_cookie(self):
        st, body, sc = self.call("POST", "/api/login", {"username": "admin", "password": ADMIN_PW})
        self.assertEqual(st, 200)
        self.assertIn("HttpOnly", sc)
        self.assertIn("SameSite=Lax", sc)
        self.assertEqual(body["user"]["role"], "admin")

    def test_login_wrong_password(self):
        st, _, _ = self.call("POST", "/api/login", {"username": "admin", "password": "faux"})
        self.assertEqual(st, 401)

    def test_login_unknown_user(self):
        st, _, _ = self.call("POST", "/api/login", {"username": "fantome", "password": "faux"})
        self.assertEqual(st, 401)

    def test_login_rejects_non_json_content_type(self):
        st, _, _ = self.call("POST", "/api/login", raw_body=b'{"username":"admin","password":"x"}', ctype="text/plain")
        self.assertEqual(st, 400)

    def test_me_requires_auth(self):
        st, _, _ = self.call("GET", "/api/me")
        self.assertEqual(st, 401)

    def test_me_with_session(self):
        cookie, _ = self.login()
        st, body, _ = self.call("GET", "/api/me", cookie=cookie)
        self.assertEqual(st, 200)
        self.assertEqual(body["user"]["username"], "admin")

    # --- CSRF ---
    def test_state_put_without_csrf_forbidden(self):
        cookie, _ = self.login()
        st, _, _ = self.call("PUT", "/api/state", {"base_revision": 1, "state": {}}, cookie=cookie)
        self.assertEqual(st, 403)

    def test_state_put_with_wrong_csrf_forbidden(self):
        cookie, _ = self.login()
        st, _, _ = self.call("PUT", "/api/state", {"base_revision": 1, "state": {}}, {"X-CSRF-Token": "faux"}, cookie=cookie)
        self.assertEqual(st, 403)

    # --- state ---
    def test_state_returns_revision_and_data(self):
        cookie, _ = self.login()
        st, body, _ = self.call("GET", "/api/state", cookie=cookie)
        self.assertEqual(st, 200)
        self.assertIn("revision", body)
        self.assertTrue(body["changed"])
        self.assertIn("consultants", body["state"])

    def test_state_if_revision_short_circuit(self):
        cookie, _ = self.login()
        _, body, _ = self.call("GET", "/api/state", cookie=cookie)
        rev = body["revision"]
        st, body2, _ = self.call("GET", f"/api/state?if_revision={rev}", cookie=cookie)
        self.assertEqual(st, 200)
        self.assertFalse(body2["changed"])

    def test_state_if_revision_non_integer_is_safe(self):
        cookie, _ = self.login()
        st, _, _ = self.call("GET", "/api/state?if_revision=abc", cookie=cookie)
        self.assertEqual(st, 200)

    # --- admin ---
    def test_admin_users_requires_admin(self):
        st, _, _ = self.call("GET", "/api/admin/users")
        self.assertEqual(st, 401)

    def test_admin_can_list_users(self):
        cookie, _ = self.login()
        st, body, _ = self.call("GET", "/api/admin/users", cookie=cookie)
        self.assertEqual(st, 200)
        self.assertTrue(any(u["username"] == "admin" for u in body["users"]))

    def test_admin_create_user_short_password_rejected(self):
        cookie, csrf = self.login()
        st, _, _ = self.call("POST", "/api/admin/users",
                             {"username": "bob", "display_name": "Bob", "consultant_id": "SMR", "role": "user", "password": "court"},
                             {"X-CSRF-Token": csrf}, cookie=cookie)
        self.assertEqual(st, 400)

    def test_admin_cannot_deactivate_self(self):
        cookie, csrf = self.login()
        _, body, _ = self.call("GET", "/api/me", cookie=cookie)
        uid = body["user"]["id"]
        st, _, _ = self.call("PATCH", f"/api/admin/users/{uid}", {"active": False}, {"X-CSRF-Token": csrf}, cookie=cookie)
        self.assertEqual(st, 400)

    def test_admin_manual_backup(self):
        cookie, csrf = self.login()
        st, body, _ = self.call("POST", "/api/admin/backup", {}, {"X-CSRF-Token": csrf}, cookie=cookie)
        self.assertEqual(st, 200)
        self.assertTrue(body["file"].endswith(".sqlite3"))

    def test_logout_clears_session(self):
        cookie, csrf = self.login()
        st, _, sc = self.call("POST", "/api/logout", {}, {"X-CSRF-Token": csrf}, cookie=cookie)
        self.assertEqual(st, 200)
        self.assertIn("Max-Age=0", sc)
        st2, _, _ = self.call("GET", "/api/me", cookie=cookie)
        self.assertEqual(st2, 401)

    # --- static & 404 ---
    def test_index_served(self):
        st, _, _ = self.call("GET", "/")
        self.assertEqual(st, 200)

    def test_support_requires_admin(self):
        st, _, _ = self.call("GET", "/support")
        self.assertEqual(st, 401)

    def test_unknown_path_404(self):
        st, _, _ = self.call("GET", "/api/inexistant")
        self.assertEqual(st, 404)

    def test_security_headers_present(self):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("GET", "/api/health")
        r = c.getresponse()
        r.read()
        self.assertEqual(r.getheader("X-Content-Type-Options"), "nosniff")
        self.assertEqual(r.getheader("X-Frame-Options"), "DENY")
        self.assertIsNotNone(r.getheader("Content-Security-Policy"))
        c.close()

    def test_csp_script_src_has_no_unsafe_inline(self):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("GET", "/")
        r = c.getresponse(); r.read()
        csp = r.getheader("Content-Security-Policy")
        c.close()
        # script-src doit être 'self' sans 'unsafe-inline' (défense en profondeur XSS)
        script_src = next(d for d in csp.split(";") if d.strip().startswith("script-src"))
        self.assertIn("'self'", script_src)
        self.assertNotIn("unsafe-inline", script_src)

    def test_app_js_served_as_javascript(self):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("GET", "/app.js")
        r = c.getresponse(); body = r.read()
        c.close()
        self.assertEqual(r.status, 200)
        self.assertIn("javascript", r.getheader("Content-Type"))
        self.assertTrue(len(body) > 1000)

    def test_support_js_requires_admin(self):
        st, _, _ = self.call("GET", "/support.js")
        self.assertEqual(st, 401)

    def test_favicon_no_content(self):
        st, _, _ = self.call("GET", "/favicon.ico")
        self.assertEqual(st, 204)

    # --- white-label ---
    def test_org_name_injected_in_index(self):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("GET", "/")
        r = c.getresponse(); body = r.read().decode()
        c.close()
        # le placeholder ne doit jamais fuiter ; la marque par défaut est injectée
        self.assertNotIn("{{PILOTEO_ORG_NAME}}", body)
        self.assertIn(server.ORG_NAME, body)

    def test_brand_logo_served_with_default(self):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("GET", "/brand-logo")
        r = c.getresponse(); body = r.read()
        c.close()
        self.assertEqual(r.status, 200)
        self.assertIn("image/svg", r.getheader("Content-Type"))
        self.assertTrue(body.startswith(b"<svg"))

    def test_health_reports_version(self):
        st, body, _ = self.call("GET", "/api/health")
        self.assertEqual(st, 200)
        self.assertEqual(body.get("version"), server.APP_VERSION)


if __name__ == "__main__":
    unittest.main()
