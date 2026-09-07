#!/usr/bin/env python3
"""Emit the README figures in both themes.

Shared language: sticker linework, halftone offset shadows, cream / Night Gallery grounds,
thin display type, mono for file names, one terracotta accent, teal for data flow.
"""
import os, sys

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
os.makedirs(OUT, exist_ok=True)

THEMES = {
    "light": dict(
        bg="#F2EBDD", card="#FBF7EE", card2="#F3EDDF", ink="#1E2A38", muted="#5C605D",
        quiet="#8A8F8B", line="#1E2A38", teal="#2E6E73", tealwash="#D6E4E1", rust="#C96F4A",
        rustwash="#F1D9CC", sage="#C8D9C5", dot="#1E2A38", dotop="0.16", white="#FFFFFF",
        shadow="#1E2A38", shadowop="0.10", ghost="#9AA09C",
    ),
    "dark": dict(
        bg="#1A1A1A", card="#262624", card2="#2E2E2B", ink="#FAF9F7", muted="#A8ACA9",
        quiet="#7C807D", line="#FAF9F7", teal="#7FA0B4", tealwash="#26383F", rust="#D4674F",
        rustwash="#3D2A24", sage="#33403A", dot="#FAF9F7", dotop="0.12", white="#FAF9F7",
        shadow="#000000", shadowop="0.35", ghost="#5E625F",
    ),
}

THEMES["vars"] = dict(
    bg="var(--fig)", card="var(--card)", card2="var(--card2)", ink="var(--ink)", muted="var(--ink-muted)",
    quiet="var(--ink-quiet)", line="var(--ink)", teal="var(--teal)", tealwash="var(--teal-wash)", rust="var(--rust)",
    rustwash="var(--rust-wash)", sage="var(--sage)", dot="var(--ink)", dotop="0.14", white="var(--glove)",
    shadow="var(--ink)", shadowop="0.14", ghost="var(--ink-quiet)",
)

FONT = "Manrope, Inter, -apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif"
MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"


def defs(p):
    return f"""<defs>
  <pattern id="dots" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(30)">
    <circle cx="2" cy="2" r="1.25" fill="{p['dot']}" fill-opacity="{p['dotop']}"/>
  </pattern>
  <marker id="arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
    <path d="M0,0 L10,5 L0,10 z" fill="{p['teal']}"/>
  </marker>
  <marker id="arrowInk" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
    <path d="M0,0 L10,5 L0,10 z" fill="{p['ink']}"/>
  </marker>
</defs>"""


def box(p, x, y, w, h, r=16, fill=None, stroke=None, sw=3, halftone=True, dash=None):
    fill = fill or p["card"]
    stroke = stroke or p["line"]
    s = ""
    if halftone:
        s += f'<rect x="{x+7}" y="{y+7}" width="{w}" height="{h}" rx="{r}" fill="url(#dots)"/>\n'
    d = f' stroke-dasharray="{dash}"' if dash else ""
    s += f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"{d}/>\n'
    return s


def text(p, x, y, s, size=14, weight=400, fill=None, anchor="start", mono=False, ls=0, op=1, halo=False):
    fill = fill or p["ink"]
    fam = MONO if mono else FONT
    h = f' paint-order="stroke" stroke="{p["bg"]}" stroke-width="6" stroke-linejoin="round"' if halo else ""
    return (f'<text x="{x}" y="{y}" font-family="{fam}" font-size="{size}" font-weight="{weight}" '
            f'fill="{fill}" text-anchor="{anchor}" letter-spacing="{ls}" opacity="{op}"{h}>{s}</text>\n')


def eyebrow(p, x, y, s, anchor="start", fill=None):
    return text(p, x, y, s.upper(), size=11, weight=700, fill=fill or p["quiet"], anchor=anchor, ls=2.2)


def pill(p, x, y, s, fill=None, stroke=None, color=None, w=None, h=26, size=11, mono=False):
    w = w or (len(s) * 7.2 + 26)
    stroke = stroke or p["line"]
    fill = fill or "none"
    color = color or p["ink"]
    out = f'<rect x="{x}" y="{y}" width="{w:.0f}" height="{h}" rx="{h/2}" fill="{fill}" stroke="{stroke}" stroke-width="2"/>\n'
    out += text(p, x + w / 2, y + h / 2 + 4, s, size=size, weight=700 if not mono else 500, fill=color,
                anchor="middle", mono=mono, ls=0 if mono else 1.2)
    return out, w


def arrow(p, pts, label=None, label2=None, color=None, dash=None, marker="arrow", sw=2.5, lx=None, ly=None):
    color = color or p["teal"]
    d = " ".join(f"{x},{y}" for x, y in pts)
    dd = f' stroke-dasharray="{dash}"' if dash else ""
    s = f'<polyline points="{d}" fill="none" stroke="{color}" stroke-width="{sw}" stroke-linejoin="round" stroke-linecap="round" marker-end="url(#{marker})"{dd}/>\n'
    if label:
        (x0, y0), (x1, y1) = pts[0], pts[-1]
        mx = lx if lx is not None else (x0 + x1) / 2
        my = ly if ly is not None else min(y0, y1) - 10
        s += text(p, mx, my, label, size=12, weight=600, fill=p["muted"], anchor="middle")
        if label2:
            s += text(p, mx, my + 16 + (abs(y1 - y0) if abs(y1 - y0) < 3 else 0), label2, size=12, weight=500,
                      fill=p["quiet"], anchor="middle")
    return s


def mascot(p, cx, cy, scale=1.0, face=True):
    """The memory card: an index card with a face, rubber-hose arms, sneakers. Anchored at card center."""
    g = f'<g transform="translate({cx},{cy}) scale({scale})">\n'
    # shadow
    g += f'<ellipse cx="0" cy="182" rx="118" ry="9" fill="{p["shadow"]}" fill-opacity="{p["shadowop"]}"/>\n'
    # legs + sneakers
    for lx in (-32, 22):
        g += f'<rect x="{lx}" y="118" width="12" height="44" rx="6" fill="{p["ink"]}"/>\n'
        g += f'<rect x="{lx-18}" y="150" width="48" height="22" rx="11" fill="{p["white"]}" stroke="{p["line"]}" stroke-width="4"/>\n'
        g += f'<line x1="{lx-10}" y1="160" x2="{lx+22}" y2="160" stroke="{p["line"]}" stroke-width="2.5" stroke-linecap="round"/>\n'
    # arms (rubber hose)
    g += f'<path d="M-104,10 C-150,30 -160,80 -132,112" fill="none" stroke="{p["ink"]}" stroke-width="12" stroke-linecap="round"/>\n'
    g += f'<path d="M104,10 C150,30 158,70 148,96" fill="none" stroke="{p["ink"]}" stroke-width="12" stroke-linecap="round"/>\n'
    # hands (gloves)
    g += f'<circle cx="-134" cy="118" r="17" fill="{p["white"]}" stroke="{p["line"]}" stroke-width="4"/>\n'
    g += f'<circle cx="150" cy="104" r="17" fill="{p["white"]}" stroke="{p["line"]}" stroke-width="4"/>\n'
    # padlock in the right hand (private)
    g += f'<path d="M140,86 a12,12 0 0 1 24,0 v8" fill="none" stroke="{p["line"]}" stroke-width="4"/>\n'
    g += f'<rect x="134" y="92" width="36" height="28" rx="6" fill="{p["teal"]}" stroke="{p["line"]}" stroke-width="4"/>\n'
    g += f'<circle cx="152" cy="106" r="3.5" fill="{p["white"]}"/>\n'
    # card body with halftone offset
    g += f'<rect x="-98" y="-118" width="210" height="250" rx="20" fill="url(#dots)"/>\n'
    g += f'<rect x="-105" y="-125" width="210" height="250" rx="20" fill="{p["card"]}" stroke="{p["line"]}" stroke-width="5"/>\n'
    # index tab
    g += f'<rect x="-84" y="-142" width="76" height="26" rx="9" fill="{p["rust"]}" stroke="{p["line"]}" stroke-width="4"/>\n'
    # ruled line under the tab
    g += f'<line x1="-105" y1="-90" x2="105" y2="-90" stroke="{p["line"]}" stroke-width="3" stroke-opacity="0.35"/>\n'
    if face:
        for ex in (-40, 40):
            g += f'<ellipse cx="{ex}" cy="-40" rx="22" ry="26" fill="{p["white"]}" stroke="{p["line"]}" stroke-width="4"/>\n'
            g += f'<circle cx="{ex+6}" cy="-36" r="9" fill="{p["ink"]}"/>\n'
            g += f'<circle cx="{ex+9}" cy="-40" r="3" fill="{p["white"]}"/>\n'
        # brows
        g += f'<path d="M-62,-78 q22,-10 44,-2" fill="none" stroke="{p["line"]}" stroke-width="4" stroke-linecap="round"/>\n'
        g += f'<path d="M18,-80 q22,-8 44,4" fill="none" stroke="{p["line"]}" stroke-width="4" stroke-linecap="round"/>\n'
        # smile
        g += f'<path d="M-28,10 q28,26 56,0" fill="none" stroke="{p["line"]}" stroke-width="4" stroke-linecap="round"/>\n'
    # observation lines (the memory)
    for i, w in enumerate((124, 88, 150)):
        g += f'<rect x="-75" y="{44+i*22}" width="{w}" height="9" rx="4.5" fill="{p["teal"]}" fill-opacity="{0.85 - i*0.18}"/>\n'
    g += "</g>\n"
    return g


# ────────────────────────────────────────────────────────────────────────────────
def hero(p):
    W, H = 1200, 420
    s = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-label="setup-claude-memory: memory that stays yours. Persistent memory for Claude, kept in local files and synced through accounts you already own.">\n'
    s += defs(p)
    s += f'<rect width="{W}" height="{H}" fill="{p["bg"]}"/>\n'
    # left text
    s += eyebrow(p, 72, 112, "open source  ·  macOS  ·  MIT")
    s += text(p, 70, 188, "Memory that", size=66, weight=300, ls=-2)
    s += text(p, 70, 254, "stays yours.", size=66, weight=300, ls=-2)
    s += text(p, 72, 300, "Persistent memory for Claude. Plain files on your Mac,", size=17, fill=p["muted"])
    s += text(p, 72, 324, "synced through accounts you already own, no server in the middle.", size=17, fill=p["muted"])
    x = 72
    for label, fill, stroke, color in (("search-first reads", None, None, None),
                                        ("private git sync", None, None, None),
                                        ("scan before push", p["rustwash"], p["rust"], p["rust"] if p["bg"] == "#1A1A1A" else p["ink"])):
        out, w = pill(p, x, 352, label, fill=fill, stroke=stroke, color=color)
        s += out
        x += w + 10
    # right illustration
    s += f'<circle cx="930" cy="212" r="168" fill="{p["sage"]}"/>\n'
    s += f'<circle cx="930" cy="212" r="168" fill="url(#dots)"/>\n'
    # relation graph behind the card
    nodes = [(772, 96), (1102, 118), (1112, 352), (742, 300)]
    for (ax, ay), (bx, by) in ((nodes[0], nodes[1]), (nodes[1], nodes[2]), (nodes[2], nodes[3]), (nodes[3], nodes[0])):
        s += f'<line x1="{ax}" y1="{ay}" x2="{bx}" y2="{by}" stroke="{p["line"]}" stroke-width="3" stroke-dasharray="1 9" stroke-linecap="round" stroke-opacity="0.7"/>\n'
    for i, (nx, ny) in enumerate(nodes):
        fill = p["rust"] if i == 1 else p["card"]
        s += f'<circle cx="{nx}" cy="{ny}" r="{15 if i else 13}" fill="{fill}" stroke="{p["line"]}" stroke-width="4"/>\n'
    art = os.environ.get("HERO_ART")
    if art:
        # The drawn character (docs/img/art/memory-card.png) in place of the SVG mascot.
        # Used by render-png.py; the committed SVG heroes keep the vector mascot.
        s += f'<ellipse cx="930" cy="378" rx="112" ry="9" fill="{p["shadow"]}" fill-opacity="{p["shadowop"]}"/>\n'
        s += f'<image href="{art}" x="800" y="52" width="260" height="330" preserveAspectRatio="xMidYMax meet"/>\n'
    else:
        s += mascot(p, 930, 206, scale=0.92)
    s += "</svg>\n"
    return s


# ────────────────────────────────────────────────────────────────────────────────
def architecture(p):
    W, H = 1200, 640
    s = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-label="How setup-claude-memory works: your Claude talks over MCP to two servers from this package, which read and write plain files in your memory folder; the folder syncs through iCloud Drive by default or a private GitHub repo you own, with a secret scan before every push. An optional shared family folder is read before family questions.">\n'
    s += defs(p)
    s += f'<rect width="{W}" height="{H}" fill="{p["bg"]}"/>\n'
    # column eyebrows
    s += eyebrow(p, 145, 62, "Your Claude", anchor="middle")
    s += eyebrow(p, 460, 62, "Two MCP servers, this package", anchor="middle")
    s += eyebrow(p, 760, 62, "Your files", anchor="middle")
    s += eyebrow(p, 1060, 62, "Sync, your accounts", anchor="middle")

    # C1 Claude
    s += box(p, 40, 120, 210, 200)
    s += text(p, 145, 158, "Claude", size=22, weight=300, anchor="middle")
    for i, lbl in enumerate(("Claude Desktop", "Claude Code")):
        s += f'<rect x="62" y="{182+i*52}" width="166" height="36" rx="10" fill="{p["card2"]}" stroke="{p["line"]}" stroke-width="2"/>\n'
        s += text(p, 145, f"{206+i*52}", lbl, size=13, weight=600, anchor="middle")
    s += text(p, 145, 302, "reads ~/.claude/CLAUDE.md", size=11, fill=p["quiet"], anchor="middle", mono=True)

    # C2 servers
    s += box(p, 330, 100, 260, 110)
    s += text(p, 348, 130, "aim-memory-server", size=14, weight=600, mono=True)
    s += text(p, 348, 154, "Knowledge graph. Facts, status, relations.", size=12, fill=p["muted"])
    s += text(p, 348, 172, "Search returns matching lines, never a", size=12, fill=p["muted"])
    s += text(p, 348, 188, "whole entity. Writes are atomic.", size=12, fill=p["muted"])
    s += box(p, 330, 250, 260, 110)
    s += text(p, 348, 280, "aim-deep-context-server", size=14, weight=600, mono=True)
    s += text(p, 348, 304, "Long-form archive. Session notes,", size=12, fill=p["muted"])
    s += text(p, 348, 322, "decisions, research. Keyword and", size=12, fill=p["muted"])
    s += text(p, 348, 338, "meaning-based search, on your Mac.", size=12, fill=p["muted"])

    # C3 files
    s += box(p, 660, 100, 200, 260)
    s += text(p, 760, 132, "Claude Memory/", size=14, weight=600, anchor="middle", mono=True)
    files = ("memory.jsonl", "memory-&lt;ctx&gt;.jsonl", "deep/index.json", "deep/*.md", "config.json")
    for i, f in enumerate(files):
        s += f'<rect x="680" y="{150+i*38}" width="160" height="28" rx="8" fill="{p["card2"]}"/>\n'
        s += text(p, 692, f"{169+i*38}", f, size="11.5", fill=p["ink"], mono=True)
    s += text(p, 760, 350, "plain text, yours to open", size=11, fill=p["quiet"], anchor="middle")

    # C4 sync
    s += box(p, 960, 100, 200, 110)
    s += text(p, 1060, 130, "iCloud Drive", size=15, weight=600, anchor="middle")
    s += text(p, 1060, 150, "the default, your Apple account", size=11.5, fill=p["muted"], anchor="middle")
    s += text(p, 1060, 176, "your other Macs see it", size=11, fill=p["quiet"], anchor="middle")
    s += text(p, 1060, 192, "in about a minute", size=11, fill=p["quiet"], anchor="middle")

    s += box(p, 960, 236, 200, 152)
    s += text(p, 1060, 264, "Private GitHub repo", size=15, weight=600, anchor="middle")
    s += text(p, 1060, 283, "npx setup-claude-memory --git", size=10.5, fill=p["muted"], anchor="middle", mono=True)
    s += f'<rect x="984" y="298" width="152" height="22" rx="11" fill="{p["rustwash"]}" stroke="{p["rust"]}" stroke-width="1.5"/>\n'
    s += text(p, 1060, 313, "SECRET SCAN ON PUSH", size=8.5, weight=700, fill=p["rust"], anchor="middle", ls=1)
    s += f'<rect x="984" y="326" width="152" height="22" rx="11" fill="{p["tealwash"]}" stroke="{p["teal"]}" stroke-width="1.5"/>\n'
    s += text(p, 1060, 341, "MERGES BY MEANING", size=8.5, weight=700, fill=p["teal"], anchor="middle", ls=1)
    s += text(p, 1060, 366, "a second Mac runs the same", size=11, fill=p["quiet"], anchor="middle")
    s += text(p, 1060, 380, "command and joins", size=11, fill=p["quiet"], anchor="middle")

    # arrows Claude -> servers
    s += f'<line x1="250" y1="155" x2="322" y2="155" stroke="{p["teal"]}" stroke-width="2.5" marker-start="url(#arrow)" marker-end="url(#arrow)"/>\n'
    s += text(p, 286, 142, "MCP", size=11, weight=700, fill=p["muted"], anchor="middle", ls=1)
    s += f'<line x1="250" y1="305" x2="322" y2="305" stroke="{p["teal"]}" stroke-width="2.5" marker-start="url(#arrow)" marker-end="url(#arrow)"/>\n'
    s += text(p, 286, 292, "MCP", size=11, weight=700, fill=p["muted"], anchor="middle", ls=1)
    # servers -> files
    s += f'<line x1="590" y1="155" x2="652" y2="155" stroke="{p["teal"]}" stroke-width="2.5" marker-start="url(#arrow)" marker-end="url(#arrow)"/>\n'
    s += text(p, 621, 142, "read / write", size=11, weight=600, fill=p["muted"], anchor="middle")
    s += f'<line x1="590" y1="305" x2="652" y2="305" stroke="{p["teal"]}" stroke-width="2.5" marker-start="url(#arrow)" marker-end="url(#arrow)"/>\n'
    s += text(p, 621, 292, "read / write", size=11, weight=600, fill=p["muted"], anchor="middle")
    # files -> sync
    s += arrow(p, [(860, 148), (952, 148)], color=p["teal"], sw=2.5)
    s += text(p, 906, 136, "syncs", size=11, weight=600, fill=p["muted"], anchor="middle")
    s += arrow(p, [(860, 300), (952, 300)], color=p["teal"], sw=2.5)
    s += text(p, 906, 288, "commits", size=11, weight=600, fill=p["muted"], anchor="middle")
    s += text(p, 906, 318, "every 15 min", size=10.5, fill=p["quiet"], anchor="middle")
    s += text(p, 906, 226, "or", size=11, weight=700, fill=p["quiet"], anchor="middle")
    s += f'<line x1="906" y1="160" x2="906" y2="212" stroke="{p["quiet"]}" stroke-width="1.5" stroke-dasharray="2 6" stroke-linecap="round"/>\n'
    s += f'<line x1="906" y1="236" x2="906" y2="284" stroke="{p["quiet"]}" stroke-width="1.5" stroke-dasharray="2 6" stroke-linecap="round"/>\n'

    # family band
    s += eyebrow(p, 460, 468, "Optional, shared with family", anchor="middle")
    s += box(p, 330, 486, 530, 96, dash="8 6", halftone=False)
    s += text(p, 348, 516, "Shared iCloud folder/Claude/Family Memory/", size=13, weight=600, mono=True)
    s += text(p, 348, 538, "A shared iCloud folder both partners' Claudes read before answering", size=12, fill=p["muted"])
    s += text(p, 348, 556, "family questions: insurance, house, pets, shared money. Markdown, append-only log.", size=12, fill=p["muted"])
    s += arrow(p, [(145, 320), (145, 534), (322, 534)], color=p["teal"], dash="6 6", sw=2.5)
    s += text(p, 232, 522, "routed by CLAUDE.md", size=11, weight=600, fill=p["muted"], anchor="middle")

    s += "</svg>\n"
    return s


# ────────────────────────────────────────────────────────────────────────────────
def datalives(p):
    W, H = 1200, 520
    s = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-label="Where your memory goes: it is stored on your Mac as plain files, synced by your own iCloud or private GitHub account, and sent to Anthropic with each conversation the same as anything you type. There is no server in the middle; nothing phones home.">\n'
    s += defs(p)
    s += f'<rect width="{W}" height="{H}" fill="{p["bg"]}"/>\n'
    cy = 262
    s += f'<circle cx="190" cy="{cy}" r="128" fill="{p["sage"]}"/>\n'
    s += f'<circle cx="190" cy="{cy}" r="128" fill="url(#dots)"/>\n'
    s += mascot(p, 190, cy - 6, scale=0.66)
    s += eyebrow(p, 190, cy + 186, "Your memory", anchor="middle")

    cols = [
        (40, "Your Mac", "stored as", "Plain files you can open, read, or edit any time.",
         "Delete a line to forget it. Delete the file to start over."),
        (150, "Your accounts", "synced by", "iCloud Drive by default, or a private GitHub repo you own.",
         "Nobody else has a login. Not the people who wrote this."),
        (260, "Anthropic, with each conversation", "sent with", "The same as anything you type into Claude. Your plan's",
         "data policy is the one that applies, and it is the only third party."),
    ]
    for y, title, lbl, l1, l2 in cols:
        s += box(p, 440, y, 480, 96)
        s += text(p, 460, y + 30, title, size=16, weight=600)
        s += text(p, 460, y + 54, l1, size=12.5, fill=p["muted"])
        s += text(p, 460, y + 72, l2, size=12.5, fill=p["muted"])
        x0, y0, x1, y1 = 330, cy, 432, y + 48
        s += arrow(p, [(x0, y0), (x1, y1)], color=p["teal"], sw=2.5)
        t = 0.62
        s += text(p, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t + 4, lbl, size=11, weight=700, fill=p["muted"], anchor="middle", halo=True)

    # the row that does not exist
    y = 370
    s += box(p, 440, y, 480, 96, fill="none", stroke=p["ghost"], dash="7 7", halftone=False, sw=2)
    s += text(p, 460, y + 30, "A server in the middle", size=16, weight=600, fill=p["ghost"])
    s += text(p, 460, y + 54, "Does not exist. Nothing phones home, nothing is collected,", size=12.5, fill=p["ghost"])
    s += text(p, 460, y + 72, "and the code that proves it is the code in this repo.", size=12.5, fill=p["ghost"])
    x0, y0, x1, y1 = 330, cy, 400, y + 48
    s += f'<line x1="{x0}" y1="{y0}" x2="{x1}" y2="{y1}" stroke="{p["ghost"]}" stroke-width="2" stroke-dasharray="3 8" stroke-linecap="round" opacity="0.8"/>\n'
    s += f'<circle cx="{x1+12}" cy="{y1+8}" r="11" fill="{p["bg"]}" stroke="{p["rust"]}" stroke-width="2.5"/>\n'
    s += f'<line x1="{x1+5}" y1="{y1+1}" x2="{x1+19}" y2="{y1+15}" stroke="{p["rust"]}" stroke-width="2.5" stroke-linecap="round"/>\n'
    s += text(p, x0 + (x1 - x0) * 0.5, y0 + (y1 - y0) * 0.5 - 8, "never", size=11, weight=700, fill=p["rust"], anchor="middle", halo=True)
    s += "</svg>\n"
    return s


def person(p, cx, cy, label):
    g = f'<circle cx="{cx}" cy="{cy-26}" r="20" fill="{p["card"]}" stroke="{p["line"]}" stroke-width="4"/>\n'
    g += f'<path d="M{cx-38},{cy+34} a38,38 0 0 1 76,0 z" fill="{p["card"]}" stroke="{p["line"]}" stroke-width="4"/>\n'
    g += f'<circle cx="{cx-7}" cy="{cy-30}" r="2.6" fill="{p["ink"]}"/><circle cx="{cx+7}" cy="{cy-30}" r="2.6" fill="{p["ink"]}"/>\n'
    g += f'<path d="M{cx-7},{cy-19} q7,6 14,0" fill="none" stroke="{p["line"]}" stroke-width="2.5" stroke-linecap="round"/>\n'
    g += text(p, cx, cy + 62, label, size=13, weight=600, anchor="middle")
    return g


def panels(p, W):
    s = box(p, 40, 70, 400, 250)
    s += eyebrow(p, 66, 104, "Work")
    s += text(p, 66, 138, "The company's Claude", size=20, weight=300)
    s += text(p, 66, 164, "Managed and locked down by IT. Outlook, Teams,", size=12.5, fill=p["muted"])
    s += text(p, 66, 182, "board material, deals. Everything here stays here.", size=12.5, fill=p["muted"])
    x = 66
    for lbl in ("Outlook", "company data", "IT policy"):
        out, w = pill(p, x, 210, lbl, fill=p["card2"]); s += out; x += w + 8
    s += f'<path d="M382,100 a14,14 0 0 1 28,0 v10" fill="none" stroke="{p["line"]}" stroke-width="3.5"/>\n'
    s += f'<rect x="374" y="108" width="44" height="34" rx="7" fill="{p["card2"]}" stroke="{p["line"]}" stroke-width="3.5"/>\n'

    s += box(p, W - 440, 70, 400, 250)
    s += eyebrow(p, W - 414, 104, "Personal")
    s += text(p, W - 414, 138, "Your own Claude", size=20, weight=300)
    s += text(p, W - 414, 164, "A personal Mac and a personal account.", size=12.5, fill=p["muted"])
    s += text(p, W - 414, 182, "Your memory, your assistant, Persona.", size=12.5, fill=p["muted"])
    x = W - 414
    for lbl in ("your memory", "your assistant", "Persona"):
        out, w = pill(p, x, 210, lbl, fill=p["card2"]); s += out; x += w + 8
    s += mascot(p, W - 96, 116, scale=0.20, face=True)
    return s


def boundary(p):
    W, H = 1200, 400
    s = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-label="Two separate Claudes: one managed by the company IT team, and your own, on a personal Mac. Nothing connects them. You are the bridge, carrying context by hand.">\n'
    s += defs(p)
    s += f'<rect width="{W}" height="{H}" fill="{p["bg"]}"/>\n'
    s += panels(p, W)
    s += f'<line x1="600" y1="40" x2="600" y2="360" stroke="{p["quiet"]}" stroke-width="2" stroke-dasharray="4 10" stroke-linecap="round"/>\n'
    s += person(p, 600, 190, "you")
    s += arrow(p, [(440, 150), (556, 168)], color=p["ink"], marker="arrowInk", dash="6 6", sw=2)
    s += text(p, 498, 146, "what you learned at work", size=11, weight=600, fill=p["muted"], anchor="middle", halo=True)
    s += arrow(p, [(644, 168), (756, 150)], color=p["ink"], marker="arrowInk", dash="6 6", sw=2)
    s += text(p, 702, 146, "what you choose to tell it", size=11, weight=600, fill=p["muted"], anchor="middle", halo=True)
    s += text(p, 600, 352, "no wire between them. you carry context by hand.", size=12, weight=600, fill=p["muted"], anchor="middle", halo=True)
    s += "</svg>\n"
    return s


def bridge(p):
    W, H = 1200, 520
    s = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-label="Later, with IT at the table: a one-way bridge. IT owns an allowlist gate on the work side. Approved categories land in a receiving folder on the personal side, you approve each item, and only then does your assistant see it. Nothing flows back.">\n'
    s += defs(p)
    s += f'<rect width="{W}" height="{H}" fill="{p["bg"]}"/>\n'
    s += panels(p, W)
    s += person(p, 600, 190, "you")
    # the bridge along the bottom
    y = 420
    s += arrow(p, [(240, 320), (240, y), (322, y)], color=p["teal"], sw=3)
    s += f'<rect x="330" y="{y-30}" width="180" height="60" rx="12" fill="{p["rustwash"]}" stroke="{p["rust"]}" stroke-width="3"/>\n'
    s += text(p, 420, y - 6, "ALLOWLIST GATE", size=11, weight=700, fill=p["rust"], anchor="middle", ls=1.5)
    s += text(p, 420, y + 14, "built and owned by IT", size=11, fill=p["muted"], anchor="middle")
    s += arrow(p, [(510, y), (582, y)], color=p["teal"], sw=3)
    s += f'<rect x="590" y="{y-30}" width="170" height="60" rx="12" fill="{p["card"]}" stroke="{p["line"]}" stroke-width="3"/>\n'
    s += text(p, 675, y - 6, "RECEIVING LANE", size=11, weight=700, fill=p["ink"], anchor="middle", ls=1.5)
    s += text(p, 675, y + 14, "a folder on your side", size=11, fill=p["muted"], anchor="middle")
    s += arrow(p, [(760, y), (832, y)], color=p["teal"], sw=3)
    s += f'<rect x="840" y="{y-30}" width="150" height="60" rx="12" fill="{p["tealwash"]}" stroke="{p["teal"]}" stroke-width="3"/>\n'
    s += text(p, 915, y - 6, "YOU APPROVE", size=11, weight=700, fill=p["teal"], anchor="middle", ls=1.5)
    s += text(p, 915, y + 14, "each item, every time", size=11, fill=p["muted"], anchor="middle")
    s += arrow(p, [(990, y), (1060, y), (1060, 328)], color=p["teal"], sw=3)
    s += text(p, 600, 486, "one way. only what is already public or purely logistical. nothing flows back.", size=12, weight=600, fill=p["muted"], anchor="middle", halo=True)
    s += text(p, 275, 372, "only", size=11, weight=700, fill=p["teal"], anchor="middle", halo=True)
    s += text(p, 275, 388, "allowed", size=11, weight=700, fill=p["teal"], anchor="middle", halo=True)
    s += text(p, 275, 404, "categories", size=11, weight=700, fill=p["teal"], anchor="middle", halo=True)
    s += "</svg>\n"
    return s


def dayflow(p):
    W, H = 1200, 330
    s = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-label="A day with your assistant: a morning brief lands in your Discord at 6:30, you reply from your phone during the day, it acts inside the rules you set and flags everything else, and an evening digest closes the loop. A needs-you list carries anything waiting on you.">\n'
    s += defs(p)
    s += f'<rect width="{W}" height="{H}" fill="{p["bg"]}"/>\n'
    y = 150
    s += f'<line x1="80" y1="{y}" x2="1120" y2="{y}" stroke="{p["line"]}" stroke-width="3" stroke-linecap="round"/>\n'
    stops = [
        (170, "6:30 AM", "The brief", "What today holds, what is overdue,", "what needs you. Posted to your Discord."),
        (450, "During the day", "You reply from your phone", "Log a thing, ask a question,", "give a decision. One line is enough."),
        (730, "Right after", "It acts, or it flags", "Inside the rules you wrote: acts.", "Anything that sends, spends, or deletes: asks."),
        (1010, "8:00 PM", "The digest", "What moved, what did not,", "what is waiting on you tomorrow."),
    ]
    for i, (x, when, title, l1, l2) in enumerate(stops):
        accent = i == 2
        s += f'<circle cx="{x}" cy="{y}" r="18" fill="{p["rust"] if accent else p["card"]}" stroke="{p["line"]}" stroke-width="4"/>\n'
        s += eyebrow(p, x, y - 40, when, anchor="middle")
        s += text(p, x, y + 52, title, size=15, weight=600, anchor="middle")
        s += text(p, x, y + 74, l1, size=12, fill=p["muted"], anchor="middle")
        s += text(p, x, y + 90, l2, size=12, fill=p["muted"], anchor="middle")
    # phone chip at stop 2
    s += f'<rect x="{450-16}" y="{y-112}" width="32" height="52" rx="8" fill="{p["card"]}" stroke="{p["line"]}" stroke-width="3"/>\n'
    s += f'<line x1="{450-6}" y1="{y-68}" x2="{450+6}" y2="{y-68}" stroke="{p["line"]}" stroke-width="2.5" stroke-linecap="round"/>\n'
    # needs-you list
    out, w = pill(p, 60, 268, "needs you: a running list it keeps, so nothing waiting on you gets lost", fill=p["tealwash"], stroke=p["teal"], color=p["teal"], h=30, size=11.5)
    s += out
    s += "</svg>\n"
    return s


# ────────────────────────────────────────────────────────────────────────────────
def filechip(p, x, y, w, label, fill=None):
    out = f'<rect x="{x}" y="{y}" width="{w}" height="30" rx="8" fill="{fill or p["card2"]}" stroke="{p["line"]}" stroke-width="2"/>\n'
    out += text(p, x + 14, y + 20, label, size=12, mono=True)
    return out


def macbox(p, x, y, title, note):
    s = box(p, x, y, 300, 190)
    s += text(p, x + 20, y + 36, title, size=20, weight=300)
    s += filechip(p, x + 20, y + 58, 260, "memory.jsonl")
    s += filechip(p, x + 20, y + 96, 260, "deep/*.md")
    s += text(p, x + 20, y + 160, note, size=12, fill=p["quiet"])
    return s


def gitsync(p):
    W, H = 1200, 470
    s = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-label="Memory in git: each of your Macs pushes to one private GitHub repo you own every 15 minutes and pulls the other Mac\'s writes. A secret scan blocks any push containing a credential, a merge driver merges two Macs\' writes by meaning, and a second Mac joins by running the same command rather than cloning by hand.">\n'
    s += defs(p)
    s += f'<rect width="{W}" height="{H}" fill="{p["bg"]}"/>\n'
    s += eyebrow(p, 190, 62, "Your first Mac", anchor="middle")
    s += eyebrow(p, 600, 62, "One private repo, your GitHub login", anchor="middle")
    s += eyebrow(p, 1010, 62, "Your second Mac", anchor="middle")
    s += macbox(p, 40, 90, "Mac A", "writes locally, syncs in the background")
    s += macbox(p, 860, 90, "Mac B", "same command, joins the same repo")
    # repo
    s += box(p, 450, 90, 300, 190)
    s += text(p, 600, 126, "Private GitHub repo", size=20, weight=300, anchor="middle")
    s += text(p, 600, 150, "github.com/you/claude-memory", size=11.5, fill=p["quiet"], anchor="middle", mono=True)
    out, w1 = pill(p, 0, 0, "private"); out, w2 = pill(p, 0, 0, "you own it")
    x = 600 - (w1 + w2 + 8) / 2
    o, _ = pill(p, x, 176, "private", fill=p["card2"]); s += o
    o, _ = pill(p, x + w1 + 8, 176, "you own it", fill=p["card2"]); s += o
    s += text(p, 600, 232, "versioned. every change is a commit you can read", size=12, fill=p["quiet"], anchor="middle")
    s += text(p, 600, 250, "and revert. only you have a login.", size=12, fill=p["quiet"], anchor="middle")
    # arrows
    for x0, x1 in ((340, 442), (860, 758)):
        s += arrow(p, [(x0, 150), (x1, 150)], label="push, 15 min")
        s += arrow(p, [(x1, 220), (x0, 220)], label="pull", ly=246)
    # the three rules
    rules = [
        (40, "Scan before push", p["rust"], p["rustwash"], p["rust"] if p["bg"] == "#1A1A1A" else p["ink"],
         "A password, key, or token blocks the push until you", "remove it. Personal data is reported, never blocks."),
        (420, "Merges by meaning", p["teal"], p["tealwash"], p["teal"],
         "Two Macs writing at once merge entity by entity,", "observations as a set. No conflict markers, ever."),
        (800, "Join, do not clone", p["line"], p["card2"], p["ink"],
         "The second Mac runs the same command and joins. A hand", "clone misses the merge driver and falls back to text merge."),
    ]
    for x, title, stroke, fill, color, l1, l2 in rules:
        s += box(p, x, 330, 360, 108)
        o, _ = pill(p, x + 20, 348, title, fill=fill, stroke=stroke, color=color); s += o
        s += text(p, x + 20, 400, l1, size=12.5, fill=p["muted"])
        s += text(p, x + 20, 418, l2, size=12.5, fill=p["muted"])
    s += "</svg>\n"
    return s


def obsbar(p, x, y, w, kind):
    if kind == "live":
        return f'<rect x="{x}" y="{y}" width="{w}" height="10" rx="5" fill="{p["teal"]}" fill-opacity="0.8"/>\n'
    if kind == "done":
        return (f'<rect x="{x}" y="{y}" width="{w}" height="10" rx="5" fill="{p["sage"]}" stroke="{p["quiet"]}" stroke-width="1"/>\n'
                f'<circle cx="{x-12}" cy="{y+5}" r="5" fill="none" stroke="{p["quiet"]}" stroke-width="1.5"/>\n'
                f'<path d="M{x-14.5},{y+5} l2,2 l4,-4" fill="none" stroke="{p["quiet"]}" stroke-width="1.5" stroke-linecap="round"/>\n')
    return (f'<rect x="{x}" y="{y}" width="{w}" height="10" rx="5" fill="{p["rustwash"]}" stroke="{p["rust"]}" stroke-width="1.5"/>\n'
            f'<circle cx="{x-12}" cy="{y+5}" r="5" fill="none" stroke="{p["rust"]}" stroke-width="1.5"/>\n'
            f'<line x1="{x-12}" y1="{y+2.5}" x2="{x-12}" y2="{y+6}" stroke="{p["rust"]}" stroke-width="1.5" stroke-linecap="round"/><circle cx="{x-12}" cy="{y+8}" r="0.8" fill="{p["rust"]}"/>\n')


def compact(p):
    W, H = 1200, 430
    s = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-label="Archiving with --compact: a project entity full of finished status notes; the tool proposes moves grouped by why, you approve each group, and the finished notes move to an archive entity where they stay searchable. Anything holding the last copy of an identifier is flagged and never bulk-approved. Nothing is ever deleted.">\n'
    s += defs(p)
    s += f'<rect width="{W}" height="{H}" fill="{p["bg"]}"/>\n'
    s += eyebrow(p, 60, 62, "Before")
    s += eyebrow(p, 600, 62, "You approve each group", anchor="middle")
    s += eyebrow(p, 810, 62, "After")
    # before
    s += box(p, 40, 84, 380, 256)
    s += text(p, 62, 116, "A project entity, months in", size=16, weight=600)
    s += text(p, 62, 136, "981 observations, 809,000 characters", size=11.5, fill=p["quiet"], mono=True)
    rows = [("live", 200), ("done", 150), ("done", 230), ("live", 120), ("done", 180), ("flag", 210), ("done", 160), ("live", 240)]
    for i, (k, w) in enumerate(rows):
        s += obsbar(p, 82, 156 + i * 20, w, k)
    s += text(p, 62, 328, "teal: still true.  checked: finished status notes.  red: holds an identifier.", size=11, fill=p["quiet"])
    # proposal
    s += box(p, 470, 120, 260, 180, dash="8 6", sw=2)
    s += text(p, 600, 152, "Proposed moves", size=15, weight=600, anchor="middle")
    y = 170
    for lbl in ("shipped  ·  12", "superseded  ·  7", "done, dated  ·  31"):
        o, w = pill(p, 0, 0, lbl); o, _ = pill(p, 600 - w / 2, y, lbl, fill=p["card2"]); s += o; y += 34
    s += text(p, 600, 288, "grouped by why. approved one group at a time.", size=11.5, fill=p["quiet"], anchor="middle")
    s += arrow(p, [(420, 210), (462, 210)], label="--compact", ly=194)
    s += arrow(p, [(730, 170), (782, 150)], label="what stays", ly=136)
    s += arrow(p, [(730, 250), (782, 280)], label="what moves", ly=300)
    # after: entity
    s += box(p, 790, 84, 370, 110)
    s += text(p, 812, 116, "The entity, after", size=16, weight=600)
    for i, w in enumerate((200, 120, 240)):
        s += obsbar(p, 832, 130 + i * 16, w, "live")
    s += text(p, 812, 184, "what is still true. fast to read, small to send.", size=11.5, fill=p["quiet"])
    # after: archive
    s += box(p, 790, 214, 370, 126, fill=p["card2"])
    s += text(p, 812, 246, "Archive entity", size=16, weight=600)
    for i, w in enumerate((150, 230, 180, 160)):
        s += obsbar(p, 832, 260 + i * 16, w, "done")
    s += text(p, 812, 330, "still searchable. in git, every pass is one revert away.", size=11.5, fill=p["quiet"])
    # footer rules
    o, w = pill(p, 40, 376, "nothing is ever deleted", fill=p["tealwash"], stroke=p["teal"], color=p["teal"], h=30, size=11.5); s += o
    o, _ = pill(p, 40 + w + 12, 376, "the last copy of an identifier is flagged and never bulk-approved", fill=p["rustwash"], stroke=p["rust"], color=p["rust"] if p["bg"] == "#1A1A1A" else p["ink"], h=30, size=11.5); s += o
    s += "</svg>\n"
    return s


def searchfirst(p):
    W, H = 1200, 310
    s = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-label="Search-first reads: against the same 981-observation entity, a naive lookup returned the whole entity, about 809,000 characters, while a search returns only the matching lines, about 13,000 characters, and reports how many matched versus how many it returned.">\n'
    s += defs(p)
    s += f'<rect width="{W}" height="{H}" fill="{p["bg"]}"/>\n'
    s += eyebrow(p, 60, 56, "The same entity. 981 observations.")
    # row 1: naive
    s += text(p, 60, 106, "a naive lookup", size=13, weight=600, fill=p["muted"])
    o, w = pill(p, 200, 88, 'get("Content_Strategy_App")', fill=p["card2"], mono=True, h=30, size=12); s += o
    s += arrow(p, [(200 + w + 12, 103), (200 + w + 60, 103)])
    bx = 200 + w + 72
    s += f'<rect x="{bx+6}" y="{94}" width="{1140-bx}" height="20" rx="10" fill="url(#dots)"/>\n'
    s += f'<rect x="{bx}" y="88" width="{1140-bx}" height="30" rx="15" fill="{p["rustwash"]}" stroke="{p["rust"]}" stroke-width="2"/>\n'
    s += text(p, bx + 18, 108, "the whole entity. ~809,000 characters. the context window is gone.", size=12.5, weight=600, fill=p["rust"] if p["bg"] == "#1A1A1A" else p["ink"])
    # row 2: search
    s += text(p, 60, 196, "search-first", size=13, weight=600, fill=p["muted"])
    o, w2 = pill(p, 200, 178, 'search("invite codes")', fill=p["card2"], mono=True, h=30, size=12); s += o
    s += arrow(p, [(200 + w2 + 12, 193), (200 + w2 + 60, 193)])
    bx2 = 200 + w2 + 72
    bw = round((1140 - bx) * 13 / 809)
    s += f'<rect x="{bx2}" y="178" width="{max(bw, 30)}" height="30" rx="15" fill="{p["tealwash"]}" stroke="{p["teal"]}" stroke-width="2"/>\n'
    s += text(p, bx2 + max(bw, 30) + 14, 198, "only the matching lines. ~13,000 characters.", size=12.5, weight=600, fill=p["teal"])
    s += text(p, bx2, 232, "and it says how many matched against how many it returned, so the assistant knows when to narrow.", size=12, fill=p["quiet"])
    s += text(p, 60, 282, "Every response has a character budget. Over budget, the server returns fewer lines. It never cuts a response mid-JSON.", size=12, fill=p["quiet"])
    s += "</svg>\n"
    return s


def family(p):
    W, H = 1200, 430
    s = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-label="Family memory: you and your partner each keep your own private memory, and both of your Claudes read one shared iCloud folder before answering a family question. It holds a markdown file of shared facts, a facts.json for lookups, and an append-only changelog. Writes go one section at a time so two people never overwrite each other.">\n'
    s += defs(p)
    s += f'<rect width="{W}" height="{H}" fill="{p["bg"]}"/>\n'
    s += person(p, 150, 150, "You")
    s += person(p, 1050, 150, "Your partner")
    for cx in (150, 1050):
        s += box(p, cx - 110, 250, 220, 96)
        s += text(p, cx, 280, "own memory", size=13, weight=600, anchor="middle")
        s += text(p, cx, 300, "private. never shared.", size=11.5, fill=p["quiet"], anchor="middle")
        s += f'<path d="M{cx-9},{318} a9,9 0 0 1 18,0 v6" fill="none" stroke="{p["line"]}" stroke-width="2.5"/>\n'
        s += f'<rect x="{cx-14}" y="{323}" width="28" height="18" rx="4" fill="{p["teal"]}" stroke="{p["line"]}" stroke-width="2.5"/>\n'
    # shared folder
    s += box(p, 340, 90, 520, 220, dash="10 7", sw=3)
    s += eyebrow(p, 600, 122, "Shared, both of you", anchor="middle")
    s += text(p, 600, 150, "Shared iCloud folder/Claude/Family Memory/", size=14, weight=600, anchor="middle", mono=True)
    chips = (("FAMILY_MEMORY.md", 366, "shared facts, one section per topic"),
             ("facts.json", 366, "deductibles, plan ids, claim phones"),
             ("changelog.md", 366, "append-only. who changed what, when"))
    for i, (name, x, note) in enumerate(chips):
        y = 172 + i * 40
        s += filechip(p, x, y, 170, name)
        s += text(p, x + 186, y + 20, note, size=12, fill=p["muted"])
    # arrows
    s += arrow(p, [(214, 150), (330, 150)], label="reads before a", label2="family question", ly=128)
    s += arrow(p, [(986, 150), (870, 150)], label="reads before a", label2="family question", ly=128)
    o, w = pill(p, 0, 0, "writes go one section at a time, so two people never overwrite each other", h=30, size=11.5)
    o, _ = pill(p, 600 - w / 2, 322, "writes go one section at a time, so two people never overwrite each other", fill=p["tealwash"], stroke=p["teal"], color=p["teal"], h=30, size=11.5); s += o
    s += text(p, 600, 380, "Routed by a block the installer adds to ~/.claude/CLAUDE.md on each Mac. Insurance, house, pets, shared money.", size=12, fill=p["quiet"], anchor="middle")
    s += text(p, 600, 400, "Templates never overwrite your edits. Run it again any time.", size=12, fill=p["quiet"], anchor="middle")
    s += "</svg>\n"
    return s


def memoryfile(p):
    W, H = 1200, 250
    s = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-label="Your memory file: memory.jsonl is one JSON object per line. Each line is one memory. Delete a line and Claude forgets that one thing.">\n'
    s += defs(p)
    s += f'<rect width="{W}" height="{H}" fill="{p["bg"]}"/>\n'
    s += box(p, 40, 40, 860, 172)
    s += text(p, 62, 70, "memory.jsonl", size=13, weight=600, mono=True)
    lines = [
        ('{"type":"entity","name":"Alex","entityType":"person","observations":["works in film","moved to Nashville in 2024"]}', None),
        ('{"type":"entity","name":"Greenhouse shoot","entityType":"project","observations":["drone pass first"]}', None),
        ('{"type":"entity","name":"Old apartment","entityType":"place","observations":["lease ends in June"]}', "gone"),
        ('{"type":"relation","from":"Alex","to":"Greenhouse shoot","relationType":"directs"}', None),
    ]
    for i, (ln, state) in enumerate(lines):
        y = 100 + i * 28
        ln = ln.replace("&", "&amp;").replace("<", "&lt;")
        fill = p["ghost"] if state else p["ink"]
        s += text(p, 62, y, ln, size=11.5, mono=True, fill=fill)
        if state:
            s += f'<line x1="60" y1="{y-4}" x2="720" y2="{y-4}" stroke="{p["rust"]}" stroke-width="2" stroke-linecap="round"/>\n'
    o, _ = pill(p, 930, 56, "one line, one memory", fill=p["tealwash"], stroke=p["teal"], color=p["teal"], h=30, size=11.5); s += o
    o, _ = pill(p, 930, 100, "delete a line, it forgets that", fill=p["rustwash"], stroke=p["rust"], color=p["rust"] if p["bg"] == "#1A1A1A" else p["ink"], h=30, size=11.5); s += o
    s += text(p, 930, 160, "Plain text. Opens in TextEdit.", size=12.5, fill=p["muted"])
    s += text(p, 930, 180, "Nothing to export, nothing to decode.", size=12.5, fill=p["muted"])
    s += text(p, 930, 200, "Delete the file and you start over.", size=12.5, fill=p["muted"])
    s += "</svg>\n"
    return s


FIGS = {"hero": hero, "architecture": architecture, "where-your-data-lives": datalives,
        "git-sync": gitsync, "compact": compact, "search-first": searchfirst, "family-memory": family,
        "memory-file": memoryfile,
        "boundary": boundary, "bridge": bridge, "dayflow": dayflow}
ONLY = os.environ.get("THEMES")
TOUR = {"boundary", "bridge", "dayflow"}   # explainer-page figures, not README ones
for name, fn in FIGS.items():
    if name in TOUR and not os.environ.get("TOUR"): continue
    for theme, pal in THEMES.items():
        if ONLY and theme not in ONLY.split(","): continue
        path = os.path.join(OUT, f"{name}-{theme}.svg")
        with open(path, "w") as f:
            f.write(fn(pal))
        print(path, os.path.getsize(path))
