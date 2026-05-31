#!/bin/bash
# Start the PSA Card Grader API server
# Usage: ./start.sh
# Set ANTHROPIC_API_KEY in your environment before running.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Verify API key
if [ -z "$ANTHROPIC_API_KEY" ]; then
  echo "ERROR: ANTHROPIC_API_KEY is not set."
  echo "  export ANTHROPIC_API_KEY=sk-ant-..."
  exit 1
fi

echo "Starting PSA Card Grader API..."
echo "  Server : http://127.0.0.1:8000"
echo "  Docs   : http://127.0.0.1:8000/docs"
echo ""

# Use the project's Python environment
PYTHON=/opt/homebrew/anaconda3/bin/python3

$PYTHON server.py
