#!/bin/bash
# Cron script to run full test suite - only logs failures
# Usage: ./scripts/run-tests-cron.sh [--network=testnet|mainnet]
# Cron:  0 4,12,20 * * * /path/to/run-tests-cron.sh
#        0 10      * * * /path/to/run-tests-cron.sh --network=mainnet

# Set up PATH for cron environment (bun, node, npm, etc.)
NODE_VERSIONS_DIR="$HOME/.nvm/versions/node"
NODE_PATH_PART=""
if [ -d "$NODE_VERSIONS_DIR" ]; then
  LATEST_NODE_VERSION="$(ls -1 "$NODE_VERSIONS_DIR" 2>/dev/null | tail -1)"
  if [ -n "$LATEST_NODE_VERSION" ] && [ -d "$NODE_VERSIONS_DIR/$LATEST_NODE_VERSION/bin" ]; then
    NODE_PATH_PART="$NODE_VERSIONS_DIR/$LATEST_NODE_VERSION/bin:"
  fi
fi
export PATH="$HOME/.bun/bin:${NODE_PATH_PART}/usr/local/bin:/usr/bin:/bin:$PATH"

# Change to project directory (robust to symlinks)
SCRIPT_PATH="$(readlink -f "$0" 2>/dev/null || echo "$0")"
SCRIPT_DIR="$(cd -- "$(dirname -- "$SCRIPT_PATH")" >/dev/null 2>&1 && pwd)"
if [ -z "$SCRIPT_DIR" ]; then
  echo "Error: Unable to determine script directory." >&2
  exit 1
fi
cd "$SCRIPT_DIR/.." || { echo "Error: Failed to change directory to project root." >&2; exit 1; }

# Load environment variables from .env if it exists
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

# Also try .dev.vars (wrangler format)
if [ -f .dev.vars ]; then
  set -a
  source .dev.vars
  set +a
fi

# Parse command-line arguments (override .env values)
CLI_NETWORK=""
for arg in "$@"; do
  case "$arg" in
    --network=*) CLI_NETWORK="${arg#*=}" ;;
  esac
done

# Network priority: CLI arg > .env > default (testnet)
if [ -n "$CLI_NETWORK" ]; then
  export X402_NETWORK="$CLI_NETWORK"
else
  export X402_NETWORK="${X402_NETWORK:-testnet}"
fi

# URL is derived from network automatically:
#   testnet  → https://x402.aibtc.dev (staging)
#   mainnet  → https://x402.aibtc.com (production)
# Override with X402_WORKER_URL if needed (e.g., for localhost testing)

# Log directory (separate subdirs per network)
LOG_DIR="logs/test-runs/${X402_NETWORK}"
TIMESTAMP=$(date +"%Y-%m-%d_%H-%M-%S")
LOG_FILE="${LOG_DIR}/test-${TIMESTAMP}.log"

# Ensure log directory exists
mkdir -p "$LOG_DIR"

# Run tests and capture output to temp file
TEMP_LOG=$(mktemp)
echo "=== Test Run Started: $(date) ===" > "$TEMP_LOG"
echo "Network: ${X402_NETWORK}" >> "$TEMP_LOG"
echo "Server: (derived from network)" >> "$TEMP_LOG"
echo "" >> "$TEMP_LOG"

# Run the full test suite
bun run tests/_run_all_tests.ts --mode=full >> "$TEMP_LOG" 2>&1
EXIT_CODE=$?

echo "" >> "$TEMP_LOG"
echo "=== Test Run Completed: $(date) ===" >> "$TEMP_LOG"
echo "Exit Code: $EXIT_CODE" >> "$TEMP_LOG"

# Only keep log if tests failed
if [ $EXIT_CODE -ne 0 ]; then
  mv "$TEMP_LOG" "$LOG_FILE"
  # Keep only last 7 days of failure logs
  if ! find "$LOG_DIR" -name "test-*.log" -mtime +7 -delete 2>/dev/null; then
    echo "Warning: failed to delete old test logs in '$LOG_DIR'" >&2
  fi
else
  rm -f "$TEMP_LOG"
fi

exit $EXIT_CODE
