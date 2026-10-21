#!/usr/bin/env python3
"""Regenerate the toolbar icons from the ASX logo.

    python3 tools/make-icons.py

`src/assets/logo.png` is the source of truth (128×128). The three sizes Chrome
asks for are plain downscales of it, so the toolbar, the extensions page and
the app's brand tile are all the same mark.
"""
import os
from PIL import Image

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(HERE, 'src', 'assets')

src = Image.open(os.path.join(ASSETS, 'logo.png')).convert('RGBA')
for size in (16, 48, 128):
    out = os.path.join(ASSETS, f'icon{size}.png')
    src.resize((size, size), Image.LANCZOS).save(out, 'PNG', optimize=True)
    print('wrote', out)
