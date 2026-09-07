# The memory card

The repo's character: an index card with a face, a terracotta tab, three teal observation
lines, rubber-hose arms, white gloves, sneakers, and a teal padlock. Same object-with-a-face
logic as the other assistants in this design language. The vector original is `mascot()` in
[`../build-figures.py`](../build-figures.py); these are the drawn versions, made in Higgsfield
(Nano Banana Pro) from that SVG plus two style references, 2026-09-06.

Live assets, used by [`../render-png.py`](../render-png.py):

| File | What |
|---|---|
| `memory-card.png` | Canonical pose, transparent, 1000 px tall. README hero. |
| `memory-card-wave.png` | Waving pose, transparent, 1000 px tall. GitHub social preview. |

Every roll, kept so the next pose starts from the same place (downscaled for the repo; the
originals are 2048 px):

| File | Higgsfield job | Notes |
|---|---|---|
| `style-test-01-print-flat.png` | `416cc45a` | Chosen. Closest to the SVG. Base for everything after. |
| `style-test-02-poster-nodes.png` | `31fcf6ae` | Composition test with the sage circle and sync nodes. Lost the index tab. |
| `style-test-03-night-gallery.png` | `043e3718` | Dark spotlight direction. Not used yet. |
| `character-sheet-turnaround.png` | `48c9e5f5` | Turnaround off test 01. Run once, before any second pose. Reference for all later poses. |
| `pose-wave.png` | `e29711a2` | Second pose, from test 01 plus the sheet. |

To draw a new pose: reference `style-test-01` and the character sheet together, describe the
card in the same words as the sheet prompt, then `remove_background`, trim to the alpha bounding
box, and resize to 1000 px tall.
