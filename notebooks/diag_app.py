"""Minimal Streamlit diagnostic — isolates which rendering layer fails.
Run:  cd notebooks && ../backend/venv/bin/streamlit run diag_app.py
Tell me which numbered sections you can see."""
import streamlit as st
import numpy as np
from PIL import Image

st.title("🔧 Streamlit diagnostic")

st.header("1 — Native text & widgets")
st.write("If you can read THIS line, native rendering + the websocket work.")
st.success("This is a green success box.")
st.button("A native button")
st.slider("A slider", 0, 10, 5)

st.header("2 — Native chart")
st.bar_chart(np.array([3, 1, 4, 1, 5, 9, 2]))

st.header("3 — Static image via st.image")
st.image(Image.new("RGB", (320, 90), (30, 111, 255)), caption="solid blue box (st.image)")

st.header("4 — Custom component (streamlit-image-coordinates)")
try:
    from streamlit_image_coordinates import streamlit_image_coordinates
    coords = streamlit_image_coordinates(Image.new("RGB", (220, 130), (229, 57, 53)), key="diag")
    st.write("component loaded OK · last click =", coords)
except Exception as e:
    st.error(f"component FAILED: {e}")

st.header("5 — Done")
st.write("If you see sections 1–4, rendering works and the issue is specific to cv_inspector.")
