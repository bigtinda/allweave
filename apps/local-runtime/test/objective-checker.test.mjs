import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep, isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { checkTaskRunOutputs } from "../src/objective-checker.mjs";

const testDirectory = await mkdtemp(join(process.cwd(), ".objective-checker-test-"));
after(async () => {
	const root = resolve(process.cwd());
	const target = resolve(testDirectory);
	const rel = relative(root, target);
	if (rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)) await rm(target, { recursive: true, force: true });
});

async function fixture(content = "verified output\n") {
	const projectRoot = join(testDirectory, randomUUID());
	const taskRoot = join(projectRoot, "03_源代码", "TASK-001", "Run-1");
	await mkdir(taskRoot, { recursive: true });
	await writeFile(join(taskRoot, "src.ts"), content, "utf8");
	return {
		projectRoot,
		taskRoot,
		files: [{ path: "src.ts", content }],
		authorization: { id: "fixture-auth", operation: "task.execute", status: "in_progress", payload: { projectId: "project-fixture", taskId: "TASK-001" } },
	};
}

test("a failed validation command blocks submission despite intact output files", async () => {
  const input = await fixture();
  const result = await checkTaskRunOutputs({ ...input, outputDirectory: "03_源代码", taskId: "TASK-001", runNumber: 1, projectId: "project-fixture", commandEnabled: true, commandChecks: [{ command: "node --check src.ts", validation: true, exitCode: 1, durationMs: 50 }] });
  assert.equal(result.checks.find((check) => check.id === "output_integrity").status, "passed");
  assert.equal(result.checks.find((check) => check.id === "automated_tests").status, "failed");
  assert.equal(result.passed, false);
});

test("objective checks verify task authorization, confined Run path, and actual disk hashes", async () => {
	const input = await fixture();
	const result = await checkTaskRunOutputs({ ...input, outputDirectory: "03_源代码", taskId: "TASK-001", runNumber: 1, projectId: "project-fixture" });
	assert.equal(result.passed, true);
	assert.deepEqual(result.checks.map((item) => item.status), ["passed", "passed", "passed", "passed", "not_run"]);
	assert.deepEqual(result.verifiedFiles, [{
		path: "src.ts",
		sha256: createHash("sha256").update("verified output\n", "utf8").digest("hex"),
		bytes: Buffer.byteLength("verified output\n", "utf8"),
	}]);
});

test("objective checks fail if the disk file differs from Agent output or authorization binding", async () => {
	const input = await fixture("disk content\n");
	input.files = [{ path: "src.ts", content: "Agent returned different content\n" }];
	input.authorization.payload.taskId = "TASK-002";
	const result = await checkTaskRunOutputs({ ...input, outputDirectory: "03_源代码", taskId: "TASK-001", runNumber: 1, projectId: "project-fixture" });
	assert.equal(result.passed, false);
	assert.equal(result.checks.find((item) => item.id === "authorization_binding").status, "failed");
	assert.equal(result.checks.find((item) => item.id === "output_integrity").status, "failed");
	assert.equal(result.checks.find((item) => item.id === "automated_tests").status, "not_run");
});

test("objective checks reject missing outputs and unsafe output paths", async () => {
	const input = await fixture();
	const empty = await checkTaskRunOutputs({ ...input, files: [], outputDirectory: "03_源代码", taskId: "TASK-001", runNumber: 1, projectId: "project-fixture" });
	assert.equal(empty.passed, false);
	assert.equal(empty.checks.find((item) => item.id === "required_output").status, "failed");
	const unsafe = await checkTaskRunOutputs({ ...input, files: [{ path: "../outside.ts", content: "x" }], outputDirectory: "03_源代码", taskId: "TASK-001", runNumber: 1, projectId: "project-fixture" });
	assert.equal(unsafe.passed, false);
	assert.equal(unsafe.checks.find((item) => item.id === "required_output").status, "failed");
});
