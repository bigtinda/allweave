import { useEffect, useState, type ElementType, type ReactNode } from "react";
import type { Artifact } from "../client/types";

const officeExtensions = new Set(["docx", "xlsx", "pptx"]);

export const isOfficeArtifact = (artifact: Artifact): boolean => officeExtensions.has(artifact.name.split(".").pop()?.toLowerCase() ?? "");

const decodeBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

export const decodeBase64FileContent = (value: string): Uint8Array => decodeBase64(value);

interface ZipEntry {
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

const readZipDirectory = (bytes: Uint8Array): Map<string, ZipEntry> => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimumOffset = Math.max(0, bytes.byteLength - 65_557);
  let endOffset = -1;
  for (let offset = bytes.byteLength - 22; offset >= minimumOffset; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) { endOffset = offset; break; }
  }
  if (endOffset < 0) throw new Error("文件不是有效的 Office 文档压缩包");
  const entryCount = view.getUint16(endOffset + 10, true);
  if (entryCount > 10_000) throw new Error("Office 文档包含过多条目，无法预览");
  let offset = view.getUint32(endOffset + 16, true);
  const decoder = new TextDecoder();
  const entries = new Map<string, ZipEntry>();
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== 0x02014b50) throw new Error("Office 文档目录格式无效");
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const nameStart = offset + 46;
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
    entries.set(name, {
      method: view.getUint16(offset + 10, true),
      compressedSize: view.getUint32(offset + 20, true),
      size: view.getUint32(offset + 24, true),
      localOffset: view.getUint32(offset + 42, true),
    });
    offset = nameStart + nameLength + extraLength + commentLength;
  }
  return entries;
};

const readZipText = async (bytes: Uint8Array, entries: Map<string, ZipEntry>, path: string): Promise<string | null> => {
  const entry = entries.get(path);
  if (!entry) return null;
  if (entry.size > 8 * 1024 * 1024) throw new Error("文件内容过大，无法安全预览");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const local = entry.localOffset;
  if (local + 30 > bytes.byteLength || view.getUint32(local, true) !== 0x04034b50) throw new Error("Office 文档内容格式无效");
  const nameLength = view.getUint16(local + 26, true);
  const extraLength = view.getUint16(local + 28, true);
  const dataStart = local + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > bytes.byteLength) throw new Error("Office 文档内容不完整");
  const compressed = bytes.slice(dataStart, dataEnd);
  let decoded: Uint8Array;
  if (entry.method === 0) decoded = compressed;
  else if (entry.method === 8) {
    const stream = new Blob([compressed.buffer as ArrayBuffer]).stream().pipeThrough(new DecompressionStream("deflate-raw" as CompressionFormat));
    decoded = new Uint8Array(await new Response(stream).arrayBuffer());
  } else throw new Error("此 Office 文档使用了暂不支持的压缩方式");
  if (decoded.byteLength !== entry.size) throw new Error("Office 文档内容校验失败");
  return new TextDecoder().decode(decoded);
};

const parseXml = (content: string): Document => {
  const xml = new DOMParser().parseFromString(content, "application/xml");
  if (xml.querySelector("parsererror")) throw new Error("Office 文档中的 XML 内容无法解析");
  return xml;
};

type OfficeContent =
  | { kind: "word"; paragraphs: string[] }
  | { kind: "excel"; sheets: Array<{ name: string; rows: string[][] }> }
  | { kind: "slides"; slides: string[][] };

const resolveZipTarget = (directory: string, target: string): string => {
  const parts = (target.startsWith("/") ? target.slice(1) : `${directory}/${target}`).split("/");
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") normalized.pop();
    else normalized.push(part);
  }
  return normalized.join("/");
};

const extractOfficeContent = async (artifact: Artifact): Promise<OfficeContent> => {
  if (artifact.contentEncoding !== "base64") throw new Error("该文件没有可预览的 Office 内容，请重新上传 .docx、.xlsx 或 .pptx 文件");
  const bytes = decodeBase64(artifact.content);
  const entries = readZipDirectory(bytes);
  const extension = artifact.name.split(".").pop()?.toLowerCase();
  if (extension === "docx") {
    const content = await readZipText(bytes, entries, "word/document.xml");
    if (!content) throw new Error("Word 文档缺少正文内容");
    const xml = parseXml(content);
    const ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    const paragraphs = Array.from(xml.getElementsByTagNameNS(ns, "p")).map((paragraph) =>
      Array.from(paragraph.getElementsByTagNameNS(ns, "t")).map((text) => text.textContent ?? "").join(""),
    ).filter(Boolean);
    return { kind: "word", paragraphs };
  }
  if (extension === "xlsx") {
    const sharedText = await readZipText(bytes, entries, "xl/sharedStrings.xml");
    const sharedStrings = sharedText ? Array.from(parseXml(sharedText).getElementsByTagNameNS("http://schemas.openxmlformats.org/spreadsheetml/2006/main", "si")).map((item) =>
      Array.from(item.getElementsByTagNameNS("http://schemas.openxmlformats.org/spreadsheetml/2006/main", "t")).map((text) => text.textContent ?? "").join(""),
    ) : [];
    const workbookText = await readZipText(bytes, entries, "xl/workbook.xml");
    const relationsText = await readZipText(bytes, entries, "xl/_rels/workbook.xml.rels");
    const mainNs = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
    const relNs = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    const relationshipNs = "http://schemas.openxmlformats.org/package/2006/relationships";
    const relations = relationsText ? parseXml(relationsText) : null;
    const targets = new Map<string, string>();
    if (relations) Array.from(relations.getElementsByTagNameNS(relationshipNs, "Relationship")).forEach((item) => {
      const id = item.getAttribute("Id");
      const target = item.getAttribute("Target");
      if (id && target) targets.set(id, resolveZipTarget("xl", target));
    });
    const workbook = workbookText ? parseXml(workbookText) : null;
    const workbookSheets = workbook ? Array.from(workbook.getElementsByTagNameNS(mainNs, "sheet")).map((sheet) => ({
      name: sheet.getAttribute("name") || "工作表",
      path: targets.get(sheet.getAttributeNS(relNs, "id") ?? "") ?? "",
    })).filter((sheet) => sheet.path && entries.has(sheet.path)) : [];
    const sheetRefs = workbookSheets.length ? workbookSheets : [...entries.keys()]
      .filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/.test(path))
      .sort((left, right) => Number(/sheet(\d+)/.exec(left)?.[1]) - Number(/sheet(\d+)/.exec(right)?.[1]))
      .map((path, index) => ({ name: `工作表 ${index + 1}`, path }));
    if (!sheetRefs.length) throw new Error("Excel 文档中没有工作表");
    const sheets: Array<{ name: string; rows: string[][] }> = [];
    for (const sheet of sheetRefs.slice(0, 8)) {
      const sheetContent = await readZipText(bytes, entries, sheet.path);
      if (!sheetContent) { sheets.push({ name: sheet.name, rows: [] }); continue; }
      const xml = parseXml(sheetContent);
      const rows = Array.from(xml.getElementsByTagNameNS(mainNs, "row")).slice(0, 300).map((row) =>
        Array.from(row.getElementsByTagNameNS(mainNs, "c")).slice(0, 40).map((cell) => {
          const type = cell.getAttribute("t");
          const value = cell.getElementsByTagNameNS(mainNs, "v")[0]?.textContent ?? "";
          if (type === "s") return sharedStrings[Number(value)] ?? "";
          if (type === "inlineStr") return Array.from(cell.getElementsByTagNameNS(mainNs, "t")).map((text) => text.textContent ?? "").join("");
          return value;
        }),
      );
      sheets.push({ name: sheet.name, rows });
    }
    return { kind: "excel", sheets };
  }
  if (extension === "pptx") {
    const presentationText = await readZipText(bytes, entries, "ppt/presentation.xml");
    const relationsText = await readZipText(bytes, entries, "ppt/_rels/presentation.xml.rels");
    const presentationNs = "http://schemas.openxmlformats.org/presentationml/2006/main";
    const relationshipNs = "http://schemas.openxmlformats.org/package/2006/relationships";
    const relNs = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    const relations = relationsText ? parseXml(relationsText) : null;
    const targets = new Map<string, string>();
    if (relations) Array.from(relations.getElementsByTagNameNS(relationshipNs, "Relationship")).forEach((item) => {
      const id = item.getAttribute("Id");
      const target = item.getAttribute("Target");
      if (id && target) targets.set(id, resolveZipTarget("ppt", target));
    });
    const presentation = presentationText ? parseXml(presentationText) : null;
    const orderedPaths = presentation ? Array.from(presentation.getElementsByTagNameNS(presentationNs, "sldId")).map((slide) => targets.get(slide.getAttributeNS(relNs, "id") ?? "") ?? "").filter((path) => path && entries.has(path)) : [];
    const slidePaths = orderedPaths.length ? orderedPaths : [...entries.keys()].filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path)).sort((left, right) => Number(/slide(\d+)/.exec(left)?.[1]) - Number(/slide(\d+)/.exec(right)?.[1]));
    if (!slidePaths.length) throw new Error("PowerPoint 文档中没有幻灯片");
    const slides: string[][] = [];
    for (const path of slidePaths.slice(0, 100)) {
      const content = await readZipText(bytes, entries, path);
      if (!content) { slides.push([]); continue; }
      const xml = parseXml(content);
      const ns = "http://schemas.openxmlformats.org/drawingml/2006/main";
      slides.push(Array.from(xml.getElementsByTagNameNS(ns, "p")).map((paragraph) =>
        Array.from(paragraph.getElementsByTagNameNS(ns, "t")).map((text) => text.textContent ?? "").join(""),
      ).filter(Boolean));
    }
    return { kind: "slides", slides };
  }
  throw new Error("暂时仅支持预览 .docx、.xlsx 和 .pptx 格式");
};

const safeLink = (href: string): boolean => /^(https?:\/\/|mailto:|\/|#)/i.test(href);

function InlineMarkdown({ text }: { text: string }) {
  const tokenPattern = /(\*\*.+?\*\*|__.+?__|~~.+?~~|`[^`]+`|\*[^*]+\*|_[^_]+_|\[[^\]]+\]\([^)]+\))/g;
  return <>{text.split(tokenPattern).filter(Boolean).map((token, index): ReactNode => {
    if (token.startsWith("**") || token.startsWith("__")) return <strong key={index}>{token.slice(2, -2)}</strong>;
    if (token.startsWith("~~")) return <del key={index}>{token.slice(2, -2)}</del>;
    if (token.startsWith("`")) return <code key={index}>{token.slice(1, -1)}</code>;
    if (token.startsWith("*") || token.startsWith("_")) return <em key={index}>{token.slice(1, -1)}</em>;
    if (token.startsWith("[")) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (link && safeLink(link[2]!)) return <a key={index} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>;
    }
    return <span key={index}>{token}</span>;
  })}</>;
}

const isBlockStart = (line: string): boolean => /^(#{1,6}\s|```|>\s?|[-*_]{3,}\s*$|\s*[-*+]\s+|\s*\d+\.\s+)/.test(line);

export function MarkdownPreview({ content }: { content: string }) {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) { index += 1; continue; }
    if (line.startsWith("```")) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]!.startsWith("```")) codeLines.push(lines[index++]!);
      index += 1;
      blocks.push(<pre key={`code-${index}`}><code>{codeLines.join("\n")}</code></pre>);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const Heading = `h${level}` as ElementType;
      blocks.push(<Heading key={`heading-${index}`}><InlineMarkdown text={heading[2]!} /></Heading>);
      index += 1;
      continue;
    }
    if (/^([-*_])\1\1+\s*$/.test(line)) { blocks.push(<hr key={`rule-${index}`} />); index += 1; continue; }
    if (line.startsWith(">")) {
      const quote: string[] = [];
      while (index < lines.length && lines[index]!.startsWith(">")) quote.push(lines[index++]!.replace(/^>\s?/, ""));
      blocks.push(<blockquote key={`quote-${index}`}><p><InlineMarkdown text={quote.join(" ")} /></p></blockquote>);
      continue;
    }
    if (line.includes("|") && index + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1]!)) {
      const cells = (value: string): string[] => value.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
      const headers = cells(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index]!.includes("|")) rows.push(cells(lines[index++]!));
      blocks.push(<div className="markdown-table-wrap" key={`table-${index}`}><table><thead><tr>{headers.map((cell, cellIndex) => <th key={cellIndex}><InlineMarkdown text={cell} /></th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{headers.map((_, cellIndex) => <td key={cellIndex}><InlineMarkdown text={row[cellIndex] ?? ""} /></td>)}</tr>)}</tbody></table></div>);
      continue;
    }
    const listMatch = /^\s*([-*+]\s+|\d+\.\s+)(.*)$/.exec(line);
    if (listMatch) {
      const ordered = /^\d/.test(listMatch[1]!);
      const items: string[] = [];
      while (index < lines.length) {
        const item = /^\s*([-*+]\s+|\d+\.\s+)(.*)$/.exec(lines[index]!);
        if (!item || /^\d/.test(item[1]!) !== ordered) break;
        items.push(item[2]!);
        index += 1;
      }
      const List = ordered ? "ol" : "ul";
      blocks.push(<List key={`list-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}><InlineMarkdown text={item} /></li>)}</List>);
      continue;
    }
    const paragraph = [line];
    index += 1;
    while (index < lines.length && lines[index]!.trim() && !isBlockStart(lines[index]!)) paragraph.push(lines[index++]!);
    blocks.push(<p key={`paragraph-${index}`}><InlineMarkdown text={paragraph.join(" ")} /></p>);
  }
  return <article className="markdown-preview">{blocks}</article>;
}

function OfficePreview({ artifact }: { artifact: Artifact }) {
  const [content, setContent] = useState<OfficeContent | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    setContent(null);
    setError("");
    void extractOfficeContent(artifact).then((parsed) => { if (current) setContent(parsed); }).catch((reason: unknown) => {
      if (current) setError(reason instanceof Error ? reason.message : "Office 文档解析失败");
    });
    return () => { current = false; };
  }, [artifact.content, artifact.contentEncoding, artifact.name]);
  if (error) return <div className="document-preview-message" role="status">{error}</div>;
  if (!content) return <div className="document-preview-message" role="status">正在解析文档…</div>;
  if (content.kind === "word") return <article className="office-word-preview">{content.paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}</article>;
  if (content.kind === "excel") return <div className="office-workbook-preview">{content.sheets.map((sheet, sheetIndex) => <section className="office-worksheet" key={sheetIndex}><h3>{sheet.name}</h3><div className="office-sheet-wrap"><table className="office-sheet-preview"><tbody>{sheet.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table></div></section>)}</div>;
  return <div className="office-slides-preview">{content.slides.map((paragraphs, index) => <article className="office-slide" key={index}><h3>第 {index + 1} 张幻灯片</h3>{paragraphs.map((paragraph, paragraphIndex) => <p key={paragraphIndex}>{paragraph}</p>)}</article>)}</div>;
}

export function DocumentPreview({ artifact }: { artifact: Artifact }) {
  if (artifact.contentEncoding === "base64" || isOfficeArtifact(artifact)) return <OfficePreview artifact={artifact} />;
  if (artifact.name.toLowerCase().endsWith(".md")) return <MarkdownPreview content={artifact.content} />;
  return <pre className="plain-file-preview">{artifact.content}</pre>;
}
