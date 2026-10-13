import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, it } from "node:test";
import { checkArchitectureBoundaries } from "./check-architecture-boundaries.mjs";

const roots = [];

function project(files) {
	const root = mkdtempSync(path.join(os.tmpdir(), "sql-fs-boundaries-"));
	roots.push(root);
	if (!("tsconfig.json" in files)) {
		files["tsconfig.json"] = '{"include":["src/**/*.ts"],"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext","target":"ES2022","skipLibCheck":true}}\n';
	}
	for (const [name, contents] of Object.entries(files)) {
		const filename = path.join(root, name);
		mkdirSync(path.dirname(filename), { recursive: true });
		writeFileSync(filename, contents);
	}
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("permits named adapter imports and scope cleanup in the runtime shutdown owner", () => {
	const root = project({
		"src/api/worker-owner/pool.ts": "export class WorkerOwnerPool {}\nexport const workerReservation = {};\n",
		"src/api/worker-owner/filesystem.ts": "export class WorkerFileSystem {}\n",
		"src/api/worker-owner/message-budget.ts": "export function assertWorkerMessageBudget() {}\n",
		"src/api/worker-owner/protocol.ts": "export class OutcomeUnknownError {}\nexport type ShellExecutionLimits = {};\n",
		"src/api/session-manager.ts":
			"import { WorkerOwnerPool } from './worker-owner/pool.js';\nimport { WorkerFileSystem } from './worker-owner/filesystem.js';\nvoid [WorkerOwnerPool, WorkerFileSystem];\n",
		"src/api/session-runtime/engine.ts":
			"interface Scope { abortScope(): Promise<void> }\nexport async function closeSessionRuntime(scope: Scope) { await scope.abortScope(); }\n",
	});
	assert.deepEqual(checkArchitectureBoundaries(root), []);
});

it("checks production files excluded from tsconfig", () => {
	const root = project({
		"tsconfig.json":
			'{"include":["src/api/included.ts"],"exclude":["src/api/excluded.ts"],"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext","target":"ES2022"}}\n',
		"src/api/included.ts": "export const included = true;\n",
		"src/api/excluded.ts": "import { WorkerOwnerPool } from './worker-owner/pool.js';\nvoid WorkerOwnerPool;\n",
		"src/api/worker-owner/pool.ts": "export class WorkerOwnerPool {}\n",
	});
	const diagnostics = checkArchitectureBoundaries(root);
	assert.ok(
		diagnostics.some(({ file, code }) => file === "src/api/excluded.ts" && code === "WORKER_INTERNAL_IMPORT"),
	);
});

it("rejects aliased imports, re-exports, and dynamic imports of worker internals", () => {
	const root = project({
		"src/api/worker-owner/pool.ts": "export class WorkerOwnerPool {}\n",
		"src/api/bridge.ts": "export { WorkerOwnerPool as Pool } from './worker-owner/pool.js';\n",
		"src/api/bridge-local.ts":
			"import { WorkerOwnerPool as LocalPool } from './worker-owner/pool.js';\nexport { LocalPool };\n",
		"src/api/consumer.ts": "import { WorkerOwnerPool as Pool } from './worker-owner/pool.js';\nvoid Pool;\n",
		"src/api/reexport.ts": "export { WorkerOwnerPool as Pool } from './worker-owner/pool.js';\n",
		"src/api/lazy.ts": "void import('./worker-owner/pool.js');\n",
		"src/api/indirect.ts": "import { Pool } from './bridge.js';\nvoid Pool;\n",
		"src/api/indirect-lazy.ts": "void import('./bridge.js');\n",
		"src/api/indirect-local.ts": "import { LocalPool } from './bridge-local.js';\nvoid LocalPool;\n",
	});
	const diagnostics = checkArchitectureBoundaries(root);
	assert.deepEqual(
		new Set(diagnostics.map(({ code }) => code)),
		new Set(["WORKER_INTERNAL_IMPORT", "WORKER_INTERNAL_DYNAMIC_IMPORT"]),
	);
	assert.ok(diagnostics.length >= 6);
	assert.ok(diagnostics.some(({ file }) => file === "src/api/indirect.ts"));
	assert.ok(diagnostics.some(({ file }) => file === "src/api/indirect-lazy.ts"));
	assert.ok(diagnostics.some(({ file }) => file === "src/api/indirect-local.ts"));
});

it("reports mutable reservation imports through aliases and namespace imports", () => {
	const root = project({
		"src/api/worker-owner/pool.ts": "export const workerReservation = {};\n",
		"src/api/consumer.ts":
			"import { workerReservation as reservation } from './worker-owner/pool.js';\nvoid reservation;\n",
		"src/api/namespace.ts": "import * as pool from './worker-owner/pool.js';\nvoid pool.workerReservation;\n",
	});
	const diagnostics = checkArchitectureBoundaries(root);
	const leaks = diagnostics.filter(({ code }) => code === "WORKER_RESERVATION_LEAK");
	assert.ok(leaks.some(({ file }) => file === "src/api/consumer.ts"));
	assert.ok(leaks.some(({ file }) => file === "src/api/namespace.ts"));
});

it("rejects direct and computed script completion calls outside the scope owner", () => {
	const root = project({
		"src/api/script-scope.ts":
			"export interface ScriptScope { beginScope(): Promise<void>; endScope(): Promise<void>; abortScope(): Promise<void> }\n",
		"src/api/routes/exec.ts":
			"import type { ScriptScope } from '../script-scope.js';\nexport async function handler(scope: ScriptScope) { await scope.beginScope(); await scope['endScope'](); await scope.abortScope(); const untyped: any = {}; await untyped.beginScope(); const { abortScope: abort } = untyped; await abort(); const end = scope.endScope; await end(); }\n",
	});
	const diagnostics = checkArchitectureBoundaries(root);
	assert.equal(diagnostics.filter(({ code }) => code === "SCRIPT_SCOPE_COMPLETION_OWNER").length, 6);
});

it("checks all production source paths and handles local export declarations", () => {
	const root = project({
		"src/api/worker-owner/pool.ts": "export class WorkerOwnerPool {}\n",
		"src/sql-fs/consumer.ts": "import { WorkerOwnerPool } from '../api/worker-owner/pool.js';\nvoid WorkerOwnerPool;\n",
		"src/sql-fs/bypass.ts":
			"interface Scope { beginScope(): Promise<void> }\nexport async function bypass(scope: Scope) { await scope.beginScope(); }\n",
		"src/sql-fs/local-export.ts": "const localValue = 1;\nexport { localValue };\n",
	});
	const diagnostics = checkArchitectureBoundaries(root);
	assert.ok(
		diagnostics.some(({ file, code }) => file === "src/sql-fs/consumer.ts" && code === "WORKER_INTERNAL_IMPORT"),
	);
	assert.ok(
		diagnostics.some(({ file, code }) => file === "src/sql-fs/bypass.ts" && code === "SCRIPT_SCOPE_COMPLETION_OWNER"),
	);
	assert.ok(!diagnostics.some(({ file }) => file === "src/sql-fs/local-export.ts"));
});

it("permits routes to use the central script-scope helper", () => {
	const root = project({
		"src/sql-fs/script-scope.ts":
			"export interface ScriptScope { beginScope(): Promise<void>; endScope(): Promise<void>; abortScope(): Promise<void> }\nexport async function runInScriptScope<T>(scope: ScriptScope, fn: () => Promise<T>) { await scope.beginScope(); try { const value = await fn(); await scope.endScope(); return value; } catch (error) { await scope.abortScope(); throw error; } }\n",
		"src/api/routes/exec.ts":
			"import { runInScriptScope, type ScriptScope } from '../../sql-fs/script-scope.js';\nexport async function handler(scope: ScriptScope, fn: () => Promise<void>) { return runInScriptScope(scope, fn); }\n",
	});
	assert.deepEqual(checkArchitectureBoundaries(root), []);
});

it("rejects nonliteral imports and CommonJS loaders outside worker-owner", () => {
	const root = project({
		"src/api/consumer.ts":
			"import { createRequire } from 'node:module';\nconst load = createRequire(import.meta.url);\nload('./runtime.js');\nrequire('./runtime.js');\nvoid import(moduleName);\n",
		"src/api/inline-loader.ts":
			"import { createRequire } from 'node:module';\nvoid createRequire(import.meta.url)('./runtime.js');\n",
		"src/api/namespace-loader.ts":
			"import * as Module from 'node:module';\nconst load = Module.createRequire(import.meta.url);\nload('./runtime.js');\n",
		"src/api/alias-loader.ts":
			"import { createRequire } from 'module';\nconst makeLoader = createRequire;\nconst load = makeLoader(import.meta.url);\nload('./runtime.js');\n",
		"src/api/default-loader.ts": "import Module from 'node:module';\n",
		"src/api/equals-node-loader.ts":
			"import Module = require('node:module');\nModule.createRequire(import.meta.url)('./runtime.js');\n",
		"src/api/equals-loader.ts":
			"import Module = require('module');\nModule.createRequire(import.meta.url)('./runtime.js');\n",
		"src/api/reexport-loader.ts": "export { createRequire as loader } from 'node:module';\n",
		"src/api/runtime.ts": "export const value = 1;\n",
	});
	const diagnostics = checkArchitectureBoundaries(root);
	assert.equal(diagnostics.filter(({ code }) => code === "WORKER_INTERNAL_DYNAMIC_IMPORT").length, 10);
});

it("rejects dynamic module loaders, aliased require calls, and reflected scope completion", () => {
	const root = project({
		"src/api/dynamic-node-module.ts":
			"const moduleApi = await import('node:module');\nconst makeLoader = moduleApi.createRequire;\nconst load = makeLoader(import.meta.url);\nload('./runtime.js');\n",
		"src/api/dynamic-module.ts":
			"const { createRequire: makeLoader } = await import('module');\nconst load = makeLoader(import.meta.url);\nload('./runtime.js');\n",
		"src/api/aliased-require.ts":
			"const makeLoader = require;\nmakeLoader('./runtime.js');\n",
		"src/api/reflected-scope.ts":
			"interface Scope { endScope(): Promise<void> }\nexport function finish(scope: Scope) { return Reflect.apply(scope.endScope, scope, []); }\n",
		"src/api/parenthesized-scope.ts":
			"interface Scope { beginScope(): Promise<void> }\nexport function start(scope: Scope) { return (scope.beginScope)(); }\n",
		"src/api/parenthesized-alias.ts":
			"interface Scope { beginScope(): Promise<void> }\nexport function start(scope: Scope) { const begin = (scope.beginScope); return begin(); }\n",
		"src/api/worker-owner/loader.ts": "void import('node:module');\n",
		"src/api/legitimate.ts": "void import('./helper.js');\n",
		"src/api/helper.ts": "export const value = 1;\n",
	});
	const diagnostics = checkArchitectureBoundaries(root);
	assert.equal(diagnostics.filter(({ code }) => code === "WORKER_INTERNAL_DYNAMIC_IMPORT").length, 3);
	assert.equal(diagnostics.filter(({ code }) => code === "SCRIPT_SCOPE_COMPLETION_OWNER").length, 3);
	assert.ok(!diagnostics.some(({ file }) => file === "src/api/legitimate.ts"));
	assert.ok(!diagnostics.some(({ file }) => file === "src/api/worker-owner/loader.ts"));
});

it("permits literal non-worker imports and rejects indirect scope method calls", () => {
	const root = project({
		"src/api/helper.ts": "export const value = 1;\n",
		"src/api/consumer.ts":
			"import { value } from './helper.js';\ninterface Scope { endScope(): Promise<void>; abortScope(): Promise<void>; beginScope(): Promise<void> }\nexport async function run(scope: Scope) { const { endScope } = scope; await scope.endScope.call(scope); await endScope.apply(scope); await scope.beginScope.bind(scope)(); }\n",
	});
	const diagnostics = checkArchitectureBoundaries(root);
	assert.deepEqual(
		diagnostics.map(({ code }) => code),
		["SCRIPT_SCOPE_COMPLETION_OWNER", "SCRIPT_SCOPE_COMPLETION_OWNER", "SCRIPT_SCOPE_COMPLETION_OWNER"],
	);
});
