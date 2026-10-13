#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const excludedDirectories = new Set([".artifacts", ".git", ".turbo", "coverage", "dist", "node_modules", "target"]);
const runtimeDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(runtimeDirectory, "../../../../");

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function listSourceFiles(root, directory = root) {
	const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
	const files = [];
	for (const entry of entries) {
		if (entry.isDirectory()) {
			if (!excludedDirectories.has(entry.name)) {
				files.push(...listSourceFiles(root, resolve(directory, entry.name)));
			}
		} else if (entry.isFile()) {
			files.push(resolve(directory, entry.name));
		} else if (entry.isSymbolicLink()) {
			throw new Error(`Pi source snapshot contains an unsupported symbolic link: ${relative(root, resolve(directory, entry.name))}`);
		}
	}
	return files;
}

function hashSourceTree(root) {
	const treeHash = createHash("sha256");
	const files = listSourceFiles(root);
	let totalBytes = 0;
	for (const path of files) {
		const content = readFileSync(path);
		const relativePath = relative(root, path).split(sep).join("/");
		totalBytes += content.byteLength;
		treeHash.update(relativePath, "utf8");
		treeHash.update("\0");
		treeHash.update(content);
		treeHash.update("\0");
	}
	return { fileCount: files.length, sha256: treeHash.digest("hex"), totalBytes };
}

const { values } = parseArgs({
	options: {
		"output-file": { type: "string" },
		"source-dir": { type: "string" },
	},
});

const sourceDirectory = resolve(values["source-dir"] ?? resolve(workspaceRoot, "pi-main"));
const outputFile = resolve(
	values["output-file"] ?? resolve(workspaceRoot, "ai-agent-team/docs/p0/pi-source-baseline.json"),
);
if (!existsSync(sourceDirectory) || !lstatSync(sourceDirectory).isDirectory()) {
	throw new Error(`Pi source directory does not exist or is not a directory: ${sourceDirectory}`);
}

const rootPackage = readJson(resolve(sourceDirectory, "package.json"));
const lockPath = resolve(sourceDirectory, "package-lock.json");
const codingAgent = readJson(resolve(sourceDirectory, "packages/coding-agent/package.json"));
const packageDirectories = readdirSync(resolve(sourceDirectory, "packages"), { withFileTypes: true })
	.filter((entry) => entry.isDirectory() && existsSync(resolve(sourceDirectory, "packages", entry.name, "package.json")))
	.map((entry) => readJson(resolve(sourceDirectory, "packages", entry.name, "package.json")))
	.filter((pkg) => typeof pkg.name === "string" && typeof pkg.version === "string")
	.map((pkg) => ({ name: pkg.name, version: pkg.version }))
	.sort((left, right) => left.name.localeCompare(right.name));
const lockSha256 = existsSync(lockPath) ? createHash("sha256").update(readFileSync(lockPath)).digest("hex") : null;
const sourceHash = hashSourceTree(sourceDirectory);

const manifest = {
	formatVersion: 1,
	createdAt: new Date().toISOString(),
	generatedBy: { node: process.version },
	source: {
		pathFromWorkspace: relative(workspaceRoot, sourceDirectory).split(sep).join("/"),
		gitMetadata: "unavailable",
		repository: codingAgent.repository?.url ?? null,
		rootPackage: { name: rootPackage.name, version: rootPackage.version },
		adapterPackage: { name: codingAgent.name, version: codingAgent.version },
		nodeEngine: codingAgent.engines?.node ?? null,
		packageCount: packageDirectories.length,
		packages: packageDirectories,
		packageLockSha256: lockSha256,
		treeHash: {
			algorithm: "sha256(path + NUL + file bytes + NUL for each relative path in sorted order)",
			...sourceHash,
		},
	},
};

mkdirSync(dirname(outputFile), { recursive: true });
writeFileSync(outputFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`${outputFile}\n${JSON.stringify(manifest.source.treeHash)}\n`);
