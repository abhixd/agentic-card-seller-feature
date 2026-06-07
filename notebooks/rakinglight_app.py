"""
rakinglight_app.py — test the RakingLight surface analysis in the browser.

Upload a phone tilt-sweep video (torch ON, rake the light across the card for ~2-3s) OR
pick a clip already dropped in embed_eval/rakinglight/. The app canonicalizes every frame
into our card rectangle, computes the SPECULAR-RESIDUAL (localized flare) map, and reports a
surface-activity score. Worn cards (scratches/dents/whitening) should light up; clean PSA10s
should stay dark.

Run: cd notebooks && KMP_DUPLICATE_LIB_OK=TRUE ../backend/venv/bin/streamlit run rakinglight_app.py --server.port 8504
"""
import os, sys, glob, tempfile
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE"); os.environ["CARD_DETECTOR"] = "seg"
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE); sys.path.insert(0, os.path.join(_HERE, "..", "backend"))
from dotenv import load_dotenv
load_dotenv(os.path.join(_HERE, "..", ".env.local"), override=True)
load_dotenv(os.path.join(_HERE, "..", "backend", ".env"), override=False)
import numpy as np, cv2, streamlit as st
import rakinglight as RL

st.set_page_config(layout="wide", page_title="RakingLight", page_icon="🔦")
st.title("🔦 RakingLight — surface analysis from a tilt-sweep")
st.caption("A single flat photo can't separate PSA9 from PSA10 (CV + fine-tuning both stall there). "
           "Raking light makes scratches/dents/whitening flare at grazing angles — this analyzes that.")


@st.cache_data(show_spinner="Canonicalizing frames + computing specular map…")
def analyze(frames_key, frame_bytes_list):
    frames = [cv2.imdecode(np.frombuffer(b, np.uint8), cv2.IMREAD_COLOR) for b in frame_bytes_list]
    canon = RL.canonicalize(frames)
    defect, diff = RL.specular_maps(canon)
    return canon, defect, diff, float(RL.activity_score(defect))


with st.sidebar:
    st.header("Input")
    src = st.radio("Source", ["Upload images", "Upload video", "Dataset clip"], horizontal=True)
    frames = None; name = None
    if src == "Upload images":
        ups = st.file_uploader("Multi-angle stills (≥5 photos of the SAME card at different "
                               "tilt/light angles)", type=["jpg", "jpeg", "png", "webp"],
                               accept_multiple_files=True)
        if ups:
            ups = sorted(ups, key=lambda f: f.name)        # filename order = sweep order
            frames = [cv2.imdecode(np.frombuffer(u.getvalue(), np.uint8), cv2.IMREAD_COLOR) for u in ups]
            frames = [f for f in frames if f is not None]
            name = f"{len(frames)} stills"
    elif src == "Upload video":
        up = st.file_uploader("Tilt-sweep video", type=["mp4", "mov", "avi", "m4v", "webm"])
        if up:
            tf = tempfile.NamedTemporaryFile(suffix=os.path.splitext(up.name)[1], delete=False)
            tf.write(up.getvalue()); tf.close()
            frames = RL.read_frames(tf.name); name = up.name
    else:
        clips = sorted(glob.glob("embed_eval/rakinglight/**/*", recursive=True))
        clips = [c for c in clips if c.lower().endswith((".mp4", ".mov", ".avi", ".m4v")) or os.path.isdir(c)]
        if clips:
            c = st.selectbox("clip", clips, format_func=lambda p: p.split("rakinglight/")[-1])
            frames = RL.read_frames(c); name = os.path.basename(c)
        else:
            st.info("No clips in embed_eval/rakinglight/ yet — drop videos in psaNN/ subfolders, or use Upload.")
    vmax = st.slider("heatmap scale", 10, 200, 80, 5, help="lower = more sensitive (more red)")

if not frames:
    st.info("Upload **≥5 multi-angle stills**, a tilt-sweep video, or pick a dataset clip in the sidebar.\n\n"
            "**Capture tip (matters a lot):** dim room, torch/lamp ON. **Keep the CARD fixed and move the LIGHT** "
            "between shots (5-12 photos) so a grazing highlight rakes across the face — *don't* move the card. "
            "Moving the card adds misalignment that the app must undo, which inflates the noise floor and weakens "
            "the signal (validated: fixed→clean≈25, re-angled→clean≈61). A slow tripod video works too. "
            "(One photo can't work — the signal IS the flare variation across light angles.)")
    st.stop()
if len(frames) < 4:
    st.error(f"Only {len(frames)} frame(s) — need ≥4-5 shots at DIFFERENT light angles (one image can't work; "
             "the signal is the flare variation across angles)."); st.stop()

try:
    keyb = [cv2.imencode(".jpg", f)[1].tobytes() for f in frames]
    canon, defect, diff, score = analyze(name + str(len(frames)), keyb)
except Exception as e:
    st.error(f"Analysis failed (seg couldn't find the card in frame 0?): {e}"); st.stop()

st.markdown(f"### {name}  ·  {len(canon)} aligned frames")
m1, m2 = st.columns([1, 3])
m1.metric("surface-activity", f"{score:.1f}", help="mean of the brightest 0.2% of localized flare; "
          "higher = more surface defects. Compare across your own slabs (worn should out-score clean).")
m2.caption("**diffuse** = baseline (median over the sweep).  **specular-residual** = localized flare "
           "(high-passed max−median) — red = where the surface flared abnormally = candidate scratch/dent/whitening.")

c1, c2 = st.columns(2)
c1.image(cv2.cvtColor(diff, cv2.COLOR_GRAY2RGB), caption="diffuse (median)", width=360)
c2.image(cv2.cvtColor(RL.overlay(diff, defect, vmax), cv2.COLOR_BGR2RGB), caption="specular-residual (red = flare)", width=360)

st.markdown("##### Sweep frames (canonicalized)")
idx = np.linspace(0, len(canon) - 1, min(6, len(canon))).astype(int)
st.image([cv2.cvtColor(canon[i], cv2.COLOR_BGR2RGB) for i in idx], width=150)
st.caption("If the highlight visibly sweeps across these frames and defects flare in the residual, the "
           "capture is good. Drop several graded cards in embed_eval/rakinglight/psaNN/ and run "
           "`python rakinglight.py` for the per-grade score table + Spearman(grade, activity).")
