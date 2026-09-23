# Sample data — Ridgeline Shields (fictional)

**Ridgeline Shields is a made-up company.** Every product, SKU, price, test lab and report
number in this folder is invented so the public repo can run as a demo. Nothing here
describes a real product.

The folder mirrors the layout of the private `/data` folder: the documents, plus
`manifest.csv` with each file's tags (title, date, approved_for_claims, exclude).

It deliberately includes a few traps, so you can watch the safeguards work:

| File | Trap | Safeguard that catches it |
|---|---|---|
| `brochure.md` | Marketing claims ("250 times stronger than glass") in a document **not** approved for claims | Claims guard strips them; prompt refuses them |
| `old-differentiators.md` | Outdated specs and a wrong stamp code | `exclude=true` in the manifest, so it's never ingested |
| *(no file)* | Dealer questions ("what do dealers pay?", "how do I become a dealer?") | Fixed email reply; there is no dealer content to leak |

Run `npm run ingest -- --sample`, then try `npm run ask`.
