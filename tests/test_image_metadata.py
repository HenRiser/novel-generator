from __future__ import annotations

import base64
import io
import json
import struct
import unittest
from unittest.mock import patch
import zlib

import httpx

import image_provider as images
from provider_catalog import default_policy

try:
    from PIL import Image, ImageCms
except ImportError:
    Image = ImageCms = None


SECRET = b"PRIVATE_PROMPT_METADATA_SENTINEL"
JPEG = base64.b64decode(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/"
    "2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/"
    "wAARCAADAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABv/"
    "EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJ9AFA4//9k="
)
WEBP = base64.b64decode("UklGRh4AAABXRUJQVlA4TBEAAAAvAYAAAAdQkTIUp/+BiOh/AAA=")


def png_chunk(kind, body):
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))


PNG_HEADER = b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 3, 8, 2, 0, 0, 0))
PNG_PIXELS = png_chunk(b"IDAT", zlib.compress((b"\0" + b"\x0c\x22\x38" * 2) * 3)) + png_chunk(b"IEND", b"")
PNG = PNG_HEADER + PNG_PIXELS


def metadata_png(profile=None):
    return PNG_HEADER + b"".join([
        png_chunk(b"tEXt", b"prompt\0" + SECRET),
        png_chunk(b"iTXt", b"prompt\0\0\0\0\0" + SECRET),
        png_chunk(b"zTXt", b"prompt\0\0" + zlib.compress(SECRET)),
        png_chunk(b"eXIf", b"Exif\0\0" + SECRET),
        png_chunk(b"prIv", SECRET),
    ] + ([png_chunk(b"iCCP", SECRET + b"\0\0" + zlib.compress(profile))] if profile is not None else [])) + PNG_PIXELS


def jpeg_segment(marker, body):
    return bytes([0xFF, marker]) + struct.pack(">H", len(body) + 2) + body


def webp_chunk(kind, body):
    return kind + struct.pack("<I", len(body)) + body + (b"\0" if len(body) & 1 else b"")


def webp_file(chunks):
    return b"RIFF" + struct.pack("<I", len(chunks) + 4) + b"WEBP" + chunks


def webp_header(flags=0x0C):
    return webp_chunk(b"VP8X", bytes([flags]) + b"\0" * 3 + (1).to_bytes(3, "little") + (2).to_bytes(3, "little"))


def private_color_profile():
    """A valid native sRGB profile with a description and an opaque private tag."""
    baseline = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    count = struct.unpack(">I", baseline[128:132])[0]
    records = []
    for index in range(count):
        signature = baseline[132 + index * 12:136 + index * 12]
        offset, length = struct.unpack(">II", baseline[136 + index * 12:144 + index * 12])
        body = baseline[offset:offset + length]
        if signature == b"desc":
            description = SECRET.decode().encode("utf-16-be")
            body = b"mluc" + b"\0" * 4 + struct.pack(">II", 1, 12) + b"enUS" + struct.pack(">II", len(description), 28) + description
        records.append((signature, body))
    records.append((b"prmt", b"text" + b"\0" * 4 + SECRET + b"\0"))
    table, data = bytearray(), bytearray()
    first_offset = 132 + len(records) * 12
    for signature, body in records:
        table.extend(signature + struct.pack(">II", first_offset + len(data), len(body)))
        data.extend(body)
        data.extend(b"\0" * (-len(data) % 4))
    header = bytearray(baseline[:128])
    size = first_offset + len(data)
    header[:4] = struct.pack(">I", size)
    return bytes(header) + struct.pack(">I", len(records)) + table + data


class ImageMetadata(unittest.TestCase):
    def test_png_removes_text_exif_private_chunks_and_preserves_rendering(self):
        colors = png_chunk(b"gAMA", struct.pack(">I", 45455)) + png_chunk(b"sRGB", b"\0")
        raw = metadata_png()
        raw = raw[:len(PNG_HEADER)] + colors + raw[len(PNG_HEADER):]
        cleaned = images.strip_image_metadata(raw, "image/png")
        self.assertEqual(cleaned, PNG_HEADER + colors + PNG_PIXELS)
        self.assertNotIn(SECRET, cleaned)
        self.assertEqual(images.image_info(cleaned), ("image/png", 2, 3))
        self.assertEqual(images.strip_image_metadata(cleaned), cleaned)

    def test_png_preserves_animation_chunks(self):
        animation = png_chunk(b"acTL", struct.pack(">II", 1, 0)) + png_chunk(
            b"fcTL", struct.pack(">IIIIIHHBB", 0, 2, 3, 0, 0, 1, 10, 0, 0))
        raw = PNG_HEADER + animation + png_chunk(b"tEXt", b"prompt\0" + SECRET) + PNG_PIXELS
        self.assertEqual(images.strip_image_metadata(raw), PNG_HEADER + animation + PNG_PIXELS)

    def test_png_removes_icc_profile_name_and_opaque_profile_payload(self):
        profile = png_chunk(b"iCCP", SECRET + b"\0\0" + zlib.compress(b"profile-tags:" + SECRET))
        self.assertEqual(images.strip_image_metadata(PNG_HEADER + profile + PNG_PIXELS), PNG)

    def test_jpeg_removes_app_and_comments_before_and_after_scan(self):
        metadata = b"".join([
            jpeg_segment(0xE1, b"Exif\0\0" + SECRET),
            jpeg_segment(0xE1, b"http://ns.adobe.com/xap/1.0/\0" + SECRET),
            jpeg_segment(0xE1, b"http://ns.adobe.com/xmp/extension/\0" + SECRET),
            jpeg_segment(0xED, b"Photoshop 3.0\0" + SECRET),
            jpeg_segment(0xFE, SECRET),
        ])
        raw = JPEG[:2] + metadata + JPEG[2:-2] + jpeg_segment(0xFE, SECRET) + JPEG[-2:]
        self.assertEqual(images.strip_image_metadata(raw, "image/jpeg"), JPEG)

    def test_jpeg_removes_icc_preserves_adobe_and_entropy_marker_escapes(self):
        profile = jpeg_segment(0xE2, b"ICC_PROFILE\0\x01\x01" + SECRET)
        colors = jpeg_segment(0xEE, b"Adobe\0d\0\0\0\0\x01")
        # A second scan exercises metadata parsing after entropy-coded bytes,
        # including a stuffed FF byte and a restart marker.
        sos = jpeg_segment(0xDA, b"\x01\x01\0\0?\0")
        scans = sos + b"\x12\xff\0\x34\xff\xd0\x56"
        baseline = JPEG[:2] + colors + JPEG[2:-2] + scans + JPEG[-2:]
        raw = JPEG[:2] + profile + colors + JPEG[2:-2] + jpeg_segment(0xFE, SECRET) + scans + JPEG[-2:]
        self.assertEqual(images.strip_image_metadata(raw), baseline)

    def test_webp_removes_metadata_and_unknown_chunks_updates_flags_and_size(self):
        profile = webp_chunk(b"ICCP", SECRET)
        retained = webp_header(0) + WEBP[12:]
        raw = webp_file(webp_header(0x2C) + profile + WEBP[12:] + webp_chunk(b"EXIF", SECRET) + webp_chunk(b"XMP ", SECRET) + webp_chunk(b"priv", SECRET))
        cleaned = images.strip_image_metadata(raw, "image/webp")
        self.assertEqual(cleaned, webp_file(retained))
        self.assertEqual(cleaned[20], 0)
        self.assertEqual(int.from_bytes(cleaned[4:8], "little"), len(cleaned) - 8)
        self.assertEqual(images.image_info(cleaned), ("image/webp", 2, 3))
        self.assertEqual(images.strip_image_metadata(cleaned), cleaned)

    def test_webp_cleans_unknown_and_metadata_chunks_inside_animation_frames(self):
        frame_header = b"\0" * 6 + (1).to_bytes(3, "little") + (2).to_bytes(3, "little") + b"\x64\0\0\0"
        animation = webp_chunk(b"ANIM", b"\0" * 6)
        frame = webp_chunk(b"ANMF", frame_header + WEBP[12:] + webp_chunk(b"XMP ", SECRET) + webp_chunk(b"priv", SECRET))
        raw = webp_file(webp_header(0x0E) + animation + frame)
        expected = webp_file(webp_header(0x02) + animation + webp_chunk(b"ANMF", frame_header + WEBP[12:]))
        self.assertEqual(images.strip_image_metadata(raw), expected)

    def test_rejects_malformed_chunks_and_mime_before_network(self):
        raw_webp = webp_file(webp_header() + b"EXIF" + struct.pack("<I", 100) + SECRET)
        unknown_critical = PNG_HEADER + png_chunk(b"PRIV", SECRET) + PNG_PIXELS
        truncated_jpeg = JPEG[:2] + jpeg_segment(0xE1, SECRET)[:-3] + JPEG[2:]
        for raw, mime in ((raw_webp, None), (unknown_critical, None), (truncated_jpeg, None), (PNG, "image/jpeg")):
            with self.subTest(mime=mime, prefix=raw[:12]), self.assertRaises(ValueError):
                images.strip_image_metadata(raw, mime)
        with patch.object(images, "_client") as network:
            content = images.validate_input("edit", {"prompt": "edit", "image": {
                "mime_type": "image/png", "data_base64": base64.b64encode(metadata_png()).decode()}})
        network.assert_not_called()
        self.assertEqual(content, PNG)

    @unittest.skipIf(Image is None, "Pillow is optional and used only to verify decoded pixels")
    def test_real_rasters_keep_pixels_animation_and_remove_color_profiles(self):
        profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
        for format_, options in (("PNG", {}), ("JPEG", {}), ("JPEG", {"progressive": True}),
                                 ("WEBP", {"lossless": True}), ("WEBP", {"lossless": False})):
            with self.subTest(format=format_, options=options):
                original = Image.new("RGB" if format_ == "JPEG" else "RGBA", (2, 3), (12, 34, 56))
                exif = Image.Exif()
                exif[270] = SECRET.decode()
                out = io.BytesIO()
                original.save(out, format=format_, exif=exif, icc_profile=profile, **options)
                raw = out.getvalue()
                cleaned = images.strip_image_metadata(raw)
                with Image.open(io.BytesIO(raw)) as before, Image.open(io.BytesIO(cleaned)) as after:
                    self.assertEqual(before.tobytes(), after.tobytes())
                    self.assertEqual(before.mode, after.mode)
                    self.assertNotIn("icc_profile", after.info)
                    self.assertFalse(after.getexif())
                self.assertNotIn(SECRET, cleaned)
        out = io.BytesIO()
        first = Image.new("RGBA", (2, 3), (12, 34, 56, 80))
        second = Image.new("RGBA", (2, 3), (60, 50, 40, 120))
        first.save(out, format="WEBP", save_all=True, append_images=[second], lossless=True,
                   duration=100, loop=0, exif=b"Exif\0\0" + SECRET, xmp=SECRET)
        raw = out.getvalue()
        cleaned = images.strip_image_metadata(raw)
        with Image.open(io.BytesIO(raw)) as before, Image.open(io.BytesIO(cleaned)) as after:
            self.assertEqual(before.n_frames, after.n_frames)
            for number in range(before.n_frames):
                before.seek(number)
                after.seek(number)
                self.assertEqual(before.tobytes(), after.tobytes())
        self.assertNotIn(SECRET, cleaned)

    @unittest.skipIf(ImageCms is None, "Pillow is optional and used only to verify native decode/profile validity")
    def test_valid_icc_description_private_tags_and_png_name_are_all_removed(self):
        profile = private_color_profile()
        self.assertIn(SECRET, profile)
        native = ImageCms.ImageCmsProfile(io.BytesIO(profile))
        self.assertEqual(ImageCms.getProfileDescription(native).strip(), SECRET.decode())
        for format_ in ("PNG", "JPEG", "WEBP"):
            with self.subTest(format=format_):
                out = io.BytesIO()
                Image.new("RGB", (2, 3), (12, 34, 56)).save(out, format=format_, icc_profile=profile)
                raw = out.getvalue()
                if format_ == "PNG":
                    # Use the private value for both PNG's profile name and the
                    # valid ICC's internal description/private data.
                    offset = 8
                    while raw[offset + 4:offset + 8] != b"iCCP":
                        offset += 12 + int.from_bytes(raw[offset:offset + 4], "big")
                    end = offset + 12 + int.from_bytes(raw[offset:offset + 4], "big")
                    raw = raw[:offset] + png_chunk(b"iCCP", SECRET + b"\0\0" + zlib.compress(profile)) + raw[end:]
                cleaned = images.strip_image_metadata(raw)
                with Image.open(io.BytesIO(raw)) as before, Image.open(io.BytesIO(cleaned)) as after:
                    self.assertEqual(before.info["icc_profile"], profile)
                    self.assertEqual(before.tobytes(), after.tobytes())
                    self.assertNotIn("icc_profile", after.info)
                self.assertNotIn(SECRET, cleaned)
                self.assertNotIn(SECRET.decode().encode("utf-16-be"), cleaned)
                self.assertEqual(images.image_info(cleaned)[1:], (2, 3))


class MetadataTransport(unittest.IsolatedAsyncioTestCase):
    async def test_official_interactions_edit_cleans_inline_input_and_final_output_metadata(self):
        raw_image = metadata_png()
        original = {"mime_type": "image/png", "data_base64": base64.b64encode(raw_image).decode()}
        seen = []
        def upstream(request):
            seen.append(request)
            raw = {"status": "completed", "steps": [{"type": "model_output", "content": [
                {"type": "image", "mime_type": "image/png", "data": original["data_base64"]}]}]}
            return httpx.Response(200, stream=httpx.ByteStream(json.dumps(raw).encode()))
        config = images.ImageConfig(images.normalize_image_connection({
            "profile_id": "metadata-test", "revision": 1, "preset": "gemini", "protocol": "gemini_images",
            "base_url": "https://generativelanguage.googleapis.com/v1beta", "model": "gemini-3.1-flash-image",
            "policy": default_policy("custom"), "auth_mode": "key"}), "fake-metadata-test-key")
        def client(url, custom=False):
            return httpx.AsyncClient(transport=httpx.MockTransport(upstream), trust_env=False)
        with patch.object(images, "_client", client):
            result = await images.request_image(config, "edit", {"prompt": "edit", "image": original}, {})
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0].url.path, "/v1beta/interactions")
        body = json.loads(seen[0].content)
        self.assertFalse(body["store"])
        self.assertEqual(body["input"][1]["mime_type"], "image/png")
        self.assertEqual(base64.b64decode(body["input"][1]["data"]), PNG)
        self.assertEqual(base64.b64decode(result["image"]["data_base64"]), PNG)
        self.assertEqual((result["image"]["width"], result["image"]["height"]), (2, 3))
        self.assertEqual(original["data_base64"], base64.b64encode(raw_image).decode())

    async def test_every_adapter_sends_and_returns_cleaned_bytes_without_real_network_or_key(self):
        raw_image = metadata_png(private_color_profile() if ImageCms is not None else b"opaque-private-icc:" + SECRET)
        original = {"mime_type": "image/png", "data_base64": base64.b64encode(raw_image).decode()}
        for protocol in images.IMAGE_PROTOCOLS:
            with self.subTest(protocol=protocol):
                seen = []
                def upstream(request):
                    seen.append(request)
                    if request.method == "GET":
                        return httpx.Response(200, stream=httpx.ByteStream(raw_image), headers={"content-type": "image/png"})
                    if protocol == "gemini_images":
                        raw = {"candidates": [{"finishReason": "STOP", "content": {"parts": [{"inlineData": {
                            "mimeType": "image/png", "data": original["data_base64"]}}]}}]}
                    elif protocol == "qwen_images":
                        raw = {"output": {"choices": [{"finish_reason": "stop", "message": {"content": [{"image": "https://image.example/result.png"}]}}]}}
                    else:
                        raw = {"data": [{"b64_json": original["data_base64"]}]}
                    return httpx.Response(200, stream=httpx.ByteStream(json.dumps(raw).encode()))
                config = images.ImageConfig(images.normalize_image_connection({
                    "profile_id": "metadata-test", "revision": 1, "preset": "custom", "protocol": protocol,
                    "base_url": "https://image.example", "model": "image-test", "policy": default_policy("custom"), "auth_mode": "none"}), "")
                def client(url, custom=False):
                    return httpx.AsyncClient(transport=httpx.MockTransport(upstream), trust_env=False)
                with patch.object(images, "_client", client):
                    result = await images.request_image(config, "edit", {"prompt": "edit", "image": original}, {})
                request = seen[0]
                self.assertNotIn("authorization", request.headers)
                self.assertNotIn("x-goog-api-key", request.headers)
                if protocol == "openai_images":
                    self.assertIn(PNG, request.content)
                    self.assertNotIn(SECRET, request.content)
                else:
                    body = json.loads(request.content)
                    if protocol == "gemini_images":
                        value = body["contents"][0]["parts"][0]["inlineData"]["data"]
                    elif protocol == "seedream_images":
                        self.assertEqual(body["sequential_image_generation"], "disabled")
                        value = body["image"].split(",", 1)[1]
                    else:
                        value = body["input"]["messages"][0]["content"][0]["image"].split(",", 1)[1]
                    self.assertEqual(base64.b64decode(value), PNG)
                self.assertEqual(base64.b64decode(result["image"]["data_base64"]), PNG)
                self.assertEqual((result["image"]["width"], result["image"]["height"]), (2, 3))
                self.assertEqual(original["data_base64"], base64.b64encode(raw_image).decode())


if __name__ == "__main__":
    unittest.main()
