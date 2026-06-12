#!/usr/bin/env bash
# Run the grading API locally.
# Usage: ./backend/start.sh [port]
set -e

PORT=${1:-8000}
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example — edit paths if needed."
fi

if [ ! -d venv ]; then
  echo "Creating virtual environment..."
  python3 -m venv venv
fi

source venv/bin/activate
pip install -q -r requirements.txt

echo ""
echo "Starting grading API on http://localhost:$PORT"
echo "  POST http://localhost:$PORT/analyze-listing"
echo "  GET  http://localhost:$PORT/health"
echo "  Docs http://localhost:$PORT/docs"
echo ""

uvicorn main:app --reload --host 0.0.0.0 --port "$PORT"
