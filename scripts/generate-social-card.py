#!/usr/bin/env python3
"""Generate Session Cartographer's canonical Open Graph card.

The visual encodes the real retrieval path: keyword and semantic search signals
converge through Reciprocal Rank Fusion, then resolve into a recalled trail.

Regenerate: python3 scripts/generate-social-card.py
Outputs:
  assets/og-card-1200x630.svg
  assets/og-card-1200x630.png
  explorer/public/og-card-1200x630.png
"""

from __future__ import annotations

import html
import math
from pathlib import Path
import shutil
import subprocess


WIDTH = 1200
HEIGHT = 630
BACKGROUND = "#090A0D"
CREAM = "#F5F1DE"
LIME = "#B9F45B"
CYAN = "#7FD9FF"
PINK = "#FF577D"
MUTED = "#B8B6AA"
CONTOUR = "#5B665B"

ROOT = Path(__file__).resolve().parent.parent
SVG_PATH = ROOT / "assets" / "og-card-1200x630.svg"
PNG_PATH = ROOT / "assets" / "og-card-1200x630.png"
PUBLIC_PATH = ROOT / "explorer" / "public" / "og-card-1200x630.png"


def text(
    x: int,
    y: int,
    value: str,
    size: int,
    *,
    fill: str = CREAM,
    weight: int = 700,
    family: str = "Avenir Next Condensed",
    anchor: str = "start",
    spacing: float = 0,
) -> str:
    return (
        f'<text x="{x}" y="{y}" fill="{fill}" font-family="{family}" '
        f'font-size="{size}" font-weight="{weight}" text-anchor="{anchor}" '
        f'letter-spacing="{spacing}">{html.escape(value)}</text>'
    )


def contour_lines() -> str:
    lines: list[str] = []
    for index in range(1, 13):
        radius = index * 31
        points: list[str] = []
        for degrees in range(0, 361, 4):
            angle = math.radians(degrees)
            wobble = (
                1
                + 0.07 * math.sin(3 * angle + 0.5 + index * 0.4)
                + 0.035 * math.cos(7 * angle - index * 0.7)
            )
            x = 190 + radius * wobble * math.cos(angle)
            y = 315 + radius * 0.72 * wobble * math.sin(angle)
            points.append(f"{x:.1f},{y:.1f}")
        lines.append(
            f'<polyline points="{" ".join(points)}" fill="none" '
            f'stroke="{CONTOUR}" stroke-width="2"/>'
        )
    return "\n".join(lines)


def build_svg() -> str:
    body = [
        f'<rect width="{WIDTH}" height="{HEIGHT}" fill="{BACKGROUND}"/>',
        '<defs><clipPath id="terrain"><rect width="365" height="630"/></clipPath></defs>',
        f'<g clip-path="url(#terrain)">{contour_lines()}</g>',
        # Actual retrieval grammar: two ranked signals merge through RRF.
        f'<path d="M148 500 C190 474 222 430 250 392" fill="none" stroke="{LIME}" stroke-width="7" stroke-linecap="round"/>',
        f'<path d="M148 552 C190 529 224 452 250 392" fill="none" stroke="{CYAN}" stroke-width="7" stroke-linecap="round"/>',
        f'<path d="M250 392 C365 286 482 186 650 212 S920 285 1162 94" fill="none" stroke="{PINK}" stroke-width="5" stroke-linecap="round" opacity="0.38"/>',
        f'<circle cx="148" cy="500" r="10" fill="{BACKGROUND}" stroke="{LIME}" stroke-width="4"/>',
        f'<circle cx="148" cy="552" r="10" fill="{BACKGROUND}" stroke="{CYAN}" stroke-width="4"/>',
        f'<circle cx="250" cy="392" r="13" fill="{BACKGROUND}" stroke="{PINK}" stroke-width="5"/>',
        f'<circle cx="1162" cy="94" r="10" fill="{BACKGROUND}" stroke="{PINK}" stroke-width="4"/>',
        text(124, 506, "KEYWORD", 18, fill=LIME, family="Menlo", weight=700, anchor="end"),
        text(124, 558, "SEMANTIC", 18, fill=CYAN, family="Menlo", weight=700, anchor="end"),
        text(269, 399, "RRF", 16, fill=CREAM, family="Menlo", weight=700),
        text(374, 133, "SESSION", 34, fill=LIME, spacing=12),
        text(360, 276, "CARTO", 148, weight=800, spacing=-2),
        text(360, 416, "GRAPHER", 148, weight=800, spacing=-4),
        f'<line x1="365" y1="466" x2="1126" y2="466" stroke="{LIME}" stroke-width="2"/>',
        text(
            365,
            516,
            "SEARCH YOUR CLAUDE CODE + CODEX HISTORY",
            24,
            fill=MUTED,
            weight=600,
            spacing=1.2,
        ),
        text(
            1118,
            582,
            "/remember",
            28,
            fill=CREAM,
            family="Menlo",
            weight=700,
            anchor="end",
        ),
    ]
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{WIDTH}" height="{HEIGHT}" '
        f'viewBox="0 0 {WIDTH} {HEIGHT}">\n'
        + "\n".join(body)
        + "\n</svg>\n"
    )


def main() -> None:
    renderer = shutil.which("rsvg-convert")
    if not renderer:
        raise SystemExit("rsvg-convert is required (brew install librsvg)")

    SVG_PATH.parent.mkdir(parents=True, exist_ok=True)
    PUBLIC_PATH.parent.mkdir(parents=True, exist_ok=True)
    SVG_PATH.write_text(build_svg(), encoding="utf-8")
    subprocess.run(
        [renderer, "-w", str(WIDTH), "-h", str(HEIGHT), str(SVG_PATH), "-o", str(PNG_PATH)],
        check=True,
    )
    shutil.copyfile(PNG_PATH, PUBLIC_PATH)

    print(f"Saved: {SVG_PATH}")
    print(f"Saved: {PNG_PATH}")
    print(f"Saved: {PUBLIC_PATH}")
    print(f"Size: {WIDTH}x{HEIGHT}")


if __name__ == "__main__":
    main()
