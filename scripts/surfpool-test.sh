#!/usr/bin/env bash
# Runs the paritas test suite against a Surfpool mainnet fork.
#
# This deliberately never calls `anchor build` or `anchor test` (see
# CONTEXT.md: Anchor's bundled platform-tools rustc cannot build this crate).
# Instead it builds with cargo build-sbf, generates the IDL with
# `anchor idl build` (a separate host-target compile, not the SBF one), then
# starts Surfpool, deploys the already-built .so to it directly with
# `solana program deploy`, and runs the mocha test against that.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

RPC_PORT=8899
WS_PORT=8900
RPC_URL="http://127.0.0.1:${RPC_PORT}"
WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
SURFPOOL_LOG="$(mktemp -t surfpool-log.XXXXXX)"
SURFPOOL_PID=""

cleanup() {
  if [ -n "${SURFPOOL_PID}" ] && kill -0 "${SURFPOOL_PID}" 2>/dev/null; then
    echo "Stopping surfpool (pid ${SURFPOOL_PID})"
    kill "${SURFPOOL_PID}" 2>/dev/null || true
    wait "${SURFPOOL_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "==> Building program (cargo build-sbf)"
cargo build-sbf --tools-version v1.57

echo "==> Generating IDL and TypeScript types (anchor idl build, host target only)"
mkdir -p target/idl target/types
anchor idl build -o target/idl/paritas.json -t target/types/paritas.ts

echo "==> Starting surfpool, forking mainnet"
surfpool start \
  --network mainnet \
  --no-deploy \
  --no-tui \
  --no-studio \
  --port "${RPC_PORT}" \
  --ws-port "${WS_PORT}" \
  --airdrop-keypair-path "${WALLET}" \
  > "${SURFPOOL_LOG}" 2>&1 &
SURFPOOL_PID=$!

echo "==> Waiting for surfpool RPC at ${RPC_URL}"
for _ in $(seq 1 60); do
  if curl -s -o /dev/null -w '%{http_code}' \
      -X POST -H 'Content-Type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' \
      "${RPC_URL}" | grep -q '^200$'; then
    break
  fi
  sleep 0.5
done

if ! curl -s "${RPC_URL}" -X POST -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | grep -q '"result":"ok"'; then
  echo "surfpool did not become healthy in time. Log:"
  cat "${SURFPOOL_LOG}"
  exit 1
fi

echo "==> Deploying paritas to the fork"
solana program deploy \
  --url "${RPC_URL}" \
  --keypair "${WALLET}" \
  --program-id target/deploy/paritas-keypair.json \
  target/deploy/paritas.so

echo "==> Running tests"
ANCHOR_PROVIDER_URL="${RPC_URL}" ANCHOR_WALLET="${WALLET}" \
  npx ts-mocha -p ./tsconfig.json -t 1000000 tests/paritas.ts
