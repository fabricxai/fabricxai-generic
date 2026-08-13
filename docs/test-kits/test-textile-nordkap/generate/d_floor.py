"""
The floor's own paper: a cutting sheet, a line's hourly clipboard, a machine plate.

All three are photographs, because that is how they reach the system. Nobody emails a
cutting sheet — somebody holds a phone over it at the end of the lay.
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

import _order as O
from _lib import (
    F_BN,
    F_HAND,
    F_MONO_B,
    F_SANS,
    F_SANS_B,
    Sheet,
    as_photo,
    save_photo,
    write_json,
    write_text,
)


# ─────────────────────────────────────────────────────────────────────────────
# 19 · the cutting sheet (door: cut_sheet → cut_reports)
# ─────────────────────────────────────────────────────────────────────────────


def cut_sheet(out: Path) -> None:
    sh = Sheet((2480, 1754), bg=(250, 248, 240), seed="cut-sheet")
    W, m = sh.w, 110

    sh.text((m, 70), O.FACTORY["name"], F_SANS_B, 40)
    sh.text((m, 124), "Cutting section — lay report", F_SANS, 30, fill=(70, 70, 70))
    sh.bn((m, 168), "কাটিং সেকশন — লে রিপোর্ট", size=30, fill=(70, 70, 70))
    sh.text((W - m, 70), "CUT REPORT", F_SANS_B, 46, anchor="ra")
    sh.text((W - m, 130), "Form CUT-02 · one lay per sheet", F_SANS, 24,
            fill=(90, 90, 90), anchor="ra")
    sh.hrule(226, m, W - m, w=4)

    def fld(x, y, en, bn, val, w=560, size=38, hand=True):
        sh.text((x, y), en, F_SANS, 26, fill=(85, 85, 85))
        sh.bn((x + sh.width(en + "  ", F_SANS, 26), y - 2), bn, size=25, fill=(85, 85, 85))
        if hand:
            sh.hand((x + 10, y + 66), val, size=size, anchor="lm")
        else:
            sh.text((x + 10, y + 66), val, F_SANS_B, size - 6, anchor="lm")
        sh.line((x, y + 96), (x + w, y + 96), fill=(150, 150, 150), w=2)

    y = 268
    fld(m, y, "Lay No.", "লে নং", O.LAY_NO, 520, 44)
    fld(m + 620, y, "Date", "তারিখ", O.LAY_DATE, 520)
    fld(m + 1240, y, "Order / Style", "অর্ডার", f"{O.PO_NO} / {O.STYLE}", 620, 34)
    y += 130
    fld(m, y, "Colour", "রং", O.LAY_COLOR, 520, 34)
    fld(m + 620, y, "Marker", "মার্কার", O.MARKER, 520, 36)
    fld(m + 1240, y, "Plies", "প্লাই", str(O.LAY_PLIES), 260, 44)
    fld(m + 1560, y, "Table", "টেবিল", "C-2", 300, 40)
    y += 130
    fld(m, y, "Rolls used", "রোল",
        f"{O.CUT_ROLLS[0]} – {O.CUT_ROLLS[-1]} (shade A)", 1140, 34)
    fld(m + 1240, y, "Fabric used (kg)", "কাপড়", f"{O.CUT_KG}", 620, 40)

    # size table — the heart of the sheet
    y += 150
    sh.text((m, y), "CUT QUANTITY BY SIZE", F_SANS_B, 32)
    sh.bn((m + sh.width("CUT QUANTITY BY SIZE   ", F_SANS_B, 32), y - 4),
          "সাইজ অনুযায়ী কাটা", size=30, bold=True)
    y += 56
    col_w = [300] + [280] * len(O.SIZES) + [300]
    labels = ["", *O.SIZES, "TOTAL"]
    x = m
    sh.d.rectangle([m, y, m + sum(col_w), y + 80], fill=(230, 230, 224))
    for j, lab in enumerate(labels):
        sh.d.rectangle([x, y, x + col_w[j], y + 80], outline=(80, 80, 80), width=3)
        sh.text((x + col_w[j] // 2, y + 40), lab, F_SANS_B, 34, anchor="mm")
        x += col_w[j]
    y += 80
    rows = [
        ("Marker ratio", [str(O.MARKER_RATIO[s]) for s in O.SIZES],
         str(sum(O.MARKER_RATIO.values())), False),
        ("Should cut", [f"{O.LAY_PLIES * O.MARKER_RATIO[s]}" for s in O.SIZES],
         str(O.LAY_PLIES * sum(O.MARKER_RATIO.values())), False),
        ("ACTUAL CUT", [f"{O.CUT_ACTUAL[s]}" for s in O.SIZES],
         str(sum(O.CUT_ACTUAL.values())), True),
    ]
    for label, vals, total, is_hand in rows:
        x = m
        cells = [label, *vals, total]
        for j, cell in enumerate(cells):
            sh.d.rectangle([x, y, x + col_w[j], y + 96], outline=(80, 80, 80), width=3)
            if j == 0:
                sh.text((x + 16, y + 48), cell, F_SANS_B if is_hand else F_SANS, 28, anchor="lm")
            elif is_hand:
                sh.hand((x + col_w[j] // 2 - 40, y + 48), cell, size=46, anchor="lm", bold=True)
            else:
                sh.text((x + col_w[j] // 2, y + 48), cell, F_SANS, 32, anchor="mm")
            x += col_w[j]
        y += 96

    y += 40
    sh.text((m, y), "Remarks", F_SANS, 26, fill=(85, 85, 85))
    sh.bn((m + 160, y - 2), "মন্তব্য", size=25, fill=(85, 85, 85))
    sh.hand((m + 10, y + 60), "2 M panels short - fabric fault on R-F-09, panels rejected",
            size=34, anchor="lm", fill=(150, 30, 30))
    sh.line((m, y + 92), (W - m, y + 92), fill=(150, 150, 150), w=2)

    sy = sh.h - 210
    sh.sign((m + 40, sy - 40), "cut-incharge", scale=0.75)
    sh.line((m, sy + 40), (m + 560, sy + 40), fill=(90, 90, 90), w=2)
    sh.text((m, sy + 54), "Cutting in-charge", F_SANS, 24, fill=(70, 70, 70))
    sh.line((W // 2 - 280, sy + 40), (W // 2 + 280, sy + 40), fill=(90, 90, 90), w=2)
    sh.text((W // 2 - 280, sy + 54), "Bundle section received", F_SANS, 24, fill=(70, 70, 70))
    sh.line((W - m - 560, sy + 40), (W - m, sy + 40), fill=(90, 90, 90), w=2)
    sh.text((W - m - 560, sy + 54), "QC — panel check", F_SANS, 24, fill=(70, 70, 70))
    sh.text((m, sh.h - 56), "TEST FIXTURE — FabricXAI platform testing.", F_SANS, 20,
            fill=(150, 150, 150))

    save_photo(sh, out / "19-cutting-sheet-LAY-41.jpg", "photo-cut-sheet")

    write_text(
        out / "19-cutting-sheet-LAY-41.paste.txt",
        f"""{O.FACTORY['name']}
CUTTING SECTION — LAY REPORT (Form CUT-02)

Lay No.: {O.LAY_NO}
Date: {O.LAY_DATE}
Order / Style: {O.PO_NO} / {O.STYLE}
Colour: {O.LAY_COLOR}
Marker: {O.MARKER}
Plies: {O.LAY_PLIES}
Table: C-2
Rolls used: {O.CUT_ROLLS[0]} - {O.CUT_ROLLS[-1]} (shade A)
Fabric used (kg): {O.CUT_KG}

CUT QUANTITY BY SIZE
                  {'   '.join(f'{s:>5}' for s in O.SIZES)}    TOTAL
Marker ratio      {'   '.join(f'{O.MARKER_RATIO[s]:>5}' for s in O.SIZES)}    {sum(O.MARKER_RATIO.values())}
Should cut        {'   '.join(f'{O.LAY_PLIES * O.MARKER_RATIO[s]:>5}' for s in O.SIZES)}    {O.LAY_PLIES * sum(O.MARKER_RATIO.values())}
ACTUAL CUT        {'   '.join(f'{O.CUT_ACTUAL[s]:>5}' for s in O.SIZES)}    {sum(O.CUT_ACTUAL.values())}

Remarks: 2 M panels short - fabric fault on R-F-09, panels rejected
""",
    )
    write_json(
        out / "19-cutting-sheet-LAY-41.expected.json",
        {
            "_intakeKind": "cut_sheet",
            "_door": "/cutting/report → the drop zone (fills the form; nothing is queued)",
            "layNo": O.LAY_NO,
            "color": O.LAY_COLOR,
            "plies": O.LAY_PLIES,
            "cells": [{"size": s, "cut": O.CUT_ACTUAL[s]} for s in O.SIZES],
            "_notes": [
                "THE TRAP OF THIS DOCUMENT: three numeric rows, and only the bottom one is "
                "the answer. 'Marker ratio' (1/2/3/2/1) and 'Should cut' (96/192/288/192/96) "
                "are both on the sheet, and 'Should cut' is the plausible wrong read — it "
                "differs from ACTUAL CUT in one cell only (M: 288 vs 286).",
                "The schema's own comment says it: 'What actually came off the table for this "
                "size. Never the marker's ratio.' If M comes back 288, the two rejected "
                "panels have been silently manufactured back into existence and the bundle "
                "count will not reconcile downstream.",
                "Total should be 862, not 864.",
            ],
        },
    )


# ─────────────────────────────────────────────────────────────────────────────
# 20 · the line's clipboard (door: hourly_sheet → hourly_outputs)
# ─────────────────────────────────────────────────────────────────────────────


def hourly_sheet(out: Path) -> None:
    sh = Sheet((1754, 2480), bg=(251, 250, 243), seed="hourly")   # A4 portrait
    W, m = sh.w, 90

    sh.text((W // 2, 60), O.FACTORY["name"], F_SANS_B, 38, anchor="ma")
    sh.text((W // 2, 112), "HOURLY PRODUCTION REPORT", F_SANS_B, 40, anchor="ma")
    sh.bn((W // 2, 164), "ঘণ্টাভিত্তিক উৎপাদন রিপোর্ট", size=34, anchor="ma")
    sh.hrule(216, m, W - m, w=4)

    def fld(x, y, en, bn, val, w, size=36):
        sh.text((x, y), en, F_SANS, 24, fill=(85, 85, 85))
        sh.bn((x + sh.width(en + "  ", F_SANS, 24), y - 2), bn, size=23, fill=(85, 85, 85))
        sh.hand((x + 10, y + 62), val, size=size, anchor="lm")
        sh.line((x, y + 90), (x + w, y + 90), fill=(150, 150, 150), w=2)

    y = 254
    fld(m, y, "Line", "লাইন", O.LINE, 380, 46)
    fld(m + 440, y, "Date", "তারিখ", O.HOURLY_DATE, 500)
    fld(m + 1000, y, "Shift", "শিফট", "A (08:00–18:00)", 480, 30)
    y += 122
    fld(m, y, "Style", "স্টাইল", O.STYLE, 380, 40)
    fld(m + 440, y, "Buyer / PO", "ক্রেতা", f"Nordkap / {O.PO_NO}", 500, 30)
    fld(m + 1000, y, "Operators", "অপারেটর", str(O.OPERATORS), 200, 42)
    fld(m + 1260, y, "SMV", "এসএমভি", str(O.SMV), 220, 42)
    y += 122
    fld(m, y, "Target / hour", "টার্গেট", str(O.HOURLY_TARGET), 380, 46)
    fld(m + 440, y, "Operation", "অপারেশন", "Sewing — full garment", 500, 28)
    fld(m + 1000, y, "Supervisor", "সুপারভাইজার", "Rokeya B.", 480, 34)

    # the hour grid
    y += 150
    col_w = [230, 300, 300, 640]
    heads = [("Hour", "ঘণ্টা"), ("Target", "টার্গেট"), ("Output", "উৎপাদন"), ("Remarks", "মন্তব্য")]
    x = m
    sh.d.rectangle([m, y, m + sum(col_w), y + 92], fill=(230, 230, 224))
    for j, (en, bn) in enumerate(heads):
        sh.d.rectangle([x, y, x + col_w[j], y + 92], outline=(80, 80, 80), width=3)
        sh.text((x + col_w[j] // 2, y + 26), en, F_SANS_B, 28, anchor="ma")
        sh.bn((x + col_w[j] // 2, y + 58), bn, size=24, fill=(60, 60, 60), anchor="ma")
        x += col_w[j]
    y += 92

    for hour, target, actual, remark in O.HOURS:
        x = m
        band = f"{hour}–{hour + 1}"
        for j, cell in enumerate([band, str(target), str(actual), remark]):
            sh.d.rectangle([x, y, x + col_w[j], y + 92], outline=(80, 80, 80), width=3)
            if j == 0:
                sh.text((x + col_w[j] // 2, y + 46), cell, F_SANS, 32, anchor="mm")
            elif j == 1:
                sh.text((x + col_w[j] // 2, y + 46), cell, F_SANS, 30, anchor="mm",
                        fill=(110, 110, 110))
            elif j == 2:
                sh.hand((x + col_w[j] // 2 - 46, y + 46), cell, size=48, anchor="lm", bold=True)
            elif cell:
                sh.hand((x + 16, y + 46), cell, size=28, anchor="lm", fill=(150, 30, 30))
            x += col_w[j]
        y += 92
        if hour == 12:   # the lunch band, ruled through the way a real sheet is
            x = m
            for j in range(4):
                sh.d.rectangle([x, y, x + col_w[j], y + 70], outline=(80, 80, 80), width=3)
                x += col_w[j]
            sh.text((m + sum(col_w) // 2, y + 35), "13:00 – 14:00   LUNCH", F_SANS, 30,
                    anchor="mm", fill=(120, 120, 120))
            sh.line((m + 8, y + 35), (m + sum(col_w) - 8, y + 35), fill=(160, 160, 160), w=2)
            y += 70

    # totals
    x = m
    for j, cell in enumerate(["TOTAL", "1,305", str(O.HOURLY_TOTAL), ""]):
        sh.d.rectangle([x, y, x + col_w[j], y + 100], outline=(60, 60, 60), width=4)
        if j == 2:
            sh.hand((x + col_w[j] // 2 - 70, y + 50), cell, size=54, anchor="lm", bold=True)
        elif cell:
            sh.text((x + col_w[j] // 2, y + 50), cell, F_SANS_B, 34, anchor="mm")
        x += col_w[j]
    y += 150

    eff = round(O.HOURLY_TOTAL * O.SMV * 100 / (O.OPERATORS * 9 * 60), 1)
    sh.text((m, y), "Efficiency (office use)", F_SANS, 26, fill=(85, 85, 85))
    sh.hand((m + 420, y + 6), f"{eff}%", size=42, anchor="lm", fill=(30, 90, 40))
    sh.text((m + 700, y), "= earned min / available min", F_SANS, 24, fill=(120, 120, 120))

    # ── downtime log ────────────────────────────────────────────────────────
    y += 90
    sh.text((m, y), "DOWNTIME LOG", F_SANS_B, 30)
    sh.bn((m + sh.width("DOWNTIME LOG   ", F_SANS_B, 30), y - 4), "মেশিন বন্ধ", size=28, bold=True)
    y += 52
    dw = [220, 220, 200, 830]
    x = m
    sh.d.rectangle([m, y, m + sum(dw), y + 66], fill=(230, 230, 224))
    for j, lab in enumerate(["From", "To", "Minutes", "Reason"]):
        sh.d.rectangle([x, y, x + dw[j], y + 66], outline=(80, 80, 80), width=3)
        sh.text((x + dw[j] // 2, y + 33), lab, F_SANS_B, 26, anchor="mm")
        x += dw[j]
    y += 66
    for frm, to, mins, reason in O.DOWNTIME:
        x = m
        for j, cell in enumerate([frm, to, str(mins), reason]):
            sh.d.rectangle([x, y, x + dw[j], y + 72], outline=(80, 80, 80), width=3)
            sh.hand((x + 16, y + 36), cell, size=28, anchor="lm")
            x += dw[j]
        y += 72
    x = m
    total_dt = sum(d[2] for d in O.DOWNTIME)
    for j, cell in enumerate(["", "TOTAL", f"{total_dt}", "minutes lost"]):
        sh.d.rectangle([x, y, x + dw[j], y + 72], outline=(60, 60, 60), width=4)
        if cell:
            sh.text((x + 16, y + 36), cell, F_SANS_B if j != 3 else F_SANS, 28, anchor="lm")
        x += dw[j]

    sy = sh.h - 230
    sh.sign((m + 40, sy - 40), "line-supervisor", scale=0.7)
    sh.line((m, sy + 30), (m + 500, sy + 30), fill=(90, 90, 90), w=2)
    sh.text((m, sy + 44), "Line supervisor", F_SANS, 24, fill=(70, 70, 70))
    sh.line((W - m - 500, sy + 30), (W - m, sy + 30), fill=(90, 90, 90), w=2)
    sh.text((W - m - 500, sy + 44), "Production manager", F_SANS, 24, fill=(70, 70, 70))
    sh.text((m, sh.h - 56), "TEST FIXTURE — FabricXAI platform testing.", F_SANS, 20,
            fill=(150, 150, 150))

    save_photo(sh, out / "20-hourly-sheet-L3.jpg", "photo-hourly", max_w=1500)

    write_text(
        out / "20-hourly-sheet-L3.paste.txt",
        f"""{O.FACTORY['name']}
HOURLY PRODUCTION REPORT

Line: {O.LINE}
Date: {O.HOURLY_DATE}
Shift: A (08:00-18:00)
Style: {O.STYLE}
Buyer / PO: Nordkap / {O.PO_NO}
Operators: {O.OPERATORS}
SMV: {O.SMV}
Target / hour: {O.HOURLY_TARGET}
Operation: Sewing - full garment
Supervisor: Rokeya B.

Hour     Target   Output   Remarks
"""
        + "\n".join(
            f"{h}-{h+1:<7}{t:<9}{a:<9}{r}"
            + ("\n13-14    LUNCH" if h == 12 else "")
            for h, t, a, r in O.HOURS
        )
        + f"""
TOTAL    1,305    {O.HOURLY_TOTAL}
Efficiency (office use): {eff}%

DOWNTIME LOG
From   To     Minutes  Reason
"""
        + "\n".join(f"{f:<7}{t:<7}{m:<9}{r}" for f, t, m, r in O.DOWNTIME)
        + f"""
       TOTAL  {sum(d[2] for d in O.DOWNTIME)}       minutes lost
""",
    )
    write_json(
        out / "20-hourly-sheet-L3.expected.json",
        {
            "_intakeKind": "hourly_sheet",
            "_door": "/lines/hourly → the day-catchup door",
            "lineCode": O.LINE,
            "producedOn": O.HOURLY_DATE,
            "reference": O.STYLE,
            "targetPerHour": O.HOURLY_TARGET,
            "hours": [
                {"hourSlot": h, "target": t, "actual": a, **({"remark": r} if r else {})}
                for h, t, a, r in O.HOURS
            ],
            "_notes": [
                "NINE hours, not ten. The 13:00–14:00 band is ruled through for lunch and "
                "must not become an hour with actual 0 — a zero hour drags the day's "
                "efficiency down by a tenth and the line gets a run-rate alert it did not "
                "earn.",
                "hourSlot is the 24-hour START of the band. '14–15' is 14. The afternoon "
                "hours are the ones that get read as 2 and 3.",
                "Two remarks only — hour 8 and hour 14. The rest must come back absent, not "
                "as empty strings.",
                "The TOTAL row (1,295) is a total, not an hour. If a tenth entry appears with "
                "actual 1295, the model read the footer as data.",
                "The downtime log at the bottom has times in it (09:40, 14:10, 16:35) and is "
                "NOT hours of output. Three more entries with actual 25 / 12 / 6 means the "
                "second table was swallowed into the first.",
            ],
        },
    )


# ─────────────────────────────────────────────────────────────────────────────
# 21 · the machine's nameplate (door: machine_nameplate → machines)
# ─────────────────────────────────────────────────────────────────────────────


def nameplate(out: Path) -> None:
    """A brushed-metal plate riveted to a machine head, photographed in the aisle."""
    W, H = 1500, 1000
    plate = Image.new("RGB", (W, H), (176, 178, 182))
    d = ImageDraw.Draw(plate)

    # brushed metal
    for y in range(H):
        v = int(9 * math.sin(y / 2.3) + 6 * math.sin(y / 11.0))
        d.line([(0, y), (W, y)], fill=(176 + v, 178 + v, 182 + v))
    plate = plate.filter(ImageFilter.GaussianBlur(0.6))
    d = ImageDraw.Draw(plate)

    sh = Sheet((10, 10), seed="plate")            # borrow the font cache
    ink = (28, 30, 34)
    d.rounded_rectangle([26, 26, W - 26, H - 26], radius=18, outline=(96, 98, 104), width=6)
    d.rounded_rectangle([40, 40, W - 40, H - 40], radius=12, outline=(140, 142, 148), width=2)

    def t(xy, s, size, font=F_SANS_B, fill=ink, anchor="la"):
        d.text(xy, s, font=sh.f(font, size), fill=fill, anchor=anchor)

    t((W // 2, 78), O.MACHINE["brand"].upper(), 54, anchor="ma")
    t((W // 2, 146), "INDUSTRIAL SEWING MACHINE", 28, F_SANS, (60, 62, 66), anchor="ma")
    d.line([(120, 200), (W - 120, 200)], fill=(96, 98, 104), width=4)

    rows = [
        ("MODEL", O.MACHINE["model"]),
        ("TYPE", "5-THREAD FLATLOCK / COVERSTITCH"),
        ("SERIAL No.", O.MACHINE["serial"]),
        ("MOTOR", O.MACHINE["power"]),
        ("VOLTAGE", O.MACHINE["voltage"]),
        ("MAX SPEED", O.MACHINE["speed"]),
        ("MFG. DATE", O.MACHINE["plate_date"]),
    ]
    y = 240
    for k, v in rows:
        t((150, y), k, 32, F_SANS, (74, 76, 80))
        t((560, y - 4), v, 38, F_MONO_B)
        y += 78

    t((150, H - 120), O.MACHINE["origin"], 30, F_SANS, (74, 76, 80))
    t((W - 150, H - 120), "CE", 46, F_SANS_B, (60, 62, 66), anchor="ra")
    # rivets
    for cx, cy in ((70, 70), (W - 70, 70), (70, H - 70), (W - 70, H - 70)):
        d.ellipse([cx - 17, cy - 17, cx + 17, cy + 17], fill=(148, 150, 156),
                  outline=(104, 106, 112), width=3)
        d.ellipse([cx - 7, cy - 10, cx + 5, cy + 2], fill=(198, 200, 205))

    # mount it on a machine body and photograph it
    scene = Image.new("RGB", (2100, 1500), (38, 62, 74))
    sd = ImageDraw.Draw(scene)
    for y in range(1500):                     # painted machine head, lit from the left
        v = int(30 * (1 - y / 1500))
        sd.line([(0, y), (2100, y)], fill=(38 + v, 62 + v, 74 + v))
    sd.rounded_rectangle([120, 900, 1980, 1500], radius=40, fill=(30, 52, 62))
    scene.paste(plate, (300, 250))
    sd.rounded_rectangle([294, 244, 300 + W + 6, 250 + H + 6], radius=20,
                         outline=(22, 34, 40), width=8)

    sheet = Sheet((10, 10), seed="x")
    sheet.img = scene
    save_photo(sheet, out / "21-machine-nameplate-flatlock.jpg", "photo-plate",
               max_w=1500, wide=0.4)

    write_text(
        out / "21-machine-nameplate-flatlock.paste.txt",
        f"""{O.MACHINE['brand'].upper()}
INDUSTRIAL SEWING MACHINE

MODEL       {O.MACHINE['model']}
TYPE        5-THREAD FLATLOCK / COVERSTITCH
SERIAL No.  {O.MACHINE['serial']}
MOTOR       {O.MACHINE['power']}
VOLTAGE     {O.MACHINE['voltage']}
MAX SPEED   {O.MACHINE['speed']}
MFG. DATE   {O.MACHINE['plate_date']}
{O.MACHINE['origin']}
""",
    )
    write_json(
        out / "21-machine-nameplate-flatlock.expected.json",
        {
            "_intakeKind": "machine_nameplate",
            "_door": "/maintenance → Machines → the reader door",
            "machineType": O.MACHINE["type"],
            "brand": O.MACHINE["brand"],
            "model": O.MACHINE["model"],
            "serial": O.MACHINE["serial"],
            "purchasedAt": O.MACHINE["purchased"],
            "_notes": [
                "This one has NO text path worth using — a nameplate is a photograph or it is "
                "nothing. Attach the .jpg and paste nothing. The .paste.txt is here only so "
                "the two paths can be compared on the same plate.",
                "The plate prints MFG. DATE as '03/2026'. purchasedAt is a full date, so "
                "2026-03-01 is the reasonable read; absent is also defensible. What is NOT "
                "defensible is 2026-03-26 or 0003-01-20 — a month/year read as a day.",
                "serial is 'SZ26-204417' exactly, letters and dash included. A serial "
                "transcribed as 26204417 cannot be matched against the plate later, which is "
                "the entire point of recording it.",
                "machineType is what it DOES, not what is stamped: the plate says '5-THREAD "
                "FLATLOCK / COVERSTITCH' and the field wants that in words.",
            ],
        },
    )


def build(out: Path) -> None:
    cut_sheet(out)
    hourly_sheet(out)
    nameplate(out)
