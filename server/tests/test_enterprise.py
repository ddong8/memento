"""Enterprise deployment: admin scope, model endpoint policy, encrypted keys, audit, SSO, SCIM."""

from __future__ import annotations

import json
import sys
import time
import unittest
import uuid
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))

from fastapi import HTTPException  # noqa: E402

from server.config import settings  # noqa: E402
from server.db.models import AccessLog, Machine, User  # noqa: E402
from server.services import enterprise_policy, secret_box  # noqa: E402


def _user(role="viewer", status="active", email=None, **kw) -> User:
    return User(id=uuid.uuid4(), email=email or f"{uuid.uuid4().hex[:6]}@corp.example.com", role=role,
                status=status, created_at=datetime.now(timezone.utc), **kw)


def _db() -> MagicMock:
    db = MagicMock()
    db.commit = AsyncMock()
    db.flush = AsyncMock()
    db.rollback = AsyncMock()
    db.refresh = AsyncMock()
    db.execute = AsyncMock()
    db.get = AsyncMock()
    return db


def _scalar(value) -> MagicMock:
    r = MagicMock()
    r.scalar_one_or_none.return_value = value
    r.scalars.return_value.first.return_value = value
    r.scalars.return_value.all.return_value = [value] if value is not None else []
    r.scalar_one.return_value = value
    return r


class AdminScopeTests(unittest.IsolatedAsyncioTestCase):
    def test_admins_see_everyone_by_default_and_only_their_own_under_own(self):
        admin, owner, viewer = _user("admin"), _user("owner"), _user("viewer")
        with patch.object(settings, "admin_scope", "all"):
            self.assertTrue(enterprise_policy.sees_all(admin))
            self.assertTrue(enterprise_policy.sees_all(owner))
            self.assertFalse(enterprise_policy.sees_all(viewer))
        with patch.object(settings, "admin_scope", "own"):
            self.assertFalse(enterprise_policy.sees_all(admin))
            self.assertFalse(enterprise_policy.sees_all(owner))
            # still manages the deployment
            self.assertTrue(enterprise_policy.is_admin(admin))

    async def test_under_own_an_admins_device_filter_is_their_own_devices(self):
        from server.services.user_filter import user_machine_ids
        admin = _user("admin")
        mine = uuid.uuid4()
        db = _db()
        res = MagicMock()
        res.all.return_value = [(mine,)]
        db.execute.return_value = res
        with patch.object(settings, "admin_scope", "all"):
            self.assertIsNone(await user_machine_ids(db, admin))
        with patch.object(settings, "admin_scope", "own"):
            self.assertEqual(await user_machine_ids(db, admin), [mine])

    async def test_under_own_an_admin_cant_send_commands_to_someone_elses_device(self):
        from server.api.tasks import _authorize_device
        admin = _user("admin")
        theirs = Machine(id=uuid.uuid4(), name="their-laptop", user_id=uuid.uuid4(), is_archived=False)
        db = _db()
        db.execute.return_value = _scalar(theirs)
        with patch.object(settings, "admin_scope", "own"):
            with self.assertRaises(HTTPException) as cm:
                await _authorize_device(db, "their-laptop", admin)
            self.assertEqual(cm.exception.status_code, 404)
        with patch.object(settings, "admin_scope", "all"):
            self.assertIs(await _authorize_device(db, "their-laptop", admin), theirs)

    async def test_under_own_the_user_list_doesnt_hand_out_other_peoples_collector_tokens(self):
        from server.api.admin import list_users
        admin = _user("admin", collector_token="a" * 64)
        other = _user("viewer", collector_token="b" * 64)
        db = _db()
        res = MagicMock()
        res.scalars.return_value.all.return_value = [admin, other]
        db.execute.return_value = res
        with patch.object(settings, "admin_scope", "own"):
            rows = {r["id"]: r for r in await list_users(_user=admin, db=db)}
        self.assertEqual(rows[str(admin.id)]["collector_token"], "a" * 64)
        self.assertIsNone(rows[str(other.id)]["collector_token"])

    async def test_a_disabled_accounts_collector_token_stops_working(self):
        from server.middleware.auth import verify_collector_token
        db = _db()
        db.execute.return_value = _scalar(_user("viewer", status="disabled", collector_token="t" * 64))
        with self.assertRaises(HTTPException) as cm:
            await verify_collector_token("t" * 64, db)
        self.assertEqual(cm.exception.status_code, 401)


class ModelEndpointPolicyTests(unittest.TestCase):
    def test_any_endpoint_when_unrestricted(self):
        with patch.object(settings, "allowed_model_hosts", ""):
            self.assertIsNone(enterprise_policy.model_endpoint_violation({"base_url": "https://api.x.com/v1"}))

    def test_only_listed_hosts_and_subdomains_of_a_wildcard(self):
        with patch.object(settings, "allowed_model_hosts", "llm.corp.example.com, *.ai.example.com"):
            ok = enterprise_policy.model_endpoint_violation
            self.assertIsNone(ok({"base_url": "https://llm.corp.example.com/v1"}))
            self.assertIsNone(ok({"base_url": "https://gpu1.ai.example.com/v1"}))
            self.assertIsNone(ok({"base_url": "https://ai.example.com"}))
            self.assertIn("api.openai.com", ok({"base_url": "https://api.openai.com/v1"}))
            self.assertIsNotNone(ok({"base_url": "https://llm.corp.example.com", "fallback_base_url": "https://evil.example.net"}))
            # a lookalike isn't a subdomain
            self.assertIsNotNone(ok({"base_url": "https://notai.example.com"}))

    def test_a_users_own_endpoint_outside_the_allowed_ones_isnt_used(self):
        from server.services.ai_provider import get_ai_providers
        user_settings = {"custom_enabled": True, "base_url": "https://api.openai.com/v1", "api_key": "sk-x", "model": "m"}
        with patch.object(settings, "allowed_model_hosts", "llm.corp.example.com"):
            names = [p.name for p in get_ai_providers(custom_settings=user_settings)]
        self.assertNotIn("user_custom", names)
        with patch.object(settings, "allowed_model_hosts", ""):
            names = [p.name for p in get_ai_providers(custom_settings=user_settings)]
        self.assertIn("user_custom", names)


class SecretBoxTests(unittest.IsolatedAsyncioTestCase):
    def test_seal_reveal_roundtrip_and_plaintext_passthrough(self):
        sealed = secret_box.seal("sk-live-123")
        self.assertTrue(sealed.startswith("enc:v1:"))
        self.assertNotIn("sk-live-123", sealed)
        self.assertEqual(secret_box.reveal(sealed), "sk-live-123")
        self.assertEqual(secret_box.seal(sealed), sealed)
        self.assertEqual(secret_box.reveal("sk-old-plain"), "sk-old-plain")
        self.assertEqual(secret_box.seal(""), "")

    def test_a_changed_key_reads_as_no_key_instead_of_failing(self):
        sealed = secret_box.seal("sk-live-123")
        with patch.object(settings, "data_key", "another-key"):
            self.assertEqual(secret_box.reveal(sealed), "")

    async def test_saving_model_settings_stores_the_key_encrypted_and_never_returns_it(self):
        from server.api.llm import LLMSettingsBody, get_llm_settings, update_llm_settings
        user = _user("viewer", llm_settings={})
        db = _db()
        body = LLMSettingsBody(custom_enabled=True, base_url="https://llm.corp.example.com/v1",
                               api_key="sk-secret-value-9999", model="corp-model")
        with patch.object(settings, "allowed_model_hosts", ""):
            resp = await update_llm_settings(body, db=db, user=user)
        stored = user.llm_settings["api_key"]
        self.assertTrue(stored.startswith("enc:v1:"))
        self.assertNotIn("sk-secret-value-9999", json.dumps(resp, ensure_ascii=False))
        self.assertEqual(secret_box.reveal(stored), "sk-secret-value-9999")
        got = await get_llm_settings(user=user)
        self.assertTrue(got["has_api_key"])
        self.assertNotIn("sk-secret-value-9999", json.dumps(got, ensure_ascii=False))
        # the model call gets the real key
        from server.services.ai_provider import get_ai_providers
        p = next(p for p in get_ai_providers(user=user) if p.name == "user_custom")
        self.assertEqual(p.api_key, "sk-secret-value-9999")

    async def test_saving_an_endpoint_the_deployment_doesnt_allow_is_refused(self):
        from server.api.llm import LLMSettingsBody, update_llm_settings
        user = _user("viewer", llm_settings={})
        body = LLMSettingsBody(custom_enabled=True, base_url="https://api.openai.com/v1", api_key="k", model="m")
        with patch.object(settings, "allowed_model_hosts", "llm.corp.example.com"):
            with self.assertRaises(HTTPException) as cm:
                await update_llm_settings(body, db=_db(), user=user)
        self.assertEqual(cm.exception.status_code, 403)
        self.assertEqual(user.llm_settings, {})


class AuditTests(unittest.IsolatedAsyncioTestCase):
    async def test_an_entry_records_actor_target_and_details(self):
        from server.services import audit_service
        actor, target = _user("admin"), uuid.uuid4()
        db = _db()
        await audit_service.record(db, actor, "admin.user.update", target_user_id=target, detail={"after": {"role": "admin"}})
        entry = db.add.call_args[0][0]
        self.assertIsInstance(entry, AccessLog)
        self.assertEqual(entry.user_id, actor.id)
        self.assertEqual(entry.action, "admin.user.update")
        self.assertEqual(entry.metadata_["target_user_id"], str(target))
        self.assertTrue(entry.metadata_["audit"])
        self.assertEqual(entry.metadata_["actor_email"], actor.email)

    async def test_recording_never_breaks_the_action(self):
        from server.services import audit_service
        db = _db()
        db.flush.side_effect = RuntimeError("db down")
        await audit_service.record(db, _user(), "auth.login")  # no exception

    async def test_changing_a_role_is_audited(self):
        from server.api.admin import UserUpdateRequest, update_user
        caller, target = _user("owner"), _user("viewer")
        db = _db()
        db.execute.return_value = _scalar(target)
        await update_user(target.id, UserUpdateRequest(role="admin"), caller=caller, db=db)
        entry = db.add.call_args[0][0]
        self.assertEqual(entry.action, "admin.user.update")
        self.assertEqual(entry.metadata_["before"]["role"], "viewer")
        self.assertEqual(entry.metadata_["after"]["role"], "admin")


class PasswordLoginTests(unittest.IsolatedAsyncioTestCase):
    async def test_with_password_login_off_only_the_owner_still_signs_in_with_a_password(self):
        from server.api import auth as auth_api
        from server.middleware.auth import hash_password
        req = MagicMock()
        req.client.host = "10.0.0.1"
        req.headers = {}
        pw = hash_password("pw-123456")
        for role, allowed in (("viewer", False), ("admin", False), ("owner", True)):
            u = _user(role, hashed_password=pw)
            db = _db()
            db.execute.return_value = _scalar(u)
            with patch.object(settings, "password_login", False), \
                    patch.object(auth_api.rate_limit, "check", AsyncMock()), \
                    patch.object(auth_api.rate_limit, "hit", AsyncMock()), \
                    patch.object(auth_api.rate_limit, "reset", AsyncMock()):
                if allowed:
                    tok = await auth_api.login(auth_api.LoginRequest(email=u.email, password="pw-123456"), req, db)
                    self.assertTrue(tok.access_token)
                else:
                    with self.assertRaises(HTTPException) as cm:
                        await auth_api.login(auth_api.LoginRequest(email=u.email, password="pw-123456"), req, db)
                    self.assertEqual(cm.exception.status_code, 403)


def _rsa():
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from jose import jwk
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    priv = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                             serialization.NoEncryption()).decode()
    pub = key.public_key().public_bytes(serialization.Encoding.PEM,
                                        serialization.PublicFormat.SubjectPublicKeyInfo).decode()
    public_jwk = jwk.construct(pub, "RS256").to_dict()
    public_jwk.update({"kid": "k1", "use": "sig", "alg": "RS256"})
    return priv, public_jwk


class SsoTests(unittest.IsolatedAsyncioTestCase):
    ISSUER = "https://idp.corp.example.com/realms/corp"

    def setUp(self):
        from server.api import sso
        sso._cache.clear()
        self.patches = [
            patch.object(settings, "oidc_issuer", self.ISSUER),
            patch.object(settings, "oidc_client_id", "memento"),
            patch.object(settings, "oidc_client_secret", "s3cret"),
            patch.object(settings, "oidc_allowed_domains", "corp.example.com"),
            patch.object(settings, "oidc_admin_group", "memento-admins"),
            patch.object(settings, "oidc_auto_create", True),
            patch.object(settings, "public_url", "https://mem.corp.example.com"),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()

    async def test_first_sign_in_creates_the_account_with_the_role_of_its_group(self):
        from server.api.sso import resolve_user
        db = _db()
        db.execute.side_effect = [_scalar(None), _scalar(None), _scalar(None), _scalar(uuid.uuid4())]
        user, err = await resolve_user(db, {"sub": "u1", "email": "Li.Lei@corp.example.com", "name": "李雷",
                                            "groups": ["memento-admins"]})
        self.assertIsNone(err)
        self.assertEqual(user.email, "li.lei@corp.example.com")
        self.assertEqual(user.role, "admin")
        self.assertEqual(user.oidc_subject, f"{self.ISSUER}|u1")
        self.assertEqual(user.status, "active")

    async def test_other_email_domains_are_turned_away(self):
        from server.api.sso import resolve_user
        user, err = await resolve_user(_db(), {"sub": "u2", "email": "x@gmail.com", "email_verified": True})
        self.assertIsNone(user)
        self.assertEqual(err, "sso_domain_not_allowed")

    async def test_an_existing_account_is_linked_by_a_vouched_email_and_its_role_follows_the_groups(self):
        from server.api.sso import resolve_user
        existing = _user("admin", email="han.mei@corp.example.com")
        db = _db()
        db.execute.side_effect = [_scalar(None), _scalar(existing)]
        user, err = await resolve_user(db, {"sub": "u3", "email": "han.mei@corp.example.com", "groups": []})
        self.assertIs(user, existing)
        self.assertEqual(user.oidc_subject, f"{self.ISSUER}|u3")
        self.assertEqual(user.role, "viewer")  # left the admin group

    async def test_a_disabled_account_cant_sign_in(self):
        from server.api.sso import resolve_user
        db = _db()
        db.execute.side_effect = [_scalar(_user("viewer", status="disabled"))]
        user, err = await resolve_user(db, {"sub": "u4", "email": "a@corp.example.com"})
        self.assertIsNone(user)
        self.assertEqual(err, "account_disabled")

    async def test_the_owner_keeps_owner_whatever_the_groups(self):
        from server.api.sso import resolve_user
        owner = _user("owner")
        db = _db()
        db.execute.side_effect = [_scalar(owner)]
        user, _ = await resolve_user(db, {"sub": "u5", "email": owner.email, "groups": []})
        self.assertEqual(user.role, "owner")

    async def test_full_code_flow_verifies_signature_nonce_and_pkce(self):
        import httpx
        from jose import jwt
        from server.api import sso

        priv, public_jwk = _rsa()
        seen: dict = {}
        state = sso.make_state("/ask")
        n = sso.read_state(state)["n"]

        def handler(request: httpx.Request) -> httpx.Response:
            url = str(request.url)
            if url.endswith("/.well-known/openid-configuration"):
                return httpx.Response(200, json={
                    "issuer": self.ISSUER,
                    "authorization_endpoint": f"{self.ISSUER}/auth",
                    "token_endpoint": f"{self.ISSUER}/token",
                    "jwks_uri": f"{self.ISSUER}/certs",
                    "userinfo_endpoint": f"{self.ISSUER}/userinfo",
                })
            if url.endswith("/certs"):
                return httpx.Response(200, json={"keys": [public_jwk]})
            if url.endswith("/token"):
                form = dict(x.split("=", 1) for x in request.content.decode().split("&"))
                seen["verifier"] = form["code_verifier"]
                now = int(time.time())
                id_token = jwt.encode({
                    "iss": self.ISSUER, "aud": "memento", "sub": "emp-42", "iat": now, "exp": now + 300,
                    "nonce": seen.get("nonce", sso._nonce(n)), "email": "wang@corp.example.com",
                    "name": "王五", "groups": ["staff"],
                }, priv, algorithm="RS256", headers={"kid": "k1"})
                return httpx.Response(200, json={"id_token": id_token, "token_type": "Bearer"})
            return httpx.Response(404)

        real = httpx.AsyncClient
        transport = httpx.MockTransport(handler)
        with patch.object(sso.httpx, "AsyncClient", lambda **kw: real(transport=transport, **kw)):
            req = MagicMock()
            req.base_url = "https://mem.corp.example.com/"
            claims = await sso._exchange(req, "the-code", n)
            self.assertEqual(claims["sub"], "emp-42")
            # PKCE: the verifier sent matches the challenge the authorize step put in the URL
            self.assertEqual(sso._challenge(seen["verifier"]), sso._challenge(sso._verifier(n)))
            # a token minted for another login attempt (other nonce) is refused
            seen["nonce"] = "someone-elses"
            with self.assertRaises(ValueError):
                await sso._exchange(req, "the-code", n)

    def test_state_is_signed_and_expires(self):
        from server.api import sso
        state = sso.make_state("/x")
        self.assertEqual(sso.read_state(state)["next"], "/x")
        payload, sig = state.split(".", 1)
        self.assertIsNone(sso.read_state(payload + "." + "0" * len(sig)))
        with patch.object(sso.time, "time", return_value=time.time() + sso.STATE_TTL + 5):
            self.assertIsNone(sso.read_state(state))


class ScimTests(unittest.IsolatedAsyncioTestCase):
    async def test_requests_without_the_token_are_refused(self):
        from server.api.scim import require_scim
        with patch.object(settings, "scim_token", "tok"):
            with self.assertRaises(HTTPException) as cm:
                await require_scim("Bearer wrong")
            self.assertEqual(cm.exception.status_code, 401)
            await require_scim("Bearer tok")
        with patch.object(settings, "scim_token", ""):
            with self.assertRaises(HTTPException) as cm:
                await require_scim("Bearer tok")
            self.assertEqual(cm.exception.status_code, 404)

    async def _patch(self, user: User, body: dict):
        from server.api.scim import patch_user
        db = _db()
        db.get.return_value = user
        db.execute.return_value = _scalar(None)
        req = MagicMock()
        req.json = AsyncMock(return_value=body)
        req.url_for.return_value = "https://x/api/scim/v2/Users/1"
        return await patch_user(str(user.id), req, db)

    async def test_deactivating_disables_the_account_without_deleting_it(self):
        u = _user("viewer")
        await self._patch(u, {"schemas": [], "Operations": [{"op": "replace", "path": "active", "value": False}]})
        self.assertEqual(u.status, "disabled")
        # Azure AD style: value object, string boolean
        u2 = _user("viewer", status="disabled")
        await self._patch(u2, {"Operations": [{"op": "Replace", "value": {"active": "True"}}]})
        self.assertEqual(u2.status, "active")

    async def test_delete_only_disables(self):
        from server.api.scim import delete_user
        u = _user("viewer")
        db = _db()
        db.get.return_value = u
        resp = await delete_user(str(u.id), db)
        self.assertEqual(resp.status_code, 204)
        self.assertEqual(u.status, "disabled")
        db.delete.assert_not_called()

    async def test_the_only_owner_cant_be_deactivated(self):
        u = _user("owner")
        with self.assertRaises(HTTPException) as cm:
            await self._patch(u, {"Operations": [{"op": "replace", "path": "active", "value": False}]})
        self.assertEqual(cm.exception.status_code, 400)
        self.assertEqual(u.status, "active")

    async def test_create_makes_an_active_viewer_and_refuses_duplicates(self):
        from server.api.scim import create_user
        db = _db()
        db.execute.return_value = _scalar(None)
        req = MagicMock()
        req.json = AsyncMock(return_value={"userName": "Zhao@Corp.example.com", "displayName": "赵六", "active": True})
        req.url_for.return_value = "https://x/api/scim/v2/Users/1"

        async def refresh(u):
            u.created_at = u.created_at or datetime.now(timezone.utc)
        db.refresh.side_effect = refresh
        resp = await create_user(req, db)
        self.assertEqual(resp.status_code, 201)
        created = db.add.call_args_list[0][0][0]
        self.assertEqual((created.email, created.role, created.status), ("zhao@corp.example.com", "viewer", "active"))
        db.execute.return_value = _scalar(created)
        with self.assertRaises(HTTPException) as cm:
            await create_user(req, db)
        self.assertEqual(cm.exception.status_code, 409)


if __name__ == "__main__":
    unittest.main()
