"""Build case files, decisions.jsonl and candidate statuses from annotations.

Usage: python3 -I assemble.py

Reads every .cache/decisions/ann/<key>.json annotation and its normalised
skeleton(s). Structural fields (ids, actors, times, parents, URLs) always come
from the skeleton; annotations supply only paraphrased summaries, cutoffs and
decision records. Reruns rebuild every output from scratch.
"""

import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[4]
CACHE = ROOT / ".cache" / "decisions"
DATASET = ROOT / "evals" / "datasets" / "decisions-v1"
FIELD_ORDER = ["id", "kind", "actor", "createdAt", "editedAt", "visibleAt", "url", "summary",
	"actorId", "actorType", "parentId"]


def load_norm(key):
	return json.loads((CACHE / "norm" / f"{key}.json").read_text())


def build_case(ann):
	primary = load_norm(ann["key"])
	parts = [primary] + [load_norm(k) for k in ann.get("include", [])]
	drop = set(ann.get("drop", []))
	events = sorted((e for p in parts for e in p["events"] if e["id"] not in drop),
		key=lambda e: (e["createdAt"], e["kind"] != "opening"))
	for e in events:
		if e.get("default") and not ann["summaries"].get(e["id"], "").strip():
			ann["summaries"][e["id"]] = e["default"]
	missing = [e["id"] for e in events if not ann["summaries"].get(e["id"], "").strip()]
	if missing:
		raise ValueError(f"{ann['key']}: {len(missing)} events lack summaries, e.g. {missing[:3]}")
	unknown = set(ann["summaries"]) - {e["id"] for e in events}
	if unknown:
		raise ValueError(f"{ann['key']}: summaries for unknown events {sorted(unknown)[:3]}")
	out = []
	for e in events:
		e = dict(e, summary=ann["summaries"][e["id"]].strip())
		out.append({k: e[k] for k in FIELD_ORDER if e.get(k) is not None})
	meta = primary["meta"]
	source = {"url": meta["url"], "retrievedAt": meta["retrievedAt"], "repository": meta["repo"],
		"number": meta["number"]}
	if meta.get("nodeId"):
		source["nodeId"] = meta["nodeId"]
	related = [{"url": p["meta"]["url"], "retrievedAt": p["meta"]["retrievedAt"]} for p in parts[1:]]
	if related:
		source["related"] = related
	cutoffs = sorted(ann["cutoffs"], key=lambda c: c["at"])
	case = {"schemaVersion": 2, "origin": "adapted", "id": ann["caseId"], "title": ann["title"],
		"source": source, "cutoffs": [{"id": c["id"], "at": c["at"]} for c in cutoffs], "events": out}
	dropped = sum(p["meta"]["droppedEvents"] for p in parts)
	return case, parts, dropped, cutoffs


def main():
	anns = [json.loads(p.read_text()) for p in sorted((CACHE / "ann").glob("*.json"))]
	cand_path = DATASET / "candidates.json"
	candidates = json.loads(cand_path.read_text())
	by_url = {c["url"]: c for c in candidates["candidates"]}
	cases_dir = DATASET / "cases"
	cases_dir.mkdir(exist_ok=True)
	for stale in cases_dir.glob("*.json"):
		stale.unlink()
	decisions, purposes, errors, merged = [], {}, 0, {}
	for ann in anns:
		norm = load_norm(ann["key"])
		entry = by_url.get(norm["meta"]["url"])
		if entry is None:
			entry = by_url[norm["meta"]["url"]] = {"url": norm["meta"]["url"], "source": "follow-up"}
			candidates["candidates"].append(entry)
		if ann["verdict"] != "keep":
			entry.update(status="discarded", reason=ann.get("discardReason"))
			continue
		try:
			case, parts, dropped, cutoffs = build_case(ann)
		except ValueError as error:
			errors += 1
			print(f"ERROR {error}", file=sys.stderr)
			continue
		entry.update(status="kept", reason=None, quota=ann["quota"], caseId=ann["caseId"])
		for part in parts[1:]:
			merged[part["meta"]["url"]] = ann["caseId"]
		text = json.dumps(case, indent="\t", ensure_ascii=False) + "\n"
		(cases_dir / f"{ann['caseId']}.json").write_text(text)
		purposes[ann["caseId"]] = {"quota": ann["quota"],
			"checkpoints": {c["id"]: c.get("purpose") for c in cutoffs}}
		for record in ann["decisions"]:
			record = dict(record, caseId=ann["caseId"], collector="local-gh")
			record["fidelity"] = {"method": "gh-api", "truncated": dropped > 0}
			if dropped:
				note = f"{dropped} low-signal comments omitted by the 150-event cap."
				record["notes"] = (record.get("notes") or "").strip() + (" " if record.get("notes") else "") + note
			decisions.append(record)
	# Applied after every annotation so a thread kept as its own case is never relabelled.
	for url, case_id in merged.items():
		linked = by_url.get(url)
		if linked and linked.get("status") != "kept":
			linked.update(status="merged", reason=f"part of case {case_id}")
	for entry in candidates["candidates"]:
		if entry.get("status") in (None, "pending"):
			entry.update(status="not-screened",
				reason="Fetched but not annotated: its quota was already met when screening stopped.")
	(DATASET / "decisions.jsonl").write_text(
		"".join(json.dumps(d, ensure_ascii=False) + "\n" for d in decisions))
	(CACHE / "purposes.json").write_text(json.dumps(purposes, indent=1))
	cand_path.write_text(json.dumps(candidates, indent="\t", ensure_ascii=False) + "\n")
	print(f"{len(purposes)} cases, {len(decisions)} decisions, {errors} errors")
	sys.exit(1 if errors else 0)


if __name__ == "__main__":
	main()
