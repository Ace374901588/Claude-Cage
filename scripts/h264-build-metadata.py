"""Bind a full-source local H264 build to its clean source and signed binaries."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()


def checked_head():
    if git("status", "--porcelain", "--untracked-files=all"):
        raise SystemExit("Commit the complete source before building the local H264 package.")
    if "-local.h264." not in (ROOT / "VERSION").read_text().strip():
        raise SystemExit("The H264 build requires a local H264 VERSION and manual update channel.")
    subprocess.run(["git", "merge-base", "--is-ancestor", "upstream/main", "HEAD"], cwd=ROOT, check=True)
    return git("rev-parse", "HEAD")


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def main():
    if sys.argv[1:] == ["check"]:
        print(checked_head())
        return
    if len(sys.argv) != 4 or sys.argv[1] != "record":
        raise SystemExit("Usage: h264-build-metadata.py check | record /absolute/Cage.app SOURCE_HEAD")
    bundle = Path(sys.argv[2])
    head = checked_head()
    if not bundle.is_absolute() or head != sys.argv[3]:
        raise SystemExit("Source changed during the H264 build.")
    resources = bundle / "Contents/Resources"
    manifest = {
        "version": (ROOT / "VERSION").read_text().strip(),
        "build_mode": "full-source",
        "source_head": head,
        "source_tree": git("rev-parse", "HEAD^{tree}"),
        "upstream_head": git("rev-parse", "upstream/main"),
        "launcher_sha256": digest(bundle / "Contents/MacOS/Cage"),
        "controller_sha256": digest(resources / "cage"),
        "guest_helper_sha256": digest(resources / "guest-os/Cage Guest Window.app/Contents/MacOS/CageGuestWindow"),
        "guest_helper_reused": False,
        "local_ad_hoc_signature": os.environ.get("CAGE_SIGNING_IDENTITY", "-") == "-",
        "notarized": False,
        "update_channel": "manual-local",
        "built_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    (resources / "CageLocalBuild.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
