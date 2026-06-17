"""config.py — load tunable centering / cb-geometry parameters from centering_config.yaml.

ROBUST BY DESIGN: a missing file, missing section/key, malformed YAML, or absent PyYAML all fall back
to the in-code default passed to `cfg(...)`. Nothing here can prevent the grading API from starting —
worst case every parameter resolves to its documented default. Loaded once and cached.

Path resolution: the CENTERING_CONFIG env var, else centering_config.yaml next to this file.
See CENTERING_CB_NOTES.md for the rationale behind each value.
"""
import os

_CONFIG = None          # cached parsed dict (or {} on any failure)
_PATH = None            # the path actually loaded (for logging/debug)


def _load():
    global _CONFIG, _PATH
    if _CONFIG is not None:
        return _CONFIG
    _CONFIG = {}
    path = os.environ.get(
        "CENTERING_CONFIG",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "centering_config.yaml"),
    )
    try:
        import yaml  # optional; defaults if unavailable
        with open(path, "r") as f:
            data = yaml.safe_load(f)
        if isinstance(data, dict):
            _CONFIG = data
            _PATH = path
    except Exception:
        _CONFIG = {}        # any failure → in-code defaults everywhere
    return _CONFIG


def cfg(section, key, default):
    """Return centering_config[section][key] coerced to type(default), or `default` on any miss
    (missing file/section/key, wrong type, parse error). `default` is the source of truth for both
    the value's type and the fallback."""
    try:
        val = _load().get(section, {}).get(key)
        if val is None:
            return default
        return type(default)(val)
    except Exception:
        return default


def config_source():
    """Path of the YAML actually loaded, or None if defaults are in effect (file missing/unreadable)."""
    _load()
    return _PATH
