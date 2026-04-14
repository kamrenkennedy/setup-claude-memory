# Family Memory PDF Index

One-line summary per PDF stored anywhere inside `Kennedy Family Docs/`. Use this to decide which PDF to open on-demand (via the `anthropic-skills:pdf` skill) when answering a family question.

**Discipline:**
- One entry per PDF. Format: `**Filename** — <one-line summary>. Path: <absolute path>.`
- When a PDF is read, cache its extracted text to `pdf-cache/{filename}.txt` so future reads skip the parse.
- Extract structured facts to `facts.json` so most common questions don't require opening the PDF at all.
- Don't move the original PDFs — they stay wherever they already live in the family folder.

---

## Insurance

_(no entries yet — populated during PDF indexing)_

## House

_(no entries yet)_

## Vehicles

_(no entries yet)_

## Identity / Personal

_(no entries yet)_

## Other

_(no entries yet)_
