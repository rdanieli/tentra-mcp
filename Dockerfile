FROM node:20-slim

# tree-sitter* native modules may fall back to compile on uncommon archs;
# keep build deps available so Glama's multi-arch build succeeds.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

# Install the published npm package globally. Pinned version matches what's
# shipped to the official MCP registry (io.github.rdanieli/tentra).
RUN npm install -g tentra-mcp@1.2.0

# stdio MCP server. Tools/list responds without auth; actual tool invocations
# trigger a device-flow GitHub login printed to stderr (first call only).
CMD ["tentra-mcp"]
