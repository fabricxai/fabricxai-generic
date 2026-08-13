"""Commercial and finance: the credit, the back-to-backs, the UD, the money landing."""

from __future__ import annotations

from pathlib import Path

from reportlab.platypus import PageBreak, Spacer

import _order as O
from _lib import (
    F_SANS,
    F_SANS_B,
    P,
    Sheet,
    build_pdf,
    doc_title,
    grid,
    kv_block,
    letterhead,
    money,
    save_scan_pdf,
    signature_row,
    two_col,
    write_json,
    write_text,
)

BANK_HEAD = lambda: letterhead(
    O.LC_ADVISING_BANK,
    [O.LC_ADVISING_BRANCH, "Plot 4, Bir Uttam Mir Shawkat Sarak, Dhaka 1212, Bangladesh"],
    [f"SWIFT {O.LC_ADVISING_SWIFT}", "Trade Services · T +880 2 9885 4400", "trade.gulshan@kmbl.test"],
    accent="#0f3d2e",
)


# ─────────────────────────────────────────────────────────────────────────────
# 06 · the master credit (door: lc_swift → lcs)
# ─────────────────────────────────────────────────────────────────────────────

DOCS_REQUIRED = [
    "Signed commercial invoice in 3 fold",
    "Full set 3/3 original clean on board ocean bills of lading made out to order and blank "
    "endorsed, marked freight collect, notify applicant",
    "Packing list in 3 fold showing carton wise contents, gross and net weight",
    "Certificate of origin GSP Form A issued by the Export Promotion Bureau, Bangladesh",
    "Beneficiary's certificate that one set of non-negotiable documents has been sent to the "
    "applicant by courier within 3 days of shipment",
    "Inspection certificate issued and signed by the applicant",
]

SWIFT_FIELDS = [
    ("27", "Sequence of total", "1/1"),
    ("40A", "Form of documentary credit", "IRREVOCABLE"),
    ("20", "Documentary credit number", O.LC_NO),
    ("31C", "Date of issue", "260915"),
    ("40E", "Applicable rules", "UCP LATEST VERSION"),
    ("31D", "Date and place of expiry", "270225  BANGLADESH"),
    ("50", "Applicant", f"{O.BUYER['name']}\n{O.BUYER['addr'][0]}\n{O.BUYER['addr'][1]}"),
    ("59", "Beneficiary", f"{O.FACTORY['name']}\n{O.FACTORY['addr'][0]}\n{O.FACTORY['addr'][1]}"),
    ("32B", "Currency code, amount", f"USD {money(O.ORDER_VALUE)}"),
    ("39A", "Percentage credit amount tolerance", f"{O.LC_TOLERANCE}/{O.LC_TOLERANCE}"),
    ("41D", "Available with ... by ...", "ANY BANK\nBY NEGOTIATION"),
    ("42C", "Drafts at ...", f"{O.DELIVERY_TERM_DAYS} DAYS FROM BILL OF LADING DATE"),
    ("42A", "Drawee", f"{O.LC_ISSUING_SWIFT}"),
    ("43P", "Partial shipments", "ALLOWED"),
    ("43T", "Transhipment", "ALLOWED"),
    ("44E", "Port of loading", "CHATTOGRAM, BANGLADESH"),
    ("44F", "Port of discharge", "GOTHENBURG, SWEDEN"),
    ("44C", "Latest date of shipment", "270210"),
]


def master_lc(out: Path) -> None:
    desc = (
        f"{O.QTY:,} PCS LADIES BRUSHED FLEECE FULL ZIP HOODIE\n"
        f"STYLE {O.STYLE} / BUYER ARTICLE {O.BUYER_ARTICLE}\n"
        f"AT USD {money(O.UNIT_PRICE)} PER PIECE {O.PRICE_TERM.upper()}\n"
        f"AS PER PROFORMA / PURCHASE ORDER NO {O.PO_NO} DATED {O.PO_DATE}\n"
        "SHIPMENT IN THREE LOTS PERMITTED"
    )
    rows = [["Tag", "Field", "Value"]]
    for tag, name, val in SWIFT_FIELDS:
        rows.append([tag, name, P(val.replace("\n", "<br/>"), "mono")])
    rows.append(["45A", "Description of goods and/or services", P(desc.replace("\n", "<br/>"), "mono")])
    rows.append(
        [
            "46A",
            "Documents required",
            P("<br/>".join(f"{i+1}. {d}" for i, d in enumerate(DOCS_REQUIRED)), "mono"),
        ]
    )
    rows.append(
        [
            "47A",
            "Additional conditions",
            P(
                "1. ALL DOCUMENTS MUST BEAR OUR CREDIT NUMBER AND DATE.<br/>"
                "2. THIRD PARTY DOCUMENTS ACCEPTABLE EXCEPT INVOICE AND DRAFT.<br/>"
                "3. SHIPMENT EFFECTED PRIOR TO RECEIPT OF ANY AMENDMENT IS NOT ACCEPTABLE.<br/>"
                "4. A DISCREPANCY FEE OF USD 75.00 WILL BE DEDUCTED FROM THE PROCEEDS FOR EACH "
                "SET OF DISCREPANT DOCUMENTS.",
                "mono",
            ),
        ]
    )
    rows.append(["71B", "Charges", P("ALL CHARGES OUTSIDE SWEDEN INCLUDING<br/>ADVISING AND "
                                     "NEGOTIATION ARE FOR<br/>BENEFICIARY ACCOUNT", "mono")])
    rows.append(["48", "Period for presentation", P("WITHIN 21 DAYS AFTER THE DATE OF SHIPMENT "
                                                    "BUT<br/>WITHIN THE VALIDITY OF THE CREDIT", "mono")])
    rows.append(["49", "Confirmation instructions", P("WITHOUT", "mono")])
    rows.append(["78", "Instructions to the paying bank", P("UPON RECEIPT OF DOCUMENTS IN "
                                                            "COMPLIANCE WE SHALL<br/>REMIT AT "
                                                            "MATURITY AS PER YOUR INSTRUCTIONS", "mono")])

    st = [
        *BANK_HEAD(),
        *doc_title(
            "Advice of documentary credit",
            f"Received by SWIFT MT700 · our reference {O.LC_ADVISING_SWIFT}/ADV/2026/44127",
        ),
        two_col(
            [
                P("<b>To the beneficiary</b>", "small"),
                P(O.FACTORY["name"], "b"),
                P(O.FACTORY["addr"][0], "p"),
                P(O.FACTORY["addr"][1], "p"),
            ],
            [
                kv_block(
                    [
                        ("Advice date", "2026-09-16"),
                        ("Issuing bank", f"{O.LC_ISSUING_BANK} ({O.LC_ISSUING_SWIFT})"),
                        ("Credit number", O.LC_NO),
                        ("Advising commission", "BDT 3,500 debited to your account"),
                    ],
                    widths=(30, 55),
                )
            ],
        ),
        Spacer(1, 6),
        P(
            "We advise you, without any engagement on our part, that we have received the "
            "documentary credit reproduced below. Please examine its terms carefully and "
            "advise us immediately of anything you cannot comply with.",
            "small",
        ),
        Spacer(1, 8),
        grid(rows, [12, 52, 116], font_size=7.4),
        Spacer(1, 8),
        P(
            "This advice is computer generated and requires no signature. "
            "Amendments, if any, will be advised separately.",
            "small",
        ),
    ]
    build_pdf(out / "06-master-lc-7712-mt700-advice.pdf", st, f"LC advice {O.LC_NO}")

    swift_txt = "\n".join(
        f":{tag}: {val}" if "\n" not in val else f":{tag}: " + val.replace("\n", "\n      ")
        for tag, _n, val in SWIFT_FIELDS
    )
    write_text(
        out / "06-master-lc-7712-mt700-advice.paste.txt",
        f"""{O.LC_ADVISING_BANK}
{O.LC_ADVISING_BRANCH}
SWIFT {O.LC_ADVISING_SWIFT}

ADVICE OF DOCUMENTARY CREDIT
Received by SWIFT MT700 - our reference {O.LC_ADVISING_SWIFT}/ADV/2026/44127
Advice date: 2026-09-16
To the beneficiary: {O.FACTORY['name']}, {O.FACTORY['addr'][0]}, {O.FACTORY['addr'][1]}

{swift_txt}
:45A: {desc}
:46A: DOCUMENTS REQUIRED
""" + "\n".join(f"      {i+1}. {d}" for i, d in enumerate(DOCS_REQUIRED)) + f"""
:47A: ADDITIONAL CONDITIONS
      1. ALL DOCUMENTS MUST BEAR OUR CREDIT NUMBER AND DATE.
      2. THIRD PARTY DOCUMENTS ACCEPTABLE EXCEPT INVOICE AND DRAFT.
      3. SHIPMENT EFFECTED PRIOR TO RECEIPT OF ANY AMENDMENT IS NOT ACCEPTABLE.
      4. A DISCREPANCY FEE OF USD 75.00 WILL BE DEDUCTED FROM THE PROCEEDS FOR EACH SET OF
         DISCREPANT DOCUMENTS.
:71B: ALL CHARGES OUTSIDE SWEDEN INCLUDING ADVISING AND NEGOTIATION ARE FOR BENEFICIARY ACCOUNT
:48: WITHIN 21 DAYS AFTER THE DATE OF SHIPMENT BUT WITHIN THE VALIDITY OF THE CREDIT
:49: WITHOUT
:78: UPON RECEIPT OF DOCUMENTS IN COMPLIANCE WE SHALL REMIT AT MATURITY AS PER YOUR INSTRUCTIONS
""",
    )
    write_json(
        out / "06-master-lc-7712-mt700-advice.expected.json",
        {
            "_intakeKind": "lc_swift",
            "_door": "/marbim/intake → 'A letter of credit' · or /lcs → New credit",
            "_context": {
                "buyerId": "picked from the Buyer dropdown — Nordkap Apparel AB (NKA). "
                "Field 50 names the applicant, but which record that is, is a human's call."
            },
            "number": O.LC_NO,
            "value": f"{O.ORDER_VALUE:.2f}",
            "currency": "USD",
            "tolerancePct": str(O.LC_TOLERANCE),
            "issueDate": O.LC_ISSUE,
            "latestShipmentDate": O.LC_LATEST_SHIPMENT,
            "expiryDate": O.LC_EXPIRY,
            "docsRequired": DOCS_REQUIRED,
            "_notes": [
                "The three dates are SWIFT six-digit: 31C 260915, 44C 270210, 31D 270225. "
                "Every one must come out as a four-digit ISO year. A 44C read as 2026-02-10 "
                "or as 2027-10-02 is the single highest-value bug this document can catch.",
                "39A is '5/5' — a tolerance PAIR. tolerancePct is one number: 5.",
                "32B is 'USD 375,900.00' — the comma is a thousands separator. 375900.00, "
                "never 375.90 and never 375900000.",
                "docsRequired should be 6 entries. The credit's :47A: conditions are NOT "
                "documents; folding them in is a finding.",
            ],
        },
    )


# ─────────────────────────────────────────────────────────────────────────────
# 07 · the two back-to-backs (no door — commercial types these)
# ─────────────────────────────────────────────────────────────────────────────


def btb_advices(out: Path) -> None:
    def one(no, value, date, benef, goods, ship, expiry, tenor):
        return [
            *BANK_HEAD(),
            *doc_title(
                "Back-to-back documentary credit — issue advice",
                f"{no} · issued against master credit {O.LC_NO}",
            ),
            two_col(
                [
                    kv_block(
                        [
                            ("Our credit no", no),
                            ("Date of issue", date),
                            ("Applicant", O.FACTORY["name"]),
                            ("Beneficiary", benef["name"]),
                            ("", ", ".join(benef["addr"])),
                        ],
                        widths=(28, 58),
                    )
                ],
                [
                    kv_block(
                        [
                            ("Amount", f"{benef['currency']} {money(value)}"),
                            ("Tenor", tenor),
                            ("Latest shipment", ship),
                            ("Expiry", expiry),
                            ("Master credit", f"{O.LC_NO} dated {O.LC_ISSUE}"),
                        ],
                        widths=(28, 58),
                    )
                ],
            ),
            Spacer(1, 8),
            P("Goods", "h2"),
            P(goods, "p"),
            Spacer(1, 8),
            P("Bond and margin", "h2"),
            grid(
                [
                    ["", "USD"],
                    ["Master credit value (32B)", money(O.ORDER_VALUE)],
                    [f"Back-to-back ceiling at {O.BTB_CEILING_PCT}% of master", money(O.BTB_CEILING)],
                    ["Already issued under this master", money(O.BTB_USED - value)],
                    ["This credit", money(value)],
                    ["Total issued after this credit", money(O.BTB_USED if no == O.BTB2_NO else value)],
                    [
                        "Headroom remaining",
                        money(
                            O.BTB_CEILING - (O.BTB_USED if no == O.BTB2_NO else value)
                        ),
                    ],
                ],
                [110, 40],
                align_right=[1],
            ),
            Spacer(1, 8),
            P(
                "This credit is issued under the export development / back-to-back arrangement "
                f"against master credit {O.LC_NO} and is payable exclusively out of the proceeds "
                "of that credit. Import under this credit is duty-free against a valid "
                "Utilization Declaration; goods may not be released from bond without one.",
                "small",
            ),
            Spacer(1, 8),
            signature_row(["Authorised signatory\n" + O.LC_ADVISING_BANK,
                           "Received by\n" + O.FACTORY["name"]]),
        ]

    st = one(
        O.BTB1_NO,
        O.BTB1_VALUE,
        O.BTB1_DATE,
        {**O.MILL, "currency": "USD"},
        f"{O.FLEECE_KG:,} KG BRUSHED BACK FLEECE 280 GSM 80/20 CVC, TUBULAR 185 CM, "
        f"IN THREE SHADES AS PER PROFORMA INVOICE {O.PI_NO} DATED {O.PI_DATE}. "
        f"CFR CHATTOGRAM. FOR MANUFACTURE OF STYLE {O.STYLE} UNDER {O.PO_NO}.",
        "2026-11-30",
        "2026-12-15",
        "120 days from B/L date",
    )
    st += [PageBreak()]
    st += one(
        O.BTB2_NO,
        O.BTB2_VALUE,
        O.BTB2_DATE,
        {**O.MILL, "name": "Shantou Weiye Textile Trading Co., Ltd",
         "addr": ["12F Block C, Huanan Textile Plaza, Chaonan District", "Shantou, Guangdong 515144, P.R. China"],
         "currency": "USD"},
        f"{O.RIB_KG:,} KG 1X1 RIB 240 GSM 95/5 COTTON ELASTANE AND ASSORTED IMPORTED TRIMS "
        f"FOR STYLE {O.STYLE} UNDER {O.PO_NO}. CFR CHATTOGRAM.",
        "2026-11-20",
        "2026-12-05",
        "90 days from B/L date",
    )
    build_pdf(out / "07-btb-credits-7712-01-and-02.pdf", st, "Back-to-back credits")

    write_text(
        out / "07-btb-credits-7712-01-and-02.paste.txt",
        f"""{O.LC_ADVISING_BANK} — BACK-TO-BACK DOCUMENTARY CREDIT ISSUE ADVICE

CREDIT 1
Our credit no: {O.BTB1_NO}
Date of issue: {O.BTB1_DATE}
Applicant: {O.FACTORY['name']}
Beneficiary: {O.MILL['name']}, {', '.join(O.MILL['addr'])}
Amount: USD {money(O.BTB1_VALUE)}
Tenor: 120 days from B/L date
Latest shipment: 2026-11-30
Expiry: 2026-12-15
Master credit: {O.LC_NO} dated {O.LC_ISSUE}
Goods: {O.FLEECE_KG:,} KG BRUSHED BACK FLEECE 280 GSM 80/20 CVC, TUBULAR 185 CM, IN THREE
SHADES AS PER PROFORMA INVOICE {O.PI_NO} DATED {O.PI_DATE}. CFR CHATTOGRAM.

CREDIT 2
Our credit no: {O.BTB2_NO}
Date of issue: {O.BTB2_DATE}
Beneficiary: Shantou Weiye Textile Trading Co., Ltd, Shantou, Guangdong, P.R. China
Amount: USD {money(O.BTB2_VALUE)}
Tenor: 90 days from B/L date
Latest shipment: 2026-11-20
Expiry: 2026-12-05
Goods: {O.RIB_KG:,} KG 1X1 RIB 240 GSM 95/5 COTTON ELASTANE AND ASSORTED IMPORTED TRIMS.

BOND AND MARGIN
Master credit value (32B):                     USD {money(O.ORDER_VALUE)}
Back-to-back ceiling at {O.BTB_CEILING_PCT}% of master:      USD {money(O.BTB_CEILING)}
Total issued after these two credits:          USD {money(O.BTB_USED)}
Headroom remaining:                            USD {money(O.BTB_FREE)}
""",
    )


# ─────────────────────────────────────────────────────────────────────────────
# 08 · the UD — a customs form, so a scan (door: ud_scan → uds)
# ─────────────────────────────────────────────────────────────────────────────

UD_ITEMS = [
    ("FAB-FLC-280", "Brushed back fleece 280 g/m², 80% cotton 20% polyester", O.FLEECE_KG, "kg"),
    ("FAB-RIB-1X1", "1×1 rib fabric 240 g/m², 95% cotton 5% elastane", O.RIB_KG, "kg"),
    ("TRM-ZIP-OE65", "Moulded open-end zipper 65 cm", O.ZIP_PCS, "pcs"),
]


def ud_scan(out: Path) -> None:
    sh = Sheet(seed="ud-2026-058")
    W = sh.w
    m = 150

    # ── masthead ────────────────────────────────────────────────────────────
    sh.bn((W // 2, 120), "বাংলাদেশ পোশাক প্রস্তুতকারক ও রপ্তানিকারক সমিতি", size=52,
          bold=True, anchor="ma")
    sh.text((W // 2, 190), "BANGLADESH GARMENT MANUFACTURERS AND EXPORTERS ASSOCIATION",
            F_SANS_B, 32, anchor="ma")
    sh.text((W // 2, 236), "BGMEA Complex, 23/1 Panthapath Link Road, Karwan Bazar, Dhaka 1215",
            F_SANS, 24, fill=(70, 70, 70), anchor="ma")
    sh.hrule(288, m, W - m, w=4)
    sh.bn((W // 2, 306), "ইউটিলাইজেশন ডিক্লারেশন", size=44, bold=True, anchor="ma")
    sh.text((W // 2, 372), "UTILIZATION DECLARATION (UD)", F_SANS_B, 34, anchor="ma")
    sh.text((W // 2, 418), "Issued under the Customs Bonded Warehouse Licensing Rules",
            F_SANS, 22, fill=(70, 70, 70), anchor="ma")

    # ── header block ────────────────────────────────────────────────────────
    # Bilingual labels are drawn in two passes: Liberation carries no Bengali glyph,
    # so mixing the scripts in one draw call prints a row of tofu boxes.
    def field(x: int, y: int, w: int, en: str, bn: str, value: str, size=30) -> None:
        sh.text((x, y), en, F_SANS, 25, fill=(88, 88, 88))
        sh.bn((x + sh.width(en + "  ", F_SANS, 25), y - 2), bn, size=25, fill=(88, 88, 88))
        sh.text((x + 8, y + 38), value, F_SANS_B, size)
        sh.line((x, y + 88), (x + w, y + 88), fill=(150, 150, 150), w=2)

    COLW = 1000
    RX = m + 1180
    y = 500
    for i, (en, bn, v) in enumerate(
        [
            ("UD No.", "ইউডি নম্বর", O.UD_NO),
            ("Date of issue", "ইস্যুর তারিখ", O.UD_ISSUE),
            ("Valid until", "মেয়াদ উত্তীর্ণের তারিখ", O.UD_VALID),
            ("Bond licence", "বন্ড লাইসেন্স", "18/Cus/Bond/2019"),
        ]
    ):
        field(m, y + i * 116, COLW, en, bn, v)
    for i, (en, bn, v) in enumerate(
        [
            ("Exporter", "রপ্তানিকারক", O.FACTORY["name"]),
            ("BGMEA registration no.", "সদস্য নম্বর", "3318"),
            ("Export L/C no.", "রপ্তানি ঋণপত্র", f"{O.LC_NO} dt. {O.LC_ISSUE}"),
            ("Back-to-back L/C", "ব্যাক-টু-ব্যাক ঋণপত্র", f"{O.BTB1_NO}, {O.BTB2_NO}"),
        ]
    ):
        field(RX, y + i * 116, W - m - RX, en, bn, v, size=28)

    y += 4 * 116 + 20
    field(m, y, COLW, "Buyer", "ক্রেতা", O.BUYER["name"], size=28)
    field(RX, y, W - m - RX, "Export item", "রপ্তানি পণ্য", f"{O.STYLE} — {O.STYLE_DESC}", size=26)
    y += 116
    field(m, y, COLW, "Export quantity", "রপ্তানির পরিমাণ", f"{O.QTY:,} pcs")
    field(RX, y, W - m - RX, "Export value", "রপ্তানি মূল্য", f"USD {money(O.ORDER_VALUE)}")
    y += 150

    # ── authorised items ────────────────────────────────────────────────────
    sh.text((m, y), "AUTHORISED IMPORT MATERIALS", F_SANS_B, 32)
    sh.bn((m + sh.width("AUTHORISED IMPORT MATERIALS   ", F_SANS_B, 32), y - 4),
          "অনুমোদিত আমদানি উপকরণ", size=32, bold=True)
    y += 66
    rows = [["Sl", "Item ref", "Description of material", "Quantity", "Unit"]]
    for i, (ref, desc, qty, unit) in enumerate(UD_ITEMS, 1):
        rows.append([str(i), ref, desc, f"{qty:,}", unit])
    rows.append(["", "", "", "", ""])          # a blank line, as the form prints
    y = sh.table(
        m, y, [90, 340, 1010, 320, 180], rows, row_h=84, size=27,
        align=["c", "l", "l", "r", "c"],
    )
    y += 44
    for ln in [
        "Materials listed above are authorised for duty-free import into the exporter's bonded",
        "warehouse against the export credit named. Consumption in excess of the authorised",
        "quantity requires a fresh declaration. Wastage allowance is included in the quantities",
        "stated and no further allowance is admissible under Rule 19.",
    ]:
        sh.text((m, y), ln, F_SANS, 25, fill=(58, 58, 58))
        y += 40

    # ── declaration ─────────────────────────────────────────────────────────
    y += 30
    sh.box((m, y), (W - 2 * m, 250), outline=(110, 110, 110), w=3)
    sh.text((m + 24, y + 24), "DECLARATION BY THE EXPORTER", F_SANS_B, 26)
    sh.bn((m + 24, y + 66), "আমি ঘোষণা করিতেছি যে উপরে বর্ণিত তথ্যাবলী সত্য ও সঠিক।", size=26)
    for i, ln in enumerate(
        [
            "I declare that the particulars stated above are true and correct, that the materials will be used",
            "solely for the manufacture of the export goods described, and that any unused quantity will be",
            "re-exported or accounted for to the Customs authority within the validity of this declaration.",
        ]
    ):
        sh.text((m + 24, y + 116 + i * 40), ln, F_SANS, 24, fill=(58, 58, 58))

    # ── signature block ─────────────────────────────────────────────────────
    y += 330
    sh.sign((m + 60, y + 30), "ud-exporter", scale=0.9)
    sh.line((m, y + 120), (m + 660, y + 120), fill=(90, 90, 90), w=2)
    sh.text((m, y + 136), "Signature and seal of the exporter", F_SANS, 24, fill=(70, 70, 70))
    sh.bn((m, y + 176), "রপ্তানিকারকের স্বাক্ষর ও সীল", size=24, fill=(70, 70, 70))

    sh.sign((W - m - 600, y + 30), "ud-bgmea", scale=0.9, color=(20, 30, 80))
    sh.line((W - m - 700, y + 120), (W - m, y + 120), fill=(90, 90, 90), w=2)
    sh.text((W - m - 700, y + 136), "For Bangladesh Garment Manufacturers and", F_SANS, 23,
            fill=(70, 70, 70))
    sh.text((W - m - 700, y + 170), "Exporters Association — authorised officer", F_SANS, 23,
            fill=(70, 70, 70))
    sh.bn((W - m - 700, y + 210), "অনুমোদনকারী কর্মকর্তা", size=23, fill=(70, 70, 70))

    sh.stamp((m + 700, y - 70), ["BGMEA", "DHAKA", O.UD_ISSUE], r=170, rot=-11)
    sh.text((m, sh.h - 130), "TEST FIXTURE — generated for FabricXAI platform testing. "
            "Not a real declaration and carries no legal meaning.", F_SANS, 22,
            fill=(140, 140, 140))

    save_scan_pdf(sh, out / "08-ud-2026-058-scan.pdf", "ud-scan", grain=13, dark=0.955)

    items_txt = "\n".join(
        f"{i}   {ref:<16}{desc:<62}{qty:>10,}  {unit}"
        for i, (ref, desc, qty, unit) in enumerate(UD_ITEMS, 1)
    )
    write_text(
        out / "08-ud-2026-058-scan.paste.txt",
        f"""BANGLADESH GARMENT MANUFACTURERS AND EXPORTERS ASSOCIATION
BGMEA Complex, 23/1 Panthapath Link Road, Karwan Bazar, Dhaka 1215

UTILIZATION DECLARATION (UD)
Issued under the Customs Bonded Warehouse Licensing Rules

UD No.: {O.UD_NO}
Date of issue: {O.UD_ISSUE}
Valid until: {O.UD_VALID}
Bond licence: 18/Cus/Bond/2019
Exporter: {O.FACTORY['name']}
BGMEA Reg. No.: 3318
Export L/C No.: {O.LC_NO} dt. {O.LC_ISSUE}
Back-to-back L/C: {O.BTB1_NO}, {O.BTB2_NO}
Buyer: {O.BUYER['name']}, {O.BUYER['addr'][1]}
Export item: {O.STYLE} — {O.STYLE_DESC}
Export quantity: {O.QTY:,} pcs
Export value: USD {money(O.ORDER_VALUE)}

AUTHORISED IMPORT MATERIALS
Sl  Item ref        Description of material                                        Quantity  Unit
{items_txt}

Materials above are authorised for duty-free import into the exporter's bonded warehouse
against the export credit named. Consumption in excess of the authorised quantity requires
a fresh declaration. Wastage allowance is included in the quantities stated and no further
allowance is admissible.
""",
    )
    write_json(
        out / "08-ud-2026-058-scan.expected.json",
        {
            "_intakeKind": "ud_scan",
            "_door": "/marbim/intake → 'A customs Utilization Declaration'",
            "number": O.UD_NO,
            "issueDate": O.UD_ISSUE,
            "validUntil": O.UD_VALID,
            "authorizedItems": [
                {"itemRef": ref, "qty": str(qty), "unit": unit}
                for ref, _d, qty, unit in UD_ITEMS
            ],
            "_notes": [
                "This one is a SCAN, not a clean PDF — the file path and the text path should "
                "score visibly differently. Run both. A scan that comes back at 1.000 on every "
                "field has not been read, it has been guessed.",
                "Three authorised items with two different units. A reading that normalises "
                "the zipper's 42,840 pcs into kg is a finding.",
                f"{O.FLEECE_KG:,} kg is the number the store's bonded issues will be checked "
                "against for the rest of this order. It is the balance the overdraw block "
                "defends, so it must be exactly right before approving.",
            ],
        },
    )


# ─────────────────────────────────────────────────────────────────────────────
# 09 · the money landing (door: bank_advice → doc_submissions)
# ─────────────────────────────────────────────────────────────────────────────


def realization_advice(out: Path) -> None:
    ded_rows = [["Description", f"Amount ({O.CURRENCY})"]]
    for name, amt in O.DEDUCTIONS:
        ded_rows.append([name, money(amt)])
    ded_rows.append(["Total deductions", money(sum(v for _, v in O.DEDUCTIONS))])

    st = [
        *BANK_HEAD(),
        *doc_title("Export proceeds realization advice", f"Our reference {O.ADVICE_REF}"),
        two_col(
            [
                P("<b>To</b>", "small"),
                P(O.FACTORY["name"], "b"),
                P(O.FACTORY["addr"][0], "p"),
                P(O.FACTORY["addr"][1], "p"),
                P("A/C 0021-4471-9930 (USD ERQ) / 0021-4471-9901 (BDT current)", "small"),
            ],
            [
                kv_block(
                    [
                        ("Advice reference", O.ADVICE_REF),
                        ("Advice date", O.ADVICE_DATE),
                        ("Value date", O.ADVICE_DATE),
                        ("Under credit", f"{O.LC_NO} of {O.LC_ISSUING_BANK}"),
                        ("EXP number", O.EXP_NO),
                    ],
                    widths=(30, 55),
                )
            ],
        ),
        Spacer(1, 8),
        P(
            "We are pleased to advise that the export proceeds against the documents detailed "
            "below have been realized and credited to your account with value date "
            f"{O.ADVICE_DATE}.",
            "p",
        ),
        Spacer(1, 8),
        grid(
            [
                ["Documents presented", ""],
                ["Commercial invoice", f"{O.INVOICE_NO} dated {O.INVOICE_DATE}"],
                ["Bill of lading", f"{O.BL_NO} on board {O.BL_DATE}"],
                ["Vessel / voyage", O.VESSEL],
                ["Shipment", f"{O.SHIP1_QTY:,} pcs, {O.SHIP1_CARTONS:,} cartons, "
                             f"{O.POL} to {O.POD}"],
                ["Presentation date", "2027-01-27"],
                ["Discrepancies", "none"],
            ],
            [50, 130],
        ),
        Spacer(1, 8),
        two_col(
            [
                P("Deductions", "h2"),
                grid(ded_rows, [58, 28], align_right=[1]),
            ],
            [
                P("Settlement", "h2"),
                grid(
                    [
                        ["", f"Amount ({O.CURRENCY})"],
                        ["Document value / gross proceeds", money(O.REALIZED_GROSS)],
                        ["Less total deductions", f"({money(sum(v for _, v in O.DEDUCTIONS))})"],
                        ["NET AMOUNT CREDITED", money(O.REALIZED_NET)],
                    ],
                    [58, 28],
                    align_right=[1],
                ),
                Spacer(1, 4),
                P(
                    "Credited: USD 60,000.00 to your ERQ account, balance converted at "
                    "BDT 121.40 = BDT 5,703,835.60.",
                    "small",
                ),
            ],
        ),
        Spacer(1, 8),
        P(
            "This realization has been reported against EXP form "
            f"{O.EXP_NO} to Bangladesh Bank. Please note that the credit remains open for the "
            f"balance quantity; latest shipment under {O.LC_NO} is {O.LC_LATEST_SHIPMENT} and "
            "no amendment has reached us as at the date of this advice.",
            "small",
        ),
        Spacer(1, 8),
        signature_row(["Authorised signatory\nTrade Services, " + O.LC_ADVISING_BRANCH]),
    ]
    build_pdf(out / "09-bank-realization-advice.pdf", st, "Realization advice")

    write_text(
        out / "09-bank-realization-advice.paste.txt",
        f"""{O.LC_ADVISING_BANK}
{O.LC_ADVISING_BRANCH} — SWIFT {O.LC_ADVISING_SWIFT}

EXPORT PROCEEDS REALIZATION ADVICE
Our reference: {O.ADVICE_REF}
Advice date: {O.ADVICE_DATE}
Value date: {O.ADVICE_DATE}
Under credit: {O.LC_NO} of {O.LC_ISSUING_BANK}
EXP number: {O.EXP_NO}

To: {O.FACTORY['name']}
A/C 0021-4471-9930 (USD ERQ) / 0021-4471-9901 (BDT current)

We are pleased to advise that the export proceeds against the documents detailed below have
been realized and credited to your account with value date {O.ADVICE_DATE}.

DOCUMENTS PRESENTED
Commercial invoice: {O.INVOICE_NO} dated {O.INVOICE_DATE}
Bill of lading: {O.BL_NO} on board {O.BL_DATE}
Vessel / voyage: {O.VESSEL}
Shipment: {O.SHIP1_QTY:,} pcs, {O.SHIP1_CARTONS:,} cartons, {O.POL} to {O.POD}
Presentation date: 2027-01-27
Discrepancies: none

DEDUCTIONS                                   Amount (USD)
"""
        + "\n".join(f"{n:<44}{money(v):>12}" for n, v in O.DEDUCTIONS)
        + f"""
{'Total deductions':<44}{money(sum(v for _, v in O.DEDUCTIONS)):>12}

SETTLEMENT                                   Amount (USD)
{'Document value / gross proceeds':<44}{money(O.REALIZED_GROSS):>12}
{'Less total deductions':<44}{'(' + money(sum(v for _, v in O.DEDUCTIONS)) + ')':>12}
{'NET AMOUNT CREDITED':<44}{money(O.REALIZED_NET):>12}
""",
    )
    write_json(
        out / "09-bank-realization-advice.expected.json",
        {
            "_intakeKind": "bank_advice",
            "_door": "/lcs → Submissions → the accepted presentation → 'read the advice'",
            "reference": O.ADVICE_REF,
            "realizedAmount": f"{O.REALIZED_NET:.2f}",
            "realizedAt": O.ADVICE_DATE,
            "documentValue": f"{O.REALIZED_GROSS:.2f}",
            "deductions": [f"{n} USD {money(v)}" for n, v in O.DEDUCTIONS],
            "lcNumber": O.LC_NO,
            "expNumber": O.EXP_NO,
            "_notes": [
                "realizedAmount is the NET — what landed (106,994.00) — not the gross "
                "(107,400.00). The advice states both and the gross is the larger, more "
                "prominent number; a reading that takes it has silently overstated realized "
                "export proceeds, which is a Bangladesh Bank reporting problem, not a rounding "
                "one.",
                "There are three deductions. The BDT conversion line at the bottom is NOT a "
                "deduction — it is how the net was split between two accounts.",
            ],
        },
    )


def build(out: Path) -> None:
    master_lc(out)
    btb_advices(out)
    ud_scan(out)
    realization_advice(out)
