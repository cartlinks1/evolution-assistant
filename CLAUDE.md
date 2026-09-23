# Evolution Assistant — notes for Claude Code

RAG Q&A assistant for Evolution Windshields (golf cart / LSV windshields). The owner is
non-technical and uses this as a portfolio piece: explain choices in plain English.

## Hard rules
- **Public repo.** Never commit `/data`, `.env*`, exports, or eval results. The pre-commit hook
  (`scripts/check-staged.mjs`) enforces this. Never bypass it (`--no-verify`).
- Demo content goes in `/sample-data` only, using the fictional **Ridgeline Shields** brand (`RDG-` SKUs).
- Contact details (phone/email) live in env vars, never in code.
- Don't ingest the Differentiators page until the owner provides a corrected version
  (`INGEST_BLOCKLIST=differentiators` + `exclude=true` in `data/manifest.csv`).
- Dealer filtering happens in SQL (`hybrid_search`, `fitment.audience`). `includeDealer` must come
  from verified server-side auth, never from request input.
- Claims (DOT/UV/impact/airflow/test numbers) are allowed only from `approved_for_claims` docs;
  `lib/claims.ts` enforces this after generation. Keep it in place.
- Build in phases and stop for the owner's review after each (see README roadmap).

## Verify after every change
`npm run typecheck && npm test && npm run check:private`
