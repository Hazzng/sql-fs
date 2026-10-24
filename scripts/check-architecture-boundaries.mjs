import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as ts from "typescript/unstable/sync";
import * as ast from "typescript/unstable/ast";

const { API, SignatureKind, SymbolFlags, TypeFlags } = ts;
const { SyntaxKind } = ast;

const workerImportAllowlist = new Map([
	[
		"src/api/session-manager.ts",
		new Map([
			["src/api/worker-owner/filesystem.ts", new Set(["WorkerFileSystem", "WorkerScriptScope"])],
			["src/api/worker-owner/message-budget.ts", new Set(["assertWorkerMessageBudget"])],
			["src/api/worker-owner/pool.ts", new Set(["WorkerOwnerPool", "WorkerPoolOptions", "loadWorkerPoolOptions"])],
			["src/api/worker-owner/protocol.ts", new Set(["ShellExecutionLimits", "OutcomeUnknownError"])],
		]),
	],
	[
		"src/api/ingress-admission.ts",
		new Map([
			["src/api/worker-owner/admission.ts", new Set(["FairAdmission"])],
			["src/api/worker-owner/protocol.ts", new Set(["WorkerBusyError"])],
		]),
	],
	["src/api/server.ts", new Map([["src/api/worker-owner/metrics.ts", new Set(["renderWorkerMetrics"])]])],
]);

for (const importer of [
	"src/api/mcp/request-context.ts",
	"src/api/mcp/tools.ts",
	"src/api/routes/exec.ts",
	"src/api/routes/files.ts",
	"src/api/routes/ingest.ts",
	"src/api/routes/sandboxes.ts",
]) {
	workerImportAllowlist.set(
		importer,
		new Map([["src/api/worker-owner/request-context.ts", new Set(["workerRequestContext"])]]),
	);
}

const scopeOperations = new Set(["beginScope", "endScope", "abortScope"]);

const fencePolicyConsumers = new Set([
	"src/sql-fs/dialects/postgres/namespace.ts",
	"src/sql-fs/dialects/postgres/ingest.ts",
]);
const fencePolicyStatements = [/\bapp\.sandbox_epoch\b/i, /\bversion\s*=\s*(?:\w+\.)?version\s*\+/i];

function forbiddenSqlApiAccess(node, checker) {
	let receiver;
	let name;
	if (ast.isPropertyAccessExpression(node)) {
		receiver = node.expression;
		name = node.name.text;
	} else if (ast.isElementAccessExpression(node) && ast.isStringLiteral(node.argumentExpression)) {
		receiver = node.expression;
		name = node.argumentExpression.text;
	} else if (ast.isBindingElement(node) && ast.isObjectBindingPattern(node.parent)) {
		receiver = node.parent;
		const property = node.propertyName ?? node.name;
		if (ast.isIdentifier(property) || ast.isStringLiteral(property)) name = property.text;
	}
	if (name !== "unsafe" && name !== "file") return false;
	const type = checker.getTypeAtLocation(receiver);
	return (
		type === undefined ||
		(type.flags & (TypeFlags.Any | TypeFlags.Unknown)) !== 0 ||
		checker.getSignaturesOfType(type, SignatureKind.Call).length > 0
	);
}

function templateLiteralText(template) {
	if (ast.isNoSubstitutionTemplateLiteral(template)) return template.text;
	return [template.head.text, ...template.templateSpans.map((span) => span.literal.text)].join(" ${} ");
}

function relative(root, filename) {
	return path.relative(root, filename).split(path.sep).join("/");
}

function listTypeScriptFiles(directory) {
	const entries = readdirSync(directory, { withFileTypes: true });
	return entries.flatMap((entry) => {
		const filename = path.join(directory, entry.name);
		if (entry.isDirectory()) return listTypeScriptFiles(filename);
		return entry.isFile() && filename.endsWith(".ts") && !filename.endsWith(".d.ts") ? [filename] : [];
	});
}

function resolveModule(root, node, checker, project) {
	const moduleSymbol = checker.getSymbolAtLocation(node);
	if (moduleSymbol === undefined || (moduleSymbol.flags & SymbolFlags.Module) === 0) return undefined;
	for (const declaration of moduleSymbol.declarations) {
		const filename = declarationFile(declaration, project);
		if (filename !== undefined) return relative(root, path.resolve(filename));
	}
	return undefined;
}

function diagnostic(root, sourceFile, node, code, message) {
	const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
	return {
		file: relative(root, sourceFile.fileName),
		line: line + 1,
		column: character + 1,
		code,
		message,
	};
}

function workerModule(file) {
	return file?.startsWith("src/api/worker-owner/") === true;
}

function declarationFile(declaration, project) {
	return declaration.resolve(project)?.getSourceFile().fileName;
}

function symbolOriginatesInWorker(symbol, root, checker, project, seen = new Set()) {
	if (symbol === undefined || seen.has(symbol)) return false;
	seen.add(symbol);
	if ((symbol.flags & SymbolFlags.Alias) !== 0) {
		return symbolOriginatesInWorker(checker.getAliasedSymbol(symbol), root, checker, project, seen);
	}
	return symbol.declarations.some((declaration) => {
		const filename = declarationFile(declaration, project);
		return filename !== undefined && workerModule(relative(root, path.resolve(filename)));
	});
}

function moduleExports(node, checker) {
	const moduleSymbol = checker.getSymbolAtLocation(node.moduleSpecifier);
	if (moduleSymbol === undefined || (moduleSymbol.flags & SymbolFlags.Module) === 0) return [];
	return checker.getExportsOfModule(moduleSymbol);
}

function importedSymbols(node, checker) {
	if (ast.isImportDeclaration(node)) {
		const clause = node.importClause;
		if (clause === undefined) return [];
		const symbols = [];
		if (clause.name !== undefined) symbols.push({ name: "default", symbol: checker.getSymbolAtLocation(clause.name) });
		if (clause.namedBindings === undefined) return symbols;
		if (ast.isNamespaceImport(clause.namedBindings)) {
			return moduleExports(node, checker).map((symbol) => ({ name: symbol.name, symbol }));
		}
		for (const item of clause.namedBindings.elements) {
			symbols.push({
				name: (item.propertyName ?? item.name).text,
				symbol: checker.getSymbolAtLocation(item.name),
			});
		}
		return symbols;
	}
	if (ast.isExportDeclaration(node)) {
		if (node.exportClause === undefined || ast.isNamespaceExport(node.exportClause)) {
			return moduleExports(node, checker).map((symbol) => ({ name: symbol.name, symbol }));
		}
		return node.exportClause.elements.map((item) => ({
			name: (item.propertyName ?? item.name).text,
			symbol: checker.getSymbolAtLocation(item.name),
		}));
	}
	return [];
}

function allowedImport(importer, target, symbol) {
	return workerImportAllowlist.get(importer)?.get(target)?.has(symbol) === true;
}

function importedNames(node) {
	if (ast.isImportDeclaration(node)) {
		const clause = node.importClause;
		if (clause === undefined) return ["<side-effect>"];
		const names = [];
		if (clause.name !== undefined) names.push("default");
		if (clause.namedBindings === undefined) return names;
		if (ast.isNamespaceImport(clause.namedBindings)) return ["*"];
		for (const item of clause.namedBindings.elements) names.push((item.propertyName ?? item.name).text);
		return names;
	}
	if (ast.isExportDeclaration(node)) {
		if (node.exportClause === undefined) return ["*"];
		if (ast.isNamespaceExport(node.exportClause)) return ["*"];
		return node.exportClause.elements.map((item) => (item.propertyName ?? item.name).text);
	}
	return [];
}

function unwrapParentheses(node) {
	let expression = node;
	while (ast.isParenthesizedExpression(expression)) expression = expression.expression;
	return expression;
}

function scopeOperationOf(expression, checker, scopeMethodAliases) {
	const target = unwrapParentheses(expression);
	if (ast.isPropertyAccessExpression(target) && scopeOperations.has(target.name.text)) return target.name.text;
	if (
		ast.isElementAccessExpression(target) &&
		target.argumentExpression !== undefined &&
		ast.isStringLiteral(target.argumentExpression) &&
		scopeOperations.has(target.argumentExpression.text)
	) {
		return target.argumentExpression.text;
	}
	if (ast.isIdentifier(target)) {
		const symbol = checker.getSymbolAtLocation(target);
		if (symbol !== undefined) return scopeMethodAliases.get(symbol);
	}
	return undefined;
}

function enclosingFunctionName(node) {
	for (let current = node.parent; current !== undefined; current = current.parent) {
		if (ast.isFunctionDeclaration(current) || ast.isMethodDeclaration(current)) return current.name?.getText();
		if (
			ast.isVariableDeclaration(current) &&
			current.initializer !== undefined &&
			ast.isArrowFunction(current.initializer)
		)
			return current.name.getText();
	}
	return undefined;
}

function scopeCallAllowed(sourcePath, operation, call) {
	if (sourcePath === "src/api/worker-owner/filesystem.ts") return true;
	if (sourcePath === "src/api/worker-owner/runtime.ts") return true;
	if (sourcePath === "src/sql-fs/script-scope.ts") return true;
	return (
		sourcePath === "src/api/session-runtime/engine.ts" &&
		operation === "abortScope" &&
		enclosingFunctionName(call) === "closeSessionRuntime"
	);
}

export function checkArchitectureBoundaries(root) {
	const absoluteRoot = path.resolve(root);
	const sourceRoot = path.join(absoluteRoot, "src");
	const files = listTypeScriptFiles(sourceRoot).filter((filename) => !filename.includes(`${path.sep}tests${path.sep}`));
	const api = new API({ cwd: absoluteRoot });
	let snapshot;
	try {
		snapshot = api.updateSnapshot({
			openProjects: [path.join(absoluteRoot, "tsconfig.json")],
			openFiles: files,
		});
		const diagnostics = [];

		for (const filename of files) {
			const project = snapshot.getDefaultProjectForFile(filename);
			if (project === undefined) throw new Error(`TypeScript 7 did not load ${filename}`);
			const sourceFile = project.program.getSourceFile(filename);
			if (sourceFile === undefined) throw new Error(`TypeScript 7 did not parse ${filename}`);
			const checker = project.checker;
			if (!path.resolve(sourceFile.fileName).startsWith(`${absoluteRoot}${path.sep}src${path.sep}`)) continue;
			const sourcePath = relative(absoluteRoot, sourceFile.fileName);
			if (sourcePath.includes("/tests/")) continue;

			const scopeMethodAliases = new Map();
			const requireAliases = new Set();
			const visit = (node) => {
				if (
					(ast.isImportDeclaration(node) || ast.isExportDeclaration(node)) &&
					node.moduleSpecifier !== undefined &&
					ast.isStringLiteral(node.moduleSpecifier) &&
					["node:module", "module"].includes(node.moduleSpecifier.text) &&
					!sourcePath.startsWith("src/api/worker-owner/") &&
					importedNames(node).some((name) => ["createRequire", "*", "default"].includes(name))
				) {
					diagnostics.push(
						diagnostic(
							absoluteRoot,
							sourceFile,
							node,
							"WORKER_INTERNAL_DYNAMIC_IMPORT",
							"import explicit ES modules instead of exposing createRequire outside worker-owner",
						),
					);
				}

				if (
					(ast.isImportDeclaration(node) || ast.isExportDeclaration(node)) &&
					(node.moduleSpecifier === undefined || ast.isStringLiteral(node.moduleSpecifier))
				) {
					const target =
						node.moduleSpecifier === undefined
							? undefined
							: resolveModule(absoluteRoot, node.moduleSpecifier, checker, project);
					const symbols = importedSymbols(node, checker);
					const hasWorkerOrigin =
						workerModule(target) || symbols.some(({ symbol }) => symbolOriginatesInWorker(symbol, absoluteRoot, checker, project));
					if (hasWorkerOrigin && !sourcePath.startsWith("src/api/worker-owner/")) {
						const entries = symbols.length > 0 ? symbols : importedNames(node).map((name) => ({ name }));
						for (const { name, symbol } of entries) {
							const resolvedSymbol =
								symbol !== undefined && (symbol.flags & SymbolFlags.Alias) !== 0
									? checker.getAliasedSymbol(symbol)
									: symbol;
							if (
								name === "workerReservation" ||
								resolvedSymbol?.name === "workerReservation" ||
								resolvedSymbol?.declarations.some((declaration) => {
										const filename = declarationFile(declaration, project);
										return filename !== undefined &&
											workerModule(relative(absoluteRoot, path.resolve(filename))) &&
											declaration.resolve(project)?.name?.getText() === "workerReservation";
									})
							) {
								diagnostics.push(
									diagnostic(
										absoluteRoot,
										sourceFile,
										node,
										"WORKER_RESERVATION_LEAK",
										"workerReservation is mutable worker-owned state and cannot be imported outside worker-owner",
									),
								);
								continue;
							}
							if (target === undefined || !allowedImport(sourcePath, target, name)) {
								diagnostics.push(
									diagnostic(
										absoluteRoot,
										sourceFile,
										node,
										"WORKER_INTERNAL_IMPORT",
										`import of ${name} from ${target} is outside the worker adapter allowlist`,
									),
								);
							}
						}
					}
				}

				if (
					ast.isCallExpression(node) &&
					node.expression.kind === SyntaxKind.ImportKeyword &&
					!sourcePath.startsWith("src/api/worker-owner/") &&
					(node.arguments.length !== 1 || !ast.isStringLiteral(node.arguments[0]))
				) {
					diagnostics.push(
						diagnostic(
							absoluteRoot,
							sourceFile,
							node,
							"WORKER_INTERNAL_DYNAMIC_IMPORT",
							"nonliteral dynamic import is outside worker-owner",
						),
					);
				}

				if (
					ast.isCallExpression(node) &&
					node.expression.kind === SyntaxKind.ImportKeyword &&
					node.arguments.length === 1 &&
					ast.isStringLiteral(node.arguments[0])
				) {
					const target = resolveModule(absoluteRoot, node.arguments[0], checker, project);
					if (["node:module", "module"].includes(node.arguments[0].text) && !sourcePath.startsWith("src/api/worker-owner/")) {
						diagnostics.push(
							diagnostic(
								absoluteRoot,
								sourceFile,
								node,
								"WORKER_INTERNAL_DYNAMIC_IMPORT",
								"import explicit ES modules instead of exposing createRequire outside worker-owner",
							),
						);
					}
					const moduleSymbol = checker.getSymbolAtLocation(node.arguments[0]);
					const dynamicExports =
						moduleSymbol === undefined || (moduleSymbol.flags & SymbolFlags.Module) === 0
							? []
							: checker.getExportsOfModule(moduleSymbol);
					if (
						(workerModule(target) ||
							dynamicExports.some((symbol) => symbolOriginatesInWorker(symbol, absoluteRoot, checker, project))) &&
						!sourcePath.startsWith("src/api/worker-owner/")
					) {
						diagnostics.push(
							diagnostic(
								absoluteRoot,
								sourceFile,
								node,
								"WORKER_INTERNAL_DYNAMIC_IMPORT",
								`dynamic import of ${target} is outside worker-owner`,
							),
						);
					}
				}

				if (
					ast.isImportEqualsDeclaration(node) &&
					ast.isExternalModuleReference(node.moduleReference) &&
					ast.isStringLiteral(node.moduleReference.expression)
				) {
					if (!sourcePath.startsWith("src/api/worker-owner/")) {
						diagnostics.push(
							diagnostic(
								absoluteRoot,
								sourceFile,
								node,
								"WORKER_INTERNAL_DYNAMIC_IMPORT",
								"import explicit ES modules instead of import-equals outside worker-owner",
							),
						);
					}
				}

				if (ast.isVariableDeclaration(node) && ast.isObjectBindingPattern(node.name)) {
					for (const element of node.name.elements) {
						const operation = (element.propertyName ?? element.name).getText(sourceFile);
						if (scopeOperations.has(operation) && ast.isIdentifier(element.name)) {
							const symbol = checker.getSymbolAtLocation(element.name);
							if (symbol !== undefined) scopeMethodAliases.set(symbol, operation);
						}
					}
				}
				if (ast.isVariableDeclaration(node) && ast.isIdentifier(node.name) && node.initializer !== undefined) {
					const initializer = unwrapParentheses(node.initializer);
					const operation = ast.isPropertyAccessExpression(initializer)
						? initializer.name.text
						: ast.isElementAccessExpression(initializer) && ast.isStringLiteral(initializer.argumentExpression)
							? initializer.argumentExpression.text
							: undefined;
					if (operation !== undefined && scopeOperations.has(operation)) {
						const symbol = checker.getSymbolAtLocation(node.name);
						if (symbol !== undefined) scopeMethodAliases.set(symbol, operation);
					}
				}
				if (ast.isVariableDeclaration(node) && ast.isIdentifier(node.name) && node.initializer !== undefined) {
					const initializer = unwrapParentheses(node.initializer);
					if (ast.isIdentifier(initializer) && initializer.text === "require") {
						const symbol = checker.getSymbolAtLocation(node.name);
						if (symbol !== undefined) requireAliases.add(symbol);
					} else if (ast.isIdentifier(initializer)) {
						const initializerSymbol = checker.getSymbolAtLocation(initializer);
						const symbol = checker.getSymbolAtLocation(node.name);
						if (symbol !== undefined && initializerSymbol !== undefined && requireAliases.has(initializerSymbol)) {
							requireAliases.add(symbol);
						}
					}
				}

				if (fencePolicyConsumers.has(sourcePath)) {
					if (forbiddenSqlApiAccess(node, checker)) {
						diagnostics.push(
							diagnostic(
								absoluteRoot,
								sourceFile,
								node,
								"FENCE_POLICY_RAW_SQL",
								"tx.unsafe and tx.file bypass fence-policy inspection; use tagged SQL and safe value builders",
							),
						);
					}
					if (
						ast.isTaggedTemplateExpression(node) &&
						fencePolicyStatements.some((pattern) => pattern.test(templateLiteralText(node.template)))
					) {
						diagnostics.push(
							diagnostic(
								absoluteRoot,
								sourceFile,
								node,
								"FENCE_POLICY_OWNER",
								"epoch acceptance, epoch publication, and sandboxes.version advancement belong to the fence policy in sandbox.ts; use fenceAndAdvance or compositeFenceAndAdvance",
							),
						);
					}
				}

				if (ast.isCallExpression(node)) {
					const expression = unwrapParentheses(node.expression);
					if (
						!sourcePath.startsWith("src/api/worker-owner/") &&
						(ast.isIdentifier(expression) && expression.text === "require" ||
							ast.isIdentifier(expression) && requireAliases.has(checker.getSymbolAtLocation(expression)))
					) {
						diagnostics.push(
							diagnostic(
								absoluteRoot,
								sourceFile,
								node,
								"WORKER_INTERNAL_DYNAMIC_IMPORT",
								"import explicit ES modules instead of require outside worker-owner",
							),
						);
					}

					let operation;
					const callTarget =
						ast.isPropertyAccessExpression(expression) && ["call", "apply", "bind"].includes(expression.name.text)
							? expression.expression
							: expression;
					operation = scopeOperationOf(callTarget, checker, scopeMethodAliases);
					if (
						operation === undefined &&
						ast.isPropertyAccessExpression(expression) &&
						expression.expression.getText(sourceFile) === "Reflect" &&
						expression.name.text === "apply" &&
						node.arguments.length >= 1
					) {
						operation = scopeOperationOf(node.arguments[0], checker, scopeMethodAliases);
					}
					if (operation !== undefined && !scopeCallAllowed(sourcePath, operation, node)) {
						diagnostics.push(
							diagnostic(
								absoluteRoot,
								sourceFile,
								node,
								"SCRIPT_SCOPE_COMPLETION_OWNER",
								`direct ${operation} call must stay in a scope adapter, worker handler, or runtime shutdown cleanup`,
							),
						);
					}
				}
				node.forEachChild(visit);
			};
			sourceFile.forEachChild(visit);
		}

		return diagnostics;
	} finally {
		snapshot?.dispose();
		api.close();
	}
}

function main() {
	const rootFlag = process.argv.indexOf("--root");
	const root = rootFlag >= 0 ? process.argv[rootFlag + 1] : process.cwd();
	if (root === undefined || root.startsWith("--"))
		throw new Error("usage: node scripts/check-architecture-boundaries.mjs [--root project-root]");
	const diagnostics = checkArchitectureBoundaries(root);
	for (const item of diagnostics) {
		console.error(`${item.file}:${item.line}:${item.column} ${item.code} ${item.message}`);
	}
	if (diagnostics.length > 0) {
		console.error(`architecture boundary check found ${diagnostics.length} violation(s)`);
		process.exitCode = 1;
	} else {
		console.log("architecture boundary check passed");
	}
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
