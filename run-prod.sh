#!/bin/bash
cd "$(dirname "$0")"
export API_URL="${API_URL:-https://trytentra.com/api}"
export WEB_URL="${WEB_URL:-https://trytentra.com}"
# TENTRA_API_KEY should be set by the user in their .mcp.json env
exec node dist/index.js
