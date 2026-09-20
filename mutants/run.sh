#!/bin/sh
# Mutation testing for the bench, the way Google runs it: break the thing on
# purpose, one small semantic change at a time, and see whether the suite
# notices. A mutant the tests do not catch is "survived", and a survivor is
# not a curiosity -- it is a test that would stay green while that behaviour
# is gone. Google's lesson is to keep the mutants few and meaningful rather
# than exhaustive (arid code is skipped), so every mutant here is written by
# hand next to the behaviour it destroys, and carries the sentence that says
# what its survival would mean.
#
# Two families:
#   code  a patch against the bench's own source (git apply), image rebuilt
#   env   the platform moved under the bench (a dead key, no gateway, no
#         realtime token, the wrong origin) -- these ask the question that
#         matters for a test lab: would it still say everything is fine?
#
# A mutant that does not compile is INVALID, not killed: the compiler caught
# it, the tests said nothing. Those are excluded from the score.
#
#   sh mutants/run.sh [mutant-id]      MUT_PROJECT=firefox to switch browser
set -eu

cd "$(dirname "$0")/.."
PROJECT=${MUT_PROJECT:-chromium}
ONLY=${1:-}
TMP=${TMPDIR:-/tmp}/lab-mutants.$$
REPORT=report/mutants.md
mkdir -p report "$TMP"

if [ -n "$(git status --porcelain app/ e2e/)" ]; then
    echo "refusing to run: app/ or e2e/ has uncommitted changes -- a mutant would be indistinguishable from your work" >&2
    exit 1
fi

DC="docker compose"
E2E() { $DC --profile e2e run --rm -T "$@" e2e sh -c "npm install --no-audit --no-fund --silent && npx playwright test $SPEC.spec.ts --project=$PROJECT --reporter=line" </dev/null; }

wait_lab() {
    i=0
    while [ $i -lt 30 ]; do
        if curl -fs -m 2 -o /dev/null "http://localhost:${LAB_PORT:-5180}/lab-config.json" 2>/dev/null; then return 0; fi
        i=$((i + 1))
        sleep 1
    done
    echo "the bench did not come back up" >&2
    return 1
}

restore() {
    git checkout -- app/ e2e/ 2>/dev/null || true
    $DC build -q lab >/dev/null 2>&1 || true
    $DC up -d --force-recreate lab hostile >/dev/null 2>&1 || true
    wait_lab || true
}

# Restoring on the way out, not only after the loop: an interrupted run used to
# leave its mutant applied in app/ and baked into the running lab image, and
# the next reader found a deliberate break sitting in `git diff` looking like
# unfinished work. Ctrl-C now puts the bench back.
trap 'restore; rm -rf "$TMP"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

killed=0
survived=0
invalid=0
: >"$TMP/rows"

# shellcheck disable=SC2034
while IFS='	' read -r id kind SPEC means <&3; do
    case "$id" in \#* | '') continue ;; esac
    [ -z "$ONLY" ] || [ "$ONLY" = "$id" ] || continue
    printf '\n=== %s (%s, %s.spec.ts)\n    %s\n' "$id" "$kind" "$SPEC" "$means"
    verdict=
    E2E_ARGS=''

    if [ "$kind" = code ]; then
        if ! git apply "mutants/$id.patch" 2>"$TMP/apply"; then
            printf 'STALE   %s -- the code it mutated has moved; regenerate it\n' "$id"
            sed 's/^/    /' "$TMP/apply"
            printf '%s\t%s\tSTALE\t%s\n' "$id" "$kind" "$means" >>"$TMP/rows"
            continue
        fi
        if ! $DC build -q lab >"$TMP/build" 2>&1 </dev/null; then
            verdict=INVALID
            invalid=$((invalid + 1))
            printf 'INVALID %s -- the compiler refused it (tests never saw it)\n' "$id"
            tail -n 3 "$TMP/build" | sed 's/^/    /'
        else
            $DC up -d --force-recreate lab >/dev/null 2>&1 </dev/null
            wait_lab
        fi
    else
        target=$(cut -d' ' -f1 <"mutants/$id.env")
        assign=$(cut -d' ' -f2- <"mutants/$id.env")
        key=${assign%%=*}
        val=${assign#*=}
        if [ "$target" = lab ]; then
            printf 'services:\n  lab:\n    environment:\n      %s: "%s"\n' "$key" "$val" >"$TMP/override.yml"
            $DC -f docker-compose.yml -f "$TMP/override.yml" up -d --force-recreate lab >/dev/null 2>&1 </dev/null
            wait_lab
        else
            E2E_ARGS="-e $key=$val"
        fi
    fi

    if [ -z "$verdict" ]; then
        # shellcheck disable=SC2086
        if E2E $E2E_ARGS >"$TMP/out" 2>&1; then
            verdict=SURVIVED
            survived=$((survived + 1))
            printf 'SURVIVED %s -- the suite stayed green\n' "$id"
        else
            verdict=KILLED
            killed=$((killed + 1))
            printf 'KILLED  %s -- %s\n' "$id" "$(grep -m1 -oE '[0-9]+ failed' "$TMP/out" || echo 'the suite failed')"
        fi
    fi
    printf '%s\t%s\t%s\t%s\n' "$id" "$kind" "$verdict" "$means" >>"$TMP/rows"

    if [ "$kind" = code ]; then
        git checkout -- app/ e2e/
    fi
done 3<mutants/index.tsv

total=$((killed + survived))
score=0
[ "$total" -eq 0 ] || score=$((killed * 100 / total))
{
    printf '# Mutation report — %s, %s\n\n' "$(date -u +%Y-%m-%dT%H:%MZ)" "$PROJECT"
    printf 'Killed **%d**, survived **%d**, invalid %d — mutation score **%d%%**.\n\n' "$killed" "$survived" "$invalid" "$score"
    printf '| mutant | kind | verdict | what its survival would mean |\n|---|---|---|---|\n'
    while IFS='	' read -r id kind verdict means; do
        printf '| `%s` | %s | %s | %s |\n' "$id" "$kind" "$verdict" "$means"
    done <"$TMP/rows"
} >"$REPORT"

printf '\n== killed %d · survived %d · invalid %d · score %d%%\n' "$killed" "$survived" "$invalid" "$score"
printf '== %s\n' "$REPORT"
[ "$survived" -eq 0 ]
