"""Restore only registered development inputs into ignored local storage."""

import argparse
import hashlib
import json
import pathlib
import subprocess


HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
DEST = ROOT / "data/visual-doc-corpus/development"


def restore(path, sha256, get_bytes):
    relative = pathlib.PurePosixPath(path)
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError(f"Invalid registered path: {path}")
    target = DEST / relative
    if target.exists():
        contents = target.read_bytes()
    else:
        contents = get_bytes()
    if hashlib.sha256(contents).hexdigest() != sha256:
        raise ValueError(f"Source hash mismatch: {path}")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(contents)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source-git",
        type=pathlib.Path,
        default=ROOT,
        help="Git checkout containing the archived source commits",
    )
    parser.add_argument(
        "--with-proposals",
        action="store_true",
        help="Also verify separately downloaded pinned proposal text",
    )
    args = parser.parse_args()
    registry = json.loads((HERE / "registry.json").read_text())
    restored = 0
    for entry in registry["development"]:
        records = [entry.get("file"), *(entry.get("files") or []), entry.get("provenance")]
        for record in filter(None, records):
            source = f"{entry['snapshot']}:{record['sourcePath']}"

            def source_bytes():
                return subprocess.check_output(
                    ["git", "-C", str(args.source_git), "show", source], stderr=subprocess.DEVNULL
                )

            restore(record["path"], record["sha256"], source_bytes)
            restored += 1
    if args.with_proposals:
        proposals = json.loads((HERE / "proposals.json").read_text())
        for entry in proposals["cases"]:

            def missing_proposal():
                raise FileNotFoundError(
                    f"Download {entry['pinnedUrl']} to {DEST / entry['file']['path']}"
                )

            restore(entry["file"]["path"], entry["file"]["sha256"], missing_proposal)
            restored += 1
    (DEST / "registry.json").write_bytes((HERE / "registry.json").read_bytes())
    print(f"Verified {restored} development files in {DEST}")


if __name__ == "__main__":
    main()
