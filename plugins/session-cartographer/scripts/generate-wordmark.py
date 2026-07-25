#!/usr/bin/env python3
"""Generate Session Cartographer wordmark with topo contour lines.

Regenerate: python3 scripts/generate-wordmark.py
Output: docs/wordmark.png (1200x400)
"""
from PIL import Image, ImageDraw, ImageFont
import os, math

W, H = 1200, 400
BG = (10, 10, 15)
GRID_COLOR = (55, 60, 55)          # Bumped from (35,40,35) for mobile visibility
CONTOUR_COLOR = (50, 55, 50)       # Concentric circles
CROSS_COLOR = (120, 160, 100)      # Green survey markers
TEXT_COLOR = (230, 228, 210)       # Cream/olive
SUBTITLE_COLOR = (160, 158, 140)
ACCENT_COLOR = (120, 160, 100)     # Green for "BM25 + RRF"

img = Image.new('RGB', (W, H), BG)
draw = ImageDraw.Draw(img)

# Grid lines
for x in range(0, W, 60):
    draw.line([(x, 0), (x, H)], fill=GRID_COLOR, width=1)
for y in range(0, H, 60):
    draw.line([(0, y), (W, y)], fill=GRID_COLOR, width=1)

# Concentric contour circles (topo lines) — center-left
cx, cy = 250, 200
for r in range(40, 300, 45):
    # Draw circle with slight irregularity for organic feel
    points = []
    for angle in range(0, 360, 2):
        rad = math.radians(angle)
        wobble = 1.0 + 0.03 * math.sin(angle * 0.1) * math.cos(angle * 0.07)
        px = cx + r * wobble * math.cos(rad)
        py = cy + r * wobble * math.sin(rad)
        points.append((px, py))
    if len(points) > 2:
        draw.line(points + [points[0]], fill=CONTOUR_COLOR, width=1)

# Survey crosshairs (small green + marks)
crosses = [(150, 80), (350, 120), (180, 280), (400, 250), (900, 140), (1050, 100), (870, 280)]
for x, y in crosses:
    size = 6
    draw.line([(x, y - size), (x, y + size)], fill=CROSS_COLOR, width=1)
    draw.line([(x - size, y), (x + size, y)], fill=CROSS_COLOR, width=1)

# Compass rose (top right)
cx_compass, cy_compass = 1120, 50
draw.line([(cx_compass, cy_compass - 20), (cx_compass, cy_compass + 15)], fill=CROSS_COLOR, width=1)
draw.line([(cx_compass - 12, cy_compass), (cx_compass + 12, cy_compass)], fill=CROSS_COLOR, width=1)
# N arrow
draw.polygon([(cx_compass, cy_compass - 22), (cx_compass - 4, cy_compass - 14), (cx_compass + 4, cy_compass - 14)], fill=CROSS_COLOR)

# Find fonts
FONT_PATHS = [
    '/System/Library/Fonts/Helvetica.ttc',
    '/System/Library/Fonts/Supplemental/Futura.ttc',
    '/Library/Fonts/Arial Bold.ttf',
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
]

def find_font(size, bold=False):
    for path in FONT_PATHS:
        if os.path.exists(path):
            idx = 1 if bold and path.endswith('.ttc') else 0
            try:
                return ImageFont.truetype(path, size, index=idx)
            except:
                continue
    return ImageFont.load_default()

# "SESSION" — letterspaced
session_font = find_font(32)
session_text = "S E S S I O N"
bbox = draw.textbbox((0, 0), session_text, font=session_font)
session_x = 380
session_y = 120
draw.text((session_x, session_y), session_text, fill=TEXT_COLOR, font=session_font)

# "CARTOGRAPHER" — bold, large
carto_font = find_font(90, bold=True)
carto_text = "CARTOGRAPHER"
carto_x = 375
carto_y = 155
draw.text((carto_x, carto_y), carto_text, fill=TEXT_COLOR, font=carto_font)

# "search your session history" — subtitle
sub_font = find_font(18)
draw.text((400, 270), "search your session history", fill=SUBTITLE_COLOR, font=sub_font)

# "BM25 + RRF" — accent
accent_font = find_font(18)
draw.text((850, 270), "BM25 + RRF", fill=ACCENT_COLOR, font=accent_font)

# Horizontal rule
draw.line([(380, 265), (1000, 265)], fill=GRID_COLOR, width=1)

out_path = os.path.join(os.path.dirname(__file__), '..', 'docs', 'wordmark.png')
img.save(out_path, 'PNG')
print(f"Saved: {os.path.abspath(out_path)}")
print(f"Size: {W}x{H}")
