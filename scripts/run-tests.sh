#!/bin/bash
# Runs all unit tests and sends results to Telegram
# Usage: ./scripts/run-tests.sh [--notify]
# With --notify: sends results to Telegram (requires TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID env vars)

set -o pipefail

NOTIFY=false
if [ "$1" = "--notify" ]; then NOTIFY=true; fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== Running unit tests ==="

# Run tests, capture output
OUTPUT=$(cd "$PROJECT_DIR" && pnpm test 2>&1)
EXIT_CODE=$?

echo "$OUTPUT"

if [ $EXIT_CODE -eq 0 ]; then
    echo ""
    echo "=== All tests passed ==="
else
    echo ""
    echo "=== Tests FAILED (exit code: $EXIT_CODE) ==="
fi

# Send results to Telegram if --notify flag is set and env vars are present
if [ "$NOTIFY" = "true" ] && [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_CHAT_ID" ]; then
    TIMESTAMP=$(date -u '+%Y-%m-%d %H:%M:%S UTC')
    HOSTNAME=$(hostname)

    # Parse test results per package from vitest output
    # Vitest output format: "Tests  N passed (N)" or "Tests  N failed | M passed (total)"
    SHARED_LINE=$(echo "$OUTPUT" | grep -A1 "packages/shared test:" | grep "Tests" | tail -1)
    KALSHI_LINE=$(echo "$OUTPUT" | grep -A1 "packages/kalshi-listener test:" | grep "Tests" | tail -1)
    POLY_LINE=$(echo "$OUTPUT" | grep -A1 "packages/polymarket-listener test:" | grep "Tests" | tail -1)

    # Extract pass/fail counts using sed
    parse_results() {
        local line="$1"
        local pkg="$2"
        if [ -z "$line" ]; then
            echo "$pkg: no results"
            return
        fi
        # Remove the package prefix if present
        local clean
        clean=$(echo "$line" | sed 's/.*Tests  *//')
        echo "$pkg: $clean"
    }

    SHARED_RESULT=$(parse_results "$SHARED_LINE" "shared")
    KALSHI_RESULT=$(parse_results "$KALSHI_LINE" "kalshi-listener")
    POLY_RESULT=$(parse_results "$POLY_LINE" "polymarket-listener")

    # Count total passed/failed from output
    TOTAL_PASSED=$(echo "$OUTPUT" | grep -oE '[0-9]+ passed' | awk '{s+=$1} END {print s+0}')
    TOTAL_FAILED=$(echo "$OUTPUT" | grep -oE '[0-9]+ failed' | awk '{s+=$1} END {print s+0}')

    # Determine overall status
    if [ $EXIT_CODE -eq 0 ]; then
        HEADER="🟢 <b>UNIT TESTS PASSED</b>"
    else
        HEADER="🔴 <b>UNIT TESTS FAILED</b>"
    fi

    # Build message
    MESSAGE="$HEADER
Host: $HOSTNAME
Time: $TIMESTAMP

📦 $SHARED_RESULT
📦 $KALSHI_RESULT
📦 $POLY_RESULT
Total: ${TOTAL_PASSED} passed, ${TOTAL_FAILED} failed"

    # Send to Telegram
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
        -d chat_id="$TELEGRAM_CHAT_ID" \
        -d parse_mode="HTML" \
        --data-urlencode "text=$MESSAGE" \
        > /dev/null 2>&1

    echo "=== Results sent to Telegram ==="
fi

exit $EXIT_CODE
