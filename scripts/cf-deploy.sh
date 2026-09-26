#!/usr/bin/env bash
# scripts/cf-deploy.sh <staging|production> — the only way to deploy (docs/cf-port/PLAN.md §0, §9).
#
# Refuses (one line, "DEPLOY REFUSED: …", exit 1) unless:
#   1. the working tree is clean (no staged, unstaged or untracked changes) — deploy a SHA, not a tree;
#   2. HEAD is on a remote-tracking branch (pushed);
#   3. the review attestation for HEAD — a git note in refs/notes/reviews, i.e. OUTSIDE the
#      reviewed tree, so recording it does not change the SHA it certifies (Codex) — has the
#      lines "codex: PASS" and "fable: PASS"; production additionally "mikael: GO".
# Then hands over to scripts/cf-preflight.sh <env> -- deploy (account/resource/Stripe checks).
#
# Recording attestations (reviewers, after the reviews pass):
#   git notes --ref=reviews add -m "codex: PASS" -m "fable: PASS" HEAD
#   git notes --ref=reviews append -m "mikael: GO" HEAD              # production only
#   git push origin refs/notes/reviews                               # share them

set -euo pipefail
set +x

refuse() { printf 'DEPLOY REFUSED: %s\n' "$*" >&2; exit 1; }

[ $# -eq 1 ] || refuse "usage: scripts/cf-deploy.sh <staging|production>"
ENV_NAME=$1
case $ENV_NAME in
  staging | production) ;;
  *) refuse "unknown environment '$ENV_NAME' — usage: scripts/cf-deploy.sh <staging|production>" ;;
esac

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
cd "$ROOT"

dirty=$(git status --porcelain --untracked-files=all)
[ -z "$dirty" ] || refuse "working tree is not clean ($(printf '%s\n' "$dirty" | wc -l | tr -d ' ') path(s), see git status) — commit or remove them; only a committed SHA is deployed"

SHA=$(git rev-parse HEAD)
git fetch -q origin 2>/dev/null || refuse "git fetch origin failed — cannot confirm HEAD is pushed"
[ -n "$(git branch -r --contains HEAD 2>/dev/null)" ] ||
  refuse "HEAD $SHA is not on any remote branch — push it first"

notes=$(git notes --ref=reviews show HEAD 2>/dev/null || true)
has_line() { printf '%s\n' "$notes" | grep -qE "^[[:space:]]*$1[[:space:]]*\$"; }
missing=
has_line 'codex: PASS' || missing="$missing 'codex: PASS'"
has_line 'fable: PASS' || missing="$missing 'fable: PASS'"
[ -z "$missing" ] ||
  refuse "HEAD $SHA has no review attestation line(s)$missing in refs/notes/reviews — once BOTH reviews of this exact SHA pass, record them with: git notes --ref=reviews add -m \"codex: PASS\" -m \"fable: PASS\" HEAD"
if [ "$ENV_NAME" = production ]; then
  has_line 'mikael: GO' ||
    refuse "production needs Mikael's go for HEAD $SHA — when he gives it, record: git notes --ref=reviews append -m \"mikael: GO\" HEAD"
fi

printf 'deploy: %s — HEAD %s reviewed (codex: PASS, fable: PASS%s)\n' "$ENV_NAME" "$SHA" \
  "$([ "$ENV_NAME" = production ] && printf ', mikael: GO')" >&2
exec "$ROOT/scripts/cf-preflight.sh" "$ENV_NAME" -- deploy
