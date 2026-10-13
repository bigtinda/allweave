import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const extractor = fileURLToPath(new URL("./extract-meeting-attachment.py", import.meta.url));
const office = new Set(["docx", "xlsx", "pptx"]);

async function extractOffice(artifact, extension, python) {
  if (!python) throw new Error("本机 Office 文档解析运行时尚未就绪");
  return new Promise((resolve, reject) => {
    const child = spawn(python.executable, [...python.prefix, extractor], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
    let output = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error("附件解析超时")); }, 10000);
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.stdout.on("data", (data) => { output += data.toString("utf8"); if (output.length > 200000) { child.kill(); reject(new Error("附件解析输出超出限制")); } });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.on("close", () => {
      clearTimeout(timeout);
      try { const result = JSON.parse(output); if (result.error) throw new Error(result.error); resolve(result.text); }
      catch (error) { reject(new Error(`无法解析附件「${artifact.name}」：${error.message}`)); }
    });
    child.stdin.end(JSON.stringify({ extension, content: artifact.content }));
  });
}

export async function prepareMeetingAttachments(state, ids, python) {
  if (ids === undefined) return [];
  if (!Array.isArray(ids) || ids.length > 5 || ids.some((id) => typeof id !== "string")) throw new Error("每次最多提供 5 个有效附件");
  const result = [];
  for (const id of new Set(ids)) {
    const artifact = state.artifacts.find((item) => item.id === id);
    if (!artifact) throw new Error("会议附件已删除或不属于当前项目");
    const path = (artifact.relativePath || artifact.name).replaceAll("\\", "/");
    if (path.split("/").some((part) => /^\.env|secret|credential|token|private.?key/i.test(part)) || state.settings?.excludedPaths?.some((excluded) => excluded && (path === excluded || path.startsWith(`${excluded.replace(/\/$/, "")}/`)))) throw new Error("附件位于受保护或排除的路径");
    const extension = artifact.name.split(".").at(-1).toLowerCase();
    const bytes = Buffer.from(artifact.content, artifact.contentEncoding === "base64" ? "base64" : "utf8");
    if (bytes.length > 1024 * 1024) throw new Error("单个附件不能超过 1 MB");
    let content;
    if (office.has(extension)) {
      if (artifact.contentEncoding !== "base64") throw new Error("Office 附件编码无效");
      content = await extractOffice(artifact, extension, python);
    } else {
      if (artifact.contentEncoding === "base64" || bytes.includes(0)) throw new Error("仅支持文本和 .docx、.xlsx、.pptx 附件");
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
    result.push({ id, name: artifact.name, path, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length,
      text: `参考附件「${artifact.name}」\n${content.slice(0, 6000)}${content.length > 6000 ? "\n（内容较长，本次只提供前 6000 字符。）" : ""}` });
  }
  return result;
}
