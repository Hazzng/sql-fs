import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");

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

function listTypeScriptFiles(directory) {
	const entries = readdirSync(directory, { withFileTypes: true });
	return entries.flatMap((entry) => {
		const filename = path.join(directory, entry.name);
		if (entry.isDirectory()) return listTypeScriptFiles(filename);
		return entry.isFile() && filename.endsWith(".ts") && !filename.endsWith(".d.ts") ? [filename] : [];
	});
}

function relative(root, filename) {
	return path.relative(root, filename).split(path.sep).join("/");
}

function resolveModule(root, sourceFile, specifier) {
	const result = ts.resolveModuleName(
		specifier,
		sourceFile.fileName,
		{
			module: ts.ModuleKind.NodeNext,
			moduleResolution: ts.ModuleResolutionKind.NodeNext,
			allowImportingTsExtensions: true,
		},
		ts.sys,
	).resolvedModule;
	if (result === undefined) return undefined;
	return relative(root, path.resolve(result.resolvedFileName));
}

function diagnostic(root, sourceFile, node, code, message) {
	const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
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

function symbolOriginatesInWorker(symbol, root, checker, seen = new Set()) {
	if (symbol === undefined || seen.has(symbol)) return false;
	seen.add(symbol);
	if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
		return symbolOriginatesInWorker(checker.getAliasedSymbol(symbol), root, checker, seen);
	}
	return (symbol.declarations ?? []).some((declaration) =>
		workerModule(relative(root, path.resolve(declaration.getSourceFile().fileName))),
	);
}

function moduleExports(node, checker) {
	const moduleSymbol = checker.getSymbolAtLocation(node.moduleSpecifier);
	if (moduleSymbol === undefined || (moduleSymbol.flags & ts.SymbolFlags.Module) === 0) return [];
	return checker.getExportsOfModule(moduleSymbol);
}

function importedSymbols(node, checker) {
	if (ts.isImportDeclaration(node)) {
		const clause = node.importClause;
		if (clause === undefined) return [];
		const symbols = [];
		if (clause.name !== undefined) symbols.push({ name: "default", symbol: checker.getSymbolAtLocation(clause.name) });
		if (clause.namedBindings === undefined) return symbols;
		if (ts.isNamespaceImport(clause.namedBindings)) {
			return moduleExports(node, checker).map((symbol) => ({ name: symbol.getName(), symbol }));
		}
		for (const item of clause.namedBindings.elements) {
			symbols.push({
				name: (item.propertyName ?? item.name).text,
				symbol: checker.getSymbolAtLocation(item.name),
			});
		}
		return symbols;
	}
	if (ts.isExportDeclaration(node)) {
		if (node.exportClause === undefined || ts.isNamespaceExport(node.exportClause)) {
			return moduleExports(node, checker).map((symbol) => ({ name: symbol.getName(), symbol }));
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
	if (ts.isImportDeclaration(node)) {
		const clause = node.importClause;
		if (clause === undefined) return ["<side-effect>"];
		const names = [];
		if (clause.name !== undefined) names.push("default");
		if (clause.namedBindings === undefined) return names;
		if (ts.isNamespaceImport(clause.namedBindings)) return ["*"];
		for (const item of clause.namedBindings.elements) names.push((item.propertyName ?? item.name).text);
		return names;
	}
	if (ts.isExportDeclaration(node)) {
		if (node.exportClause === undefined) return ["*"];
		if (ts.isNamespaceExport(node.exportClause)) return ["*"];
		return node.exportClause.elements.map((item) => (item.propertyName ?? item.name).text);
	}
	return [];
}

function enclosingFunctionName(node) {
	for (let current = node.parent; current !== undefined; current = current.parent) {
		if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) return current.name?.getText();
		if (
			ts.isVariableDeclaration(current) &&
			current.initializer !== undefined &&
			ts.isArrowFunction(current.initializer)
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
	const files = listTypeScriptFiles(sourceRoot).filter((file) => !file.includes(`${path.sep}tests${path.sep}`));
	const options = {
		allowImportingTsExtensions: true,
		module: ts.ModuleKind.NodeNext,
		moduleResolution: ts.ModuleResolutionKind.NodeNext,
		noEmit: true,
		skipLibCheck: true,
		target: ts.ScriptTarget.ES2022,
	};
	const program = ts.createProgram(files, options);
	const checker = program.getTypeChecker();
	const diagnostics = [];

	for (const sourceFile of program.getSourceFiles()) {
		if (!path.resolve(sourceFile.fileName).startsWith(`${absoluteRoot}${path.sep}src${path.sep}`)) continue;
		const sourcePath = relative(absoluteRoot, sourceFile.fileName);
		if (sourcePath.includes("/tests/")) continue;

		const scopeMethodAliases = new Map();
		const visit = (node) => {
			if (
				(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
				node.moduleSpecifier !== undefined &&
				ts.isStringLiteral(node.moduleSpecifier) &&
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
				(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
				(node.moduleSpecifier === undefined || ts.isStringLiteral(node.moduleSpecifier))
			) {
				const target =
					node.moduleSpecifier === undefined
						? undefined
						: resolveModule(absoluteRoot, sourceFile, node.moduleSpecifier.text);
				const symbols = importedSymbols(node, checker);
				const hasWorkerOrigin =
					workerModule(target) || symbols.some(({ symbol }) => symbolOriginatesInWorker(symbol, absoluteRoot, checker));
				if (hasWorkerOrigin && !sourcePath.startsWith("src/api/worker-owner/")) {
					const entries = symbols.length > 0 ? symbols : importedNames(node).map((name) => ({ name }));
					for (const { name, symbol } of entries) {
						const resolvedSymbol =
							symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0
								? checker.getAliasedSymbol(symbol)
								: symbol;
						if (
							name === "workerReservation" ||
							resolvedSymbol?.getName() === "workerReservation" ||
							resolvedSymbol?.declarations?.some(
								(declaration) =>
									workerModule(relative(absoluteRoot, path.resolve(declaration.getSourceFile().fileName))) &&
									declaration.name?.getText() === "workerReservation",
							)
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
				ts.isCallExpression(node) &&
				node.expression.kind === ts.SyntaxKind.ImportKeyword &&
				!sourcePath.startsWith("src/api/worker-owner/") &&
				(node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0]))
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
				ts.isCallExpression(node) &&
				node.expression.kind === ts.SyntaxKind.ImportKeyword &&
				node.arguments.length === 1 &&
				ts.isStringLiteral(node.arguments[0])
			) {
				const target = resolveModule(absoluteRoot, sourceFile, node.arguments[0].text);
				const moduleSymbol = checker.getSymbolAtLocation(node.arguments[0]);
				const dynamicExports =
					moduleSymbol === undefined || (moduleSymbol.flags & ts.SymbolFlags.Module) === 0
						? []
						: checker.getExportsOfModule(moduleSymbol);
				if (
					(workerModule(target) ||
						dynamicExports.some((symbol) => symbolOriginatesInWorker(symbol, absoluteRoot, checker))) &&
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
				ts.isImportEqualsDeclaration(node) &&
				ts.isExternalModuleReference(node.moduleReference) &&
				ts.isStringLiteral(node.moduleReference.expression)
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

			if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)) {
				for (const element of node.name.elements) {
					const operation = (element.propertyName ?? element.name).getText(sourceFile);
					if (scopeOperations.has(operation) && ts.isIdentifier(element.name)) {
						const symbol = checker.getSymbolAtLocation(element.name);
						if (symbol !== undefined) scopeMethodAliases.set(symbol, operation);
					}
				}
			}
			if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
				const initializer = node.initializer;
				const operation = ts.isPropertyAccessExpression(initializer)
					? initializer.name.text
					: ts.isElementAccessExpression(initializer) && ts.isStringLiteral(initializer.argumentExpression)
						? initializer.argumentExpression.text
						: undefined;
				if (operation !== undefined && scopeOperations.has(operation)) {
					const symbol = checker.getSymbolAtLocation(node.name);
					if (symbol !== undefined) scopeMethodAliases.set(symbol, operation);
				}
			}

			if (ts.isCallExpression(node)) {
				const expression = node.expression;
				if (
					!sourcePath.startsWith("src/api/worker-owner/") &&
					ts.isIdentifier(expression) &&
					expression.text === "require"
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
					ts.isPropertyAccessExpression(expression) && ["call", "apply", "bind"].includes(expression.name.text)
						? expression.expression
						: expression;
				if (ts.isPropertyAccessExpression(callTarget) && scopeOperations.has(callTarget.name.text)) {
					operation = callTarget.name.text;
				} else if (
					ts.isElementAccessExpression(callTarget) &&
					callTarget.argumentExpression !== undefined &&
					ts.isStringLiteral(callTarget.argumentExpression) &&
					scopeOperations.has(callTarget.argumentExpression.text)
				) {
					operation = callTarget.argumentExpression.text;
				} else if (ts.isIdentifier(callTarget)) {
					const symbol = checker.getSymbolAtLocation(callTarget);
					if (symbol !== undefined) operation = scopeMethodAliases.get(symbol);
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
			ts.forEachChild(node, visit);
		};
		ts.forEachChild(sourceFile, visit);
	}

	return diagnostics;
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
