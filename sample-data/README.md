# Sample data — Ridgeline Shields (fictional)

**Ridgeline Shields is a made-up company.** Every product, SKU, price, test lab and report
number in this folder is invented so the public repo can run as a demo. Nothing here
describes a real product.

The folder mirrors the layout of the private `/data` folder:

```
sample-data/
├─ manifest.csv          ← tags for each file (title, date, approved_for_claims, exclude)
├─ public/               ← anyone can get answers from these
└─ dealer/               ← only retrievable in dealer mode
```

It deliberately includes a few traps, so you can watch the safeguards work:

| File | Trap | Safeguard that catches it |
|---|---|---|
| `public/brochure.md` | Marketing claims ("250 times stronger than glass") in a document **not** approved for claims | Claims guard strips them; prompt refuses them |
| `public/old-differentiators.md` | Outdated specs and a wrong stamp code | `exclude=true` in the manifest, so it's never ingested |
| `dealer/dealer-program.md` | Dealer-only program terms (dealer pricing is never answered; it goes to email) | Database audience filter; pricing questions short-circuit to the email reply |

Run `npm run ingest -- --sample`, then try `npm run ask`.
