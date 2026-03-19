# LangChain Guardrails Example

Demonstrates how to add real-time behavioral guardrails to a LangChain agent.

## What it does

This example creates a simulated LangChain-style agent that:
1. Makes tool calls (search, read_file, write_file)
2. Encounters errors and retries
3. Gets stuck in a reasoning loop

Varpulis detects all three failure modes in real-time.

## Run

```bash
# TypeScript
npx ts-node index.ts

# Python
pip install varpulis-agent-runtime
python main.py
```
