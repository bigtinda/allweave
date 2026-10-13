import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createProjectAgentTools } from "../src/model-provider-server.mjs";

const testDirectory = await mkdtemp(join(process.cwd(), ".project-agent-tools-test-"));

async function wait(ms) { await new Promise((done) => setTimeout(done, ms)); }

async function removeTemporaryTree(path) {
	for (let attempt = 0; ; attempt++) {
		try { await rm(path, { recursive: true, force: true }); return; }
		catch (error) {
			if (!["EBUSY", "EPERM", "ENOTEMPTY"].includes(error.code) || attempt >= 8) throw error;
			await wait(50 * (attempt + 1));
		}
	}
}

after(async () => {
	const root = resolve(process.cwd());
	const target = resolve(testDirectory);
	const rel = relative(root, target);
	if (rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)) await removeTemporaryTree(target);
});

test("Pi Agent project tools enforce confined reads, protected paths, symlinks and output limits", async () => {
	const projectRoot = join(testDirectory, "project");
	const taskRoot = join(projectRoot, "03_源代码", "TASK-001", "Run-1");
	const outsideRoot = join(testDirectory, "outside");
	await Promise.all([mkdir(projectRoot, { recursive: true }), mkdir(taskRoot, { recursive: true }), mkdir(outsideRoot, { recursive: true })]);
	await Promise.all([
		writeFile(join(projectRoot, "README.md"), "项目说明", "utf8"),
		writeFile(join(projectRoot, ".env.local"), "private environment", "utf8"),
		writeFile(join(projectRoot, "token-notes.txt"), "private token", "utf8"),
		writeFile(join(projectRoot, "large.txt"), "x".repeat(256 * 1024 + 1), "utf8"),
		writeFile(join(projectRoot, "binary.bin"), Buffer.from([0, 1, 2])),
		writeFile(join(outsideRoot, "secret.md"), "outside project secret", "utf8"),
		writeFile(join(outsideRoot, "race-note.md"), "outside project note", "utf8"),
	]);
	await mkdir(join(projectRoot, "race-read"));
	await writeFile(join(projectRoot, "race-read", "race-note.md"), "inside project note", "utf8");
	await mkdir(join(projectRoot, "race-list"));
	await writeFile(join(projectRoot, "race-list", "inside.md"), "inside listing", "utf8");
	await writeFile(join(outsideRoot, "outside-listing.md"), "outside listing", "utf8");
	await mkdir(join(taskRoot, "race-write"));
	await symlink(outsideRoot, join(projectRoot, "external-link"), "junction");
	await symlink(outsideRoot, join(taskRoot, "external-output"), "junction");
	const auditedReads = [];
	const { tools, written } = createProjectAgentTools(projectRoot, taskRoot, (path, content) => auditedReads.push({ path, content }));
	const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

	const listing = await byName.list_project_files.execute("list", {});
	const listedPaths = listing.content[0].text;
	assert.match(listedPaths, /README\.md/);
	assert.doesNotMatch(listedPaths, /\.env\.local|token-notes|external-link|secret\.md/);

	const read = await byName.read_project_file.execute("read", { path: "README.md" });
	assert.equal(read.content[0].text, "项目说明");
	assert.deepEqual(auditedReads, [{ path: "README.md", content: "项目说明" }]);
	for (const path of ["../outside/secret.md", "external-link/secret.md", ".env.local", "token-notes.txt", "large.txt", "binary.bin", "C:\\outside\\secret.md", "/outside/secret.md"]) {
		await assert.rejects(byName.read_project_file.execute("read-denied", { path }), undefined, `读取必须被拒绝：${path}`);
	}
	assert.equal(auditedReads.length, 1, "拒绝的读取不应进入文件访问审计回调");

	let listRaceInjected = false;
	const racedListTools = createProjectAgentTools(projectRoot, taskRoot, () => {}, {
		afterProjectDirectoryListed: async ({ directory, prefix }) => {
			if (listRaceInjected || prefix !== "race-list") return;
			listRaceInjected = true;
			await rename(directory, `${directory}-original`);
			await symlink(outsideRoot, directory, "junction");
		},
	}).tools.find((tool) => tool.name === "list_project_files");
	await assert.rejects(racedListTools.execute("race-list", {}), /符号链接|变化/);

	let readRaceInjected = false;
	const racedReadTools = createProjectAgentTools(projectRoot, taskRoot, (path, content) => auditedReads.push({ path, content }), {
		afterReadPathValidated: async () => {
			if (readRaceInjected) return;
			readRaceInjected = true;
			await rename(join(projectRoot, "race-read"), join(projectRoot, "race-read-original"));
			await symlink(outsideRoot, join(projectRoot, "race-read"), "junction");
		},
	}).tools.find((tool) => tool.name === "read_project_file");
	await assert.rejects(racedReadTools.execute("race-read", { path: "race-read/race-note.md" }), /符号链接|变化/);
	assert.equal(auditedReads.length, 1, "验证后替换成外部目录联接时不得读取外部文件或写入审计");

	let writeRaceInjected = false;
	const racedWriteTools = createProjectAgentTools(projectRoot, taskRoot, () => {}, {
		afterWritePathValidated: async () => {
			if (writeRaceInjected) return;
			writeRaceInjected = true;
			await rename(join(taskRoot, "race-write"), join(taskRoot, "race-write-original"));
			await symlink(outsideRoot, join(taskRoot, "race-write"), "junction");
		},
	}).tools.find((tool) => tool.name === "write_deliverable");
	await assert.rejects(racedWriteTools.execute("race-write", { path: "race-write/pwned.md", content: "must remain inside project" }), /符号链接|变化/);
	assert.deepEqual((await readdir(outsideRoot)).sort(), ["outside-listing.md", "race-note.md", "secret.md"], "验证后替换成外部目录联接时不得向项目外写文件");

	await byName.write_deliverable.execute("write", { path: "src/result.ts", content: "export const value = 1;" });
	await byName.write_deliverable.execute("rewrite", { path: "src/result.ts", content: "export const value = 2;" });
	assert.equal(await readFile(join(taskRoot, "src", "result.ts"), "utf8"), "export const value = 2;");
	assert.equal(written.size, 1, "重复写入相同相对路径应只保留一个产物索引");
	for (const path of ["../escape.txt", "external-output/pwned.txt", ".env", "node_modules/pkg.js", "credential.json", "nested/../../escape.txt"]) {
		await assert.rejects(byName.write_deliverable.execute("write-denied", { path, content: "must not escape" }), undefined, `写入必须被拒绝：${path}`);
	}
	await assert.rejects(byName.write_deliverable.execute("write-large", { path: "large.txt", content: "x".repeat(1024 * 1024 + 1) }), /1 MB/);
	await assert.rejects(byName.write_deliverable.execute("write-deep", { path: Array.from({ length: 9 }, (_, index) => `d${index}`).join("/") + "/file.txt", content: "too deep" }));
	assert.deepEqual((await readdir(outsideRoot)).sort(), ["outside-listing.md", "race-note.md", "secret.md"], "任何失败的路径写入都不能创建项目外文件");
	assert.deepEqual(written.get("src/result.ts"), ["src", "result.ts"]);
});
