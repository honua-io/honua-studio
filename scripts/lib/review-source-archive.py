"""Materialize a pinned GitHub source archive as inert, non-executable files.

No Git checkout, hooks, config, filesystem links, or candidate scripts are used.
Git symlink blobs are represented by their literal target text, never followed.
"""

import io
from pathlib import Path
import stat
import sys
import zipfile

MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
MAX_FILE_BYTES = 32 * 1024 * 1024
MAX_TOTAL_BYTES = 256 * 1024 * 1024
MAX_ENTRIES = 10000


def materialize(archive, destination):
    if len(archive) > MAX_ARCHIVE_BYTES:
        raise ValueError("Source archive exceeded its compressed bound.")
    destination = Path(destination)
    if destination.exists() or destination.is_symlink():
        raise ValueError("Source destination must not already exist.")
    with zipfile.ZipFile(io.BytesIO(archive)) as source:
        entries = source.infolist()
        if not entries or len(entries) > MAX_ENTRIES:
            raise ValueError("Source archive entry count is invalid.")
        root = None
        total = 0
        files = []
        paths = set()
        for entry in entries:
            name = entry.filename
            if (
                not name
                or name.startswith("/")
                or "\\" in name
                or any(ord(char) < 32 or ord(char) == 127 for char in name)
                or entry.flag_bits & 1
            ):
                raise ValueError("Invalid source archive path or encryption.")
            parts = name.removesuffix("/").split("/")
            if any(part in ("", ".", "..", ".git") for part in parts):
                raise ValueError("Source archive path escapes its data boundary.")
            root = root or parts[0]
            if parts[0] != root or (len(parts) == 1 and not entry.is_dir()):
                raise ValueError("Source archive must have one enclosing directory.")
            relative = Path(*parts[1:])
            if relative in paths:
                raise ValueError("Duplicate source archive path.")
            paths.add(relative)
            mode = stat.S_IFMT(entry.external_attr >> 16)
            if mode not in (0, stat.S_IFREG, stat.S_IFDIR, stat.S_IFLNK):
                raise ValueError("Special filesystem objects are not source data.")
            if entry.file_size > MAX_FILE_BYTES or entry.file_size < 0:
                raise ValueError("Source file exceeded its bound.")
            total += entry.file_size
            if total > MAX_TOTAL_BYTES:
                raise ValueError("Expanded source archive exceeded its bound.")
            if not entry.is_dir():
                files.append((entry, relative))
        if not files:
            raise ValueError("Source archive contains no files.")
        # Validate the entire namespace before creating anything. A file must
        # never become an ancestor of another entry, including a symlink blob.
        file_paths = {relative for _, relative in files}
        if any(parent in file_paths for relative in paths for parent in relative.parents):
            raise ValueError("Source archive has conflicting file/directory paths.")
        destination.mkdir(mode=0o700, parents=True)
        for entry, relative in files:
            target = destination / relative
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            # Explicitly copy bytes; ZipFile.extract and archive permission bits
            # must not introduce links, executable files or path traversal.
            with source.open(entry) as data, target.open("xb") as output:
                remaining = entry.file_size
                while chunk := data.read(min(65536, remaining + 1)):
                    remaining -= len(chunk)
                    if remaining < 0:
                        raise ValueError("Source file differs from its declared size.")
                    output.write(chunk)
                if remaining:
                    raise ValueError("Incomplete source file.")
            target.chmod(0o600)
        return len(files)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Expected archive file and fresh destination directory.")
    with Path(sys.argv[1]).open("rb") as archive_file:
        archive = archive_file.read(MAX_ARCHIVE_BYTES + 1)
    print(f"Materialized {materialize(archive, sys.argv[2])} inert source files.")
