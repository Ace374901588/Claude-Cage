#!/usr/bin/env python3
"""Build a separate local H264 application using the verified pinned vendor kit.

Never replaces the vendor application or a running binary. Guest installation
is a separate, explicit step; --guest-app may reuse an unchanged approved helper
so a host-only update does not invalidate its guest privacy permissions.
"""
from pathlib import Path
import argparse
import hashlib
import json
import os
import plistlib
import re
import shutil
import subprocess
import tempfile

SOURCE = Path(__file__).resolve().parent.parent
VERSION = "0.1.8-local.h264.6"
BASE = "c31d80cca5d8f79ae84e8b2e8ec3d7aa16020f3b"


def incompatible_vendor_sources():
    """The pinned bundle cannot supply newer launchers or guest kit scripts."""
    changed = subprocess.check_output([
        "git", "diff", "--name-only", BASE, "HEAD", "--", "desktop",
        "scripts/guest-os", "scripts/bundle-cloud-kit.mjs", "deploy/cloud",
    ], cwd=SOURCE, text=True).splitlines()
    builder = (SOURCE / "scripts/guest-os/build-macos-claude-window.sh").read_text()
    compiled = {"scripts/guest-os/" + name for name in re.findall(r'"\$src/([^"\n]+)"', builder)
                if name.endswith((".swift", ".c", ".m", ".h")) and not name.startswith("../")}
    return [name for name in changed if not (
        name in compiled or name == "scripts/guest-os/build-macos-claude-window.sh" or
        name.startswith("scripts/guest-os/tests/"))]


def run(*args, **kwargs):
    return subprocess.run([str(arg) for arg in args], check=True, **kwargs)


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-app", type=Path, default=Path("/Applications/Cage.app"))
    parser.add_argument("--guest-app", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--skip-build", action="store_true")
    args = parser.parse_args()
    output = args.output.absolute()
    if not args.output.is_absolute() or output.suffix != ".app" or output.exists() or output.is_symlink():
        parser.error("--output must be a new absolute .app destination")
    incompatible = incompatible_vendor_sources()
    if incompatible:
        parser.error("This source has newer launchers or guest resources than the pinned vendor kit. "
                     "Build the complete current application with bash scripts/build-app.sh; "
                     "do not mix its controller with an older installed bundle. Changed sources: " +
                     ", ".join(incompatible[:5]))
    vendor = args.base_app.resolve(strict=True)
    if plistlib.loads((vendor / "Contents/Info.plist").read_bytes()).get("CageVersion") != "0.1.8-rc":
        parser.error("This integration requires the pinned 0.1.8-rc vendor kit")
    run("codesign", "--verify", "--deep", "--strict", vendor)
    clean = subprocess.check_output(["git", "status", "--porcelain"], cwd=SOURCE, text=True)
    if clean:
        parser.error("Commit the reviewed source before building a reproducible package")
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=SOURCE, text=True).strip()
    if not args.skip_build:
        run("bash", "scripts/guest-os/build-macos-guest-core.sh", VERSION, cwd=SOURCE)
    controller = SOURCE / "_output/bin/cage"
    actual_version = subprocess.check_output([str(controller), "version"], text=True).strip()
    if VERSION not in actual_version.split():
        parser.error("Controller version does not match the local package; rebuild it")
    run(controller, "verify-web-assets")
    run(controller, "verify-macos-guest")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".cage-h264-build-", dir=output.parent) as temporary:
        stage = Path(temporary)
        guest = args.guest_app.resolve(strict=True) if args.guest_app else stage / "Guest.app"
        if not args.guest_app:
            run("bash", "scripts/guest-os/build-macos-claude-window.sh", guest, cwd=SOURCE)
        guest_info = plistlib.loads((guest / "Contents/Info.plist").read_bytes())
        if guest_info.get("CFBundleIdentifier") != "dev.cage.GuestClaudeWindow":
            parser.error("Guest helper identity differs from Cage Guest Window")
        run("codesign", "--verify", "--deep", "--strict", guest)
        bundle = stage / "Cage H264.app"
        run("ditto", vendor, bundle)
        target = bundle / "Contents/Resources/cage"
        replacement = target.with_name(".cage-replacement")
        shutil.copy2(controller, replacement)
        os.replace(replacement, target)
        kit_guest = bundle / "Contents/Resources/guest-os/Cage Guest Window.app"
        shutil.rmtree(kit_guest)
        run("ditto", guest, kit_guest)
        info_path = bundle / "Contents/Info.plist"
        info = plistlib.loads(info_path.read_bytes())
        info.update(CFBundleIdentifier="io.github.lee-xeo.claude-cage.h264-local",
                    CFBundleName="Cage H264", CFBundleDisplayName="Cage H264",
                    CFBundleVersion="9", CFBundleShortVersionString="0.1.8", CageVersion=VERSION)
        info_path.write_bytes(plistlib.dumps(info))
        material = bundle / "Contents/Resources/local-h264"
        material.mkdir()
        with (material / "source.patch").open("wb") as patch:
            run("git", "diff", "--binary", BASE, head, cwd=SOURCE, stdout=patch)
        shutil.copy2(SOURCE / "H264_LOCAL.txt", material / "H264_LOCAL.txt")
        manifest = {"version": VERSION, "source_base": BASE, "source_head": head,
                    "controller_sha256": sha(target),
                    "guest_helper_sha256": sha(kit_guest / "Contents/MacOS/CageGuestWindow"),
                    "guest_helper_reused": bool(args.guest_app),
                    "source_patch_sha256": sha(material / "source.patch"),
                    "local_ad_hoc_signature": True, "notarized": False,
                    "update_channel": "manual-local", "runtime_acceptance": "see external acceptance record"}
        (bundle / "Contents/Resources/CageLocalBuild.json").write_text(json.dumps(manifest, indent=2) + "\n")
        run("codesign", "--force", "--sign", "-", bundle)
        run("codesign", "--verify", "--deep", "--strict", bundle)
        run(target, "verify-web-assets")
        run(target, "verify-macos-guest")
        if output.exists() or output.is_symlink():
            raise RuntimeError("Output appeared during the build; nothing replaced")
        os.rename(bundle, output)
    print(json.dumps({"application": str(output), **manifest}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
