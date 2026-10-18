"""Check one or more annotations in isolation, without touching shared outputs.

Usage: python3 -I check_ann.py KEY [KEY ...]

Builds each case in memory and runs the record, case-shape and verbatim-leak
checks from validate.py. Safe to run while other annotators work.
"""

import json
import pathlib
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import assemble  # noqa: E402
import validate  # noqa: E402


def check(key):
	ann = json.loads((assemble.CACHE / "ann" / f"{key}.json").read_text())
	if ann["verdict"] != "keep":
		return [] if ann.get("discardReason") else [f"{key}: discard without discardReason"]
	problems = []
	try:
		case, parts, dropped, cutoffs = assemble.build_case(ann)
	except ValueError as error:
		return [str(error)]
	if ann.get("quota") not in {"product-ui", "pr-debate", "eng-issue", "formal-process",
			"small-team", "open-choice"}:
		problems.append(f"{key}: bad quota {ann.get('quota')!r}")
	for c in cutoffs:
		if c.get("purpose") not in {"question-clear", "options-on-table", "before-decision",
				"after-decision"}:
			problems.append(f"{key}: cutoff {c.get('id')} purpose {c.get('purpose')!r}")
	with tempfile.TemporaryDirectory() as tmp:
		path = pathlib.Path(tmp) / f"{ann['caseId']}.json"
		path.write_text(json.dumps(case))
		validate.check_case(path, problems)
	records = [dict(r, caseId=ann["caseId"], collector="local-gh",
		fidelity={"method": "gh-api", "truncated": dropped > 0}) for r in ann["decisions"]]
	validate.check_records(records, {ann["caseId"]: case}, problems)
	validate.check_leaks(records, {ann["caseId"]: case}, problems)
	return problems


if __name__ == "__main__":
	problems = [p for key in sys.argv[1:] for p in check(key)]
	for p in problems:
		print(p)
	print(f"{len(sys.argv) - 1} annotations, {len(problems)} problems")
	sys.exit(1 if problems else 0)
