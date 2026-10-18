import hashlib
import io
import json
from pathlib import Path
import runpy
import tarfile
import tempfile
import unittest

INSTALLER = runpy.run_path(str(Path(__file__).resolve().parents[2] / "scripts/install-reviewed-sdk.py"))


def fixture(name="package/package.json", link=False, expected=None):
    stream = io.BytesIO()
    content = b'{"name":"@honua/sdk-js","version":"0.2.3"}'
    with tarfile.open(fileobj=stream, mode="w:gz") as archive:
        info = tarfile.TarInfo(name)
        if link:
            info.type = tarfile.SYMTYPE
            info.linkname = "/outside"
            archive.addfile(info)
        else:
            info.size = len(content)
            archive.addfile(info, io.BytesIO(content))
    data = stream.getvalue()
    receipt = {"artifactSha256": hashlib.sha256(data).hexdigest(), "files": {"package.json": expected or hashlib.sha256(content).hexdigest()}}
    return data, receipt


class ReviewedSdkInstallerTests(unittest.TestCase):
    def test_exact_regular_payload(self):
        data, receipt = fixture()
        self.assertEqual(INSTALLER["payload"](data, receipt)["package.json"][0], b'{"name":"@honua/sdk-js","version":"0.2.3"}')

    def test_wrong_member_hash(self):
        data, receipt = fixture(expected="0" * 64)
        with self.assertRaisesRegex(ValueError, "member checksum"):
            INSTALLER["payload"](data, receipt)

    def test_no_links_or_parent_paths(self):
        for name, link in (("package/../../outside", False), ("package/package.json", True)):
            with self.subTest(name=name, link=link):
                data, receipt = fixture(name, link)
                with self.assertRaises(ValueError):
                    INSTALLER["payload"](data, receipt)

    def test_detects_unrelated_floating_dependency_before_overlay(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dependency = root / "node_modules/vite"
            dependency.mkdir(parents=True)
            (dependency / "package.json").write_text(json.dumps({"version": "8.3.4"}))
            (root / "package-lock.json").write_text(json.dumps({"packages": {"node_modules/@honua/sdk-js": {}, "node_modules/vite": {"version": "8.1.5"}}}))
            with self.assertRaisesRegex(ValueError, "Run npm ci first"):
                INSTALLER["verify_dependency_inputs"](root, {})
            (dependency / "package.json").write_text(json.dumps({"version": "8.1.5"}))
            INSTALLER["verify_dependency_inputs"](root, {})


if __name__ == "__main__":
    unittest.main()
