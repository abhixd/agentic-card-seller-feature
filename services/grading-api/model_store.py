"""
model_store.py — durable per-side model loading from Supabase model_artifacts.

The grading-api reads the newest stored model at startup (and on demand) with the ANON key —
the model isn't sensitive, so model_artifacts is world-readable and only the anon URL+key are
needed here (no service-role secret on the grading-api). Every call degrades gracefully to None
(→ cv_grader falls back to the baked-in perside_lr.joblib) if Supabase isn't configured/reachable.
"""
import os, json, base64, urllib.request, urllib.error


def _conf():
    url = os.environ.get("SUPABASE_URL") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
    key = os.environ.get("SUPABASE_ANON_KEY") or os.environ.get("NEXT_PUBLIC_SUPABASE_ANON_KEY")
    return (url, key) if (url and key) else (None, None)


def latest_model_bytes(kind: str = "perside_centering"):
    """Newest stored model as raw joblib bytes (a dict {"model": pipeline}), or None."""
    url, key = _conf()
    if not url:
        return None
    q = (f"{url.rstrip('/')}/rest/v1/model_artifacts"
         f"?kind=eq.{kind}&select=model_b64&order=created_at.desc&limit=1")
    req = urllib.request.Request(q, headers={"apikey": key, "Authorization": f"Bearer {key}"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            rows = json.load(r)
    except Exception:
        return None
    if not rows or not rows[0].get("model_b64"):
        return None
    try:
        return base64.b64decode(rows[0]["model_b64"])
    except Exception:
        return None
