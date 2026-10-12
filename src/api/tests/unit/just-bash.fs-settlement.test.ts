import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

function runScenario(scenario: string): string {
	return execFileSync(
		process.execPath,
		[
			"--unhandled-rejections=strict",
			"--input-type=module",
			"--eval",
			`
      import assert from "node:assert/strict";
      import { setImmediate } from "node:timers/promises";
      import { Bash, InMemoryFs } from "just-bash";

      const scenario = ${JSON.stringify(scenario)};
      const started = Promise.withResolvers();
      const pending = Promise.withResolvers();
      const fs = new InMemoryFs({ "/input.txt": "content" });
      let sandboxCallbacks = 0;
      const read = () => {
        started.resolve();
        if (scenario === "late-success") {
          pending.promise.then(() => { sandboxCallbacks++; });
        }
        return pending.promise;
      };
      if (scenario === "late-buffer-rejection") {
        fs.readFileBytes = undefined;
        fs.readFileBuffer = read;
      } else {
        fs.readFileBytes = read;
      }

      const controller = new AbortController();
      const customCommands = scenario === "late-lazy-rejection" ? [{
        name: "deferred-read",
        trusted: false,
        load: async () => ({
          name: "deferred-read",
          trusted: false,
          async execute(_args, ctx) {
            await ctx.fs.readFileBytes("/input.txt");
            return { stdout: "", stderr: "", exitCode: 0 };
          },
        }),
      }] : undefined;
      const bash = new Bash({ fs, defenseInDepth: true, customCommands });
      const command = customCommands ? "deferred-read" : "cat /input.txt";
      const execution = bash.exec(command, {
        signal: controller.signal,
      });
      await started.promise;
      if (scenario === "ordinary-success") {
        pending.resolve("content");
        const result = await execution;
        assert.equal(result.exitCode, 0);
        assert.equal(result.stdout, "content");
        assert.equal(result.stderr, "");
      } else {
        controller.abort();
        const result = await execution;
        assert.equal(result.exitCode, 124);
        assert.equal(result.stdout, "");
        assert.equal(result.stderr, "bash: execution aborted\\n");
        if (scenario === "late-success") {
          pending.resolve("content");
        } else {
          pending.reject(Object.assign(new Error("late filesystem rejection"), {
            code: "EIO",
          }));
        }
      }

      await setImmediate();
      await setImmediate();
      assert.equal(sandboxCallbacks, 0);
      const next = await bash.exec("echo ready");
      assert.equal(next.exitCode, 0);
      assert.equal(next.stdout, "ready\\n");
      assert.equal(next.stderr, "");
      console.log("settled");
      `,
		],
		{ encoding: "utf8", timeout: 10_000 },
	);
}

it("observes a filesystem rejection after an aborted exec returns", () => {
	expect(runScenario("late-rejection")).toBe("settled\n");
});

it("observes a binary filesystem rejection after an aborted exec returns", () => {
	expect(runScenario("late-buffer-rejection")).toBe("settled\n");
});

it("continues blocking sandbox callbacks after an aborted exec returns", () => {
	expect(runScenario("late-success")).toBe("settled\n");
});

it("preserves ordinary awaited filesystem results", () => {
	expect(runScenario("ordinary-success")).toBe("settled\n");
});

it("observes a lazy custom command rejection after an aborted exec returns", () => {
	expect(runScenario("late-lazy-rejection")).toBe("settled\n");
});
