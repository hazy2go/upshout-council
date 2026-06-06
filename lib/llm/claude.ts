import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { RunRequest, RunCallbacks } from "./types";

// Model aliases resolve against your Claude subscription via the local CLI.
// Everything defaults to Sonnet — Opus is ~5× the cost and we run a synth turn
// per card (an event can be 10+ cards), so the default must never be Opus.
function model(role: RunRequest["role"]): string {
  return role === "synth"
    ? process.env.CLAUDE_SYNTH_MODEL ?? "sonnet"
    : process.env.CLAUDE_EXPERT_MODEL ?? "sonnet";
}

/** Summarize a tool call's input into a short human label. */
function toolDetail(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  if (name === "WebSearch") return String(i.query ?? "");
  if (name === "WebFetch") return String(i.url ?? "");
  const s = JSON.stringify(i);
  return s.length > 80 ? s.slice(0, 80) + "…" : s;
}

/**
 * Run one Claude Agent SDK query, forwarding streamed deltas. Uses the local
 * Claude subscription (the `claude` CLI login); WebSearch/WebFetch run headless
 * (permissions bypassed for this trusted local app).
 */
export async function runClaude(req: RunRequest, cb: RunCallbacks): Promise<string> {
  // Bridge the request's AbortSignal to the SDK's AbortController.
  const ac = new AbortController();
  if (req.signal) {
    if (req.signal.aborted) ac.abort();
    else req.signal.addEventListener("abort", () => ac.abort(), { once: true });
  }

  const options: Options = {
    systemPrompt: req.system,
    model: model(req.role),
    allowedTools: req.webSearch ? ["WebSearch", "WebFetch"] : [],
    // Positive base set: ONLY the tools this turn can use exist at all. Anything
    // else (Bash/Read/Edit/…) would ship schema tokens on every request — and a
    // larger toolset triggers schema deferral, making experts burn their first
    // agentic turn on ToolSearch just to load WebSearch/WebFetch.
    tools: req.webSearch ? ["WebSearch", "WebFetch"] : [],
    includePartialMessages: true,
    maxTurns: req.maxTurns,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    abortController: ac,
    // Don't inherit the user's CLAUDE.md / settings — keep runs isolated.
    settingSources: [],
  };

  let streamed = "";
  let finalText = "";

  for await (const message of query({ prompt: req.prompt, options })) {
    if (message.type === "stream_event") {
      const ev = message.event as {
        type: string;
        delta?: { type?: string; text?: string; thinking?: string };
      };
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
        streamed += ev.delta.text;
        cb.onText(ev.delta.text);
      } else if (
        ev.type === "content_block_delta" &&
        ev.delta?.type === "thinking_delta" &&
        ev.delta.thinking
      ) {
        cb.onThink?.(ev.delta.thinking);
      }
    } else if (message.type === "assistant") {
      // Surface tool use (web searches/fetches) as live activity.
      for (const block of message.message.content) {
        if (block.type === "tool_use") {
          cb.onTool?.(block.name, toolDetail(block.name, block.input));
        }
      }
    } else if (message.type === "result") {
      if (message.subtype === "success") finalText = message.result;
      // Surface non-success endings (e.g. error_max_turns: the agent spent every
      // turn on tools and never wrote its answer) so the run log shows WHY a
      // turn came back empty instead of failing silently.
      else cb.onTool?.("result", message.subtype);
      // Surface token/cost usage so the council can track spend per card.
      const m = message as unknown as {
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
        total_cost_usd?: number;
      };
      if (m.usage) {
        cb.onUsage?.({
          inputTokens: m.usage.input_tokens ?? 0,
          outputTokens: m.usage.output_tokens ?? 0,
          cacheReadTokens: m.usage.cache_read_input_tokens ?? 0,
          cacheCreationTokens: m.usage.cache_creation_input_tokens ?? 0,
          costUsd: m.total_cost_usd ?? 0,
        });
      }
    }
  }

  return finalText.trim() || streamed.trim();
}
