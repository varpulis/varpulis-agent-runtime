"""Framework integrations for Varpulis Agent Runtime.

Available integrations:

- **LangChain**: ``varpulis_agent_runtime.integrations.langchain.VarpulisCallbackHandler``
  Implements the LangChain BaseCallbackHandler protocol to observe tool calls,
  LLM calls, and chain execution via LangChain's callback system.

- **CrewAI**: ``varpulis_agent_runtime.integrations.crewai.VarpulisCrewAIHook``
  Registers before/after tool call hooks with CrewAI to observe tool executions
  and enforce kill actions when dangerous patterns are detected.

- **OpenTelemetry**: ``varpulis_agent_runtime.integrations.opentelemetry.VarpulisSpanProcessor``
  An OpenTelemetry SpanProcessor that converts GenAI semantic convention spans
  (``gen_ai.chat``, ``gen_ai.tool``, etc.) into Varpulis events.
"""
