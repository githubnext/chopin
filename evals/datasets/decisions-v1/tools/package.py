"""Write manifest.json and stats.json from the assembled case files and records.

Usage: python3 -I package.py   (run after assemble.py)
"""

import collections
import hashlib
import json
import pathlib
import statistics

ROOT = pathlib.Path(__file__).resolve().parents[4]
CACHE = ROOT / ".cache" / "decisions"
DATASET = ROOT / "evals" / "datasets" / "decisions-v1"


# Annotators wrote free-form gap names; these keyword rules fold synonyms into one cluster.
# Order matters: the first matching rule wins.
CLUSTERS = [
	("staged acceptance", ["staged", "in principle", "settled but not shipped", "interim decision"]),
	("off-platform decision", ["off-platform", "off platform", "off-thread", "decided elsewhere",
		"meeting", "discord", "private evidence"]),
	("votes as evidence", ["vote", "poll", "reaction", "👍", "demand signal", "+1"]),
	("coupled decisions", ["coupled", "split scope", "bundled", "per-item"]),
	("decider not in thread", ["decider", "absent", "outside the thread", "authority"]),
	("reversal after shipping", ["revers", "revert", "rollback", "flip"]),
	("superseded or moved to another thread", ["supersed", "successor", "moved to another",
		"another thread", "implementation elsewhere", "vehicle", "relocat"]),
	("duplicates merged", ["duplicate"]),
	("experiments as evidence", ["experiment", "feature flag", "spike", "prototype", "preview",
		"fork", "benchmark", "visual evidence", "user research", "data"]),
	("competing implementations", ["competing"]),
	("dormant or ownerless question", ["dorman", "stall", "no owner", "ownerless", "abandon"]),
	("unresolved dissent", ["dissent", "contested settled", "reopen request"]),
	("stale or edited record", ["stale", "edited", "living", "drift", "source of truth"]),
	("reframing", ["refram", "problem before solution", "requirement"]),
	("external dependency", ["external", "upstream", "ecosystem", "cross-repo"]),
	("configurable outcome", ["configurable", "setting as", "workaround"]),
]


def cluster(gap):
	head = gap.split(":", 1)[0].strip().lower()
	for name, keys in CLUSTERS:
		if any(k in head for k in keys):
			return name
	return "other: " + head[:50]


def share(n, total):
	return round(n / total, 3) if total else 0


def main():
	purposes = json.loads((CACHE / "purposes.json").read_text())
	records = [json.loads(l) for l in (DATASET / "decisions.jsonl").read_text().splitlines() if l.strip()]
	entries = []
	for path in sorted((DATASET / "cases").glob("*.json")):
		data = path.read_bytes()
		case = json.loads(data)
		meta = purposes[case["id"]]
		entries.append({
			"id": case["id"],
			"kind": "async-discussion",
			"origin": "adapted",
			"sourceCluster": meta["quota"],
			"sourceUrl": case["source"]["url"],
			"retrievedAt": case["source"]["retrievedAt"],
			"relatedUrls": [p["url"] for p in case["source"].get("related", [])],
			"checkpoints": [c["id"] for c in case["cutoffs"]],
			"checkpointPurposes": meta["checkpoints"],
			"file": {"path": f"cases/{path.name}", "sha256": hashlib.sha256(data).hexdigest(),
				"bytes": len(data)},
			"reuse": "attributed-paraphrase",
		})
	manifest = {"version": 1, "dataset": "decisions-v1", "partition": "development",
		"caseSchemaVersion": 2, "holdoutCheck": "pending", "cases": entries}
	(DATASET / "manifest.json").write_text(json.dumps(manifest, indent="\t") + "\n")

	n = len(records)
	gaps = collections.Counter()
	gap_examples = collections.defaultdict(list)
	for r in records:
		for c in {cluster(g) for g in r["chopinFit"]["gaps"]}:
			gaps[c] += 1
			if len(gap_examples[c]) < 5:
				gap_examples[c].append(r["caseId"])
	coupled = sum(bool(r["process"]["subQuestions"])
		or any(cluster(g) == "coupled decisions" for g in r["chopinFit"]["gaps"]) for r in records)
	reversed_ = sum(r["process"]["superseded"] or r["process"]["reopened"]
		or any(cluster(g) == "reversal after shipping" for g in r["chopinFit"]["gaps"]) for r in records)
	stats = {
		"decisions": n,
		"cases": len(entries),
		"byQuota": dict(collections.Counter(e["sourceCluster"] for e in entries).most_common()),
		"byDomain": dict(collections.Counter(r["domain"] for r in records).most_common()),
		"byOutcomeHow": dict(collections.Counter(r["outcome"]["how"] for r in records).most_common()),
		"decidedShare": share(sum(r["outcome"]["decided"] for r in records), n),
		"shapeDistribution": dict(collections.Counter(r["chopinFit"]["shape"] for r in records).most_common()),
		"secondaryShapeDistribution": dict(collections.Counter(
			r["chopinFit"]["secondaryShape"] for r in records if r["chopinFit"]["secondaryShape"]).most_common()),
		"flowDistribution": dict(collections.Counter(
			f for r in records for f in r["chopinFit"]["fitsFlows"]).most_common()),
		"topGapClusters": [{"gap": g, "decisions": c, "share": share(c, n), "examples": gap_examples[g]}
			for g, c in gaps.most_common(20)],
		"shareWithSubQuestionsOrCoupling": share(coupled, n),
		"shareWithSubQuestions": share(sum(bool(r["process"]["subQuestions"]) for r in records), n),
		"shareWithCouplingGap": share(sum(any(cluster(g) == "coupled decisions"
			for g in r["chopinFit"]["gaps"]) for r in records), n),
		"shareFlaggedSupersededOrReopened": share(sum(r["process"]["superseded"] or r["process"]["reopened"]
			for r in records), n),
		"shareDecidedOffPlatform": share(sum(r["process"]["decidedOffPlatform"] for r in records), n),
		"shareReversedReopenedOrSuperseded": share(reversed_, n),
		"medianParticipants": statistics.median(r["participants"]["count"] for r in records) if n else None,
		"medianDurationDays": statistics.median(r["process"]["durationDays"] for r in records) if n else None,
		"truncatedShare": share(sum(r["fidelity"]["truncated"] for r in records), n),
	}
	(DATASET / "stats.json").write_text(json.dumps(stats, indent="\t", ensure_ascii=False) + "\n")
	print(json.dumps({k: stats[k] for k in ("cases", "decisions", "byQuota", "shapeDistribution")}))


if __name__ == "__main__":
	main()
