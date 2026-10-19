#!/usr/bin/env python3
"""Overlay exact reviewed SDK bytes after npm ci, without resolving any dependency ranges."""
import argparse
import hashlib
import io
import json
import os
import stat
import shutil
import tarfile
import tempfile
from pathlib import Path, PurePosixPath

RECEIPT_SHA256 = "b5bc126a1c21c216f6ef6bdbd41287bfd15816fd0c7858f1ff5cd0ddfab9938c"
MAX_FILE = 64 * 1024 * 1024
MAX_TOTAL = 256 * 1024 * 1024


def payload(archive: bytes, receipt: dict) -> dict[str, tuple[bytes, int]]:
    if len(archive) > MAX_FILE or hashlib.sha256(archive).hexdigest() != receipt["artifactSha256"]:
        raise ValueError("Reviewed SDK archive checksum mismatch.")
    files = {}
    total = 0
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as package:
        for member in package:
            path = PurePosixPath(member.name)
            if path.is_absolute() or ".." in path.parts or not path.parts or path.parts[0] != "package":
                raise ValueError("Unsafe SDK archive path.")
            if member.isdir():
                continue
            if not member.isfile() or len(path.parts) < 2:
                raise ValueError("SDK archives must contain regular package files only.")
            relative = "/".join(path.parts[1:])
            if relative in files or relative not in receipt["files"] or member.size > MAX_FILE:
                raise ValueError("Unexpected, duplicate, or oversized SDK package member.")
            total += member.size
            if total > MAX_TOTAL:
                raise ValueError("Reviewed SDK payload exceeds its size budget.")
            stream = package.extractfile(member)
            if stream is None:
                raise ValueError("Unreadable SDK archive member.")
            data = stream.read(member.size + 1)
            if len(data) != member.size or hashlib.sha256(data).hexdigest() != receipt["files"][relative]:
                raise ValueError("SDK package member checksum mismatch.")
            files[relative] = (data, member.mode & 0o111)
    if set(files) != set(receipt["files"]):
        raise ValueError("Reviewed SDK payload is incomplete.")
    return files


def verify_dependency_inputs(root: Path, package: dict) -> None:
    lock = json.loads((root / "package-lock.json").read_text())
    locked_sdk = lock["packages"]["node_modules/@honua/sdk-js"]
    for key in ("dependencies", "peerDependencies", "peerDependenciesMeta", "optionalDependencies"):
        if package.get(key, {}) != locked_sdk.get(key, {}):
            raise ValueError("SDK dependency metadata differs from the locked graph; qualify a new lock explicitly.")
    for relative, entry in lock["packages"].items():
        if not relative or relative == "node_modules/@honua/sdk-js" or relative.startswith("node_modules/@honua/sdk-js/"):
            continue
        file = root / relative / "package.json"
        if not file.is_file() and entry.get("optional"):
            continue
        if not file.is_file() or json.loads(file.read_text()).get("version") != entry.get("version"):
            raise ValueError("Run npm ci first: installed dependency differs from lock: " + relative)


def read_archive(path: Path) -> bytes:
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise ValueError("Reviewed SDK archive must be a regular file.")
        with os.fdopen(descriptor, "rb", closefd=False) as source:
            data = source.read(MAX_FILE + 1)
        if len(data) > MAX_FILE:
            raise ValueError("Reviewed SDK archive exceeds its size budget.")
        return data
    finally:
        os.close(descriptor)


def install(root: Path, archive: Path) -> dict:
    receipt_bytes = (root / "scripts/sdk-review-receipt.json").read_bytes()
    if hashlib.sha256(receipt_bytes).hexdigest() != RECEIPT_SHA256:
        raise ValueError("The reviewed SDK receipt changed; qualify its replacement first.")
    receipt = json.loads(receipt_bytes)
    files = payload(read_archive(archive), receipt)
    verify_dependency_inputs(root, json.loads(files["package.json"][0]))
    parent = root / "node_modules/@honua"
    target = parent / "sdk-js"
    if parent.resolve() != parent or target.is_symlink() or not target.is_dir():
        raise ValueError("Expected this worktree's own npm ci dependency directory.")
    stage = Path(tempfile.mkdtemp(prefix=".reviewed-sdk-", dir=parent))
    backup = Path(tempfile.mkdtemp(prefix=".previous-sdk-", dir=parent))
    backup.rmdir()
    try:
        for relative, (data, executable) in files.items():
            destination = stage / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
            destination.chmod(0o755 if executable else 0o644)
        target.rename(backup)
        try:
            stage.rename(target)
        except BaseException:
            backup.rename(target)
            raise
        shutil.rmtree(backup)
    finally:
        if stage.exists():
            shutil.rmtree(stage)
    return {"sourceCommit": receipt["sourceCommit"], "artifactSha256": receipt["artifactSha256"], "files": len(files)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    options = parser.parse_args()
    print(json.dumps(install(Path(__file__).resolve().parent.parent, options.archive.resolve())))
