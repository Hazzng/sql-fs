import { Bash } from "just-bash";
import type { BashExecResult, ExecOptions, IFileSystem, SecurityViolation } from "just-bash";
import { SessionScopedFs } from "../../sql-fs/session-scoped-fs.js";
import type { ICoherentFs, IScriptTxFs } from "../../sql-fs/sql-fs.js";
import { type GitIdentity, createGitCommand, httpsOnlyGitFetch } from "../commands/git-command.js";
import { nodeCommand } from "../commands/node-command.js";
import { LockLostError } from "../distributed-lock.js";
import { type ExecContext, consumeExecInput, execContext } from "../exec-context.js";
import { logAudit } from "../lib/audit.js";
import { MAX_EXEC_FILE_BYTES } from "../lib/env.js";
import { posixNormalizePath } from "../lib/paths.js";
import { readOnlyContext } from "../read-only-context.js";
import { sessionLeaseSignal } from "../session-lease-context.js";
import { ownerLeaseLost } from "../worker-owner/cancellation.js";

export interface RuntimeOptions {
	readonly python: boolean;
	readonly javascript: boolean;
	readonly network: boolean;
}

export interface SessionScriptScope {
	readonly isActive: boolean;
	beginScope(): void | Promise<void>;
	endScope(): Promise<void>;
	abortScope(): Promise<void>;
	run<T>(fn: () => Promise<T>): Promise<T>;
}

export interface SessionRuntime {
	readonly fs: IFileSystem;
	readonly bash: Pick<Bash, "exec" | "getCwd" | "registerCommand">;
	readonly runtimeOptions: RuntimeOptions;
	readonly tenantId: string;
	readonly sandboxId: string;
	readonly scriptTx: SessionScriptScope | undefined;
	readonly execInputLimitBytes?: number;
	readonly execFileLimitBytes?: number | null;
	cwd: string;
}

export interface RuntimeFactoryOptions {
	readonly defenseInDepth: boolean;
	readonly defenseAuditMode: boolean;
	readonly executionLimits?: NonNullable<ConstructorParameters<typeof Bash>[0]>["executionLimits"];
	readonly execFileLimitBytes?: number | null;
	readonly baseEnv?: Record<string, string>;
	readonly gitIdentity?: GitIdentity;
}

const NETWORK_CREDENTIALS = new Set(["GITHUB_TOKEN", "GIT_HTTP_BEARER_TOKEN", "GIT_HTTP_USER", "GIT_HTTP_PASSWORD"]);
const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const unsupportedEnvWarned = new WeakSet<SessionRuntime>();

export function buildSandboxBaseEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const out: Record<string, string> = Object.create(null);
	if (env.GITHUB_TOKEN) {
		out.GITHUB_TOKEN = env.GITHUB_TOKEN;
		out.GIT_HTTP_USER = "x-access-token";
		out.GIT_HTTP_PASSWORD = env.GITHUB_TOKEN;
	}
	return out;
}

export function buildGitIdentity(env: NodeJS.ProcessEnv = process.env): GitIdentity | undefined {
	const name = env.GIT_AUTHOR_NAME || env.GIT_COMMITTER_NAME;
	const email = env.GIT_AUTHOR_EMAIL || env.GIT_COMMITTER_EMAIL;
	return name && email ? { name, email } : undefined;
}

export function deriveExecGitCredentials(
	env: Record<string, string> | undefined,
	network: boolean,
): Record<string, string> | undefined {
	if (env === undefined || !network || !Object.hasOwn(env, "GITHUB_TOKEN")) return env;
	const out: Record<string, string> = Object.assign(Object.create(null), env);
	if (!Object.hasOwn(env, "GIT_HTTP_USER")) out.GIT_HTTP_USER = "x-access-token";
	if (!Object.hasOwn(env, "GIT_HTTP_PASSWORD")) out.GIT_HTTP_PASSWORD = env.GITHUB_TOKEN ?? "";
	return out;
}

function runtimeEnv(base: Record<string, string>, network: boolean): Record<string, string> | undefined {
	const out: Record<string, string> = Object.create(null);
	for (const [key, value] of Object.entries(base)) {
		if (network || !NETWORK_CREDENTIALS.has(key)) out[key] = value;
	}
	return Object.keys(out).length === 0 ? undefined : out;
}

function logDefenseViolation(violation: SecurityViolation): void {
	logAudit("defense_in_depth_violation", { ...violation, sandboxId: execContext.getStore()?.sandboxId });
}

function scriptScope(fs: IFileSystem): SessionScopedFs | undefined {
	const candidate = fs as Partial<IScriptTxFs>;
	return typeof candidate.beginScriptScope === "function" &&
		typeof candidate.endScriptScope === "function" &&
		typeof candidate.abortScriptScope === "function" &&
		typeof candidate.reload === "function" &&
		typeof candidate.wasDirty === "function" &&
		typeof candidate.clearDirty === "function"
		? new SessionScopedFs(fs as IScriptTxFs)
		: undefined;
}

export function createSessionRuntime(
	fs: IFileSystem,
	identity: { readonly tenantId: string; readonly sandboxId: string; readonly runtimeOptions: RuntimeOptions },
	options: RuntimeFactoryOptions,
): SessionRuntime {
	const inputLimit = options.executionLimits?.maxInputBytes;
	if (
		options.execFileLimitBytes === null &&
		(inputLimit === undefined || !Number.isSafeInteger(inputLimit) || inputLimit <= 0)
	) {
		throw new Error("Worker execution without a per-file cap requires a finite positive aggregate input budget");
	}
	const execFileLimitBytes =
		options.execFileLimitBytes === undefined ? MAX_EXEC_FILE_BYTES : options.execFileLimitBytes;
	const maxPythonBridgeBytes =
		execFileLimitBytes === null
			? options.executionLimits?.maxPythonBridgeBytes
			: Math.min(
					Math.max(24, execFileLimitBytes),
					options.executionLimits?.maxPythonBridgeBytes ?? Number.POSITIVE_INFINITY,
				);
	(fs as Partial<ICoherentFs>).setOwnerLeaseGuard?.(() => {
		if (sessionLeaseSignal()?.aborted) throw new LockLostError("session owner generation");
	});
	const { runtimeOptions } = identity;
	const bash = new Bash({
		fs,
		executionLimits: { ...options.executionLimits, maxPythonBridgeBytes },
		python: runtimeOptions.python || undefined,
		javascript: runtimeOptions.javascript || undefined,
		network: runtimeOptions.network ? { dangerouslyAllowFullInternetAccess: true } : undefined,
		env: runtimeEnv(options.baseEnv ?? buildSandboxBaseEnv(), runtimeOptions.network),
		defenseInDepth: options.defenseInDepth
			? {
					enabled: true,
					auditMode: options.defenseAuditMode,
					onViolation: logDefenseViolation,
				}
			: false,
		customCommands: [
			...(runtimeOptions.javascript ? [nodeCommand] : []),
			createGitCommand({
				network: runtimeOptions.network ? { fetch: httpsOnlyGitFetch } : false,
				identity: options.gitIdentity ?? buildGitIdentity(),
			}),
		],
	});
	return {
		...identity,
		fs,
		bash,
		scriptTx: scriptScope(fs),
		execInputLimitBytes: options.executionLimits?.maxInputBytes,
		execFileLimitBytes,
		cwd: bash.getCwd(),
	};
}

function warnUnsupportedEnv(runtime: SessionRuntime, env: Record<string, string> | undefined): void {
	if (unsupportedEnvWarned.has(runtime) || env === undefined) return;
	const variableNames: string[] = [];
	let omittedNameCount = 0;
	let truncatedNameCount = 0;
	for (const name in env) {
		if (!Object.hasOwn(env, name) || SHELL_NAME.test(name)) continue;
		if (variableNames.length >= 20) {
			omittedNameCount++;
			continue;
		}
		variableNames.push(name.slice(0, 128));
		if (name.length > 128) truncatedNameCount++;
	}
	if (variableNames.length === 0) return;
	unsupportedEnvWarned.add(runtime);
	logAudit("exec_env_not_exported", {
		tenantId: runtime.tenantId,
		sandboxId: runtime.sandboxId,
		variableNames,
		omittedNameCount,
		truncatedNameCount,
		severity: "warn",
	});
}

export async function executeSessionRuntime(
	runtime: SessionRuntime,
	script: string,
	options?: ExecOptions,
): Promise<BashExecResult> {
	const resolved: ExecOptions = {
		...options,
		cwd: options?.cwd ?? runtime.cwd,
		env: deriveExecGitCredentials(options?.env, runtime.runtimeOptions.network),
	};
	warnUnsupportedEnv(runtime, resolved.env);
	const readOnly = readOnlyContext.getStore() !== undefined;
	const scope = readOnly ? undefined : runtime.scriptTx;
	const ownsScope = scope !== undefined && !scope.isActive;
	if (ownsScope) await scope.beginScope();
	const context: ExecContext = {
		sandboxId: runtime.sandboxId,
		maxFileBytes: runtime.execFileLimitBytes === undefined ? MAX_EXEC_FILE_BYTES : runtime.execFileLimitBytes,
		...(runtime.execInputLimitBytes === undefined
			? {}
			: { inputLimitBytes: runtime.execInputLimitBytes, inputBytes: 0 }),
	};
	try {
		consumeExecInput(context, Buffer.byteLength(resolved.stdin ?? "", "utf8"), "stdin");
		const result = await execContext.run(context, () => runtime.bash.exec(script, resolved));
		if (scope !== undefined && (sessionLeaseSignal()?.aborted === true || ownerLeaseLost())) {
			throw new LockLostError("exec aborted: distributed exec lock lost mid-script");
		}
		if (context.exceeded !== undefined) throw context.exceeded;
		if (ownsScope) await scope.endScope();
		const cwd = result.env?.PWD;
		if (!readOnly && typeof cwd === "string" && cwd.startsWith("/") && !cwd.includes("\0")) {
			runtime.cwd = posixNormalizePath(cwd);
		}
		return result;
	} catch (error) {
		if (ownsScope) {
			try {
				await scope.abortScope();
			} catch {}
		}
		throw error;
	}
}

export async function closeSessionRuntime(runtime: SessionRuntime): Promise<void> {
	const fs = runtime.fs as IFileSystem & { disconnect?: () => Promise<void> };
	try {
		await runtime.scriptTx?.abortScope();
	} finally {
		await fs.disconnect?.();
	}
}
