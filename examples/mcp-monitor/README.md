# MCP Monitor Example

Demonstrates how to monitor MCP (Model Context Protocol) tool calls with Varpulis.

## What it does

Simulates an MCP client that:
1. Calls `file_search` repeatedly with identical params (retry storm)
2. Receives a mix of successes and errors
3. Uses the `McpAdapter` to translate MCP messages into Varpulis events

## Run

```bash
npx ts-node index.ts
```
