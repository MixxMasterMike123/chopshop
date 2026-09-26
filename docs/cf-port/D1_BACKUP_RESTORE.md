# D1 backup + restore — runbook and drill record

PLAN §2.7: "Time Travel + weekly export to R2 with a restore drill in CP1". Drill run 2026-09-26 on
`chopshop-stg` (`d1162797-5a79-4a79-aef9-e5f7e1634fb1`), through the preflight only.

## Two mechanisms, different jobs

| | Time Travel (built in) | SQL export (`d1 export`) |
|---|---|---|
| What | Point-in-time restore of the SAME database, any second in the last 30 days (Paid) | A `.sql` dump: schema + data |
| Use for | "Undo" a bad migration / bad write / accidental delete | Off-platform copy, restore into ANOTHER database, audit archive |
| Downtime | Seconds; the database stays bound | n/a (read) |
| Limits | Cannot restore into a different database; a restore is itself a new bookmark | Dump holds every row incl. PII and password hashes → treat as a secret |

## Commands (always via the preflight; never bare wrangler)

```sh
# bookmark of "now" (record it before any risky migration/import)
scripts/cf-preflight.sh <env> -- d1 time-travel info DB

# restore to a timestamp (UTC) or a bookmark — confirmation is read from stdin
printf 'y\n' | scripts/cf-preflight.sh <env> -- d1 time-travel restore DB --timestamp 2026-09-26T19:13:00Z
printf 'y\n' | scripts/cf-preflight.sh <env> -- d1 time-travel restore DB --bookmark=<bookmark>
# every restore prints the bookmark to UNDO it ("restore to the previous bookmark: …") — keep it.

# export (note: --remote here; time-travel commands take NO --remote flag)
scripts/cf-preflight.sh <env> -- d1 export DB --remote --output /absolute/path/chopshop-<env>-<utc>.sql

# restore an export INTO a database (e.g. a fresh one, or production from a staging-verified dump)
scripts/cf-preflight.sh <env> --bootstrap -- d1 execute DB --remote --file /absolute/path/dump.sql
```

Production adds nothing: same commands with `production`; the preflight's launch gate applies to
`deploy`, not to these. A production restore is a **Mikael GO** action (record in HANDOVER).

## Drill 2026-09-26 (staging)

1. `d1 export` → 55 436 bytes, 31 `CREATE TABLE`, 38 `INSERT` rows, 1 tenant (`smoke-cp1`) — dump kept
   only in the session scratchpad (contains the admin's password hash), deleted with the session.
2. `time-travel info` → bookmark `00000007-00000000-000050f2-6d1b…`.
3. `restore --timestamp 2026-09-26T19:13:00Z` (one minute before the smoke tenant existed) → restored to
   bookmark `00000005-0000001e-…`; verified: `tenants` empty, `identity_access` still holds the platform
   admin (created 19:11Z), `/ready` 200 on `0016` (migrations are data too — they travelled with it).
4. `restore --bookmark=00000007-ffffffff-…` (the printed undo bookmark) → verified: `smoke-cp1` back,
   product `SMOKE-1` back, 1 revoked acting-as grant back, `/ready` 200.

Total wall time ≈ 40 s for both restores. **Conclusion:** Time Travel is the primary recovery path
(seconds, exact); the export is the archive/off-platform path.

## Still to build (CP2/CP3)
- Weekly export to R2 `chopshop-<env>-private/backups/d1/<utc>.sql` from a cron trigger (the Worker
  cannot run `d1 export`; use the D1 REST export endpoint from the Worker with an account API token
  secret, or a GitHub Actions cron running the preflight). Decide at CP3 with the import scripts.
- Capacity alert at 5 GB (PLAN §2.7) — a cron query on `PRAGMA page_count * page_size`.
- Before every production migration: `time-travel info` bookmark recorded in the deploy notes.
