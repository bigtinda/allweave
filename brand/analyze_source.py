"""
品牌图内容边界分析

从原始 PNG 中检测非背景像素区域，定位 logo / 字标 / 标语等内容块，
输出可复用的裁剪框，避免手工试错。
"""

from PIL import Image
import numpy as np
from pathlib import Path

SRC = Path(r"D:\project\keTeam\品牌主题")


def content_mask(img: Image.Image, threshold: int = 735) -> np.ndarray:
    arr = np.asarray(img.convert("RGB"), dtype=np.int16)
    return arr.sum(axis=2) < threshold


def runs(flags: np.ndarray, min_len: int = 3):
    out = []
    start = None
    for i, v in enumerate(flags):
        if v and start is None:
            start = i
        elif not v and start is not None:
            if i - start >= min_len:
                out.append((start, i - 1))
            start = None
    if start is not None and len(flags) - start >= min_len:
        out.append((start, len(flags) - 1))
    return out


def profile(mask: np.ndarray, label: str, gap: int = 6):
    """在给定区域内输出行/列内容带，带间至少间隔 gap 像素才拆分。"""
    ys, xs = np.where(mask)
    if len(xs) == 0:
        print(f"  {label}: empty")
        return
    x0, x1 = int(xs.min()), int(xs.max())
    y0, y1 = int(ys.min()), int(ys.max())
    sub = mask[y0 : y1 + 1, x0 : x1 + 1]

    def merge(rs, g):
        merged = []
        for r in rs:
            if merged and r[0] - merged[-1][1] <= g:
                merged[-1] = (merged[-1][0], r[1])
            else:
                merged.append(r)
        return merged

    rows = merge(runs(sub.any(axis=1), 2), gap)
    cols = merge(runs(sub.any(axis=0), 2), gap)

    print(f"  {label}  origin=({x0},{y0})")
    for i, (a, b) in enumerate(rows):
        seg = sub[a : b + 1]
        c = np.where(seg.any(axis=0))[0]
        print(
            f"    row[{i}] y {y0 + a:>4}..{y0 + b:<4} (h={b - a + 1:>3})  "
            f"x {x0 + c.min():>4}..{x0 + c.max():<4} (w={c.max() - c.min() + 1:>4})"
        )
    for i, (a, b) in enumerate(cols):
        seg = sub[:, a : b + 1]
        r = np.where(seg.any(axis=1))[0]
        print(
            f"    col[{i}] x {x0 + a:>4}..{x0 + b:<4} (w={b - a + 1:>4})  "
            f"y {y0 + r.min():>4}..{y0 + r.max():<4} (h={r.max() - r.min() + 1:>4})"
        )


def main():
    p = SRC / "万象成序品牌标识系统.png"
    img = Image.open(p)
    mask = content_mask(img)
    print(f"=== {p.name} {img.size[0]}x{img.size[1]} ===")
    profile(mask[101:452, :], "BAND0 upper (logo+wordmark)")
    print()
    profile(mask[614:1032, :], "BAND3 lower (Write/Build/Team)")


if __name__ == "__main__":
    main()
