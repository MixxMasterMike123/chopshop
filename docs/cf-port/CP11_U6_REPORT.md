claude-sonnet-5-5

# CP11 U6: docs (2026-10-19)

Edited in place, table shapes kept: `docs/SnapWearDocs/LAUNCH_TODO.md`. A5, A6, A12 got a "Prodigi (CP11)" note appended to their Notes cell. C1-C9 got a "Prodigi:" answer appended to the Question cell (the table has three columns; a new column would change its shape). New row B6c (Prodigi sub-processor, prodigi.com/dpa) directly after B6b. The SnapWear DPA draft is untouched. Nothing under `cloudflare/` or `scripts/` touched; no git write.

New: `docs/cf-port/PRODIGI_MONEY_DECISION.md` (shipping figure, mixed-lab under-collection, EUR/SEK rate and buffer as a labelled suggestion of 11.20 / 500 bp, BC3001 at EUR 25, non-EU labs, the print-area variant decision with both options and the cost of each being wrong).

Points to know:
- A12 names the callback route `POST /v1/webhooks/prodigi` (U3). U3 had no report when I wrote, so the route is described from the brief and HANDOVER, not from built code. Check against U3.
- C6 (failed card) is marked NOT verified; the HANDOVER only states "card at production".
- C1: the garments named there (64400, SF500, W101, B445, trucker, posters) are not among the 9 Prodigi models; the note says so.
- The brief treats "withhold the PL figure" as decided; I wrote it as a recommendation with reasoning. Rate/buffer, BC3001 and non-EU labs are open.
- B6c: whether Prodigi's DPA needs a signature is unchecked; stated as such.

Gate: `node guard/guards.test.mjs` -> `guard: PASS` (baseline 292). The new untracked files are not scanned by the guard; they contain no legacy brand names.
