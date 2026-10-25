import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const applicationSetting =
	/^(SQL_FS_|JUST_BASH_|MAX_|SCRIPT_TX_|REDIS_|AUTH_|ADMIN_|BOOTSTRAP_|TENANT_|DATABASE_|SESSION_|EXEC_|MCP_|PYTHON_|JS_|ENABLE_|EVENT_LOOP_|SKIP_STARTUP_|SDK_VERIFY_|INPUT_VERIFY_|INGRESS_VERIFY_|SSE_FINALIZATION_|NODE_OPTIONS$|PORT$)/;

export function startApiContainer(repo, name, env, evidence) {
	const image = process.env.VERIFY_CONTAINER_IMAGE;
	const cpus = process.env.VERIFY_CONTAINER_CPUS ?? "1";
	const memory = process.env.VERIFY_CONTAINER_MEMORY ?? "2g";
	const user =
		process.env.VERIFY_IMAGE_ARTIFACT !== "1" && process.getuid
			? ["--user", `${process.getuid()}:${process.getgid()}`]
			: [];
	const settings = Object.keys(env)
		.filter((key) => applicationSetting.test(key))
		.flatMap((key) => ["--env", key]);
	const profile = process.env.VERIFY_CPU_PROFILE === "1";
	const profileDirectory =
		profile && process.env.VERIFY_IMAGE_ARTIFACT === "1" ? join(evidence, "cpu-profiles") : evidence;
	if (profileDirectory !== evidence) {
		mkdirSync(profileDirectory, { recursive: true });
		chmodSync(profileDirectory, 0o1777);
	}
	const child = spawn(
		"docker",
		[
			"run",
			"--name",
			name,
			"--network",
			"host",
			"--cpus",
			cpus,
			"--memory",
			memory,
			...user,
			"--memory-swap",
			memory,
			"--read-only",
			"--tmpfs",
			"/tmp",
			"--volume",
			process.env.VERIFY_IMAGE_ARTIFACT === "1"
				? `${repo}/scripts/verify:/app/scripts/verify:ro`
				: `${repo}:/app:ro`,
			...(profile ? ["--volume", `${profileDirectory}:/evidence:rw`] : []),
			"--workdir",
			"/app",
			...settings,
			image,
			"node",
			...(profile ? ["--cpu-prof", "--cpu-prof-dir=/evidence"] : []),
			"dist/api/server.js",
		],
		{ env, stdio: ["ignore", "pipe", "pipe"] },
	);
	return { child, container: name };
}

export async function containerResources(name) {
	const { stdout } = await execute("docker", ["inspect", name]);
	const [info] = JSON.parse(stdout);
	const [status, peak, cpu, memoryEvents, version] = await Promise.all(
		["/proc/1/status", "/sys/fs/cgroup/memory.peak", "/sys/fs/cgroup/cpu.stat", "/sys/fs/cgroup/memory.events"]
			.map((path) => execute("docker", ["exec", name, "cat", path]).then((result) => result.stdout))
			.concat([execute("docker", ["exec", name, "node", "--version"]).then((result) => result.stdout)]),
	);
	const field = (key) => Number(status.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"))?.[1] ?? 0);
	const counters = (value) =>
		Object.fromEntries(
			value
				.trim()
				.split("\n")
				.map((line) => {
					const [key, count] = line.split(/\s+/);
					return [key, Number(count)];
				}),
		);
	return {
		imageId: info.Image,
		serverNode: version.trim(),
		cpuQuotaCores: info.HostConfig.NanoCpus / 1e9,
		memoryLimitBytes: info.HostConfig.Memory,
		memoryPeakBytes: Number(peak.trim()),
		oomKilled: info.State.OOMKilled,
		cpu: counters(cpu),
		memoryEvents: counters(memoryEvents),
		rssBytes: field("VmRSS") * 1024,
		peakRssBytes: field("VmHWM") * 1024,
		threads: field("Threads"),
	};
}

export function sampleContainer(name, receive) {
	const child = spawn("docker", ["stats", "--format", "{{json .}}", name], { stdio: ["ignore", "pipe", "ignore"] });
	let pending = "";
	child.stdout.on("data", (chunk) => {
		pending += chunk.toString();
		let newline;
		while ((newline = pending.indexOf("\n")) >= 0) {
			const line = pending.slice(0, newline);
			pending = pending.slice(newline + 1);
			try {
				receive(JSON.parse(line));
			} catch {}
		}
	});
	return async () => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		const exited = once(child, "exit");
		child.kill("SIGINT");
		const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
		try {
			await exited;
		} finally {
			clearTimeout(timer);
		}
	};
}

export async function stopApiContainer(name, profileDestination) {
	await execute("docker", ["stop", "--time", "10", name]);
	const { stdout } = await execute("docker", ["inspect", "--format", "{{.State.Running}}", name]);
	if (stdout.trim() !== "false") throw new Error("Owned verification container did not stop");
	try {
		if (profileDestination) await execute("docker", ["cp", `${name}:/evidence/.`, profileDestination]);
	} finally {
		await execute("docker", ["rm", name]);
	}
}
