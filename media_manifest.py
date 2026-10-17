"""Build/verify a local corpus manifest. No network or environment-file access."""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import tempfile


class LabError(Exception):
    """Safe, fixed error text suitable for terminal output."""


def save_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    name = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False, encoding="utf-8") as stream:
            name = stream.name
            json.dump(value, stream, indent=2, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        name = None
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if name is not None:
            Path(name).unlink(missing_ok=True)


def read_json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise LabError("Cannot read valid local JSON; details redacted.") from None


def checksum(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def duration(path):
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)],
            capture_output=True, text=True, check=True, timeout=30,
        )
        seconds = float(json.loads(result.stdout)["format"]["duration"])
        if not math.isfinite(seconds) or seconds <= 0:
            raise ValueError()
        return seconds
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError):
        raise LabError("Duration check failed; check ffprobe and media locally. Details redacted.") from None


def verify(manifest, media_dir):
    if not isinstance(manifest, dict) or manifest.get("schema_version") != 1:
        raise LabError("Unsupported manifest schema.")
    clips = manifest.get("clips")
    if not isinstance(clips, list) or len(clips) != 3:
        raise LabError("Select exactly three clips; the empty template is not a corpus.")
    names, hashes = set(), set()
    for clip in clips:
        if not isinstance(clip, dict):
            raise LabError("Invalid manifest entry.")
        name = clip.get("filename")
        if not isinstance(name, str) or not name or Path(name).name != name or "\\" in name or name in (".", ".."):
            raise LabError("Filename must identify a file directly inside media/.")
        path = Path(media_dir) / name
        if path.is_symlink() or not path.is_file():
            raise LabError("Selected media is missing or is a symlink; details redacted.")
        sha = checksum(path)
        if sha != clip.get("sha256") or path.stat().st_size != clip.get("size_bytes"):
            raise LabError("Media checksum/size mismatch; refusing to change corpus identity.")
        seconds = clip.get("duration_seconds")
        if type(seconds) not in (int, float) or not math.isfinite(seconds) or seconds <= 0:
            raise LabError("Invalid manifest duration.")
        if name in names or sha in hashes:
            raise LabError("Duplicate corpus entry or identical media bytes.")
        names.add(name)
        hashes.add(sha)
        for field in ("source", "license", "attribution"):
            if not isinstance(clip.get(field), str) or not clip[field].strip():
                raise LabError("Source, license and attribution must be filled in locally.")
        if not isinstance(clip.get("ground_truth"), list):
            raise LabError("Ground truth must be a handwritten list; an empty list means unreviewed.")
    return clips


def build(filenames, media_dir, probe=duration):
    if len(filenames) != 3 or len(set(filenames)) != 3:
        raise LabError("Explicitly select exactly three different filenames.")
    clips = []
    for name in filenames:
        if Path(name).name != name or "\\" in name or name in (".", ".."):
            raise LabError("Select filenames directly inside media/.")
        path = Path(media_dir) / name
        if path.is_symlink() or not path.is_file():
            raise LabError("Selected media is missing or is a symlink; details redacted.")
        before = checksum(path)
        seconds = probe(path)
        if before != checksum(path):
            raise LabError("Media changed during manifest generation.")
        clips.append(dict(filename=name, sha256=before, size_bytes=path.stat().st_size,
                          duration_seconds=seconds, source="", license="", attribution="", ground_truth=[]))
    if len({clip["sha256"] for clip in clips}) != 3:
        raise LabError("Selected clips have duplicate media bytes.")
    return {"schema_version": 1, "clips": clips}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--media-dir", type=Path, default=Path("media"))
    parser.add_argument("--manifest", type=Path, default=Path("media-manifest.json"))
    parser.add_argument("--check", action="store_true")
    parser.add_argument("filenames", nargs="*")
    args = parser.parse_args()
    try:
        if args.check:
            verify(read_json(args.manifest), args.media_dir)
            print("Three selected clips match the manifest checksums and sizes.")
        else:
            # Never overwrite a real manifest or handwritten annotations.
            if args.manifest.exists() and read_json(args.manifest).get("clips") != []:
                raise LabError("Manifest already contains a corpus; refusing to overwrite it.")
            save_json(args.manifest, build(args.filenames, args.media_dir))
            print("Manifest generated locally. Fill source, license, attribution and ground_truth by hand.")
    except (LabError, OSError) as error:
        parser.exit(1, f"{error if isinstance(error, LabError) else 'Local file operation failed; details redacted.'}\n")


if __name__ == "__main__":
    main()
