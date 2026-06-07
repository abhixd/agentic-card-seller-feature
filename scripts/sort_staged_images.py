#!/usr/bin/env python3
"""
scripts/sort_staged_images.py

Reads every staged_NNNNNN_front.jpeg from the staging folder, asks Claude
Vision (haiku — cheap/fast) to read the PSA/BGS/CGC grade from the label,
then moves the file into the appropriate grade folder (5-10).

Files whose grade can't be read (raw card photos, unclear labels) are moved
to staging/unverified/ so they don't pollute the training set.

Usage:
    python3 scripts/sort_staged_images.py [--dry-run] [--batch N]

Options:
    --dry-run    Show what would happen without moving any files
    --batch N    Process at most N images (default: all)

Results saved to: staging/.sort_log.csv
"""

import os, sys, base64, json, shutil, csv, time
from pathlib import Path
import anthropic

# ── Config ─────────────────────────────────────────────────────────────────────
BASE        = Path("/Users/srinivasdoddi/srini/card-solutoin-testing/datasets/psa_graded")
STAGING     = Path("/Users/srinivasdoddi/srini/agentic-card-seller-os/notebooks/staging")
UNVERIFIED  = STAGING / "unverified"
VALID       = {5, 6, 7, 8, 9, 10}
LOG_FILE    = STAGING / ".sort_log.csv"
DONE_FILE   = STAGING / ".sorted_files.json"  # already-sorted filenames, skip on resume
MODEL       = "claude-haiku-4-5"
MAX_TOKENS  = 10
DELAY       = 0.25   # s between API calls

PROMPT = (
    "Look at this image. If you can see a grading company label "
    "(PSA, BGS, CGC, SGC) with a numeric grade, reply with ONLY that "
    "number — it must be 5, 6, 7, 8, 9, or 10. "
    "If no clear grade label is visible, or the grade is outside that range, "
    "reply with exactly: unknown"
)

# ── CLI ────────────────────────────────────────────────────────────────────────
dry_run   = "--dry-run" in sys.argv
batch_lim = None
if "--batch" in sys.argv:
    batch_lim = int(sys.argv[sys.argv.index("--batch") + 1])

# ── Load env ───────────────────────────────────────────────────────────────────
root = Path(__file__).parent.parent
for f in [root / ".env.local", root / "backend" / ".env"]:
    try:
        for line in f.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, _, v = line.partition('=')
                os.environ.setdefault(k.strip(), v.strip().strip('"'))
    except FileNotFoundError:
        pass

client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY", ""))

# ── Load already-sorted set (resume support) ──────────────────────────────────
done_set = set()
if DONE_FILE.exists():
    try: done_set = set(json.loads(DONE_FILE.read_text()))
    except: pass

# ── Helpers ───────────────────────────────────────────────────────────────────

def read_grade(img_path: Path) -> str:
    data = base64.b64encode(img_path.read_bytes()).decode()
    msg = client.messages.create(
        model=MODEL, max_tokens=MAX_TOKENS,
        messages=[{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64",
             "media_type": "image/jpeg", "data": data}},
            {"type": "text", "text": PROMPT}
        ]}]
    )
    raw = msg.content[0].text.strip()
    return raw if raw in {str(g) for g in VALID} else "unknown"


def next_index(grade_dir: Path) -> int:
    import re
    nums = [
        int(m.group(1))
        for p in grade_dir.glob("scraped_*_front.jpeg")
        if (m := re.match(r'scraped_(\d+)_front', p.name))
    ]
    return max(nums, default=0) + 1


def mark_done(fname: str):
    done_set.add(fname)
    DONE_FILE.write_text(json.dumps(sorted(done_set)))

# ── Discover staged images ────────────────────────────────────────────────────
all_staged = sorted(STAGING.glob("staged_*_front.jpeg"))
pending    = [p for p in all_staged if p.name not in done_set]
if batch_lim:
    pending = pending[:batch_lim]

print(f"Staged images : {len(all_staged)} total")
print(f"Already sorted: {len(done_set)}")
print(f"To process    : {len(pending)}")
print(f"Dry-run       : {dry_run}\n")

if not pending:
    print("Nothing to sort. Run the scraper first:")
    print("  node scripts/scrape-ebay-bulk.mjs")
    sys.exit(0)

if not dry_run:
    UNVERIFIED.mkdir(parents=True, exist_ok=True)
    for g in VALID:
        (BASE / str(g)).mkdir(exist_ok=True)

# ── Main loop ─────────────────────────────────────────────────────────────────
# ── Load existing metadata.csv so we can write vision_grade back ──────────────
META_FILE = STAGING / "metadata.csv"
meta_rows = []          # list of dicts, one per CSV row
meta_by_filename = {}   # filename → row index for quick lookup
if META_FILE.exists():
    import csv as _csv
    with open(META_FILE, newline="", encoding="utf-8") as mf:
        reader = _csv.DictReader(mf)
        for row in reader:
            meta_rows.append(dict(row))
    meta_by_filename = {r["filename"]: i for i, r in enumerate(meta_rows)}
    print(f"Loaded {len(meta_rows)} rows from metadata.csv")

def save_metadata():
    if not meta_rows: return
    import csv as _csv
    cols = list(meta_rows[0].keys())
    with open(META_FILE, "w", newline="", encoding="utf-8") as mf:
        w = _csv.DictWriter(mf, fieldnames=cols, extrasaction="ignore")
        w.writeheader(); w.writerows(meta_rows)

log_rows = []
grade_counts = {g: 0 for g in VALID}
grade_counts["unknown"] = 0

for i, img_path in enumerate(pending, 1):
    pct = int(100 * i / len(pending))
    print(f"  ({i}/{len(pending)}, {pct}%) {img_path.name} ...", end=" ", flush=True)

    # Show title_grade hint from metadata if available (helps cross-check)
    meta_idx = meta_by_filename.get(img_path.name)
    title_grade = meta_rows[meta_idx].get("psa_grade_from_title","") if meta_idx is not None else ""
    if title_grade:
        print(f"[title:{title_grade}]", end=" ", flush=True)

    try:
        detected = read_grade(img_path)
    except Exception as e:
        detected = "unknown"
        print(f"API ERROR: {e}", end=" ")

    time.sleep(DELAY)

    if detected == "unknown":
        dest_dir  = UNVERIFIED
        dest_name = img_path.name
        action    = "→ unverified/"
        grade_counts["unknown"] += 1
    else:
        g         = int(detected)
        dest_dir  = BASE / str(g)
        idx       = next_index(dest_dir)
        dest_name = f"scraped_{idx:03d}_front.jpeg"
        action    = f"→ {g}/{dest_name}"
        grade_counts[g] += 1

    dest = dest_dir / dest_name
    print(action)

    log_rows.append({
        "source": img_path.name,
        "detected_grade": detected,
        "dest": str(dest.relative_to(BASE)),
        "dry_run": dry_run,
    })

    # Write vision_grade back into metadata.csv
    if meta_idx is not None:
        meta_rows[meta_idx]["vision_grade"] = detected

    if not dry_run:
        shutil.move(str(img_path), str(dest))
        mark_done(img_path.name)
        save_metadata()   # persist after every move

# ── Save log ──────────────────────────────────────────────────────────────────
with open(LOG_FILE, "a", newline="") as f:
    w = csv.DictWriter(f, fieldnames=["source","detected_grade","dest","dry_run"])
    if LOG_FILE.stat().st_size < 100: w.writeheader()   # write header on first run
    w.writerows(log_rows)

# ── Summary ───────────────────────────────────────────────────────────────────
print(f"\n{'='*55}")
print("SORT SUMMARY")
print(f"{'='*55}")
for g in sorted(VALID):
    print(f"  PSA {g:2d} : {grade_counts[g]:4d} images moved")
print(f"  Unknown: {grade_counts['unknown']:4d} images → staging/unverified/")
print(f"\nLog appended → {LOG_FILE}")
print(f"{'(dry-run — no files moved)' if dry_run else ''}")

print(f"\nFinal front image counts per grade:")
for g in sorted(VALID):
    n = len(list((BASE / str(g)).glob("*_front*.jpeg")))
    print(f"  PSA {g}: {n}")
