#!/usr/bin/env python3
"""
scripts/verify_scraped_grades.py

Uses Claude Vision (haiku — cheap, fast) to read the grade label from each
scraped_*_front.jpeg image and move files that are in the wrong grade folder.

Usage:
    python3 scripts/verify_scraped_grades.py [--dry-run] [--grade N]

Results are also written to: diag/grade_verification.csv
"""

import os, sys, base64, json, shutil, csv, time
from pathlib import Path
import anthropic

# ── Config ─────────────────────────────────────────────────────────────────────
BASE = Path("/Users/srinivasdoddi/srini/card-solutoin-testing/datasets/psa_graded")
VALID_GRADES = {5, 6, 7, 8, 9, 10}
MODEL = "claude-haiku-4-5"      # cheapest vision model; enough for reading a label
MAX_TOKENS = 10
DELAY = 0.3                     # seconds between API calls

PROMPT = (
    "Look at this image. If you can see a grading company label "
    "(PSA, BGS, CGC, SGC) with a numeric grade, reply with ONLY that "
    "number (e.g. 5, 6, 7, 8, 9, or 10). "
    "If no grade label is visible, or the grade is not one of those numbers, "
    "reply with exactly: unknown"
)

# ── CLI ────────────────────────────────────────────────────────────────────────
dry_run = "--dry-run" in sys.argv
grade_filter = None
if "--grade" in sys.argv:
    idx = sys.argv.index("--grade")
    grade_filter = int(sys.argv[idx + 1])

# ── Load env ───────────────────────────────────────────────────────────────────
script_dir = Path(__file__).parent.parent
for env_file in [script_dir/".env.local", script_dir/"backend/.env"]:
    try:
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, _, v = line.partition('=')
                os.environ.setdefault(k.strip(), v.strip().strip('"'))
    except FileNotFoundError:
        pass

client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY", ""))

# ── Grade-reading function ─────────────────────────────────────────────────────
def read_grade(img_path: Path) -> str:
    """Return the grade string read by Claude ('5'–'10' or 'unknown')."""
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
    # Accept only valid grade numbers or 'unknown'
    if raw in {str(g) for g in VALID_GRADES}:
        return raw
    return "unknown"

# ── Next available scraped index for a grade dir ───────────────────────────────
def next_index(grade_dir: Path) -> int:
    existing = [
        int(m.group(1))
        for p in grade_dir.glob("scraped_*_front.jpeg")
        if (m := __import__('re').match(r'scraped_(\d+)_front', p.name))
    ]
    return max(existing, default=0) + 1

# ── Main ───────────────────────────────────────────────────────────────────────
results = []
moves = []
grades_to_run = [grade_filter] if grade_filter else sorted(VALID_GRADES)

total_imgs = sum(
    len(list((BASE / str(g)).glob("scraped_*_front.jpeg")))
    for g in grades_to_run
)
print(f"Verifying {total_imgs} scraped images across grades {grades_to_run}")
print(f"Model: {MODEL}  |  Dry-run: {dry_run}\n")

for folder_grade in grades_to_run:
    grade_dir = BASE / str(folder_grade)
    imgs = sorted(grade_dir.glob("scraped_*_front.jpeg"))
    if not imgs:
        continue
    print(f"{'='*55}")
    print(f"PSA {folder_grade} folder — {len(imgs)} scraped images")
    print(f"{'='*55}")

    for img_path in imgs:
        detected = read_grade(img_path)
        time.sleep(DELAY)

        status = "✓ match"
        action = "keep"

        if detected == "unknown":
            status = "? unknown  (no visible label)"
            action = "keep"
        elif int(detected) != folder_grade:
            status = f"✗ WRONG  (label says PSA {detected}, folder says {folder_grade})"
            action = f"move→{detected}"

        print(f"  {img_path.name}  {status}")

        row = {
            "file": img_path.name,
            "folder_grade": folder_grade,
            "detected_grade": detected,
            "action": action,
        }
        results.append(row)

        if action.startswith("move") and not dry_run:
            dest_dir = BASE / detected
            dest_dir.mkdir(exist_ok=True)
            idx = next_index(dest_dir)
            dest_path = dest_dir / f"scraped_{idx:03d}_front.jpeg"
            shutil.move(str(img_path), str(dest_path))
            moves.append((img_path, dest_path))
            print(f"    → moved to {dest_path.relative_to(BASE)}")

# ── Save CSV ───────────────────────────────────────────────────────────────────
diag_dir = script_dir / "notebooks" / "diag"
diag_dir.mkdir(exist_ok=True)
csv_path = diag_dir / "grade_verification.csv"
with open(csv_path, "w", newline="") as f:
    writer = csv.DictWriter(f, fieldnames=["file","folder_grade","detected_grade","action"])
    writer.writeheader()
    writer.writerows(results)

# ── Summary ────────────────────────────────────────────────────────────────────
n_match   = sum(1 for r in results if r["action"] == "keep" and r["detected_grade"] != "unknown")
n_unknown = sum(1 for r in results if r["detected_grade"] == "unknown")
n_wrong   = sum(1 for r in results if r["action"].startswith("move"))

print(f"\n{'='*55}")
print("SUMMARY")
print(f"{'='*55}")
print(f"  Correct grade in right folder : {n_match}")
print(f"  No visible label (unknown)    : {n_unknown}  (raw card photos — kept in place)")
print(f"  Wrong grade / moved           : {n_wrong}  {'(dry-run — no files moved)' if dry_run else ''}")
print(f"\nResults saved → {csv_path}")

if dry_run and n_wrong:
    print(f"\nRe-run without --dry-run to apply the {n_wrong} moves.")
