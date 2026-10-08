// Date parsing + time-axis ticks shared by timeline and gantt.
// Accepts numbers, "2026", "2026-03", "2026-03-14", "2026-Q2", "Q2 2026".

const DAY = 864e5;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function parseTime(v) {
	if (typeof v === "number") return { t: v, kind: "num" };
	const s = String(v).trim();
	let m;
	if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
		return { t: Date.UTC(+m[1], +m[2] - 1, +m[3]), kind: "day" };
	}
	if ((m = s.match(/^(\d{4})-(\d{1,2})$/))) {
		return { t: Date.UTC(+m[1], +m[2] - 1, 1), kind: "month" };
	}
	if ((m = s.match(/^(\d{4})-?Q([1-4])$/i) || s.match(/^Q([1-4])\s+(\d{4})$/i))) {
		const [y, q] = m[1].length === 4 ? [+m[1], +m[2]] : [+m[2], +m[1]];
		return { t: Date.UTC(y, (q - 1) * 3, 1), kind: "quarter" };
	}
	if ((m = s.match(/^(\d{4})$/))) return { t: Date.UTC(+m[1], 0, 1), kind: "year" };
	return null;
}

export function addDays(t, d) {
	return t + d * DAY;
}

export function fmtTime(t, kind) {
	if (kind === "num") return String(Math.round(t * 100) / 100);
	const d = new Date(t);
	const y = d.getUTCFullYear(), mo = d.getUTCMonth();
	if (kind === "year") return String(y);
	if (kind === "quarter") return `Q${Math.floor(mo / 3) + 1} ${y}`;
	if (kind === "month") return `${MON[mo]} ${y}`;
	return `${MON[mo]} ${d.getUTCDate()}`;
}

// Ticks across [t0, t1] (ms or plain numbers): ~4–10 ticks on natural boundaries.
export function timeTicks(t0, t1, numeric) {
	if (numeric) {
		const span = t1 - t0 || 1;
		const raw = span / 6;
		const mag = 10 ** Math.floor(Math.log10(raw));
		const step = [1, 2, 5, 10].map((k) => k * mag).find((k) => span / k <= 8) || mag * 10;
		const out = [];
		for (let v = Math.ceil(t0 / step) * step; v <= t1 + 1e-9; v += step) {
			out.push({ t: v, label: fmtTime(v, "num") });
		}
		return out;
	}
	const days = (t1 - t0) / DAY;
	const out = [];
	const d = new Date(t0);
	if (days > 365 * 3) {
		const step = days > 365 * 12 ? 5 : days > 365 * 6 ? 2 : 1;
		for (let y = Math.ceil(d.getUTCFullYear() / step) * step; Date.UTC(y, 0, 1) <= t1; y += step) {
			const t = Date.UTC(y, 0, 1);
			if (t >= t0) out.push({ t, label: String(y) });
		}
	} else if (days > 120) {
		const months = days > 540 ? 3 : 1;
		let y = d.getUTCFullYear(), mo = d.getUTCMonth();
		for (; Date.UTC(y, mo, 1) <= t1; mo += months) {
			const t = Date.UTC(y, mo, 1);
			if (t >= t0) {
				out.push({
					t,
					label: months === 3
						? fmtTime(t, "quarter")
						: MON[new Date(t).getUTCMonth()]
							+ (new Date(t).getUTCMonth() === 0 ? ` ${new Date(t).getUTCFullYear()}` : ""),
				});
			}
		}
	} else {
		const step = days > 45 ? 7 : days > 14 ? 2 : 1;
		for (
			let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
			t <= t1;
			t += step * DAY
		) {
			if (t >= t0) out.push({ t, label: fmtTime(t, "day") });
		}
	}
	return out;
}

export { DAY };
