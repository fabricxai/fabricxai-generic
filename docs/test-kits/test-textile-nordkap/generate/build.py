#!/usr/bin/env python3
"""
Regenerate the Nordkap document pack.

    cd docs/test-kits/test-textile-nordkap/generate && python3 build.py

Writes into ../documents/<NN-department>/ and rebuilds ../fabricxai-test-kit-nordkap.zip.
Deterministic: same input, same bytes, so re-running does not churn the repo.

Requires reportlab, openpyxl and Pillow with raqm (the Bangla on the floor documents needs
shaping — check with `python3 -c "from PIL import features; print(features.check('raqm'))"`).
"""

from __future__ import annotations

import shutil
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import d_commercial
import d_floor
import d_merch
import d_people
import d_quality
import d_ship
import d_supply
import _order as O

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "documents"

# Which builder fills which department folder. A document lives with the desk that
# RECEIVES it, not the desk that wrote it — the buyer's PO is merchandising's paper.
LAYOUT = [
    ("01-merchandising", d_merch.build),
    ("02-commercial", d_commercial.build),
    ("03-procurement-and-store", d_supply.build),
    ("04-quality", d_quality.build),
    ("05-floor-cutting-production-maintenance", d_floor.build),
    ("06-shipment-and-finance", d_ship.build),
    ("07-hr-and-compliance", d_people.build),
]


def main() -> int:
    layout = LAYOUT

    if DOCS.exists():
        shutil.rmtree(DOCS)
    DOCS.mkdir(parents=True)

    for folder, build in layout:
        target = DOCS / folder
        target.mkdir(parents=True, exist_ok=True)
        build(target)
        n = len(list(target.iterdir()))
        print(f"  {folder:<44} {n:>3} files")

    # the two guides travel with the pack
    zip_path = ROOT / "fabricxai-test-kit-nordkap.zip"
    members: list[tuple[Path, str]] = []
    for name in ("00-TEST-KIT.md", "01-ORDER-STORY.md"):
        p = ROOT / name
        if p.exists():
            members.append((p, f"fabricxai-test-kit-nordkap/{name}"))
    for p in sorted(DOCS.rglob("*")):
        if p.is_file():
            members.append((p, f"fabricxai-test-kit-nordkap/documents/{p.relative_to(DOCS)}"))

    # fixed timestamps — a zip that differs only in mtime is noise in a diff
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for src, arc in members:
            info = zipfile.ZipInfo(arc, date_time=(2026, 8, 14, 12, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            z.writestr(info, src.read_bytes())

    total = sum(p.stat().st_size for p in DOCS.rglob("*") if p.is_file())
    print(f"\n  {len(members)} files · {total / 1024 / 1024:.1f} MB")
    print(f"  zip → {zip_path.relative_to(ROOT.parent.parent.parent)} "
          f"({zip_path.stat().st_size / 1024 / 1024:.1f} MB)")
    print(f"\n  order: {O.BUYER['name']} · {O.PO_NO} · {O.STYLE} · {O.QTY:,} pcs · "
          f"USD {O.ORDER_VALUE:,.2f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
