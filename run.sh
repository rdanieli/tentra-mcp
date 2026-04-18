#!/bin/bash
cd "$(dirname "$0")"
export API_URL="${API_URL:-http://localhost:3001}"
export WEB_URL="${WEB_URL:-http://localhost:5173}"
exec node dist/index.js
