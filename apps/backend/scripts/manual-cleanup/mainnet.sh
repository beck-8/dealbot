#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "$script_dir/../../../.." && pwd)"
run_dir="${MAINNET_CLEANUP_DIR:-$repo_dir/cleanup-runs/mainnet-20261004}"
if [[ "$run_dir" != /* ]]; then run_dir="$repo_dir/$run_dir"; fi
cli="$repo_dir/apps/backend/scripts/manual-cleanup/cli.mjs"
manifest="$run_dir/manifest.json"
state="$run_dir/state.json"
mode="${1:-help}"
if (( $# > 0 )); then shift; fi
case "$mode" in
  scan)
    node "$cli" scan --network mainnet \
      --payer "${MAINNET_CLEANUP_PAYER:-0x305025d07c1dee47f25a4990179eff2becddca0b}" \
      --out "$run_dir" "$@"
    ;;
  dry-run)
    node "$repo_dir/apps/backend/scripts/manual-cleanup/cleanup.mjs" \
      --network mainnet --input "$manifest" --include-abandoned --limit 3 "$@"
    ;;
  execute)
    included=false
    for arg in "$@"; do [[ "$arg" != '--include-abandoned' ]] || included=true; done
    if [[ "$included" != true ]]; then
      echo 'These 66 candidates are un-terminated abandonment datasets. Add --include-abandoned to select them for deletion.' >&2
      exit 2
    fi
    if [[ -z "${MANUAL_CLEANUP_PRIVATE_KEY:-}" ]]; then
      read -r -s -p 'Mainnet cleanup wallet private key (hidden): ' MANUAL_CLEANUP_PRIVATE_KEY
      printf '\n'
    fi
    export MANUAL_CLEANUP_PRIVATE_KEY
    trap 'unset MANUAL_CLEANUP_PRIVATE_KEY' EXIT
    node "$cli" execute --network mainnet --input "$manifest" --state "$state" \
      --concurrency 8 --confirmations 2 --delay-ms 300 "$@"
    ;;
  status)
    node "$cli" status --state "$state" "$@"
    ;;
  verify)
    if [[ -f "$state" ]]; then
      node "$cli" verify --input "$manifest" --state "$state" "$@"
    else
      node "$cli" verify --input "$manifest" "$@"
    fi
    ;;
  *)
    printf '%s\n' \
      './apps/backend/scripts/manual-cleanup/mainnet.sh scan # create a fresh local mainnet manifest' \
      './apps/backend/scripts/manual-cleanup/mainnet.sh dry-run                             # read-only: simulate 3 IDs and estimate gas' \
      './apps/backend/scripts/manual-cleanup/mainnet.sh execute --include-abandoned --limit 3 # execute first 3; prompts locally for key' \
      './apps/backend/scripts/manual-cleanup/mainnet.sh execute --include-abandoned           # execute/resume full fixed manifest' \
      './apps/backend/scripts/manual-cleanup/mainnet.sh status                               # inspect saved progress' \
      './apps/backend/scripts/manual-cleanup/mainnet.sh verify                               # independent on-chain acceptance'
    ;;
esac
