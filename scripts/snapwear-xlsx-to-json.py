#!/usr/bin/env python3
"""
snapwear-xlsx-to-json.py — convert SnapWear's two spreadsheets into ONE checked-in
JSON catalog that the Node seed (scripts/seed-snapwear-printer.cjs) reads.

WHY A PYTHON STEP: the repo has no xlsx parser in node_modules and the project
rule is "no new npm dependencies". python3 + openpyxl are already on the
operator's Mac, so the conversion happens here, ONCE per new sheet from
SnapWear, and the resulting JSON is committed. The Node seed never touches xlsx.

INPUTS (docs/SnapWearDocs/):
  PrintArea.xlsx   — SnapWear's DTG SKU list: per SKU the model, pallet size and
                     the FRONT/BACK print frames (w×h mm + offset from top).
                     Covers ~48 models; several of Kent's picks are MISSING
                     (64400, SF500, W101, B445 patch, trucker cap — open
                     question C1 to Natalia).
  SKU 21.09.xlsx   — Kent's picked products: one sheet per model, each with
                     its OWN column layout (no header rows). These SKU numbers
                     are what we will actually send in /api/order/add.

OUTPUT: docs/SnapWearDocs/snapwear-catalog.json
  {
    generatedAt, generator, source: {...},
    models: { '<model>': { brand, name, garment|null, palletMm, front, back,
                           sleeve, innerNeck, outerNeck, rowCount, frameVariants } },
    skus:   { '<sku number>': { model, garment, colour, size, printAreaColour? } },
    skipped: [ {sheet, row, reason} ],
    warnings: [ '...' ],
  }

RULES:
  - Map by SKU NUMBER, never by colour name (SnapWear's own two sheets disagree:
    SKU 4300053 is 'Blue' in Kent's sheet and 'Royal' in PrintArea).
  - Sizes normalised: xs→XS, xxl→2XL, xxxl→3XL, xxxxl→4XL, 'one size'→'One Size'.
  - 'ABSENT' / empty SKU cells are skipped (and counted).
  - A model's frames = the MOST COMMON frame tuple across its rows; any other
    tuple seen is kept under frameVariants so nothing is silently dropped.

USAGE:  python3 scripts/snapwear-xlsx-to-json.py
"""
import collections
import datetime
import json
import os
import re
import sys

try:
    import openpyxl
except ImportError:  # pragma: no cover - operator machine has it
    sys.exit('openpyxl missing: pip3 install openpyxl')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(ROOT, 'docs', 'SnapWearDocs')
PRINT_AREA = os.path.join(DOCS, 'PrintArea.xlsx')
SKU_FILE = os.path.join(DOCS, 'SKU 21.09.xlsx')
OUT = os.path.join(DOCS, 'snapwear-catalog.json')

# Kent's picks (snapwear.pro, 2026-09) → our garment vocabulary
# (src/config/podGarments.js). Every other model in PrintArea.xlsx is catalogued
# with garment null: SnapWear can print it, we just do not sell it.
MODEL_GARMENT = {
    '64000': 'tee',
    '64400': 'longsleeve',
    '18000': 'sweatshirt',
    'SF500': 'hoodie',
    'JH050': 'hoodie',
    'W101': 'bag',
    'TRUCKER': 'cap',
    'B445': 'beanie',
}

SIZE_MAP = {
    'xs': 'XS', 's': 'S', 'm': 'M', 'l': 'L', 'xl': 'XL',
    'xxl': '2XL', '2xl': '2XL', 'xxxl': '3XL', '3xl': '3XL',
    'xxxxl': '4XL', '4xl': '4XL', 'xxxxxl': '5XL', '5xl': '5XL',
    'one size': 'One Size', 'onesize': 'One Size',
}

skipped = []
warnings = []


def norm_size(raw):
    s = str(raw or '').strip()
    return SIZE_MAP.get(s.lower(), s.upper() if s else 'One Size')


def norm_sku(raw):
    """SKU cell → canonical string, or None for ABSENT/empty/non-numeric."""
    if raw is None:
        return None
    if isinstance(raw, float) and raw.is_integer():
        raw = int(raw)
    s = str(raw).strip()
    return s if re.fullmatch(r'\d{5,}', s) else None


def frame(raw):
    """'390x490' / '50 x 50' → {'w':390,'h':490}; 'NO'/None → None."""
    m = re.fullmatch(r'\s*(\d+)\s*[x×]\s*(\d+)\s*', str(raw or ''))
    return {'w': int(m.group(1)), 'h': int(m.group(2))} if m else None


def offset(raw):
    return int(raw) if isinstance(raw, (int, float)) and not isinstance(raw, bool) else None


# ── 1. PrintArea.xlsx → models (+ a sku→colour index for cross-checking) ────
pa_models = collections.OrderedDict()
pa_sku_colour = {}
wb = openpyxl.load_workbook(PRINT_AREA, data_only=True)
ws = wb.worksheets[0]
for idx, row in enumerate(ws.iter_rows(min_row=3, values_only=True), start=3):
    brand, model, colour, size = row[1], row[2], row[3], row[4]
    if model is None:
        continue
    model_id = str(model).strip()
    sku = norm_sku(row[0])
    if sku:
        pa_sku_colour[sku] = (model_id, str(colour or '').strip(), norm_size(size))
    front = frame(row[9])
    back = frame(row[11])
    tup = json.dumps({
        'palletMm': frame(row[6]),
        'front': dict(front, offsetTopMm=offset(row[8])) if front else None,
        'back': dict(back, offsetTopMm=offset(row[10])) if back else None,
        'sleeve': frame(row[12]),
        'innerNeck': frame(row[14]),
        'outerNeck': frame(row[15]),
    }, sort_keys=True)
    entry = pa_models.setdefault(model_id, {
        'brand': str(brand or '').strip() or None,
        'name': str(row[7] or '').strip() or None,
        'tuples': collections.Counter(),
        'rows': 0,
    })
    entry['rows'] += 1
    entry['tuples'][tup] += 1

models = {}
for model_id, e in pa_models.items():
    # Rows with no frame at all (ABSENT sizes) must not out-vote the real frame.
    ranked = sorted(e['tuples'].items(),
                    key=lambda kv: (json.loads(kv[0])['front'] is not None, kv[1]),
                    reverse=True)
    best = json.loads(ranked[0][0])
    variants = [dict(json.loads(t), rows=n) for t, n in ranked[1:]
                if json.loads(t)['front'] is not None]
    models[model_id] = {
        'brand': e['brand'],
        'name': e['name'],
        'garment': MODEL_GARMENT.get(model_id.upper()),
        **best,
        'rowCount': e['rows'],
        'frameVariants': variants,
        'framesMissing': best['front'] is None,
    }

# ── 2. SKU 21.09.xlsx → Kent's sellable SKUs ────────────────────────────────
# One parser per sheet: SnapWear sent each model with its own column layout.
skus = {}


def add_sku(sheet, rowno, sku_raw, model, colour, size):
    sku = norm_sku(sku_raw)
    if not sku:
        skipped.append({'sheet': sheet, 'row': rowno, 'reason': f'no SKU number ({sku_raw!r})'})
        return
    garment = MODEL_GARMENT.get(model.upper())
    rec = {'model': model, 'garment': garment, 'colour': colour, 'size': norm_size(size)}
    pa = pa_sku_colour.get(sku)
    if pa:
        rec['printAreaColour'] = pa[1]
        if pa[0] != model:
            warnings.append(f'SKU {sku}: model {model} in {sheet} but {pa[0]} in PrintArea.xlsx')
    if sku in skus and skus[sku] != rec:
        warnings.append(f'SKU {sku} listed twice with different data ({sheet} row {rowno})')
    skus[sku] = rec


wb = openpyxl.load_workbook(SKU_FILE, data_only=True)
for ws in wb.worksheets:
    title = ws.title.strip()
    rows = list(ws.iter_rows(values_only=True))
    if title == 'Posters':
        # Not a garment — nothing in the studio can design a poster yet.
        for i, _ in enumerate(rows, start=1):
            skipped.append({'sheet': title, 'row': i, 'reason': 'poster (no garment)'})
        continue
    carry_colour = None
    for i, r in enumerate(rows, start=1):
        if all(c is None for c in r):
            continue
        if title == 'Beechfield Hat':          # (colour, sku)
            add_sku(title, i, r[1], 'B445', str(r[0]).strip(), 'One Size')
        elif title == 'Trucker Cap':           # (sku, 'Trucker cap <colour>')
            colour = re.sub(r'(?i)^trucker cap\s*', '', str(r[1] or '')).strip().capitalize()
            add_sku(title, i, r[0], 'TRUCKER', colour, 'One Size')
        elif title.startswith('Totebag'):      # (sku, model, brand, name, colour, size)
            add_sku(title, i, r[0], str(r[1]).strip(), str(r[4]).strip(), r[5])
        elif title.startswith('AWD'):          # (sku, brand, type, colour, size)
            add_sku(title, i, r[0], 'JH050', str(r[3]).strip(), r[4])
        elif title == 'Gildan 64000':          # (colour-or-None, size, sku) — colour carries down
            if r[0]:
                carry_colour = str(r[0]).strip()
            add_sku(title, i, r[2], '64000', carry_colour, r[1])
        elif title.startswith('Gildan'):       # (sku, brand, type, model, name, colour, size)
            add_sku(title, i, r[0], str(r[3]).strip(), str(r[5]).strip(), r[6])
        else:
            skipped.append({'sheet': title, 'row': i, 'reason': 'unknown sheet layout'})

# Kent's models that PrintArea.xlsx does not cover → frames missing (C1).
for model_id in sorted({s['model'] for s in skus.values()}):
    if model_id not in models:
        models[model_id] = {
            'brand': None, 'name': None, 'garment': MODEL_GARMENT.get(model_id.upper()),
            'palletMm': None, 'front': None, 'back': None, 'sleeve': None,
            'innerNeck': None, 'outerNeck': None, 'rowCount': 0, 'frameVariants': [],
            'framesMissing': True,
        }
        warnings.append(f'model {model_id}: not in PrintArea.xlsx — frames missing (ask SnapWear, C1)')

colour_mismatch = sorted(
    f"{k}: '{v['colour']}' vs PrintArea '{v['printAreaColour']}'"
    for k, v in skus.items()
    if v.get('printAreaColour') and v['printAreaColour'].lower() != (v['colour'] or '').lower()
)
if colour_mismatch:
    warnings.append(f'{len(colour_mismatch)} SKU colour names differ between the sheets '
                    f'(harmless: mapping is by SKU number), e.g. {colour_mismatch[:3]}')

out = {
    'generatedAt': datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat(),
    'generator': 'scripts/snapwear-xlsx-to-json.py',
    'source': {
        'printArea': 'docs/SnapWearDocs/PrintArea.xlsx',
        'skus': 'docs/SnapWearDocs/SKU 21.09.xlsx',
    },
    'models': dict(sorted(models.items())),
    'skus': dict(sorted(skus.items())),
    'skipped': skipped,
    'warnings': warnings,
}
with open(OUT, 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, indent=2)
    f.write('\n')

by_garment = collections.Counter(s['garment'] for s in skus.values())
print(f'wrote {os.path.relpath(OUT, ROOT)}')
print(f'  models: {len(models)} ({sum(1 for m in models.values() if m["garment"])} ours)')
print(f'  skus:   {len(skus)}  by garment: {dict(by_garment)}')
print(f'  skipped: {len(skipped)}  warnings: {len(warnings)}')
for w in warnings:
    print('  ⚠', w)
