"""
Rendering helpers for the Nordkap test kit.

Three kinds of paper, because a factory receives three kinds and the AI doors read them
differently:

  * `pdf_*`   — clean digital PDFs (reportlab). What a buyer, a bank or a mill emails.
  * `scan_*`  — PIL-rendered pages saved as PDF/PNG with photocopier grain. What a customs
                or government form looks like by the time it reaches the factory: a scan of
                a stamped print. Bangla lives here, because PIL shapes it (raqm) and
                reportlab does not.
  * `photo_*` — a sheet of paper photographed on a desk: skew, uneven light, a shadow.
                What the floor actually sends — a challan, an hourly sheet, a nameplate.

Everything is deterministic. `rng()` is seeded per document so regenerating the kit does
not churn the committed files.
"""

from __future__ import annotations

import math
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    HRFlowable,
    Image as RLImage,
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

# ─────────────────────────────────────────────────────────────────────────────
# fonts
# ─────────────────────────────────────────────────────────────────────────────

FONTS = Path("/usr/share/fonts/truetype")
F_SANS = FONTS / "liberation/LiberationSans-Regular.ttf"
F_SANS_B = FONTS / "liberation/LiberationSans-Bold.ttf"
F_SANS_I = FONTS / "liberation/LiberationSans-Italic.ttf"
F_SERIF = FONTS / "liberation/LiberationSerif-Regular.ttf"
F_SERIF_B = FONTS / "liberation/LiberationSerif-Bold.ttf"
F_MONO = FONTS / "liberation/LiberationMono-Regular.ttf"
F_MONO_B = FONTS / "liberation/LiberationMono-Bold.ttf"
F_BN = FONTS / "noto/NotoSansBengali-Regular.ttf"
F_BN_B = FONTS / "noto/NotoSansBengali-Bold.ttf"
F_HAND = FONTS / "msttcorefonts/comic.ttf"
F_HAND_B = FONTS / "msttcorefonts/comicbd.ttf"

_registered = False


def register_pdf_fonts() -> None:
    global _registered
    if _registered:
        return
    pdfmetrics.registerFont(TTFont("Body", str(F_SANS)))
    pdfmetrics.registerFont(TTFont("Body-B", str(F_SANS_B)))
    pdfmetrics.registerFont(TTFont("Body-I", str(F_SANS_I)))
    pdfmetrics.registerFont(TTFont("Serif", str(F_SERIF)))
    pdfmetrics.registerFont(TTFont("Serif-B", str(F_SERIF_B)))
    pdfmetrics.registerFont(TTFont("Mono", str(F_MONO)))
    pdfmetrics.registerFont(TTFont("Mono-B", str(F_MONO_B)))
    pdfmetrics.registerFontFamily("Body", normal="Body", bold="Body-B", italic="Body-I")
    _registered = True


def ttf(path: Path, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(path), size)


def rng(seed: str) -> random.Random:
    return random.Random(seed)


# ─────────────────────────────────────────────────────────────────────────────
# reportlab: clean digital paper
# ─────────────────────────────────────────────────────────────────────────────

INK = colors.HexColor("#111111")
MUTED = colors.HexColor("#555555")
RULE = colors.HexColor("#9a9a9a")
BAND = colors.HexColor("#ececec")

_ss = getSampleStyleSheet()


def styles() -> dict[str, ParagraphStyle]:
    register_pdf_fonts()
    base = dict(fontName="Body", textColor=INK, leading=11.5, fontSize=8.5)
    return {
        "p": ParagraphStyle("p", **base),
        "p_r": ParagraphStyle("p_r", alignment=TA_RIGHT, **base),
        "p_c": ParagraphStyle("p_c", alignment=TA_CENTER, **base),
        "small": ParagraphStyle(
            "small", fontName="Body", fontSize=7, leading=9, textColor=MUTED
        ),
        "small_c": ParagraphStyle(
            "small_c", fontName="Body", fontSize=7, leading=9, textColor=MUTED,
            alignment=TA_CENTER,
        ),
        "b": ParagraphStyle("b", fontName="Body-B", fontSize=8.5, leading=11.5, textColor=INK),
        "b_r": ParagraphStyle(
            "b_r", fontName="Body-B", fontSize=8.5, leading=11.5, textColor=INK,
            alignment=TA_RIGHT,
        ),
        "h1": ParagraphStyle(
            "h1", fontName="Body-B", fontSize=15, leading=18, textColor=INK, spaceAfter=2
        ),
        "h2": ParagraphStyle(
            "h2", fontName="Body-B", fontSize=10, leading=13, textColor=INK,
            spaceBefore=8, spaceAfter=3,
        ),
        "mono": ParagraphStyle("mono", fontName="Mono", fontSize=7.6, leading=10, textColor=INK),
        "mono_b": ParagraphStyle(
            "mono_b", fontName="Mono-B", fontSize=7.6, leading=10, textColor=INK
        ),
        "title": ParagraphStyle(
            "title", fontName="Body-B", fontSize=13, leading=16, textColor=INK,
            alignment=TA_CENTER, spaceAfter=1,
        ),
        "sub": ParagraphStyle(
            "sub", fontName="Body", fontSize=8, leading=10, textColor=MUTED,
            alignment=TA_CENTER,
        ),
    }


S = None


def _s() -> dict[str, ParagraphStyle]:
    global S
    if S is None:
        S = styles()
    return S


def P(text: str, style: str = "p") -> Paragraph:
    return Paragraph(text, _s()[style])


def pdf_doc(path: Path, title: str, margins: float = 15) -> SimpleDocTemplate:
    register_pdf_fonts()
    path.parent.mkdir(parents=True, exist_ok=True)
    return SimpleDocTemplate(
        str(path),
        pagesize=A4,
        leftMargin=margins * mm,
        rightMargin=margins * mm,
        topMargin=13 * mm,
        bottomMargin=14 * mm,
        title=title,
        author="FabricXAI test kit — fixture document",
        subject="TEST FIXTURE — not real business paper",
    )


def letterhead(
    name: str,
    lines: list[str],
    right: list[str] | None = None,
    rule: bool = True,
    accent: str | None = None,
) -> list:
    """A company's own paper: name, address block, and a right-hand contact column."""
    left = [P(f"<b>{name}</b>", "h1")] + [P(x, "small") for x in lines]
    cells = [[left, [P(x, "small") for x in (right or [])]]]
    tbl = Table(cells, colWidths=[112 * mm, 68 * mm])
    tbl.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("ALIGN", (1, 0), (1, 0), "RIGHT"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                ("TOPPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
            ]
        )
    )
    out = [tbl]
    if rule:
        out += [
            Spacer(1, 4),
            HRFlowable(
                width="100%",
                thickness=1.6,
                color=colors.HexColor(accent or "#1f1f1f"),
                spaceAfter=6,
            ),
        ]
    return out


def doc_title(title: str, sub: str = "") -> list:
    out = [P(title.upper(), "title")]
    if sub:
        out.append(P(sub, "sub"))
    out.append(Spacer(1, 7))
    return out


def kv_block(rows: list[tuple[str, str]], widths=(34, 56), size=8.5) -> Table:
    """Label / value pairs, the way a form prints them."""
    data = [[P(f"{k}", "small"), P(v, "b" if v else "p")] for k, v in rows]
    tbl = Table(data, colWidths=[widths[0] * mm, widths[1] * mm])
    tbl.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 3),
                ("TOPPADDING", (0, 0), (-1, -1), 1.4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 1.4),
            ]
        )
    )
    return tbl


def two_col(left: list, right: list, widths=(90, 90)) -> Table:
    tbl = Table([[left, right]], colWidths=[widths[0] * mm, widths[1] * mm])
    tbl.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
            ]
        )
    )
    return tbl


def grid(
    data: list[list],
    widths: list[float],
    header: bool = True,
    align_right: list[int] | None = None,
    font_size: float = 8,
    zebra: bool = False,
    repeat_header: bool = True,
) -> Table:
    """A ruled table — the workhorse of every commercial document."""
    tbl = Table(
        data,
        colWidths=[w * mm for w in widths],
        repeatRows=1 if (header and repeat_header) else 0,
    )
    cmds = [
        ("FONTNAME", (0, 0), (-1, -1), "Body"),
        ("FONTSIZE", (0, 0), (-1, -1), font_size),
        ("TEXTCOLOR", (0, 0), (-1, -1), INK),
        ("GRID", (0, 0), (-1, -1), 0.4, RULE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 3),
        ("RIGHTPADDING", (0, 0), (-1, -1), 3),
        ("TOPPADDING", (0, 0), (-1, -1), 2.6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2.6),
    ]
    if header:
        cmds += [
            ("FONTNAME", (0, 0), (-1, 0), "Body-B"),
            ("BACKGROUND", (0, 0), (-1, 0), BAND),
        ]
    for c in align_right or []:
        cmds.append(("ALIGN", (c, 0), (c, -1), "RIGHT"))
    if zebra:
        for r in range(1 if header else 0, len(data)):
            if r % 2 == 0:
                cmds.append(("BACKGROUND", (0, r), (-1, r), colors.HexColor("#f7f7f7")))
    tbl.setStyle(TableStyle(cmds))
    return tbl


def signature_row(labels: list[str], widths: list[float] | None = None) -> Table:
    n = len(labels)
    widths = widths or [180 / n] * n
    cells = [
        [
            P("<br/><br/><br/>_______________________<br/>" + lab, "small")
            for lab in labels
        ]
    ]
    tbl = Table(cells, colWidths=[w * mm for w in widths])
    tbl.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    return tbl


FIXTURE_NOTE = (
    "TEST FIXTURE — this document was generated for FabricXAI platform testing. "
    "Nordkap Apparel AB and every counterparty named here are invented. "
    "It is not real business paper and carries no legal meaning."
)


def fixture_footer() -> list:
    return [
        Spacer(1, 10),
        HRFlowable(width="100%", thickness=0.4, color=RULE, spaceAfter=3),
        P(FIXTURE_NOTE, "small"),
    ]


def build_pdf(path: Path, story: list, title: str, margins: float = 15) -> Path:
    doc = pdf_doc(path, title, margins)
    doc.build(story + fixture_footer())
    return path


# ─────────────────────────────────────────────────────────────────────────────
# PIL: forms, scans and photographs
# ─────────────────────────────────────────────────────────────────────────────

A4_PX = (2480, 3508)  # 300 dpi
PAPER = (252, 251, 247)


class Sheet:
    """A sheet of paper drawn in pixels, so Bangla shapes and handwriting wobbles."""

    def __init__(self, size=A4_PX, bg=PAPER, seed: str = "sheet"):
        self.img = Image.new("RGB", size, bg)
        self.d = ImageDraw.Draw(self.img)
        self.w, self.h = size
        self.r = rng(seed)
        self._cache: dict[tuple[str, int], ImageFont.FreeTypeFont] = {}

    def f(self, path: Path, size: int) -> ImageFont.FreeTypeFont:
        key = (str(path), size)
        if key not in self._cache:
            self._cache[key] = ttf(path, size)
        return self._cache[key]

    # ── text ────────────────────────────────────────────────────────────────
    def text(self, xy, s, font: Path = F_SANS, size=30, fill=(20, 20, 24), anchor="la"):
        self.d.text(xy, s, font=self.f(font, size), fill=fill, anchor=anchor)

    def bn(self, xy, s, size=30, fill=(20, 20, 24), bold=False, anchor="la"):
        """Bangla — shaped by raqm, which is why these sheets are pixels not vectors."""
        self.d.text(
            xy, s, font=self.f(F_BN_B if bold else F_BN, size), fill=fill, anchor=anchor
        )

    def hand(self, xy, s, size=34, fill=(28, 40, 96), jitter=2.0, bold=False, anchor="la"):
        """
        Ballpoint: each glyph sits a hair off the line, and the ink is blue-black.

        `anchor="lm"` centres the writing on y — worth using inside a ruled row, because
        Comic Sans carries a tall ascent and top-anchored handwriting drops out of its box.
        """
        x, y = xy
        font = self.f(F_HAND_B if bold else F_HAND, size)
        for ch in s:
            dy = self.r.uniform(-jitter, jitter)
            self.d.text((x, y + dy), ch, font=font, fill=fill, anchor=anchor)
            x += self.d.textlength(ch, font=font) + self.r.uniform(-0.6, 0.9)
        return x

    def width(self, s, font: Path = F_SANS, size=30) -> float:
        return self.d.textlength(s, font=self.f(font, size))

    # ── rules and boxes ─────────────────────────────────────────────────────
    def line(self, a, b, fill=(70, 70, 70), w=2):
        self.d.line([a, b], fill=fill, width=w)

    def box(self, xy, wh, outline=(70, 70, 70), w=2, fill=None):
        x, y = xy
        self.d.rectangle([x, y, x + wh[0], y + wh[1]], outline=outline, width=w, fill=fill)

    def hrule(self, y, x0=None, x1=None, fill=(70, 70, 70), w=2):
        self.line((x0 or 0, y), (x1 or self.w, y), fill=fill, w=w)

    def table(
        self,
        x,
        y,
        col_w: list[int],
        rows: list[list[str]],
        row_h=58,
        head=True,
        font=F_SANS,
        size=26,
        head_fill=(228, 228, 224),
        align: list[str] | None = None,
    ) -> int:
        """Returns the y after the last row."""
        align = align or ["l"] * len(col_w)
        total = sum(col_w)
        cy = y
        for i, row in enumerate(rows):
            h = row_h
            if head and i == 0:
                self.d.rectangle([x, cy, x + total, cy + h], fill=head_fill)
            cx = x
            for j, cell in enumerate(row):
                fnt = F_SANS_B if (head and i == 0) else font
                tx = cx + 10
                anch = "la"
                if align[j] == "r":
                    tx = cx + col_w[j] - 10
                    anch = "ra"
                elif align[j] == "c":
                    tx = cx + col_w[j] // 2
                    anch = "ma"
                self.text((tx, cy + (h - size) // 2 - 2), str(cell), fnt, size, anchor=anch)
                self.d.rectangle([cx, cy, cx + col_w[j], cy + h], outline=(90, 90, 90), width=2)
                cx += col_w[j]
            cy += h
        return cy

    # ── marks a real document carries ───────────────────────────────────────
    def stamp(self, xy, lines: list[str], color=(38, 78, 150), r=170, rot=-14):
        """A round rubber stamp, slightly rolled and never fully inked."""
        pad = 40
        layer = Image.new("RGBA", (r * 2 + pad * 2, r * 2 + pad * 2), (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer)
        c = (r + pad, r + pad)
        ld.ellipse([c[0] - r, c[1] - r, c[0] + r, c[1] + r], outline=color + (235,), width=9)
        ld.ellipse(
            [c[0] - r + 20, c[1] - r + 20, c[0] + r - 20, c[1] + r - 20],
            outline=color + (200,),
            width=4,
        )
        for i, ln in enumerate(lines):
            fs = 30 if i == 0 else 25
            ld.text(
                (c[0], c[1] - 34 + i * 36),
                ln,
                font=ttf(F_SANS_B, fs),
                fill=color + (235,),
                anchor="mm",
            )
        layer = layer.rotate(rot, resample=Image.BICUBIC, expand=False)
        # patchy ink
        mask = layer.split()[3]
        noise = Image.effect_noise(mask.size, 44).point(lambda v: 255 if v > 96 else 150)
        mask = Image.composite(mask, mask.point(lambda v: int(v * 0.45)), noise)
        layer.putalpha(mask)
        self.img.paste(layer, (int(xy[0]), int(xy[1])), layer)

    def sign(self, xy, seed: str, color=(24, 36, 92), scale=1.0):
        """A looping ballpoint signature — a bezier-ish scrawl, deterministic per seed."""
        r = rng(seed)
        x0, y0 = xy
        pts = []
        n = 68
        amp = r.uniform(26, 40) * scale
        for i in range(n):
            t = i / (n - 1)
            x = x0 + t * 300 * scale
            y = (
                y0
                + math.sin(t * math.pi * r.uniform(3.0, 4.4)) * amp
                - math.sin(t * math.pi * 1.0) * 26 * scale
                + r.uniform(-2, 2)
            )
            pts.append((x, y))
        self.d.line(pts, fill=color, width=max(2, int(4 * scale)), joint="curve")
        self.d.line(
            [(x0 - 10 * scale, y0 + 46 * scale), (x0 + 250 * scale, y0 + 40 * scale)],
            fill=color,
            width=max(2, int(3 * scale)),
        )

    def save_png(self, path: Path, dpi=200) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.img.save(path, dpi=(dpi, dpi))
        return path

    def save_pdf(self, path: Path, dpi=200) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.img.convert("RGB").save(path, "PDF", resolution=dpi)
        return path


def as_scan(img: Image.Image, seed: str, skew=0.35, grain=10, dark=0.97) -> Image.Image:
    """Run a page through a tired photocopier: faint skew, grain, a dirty edge."""
    r = rng(seed)
    img = img.rotate(
        r.uniform(-skew, skew), resample=Image.BICUBIC, expand=False, fillcolor=(255, 255, 255)
    )
    img = ImageEnhance.Brightness(img).enhance(dark)
    img = ImageEnhance.Contrast(img).enhance(1.12)
    noise = Image.effect_noise(img.size, grain).convert("L").filter(ImageFilter.GaussianBlur(0.4))
    img = Image.blend(img, Image.merge("RGB", (noise, noise, noise)), 0.055)
    # scanner edge shadow
    d = ImageDraw.Draw(img, "RGBA")
    for i in range(28):
        a = int(52 * (1 - i / 28))
        d.line([(i, 0), (i, img.height)], fill=(0, 0, 0, a))
    return img


def as_photo(img: Image.Image, seed: str, angle=None, wide=1.0) -> Image.Image:
    """
    A phone photo of a sheet on a desk.

    Keystone (a hand is never square to the page), a warm light gradient falling off to one
    corner, a soft shadow at the paper's edge and a little sensor noise. The AI door reads
    the file itself, so this is the input its confidence should visibly pay for.
    """
    r = rng(seed)
    angle = r.uniform(-3.2, 3.2) if angle is None else angle

    # sit the page on a desk
    pad_x, pad_y = int(img.width * 0.09), int(img.height * 0.06)
    desk = Image.new(
        "RGB", (img.width + pad_x * 2, img.height + pad_y * 2), (108, 96, 82)
    )
    dd = ImageDraw.Draw(desk)
    for y in range(0, desk.height, 3):  # faint desk grain
        v = int(10 * math.sin(y / 17.0) + r.uniform(-4, 4))
        dd.line([(0, y), (desk.width, y)], fill=(108 + v, 96 + v, 82 + v))

    # keystone the page
    page = img.convert("RGB")
    k = 0.018 * wide
    w, h = page.size
    dx = w * k * r.choice([1, -1])
    page = page.transform(
        (w, h),
        Image.QUAD,
        (0, 0, dx * 0.6, h, w - dx * 0.4, h, w, 0),
        resample=Image.BICUBIC,
        fillcolor=(255, 255, 255),
    )
    page = page.rotate(angle, resample=Image.BICUBIC, expand=True, fillcolor=(108, 96, 82))

    # drop shadow
    sh = Image.new("L", page.size, 0)
    ImageDraw.Draw(sh).rectangle([0, 0, page.width, page.height], fill=190)
    sh = sh.filter(ImageFilter.GaussianBlur(26))
    desk.paste((26, 22, 18), (pad_x + 14, pad_y + 20), sh)
    desk.paste(page, (pad_x, pad_y))

    # lamp: warm, off-centre, falling off
    lx, ly = r.uniform(0.18, 0.42), r.uniform(0.10, 0.30)
    grad = Image.new("L", (desk.width // 8, desk.height // 8))
    gd = ImageDraw.Draw(grad)
    cx, cy = grad.width * lx, grad.height * ly
    far = math.hypot(grad.width, grad.height)
    for y in range(grad.height):
        for x in range(0, grad.width, 2):
            v = 255 - int(118 * (math.hypot(x - cx, y - cy) / far))
            gd.line([(x, y), (x + 1, y)], fill=max(96, v))
    grad = grad.resize(desk.size, Image.BICUBIC)
    desk = Image.composite(
        desk, ImageEnhance.Brightness(desk).enhance(0.62), grad.point(lambda v: v)
    )
    desk = ImageEnhance.Color(desk).enhance(1.06)

    # sensor
    n = Image.effect_noise(desk.size, 13).convert("L")
    desk = Image.blend(desk, Image.merge("RGB", (n, n, n)), 0.05)
    return desk.filter(ImageFilter.GaussianBlur(0.5))


def save_photo(sheet: Sheet, path: Path, seed: str, max_w=1700, **kw) -> Path:
    img = as_photo(sheet.img, seed, **kw)
    if img.width > max_w:
        img = img.resize((max_w, int(img.height * max_w / img.width)), Image.LANCZOS)
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, quality=86)
    return path


def save_scan_pdf(sheet: Sheet, path: Path, seed: str, **kw) -> Path:
    img = as_scan(sheet.img, seed, **kw)
    img = img.resize((img.width // 2, img.height // 2), Image.LANCZOS)  # 150 dpi, like a real one
    path.parent.mkdir(parents=True, exist_ok=True)
    img.convert("RGB").save(path, "PDF", resolution=150)
    return path


# ─────────────────────────────────────────────────────────────────────────────
# companions: the text a door reads, and the truth it is graded against
# ─────────────────────────────────────────────────────────────────────────────


def write_text(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text.rstrip() + "\n", encoding="utf-8")
    return path


def write_json(path: Path, obj) -> Path:
    import json

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


def money(v: float, dp: int = 2) -> str:
    return f"{v:,.{dp}f}"


def plain(v: float, dp: int = 2) -> str:
    return f"{v:.{dp}f}"
