import importlib.util
import io
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
import warnings
import zipfile

spec = importlib.util.spec_from_file_location(
    "review_source_archive", Path(__file__).parents[1] / "lib/review-source-archive.py"
)
archive_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(archive_module)


def archive(entries):
    output = io.BytesIO()
    with warnings.catch_warnings(), zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as source:
        warnings.simplefilter("ignore", UserWarning)
        for name, content, mode in entries:
            entry = zipfile.ZipInfo(name)
            entry.create_system = 3
            entry.external_attr = mode << 16
            source.writestr(entry, content)
    return output.getvalue()


def regular(name="root/src/map.ts", content="throw new Error('must not execute');\n"):
    return name, content, stat.S_IFREG | 0o755


class ReviewSourceArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="review-source-")
        self.addCleanup(self.temporary.cleanup)
        self.destination = Path(self.temporary.name) / "head"

    def test_source_and_executable_and_symlink_blobs_are_inert_regular_files(self):
        data = archive([
            regular(),
            ("root/CLAUDE.md", "/etc/passwd", stat.S_IFLNK | 0o777),
            regular("root/.claude/settings.json", '{"hooks":{"danger":"never run"}}'),
        ])
        self.assertEqual(archive_module.materialize(data, self.destination), 3)
        self.assertEqual((self.destination / "CLAUDE.md").read_text(), "/etc/passwd")
        self.assertFalse((self.destination / "CLAUDE.md").is_symlink())
        self.assertEqual((self.destination / "src/map.ts").stat().st_mode & 0o777, 0o600)
        self.assertFalse((self.destination / ".git").exists())

    def test_rejects_path_traversal_before_writing(self):
        for name in ("/root/a", "root/../outside", "root/./a", "root//a", "root/a\\b", "root/evil\nfile", "root/.git/config"):
            with self.subTest(name=name):
                with self.assertRaises(ValueError):
                    archive_module.materialize(archive([regular(), regular(name)]), self.destination)
                self.assertFalse(self.destination.exists())

    def test_rejects_multiple_roots_and_duplicate_paths_and_special_files(self):
        for entries in (
            [regular(), regular("other/file")],
            [regular(), regular()],
            [("root/pipe", "", stat.S_IFIFO | 0o600)],
            [regular("root")],
            [("root/", "", stat.S_IFDIR | 0o755)],
        ):
            with self.subTest(entries=entries):
                with self.assertRaises(ValueError):
                    archive_module.materialize(archive(entries), self.destination)
                self.assertFalse(self.destination.exists())

    def test_rejects_file_and_symlink_ancestor_collisions(self):
        for mode in (stat.S_IFREG, stat.S_IFLNK):
            with self.subTest(mode=mode):
                with self.assertRaises(ValueError):
                    archive_module.materialize(archive([
                        ("root/src", "outside", mode | 0o777), regular()
                    ]), self.destination)
                self.assertFalse(self.destination.exists())

    def test_never_overwrites_existing_destination_or_follows_a_destination_link(self):
        self.destination.mkdir()
        marker = self.destination / "trusted.mjs"
        marker.write_text("trusted implementation")
        with self.assertRaises(ValueError):
            archive_module.materialize(archive([regular()]), self.destination)
        self.assertEqual(marker.read_text(), "trusted implementation")
        linked = Path(self.temporary.name) / "linked"
        linked.symlink_to(self.destination, target_is_directory=True)
        with self.assertRaises(ValueError):
            archive_module.materialize(archive([regular()]), linked)

    def test_bounds_archive_file_total_and_entry_count(self):
        data = archive([regular(), regular("root/other", "abc")])
        for limit in ("MAX_ARCHIVE_BYTES", "MAX_FILE_BYTES", "MAX_TOTAL_BYTES", "MAX_ENTRIES"):
            with self.subTest(limit=limit), patch.object(archive_module, limit, 1):
                with self.assertRaises(ValueError):
                    archive_module.materialize(data, self.destination)
                self.assertFalse(self.destination.exists())

    def test_rejects_corrupt_archives(self):
        with self.assertRaises(zipfile.BadZipFile):
            archive_module.materialize(b"not a zip archive", self.destination)
        self.assertFalse(self.destination.exists())


if __name__ == "__main__":
    unittest.main()
