"""
How to add Varpulis to a real LangChain agent.

This file shows working integration code. It requires an API key to run,
but documents the exact steps needed to add behavioral guardrails to any
LangChain ReAct agent.

Option 1: One-line auto-patching
    import varpulis_agent_runtime
    varpulis_agent_runtime.init()

Option 2: Explicit callback handler
    from varpulis_agent_runtime.integrations.langchain import VarpulisCallbackHandler
    handler = VarpulisCallbackHandler(runtime)
    agent.invoke({"input": "..."}, config={"callbacks": [handler]})

Requirements:
    pip install varpulis-agent-runtime langchain langchain-community langchain-openai
    pip install duckduckgo-search   # for DuckDuckGo tool
    export OPENAI_API_KEY=sk-...    # or any LangChain-compatible LLM
"""

# ============================================================================
# Option 1: Zero-config auto-patching (recommended)
# ============================================================================

def option_1_auto_patch():
    """
    The simplest integration. One import + one function call.
    Varpulis automatically hooks into LangChain's CallbackManager so every
    chain, tool call, and LLM invocation is observed.
    """
    import varpulis_agent_runtime

    # This single line:
    # 1. Creates a VarpulisAgentRuntime with sensible defaults
    # 2. Auto-detects LangChain and patches CallbackManager.configure
    # 3. Prints detections to stderr when verbose=True
    runtime = varpulis_agent_runtime.init(verbose=True)

    # Optional: add custom handlers for specific patterns
    @runtime.on("retry_storm")
    def handle_retry_storm(detection):
        print(f"ALERT: {detection['message']}")
        # In production: send to PagerDuty, kill the agent, etc.

    @runtime.on("budget_runaway")
    def handle_budget(detection):
        if detection["severity"] == "error":
            raise RuntimeError(f"Budget exceeded: {detection['message']}")

    # Now use LangChain normally -- Varpulis is watching automatically
    from langchain_openai import ChatOpenAI
    from langchain_community.tools import DuckDuckGoSearchRun
    from langchain.agents import AgentExecutor, create_react_agent
    from langchain_core.prompts import ChatPromptTemplate

    llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)
    tools = [DuckDuckGoSearchRun()]

    prompt = ChatPromptTemplate.from_messages([
        ("system", "You are a helpful research assistant. Use tools when needed."),
        ("human", "{input}"),
        ("placeholder", "{agent_scratchpad}"),
    ])

    agent = create_react_agent(llm, tools, prompt)
    executor = AgentExecutor(agent=agent, tools=tools, verbose=True)

    # This will be observed by Varpulis automatically -- no extra code needed.
    result = executor.invoke({"input": "What are the latest developments in fusion energy?"})
    print(result["output"])


# ============================================================================
# Option 2: Explicit callback handler (more control)
# ============================================================================

def option_2_explicit_handler():
    """
    For when you want fine-grained control over which agents are monitored,
    or need different pattern configs per agent.
    """
    from varpulis_agent_runtime import VarpulisAgentRuntime, Patterns
    from varpulis_agent_runtime.integrations.langchain import VarpulisCallbackHandler

    # Custom runtime with strict thresholds for a production chatbot
    runtime = VarpulisAgentRuntime(
        patterns=[
            Patterns.retry_storm(min_repetitions=2, window_seconds=10),
            Patterns.error_spiral(min_error_count=2, window_seconds=30),
            Patterns.stuck_agent(max_steps_without_output=5, max_time_without_output_seconds=30),
            Patterns.budget_runaway(max_cost_usd=0.25, max_tokens=25_000, window_seconds=60),
        ],
        cooldown_ms=5_000,
    )

    # Kill the agent on critical detections
    @runtime.on("stuck_agent")
    def kill_stuck_agent(detection):
        raise RuntimeError(f"Agent terminated: {detection['message']}")

    # Create the callback handler
    handler = VarpulisCallbackHandler(runtime)

    # Use LangChain with the explicit handler
    from langchain_openai import ChatOpenAI
    from langchain_community.tools import DuckDuckGoSearchRun, WikipediaQueryRun
    from langchain_community.utilities import WikipediaAPIWrapper
    from langchain.agents import AgentExecutor, create_react_agent
    from langchain_core.prompts import ChatPromptTemplate

    llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)
    tools = [
        DuckDuckGoSearchRun(),
        WikipediaQueryRun(api_wrapper=WikipediaAPIWrapper()),
    ]

    prompt = ChatPromptTemplate.from_messages([
        ("system", "You are a research assistant with access to search and Wikipedia."),
        ("human", "{input}"),
        ("placeholder", "{agent_scratchpad}"),
    ])

    agent = create_react_agent(llm, tools, prompt)
    executor = AgentExecutor(agent=agent, tools=tools, verbose=True)

    # Pass the handler explicitly -- only this agent is monitored
    try:
        result = executor.invoke(
            {"input": "Compare the GDP of the top 5 economies"},
            config={"callbacks": [handler]},
        )
        print(result["output"])
    except RuntimeError as e:
        print(f"Agent was stopped by Varpulis: {e}")

    # Check what happened
    print(f"Total events observed: {runtime.event_count}")


# ============================================================================
# Option 3: Custom detection callback with logging
# ============================================================================

def option_3_with_logging():
    """
    Route Varpulis detections to your observability stack.
    """
    import logging
    import json

    import varpulis_agent_runtime

    logger = logging.getLogger("varpulis")
    logger.setLevel(logging.WARNING)
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
    logger.addHandler(handler)

    def log_detection(detection):
        level = {
            "info": logging.INFO,
            "warning": logging.WARNING,
            "error": logging.ERROR,
            "critical": logging.CRITICAL,
        }.get(detection.get("severity", "info"), logging.INFO)

        logger.log(level, "Pattern=%s Action=%s -- %s\n  Details: %s",
                   detection["pattern_name"],
                   detection.get("action", "alert"),
                   detection["message"],
                   json.dumps(detection.get("details", {}), indent=2))

    runtime = varpulis_agent_runtime.init(
        on_detection=log_detection,
        verbose=False,  # we handle logging ourselves
    )

    # Now use any LangChain agent -- detections go to your logger
    # ...


# ============================================================================

if __name__ == "__main__":
    print(__doc__)
    print("This file requires langchain + an API key to run.")
    print("See main.py for a self-contained demo that runs without any API key.")
    print()
    print("Quick start:")
    print("  pip install varpulis-agent-runtime langchain langchain-openai langchain-community duckduckgo-search")
    print("  export OPENAI_API_KEY=sk-...")
    print()
    print("Then uncomment one of:")
    print("  option_1_auto_patch()      # Zero-config, auto-patches LangChain")
    print("  option_2_explicit_handler() # Explicit control per agent")
    print("  option_3_with_logging()    # Custom logging integration")
