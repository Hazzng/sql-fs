import { describe, expect, it } from "vitest";
import { type OwnerCommand, type OwnerIdentity, mayApply } from "../../worker-owner/protocol.js";

const identity: OwnerIdentity = {
	tenantId: "tenant",
	sandboxId: "sandbox",
	connectionString: "unused",
	runtimeOptions: { python: false, javascript: false, network: false },
	owner: "owner",
	cwd: "/home/user",
};

const effects: Array<{ command: OwnerCommand; applies: boolean }> = [
	{ command: { kind: "attach", identity }, applies: true },
	{ command: { kind: "attach", identity: { ...identity, openExisting: false } }, applies: true },
	{ command: { kind: "attach", identity: { ...identity, openExisting: true } }, applies: false },
	{ command: { kind: "exec", script: "curl -X POST https://example.com", options: {} }, applies: true },
	{ command: { kind: "readFile", args: ["/file"] }, applies: false },
	{ command: { kind: "readFileBuffer", args: ["/file"] }, applies: false },
	{ command: { kind: "readFileBytes", args: ["/file"] }, applies: false },
	{ command: { kind: "writeFile", args: ["/file", "bytes"] }, applies: true },
	{ command: { kind: "appendFile", args: ["/file", "bytes"] }, applies: true },
	{ command: { kind: "exists", args: ["/file"] }, applies: false },
	{ command: { kind: "stat", args: ["/file"] }, applies: false },
	{ command: { kind: "mkdir", args: ["/dir"] }, applies: true },
	{ command: { kind: "createExclusive", args: ["/file", { mode: 0o600 }] }, applies: true },
	{ command: { kind: "readdir", args: ["/dir"] }, applies: false },
	{ command: { kind: "readdirWithFileTypes", args: ["/dir"] }, applies: false },
	{ command: { kind: "rm", args: ["/file"] }, applies: true },
	{ command: { kind: "cp", args: ["/file", "/copy"] }, applies: true },
	{ command: { kind: "mv", args: ["/file", "/moved"] }, applies: true },
	{ command: { kind: "chmod", args: ["/file", 0o644] }, applies: true },
	{ command: { kind: "symlink", args: ["/file", "/symlink"] }, applies: true },
	{ command: { kind: "link", args: ["/file", "/hardlink"] }, applies: true },
	{ command: { kind: "readlink", args: ["/symlink"] }, applies: false },
	{ command: { kind: "lstat", args: ["/file"] }, applies: false },
	{ command: { kind: "realpath", args: ["/file"] }, applies: false },
	{ command: { kind: "utimes", args: ["/file", new Date(0), new Date(0)] }, applies: true },
	{ command: { kind: "paths" }, applies: false },
	{ command: { kind: "reload" }, applies: false },
	{ command: { kind: "fresh" }, applies: false },
	{ command: { kind: "runtime", runtimeOptions: identity.runtimeOptions }, applies: false },
	{ command: { kind: "bulkIngest", files: [] }, applies: true },
	{ command: { kind: "beginScope" }, applies: false },
	{ command: { kind: "endScope" }, applies: true },
	{ command: { kind: "abortScope" }, applies: false },
	{ command: { kind: "disconnect" }, applies: false },
	{ command: { kind: "clearDirty" }, applies: false },
	{ command: { kind: "shutdown" }, applies: false },
];

describe("worker command effects", () => {
	it.each(effects)("classifies $command.kind as applies=$applies", ({ command, applies }) => {
		expect(mayApply(command)).toBe(applies);
	});
});
