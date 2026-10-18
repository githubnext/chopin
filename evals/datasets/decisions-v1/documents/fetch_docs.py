"""Fetch the source documents behind documents/decisions.jsonl into the raw cache.

Usage: python3 -I fetch_docs.py   (reads every sources[].url in documents/decisions.jsonl)

Each document is cached once as .cache/decisions/docs/<sha256 of url>.json. The
cache is git-ignored; documents/validate.py uses it for the verbatim-leak check.
"""

import base64
import hashlib
import json
import pathlib
import re
import subprocess
import sys
from datetime import datetime, timezone

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[3]
DOCS = ROOT / ".cache" / "decisions" / "docs"


def doc_path(url):
	return DOCS / f"{hashlib.sha256(url.encode()).hexdigest()[:24]}.json"


def locate(url):
	"""Map a source URL to (owner, repo, path, ref) in a GitHub repository."""
	url = url.split("#")[0]
	m = re.match(r"https://github\.com/([^/]+)/([^/]+)/blob/([^/]+)/(.+)", url)
	if m:
		owner, repo, ref, path = m.groups()
		return owner, repo, path, ref
	m = re.match(r"https://raw\.githubusercontent\.com/([^/]+)/([^/]+)/([^/]+)/(.+)", url)
	if m:
		owner, repo, ref, path = m.groups()
		return owner, repo, path, ref
	m = re.match(r"https://peps\.python\.org/pep-(\d+)/?", url)
	if m:
		return "python", "peps", f"peps/pep-{int(m.group(1)):04d}.rst", None
	raise ValueError(f"Unsupported document URL: {url}")


def fetch(url):
	path = doc_path(url)
	if path.exists():
		return "cached"
	owner, repo, file, ref = locate(url)
	api = f"repos/{owner}/{repo}/contents/{file}" + (f"?ref={ref}" if ref else "")
	out = subprocess.run(["gh", "api", api], capture_output=True, text=True)
	if out.returncode != 0:
		raise RuntimeError(out.stderr.strip()[:200])
	body = json.loads(out.stdout)
	text = base64.b64decode(body["content"]).decode("utf-8", "replace")
	DOCS.mkdir(parents=True, exist_ok=True)
	path.write_text(json.dumps({"url": url, "api": api, "sha": body.get("sha"),
		"retrievedAt": datetime.now(timezone.utc).isoformat(), "text": text}))
	return "fetched"


if __name__ == "__main__":
	records = [json.loads(l) for l in (HERE / "decisions.jsonl").read_text().splitlines() if l.strip()]
	failed = 0
	for url in sorted({s["url"] for r in records for s in r["sources"]}):
		try:
			print(f"{fetch(url)}\t{url}")
		except Exception as error:  # report every failure and keep going
			failed += 1
			print(f"FAILED\t{url}\t{error}", file=sys.stderr)
	sys.exit(1 if failed else 0)
