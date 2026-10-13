import { extname } from "node:path";

export const officeFileExtensions = new Set([".docx", ".xlsx", ".pptx"]);
export const taskOutputTotalBytesLimit = 5 * 1024 * 1024;

export function taskFileBytesLimit(path) {
	return officeFileExtensions.has(extname(path).toLowerCase()) ? taskOutputTotalBytesLimit : 1024 * 1024;
}

export function taskFileContentBytes(path, content, encoding) {
	if (typeof content !== "string") throw new Error("任务文件内容无效");
	const isOfficeFile = officeFileExtensions.has(extname(path).toLowerCase());
	if (encoding === "base64") {
		if (!isOfficeFile) throw new Error("只有 Word、Excel 和 PowerPoint 文件可以使用 Base64 编码");
		const bytes = Buffer.from(content, "base64");
		if (bytes.toString("base64") !== content) throw new Error("Office 文件编码无效");
		return bytes;
	}
	if (encoding !== undefined) throw new Error("任务文件编码无效");
	if (isOfficeFile) throw new Error("Office 文件必须使用 Base64 编码");
	return Buffer.from(content, "utf8");
}
