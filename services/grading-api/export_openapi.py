"""
export_openapi.py — regenerate the committed contract schema from contract.py (the source of truth).

Run on the GRADING machine whenever contract.py changes:
    cd services/grading-api && python export_openapi.py
It writes packages/grading-contract/schema/grade-response.schema.json (JSON Schema) which the product
package turns into TypeScript. Also validates a representative /grade payload against the model so a
drift between the real response and the contract is caught here, not in production.
"""
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from contract import GradeResponse, CONTRACT_VERSION

OUT_DIR = os.path.normpath(os.path.join(HERE, "..", "..", "packages", "grading-contract", "schema"))
os.makedirs(OUT_DIR, exist_ok=True)

schema = GradeResponse.model_json_schema()
schema["$id"] = "https://acs/grading-contract/grade-response.schema.json"
schema["x-contract-version"] = CONTRACT_VERSION
with open(os.path.join(OUT_DIR, "grade-response.schema.json"), "w") as f:
    json.dump(schema, f, indent=2)

# Drift check: a representative response (public fields) must validate.
sample = {
    "overall_score": 9.0, "psa_equivalent": "PSA 9 MINT", "summary": "clean copy",
    "centering": {"score": 7.0, "left_right": "49/51", "top_bottom": "60/40", "reliable": True,
                  "notes": "L/R 49/51 · T/B 60/40", "content_region": {"x1": 0.04, "y1": 0.04, "x2": 0.96, "y2": 0.99},
                  "_source": "perside", "confidence": 0.82},
    "corners": {"score": 9.0, "worst_severity": 1}, "edges": {"score": 9.0, "worst_severity": 1},
    "surface": {"score": 10.0, "worst_severity": 0},
    "issues": {"corners": [], "edges": [], "surface": [], "centering": []},
    "confidence": "high", "economics": {"ev": 42.0}, "decision": {"action": "buy"},
    "pillar_visuals": {"centering": "<b64>", "edges": "<b64>", "surface": "<b64>",
                       "corners": {"TL": "<b64>", "TR": "<b64>", "BR": "<b64>", "BL": "<b64>"}},
    "pillar_zooms": {"edges": {"top": {"crop_b64": "<b64>", "flagged": ["white"]}},
                     "surface": {"scratches": {"crop_b64": "<b64>", "count": 2}},
                     "corners": {"TL": "<b64>", "TR": "<b64>", "BR": "<b64>", "BL": "<b64>"}},
    "_warped_jpeg_b64": "…", "_tier": 2,                    # internal extras must pass through, not fail
}
GradeResponse.model_validate(sample)
print(f"OK  contract v{CONTRACT_VERSION}  →  {os.path.relpath(OUT_DIR, os.path.join(HERE, '..', '..'))}/grade-response.schema.json")
print("    drift check passed (sample /grade payload validates, internal _-keys pass through)")
