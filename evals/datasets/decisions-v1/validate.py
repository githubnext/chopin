"""Validate decisions-v1: records, case files, manifest and licensing leaks.

Usage: python3 -I evals/datasets/decisions-v1/validate.py [--no-leaks]

The leak check compares every summary and every free-text record field with the
git-ignored raw cache (.cache/decisions/). Without that cache it is skipped
with a warning; run it on the collector's machine before committing.
"""

import hashlib
import json
import pathlib
import re
import sys
from datetime import datetime

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[2]
CACHE = ROOT / ".cache" / "decisions"
NGRAM = 8

ENUMS = {
	"sources.kind": {"discussion", "issue", "pr", "rfc", "proposal", "adr", "design-doc", "minutes",
		"meeting-notes", "other"},
	"domain": {"api-design", "language-design", "ui-ux", "product-behaviour", "architecture",
		"dependency", "performance", "security", "naming", "process-governance", "compatibility",
		"tooling", "docs", "infra", "data-model", "other"},
	"options.fate": {"chosen", "rejected", "deferred", "merged", "partly"},
	"participants.decider": {"consensus", "named maintainer", "vote", "BDFL", "team", "unclear"},
	"process.research": {"none", "links", "benchmarks", "survey", "data-analysis"},
	"process.spike": {"none", "prototype", "implementation-pr", "experiment", "feature-flag"},
	"process.escalation": {"none", "core-team", "steering", "tsc", "vote"},
	"outcome.how": {"consensus", "maintainer-decision", "vote", "fcp", "default/no-action",
		"abandoned", "unclear"},
	"outcome.confidence": {"stated", "implied", "none"},
	"outcome.reversibility": {"stated-easy", "stated-hard", "implied", "unknown"},
	"chopinFit.shape": {"explore", "choice", "tune", "check", "mixed", "none"},
	"chopinFit.fitsFlows": {"find", "work-in-place", "research-or-spike", "ask-teammate", "settle",
		"revisit-reopen", "build-pr", "reshape"},
	"collector": {"local-gh"},
	"fidelity.method": {"gh-api"},
}
REQUIRED = {
	"": ["id", "caseId", "collector", "sources", "repo", "domain", "title", "question",
		"questionExplicit", "context", "options", "criteria", "participants", "process", "outcome",
		"chopinFit", "evalUse", "fidelity", "notes"],
	"participants": ["count", "roles", "decider"],
	"process": ["research", "spike", "poll", "escalation", "subQuestions", "deferred", "reopened",
		"superseded", "durationDays", "comments", "reactionsTotal", "decidedOffPlatform",
		"notableMoves"],
	"outcome": ["decided", "decision", "how", "rationale", "dissent", "confidence", "reversibility",
		"implementedIn"],
	"chopinFit": ["shape", "shapeWhy", "secondaryShape", "fitsFlows", "gaps"],
	"fidelity": ["method", "truncated"],
}
EVENT_REQUIRED = ["id", "kind", "actor", "createdAt", "summary"]
EVENT_ALLOWED = {"id", "kind", "actor", "actorId", "actorType", "createdAt", "editedAt", "visibleAt",
	"url", "parentId", "summary"}
EVENT_KINDS = {"opening", "comment", "reply", "review", "review-comment", "process"}


def time(value):
	return datetime.fromisoformat(value.replace("Z", "+00:00"))


def words(text):
	return re.findall(r"[a-z0-9']+", text.lower())


def ngrams(text):
	w = words(text)
	return {tuple(w[i:i + NGRAM]) for i in range(len(w) - NGRAM + 1)}


def raw_texts(doc):
	"""Every human-written string in a cached raw response."""
	out = []

	def walk(node):
		if isinstance(node, dict):
			for key, value in node.items():
				if key in ("body", "title") and isinstance(value, str):
					out.append(value)
				else:
					walk(value)
		elif isinstance(node, list):
			for item in node:
				walk(item)
	walk(doc)
	return out


def check_records(records, cases, problems):
	ids = set()
	for n, r in enumerate(records, 1):
		where = f"decisions.jsonl:{n} ({r.get('id')})"
		for section, keys in REQUIRED.items():
			node = r if not section else r.get(section)
			if not isinstance(node, dict):
				problems.append(f"{where}: missing object {section}")
				continue
			for key in keys:
				if key not in node:
					problems.append(f"{where}: missing {section + '.' if section else ''}{key}")
		for path, allowed in ENUMS.items():
			head, _, tail = path.partition(".")
			if not tail:
				values = [r.get(head)]
			else:
				node = r.get(head)
				if isinstance(node, list):
					values = [item.get(tail) for item in node]
				elif isinstance(node, dict):
					value = node.get(tail)
					values = value if isinstance(value, list) else [value]
				else:
					values = []
			for value in values:
				if value not in allowed:
					problems.append(f"{where}: {path}={value!r} not in enum")
		second = (r.get("chopinFit") or {}).get("secondaryShape")
		if second is not None and second not in ENUMS["chopinFit.shape"]:
			problems.append(f"{where}: chopinFit.secondaryShape={second!r} not in enum")
		if r.get("id") in ids:
			problems.append(f"{where}: duplicate id")
		ids.add(r.get("id"))
		if r.get("caseId") not in cases:
			problems.append(f"{where}: caseId {r.get('caseId')!r} has no case file")
		if not isinstance(r.get("questionExplicit"), bool):
			problems.append(f"{where}: questionExplicit must be boolean")
		for key in ("poll", "deferred", "reopened", "superseded", "decidedOffPlatform"):
			if not isinstance((r.get("process") or {}).get(key), bool):
				problems.append(f"{where}: process.{key} must be boolean")
		for key in ("durationDays", "comments", "reactionsTotal"):
			if not isinstance((r.get("process") or {}).get(key), int):
				problems.append(f"{where}: process.{key} must be an integer")


def check_case(path, problems):
	where = f"cases/{path.name}"
	try:
		case = json.loads(path.read_text())
	except json.JSONDecodeError as error:
		problems.append(f"{where}: invalid JSON {error}")
		return None
	if case.get("schemaVersion") != 2 or case.get("origin") != "adapted":
		problems.append(f"{where}: must be schemaVersion 2, origin adapted")
	if case.get("id") != path.stem:
		problems.append(f"{where}: id does not match file name")
	source = case.get("source") or {}
	for key in ("url", "retrievedAt", "number"):
		if key not in source:
			problems.append(f"{where}: source.{key} missing")
	events = case.get("events") or []
	ids = [e.get("id") for e in events]
	if len(set(ids)) != len(ids):
		problems.append(f"{where}: duplicate event ids")
	known = set(ids)
	if not events or events[0].get("kind") != "opening":
		problems.append(f"{where}: first event must be the opening")
	for e in events:
		for key in EVENT_REQUIRED:
			if not e.get(key):
				problems.append(f"{where}: event {e.get('id')} missing {key}")
		if set(e) - EVENT_ALLOWED:
			problems.append(f"{where}: event {e.get('id')} has extra fields {set(e) - EVENT_ALLOWED}")
		if e.get("kind") not in EVENT_KINDS:
			problems.append(f"{where}: event {e.get('id')} kind {e.get('kind')!r}")
		if e.get("parentId") and e["parentId"] not in known:
			problems.append(f"{where}: event {e.get('id')} parent {e['parentId']} not in case")
		try:
			time(e["createdAt"])
		except (KeyError, ValueError):
			problems.append(f"{where}: event {e.get('id')} bad createdAt")
	cutoffs = case.get("cutoffs") or []
	if not 2 <= len(cutoffs) <= 4:
		problems.append(f"{where}: needs 2–4 cutoffs, has {len(cutoffs)}")
	if [c.get("id") for c in cutoffs] != [f"c{i}" for i in range(1, len(cutoffs) + 1)]:
		problems.append(f"{where}: cutoff ids must be c1..cN")
	ats = [c.get("at") for c in cutoffs]
	if ats != sorted(ats):
		problems.append(f"{where}: cutoffs out of order")
	if events and cutoffs:
		first = time(events[0]["createdAt"])
		for c in cutoffs:
			if time(c["at"]) < first:
				problems.append(f"{where}: cutoff {c['id']} precedes the opening")
	return case


def check_manifest(cases, problems):
	path = HERE / "manifest.json"
	if not path.exists():
		problems.append("manifest.json missing")
		return
	manifest = json.loads(path.read_text())
	listed = {entry["id"]: entry for entry in manifest["cases"]}
	if set(listed) != set(cases):
		problems.append(f"manifest ids differ from case files: {sorted(set(listed) ^ set(cases))[:5]}")
	for cid, entry in listed.items():
		file = HERE / entry["file"]["path"]
		if not file.exists():
			continue
		data = file.read_bytes()
		if len(data) != entry["file"]["bytes"] or hashlib.sha256(data).hexdigest() != entry["file"]["sha256"]:
			problems.append(f"manifest: {cid} size or sha256 mismatch")


def cache_key(url):
	m = re.match(r"https://github\.com/([^/]+)/([^/]+)/(issues|pull|discussions)/(\d+)", url)
	owner, repo, kind, number = m.groups()
	kind = {"pull": "pr", "issues": "issue", "discussions": "discussion"}[kind]
	return f"{owner}__{repo}__{kind}__{number}"


def check_leaks(records, cases, problems):
	if not any(CACHE.glob("*.json")):
		print("WARNING: raw cache absent; verbatim leak check skipped", file=sys.stderr)
		return
	by_case = {}
	for r in records:
		by_case.setdefault(r.get("caseId"), []).append(r)
	for cid, case in cases.items():
		urls = [case["source"]["url"]] + [p["url"] for p in case["source"].get("related", [])]
		urls += [s["url"] for r in by_case.get(cid, []) for s in r.get("sources", [])
			if "github.com" in s.get("url", "")]
		source = set()
		for url in set(urls):
			try:
				path = CACHE / f"{cache_key(url)}.json"
			except AttributeError:
				continue
			if path.exists():
				for text in raw_texts(json.loads(path.read_text())["raw"]):
					source |= ngrams(text)
		texts = [(f"cases/{cid}.json event {e['id']}", e.get("summary", "")) for e in case["events"]]
		for r in by_case.get(cid, []):
			outcome = r.get("outcome") or {}
			fields = [r.get("question"), r.get("context"), outcome.get("decision"),
				outcome.get("rationale"), outcome.get("dissent"), r.get("notes"), r.get("title")]
			fields += [o.get("label") for o in r.get("options", [])] + r.get("criteria", [])
			fields += (r.get("chopinFit") or {}).get("gaps", [])
			texts += [(f"decisions.jsonl {r.get('id')}", f) for f in fields if isinstance(f, str)]
		for where, text in texts:
			hits = ngrams(text) & source
			if hits:
				sample = " ".join(sorted(hits)[0])
				problems.append(f"LEAK {where}: {len(hits)} verbatim 8-word run(s), e.g. \"{sample}\"")


def main():
	problems = []
	records = [json.loads(line) for line in (HERE / "decisions.jsonl").read_text().splitlines() if line.strip()]
	cases = {}
	for path in sorted((HERE / "cases").glob("*.json")):
		case = check_case(path, problems)
		if case:
			cases[path.stem] = case
	check_records(records, cases, problems)
	orphans = set(cases) - {r.get("caseId") for r in records}
	for cid in sorted(orphans):
		problems.append(f"cases/{cid}.json: no decision record")
	check_manifest(cases, problems)
	if "--no-leaks" not in sys.argv:
		check_leaks(records, cases, problems)
	for problem in problems:
		print(problem)
	print(f"{len(cases)} cases, {len(records)} decisions, {len(problems)} problems")
	sys.exit(1 if problems else 0)


if __name__ == "__main__":
	main()
