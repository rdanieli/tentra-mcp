import * as esbuild from 'esbuild'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

await esbuild.build({
  entryPoints: [join(ROOT, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: join(ROOT, 'dist/index.js'),
  // Native binaries — can't bundle these; leave external
  external: [
    'tree-sitter',
    'tree-sitter-typescript',
    'tree-sitter-javascript',
    'tree-sitter-python',
    'tree-sitter-go',
    'tree-sitter-java',
    'tree-sitter-rust',
    '@modelcontextprotocol/sdk',
    '@readme/openapi-parser',
    'protobufjs',
    'yaml',
    'zod',
  ],
  resolveExtensions: ['.ts', '.js', '.mjs'],
  // Silence ESM/CJS interop noise
  banner: {
    js: `import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);`,
  },
  logLevel: 'info',
})

console.log('[bundle] tentra-mcp/dist/index.js created')
