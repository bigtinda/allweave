import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { prepareMeetingAttachments } from "../src/meeting-attachments.mjs";
const stateFor = (artifact) => ({ artifacts: [artifact], settings: { excludedPaths: ["private"] } });
test("attachments reject missing, protected and oversized project references", async () => {
 const artifact = { id: "file", name: "brief.txt", content: "会议附件内容", relativePath: "docs/brief.txt" };
 assert.equal((await prepareMeetingAttachments(stateFor(artifact), ["file"]))[0].text.includes(artifact.content), true);
 await assert.rejects(prepareMeetingAttachments(stateFor(artifact), ["foreign"]), /不属于/);
 await assert.rejects(prepareMeetingAttachments(stateFor({ ...artifact, relativePath: "private/brief.txt" }), ["file"]), /受保护/);
 await assert.rejects(prepareMeetingAttachments(stateFor({ ...artifact, content: "x".repeat(1024 * 1024 + 1) }), ["file"]), /1 MB/);
});
test("Word Excel and PowerPoint attachments extract local OpenXML text", async () => {
 const python = process.platform === "win32" ? "python" : "python3";
 for (const [extension, path, xml] of [
   ["docx", "word/document.xml", '<document xmlns="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><p><t>Word attachment</t></p></document>'],
   ["xlsx", "xl/worksheets/sheet1.xml", '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row><c t="inlineStr"><is><t>Excel attachment</t></is></c></row></sheetData></worksheet>'],
   ["pptx", "ppt/slides/slide1.xml", '<slide xmlns="http://schemas.openxmlformats.org/drawingml/2006/main"><p><t>PowerPoint attachment</t></p></slide>']
 ]) {
  const content = execFileSync(python, ["-c", "import io,zipfile,base64,sys; b=io.BytesIO(); z=zipfile.ZipFile(b,'w'); z.writestr(sys.argv[1],sys.argv[2]); z.close(); print(base64.b64encode(b.getvalue()).decode())", path, xml], { encoding: "utf8", windowsHide: true }).trim();
  const result = await prepareMeetingAttachments(stateFor({ id: "file", name: `brief.${extension}`, content, contentEncoding: "base64" }), ["file"], { executable: python, prefix: [] });
  assert.match(result[0].text, /attachment/);
  assert.equal(result[0].sha256.length, 64);
 }
});
