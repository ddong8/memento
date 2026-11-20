"""插件市场 (Plugin Marketplace)：按需安装、配置加密、连通性隔离与未安装屏蔽测试。"""

from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from server.api.plugins import (
    PluginConfigReq,
    PluginInstallReq,
    install_plugin,
    list_plugins,
    uninstall_plugin,
    update_plugin_config,
)
from server.api.studio import studio_health
from server.services.plugin_service import (
    get_user_plugins_payload,
    is_plugin_ready,
    resolve_studio_connection,
    resolve_wechat_connection,
)
from server.services.secret_box import is_sealed


def _make_user(plugin_settings: dict | None = None):
    return SimpleNamespace(id="u-plugin-1", role="viewer", plugin_settings=dict(plugin_settings or {}))


class TestPluginMarketplace(unittest.IsolatedAsyncioTestCase):
    async def test_uninstalled_plugins_are_hidden_and_blocked_for_self_hosted(self):
        user = _make_user()
        with patch("server.services.plugin_service.settings.studio_filmkit_url", "http://127.0.0.1:8765"), \
             patch("server.services.plugin_service.settings.studio_filmkit_token", ""):
            payload = await list_plugins(user=user)
            by_id = {p["id"]: p for p in payload["plugins"]}
            self.assertFalse(by_id["studio"]["installed"])
            self.assertFalse(by_id["studio"]["ready"])
            self.assertFalse(by_id["wechat_publish"]["installed"])
            self.assertFalse(by_id["wechat_publish"]["ready"])
            self.assertFalse(payload["server_capabilities"]["studio_default"])

            with self.assertRaises(HTTPException) as ctx_s:
                resolve_studio_connection(user)
            self.assertEqual(ctx_s.exception.status_code, 412)

            with self.assertRaises(HTTPException) as ctx_w:
                resolve_wechat_connection(user)
            self.assertEqual(ctx_w.exception.status_code, 412)

            h = await studio_health(user=user)
            self.assertFalse(h["online"])
            self.assertFalse(h["installed"])

    async def test_install_configure_seal_secrets_and_uninstall_lifecycle(self):
        user = _make_user()
        db = AsyncMock()

        with patch("server.api.plugins.flag_modified"), \
             patch("server.services.plugin_service.settings.studio_filmkit_url", "http://127.0.0.1:8765"), \
             patch("server.services.plugin_service.settings.studio_filmkit_token", ""):
            # 1) Install studio without config -> installed but not ready
            res1 = await install_plugin("studio", PluginInstallReq(), user=user, db=db)
            st1 = next(p for p in res1["plugins"] if p["id"] == "studio")
            self.assertTrue(st1["installed"])
            self.assertFalse(st1["configured"])
            self.assertFalse(st1["ready"])

            # 2) Configure custom filmkit_url + secret token -> sealed at rest, masked in payload, resolved cleanly
            res2 = await update_plugin_config(
                "studio",
                PluginConfigReq(
                    config={"filmkit_url": "https://my-studio.example.com/", "filmkit_token": "super-secret-tok-99"},
                    enabled=True,
                ),
                user=user,
                db=db,
            )
            st2 = next(p for p in res2["plugins"] if p["id"] == "studio")
            self.assertTrue(st2["ready"])
            self.assertTrue(st2["config"]["has_filmkit_token"])
            self.assertNotIn("super-secret-tok-99", str(st2["config"]))
            self.assertTrue(is_sealed(user.plugin_settings["studio"]["config"]["filmkit_token"]))
            self.assertEqual(resolve_studio_connection(user), ("https://my-studio.example.com", "super-secret-tok-99"))

            # 3) Updating non-secret field preserves existing sealed token
            await update_plugin_config(
                "studio",
                PluginConfigReq(config={"filmkit_url": "https://my-studio-2.example.com", "filmkit_token": ""}),
                user=user,
                db=db,
            )
            self.assertEqual(resolve_studio_connection(user), ("https://my-studio-2.example.com", "super-secret-tok-99"))

            # 4) Install + configure wechat_publish plugin
            res_wx = await install_plugin(
                "wechat_publish",
                PluginInstallReq(
                    config={
                        "api_base_url": "https://wx-selfhost.example.com/",
                        "api_token": "wx-key-123456",
                        "default_author": "TechBlog",
                        "default_cover_media_id": "MEDIA_ID_001",
                        "official_site_url": "https://blog.example.com",
                    }
                ),
                user=user,
                db=db,
            )
            wx = next(p for p in res_wx["plugins"] if p["id"] == "wechat_publish")
            self.assertTrue(wx["ready"])
            self.assertTrue(is_plugin_ready(user, "wechat_publish"))
            url, tok, pub_cfg = resolve_wechat_connection(user)
            self.assertEqual(url, "https://wx-selfhost.example.com")
            self.assertEqual(tok, "wx-key-123456")
            self.assertEqual(pub_cfg["default_cover_media_id"], "MEDIA_ID_001")

            # 5) Invalid URL rejected cleanly
            with self.assertRaises(HTTPException) as bad_url:
                await update_plugin_config(
                    "wechat_publish",
                    PluginConfigReq(config={"api_base_url": "javascript:alert(1)"}),
                    user=user,
                    db=db,
                )
            self.assertEqual(bad_url.exception.status_code, 400)

            # 6) Uninstall removes plugin and hides it again
            res_un = await uninstall_plugin("studio", user=user, db=db)
            st_un = next(p for p in res_un["plugins"] if p["id"] == "studio")
            self.assertFalse(st_un["installed"])
            self.assertFalse(st_un["ready"])
            self.assertFalse(is_plugin_ready(user, "studio"))

    async def test_managed_server_studio_default_option(self):
        user = _make_user()
        db = AsyncMock()
        with patch("server.api.plugins.flag_modified"), \
             patch("server.services.plugin_service.settings.studio_filmkit_url", "http://filmkit:8765"), \
             patch("server.services.plugin_service.settings.studio_filmkit_token", "cluster-token"):
            payload = get_user_plugins_payload(user)
            self.assertTrue(payload["server_capabilities"]["studio_default"])

            # Still NOT auto-enabled until user explicitly installs from Plugin Marketplace
            self.assertFalse(is_plugin_ready(user, "studio"))

            await install_plugin("studio", PluginInstallReq(), user=user, db=db)
            self.assertTrue(is_plugin_ready(user, "studio"))
            self.assertEqual(resolve_studio_connection(user), ("http://filmkit:8765", "cluster-token"))
