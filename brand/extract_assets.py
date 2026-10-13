"""
AllWeave 品牌图片裁剪

从 `品牌主题/` 的原始 PNG 中裁出标识、字标与变体，合成 README 素材，
并用 256 色调色板压缩（品牌图只有蓝白灰，视觉无损但体积降约 90%）。

裁剪框由 analyze_source.py 的内容投影测得，非手工试错。
"""

from pathlib import Path

from PIL import Image, ImageDraw
import numpy as np

SRC = Path(r"D:\project\keTeam\品牌主题\万象成序品牌标识系统.png")
OUT = Path(__file__).resolve().parent / "assets"

# —— 实测内容框（见 analyze_source.py 输出）——
BOX_LOGO = (465, 95, 894, 288)      # 蓝色编织 ∞ 标识
BOX_WORDMARK = (470, 296, 888, 368)  # ALLWEAVE
BOX_CN = (550, 374, 808, 432)       # 万 象 成 序
BOX_TAGLINE = (458, 456, 930, 522)  # 两行标语
BOX_WRITE = (145, 620, 412, 1042)
BOX_BUILD = (586, 620, 866, 1042)
BOX_TEAM = (1042, 620, 1316, 1042)
BOX_TILE = (1078, 80, 1266, 305)    # 右侧圆角应用图标

BRAND = (0, 47, 167)
INK = (17, 17, 17)
MUTED = (107, 114, 128)
CANVAS = (247, 248, 250)
BORDER = (229, 231, 235)


def crop(src: Image.Image, box) -> Image.Image:
    return src.crop(box)


def sample_bg(src: Image.Image):
    """采样原图背景色（四角与边缘中位色），用于无缝合成与抠底。"""
    w, h = src.size
    edges = np.concatenate([
        np.asarray(src.crop((0, 0, w, 6)), dtype=np.int16).reshape(-1, 3),
        np.asarray(src.crop((0, h - 6, w, h)), dtype=np.int16).reshape(-1, 3),
        np.asarray(src.crop((0, 0, 6, h)), dtype=np.int16).reshape(-1, 3),
        np.asarray(src.crop((w - 6, 0, w, h)), dtype=np.int16).reshape(-1, 3),
    ])
    bg = tuple(int(v) for v in np.median(edges, axis=0))
    return bg


def knock_out(img: Image.Image, bg, tol: int = 16) -> Image.Image:
    """把接近背景色的像素转为透明，使素材可置于任意底色。"""
    arr = np.asarray(img.convert("RGB"), dtype=np.int16)
    dist = np.abs(arr - np.asarray(bg, dtype=np.int16)).sum(axis=2)
    alpha = np.where(dist <= tol, 0, 255).astype(np.uint8)
    out = img.convert("RGBA")
    out.putalpha(Image.fromarray(alpha, mode="L"))
    return out


def compose_banner(src: Image.Image, bg) -> Image.Image:
    """横向排布：标识 | 字标，下方标语，用于 README 顶部。"""
    logo = knock_out(crop(src, BOX_LOGO), bg)
    word = knock_out(crop(src, BOX_WORDMARK), bg)
    cn = knock_out(crop(src, BOX_CN), bg)
    tag = knock_out(crop(src, BOX_TAGLINE), bg)

    pad = 34
    gap = 44
    left_w = logo.width
    text_w = max(word.width, cn.width)
    text_h = word.height + 18 + cn.height

    inner_w = left_w + gap + text_w
    body_h = max(logo.height, text_h)
    W = inner_w + pad * 2
    H = pad + body_h + 20 + tag.height + pad

    canvas = Image.new("RGBA", (W, H), bg + (255,))
    d = ImageDraw.Draw(canvas)
    d.rectangle([0, 0, W - 1, H - 1], outline=BORDER + (255,), width=1)

    ly = pad + (body_h - logo.height) // 2
    canvas.paste(logo, (pad, ly), logo)

    tx = pad + left_w + gap
    ty = pad + (body_h - text_h) // 2
    canvas.paste(word, (tx, ty), word)
    canvas.paste(cn, (tx + (text_w - cn.width) // 2, ty + word.height + 18), cn)

    canvas.paste(tag, ((W - tag.width) // 2, pad + body_h + 20), tag)
    return canvas


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    src = Image.open(SRC).convert("RGB")
    bg = sample_bg(src)
    print(f"  sampled background: #{bg[0]:02x}{bg[1]:02x}{bg[2]:02x}")

    # 透明底的独立素材（app-tile 保留自身卡片底色）
    transparent = {
        "logo-mark.png": BOX_LOGO,
        "wordmark.png": BOX_WORDMARK,
        "identity-write.png": BOX_WRITE,
        "identity-build.png": BOX_BUILD,
        "identity-team.png": BOX_TEAM,
    }

    banner = compose_banner(src, bg)
    save(banner, OUT / "banner.png")
    print(f"  banner.png            {banner.width}x{banner.height}")

    for name, box in transparent.items():
        img = knock_out(crop(src, box), bg)
        save(img, OUT / name)
        print(f"  {name:<22} {img.width}x{img.height} (transparent)")

    tile = crop(src, BOX_TILE)
    save(tile, OUT / "app-tile.png")
    print(f"  app-tile.png          {tile.width}x{tile.height}")

    # 三变体合并图
    tiles = [knock_out(crop(src, b), bg) for b in (BOX_WRITE, BOX_BUILD, BOX_TEAM)]
    tw = max(t.width for t in tiles)
    th = max(t.height for t in tiles)
    strip = Image.new("RGBA", (tw * 3 + 2 * 24, th), (0, 0, 0, 0))
    for i, t in enumerate(tiles):
        strip.paste(t, (i * (tw + 24), 0), t)
    save(strip, OUT / "identity-variants.png")
    print(f"  identity-variants.png {strip.width}x{strip.height} (transparent)")


def save(img: Image.Image, path: Path):
    """调色板量化：蓝白灰素材在 256 色下视觉无损，体积大幅下降。"""
    if img.mode == "RGBA":
        q = img.quantize(colors=255, method=Image.FASTOCTREE, dither=Image.NONE)
    else:
        q = img.quantize(colors=256, method=Image.MEDIANCUT, dither=Image.NONE)
    q.save(path, "PNG", optimize=True, transparency=0 if img.mode == "RGBA" else None)


if __name__ == "__main__":
    main()
