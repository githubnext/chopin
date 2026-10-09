import { parse as parseJavaScript } from "@babel/parser";

import type { Extraction } from "./source";

type Ast = { type: string; [key: string]: unknown };
type Scope = { parent?: Scope; bindings: Map<string, Ast | undefined> };
export let presentation = new Set([
	"font",
	"font-size",
	"font-family",
	"color",
	"fill",
	"stroke",
	"stop-color",
	"flood-color",
	"lighting-color",
]);

function node(value: unknown): Ast | undefined {
	return value && typeof value === "object" && "type" in value
		? value as Ast
		: undefined;
}

function children(value: Ast): Ast[] {
	return Object.entries(value).flatMap(([key, child]) => {
		if (["comments", "tokens", "loc", "leadingComments", "trailingComments"].includes(key)) {
			return [];
		}
		return (Array.isArray(child) ? child : [child]).map(node).filter((n): n is Ast => !!n);
	});
}

function propertyName(value: string): string {
	if (value.startsWith("--")) return value;
	return value.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`).replace(/^ms-/, "-ms-");
}

function absent(current: Ast | undefined): boolean {
	return !current || current.type === "NullLiteral"
		|| (current.type === "Identifier" && current.name === "undefined")
		|| current.type === "BooleanLiteral";
}

export function extractJavaScript(
	file: string,
	source: string,
	baseLine: number,
	result: Extraction,
	addCss: (css: string, line?: number, context?: string) => void,
	staticImport?: (specifier: string, name: string) => Record<string, string> | undefined,
): void {
	let tree: Ast;
	try {
		tree = parseJavaScript(source, {
			sourceType: "unambiguous",
			plugins: ["typescript", "jsx"],
		}) as unknown as Ast;
	} catch (error) {
		result.errors.push(`${file}:${baseLine} JavaScript parse error: ${String(error)}`);
		return;
	}
	let scopes = new WeakMap<Ast, Scope>();
	let parents = new WeakMap<Ast, Ast>();
	let all: Ast[] = [];
	let bindPattern = (pattern: Ast | undefined, scope: Scope, value?: Ast) => {
		if (!pattern) return;
		if (pattern.type === "Identifier") scope.bindings.set(String(pattern.name), value);
		else if (pattern.type === "ObjectProperty") bindPattern(node(pattern.value), scope);
		else if (pattern.type === "AssignmentPattern") bindPattern(node(pattern.left), scope);
		else for (let child of children(pattern)) bindPattern(child, scope);
	};
	let collect = (current: Ast, parent: Scope) => {
		let scope = /^(?:Program|BlockStatement|CatchClause|.*Function.*)$/.test(current.type)
			? { parent, bindings: new Map<string, Ast | undefined>() }
			: parent;
		scopes.set(current, scope);
		all.push(current);
		if (current.type === "VariableDeclarator") {
			bindPattern(node(current.id), scope, node(current.init));
		}
		if (current.type === "FunctionDeclaration") {
			bindPattern(node(current.id), parent, current);
		}
		if (Array.isArray(current.params)) {
			for (let param of current.params) bindPattern(node(param), scope);
		}
		if (current.type === "CatchClause") bindPattern(node(current.param), scope);
		if (current.type.startsWith("Import") && current.local) {
			let imported = node(current.imported);
			let specifier = node(parents.get(current)?.source);
			let value = imported && specifier
				&& staticImport?.(String(specifier.value), String(imported.name));
			bindPattern(
				node(current.local),
				scope,
				value
					? {
						type: "ObjectExpression",
						properties: Object.entries(value).map(([key, value]) => ({
							type: "ObjectProperty",
							foundation: true,
							key: { type: "StringLiteral", value: key },
							value: { type: "StringLiteral", value },
						})),
					}
					: undefined,
			);
		}
		for (let child of children(current)) {
			parents.set(child, current);
			collect(child, scope);
		}
	};
	collect(tree, { bindings: new Map() });
	let bindingScope = (current: Ast): Scope | undefined => {
		let scope = scopes.get(current);
		while (scope && !scope.bindings.has(String(current.name))) scope = scope.parent;
		return scope;
	};
	// Reassigned bindings cannot be proved static without control-flow analysis.
	for (let current of all) {
		if (current.type !== "AssignmentExpression" && current.type !== "UpdateExpression") continue;
		let target = node(current.left ?? current.argument);
		if (target?.type === "Identifier") {
			bindingScope(target)?.bindings.set(String(target.name), undefined);
		}
	}
	let resolve = (current: Ast | undefined, seen = new Set<Ast>()): Ast | undefined => {
		if (!current || seen.has(current)) return undefined;
		seen.add(current);
		if (
			[
				"TSAsExpression",
				"TSSatisfiesExpression",
				"TSNonNullExpression",
				"ParenthesizedExpression",
			].includes(current.type)
		) {
			return resolve(node(current.expression), seen);
		}
		if (current.type === "Identifier") {
			let value = bindingScope(current)?.bindings.get(String(current.name));
			return value ? resolve(value, seen) : current;
		}
		if (current.type === "ConditionalExpression") {
			let test = resolve(node(current.test), new Set(seen));
			if (test?.type === "BooleanLiteral") {
				return resolve(node(test.value ? current.consequent : current.alternate), seen);
			}
		}
		if (
			current.type === "CallExpression"
			&& node(current.callee)?.type === "MemberExpression"
			&& node(node(current.callee)?.object)?.name === "Object"
			&& node(node(current.callee)?.property)?.name === "freeze"
			&& !bindingScope(node(node(current.callee)?.object)!)
		) return resolve(node((current.arguments as unknown[])[0]), seen);
		if (["MemberExpression", "OptionalMemberExpression"].includes(current.type)) {
			let object = resolve(node(current.object), seen);
			if (object?.type === "ObjectExpression" && !mutated.has(object)) {
				let name = key(current);
				for (let entry of (object.properties as unknown[]).toReversed()) {
					let property = node(entry)!;
					if (property.type === "SpreadElement") break;
					if (name !== undefined && key(property) === name) {
						return resolve(node(property.value), seen);
					}
				}
			}
		}
		return current;
	};
	let text = (current: Ast | undefined, seen = new Set<Ast>()): string | undefined => {
		current = resolve(current);
		if (!current || seen.has(current)) return undefined;
		seen.add(current);
		if (["StringLiteral", "NumericLiteral"].includes(current.type)) return String(current.value);
		if (current.type === "UnaryExpression" && ["+", "-"].includes(String(current.operator))) {
			let value = text(node(current.argument), seen);
			return value === undefined ? undefined : `${current.operator}${value}`;
		}
		if (current.type === "TemplateLiteral") {
			let expressions = (current.expressions as unknown[]).map(expression =>
				text(node(expression), new Set(seen))
			);
			if (expressions.some(value => value === undefined)) return undefined;
			return (current.quasis as { value: { cooked: string } }[])
				.map((quasi, index) => quasi.value.cooked + (expressions[index] ?? "")).join("");
		}
		if (current.type === "BinaryExpression" && current.operator === "+") {
			let left = text(node(current.left), new Set(seen));
			let right = text(node(current.right), new Set(seen));
			return left === undefined || right === undefined ? undefined : left + right;
		}
		return undefined;
	};
	let key = (current: Ast): string | undefined => {
		let name = node(current.property ?? current.key);
		return !current.computed && name?.type === "Identifier" ? String(name.name) : text(name);
	};
	let line = (current: Ast) =>
		baseLine + ((current.loc as { start: { line: number } } | undefined)?.start.line ?? 1) - 1;
	let sourceOf = (current: Ast | undefined) =>
		current ? source.slice(Number(current.start), Number(current.end)) : "<unknown>";
	let contextOf = (current: Ast): string => {
		let path: string[] = [];
		let ancestor: Ast | undefined = current;
		while (ancestor) {
			if (ancestor.type === "JSXOpeningElement") {
				path.unshift(`<${sourceOf(node(ancestor.name))}>`);
			}
			if (ancestor.type === "VariableDeclarator") path.unshift(sourceOf(node(ancestor.id)));
			if (/Function/.test(ancestor.type) && ancestor.id) {
				path.unshift(sourceOf(node(ancestor.id)));
			}
			ancestor = parents.get(ancestor);
		}
		return path.join(" > ");
	};
	let add = (
		property: string,
		value: Ast | undefined,
		origin: Ast,
		context: string,
		seen = new Set<Ast>(),
	) => {
		let resolved = resolve(value);
		if (absent(resolved)) return;
		if (resolved && !seen.has(resolved) && resolved.type === "ConditionalExpression") {
			seen.add(resolved);
			add(property, node(resolved.consequent), origin, context, new Set(seen));
			add(property, node(resolved.alternate), origin, context, new Set(seen));
			return;
		}
		if (resolved && !seen.has(resolved) && resolved.type === "LogicalExpression") {
			seen.add(resolved);
			if (resolved.operator !== "&&") {
				add(property, node(resolved.left), origin, context, new Set(seen));
			}
			add(property, node(resolved.right), origin, context, new Set(seen));
			return;
		}
		let literal = text(value);
		result.declarations.push({
			property: propertyName(property),
			value: literal ?? sourceOf(value),
			line: line(origin),
			context: [context, contextOf(origin)].filter(Boolean).join(" > "),
			...(property === "*" || literal === undefined ? { dynamic: true } : {}),
			...(origin.foundation ? { foundation: true } : {}),
		});
	};
	let mutated = new Set<Ast>();
	for (let current of all) {
		if (current.type === "CallExpression" && sourceOf(node(current.callee)) === "Object.assign") {
			let argument = node((current.arguments as unknown[])[0]);
			let object = resolve(argument);
			if (object?.type === "ObjectExpression") mutated.add(object);
		}
		if (!["AssignmentExpression", "UpdateExpression", "UnaryExpression"].includes(current.type)) {
			continue;
		}
		if (current.type === "UnaryExpression" && current.operator !== "delete") continue;
		let target = node(current.left ?? current.argument);
		let object = target && resolve(node(target.object));
		if (object?.type === "ObjectExpression") mutated.add(object);
	}
	let style = (value: Ast | undefined, origin: Ast, seen = new Set<Ast>()) => {
		let current = resolve(value);
		if (absent(current)) return;
		if (!current || seen.has(current)) {
			add("*", value, origin, "unresolved style");
			return;
		}
		seen.add(current);
		if (current.type === "ObjectExpression") {
			if (mutated.has(current)) add("*", value, origin, "mutated style object");
			for (let entry of current.properties as unknown[]) {
				let property = node(entry)!;
				if (property.type === "SpreadElement") {
					style(node(property.argument), property, new Set(seen));
				} else add(key(property) ?? "*", node(property.value), property, "style object");
			}
		} else if (current.type === "ConditionalExpression") {
			style(node(current.consequent), origin, new Set(seen));
			style(node(current.alternate), origin, new Set(seen));
		} else if (current.type === "LogicalExpression") {
			if (current.operator !== "&&") style(node(current.left), origin, new Set(seen));
			style(node(current.right), origin, new Set(seen));
		} else if (current.type === "CallExpression") {
			let producer = resolve(node(current.callee));
			let body = producer && node(producer.body);
			let statements = body?.type === "BlockStatement"
				? (body.body as unknown[]).map(node)
				: undefined;
			let returned = statements?.at(-1);
			let containsObject = (argument: Ast | undefined, visited = new Set<Ast>()): boolean => {
				let value = resolve(argument);
				if (!value || visited.has(value)) return false;
				visited.add(value);
				if (value?.type === "ObjectExpression") return true;
				return value?.type === "ConditionalExpression"
					&& (containsObject(node(value.consequent), new Set(visited))
						|| containsObject(node(value.alternate), new Set(visited)));
			};
			let passesObjectToCall = (statement: Ast): boolean => {
				if (
					statement.type === "CallExpression"
					&& (statement.arguments as unknown[]).some(argument => containsObject(node(argument)))
				) return true;
				return children(statement).some(passesObjectToCall);
			};
			if (
				producer && ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]
					.includes(producer.type)
				&& statements?.slice(0, -1).every(statement => statement?.type === "VariableDeclaration")
				&& returned?.type === "ReturnStatement"
				&& !statements.some(statement => statement && passesObjectToCall(statement))
			) {
				style(node(returned.argument), origin, new Set(seen));
			} else add("*", value, origin, "unresolved style");
		} else {
			add("*", value, origin, "unresolved style");
		}
	};
	let classes = (value: Ast | undefined, origin: Ast, seen = new Set<Ast>()) => {
		let context = ["class", contextOf(origin)].filter(Boolean).join(" > ");
		let current = resolve(value);
		if (absent(current)) return;
		let literal = text(current);
		if (literal !== undefined) {
			result.classes.push({ value: literal, line: line(origin), context });
			return;
		}
		if (!current || seen.has(current)) {
			result.classes.push({ value: sourceOf(value), line: line(origin), context, dynamic: true });
			return;
		}
		seen.add(current);
		let visit = (child: unknown) => classes(node(child), origin, new Set(seen));
		if (
			["MemberExpression", "OptionalMemberExpression"].includes(current.type)
			&& current.computed && text(node(current.property)) === undefined
		) {
			let object = resolve(node(current.object));
			if (object?.type === "ObjectExpression" && !mutated.has(object)) {
				let properties = (object.properties as unknown[]).map(node);
				if (properties.every(property => property?.type === "ObjectProperty")) {
					for (let property of properties) visit(property!.value);
					return;
				}
			}
		}
		if (current.type === "ConditionalExpression") {
			visit(current.consequent);
			visit(current.alternate);
		} else if (current.type === "LogicalExpression") {
			if (current.operator !== "&&") visit(current.left);
			visit(current.right);
		} else if (current.type === "TemplateLiteral") {
			for (let quasi of current.quasis as { value: { cooked: string } }[]) {
				result.classes.push({ value: quasi.value.cooked, line: line(origin), context });
			}
			for (let expression of current.expressions as unknown[]) visit(expression);
		} else if (current.type === "ArrayExpression") {
			for (let element of current.elements as unknown[]) visit(element);
		} else if (current.type === "ObjectExpression") {
			if (mutated.has(current)) {
				result.classes.push({
					value: sourceOf(value),
					line: line(origin),
					context: ["mutated class object", contextOf(origin)].filter(Boolean).join(" > "),
					dynamic: true,
				});
			}
			for (let entry of current.properties as unknown[]) {
				let property = node(entry)!;
				if (property.type === "SpreadElement") visit(property.argument);
				else {result.classes.push({
						value: key(property) ?? sourceOf(property),
						line: line(origin),
						context,
						...(key(property) === undefined ? { dynamic: true } : {}),
					});}
			}
		} else if (
			current.type === "CallExpression"
			&& /^(?:cn|clsx|classNames|classnames)$/.test(sourceOf(node(current.callee)))
		) {
			for (let argument of current.arguments as unknown[]) visit(argument);
		} else if (
			current.type === "CallExpression"
			&& ["join", "trim"].includes(key(node(current.callee)!) ?? "")
		) {
			visit(node(current.callee)?.object);
		} else {result.classes.push({
				value: sourceOf(value),
				line: line(origin),
				context,
				dynamic: true,
			});}
	};
	let isStyle = (value: Ast | undefined) => {
		let current = resolve(value);
		return current && ["MemberExpression", "OptionalMemberExpression"].includes(current.type)
			&& key(current) === "style";
	};
	let cssValue = (value: Ast | undefined, origin: Ast) => {
		let literal = text(value);
		if (literal === undefined) add("*", value, origin, "dynamic CSS text");
		else {
			let target = node(origin.left ?? origin.callee ?? origin.id);
			let context = ["embedded CSS", target && sourceOf(target), contextOf(origin)].filter(Boolean)
				.join(" > ");
			addCss(literal, line(origin), context);
		}
	};
	let props = (value: Ast | undefined, origin: Ast, seen = new Set<Ast>()) => {
		let current = resolve(value);
		if (absent(current)) return;
		if (current && !seen.has(current) && current.type === "ConditionalExpression") {
			seen.add(current);
			props(node(current.consequent), origin, new Set(seen));
			props(node(current.alternate), origin, new Set(seen));
			return;
		}
		if (current && !seen.has(current) && current.type === "LogicalExpression") {
			seen.add(current);
			if (current.operator !== "&&") props(node(current.left), origin, new Set(seen));
			props(node(current.right), origin, new Set(seen));
			return;
		}
		if (!current || seen.has(current) || current.type !== "ObjectExpression") {
			add("*", value, origin, "unresolved JSX props");
			return;
		}
		seen.add(current);
		if (mutated.has(current)) add("*", value, origin, "mutated JSX props");
		for (let entry of current.properties as unknown[]) {
			let property = node(entry)!;
			let name = key(property);
			if (property.type === "SpreadElement") {
				props(node(property.argument), property, new Set(seen));
			} else if (name === "style") style(node(property.value), property);
			else if (name === "className" || name === "class") classes(node(property.value), property);
			else if (name && presentation.has(propertyName(name))) {
				add(name, node(property.value), property, "presentation attribute");
			} else if (name === undefined) {
				add("*", node(property.value), property, "computed JSX prop");
			}
		}
	};
	let constantClasses = (value: Ast | undefined, seen = new Set<Ast>()) => {
		let current = resolve(value);
		if (!current || seen.has(current)) return;
		seen.add(current);
		if (current?.type === "ObjectExpression") {
			for (let property of current.properties as unknown[]) {
				constantClasses(node(node(property)?.value), new Set(seen));
			}
		} else if (current.type === "ArrayExpression") {
			for (let element of current.elements as unknown[]) {
				constantClasses(node(element), new Set(seen));
			}
		} else {
			let literal = text(current);
			// Whole class-shaped strings avoid scanning sentences, Markdown, or HTML as utilities.
			if (literal && /^[\w\s!@:[\]/.%#()=+-]+$/.test(literal)) classes(current, current);
		}
	};
	let exported = new Set<string>();
	for (let current of all) {
		if (current.type !== "ExportSpecifier") continue;
		let local = node(current.local);
		if (local?.type === "Identifier") exported.add(String(local.name));
	}
	for (let current of all) {
		if (current.type === "JSXSpreadAttribute") props(node(current.argument), current);
		if (current.type === "JSXAttribute") {
			let name = String(node(current.name)?.name);
			let value = node(current.value);
			if (value?.type === "JSXExpressionContainer") value = node(value.expression);
			if (name === "style") style(value, current);
			else if (["class", "className"].includes(name)) classes(value, current);
			else if (presentation.has(propertyName(name))) {
				add(name, value, current, "presentation attribute");
			}
		}
		if (current.type === "AssignmentExpression") {
			let target = node(current.left);
			if (!target || !["MemberExpression", "OptionalMemberExpression"].includes(target.type)) {
				continue;
			}
			if (isStyle(node(target.object))) {
				if (key(target) === "cssText") cssValue(node(current.right), current);
				else {add(
						key(target) ?? "*",
						node(current.right),
						current,
						`DOM style assignment > ${sourceOf(target)}`,
					);}
			} else if (key(target) === "className") classes(node(current.right), current);
			else if (isStyle(target)) cssValue(node(current.right), current);
		}
		if (current.type === "CallExpression") {
			let callee = resolve(node(current.callee));
			if (!callee) continue;
			let args = (current.arguments as unknown[]).map(node);
			let method = key(callee);
			if (method === "createElement" || sourceOf(callee) === "createElement") {
				props(args[1], current);
			}
			if (method === "setProperty" && isStyle(node(callee.object))) {
				add(text(args[0]) ?? "*", args[1], current, `DOM setProperty > ${sourceOf(callee)}`);
			}
			if (method === "assign" && sourceOf(node(callee.object)) === "Object" && isStyle(args[0])) {
				for (let argument of args.slice(1)) style(argument, current);
			}
			if (method === "setAttribute") {
				let attribute = text(args[0]);
				if (attribute === undefined) {
					add(
						"*",
						args[1],
						current,
						`DOM dynamic attribute > ${sourceOf(callee)}(${sourceOf(args[0])})`,
					);
				} else if (attribute === "style") cssValue(args[1], current);
				else if (attribute === "class") classes(args[1], current);
				else if (attribute && presentation.has(attribute)) {
					add(attribute, args[1], current, "DOM presentation attribute");
				}
			}
			if (
				["add", "remove", "toggle", "replace"].includes(method ?? "")
				&& key(node(callee.object) ?? callee) === "classList"
			) {
				for (let argument of method === "toggle" ? args.slice(0, 1) : args) {
					classes(argument, current);
				}
			}
			if (["insertRule", "replaceSync"].includes(method ?? "")) cssValue(args[0], current);
		}
		if (
			current.type === "TaggedTemplateExpression"
			&& /^(?:css|styled(?:\.[\w]+)?)$/.test(sourceOf(node(current.tag)))
		) cssValue(node(current.quasi), current);
		if (
			current.type === "VariableDeclarator"
			&& /^(?:css|stylesheet)$/i.test(String(node(current.id)?.name))
		) {
			let value = resolve(node(current.init));
			if (value && ["StringLiteral", "TemplateLiteral"].includes(value.type)) {
				cssValue(value, value);
			}
		}
		if (
			current.type === "VariableDeclarator"
			&& String(node(current.id)?.name).endsWith("_LEXICAL_THEME")
		) constantClasses(node(current.init));
		else if (current.type === "VariableDeclarator") {
			let name = String(node(current.id)?.name);
			let isExport = parents.get(parents.get(current)!)?.type === "ExportNamedDeclaration"
				|| exported.has(name);
			if (isExport && (/^[A-Z][A-Z_\d]*$/.test(name) || /class/i.test(name))) {
				constantClasses(node(current.init));
			}
		}
	}
}
