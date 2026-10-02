import { describe, expect, it } from "vitest";
import { runValidation, runValidations } from "../src/validation.js";

const cwd = process.cwd();

describe("runValidation", () => {
  it("reports a non-zero exit as failed instead of throwing", async () => {
    const result = await runValidation('node -e "process.exit(3)"', cwd);
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(3);
  });

  it("reports exit 0 as passed with captured output", async () => {
    const result = await runValidation('node -e "console.log(\'hello\')"', cwd);
    expect(result.status).toBe("passed");
    expect(result.output.trim()).toBe("hello");
  });

  it("kills a hung command and reports timed_out", async () => {
    const result = await runValidation('node -e "setTimeout(()=>{},5000)"', cwd, { timeoutMs: 200 });
    expect(result.status).toBe("timed_out");
    expect(result.exitCode).toBeNull();
    expect(result.durationMs).toBeLessThan(4000);
  }, 10_000);

  it("caps output and marks it truncated", async () => {
    const result = await runValidation("node -e \"process.stdout.write('x'.repeat(10000))\"", cwd, {
      maxOutputBytes: 100,
    });
    expect(result.truncated).toBe(true);
    expect(result.output).toContain("[output truncated at 100 bytes]");
    expect(result.output.length).toBeLessThan(200);
  });

  it("rejects a command that is not on the allowlist without running it", async () => {
    const result = await runValidation("rm -rf /tmp/should-not-run", cwd, { allowedCommands: ["npm test"] });
    expect(result.status).toBe("rejected");
    expect(result.durationMs).toBe(0);
    expect(result.output).toContain("npm test");
  });

  it("matches allowlisted commands exactly, so a prefix is not enough", async () => {
    const result = await runValidation("npm test; echo pwned", cwd, { allowedCommands: ["npm test"] });
    expect(result.status).toBe("rejected");
  });
});

describe("runValidations", () => {
  it("keeps going after a failure and preserves order", async () => {
    const results = await runValidations(['node -e "process.exit(1)"', 'node -e "process.exit(0)"'], cwd);
    expect(results.map((r) => r.status)).toEqual(["failed", "passed"]);
  });
});
