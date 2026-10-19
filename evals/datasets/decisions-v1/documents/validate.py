"""Validate documents/decisions.jsonl with the main validator's record checks.

Usage: python3 -I evals/datasets/decisions-v1/documents/validate.py

Document records differ from thread records in four allowed ways: `caseId` is
null (there is no case file), `collector` is "cloud-git", `fidelity.method` is
"git-file", and counts a document cannot supply (`participants.count`,
`process.durationDays`, `process.comments`, `process.reactionsTotal`) may be
null. Everything else uses validate.py's checks unchanged. The leak check
compares free text with the cached source documents (fetch_docs.py).
"""

import importlib.util
import json
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from fetch_docs import doc_path  # noqa: E402

# This file shares the main validator's name, so load that one by path.
_spec = importlib.util.spec_from_file_location("thread_validate", HERE.parent / "validate.py")
base = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(base)

NULLABLE = ("durationDays", "comments", "reactionsTotal")
ENUMS = dict(base.ENUMS, collector={"cloud-git"}, **{"fidelity.method": {"git-file"}})


def check_records(records, problems):
	base.check_records(records, {}, problems, enums=ENUMS, nullable=NULLABLE,
		file="documents/decisions.jsonl", require_case=False)
	for n, r in enumerate(records, 1):
		where = f"documents/decisions.jsonl:{n} ({r.get('id')})"
		count = r["participants"].get("count")
		if count is not None and not isinstance(count, int):
			problems.append(f"{where}: participants.count must be an integer or null")
		for gap in r["chopinFit"]["gaps"]:
			if not re.match(r"^[a-z][a-z -]*: \S", gap):
				problems.append(f"{where}: gap is not 'cluster: detail': {gap[:60]!r}")


def check_leaks(records, problems):
	for r in records:
		source = set()
		missing = []
		for s in r["sources"]:
			path = doc_path(s["url"])
			if path.exists():
				source |= base.ngrams(json.loads(path.read_text())["text"])
			else:
				missing.append(s["url"])
		if missing:
			print(f"WARNING: {r['id']}: {len(missing)} source(s) not cached; run fetch_docs.py", file=sys.stderr)
		for text in base.record_texts(r):
			hits = base.ngrams(text) & source
			if hits:
				sample = " ".join(sorted(hits)[0])
				problems.append(f"LEAK documents/decisions.jsonl {r['id']}: {len(hits)} verbatim 8-word run(s), e.g. \"{sample}\"")


def main():
	records = [json.loads(l) for l in (HERE / "decisions.jsonl").read_text().splitlines() if l.strip()]
	threads = [json.loads(l) for l in (HERE.parent / "decisions.jsonl").read_text().splitlines() if l.strip()]
	problems = []
	check_records(records, problems)
	clash = {r["id"] for r in records} & {r["id"] for r in threads}
	if clash:
		problems.append(f"ids shared with thread records: {sorted(clash)}")
	if any(doc_path(s["url"]).exists() for r in records for s in r["sources"]):
		if "--no-leaks" not in sys.argv:
			check_leaks(records, problems)
	else:
		print("WARNING: document cache absent; verbatim leak check skipped", file=sys.stderr)
	for problem in problems:
		print(problem)
	print(f"{len(records)} document records, {len(problems)} problems")
	sys.exit(1 if problems else 0)


if __name__ == "__main__":
	main()
