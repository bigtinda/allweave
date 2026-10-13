"""Local, project-scoped Office document MCP for the AI Agent Team runtime."""

from __future__ import annotations

import json
import os
import re
import tempfile
import zipfile
from pathlib import Path
from typing import Any

from docx import Document
from mcp.server.fastmcp import FastMCP
from openpyxl import Workbook, load_workbook
from pptx import Presentation
from pptx.util import Pt


OFFICE_EXTENSIONS = {".docx", ".xlsx", ".pptx"}
MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_EXPANDED_BYTES = 100 * 1024 * 1024
MAX_ARCHIVE_ENTRIES = 10_000
PROTECTED_PARTS = re.compile(r"^(?:\.git|\.env(?:\..*)?|node_modules|secrets?)$|credential|token|api.?key|private.?key", re.I)
PROJECT_ROOT = Path(os.environ.get("AI_TEAM_PROJECT_ROOT", "")).resolve(strict=True)
TASK_ROOT = Path(os.environ.get("AI_TEAM_TASK_ROOT", "")).resolve(strict=True)
READ_LOG = os.environ.get("AI_TEAM_WPS_FILE_READ_LOG", "")
mcp = FastMCP("wps-office-local")


def _segments(relative_path: str) -> list[str]:
    if not isinstance(relative_path, str) or not relative_path or "\x00" in relative_path:
        raise ValueError("请提供项目内的相对文件路径")
    normalized = relative_path.replace("\\", "/")
    if normalized.startswith("/") or re.match(r"^[A-Za-z]:", normalized):
        raise ValueError("只允许使用项目内相对路径")
    parts = normalized.split("/")
    if len(parts) > 8 or any(not part or part in {".", ".."} or len(part) > 180 for part in parts):
        raise ValueError("文件路径无效或层级过深")
    if any(PROTECTED_PARTS.search(part) for part in parts):
        raise ValueError("凭据、依赖、Git 和私钥路径受到保护")
    if any(re.search(r'[<>:"|?*\x00-\x1f]', part) or part.endswith((".", " ")) for part in parts):
        raise ValueError("文件路径包含不支持的字符")
    return parts


def _resolve(root: Path, relative_path: str, *, office_only: bool = True, must_exist: bool = True) -> Path:
    parts = _segments(relative_path)
    if office_only and Path(parts[-1]).suffix.lower() not in OFFICE_EXTENSIONS:
        raise ValueError("目前支持 .docx、.xlsx、.pptx 文件")
    candidate = root.joinpath(*parts)
    current = root
    for index, part in enumerate(parts):
        current = current / part
        if current.is_symlink():
            raise ValueError("文件路径包含符号链接，操作已拒绝")
        if index < len(parts) - 1 and current.exists() and not current.is_dir():
            raise ValueError("文件路径中的上级目录无效")
    resolved = candidate.resolve(strict=must_exist)
    try:
        resolved.relative_to(root)
    except ValueError as error:
        raise ValueError("文件路径超出了允许的目录") from error
    if must_exist and (not resolved.is_file() or resolved.stat().st_size > MAX_FILE_BYTES):
        raise ValueError("文件不存在、不是普通文件或超过 1 MB")
    return resolved


def _project_file(path: str) -> Path:
    return _resolve(PROJECT_ROOT, path)


def _project_directory(path: str) -> Path:
    parts = _segments(path) if path else []
    current = PROJECT_ROOT
    for part in parts:
        current = current / part
        if current.is_symlink():
            raise ValueError("目录路径包含符号链接，操作已拒绝")
    resolved = current.resolve(strict=True)
    try:
        resolved.relative_to(PROJECT_ROOT)
    except ValueError as error:
        raise ValueError("目录超出了项目文件夹") from error
    if not resolved.is_dir():
        raise ValueError("指定路径不是安全的项目目录")
    return resolved


def _output_file(path: str, *, must_exist: bool = False) -> Path:
    parts = _segments(path)
    if Path(parts[-1]).suffix.lower() not in OFFICE_EXTENSIONS:
        raise ValueError("目前支持 .docx、.xlsx、.pptx 文件")
    current = TASK_ROOT
    for part in parts[:-1]:
        next_directory = current / part
        is_junction = getattr(next_directory, "is_junction", lambda: False)
        if next_directory.is_symlink() or is_junction():
            raise ValueError("输出目录包含符号链接，操作已拒绝")
        try:
            next_directory.mkdir()
        except FileExistsError:
            pass
        if not next_directory.is_dir() or next_directory.is_symlink() or getattr(next_directory, "is_junction", lambda: False)():
            raise ValueError("输出目录不是安全的普通目录")
        current = next_directory.resolve(strict=True)
        try:
            current.relative_to(TASK_ROOT)
        except ValueError as error:
            raise ValueError("输出目录超出了当前任务 Run 范围") from error
    target = current / parts[-1]
    if target.is_symlink() or getattr(target, "is_junction", lambda: False)():
        raise ValueError("输出文件包含链接，操作已拒绝")
    if must_exist and (not target.is_file() or target.stat().st_size > MAX_FILE_BYTES):
        raise ValueError("文件不存在、不是普通文件或超过 1 MB")
    return target


def _record_read(path: str) -> None:
    if not READ_LOG:
        return
    log_path = Path(READ_LOG)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("a", encoding="utf-8") as log:
        log.write(json.dumps({"path": path.replace("\\", "/")}, ensure_ascii=False) + "\n")


def _text(value: Any, maximum: int = 200_000) -> str:
    result = str(value if value is not None else "")
    if len(result) > maximum:
        raise ValueError("文本内容超过 200,000 个字符")
    return result


def _atomic_save(target: Path, save_callback) -> None:
    if target.exists() or target.is_symlink():
        raise ValueError("目标文件已存在；请使用对应的编辑工具")
    with tempfile.NamedTemporaryFile(prefix=".wps-office-", suffix=target.suffix, dir=target.parent, delete=False) as temporary:
        temporary_path = Path(temporary.name)
    try:
        save_callback(str(temporary_path))
        if temporary_path.stat().st_size > MAX_FILE_BYTES:
            raise ValueError("Office 文件不能超过 1 MB")
        if target.exists() or target.is_symlink():
            raise ValueError("目标文件在写入期间已创建，操作已拒绝")
        os.replace(temporary_path, target)
    finally:
        temporary_path.unlink(missing_ok=True)


def _replace_existing(target: Path, save_callback) -> None:
    if not target.exists() or target.is_symlink() or not target.is_file():
        raise ValueError("只能编辑当前任务 Run 目录中的 Office 文件")
    with tempfile.NamedTemporaryFile(prefix=".wps-office-", suffix=target.suffix, dir=target.parent, delete=False) as temporary:
        temporary_path = Path(temporary.name)
    try:
        save_callback(str(temporary_path))
        if temporary_path.stat().st_size > MAX_FILE_BYTES:
            raise ValueError("Office 文件不能超过 1 MB")
        if target.is_symlink() or not target.is_file():
            raise ValueError("目标文件在写入期间发生变化，操作已拒绝")
        os.replace(temporary_path, target)
    finally:
        temporary_path.unlink(missing_ok=True)


def _word_paragraphs(document: Document) -> list[str]:
    lines = [paragraph.text for paragraph in document.paragraphs if paragraph.text.strip()]
    for table in document.tables:
        for row in table.rows:
            lines.append(" | ".join(cell.text.replace("\n", " / ") for cell in row.cells))
    return lines


def _validate_office_archive(path: Path) -> None:
    try:
        with zipfile.ZipFile(path) as archive:
            entries = archive.infolist()
            if len(entries) > MAX_ARCHIVE_ENTRIES or sum(entry.file_size for entry in entries) > MAX_EXPANDED_BYTES:
                raise ValueError("Office 文档展开后的内容超过安全限制")
            if any(entry.file_size > MAX_EXPANDED_BYTES for entry in entries):
                raise ValueError("Office 文档中包含过大的内容条目")
    except zipfile.BadZipFile as error:
        raise ValueError("Office 文件不是有效的 OpenXML 文档") from error


@mcp.tool()
def list_office_files(path: str = "") -> str:
    """列出项目中的 Word、Excel 和 PowerPoint 文件。path 是项目内相对目录。"""
    directory = _project_directory(path)
    results: list[str] = []
    for current, directories, filenames in os.walk(directory, followlinks=False):
        current_path = Path(current)
        try:
            relative_directory = current_path.relative_to(PROJECT_ROOT)
            if len(relative_directory.parts) >= 8:
                directories[:] = []
            else:
                directories[:] = sorted(
                    name for name in directories
                    if not PROTECTED_PARTS.search(name)
                    and not (current_path / name).is_symlink()
                    and not getattr(current_path / name, "is_junction", lambda: False)()
                )
            for name in sorted(filenames):
                item = current_path / name
                relative = item.relative_to(PROJECT_ROOT)
                if item.is_symlink() or any(PROTECTED_PARTS.search(part) for part in relative.parts):
                    continue
                if item.suffix.lower() in OFFICE_EXTENSIONS and item.stat().st_size <= MAX_FILE_BYTES:
                    results.append(relative.as_posix())
                    if len(results) >= 120:
                        break
        except (OSError, ValueError):
            continue
        if len(results) >= 120:
            break
    return "\n".join(results) if results else "没有找到可读取的 Word、Excel 或 PowerPoint 文件"


@mcp.tool()
def read_word(file_path: str) -> str:
    """读取项目中的 .docx 文本和表格；源文件保持不变。"""
    target = _project_file(file_path)
    if target.suffix.lower() != ".docx":
        raise ValueError("read_word 只支持 .docx 文件")
    _validate_office_archive(target)
    content = "\n".join(_word_paragraphs(Document(target)))
    _record_read(file_path)
    return content[:80_000] or "文档没有可提取的正文文本"


@mcp.tool()
def read_excel(file_path: str, sheet_name: str = "") -> str:
    """读取项目中的 .xlsx 工作表、公式和值；源文件保持不变。"""
    target = _project_file(file_path)
    if target.suffix.lower() != ".xlsx":
        raise ValueError("read_excel 只支持 .xlsx 文件")
    _validate_office_archive(target)
    workbook = load_workbook(target, read_only=True, data_only=False, keep_links=False)
    try:
        sheets = [workbook[sheet_name]] if sheet_name else list(workbook.worksheets)
        output: list[str] = []
        for sheet in sheets:
            output.append(f"## 工作表：{sheet.title}")
            for row in sheet.iter_rows():
                values = ["" if cell.value is None else str(cell.value).replace("\n", " ") for cell in row]
                while values and not values[-1]:
                    values.pop()
                if values:
                    output.append(" | ".join(values))
                if len(output) >= 4000:
                    output.append("（结果已截断）")
                    break
        _record_read(file_path)
        return "\n".join(output)[:80_000] or "工作簿没有可读取的数据"
    finally:
        workbook.close()


@mcp.tool()
def read_powerpoint(file_path: str, slide_number: int = 0) -> str:
    """读取项目中的 .pptx 幻灯片文本；slide_number 从 1 开始，0 表示全部。"""
    target = _project_file(file_path)
    if target.suffix.lower() != ".pptx":
        raise ValueError("read_powerpoint 只支持 .pptx 文件")
    _validate_office_archive(target)
    presentation = Presentation(target)
    slides = list(enumerate(presentation.slides, start=1))
    if slide_number:
        slides = [(number, slide) for number, slide in slides if number == slide_number]
        if not slides:
            raise ValueError("找不到指定的幻灯片")
    output: list[str] = []
    for number, slide in slides:
        output.append(f"## 幻灯片 {number}")
        for shape in slide.shapes:
            if getattr(shape, "has_text_frame", False) and shape.text.strip():
                output.append(shape.text.strip())
            if getattr(shape, "has_table", False):
                for row in shape.table.rows:
                    output.append(" | ".join(cell.text.replace("\n", " / ") for cell in row.cells))
    _record_read(file_path)
    return "\n".join(output)[:80_000] or "演示文稿没有可提取的文本"


@mcp.tool()
def copy_office_file(source_path: str, output_path: str) -> str:
    """将项目中的 Office 文件复制到当前 Run 目录，后续编辑不会改动原文件。"""
    source = _project_file(source_path)
    target = _output_file(output_path)
    if source.suffix.lower() != target.suffix.lower():
        raise ValueError("复制前后必须保留相同的 Office 文件格式")
    data = source.read_bytes()
    if target.exists() or target.is_symlink():
        raise ValueError("目标文件已存在")
    _atomic_save(target, lambda temporary_path: Path(temporary_path).write_bytes(data))
    _record_read(source_path)
    return f"已将 {source_path} 复制到当前 Run：{output_path}；源文件没有修改"


@mcp.tool()
def create_word(file_path: str, content: str, title: str = "") -> str:
    """在当前 Run 目录创建 .docx，可传入 Markdown 风格标题、列表和正文。"""
    if Path(file_path).suffix.lower() != ".docx":
        raise ValueError("输出文件名必须以 .docx 结尾")
    target = _output_file(file_path)
    text = _text(content)
    heading = _text(title, 500).strip()

    def save(path: str) -> None:
        document = Document()
        if heading:
            document.add_heading(heading, level=0)
        for line in text.splitlines():
            line = line.strip()
            if not line:
                document.add_paragraph("")
            elif line.startswith("### "):
                document.add_heading(line[4:], level=3)
            elif line.startswith("## "):
                document.add_heading(line[3:], level=2)
            elif line.startswith("# "):
                document.add_heading(line[2:], level=1)
            elif line.startswith(("- ", "* ")):
                document.add_paragraph(line[2:], style="List Bullet")
            else:
                document.add_paragraph(line)
        document.save(path)

    _atomic_save(target, save)
    return f"已在当前 Run 目录创建 Word 文档：{file_path}"


@mcp.tool()
def create_excel(file_path: str, rows_json: str, sheet_name: str = "Sheet1") -> str:
    """在当前 Run 目录创建 .xlsx；rows_json 为二维数组，例如 [[\"名称\",\"状态\"],[\"需求\",\"完成\"]]。"""
    if Path(file_path).suffix.lower() != ".xlsx":
        raise ValueError("输出文件名必须以 .xlsx 结尾")
    target = _output_file(file_path)
    rows = json.loads(_text(rows_json))
    if not isinstance(rows, list) or len(rows) > 10000 or any(not isinstance(row, list) or len(row) > 200 for row in rows):
        raise ValueError("rows_json 必须是最多 10,000 行、每行最多 200 列的二维数组")
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = _text(sheet_name, 31).strip() or "Sheet1"
    for row in rows:
        sheet.append(row)
    _atomic_save(target, workbook.save)
    return f"已在当前 Run 目录创建 Excel 工作簿：{file_path}"


@mcp.tool()
def create_powerpoint(file_path: str, slides_json: str, title: str = "") -> str:
    """在当前 Run 目录创建 .pptx；slides_json 是含 title 和 body 字段的幻灯片数组。"""
    if Path(file_path).suffix.lower() != ".pptx":
        raise ValueError("输出文件名必须以 .pptx 结尾")
    target = _output_file(file_path)
    slides = json.loads(_text(slides_json))
    if not isinstance(slides, list) or not slides or len(slides) > 100:
        raise ValueError("slides_json 必须包含 1 到 100 张幻灯片")
    presentation = Presentation()
    presentation.core_properties.title = _text(title, 500)
    for item in slides:
        if not isinstance(item, dict):
            raise ValueError("每张幻灯片需要是包含 title 和 body 的对象")
        slide = presentation.slides.add_slide(presentation.slide_layouts[1])
        slide.shapes.title.text = _text(item.get("title", ""), 500)
        body = slide.placeholders[1].text_frame
        body.clear()
        for index, line in enumerate(_text(item.get("body", ""), 20_000).splitlines()):
            paragraph = body.paragraphs[0] if index == 0 else body.add_paragraph()
            paragraph.text = line
            paragraph.font.size = Pt(20)
            paragraph.level = 0
    _atomic_save(target, presentation.save)
    return f"已在当前 Run 目录创建 PowerPoint 演示文稿：{file_path}"


@mcp.tool()
def edit_word(file_path: str, find_text: str, replace_text: str) -> str:
    """在当前 Run 目录修改 .docx 中的文本；先用 copy_office_file 复制项目文件。"""
    target = _output_file(file_path, must_exist=True)
    if target.suffix.lower() != ".docx":
        raise ValueError("edit_word 只支持当前 Run 中的 .docx 文件")
    _validate_office_archive(target)
    find_value = _text(find_text, 20_000)
    if not find_value:
        raise ValueError("find_text 不能为空")
    replace_value = _text(replace_text, 20_000)
    document = Document(target)
    changes = 0

    def replace_paragraphs(paragraphs) -> None:
        nonlocal changes
        for paragraph in paragraphs:
            if find_value in paragraph.text:
                paragraph.text = paragraph.text.replace(find_value, replace_value)
                changes += 1

    replace_paragraphs(document.paragraphs)
    for table in document.tables:
        for row in table.rows:
            for cell in row.cells:
                replace_paragraphs(cell.paragraphs)
    if not changes:
        return "没有找到待替换文本，文档没有改变"
    _replace_existing(target, document.save)
    return f"已修改当前 Run 中的 Word 文档：{file_path}（{changes} 处）"


@mcp.tool()
def edit_excel_cell(file_path: str, sheet_name: str, cell: str, value: str) -> str:
    """修改当前 Run 目录 .xlsx 的单元格；先用 copy_office_file 复制项目文件。"""
    target = _output_file(file_path, must_exist=True)
    if target.suffix.lower() != ".xlsx":
        raise ValueError("edit_excel_cell 只支持当前 Run 中的 .xlsx 文件")
    _validate_office_archive(target)
    if not re.fullmatch(r"[A-Za-z]{1,3}[1-9][0-9]{0,6}", cell):
        raise ValueError("单元格地址格式无效")
    workbook = load_workbook(target, keep_links=False)
    try:
        if sheet_name not in workbook.sheetnames:
            raise ValueError("找不到指定的工作表")
        workbook[sheet_name][cell] = _text(value, 20_000)
        _replace_existing(target, workbook.save)
    finally:
        workbook.close()
    return f"已修改当前 Run 中的 Excel 单元格：{file_path} · {sheet_name}!{cell}"


@mcp.tool()
def replace_powerpoint_text(file_path: str, find_text: str, replace_text: str) -> str:
    """替换当前 Run 目录 .pptx 的文字；先用 copy_office_file 复制项目文件。"""
    target = _output_file(file_path, must_exist=True)
    if target.suffix.lower() != ".pptx":
        raise ValueError("replace_powerpoint_text 只支持当前 Run 中的 .pptx 文件")
    _validate_office_archive(target)
    find_value = _text(find_text, 20_000)
    if not find_value:
        raise ValueError("find_text 不能为空")
    replace_value = _text(replace_text, 20_000)
    presentation = Presentation(target)
    changes = 0
    for slide in presentation.slides:
        for shape in slide.shapes:
            if getattr(shape, "has_text_frame", False):
                for paragraph in shape.text_frame.paragraphs:
                    for run in paragraph.runs:
                        if find_value in run.text:
                            run.text = run.text.replace(find_value, replace_value)
                            changes += 1
            if getattr(shape, "has_table", False):
                for row in shape.table.rows:
                    for cell in row.cells:
                        if find_value in cell.text:
                            cell.text = cell.text.replace(find_value, replace_value)
                            changes += 1
    if not changes:
        return "没有找到待替换文本，演示文稿没有改变"
    _replace_existing(target, presentation.save)
    return f"已修改当前 Run 中的 PowerPoint：{file_path}（{changes} 处）"


mcp.run(transport="stdio")
