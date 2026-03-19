# Standalone Browser Example

This example installs `@varpulis/agent-runtime` from the package tarball and runs it in a real browser via Vite, proving WASM loading works end-to-end.

## Run

```bash
# First, build the package tarball (from repo root):
cd packages/npm && npm run build && npm pack

# Then run the example:
cd examples/standalone-browser
npm run setup   # installs from local tarball + vite
npm run dev     # opens browser demo at localhost:5173
```

## What it tests

- WASM module loads in the browser via Vite + vite-plugin-wasm
- Subpath exports work (`@varpulis/agent-runtime/wasm`)
- All 6 pattern detectors fire correctly
- Kill action works
- Visual output with color-coded severity levels
