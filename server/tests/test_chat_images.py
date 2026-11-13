"""Images pasted into a question: their own names per question, and a kept copy the workbench is served from."""
import asyncio
import re
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from server.services import chat_images


class NamesAndKeys(unittest.TestCase):
    def test_each_question_names_its_images_on_new_devices(self):
        a = chat_images.image_names(["webp", "png"], unique=True)
        b = chat_images.image_names(["webp"], unique=True)
        self.assertRegex(a[0], r"^image_[0-9a-f]+_1\.webp$")
        self.assertRegex(a[1], r"^image_[0-9a-f]+_2\.png$")
        self.assertNotEqual(a[0], b[0])  # a later question's first image doesn't take this one's name
        self.assertEqual(chat_images.image_names(["webp"], unique=False), ["image_1.webp"])

    def test_storage_key_only_for_chat_image_paths(self):
        conv = "40858dab-df70-409b-a1ee-ec51a8b50e7d"
        self.assertEqual(
            chat_images.storage_key("u1", f"/tmp/memento_images/{conv}/image_abc_1.webp"),
            f"chat-images/u1/{conv}/image_abc_1.webp",
        )
        self.assertEqual(
            chat_images.storage_key("u1", f"/data2/memento/images/{conv}/image_1.PNG"),
            f"chat-images/u1/{conv}/image_1.png",
        )
        for path in (
            f"/tmp/memento_images/{conv}/../../etc/passwd",
            f"/tmp/memento_images/{conv}/notes.md",
            "/Users/x/Desktop/image_1.webp",
            f"/tmp/memento_images/{conv}/sub/image_1.webp",
        ):
            self.assertIsNone(chat_images.storage_key("u1", path), path)

    def test_agent_path_and_key_agree(self):
        name = chat_images.image_names(["webp"], unique=True)[0]
        self.assertIsNotNone(chat_images.storage_key("u", chat_images.agent_path("conv-1", name)))


class DeviceVersion(unittest.TestCase):
    def _run(self, versions):
        res = MagicMock()
        res.scalars.return_value.all.return_value = versions
        db = MagicMock(execute=AsyncMock(return_value=res))
        return asyncio.run(chat_images.device_names_images(db, "memento-abc"))

    def test_only_daemons_that_write_given_names(self):
        self.assertTrue(self._run(["1.0.125"]))
        self.assertTrue(self._run(["1.1.0"]))
        self.assertFalse(self._run(["1.0.124"]))
        self.assertFalse(self._run(["1.0.125", "1.0.117"]))  # the same name on an older machine too: old names
        self.assertFalse(self._run([]))
        self.assertFalse(asyncio.run(chat_images.device_names_images(MagicMock(), "auto")))


class KeptCopyServed(unittest.IsolatedAsyncioTestCase):
    async def test_stream_serves_the_kept_copy_without_asking_devices(self):
        from server.api import devices

        user = MagicMock(role="owner", id="u1")
        path = "/tmp/memento_images/conv-1/image_abc_1.webp"
        store = {"chat-images/u1/conv-1/image_abc_1.webp": (b"RIFFwebp", "image/webp")}

        async def get_bytes(key):
            return store.get(key, (None, ""))

        with patch.object(chat_images, "get_bytes", side_effect=get_bytes), \
             patch("server.services.user_filter.find_machine_by_id_or_hash", AsyncMock(return_value=None)), \
             patch.object(devices, "user_machine_ids", AsyncMock(return_value=None)), \
             patch.object(devices, "_stat_on_devices", AsyncMock(side_effect=AssertionError("asked a device"))):
            resp = await devices.stream_device_file(
                device_id="auto", path=path, filename="image_abc_1.webp", request=MagicMock(method="GET", headers={}),
                db=MagicMock(), _user=user,
            )
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(resp.body, b"RIFFwebp")
            self.assertEqual(resp.media_type, "image/webp")

            # another user's path with the same name isn't theirs
            other = MagicMock(role="member", id="u2")
            self.assertIsNone(await chat_images.load(other.id, path))

    async def test_keep_writes_under_the_users_key(self):
        put = AsyncMock(return_value="k")
        with patch.object(chat_images, "upload_bytes", put):
            self.assertTrue(await chat_images.keep("u1", "conv-1", "image_abc_1.webp", b"x"))
        key, data = put.call_args.args[:2]
        self.assertEqual(key, "chat-images/u1/conv-1/image_abc_1.webp")
        self.assertEqual(put.call_args.kwargs["content_type"], "image/webp")
        self.assertTrue(re.match(r"^chat-images/", key))


if __name__ == "__main__":
    unittest.main()
