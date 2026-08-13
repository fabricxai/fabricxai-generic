"""
The order, once, in numbers.

Every document in the kit is rendered from this module, so the tech pack's consumption, the
BTB's value, the UD's authorised quantity and the packing list's carton count cannot drift
apart the way they do when twenty documents are written by hand. If a number here is wrong
it is wrong everywhere consistently — which is testable. If it were wrong in one document
only, the tester would be chasing the kit instead of the product.

Fictitious throughout. Nordkap Apparel AB, Zhejiang Hualing, Ashulia Knit, Nordbanken and
Vertas Assurance do not exist; Karnaphuli Mercantile Bank, Dhaka Trims House, Square Yarns
and Suzuka Sewing Machine Co. are the existing kit's inventions, reused so the two kits sit
on one tenant without contradicting each other.
"""

from __future__ import annotations

# ─────────────────────────────────────────────────────────────────────────────
# the factory (the tenant under test)
# ─────────────────────────────────────────────────────────────────────────────

FACTORY = dict(
    name="Test Textile Ltd",
    addr=[
        "Plot 44–46, Sector 3, Karnaphuli EPZ Road",
        "Ashulia, Savar, Dhaka 1341, Bangladesh",
    ],
    contact=[
        "T +880 2 7788 4410   F +880 2 7788 4411",
        "merchandising@testtextile.test",
        "BIN 004471003-0201 · BGMEA Reg. 3318",
        "Bond Licence 18/Cus/Bond/2019",
    ],
    slug="test-textile",
    host="baraka.fabricxai.com",
)

# ─────────────────────────────────────────────────────────────────────────────
# the buyer — new to this tenant, on purpose
# ─────────────────────────────────────────────────────────────────────────────

BUYER = dict(
    code="NKA",
    name="Nordkap Apparel AB",
    country="SE",
    addr=[
        "Lindholmsallén 32",
        "417 55 Göteborg, Sweden",
    ],
    contact=[
        "Sourcing office: sourcing@nordkap-apparel.test",
        "T +46 31 448 22 00",
        "Org.nr 556812-3494 · VAT SE556812349401",
    ],
    person="E. Sandberg",
    person_title="Sourcing Manager, Knitwear",
    qa_person="M. Ohlsson",
    qa_title="Quality & Compliance",
    accent="#123a5c",
)

# ─────────────────────────────────────────────────────────────────────────────
# the style
# ─────────────────────────────────────────────────────────────────────────────

STYLE = "ST-2815"
STYLE_DESC = "ladies' brushed-fleece full-zip hoodie"
STYLE_LONG = (
    "Ladies' full-zip hooded sweatshirt, brushed back fleece 280 g/m², "
    "two-panel lined hood, kangaroo pocket, 1×1 rib cuff and hem"
)
SEASON = "AW-27 Core"
BUYER_ARTICLE = "NK-90455"

SIZES = ["XS", "S", "M", "L", "XL"]
COLORS = ["Charcoal Melange", "Deep Navy", "Off White"]
COLOR_CODES = {"Charcoal Melange": "CHM", "Deep Navy": "NVY", "Off White": "OFW"}

# colour × size, as the PO prints it. Deliberately NOT one ratio across all three
# colours — a real PO's grid is negotiated per colour and a kit that fakes a clean
# ratio never exercises the breakdown screen honestly.
BREAKDOWN = {
    "Charcoal Melange": {"XS": 1800, "S": 3600, "M": 5400, "L": 3600, "XL": 1800},
    "Deep Navy": {"XS": 1600, "S": 3200, "M": 4800, "L": 3200, "XL": 1600},
    "Off White": {"XS": 1200, "S": 2400, "M": 3600, "L": 2700, "XL": 1500},
}

QTY = sum(sum(c.values()) for c in BREAKDOWN.values())          # 42,000
UNIT_PRICE = 8.95
CURRENCY = "USD"
ORDER_VALUE = round(QTY * UNIT_PRICE, 2)                        # 375,900.00
PRICE_TERM = "FOB Chattogram"


def color_total(c: str) -> int:
    return sum(BREAKDOWN[c].values())


def size_total(s: str) -> int:
    return sum(BREAKDOWN[c][s] for c in COLORS)


# ─────────────────────────────────────────────────────────────────────────────
# references and dates — the order's calendar
# ─────────────────────────────────────────────────────────────────────────────

ENQ_NO = "NKA-ENQ-4471"
ENQ_DATE = "2026-08-18"
ENQ_TARGET_PRICE = 8.40
ENQ_DEADLINE = "2026-08-27"

PO_NO = "NKA-PO-70318"
PO_DATE = "2026-09-02"
EX_FACTORY = "2027-01-28"
DELIVERY_TERM_DAYS = 120

AMD_NO = "AMD-01"
AMD_DATE = "2026-12-20"
AMD_EX_FACTORY = "2027-02-14"          # past LC 44C — the armed conflict

TECHPACK_REV = "Rev 2"
TECHPACK_DATE = "2026-09-05"

# money rails
LC_NO = "LC-7712"
LC_ISSUE = "2026-09-15"
LC_LATEST_SHIPMENT = "2027-02-10"      # 44C
LC_EXPIRY = "2027-02-25"               # 31D
LC_TOLERANCE = 5
LC_ISSUING_BANK = "Nordbanken Kommers AB"
LC_ISSUING_SWIFT = "NDKMSESS"
LC_ADVISING_BANK = "Karnaphuli Mercantile Bank Ltd"
LC_ADVISING_SWIFT = "KRMLBDDH"
LC_ADVISING_BRANCH = "Gulshan Corporate Branch, Dhaka"

BTB_CEILING_PCT = 70
BTB_CEILING = round(ORDER_VALUE * BTB_CEILING_PCT / 100, 2)     # 263,130.00

UD_NO = "UD-2026-058"
UD_ISSUE = "2026-09-28"
UD_VALID = "2027-03-31"

# ─────────────────────────────────────────────────────────────────────────────
# consumption — every material quantity in the kit derives from these
# ─────────────────────────────────────────────────────────────────────────────

CONS_FLEECE = 0.560     # kg/pc net
CONS_RIB = 0.045        # kg/pc net
WASTAGE_FABRIC = 8.0    # %
WASTAGE_TRIM = 2.0
WASTAGE_CORD = 3.0


def _round_to(v: float, step: int) -> int:
    return int(round(v / step) * step)


FLEECE_KG = _round_to(QTY * CONS_FLEECE * (1 + WASTAGE_FABRIC / 100), 100)   # 25,400
RIB_KG = _round_to(QTY * CONS_RIB * (1 + WASTAGE_FABRIC / 100), 50)          # 2,050
ZIP_PCS = int(QTY * (1 + WASTAGE_TRIM / 100))                                # 42,840
CORD_PCS = int(QTY * (1 + WASTAGE_CORD / 100))                               # 43,260
EYELET_PCS = int(QTY * 2 * (1 + WASTAGE_CORD / 100))                         # 86,520
LABEL_PCS = ZIP_PCS
PCS_PER_CARTON = 24
CARTONS_TOTAL = QTY // PCS_PER_CARTON                                        # 1,750

# BOM as the tech pack prints it — consumption is PER PIECE, which is what the
# costing door's schema means by `consumption`.
BOM = [
    dict(group="fabric", ref="FAB-FLC-280",
         spec="brushed back fleece 280 g/m², 80% cotton / 20% polyester, tubular 185 cm, self shade",
         cons="0.560", uom="kg", waste="8.00", page=4),
    dict(group="fabric", ref="FAB-RIB-1X1",
         spec="1×1 rib 240 g/m², 95% cotton / 5% elastane, cuff, hem and hood binding, self shade",
         cons="0.045", uom="kg", waste="8.00", page=4),
    dict(group="trims", ref="TRM-ZIP-OE65",
         spec="YKK #5 moulded open-end zipper, 65 cm, auto-lock puller, tape dyed to shade",
         cons="1", uom="pcs", waste="2.00", page=6),
    dict(group="trims", ref="TRM-CORD-8",
         spec="flat drawcord 8 mm × 130 cm, cut and heat-tipped, self shade",
         cons="1", uom="pcs", waste="3.00", page=6),
    dict(group="trims", ref="TRM-EYELET-8",
         spec="metal eyelet 8 mm, nickel-free, antique silver finish",
         cons="2", uom="pcs", waste="3.00", page=6),
    dict(group="trims", ref="TRM-LBL-MAIN",
         spec="woven main label, Nordkap, size-specific, folded and stitched at CB neck",
         cons="1", uom="pcs", waste="2.00", page=7),
    dict(group="trims", ref="TRM-LBL-CARE",
         spec="printed care and content label, 5 languages, side seam left",
         cons="1", uom="pcs", waste="2.00", page=7),
    dict(group="trims", ref="TRM-THR-40",
         spec="sewing thread 40/2 spun polyester, colour matched",
         cons="145", uom="m", waste="5.00", page=6),
    dict(group="embellishment", ref="EMB-PRINT-CB",
         spec="centre-back plastisol print 180 × 120 mm, 3 colours, phthalate free",
         cons="1", uom="pcs", waste="3.00", page=8),
    dict(group="packing", ref="PKG-POLY",
         spec="polybag 300 × 420 mm, 0.04 mm LDPE 30% recycled, vent holes, suffocation warning",
         cons="1", uom="pcs", waste="2.00", page=9),
    dict(group="packing", ref="PKG-HANGTAG",
         spec="hangtag 55 × 90 mm FSC board + cotton string, price ticket applied by buyer",
         cons="1", uom="set", waste="2.00", page=9),
    dict(group="packing", ref="PKG-CTN-5PLY",
         spec="5-ply export carton 600 × 400 × 350 mm, 24 pcs solid size solid colour",
         cons="0.0417", uom="pcs", waste="1.00", page=9),
]

# ─────────────────────────────────────────────────────────────────────────────
# measurements — 10 points, graded across 5 sizes
# ─────────────────────────────────────────────────────────────────────────────

POM_UNIT = "cm"
POM = [
    dict(code="A", name="Chest width, 1 cm below armhole",
         v=[51.0, 53.5, 56.0, 58.5, 61.0], tol=1.5),
    dict(code="B", name="Body length from HPS", v=[62.0, 64.0, 66.0, 68.0, 70.0], tol=1.0),
    dict(code="C", name="Across shoulder", v=[40.5, 42.0, 43.5, 45.0, 46.5], tol=1.0),
    dict(code="D", name="Sleeve length from CB", v=[78.0, 80.0, 82.0, 84.0, 86.0], tol=1.0),
    dict(code="E", name="Armhole straight", v=[22.5, 23.5, 24.5, 25.5, 26.5], tol=0.8),
    dict(code="F", name="Cuff width relaxed", v=[8.5, 8.5, 9.0, 9.0, 9.5], tol=0.5),
    dict(code="G", name="Bottom rib width relaxed",
         v=[38.0, 40.5, 43.0, 45.5, 48.0], tol=1.5),
    dict(code="H", name="Hood height", v=[35.0, 35.5, 36.0, 36.5, 37.0], tol=0.8),
    dict(code="I", name="Hood width at base", v=[24.0, 24.5, 25.0, 25.5, 26.0], tol=0.5),
    dict(code="J", name="Pocket opening", v=[15.5, 16.0, 16.5, 17.0, 17.5], tol=0.5),
]

# ─────────────────────────────────────────────────────────────────────────────
# suppliers
# ─────────────────────────────────────────────────────────────────────────────

MILL = dict(
    code="ZJ-HUALING",
    name="Zhejiang Hualing Knitting Co., Ltd",
    addr=["No. 88 Binhai Industrial Road, Keqiao District", "Shaoxing, Zhejiang 312030, P.R. China"],
    contact=["export@hualing-knit.test", "T +86 575 8412 6600"],
    origin="import",
    currency="USD",
)
RIB_MILL = dict(
    code="ASH-KNT",
    name="Ashulia Knit & Dyeing Ltd",
    addr=["Zirabo, Ashulia, Savar, Dhaka 1341, Bangladesh"],
    contact=["sales@ashuliaknit.test", "T +880 2 7789 1120"],
    origin="local",
    currency="BDT",
)
TRIMS = dict(
    code="DHK-TRM",
    name="Dhaka Trims House",
    addr=["148/A Tejgaon Industrial Area, Dhaka 1208, Bangladesh"],
    contact=["orders@dhakatrims.test", "T +880 2 8878 4102"],
    origin="local",
    currency="BDT",
)

# fabric proforma
PI_NO = "HL-PI-26-0914"
PI_DATE = "2026-09-14"
PI_VALID = "2026-10-15"
FLEECE_RATE = 4.85                                    # USD/kg CFR
FLEECE_VALUE = round(FLEECE_KG * FLEECE_RATE, 2)      # 123,190.00
PI_FREIGHT = 1850.00
PI_LEAD_DAYS = 35
PI_MOQ = 5000

BTB1_NO = "BTB-7712-01"
BTB1_VALUE = FLEECE_VALUE
BTB1_DATE = "2026-09-22"
BTB2_NO = "BTB-7712-02"
BTB2_VALUE = 26400.00
BTB2_DATE = "2026-09-30"
BTB_USED = round(BTB1_VALUE + BTB2_VALUE, 2)          # 149,590.00
BTB_FREE = round(BTB_CEILING - BTB_USED, 2)           # 113,540.00
BTB3_TRAP_VALUE = 118500.00                           # over free headroom by 4,960

# trims quotation (BDT)
TQ_NO = "DTH-Q-2026-337"
TQ_DATE = "2026-09-18"
TQ_VALID = "2026-10-31"
TRIM_QUOTE = [
    dict(ref="TRM-ZIP-OE65", name="YKK #5 moulded open-end zipper 65 cm, auto-lock",
         qty=ZIP_PCS, unit="pcs", rate=34.50, lead=21, moq=10000),
    dict(ref="TRM-CORD-8", name="flat drawcord 8 mm × 130 cm, heat tipped",
         qty=CORD_PCS, unit="pcs", rate=7.20, lead=14, moq=20000),
    dict(ref="TRM-EYELET-8", name="metal eyelet 8 mm, nickel-free antique silver",
         qty=EYELET_PCS, unit="pcs", rate=1.15, lead=14, moq=50000),
    dict(ref="TRM-LBL-MAIN", name="woven main label, size-specific",
         qty=LABEL_PCS, unit="pcs", rate=2.60, lead=18, moq=5000),
    dict(ref="TRM-LBL-CARE", name="printed care and content label, 5 language",
         qty=LABEL_PCS, unit="pcs", rate=1.40, lead=18, moq=5000),
]

# ─────────────────────────────────────────────────────────────────────────────
# the fabric that actually turned up — first tranche only
# ─────────────────────────────────────────────────────────────────────────────

GRN_CHALLAN = "ZJH-DC-8842"
GRN_DATE = "2026-11-12"
GRN_LOT = "HL-L1-CHM"
GRN_ROLLS = 60
GRN_FAILED = ["R-F-17", "R-F-44", "R-F-58"]     # >20 pts/100 sq yd at 4-point
GRN_SHADE_B_FROM = 39                            # R-F-39 … R-F-60 are shade B


def roll_weights() -> list[tuple[str, float, str]]:
    """
    60 rolls, deterministic, averaging ~25.8 kg — what a fleece roll actually weighs.

    Returned as (roll no, kg, shade group) so the packing list, the GRN, the 4-point
    report and the cut report all quote the same rolls.
    """
    import random as _r

    rnd = _r.Random("nordkap-rolls-v1")
    out = []
    for i in range(1, GRN_ROLLS + 1):
        kg = round(rnd.uniform(23.4, 28.6), 1)
        shade = "A" if i < GRN_SHADE_B_FROM else "B"
        out.append((f"R-F-{i:02d}", kg, shade))
    return out


ROLLS = roll_weights()
GRN_KG = round(sum(k for _, k, _ in ROLLS), 1)

TRIMS_CHALLAN = "DTH-4512"
TRIMS_CHALLAN_DATE = "2026-11-18"

# ─────────────────────────────────────────────────────────────────────────────
# the floor
# ─────────────────────────────────────────────────────────────────────────────

LAY_NO = "LAY-41"
LAY_DATE = "2026-11-26"
LAY_COLOR = "Charcoal Melange"
LAY_PLIES = 96
MARKER = "ST-2815-A"
MARKER_RATIO = {"XS": 1, "S": 2, "M": 3, "L": 2, "XL": 1}
# what the marker says should come off, and what actually did (2 M panels short)
CUT_ACTUAL = {"XS": 96, "S": 192, "M": 286, "L": 192, "XL": 96}
CUT_ROLLS = [r for r, _, _ in ROLLS[:21]]
CUT_KG = 521.3

LINE = "L-3"
HOURLY_DATE = "2026-12-08"
HOURLY_TARGET = 145
HOURS = [
    (8, 145, 118, "first hour — feeding, 6 operators short"),
    (9, 145, 141, ""),
    (10, 145, 149, ""),
    (11, 145, 152, ""),
    (12, 145, 147, ""),
    (14, 145, 138, "needle change SN-3-014"),
    (15, 145, 151, ""),
    (16, 145, 156, ""),
    (17, 145, 143, ""),
]
HOURLY_TOTAL = sum(a for _, _, a, _ in HOURS)     # 1,295
SMV = 18.6
# A 68-head line at 145/hr on an 18.6-minute hoodie runs at about 66% — week one of a new
# style, which is what this day is. Manning and SMV have to agree or the efficiency figure
# on the sheet is nonsense, and the whole point of the sheet is that the number recomputes.
OPERATORS = 68
# What stopped the line, and for how long. Not an intake field — it fills the sheet the way
# a real one is filled, and gives the maintenance ticket in scene 10 something to point at.
DOWNTIME = [
    ("09:40", "10:05", 25, "L-3 flatlock SZ26-204417 — looper timing, mechanic called"),
    ("14:10", "14:22", 12, "needle change SN-3-014, 3 machines"),
    ("16:35", "16:41", 6, "power dip, generator changeover"),
]

DEFECTS = [
    ("BROKEN_STITCH", "broken stitch", 18),
    ("SKIP_STITCH", "skip stitch", 14),
    ("PUCKERING", "puckering", 11),
    ("OIL_STAIN", "oil stain", 9),
    ("OPEN_SEAM", "open seam", 7),
    ("MEASUREMENT", "measurement out of tolerance", 6),
    ("ZIPPER_FAULT", "zipper not running free", 3),
    ("LABEL_WRONG", "wrong size label", 3),
]
DEFECT_TOTAL = sum(n for _, _, n in DEFECTS)      # 71

MACHINE = dict(
    type="flatlock 5-thread coverstitch",
    brand="Suzuka Sewing Machine Co.",
    model="SZ-988-FL",
    serial="SZ26-204417",
    purchased="2026-03-01",
    plate_date="03/2026",
    power="550 W",
    voltage="220–240 V ~ 50 Hz",
    speed="6,000 s.p.m.",
    origin="Made in Japan",
)

# ─────────────────────────────────────────────────────────────────────────────
# shipment 1
# ─────────────────────────────────────────────────────────────────────────────

SHIP1_QTY = 12000
SHIP1_CARTONS = SHIP1_QTY // PCS_PER_CARTON       # 500
SHIP1_VALUE = round(SHIP1_QTY * UNIT_PRICE, 2)    # 107,400.00
PACKOUT_CARTONS = 40                              # the sheet the pack-out desk types in
INVOICE_NO = "TT-INV-2815-1"
INVOICE_DATE = "2027-01-22"
EXP_NO = "EXP-2027-KMB-041182"
BL_NO = "MAEU-CTG-771904"
BL_DATE = "2027-01-22"
VESSEL = "MAERSK KALMAR / 703W"
POL = "Chattogram, Bangladesh"
POD = "Gothenburg, Sweden"
CTN_NET = 14.52
CTN_GROSS = 15.50

# final inspection
AQL_LOT = SHIP1_QTY
AQL_LEVEL = "GII"
AQL_SAMPLE = 315            # ISO 2859-1 code M for 10,001–35,000
AQL_MAJOR = 2.5
AQL_MINOR = 4.0
AQL_ACC_MAJOR, AQL_REJ_MAJOR = 14, 15
AQL_ACC_MINOR, AQL_REJ_MINOR = 21, 22
AQL_FOUND_MAJOR = 9
AQL_FOUND_MINOR = 18
AQL_REPORT = "FI-2815-01"
AQL_DATE = "2027-01-18"

# bank
ADVICE_REF = "KMB/EXP/2027/09117"
ADVICE_DATE = "2027-02-18"
REALIZED_GROSS = SHIP1_VALUE
DEDUCTIONS = [
    ("Foreign bank charges", 92.50),
    ("Courier charges", 45.00),
    ("Negotiation commission 0.25%", 268.50),
]
REALIZED_NET = round(REALIZED_GROSS - sum(v for _, v in DEDUCTIONS), 2)   # 106,994.00

# ─────────────────────────────────────────────────────────────────────────────
# compliance — the buyer's own pre-order audit
# ─────────────────────────────────────────────────────────────────────────────

AUDIT_FIRM = "Vertas Assurance Ltd"
AUDIT_REF = "VA-BD-2026-3391"
AUDIT_DATE = "2026-08-26"
AUDIT_REGIME = "buyer"
AUDIT_STANDARD = "Nordkap Supplier Code of Conduct v6 (2025)"
FINDINGS = [
    dict(sev="critical", page=4,
         text="Two of the four fire exits on the 3rd floor sewing area were obstructed by "
              "stacked carton pallets at the time of the walk; exit 3B was locked and the "
              "key was held in the security office."),
    dict(sev="major", page=5,
         text="Overtime records for June and July 2026 show 68 operators exceeding the "
              "statutory 2 hours per day on 9 and 11 days respectively, without the "
              "written consent required by the Bangladesh Labour Rules 2015."),
    dict(sev="major", page=5,
         text="Chemical store for spot-cleaning solvents has no secondary containment and "
              "no MSDS displayed in Bangla; three containers were unlabelled."),
    dict(sev="major", page=6,
         text="No functioning anti-harassment committee could be evidenced; the last "
              "recorded meeting minute is dated 2025-11-04."),
    dict(sev="minor", page=6,
         text="Drinking-water points on the ground floor were tested at 1 point per 84 "
              "workers against the required 1 per 50."),
    dict(sev="minor", page=7,
         text="Personal protective equipment for the cutting section (metal mesh gloves) "
              "was available but not worn by 4 of 11 cutters observed."),
    dict(sev="minor", page=7,
         text="Machine guards were missing on 2 of 14 button-attach machines inspected."),
    dict(sev="observation", page=8,
         text="Childcare room is operating above its registered capacity on morning shifts; "
              "the factory has applied for an extension."),
]

# ─────────────────────────────────────────────────────────────────────────────
# HR — the week the hoodie ran
# ─────────────────────────────────────────────────────────────────────────────

PAY_PERIOD = "2026-12"
ATT_WEEK = ["2026-12-06", "2026-12-07", "2026-12-08", "2026-12-09", "2026-12-10"]
GAZETTE_VERSION = "SRO-2026-11"
GAZETTE_FROM = "2026-12-01"
GAZETTE_GRADES = [
    # grade, basic, house rent, medical, transport, food
    ("1", "10400", "5200", "750", "450", "1250"),
    ("2", "9750", "4875", "750", "450", "1250"),
    ("3", "9100", "4550", "750", "450", "1250"),
    ("4", "8600", "4300", "750", "450", "1250"),
    ("5", "8150", "4075", "750", "450", "1250"),
    ("6", "7750", "3875", "750", "450", "1250"),
    ("7", "7400", "3700", "750", "450", "1250"),
]
