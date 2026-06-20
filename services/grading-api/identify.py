"""
identify.py — name a trading card from a photo (Claude vision).

The Sourcing scout runs on a "photo dump" that has no listing title, so we can't reuse the
extension's scraped title for the comp keyword + worklist identity. This asks Claude to read the card
and return a structured identity (+ an eBay-style `title` used as the comp search keyword).

Mirrors grader.py's Claude call (same SDK, same base64 image block, CLAUDE_MODEL default).
"""
import os, re, json
import anthropic
import grader as G                    # reuse encode_image() + the image-block shape

MODEL = os.environ.get("IDENTIFY_MODEL", os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-5"))

_SYSTEM = (
    "You identify collectible trading cards (mainly Pokémon) from a single photo, for resale pricing. "
    "Be precise and conservative: if you cannot read a field, use null. Never invent a card you cannot see."
)

_USER = (
    "Identify this card. Return ONLY a JSON object with these keys:\n"
    '{"name": "<main card/character name, e.g. Charizard>",\n'
    ' "set": "<set name, e.g. Base Set, or null>",\n'
    ' "number": "<collector number, e.g. 4/102, or null>",\n'
    ' "year": <release year as integer, or null>,\n'
    ' "variant": "<holo | reverse holo | full art | 1st edition | promo | null>",\n'
    ' "language": "<English | Japanese | ... | null>",\n'
    ' "title": "<concise eBay-style search string combining the above, '
    'e.g. Charizard Base Set 4/102 Holo>",\n'
    ' "confidence": <0.0-1.0 how sure you are of the identification>}'
)


def _coerce(d: dict) -> dict:
    out = {k: d.get(k) for k in ("name", "set", "number", "year", "variant", "language", "title", "confidence")}
    if not out.get("title"):
        out["title"] = " ".join(str(out.get(k)) for k in ("name", "set", "number", "variant")
                                 if out.get(k)).strip()
    try:
        out["confidence"] = float(out.get("confidence")) if out.get("confidence") is not None else None
    except (TypeError, ValueError):
        out["confidence"] = None
    return out


def identify_card(img_bgr, api_key: str = None) -> dict:
    """Photo -> {name, set, number, year, variant, language, title, confidence}. Never raises; on any
    failure returns an empty-ish identity with an `error` key so the scout can still grade the card."""
    api_key = api_key or os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return {"error": "no_api_key", "title": "", "confidence": 0.0}
    try:
        enc = G.encode_image(img_bgr)
        content = [
            {"type": "image", "source": {"type": "base64",
                                         "media_type": enc["media_type"], "data": enc["data"]}},
            {"type": "text", "text": _USER},
        ]
        client = anthropic.Anthropic(api_key=api_key)
        msg = client.messages.create(model=MODEL, max_tokens=400, system=_SYSTEM,
                                     messages=[{"role": "user", "content": content}])
        raw = re.sub(r"```json|```", "", msg.content[0].text.strip()).strip()
        return _coerce(json.loads(raw))
    except json.JSONDecodeError:
        return {"error": "parse", "title": "", "confidence": 0.0}
    except Exception as e:
        return {"error": f"{type(e).__name__}: {e}", "title": "", "confidence": 0.0}
