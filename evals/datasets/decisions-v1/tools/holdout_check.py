"""Check decisions-v1 against holdout thread URLs before committing.

Usage: python3 -I holdout_check.py URLS_FILE   (one GitHub URL per line)

Matches each holdout against every candidate, case source, related thread, and
the sources and implementations of every thread and document decision record,
ignoring URL fragments, trailing slashes and case. Exits 1 if
any kept or merged material matches; remove those cases, mark the candidates
`holdout`, rerun assemble.py and package.py, then rerun this check.
"""

import json
import pathlib
import re
import sys

DATASET = pathlib.Path(__file__).resolve().parents[1]


def canon(url):
	url = url.strip().split("#")[0].split("?")[0].rstrip("/").lower()
	# Issues, PRs and discussions share one number space per repository.
	return re.sub(r"/(pull|discussions)/", "/issues/", url)


def main():
	holdouts = {canon(line) for line in pathlib.Path(sys.argv[1]).read_text().splitlines() if line.strip()}
	hits = []
	for c in json.loads((DATASET / "candidates.json").read_text())["candidates"]:
		if canon(c["url"]) in holdouts:
			hits.append(f"candidate {c['url']} (status {c.get('status')})")
	for path in sorted((DATASET / "cases").glob("*.json")):
		source = json.loads(path.read_text())["source"]
		for url in [source["url"]] + [r["url"] for r in source.get("related", [])]:
			if canon(url) in holdouts:
				hits.append(f"case {path.stem}: {url}")
	for name in ("decisions.jsonl", "documents/decisions.jsonl"):
		path = DATASET / name
		if not path.exists():
			continue
		for line in path.read_text().splitlines():
			if not line.strip():
				continue
			record = json.loads(line)
			for url in [s["url"] for s in record["sources"]] + record["outcome"]["implementedIn"]:
				if canon(url) in holdouts:
					hits.append(f"{name}: {record['id']} cites {url}")
	for hit in hits:
		print(hit)
	print(f"{len(holdouts)} holdouts checked, {len(hits)} matches")
	sys.exit(1 if hits else 0)


if __name__ == "__main__":
	main()
