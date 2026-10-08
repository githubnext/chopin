// Tiny JSON-Schema subset validator (no dependencies).
// Supports: type, enum, const, required, properties, additionalProperties,
// items (schema or tuple array), minItems, maxItems, minimum, maximum,
// minLength, maxLength, pattern, anyOf, oneOf, $ref (local "#/$defs/…").

function typeOf(v) {
	if (v === null) return "null";
	if (Array.isArray(v)) return "array";
	if (Number.isInteger(v)) return "integer";
	return typeof v;
}

function typeMatches(v, t) {
	const actual = typeOf(v);
	if (t === "number") return actual === "number" || actual === "integer";
	return actual === t;
}

function resolve(root, ref) {
	if (!ref.startsWith("#/")) throw new Error(`unsupported $ref ${ref}`);
	return ref.slice(2).split("/").reduce((o, k) => o?.[k], root);
}

export function validate(schema, value, root = schema, path = "", out = []) {
	if (schema.$ref) return validate(resolve(root, schema.$ref), value, root, path, out);
	const at = path || "(root)";
	if (schema.type) {
		const types = [].concat(schema.type);
		if (!types.some((t) => typeMatches(value, t))) {
			out.push({ at, msg: `expected ${types.join("|")}, got ${typeOf(value)}` });
			return out;
		}
	}
	if (schema.const !== undefined && value !== schema.const) {
		out.push({ at, msg: `must be ${JSON.stringify(schema.const)}` });
	}
	if (schema.enum && !schema.enum.includes(value)) {
		out.push({ at, msg: `must be one of ${schema.enum.join(", ")}` });
	}
	if (typeof value === "string") {
		if (schema.minLength !== undefined && value.length < schema.minLength) {
			out.push({ at, msg: `too short (min ${schema.minLength})` });
		}
		if (schema.maxLength !== undefined && value.length > schema.maxLength) {
			out.push({ at, msg: `too long (max ${schema.maxLength} chars)` });
		}
		if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
			out.push({ at, msg: `must match ${schema.pattern}` });
		}
	}
	if (typeof value === "number") {
		if (schema.minimum !== undefined && value < schema.minimum) {
			out.push({ at, msg: `must be >= ${schema.minimum}` });
		}
		if (schema.maximum !== undefined && value > schema.maximum) {
			out.push({ at, msg: `must be <= ${schema.maximum}` });
		}
	}
	if (Array.isArray(value)) {
		if (schema.minItems !== undefined && value.length < schema.minItems) {
			out.push({ at, msg: `needs at least ${schema.minItems} items` });
		}
		if (schema.maxItems !== undefined && value.length > schema.maxItems) {
			out.push({ at, msg: `allows at most ${schema.maxItems} items` });
		}
		if (Array.isArray(schema.items)) {
			schema.items.forEach((s, i) => {
				if (i < value.length) validate(s, value[i], root, `${path}[${i}]`, out);
			});
		} else if (schema.items) {
			value.forEach((v, i) => validate(schema.items, v, root, `${path}[${i}]`, out));
		}
	}
	if (value && typeof value === "object" && !Array.isArray(value)) {
		for (const k of schema.required || []) {
			if (value[k] === undefined) out.push({ at: path ? `${path}.${k}` : k, msg: "is required" });
		}
		const props = schema.properties || {};
		for (const [k, v] of Object.entries(value)) {
			const p = path ? `${path}.${k}` : k;
			if (Object.hasOwn(props, k)) validate(props[k], v, root, p, out);
			else if (schema.additionalProperties === false) out.push({ at: p, msg: "unknown field" });
			else if (typeof schema.additionalProperties === "object") {
				validate(schema.additionalProperties, v, root, p, out);
			}
		}
	}
	for (const key of ["anyOf", "oneOf"]) {
		if (!schema[key]) continue;
		const results = schema[key].map((s) => validate(s, value, root, path, []));
		const ok = results.filter((r) => r.length === 0).length;
		if (key === "anyOf" ? ok === 0 : ok !== 1) {
			const best = results.reduce((a, b) => (b.length < a.length ? b : a));
			out.push(...(best.length ? best : [{ at, msg: `must match exactly one allowed shape` }]));
		}
	}
	return out;
}
