"""Streamlit UI placeholder.

MVP target:
- one text input area
- submit button
- archive result panel
- active bucket list
- selected bucket detail panel
"""

import streamlit as st

st.set_page_config(page_title="Work Memory Agent", page_icon="🧠", layout="wide")
st.title("🧠 Personal Work Memory Agent")
st.caption("MVP skeleton. Implement app.services.archive_service.archive_user_input first.")

text = st.text_area("把碎片信息丢进来", height=180)
if st.button("归档"):
    if not text.strip():
        st.warning("请先输入内容。")
    else:
        st.info("归档流程尚未实现。请参考 docs/DEVELOPMENT_GUIDE.md。")
