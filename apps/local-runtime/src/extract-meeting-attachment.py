"""Read uploaded OpenXML bytes without executing macros or extracting files."""
import base64
import io
import json
import re
import sys
import zipfile
from xml.etree import ElementTree as ET


def xml(archive, name):
    data = archive.read(name)
    if b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
        raise ValueError("不支持含外部实体的文档")
    return ET.fromstring(data)


def extract(request):
    raw = base64.b64decode(request["content"], validate=True)
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        entries = archive.infolist()
        if len(entries) > 2000 or sum(item.file_size for item in entries) > 20 * 1024 * 1024:
            raise ValueError("文档解压大小超出限制")
        lines = []
        extension = request["extension"]
        if extension == "docx":
            root = xml(archive, "word/document.xml")
            for paragraph in root.iter():
                if paragraph.tag.endswith("}p"):
                    lines.append("".join(node.text or "" for node in paragraph.iter() if node.tag.endswith("}t")))
        elif extension == "pptx":
            names = sorted((name for name in archive.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)), key=lambda name: int(re.search(r"slide(\d+)", name).group(1)))
            for index, name in enumerate(names, 1):
                lines.append(f"幻灯片 {index}")
                lines.extend(node.text or "" for node in xml(archive, name).iter() if node.tag.endswith("}t"))
        elif extension == "xlsx":
            shared = []
            if "xl/sharedStrings.xml" in archive.namelist():
                shared = ["".join(node.text or "" for node in item.iter() if node.tag.endswith("}t")) for item in xml(archive, "xl/sharedStrings.xml")]
            for name in sorted(name for name in archive.namelist() if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", name)):
                lines.append(name)
                for row in xml(archive, name).iter():
                    if not row.tag.endswith("}row"):
                        continue
                    cells = []
                    for cell in row:
                        values = [node.text or "" for node in cell.iter() if node.tag.endswith("}v") or node.tag.endswith("}t")]
                        value = "".join(values)
                        if cell.get("t") == "s" and value:
                            value = shared[int(value)]
                        cells.append(f"{cell.get('r', '')}: {value}")
                    lines.append(" | ".join(cells))
        else:
            raise ValueError("不支持此文档格式")
        return "\n".join(lines)[:12000]


if __name__ == "__main__":
    try:
        print(json.dumps({"text": extract(json.load(sys.stdin))}, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        sys.exit(1)
