# Standalone Node.js Example

This example installs `@varpulis/agent-runtime` from the package tarball and demonstrates that WASM loading and pattern detection work end-to-end in a real Node.js environment.

## Run

```bash
# First, build the package tarball (from repo root):
cd packages/npm && npm run build && npm pack

# Then run the example:
cd examples/standalone-node
npm run setup   # installs from local tarball
npm start       # runs the demo
```

## What it tests

- WASM module loads correctly in Node.js via the `@varpulis/agent-runtime/wasm` subpath export
- All 6 pattern detectors work
- Kill action fires when threshold is exceeded
- `hashParams` utility works
