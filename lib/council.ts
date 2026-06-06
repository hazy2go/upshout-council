import type { Card, CouncilEvent, Expert } from "./types";
import { EXPERTS } from "./experts";
import { fromMicro } from "./upshot";
import { runAgent, providerLabel } from "./llm";
import type { TurnUsage } from "./llm/types";
import { extractCall, extractStatus, extractVerdictProb, extractVerdictCall } from "./parse";
import { saveRun } from "./db";

// Per-turn timeouts so one hung agent can't stall the batch (overridable via env).
const EXPERT_TIMEOUT_MS = Number(process.env.COUNCIL_EXPERT_TIMEOUT_MS ?? 210_000);
const SYNTH_TIMEOUT_MS = Number(process.env.COUNCIL_SYNTH_TIMEOUT_MS ?? 180_000);

// Round-1 agentic turn cap. Each extra turn re-sends the whole growing context
// (including fetched pages), so the loop's cost grows quadratically — keep it
// tight, but NOT too tight: the first turn is burned on tool-schema loading
// (ToolSearch) and experts often spend a few turns searching, so below ~6 they
// run out of turns BEFORE writing their assessment and return nothing.
const R1_MAX_TURNS = Number(process.env.COUNCIL_R1_MAX_TURNS ?? 6);

/** Token-cheap digest of a take for feeding to others/the synth. */
function digest(expert: Expert, text: string, maxChars = 280, tag = ""): string {
  const { prob, lean } = extractCall(text);
  const body = text.replace(/PROBABILITY:[\s\S]*$/i, "").trim();
  const thesis = body.replace(/\s+/g, " ").slice(0, maxChars);
  return `### ${expert.name} (${expert.bias})${tag} — ${prob ?? "?"}% · ${lean ?? "?"}\n${thesis}${
    body.length > maxChars ? "…" : ""
  }`;
}

type Emit = (event: CouncilEvent) => void;

/** Format micro-units as a USD amount, e.g. 732920721 -> "$732.92". */
function usd(value?: string | number): string | null {
  const n = fromMicro(value);
  return n == null ? null : `$${n.toFixed(2)}`;
}

// Upshot has no SHOT/USD rate endpoint (even its own UI shows raw SHOT), so the
// dollar value of a SHOT price can only be known if the operator supplies a rate.
// Set UPSHOT_SHOT_USD (dollars per 1 SHOT) to let the council compute USD EV
// directly; otherwise it computes the break-even SHOT price instead of guessing.
const SHOT_USD = process.env.UPSHOT_SHOT_USD
  ? Number(process.env.UPSHOT_SHOT_USD)
  : null;

/** Convert a display amount in a given currency to USD when we can. */
function toUsd(amount: number, currency?: string): number | null {
  const c = (currency ?? "").toUpperCase();
  if (c === "CASH") return amount; // CASH is USD-pegged
  if (c === "SHOT" && SHOT_USD != null && !Number.isNaN(SHOT_USD)) return amount * SHOT_USD;
  return null;
}

/**
 * Describe what the card pays if it wins. Upshot has separate reward rails —
 * CASH (real money in `potentialPrize`), POINTS/GOLD (in `pointsValue`), and SHOT
 * (a raffle/prize entry). A CASH card legitimately has pointsValue 0 and vice
 * versa, so we must read the right field for the rail or the brief understates it.
 */
function formatReward(card: Card): string {
  const rail = (card.prizeType ?? card.event?.kind ?? "").toUpperCase();
  const cash = usd(card.potentialPrize ?? card.prizeAmount);
  const points = fromMicro(card.pointsValue);

  if (rail === "CASH") {
    return `Reward if it wins: CASH — ${cash ?? "$0.00"} cash payout (this is a cash card; points are 0 by design)`;
  }
  if (rail === "SHOT") {
    return `Reward if it wins: a SHOT (raffle/prize entry)${cash ? `, prize ${cash}` : ""}`;
  }
  if (points != null && points > 0) {
    return `Reward if it wins: ${points} ${rail === "GOLD" ? "GOLD" : "points"}`;
  }
  // Unknown rail — surface whatever is non-zero rather than defaulting to points.
  if (cash && cash !== "$0.00") return `Reward if it wins: ${cash} (${rail || "prize"})`;
  return `Reward if it wins: ${points ?? 0} points`;
}

/** Build a compact, factual brief about the card for every expert to share. */
function cardBrief(card: Card): string {
  const lines: string[] = [];
  lines.push(`Card: "${card.name}"`);
  if (card.rarity) lines.push(`Rarity: ${card.rarity}`);
  if (card.maxSupply != null) lines.push(`Max supply: ${card.maxSupply}`);
  lines.push(formatReward(card));
  if (card.event) {
    const e = card.event;
    const isCash = (card.prizeType ?? e.kind ?? "").toUpperCase() === "CASH";
    if (e.name) lines.push(`Event: ${e.name}`);
    if (e.status) lines.push(`Event status: ${e.status}`);
    if (e.kind) lines.push(`Event kind: ${e.kind}`);
    if (e.eventDate) lines.push(`Event date: ${e.eventDate}`);
    const pool = isCash ? usd(e.prizePool) : fromMicro(e.prizePool);
    if (pool != null) lines.push(`Event prize pool: ${isCash ? pool : `${pool} GOLD`}`);
    if (e.status === "RESOLVED") {
      lines.push(
        `ALREADY RESOLVED — winning outcome: ${e.winningOutcomeId ?? "n/a"}, this card's outcome: ${card.outcomeId ?? "n/a"}`
      );
    }
  }

  // ---- Cost to acquire: anchor on the REAL price, not the (often sold-out) mint ----
  const soldOut =
    card.maxSupply != null && card.minted != null && card.minted >= card.maxSupply;
  const mintNum = fromMicro(card.event?.pricePerCard);
  const buy = fromMicro(card.pricing?.buyPrice);
  const cur = card.pricing?.currency ?? "GOLD";
  if (buy != null) {
    const buyUsd = toUsd(buy, cur);
    lines.push(
      `Cost to BUY now (live secondary-market ask): ${buy} ${cur}${buyUsd != null ? ` (≈ $${buyUsd.toFixed(2)})` : ""}`
    );
    const sell = fromMicro(card.pricing?.sellPrice);
    if (sell != null) lines.push(`Sell-back (bid): ${sell} ${cur}`);

    // Deterministic break-even (computed in code, not left to the model).
    const isCashPrize = (card.prizeType ?? card.event?.kind ?? "").toUpperCase() === "CASH";
    const prizeUsd = isCashPrize ? fromMicro(card.potentialPrize ?? card.prizeAmount) : null;
    if (prizeUsd && prizeUsd > 0) {
      if (buyUsd != null) {
        const be = (buyUsd / prizeUsd) * 100;
        lines.push(
          `Break-even win probability at this price: ${be.toFixed(be < 1 ? 2 : 1)}% — BUY only if you believe the outcome is MORE likely than this; PASS if less.`
        );
      } else {
        lines.push(
          `Break-even in USD needs a ${cur}/USD rate (none set) — solve for the break-even ${cur} value instead: it's +EV iff win_prob × $${prizeUsd.toFixed(2)} > ${buy} ${cur}.`
        );
      }
    }
  }
  if (mintNum != null) {
    const mintLabel = (card.prizeType ?? card.event?.kind ?? "").toUpperCase() === "CASH"
      ? `$${mintNum.toFixed(2)}`
      : `${mintNum} GOLD`;
    lines.push(
      soldOut
        ? `Mint price was ${mintLabel}, but max supply (${card.maxSupply}) is fully minted — you CANNOT buy at mint. Judge value against the BUY price above, not the mint price.`
        : `Mint price per card: ${mintLabel}`
    );
  }
  if (card.pricing?.isTradeable != null) lines.push(`Tradeable: ${card.pricing.isTradeable}`);

  // ---- Guard: don't "forecast" a settled or past-deadline event from priors ----
  const eventMs = card.event?.eventDate ? Date.parse(card.event.eventDate) : NaN;
  const pastDeadline = !Number.isNaN(eventMs) && eventMs < Date.now();
  const resolved = card.event?.status === "RESOLVED" || !!card.event?.winningOutcomeId;
  if (resolved || pastDeadline) {
    lines.unshift(
      `⚠️ RESOLUTION ALERT: this event is ${
        resolved ? "marked RESOLVED" : "past its event date"
      } (${card.event?.eventDate ?? "date unknown"}). Your FIRST task is to WEB-SEARCH the ACTUAL outcome and state plainly whether this card WON or LOST. Do NOT forecast a settled event from priors — find the real result. If you cannot confirm it, say so explicitly and do not invent a probability.`
    );
  }
  return lines.join("\n");
}

const SHARED_CONTEXT = `Upshot Cards is a prediction-market platform: a "card" represents a specific
outcome (e.g. "ETH closes above $4000"). If the predicted outcome happens, the card "wins" and pays out a
reward. Rewards come on different rails depending on the card: CASH (real money), POINTS/GOLD (in-app points),
or a SHOT (a raffle/prize entry) — the brief states which rail and amount apply to this card.
You are evaluating whether this card's predicted outcome will occur — i.e. the probability it WINS — and
whether buying it is a good bet given that reward.

Judging value (BUY / HOLD / PASS):
- Base your call on the ACTUAL price to acquire the card right now — the "Cost to BUY now" line — NOT the
  mint price, which is frequently sold out and unobtainable.
- The reward and the buy price are often in DIFFERENT currencies (e.g. reward in CASH/USD, price in SHOT).
  A bet is +EV when  win_probability × reward  >  buy_price.  Convert to a common currency before comparing.
- If the brief already shows the buy price converted to USD (≈ $X), compare directly against the USD reward.
- If you are NOT given a USD value for the buy currency, DO NOT invent an exchange rate. Instead solve for the
  break-even rate: the maximum the buy currency can be worth for the bet to stay +EV
  (break_even_price_per_unit = win_probability × reward_usd ÷ buy_price_in_units), and frame your lean around it
  — e.g. "BUY only if 1 SHOT is worth less than $0.0020; PASS if you value SHOT above that." State the assumption.`;

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Run one expert turn; forwards deltas and returns full text. Round 1 researches
 * with web search; round 2 is a single no-search turn — the rebuttal reasons over
 * round-1 findings instead of re-running the (expensive) agentic search loop.
 */
async function runExpert(
  expert: Expert,
  userPrompt: string,
  round: number,
  emit: Emit,
  outerSignal?: AbortSignal,
  onUsage?: (u: TurnUsage) => void
): Promise<string> {
  emit({ type: "expert_start", expertId: expert.id, name: expert.name, bias: expert.bias, round });

  const roundDirective =
    round === 1
      ? `Use web search to research current facts BEFORE you commit to a number — weight the most recent information heavily and stamp the date of time-sensitive facts (a settled or stale fact must not be treated as a live forecast). Cite what you find. Budget: at most 3 searches TOTAL, one at a time — once you have searched 3 times (or learned enough sooner), your NEXT message MUST be the final written assessment with NO tool calls. You have a hard step limit; an unanswered turn is a failed turn, and a decent answer from 2 searches beats no answer from 6. NEVER state an event result you did not find in a source; if the outcome hasn't happened yet, forecast it and say so.`
      : `You have NO web access this turn. Argue strictly from your round-1 research (included below) and the other council members' takes — do not invent new facts. If your own round-1 research is missing or incomplete, say so, lean on the others' takes, and be explicitly conservative — NEVER assert an event result nobody sourced.`;

  const system = `${expert.persona}\n\n${SHARED_CONTEXT}\n\nToday's date is ${today()}. ${roundDirective} Keep your written analysis under 150 words — dense and factual, no filler.`;

  // Per-expert timeout: abort a hung turn but keep whatever it streamed so the
  // debate and synthesis still have signal from it.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXPERT_TIMEOUT_MS);
  // Fold the run-wide signal (client Stop / disconnect) into this turn's controller.
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort();
    else outerSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  let acc = "";
  let full = "";
  try {
    full = await runAgent(
      {
        role: "expert",
        system,
        prompt: userPrompt,
        webSearch: round === 1,
        maxTurns: round === 1 ? R1_MAX_TURNS : 1,
        signal: controller.signal,
      },
      {
        onText: (text) => {
          acc += text;
          emit({ type: "delta", expertId: expert.id, round, text });
        },
        onThink: (text) => emit({ type: "think", expertId: expert.id, round, text }),
        onTool: (tool, detail) => emit({ type: "tool", expertId: expert.id, round, tool, detail }),
        onUsage,
      }
    );
  } catch {
    // Timed out or errored mid-stream — fall through with the partial text.
    if (controller.signal.aborted) {
      emit({
        type: "tool",
        expertId: expert.id,
        round,
        tool: "timeout",
        detail: `cut off after ${Math.round(EXPERT_TIMEOUT_MS / 1000)}s`,
      });
    }
  } finally {
    clearTimeout(timer);
  }

  // Stream fallback: after multi-turn tool use the SDK sometimes delivers the
  // final text only in the `result` message with no text deltas — without this
  // the UI panel for the round renders empty even though the run succeeded.
  if (!acc.trim() && full.trim()) {
    emit({ type: "delta", expertId: expert.id, round, text: full.trim() });
  }

  emit({ type: "expert_done", expertId: expert.id, round });
  return (full || acc).trim();
}

/**
 * Orchestrate the full council deliberation:
 *   Round 1 — five experts independently research and give a take (parallel)
 *   Round 2 — each expert rebuts the others after seeing all takes (parallel)
 *   Synthesis — the chair weighs everything into a final verdict (streamed)
 */
export async function runCouncil(card: Card, emit: Emit, signal?: AbortSignal): Promise<void> {
  const brief = cardBrief(card);

  // Running token/cost totals for the whole card — emitted after every turn so
  // the UI always shows the live spend.
  const totals = { input: 0, output: 0, cacheRead: 0, costUsd: 0 };
  const onUsage = (u: TurnUsage) => {
    totals.input += u.inputTokens + u.cacheCreationTokens;
    totals.output += u.outputTokens;
    totals.cacheRead += u.cacheReadTokens;
    totals.costUsd += u.costUsd;
    emit({
      type: "cost",
      inputTokens: totals.input,
      outputTokens: totals.output,
      cacheReadTokens: totals.cacheRead,
      costUsd: totals.costUsd,
    });
  };

  // Bail the instant the client stops listening (Stop / NEW BATCH / disconnect).
  // Without this, an aborted run still launches round 2 (4 turns) + synth, burning
  // the subscription on work nobody will see.
  const aborted = () => signal?.aborted === true;
  if (aborted()) return;

  // ---- Round 1: independent research ----
  emit({
    type: "status",
    phase: "research",
    message: `Council researching independently (via ${providerLabel()})…`,
  });

  const round1Prompt = `Here is the card under review:\n\n${brief}\n\nResearch this outcome and give your independent assessment. End your response with three lines exactly:\nPROBABILITY: <0-100>%\nLEAN: <BUY | HOLD | PASS>\nSTATUS: <SETTLED | OPEN>  (SETTLED only if you FOUND the decided outcome in a source — name the source; otherwise OPEN)`;

  const round1raw = await Promise.all(
    EXPERTS.map((e) => runExpert(e, round1Prompt, 1, emit, signal, onUsage))
  );
  // An expert that ran out of steps (or errored) returns "" — make that explicit
  // downstream, or round 2 "argues from research" that doesn't exist and the
  // council confabulates facts nobody sourced.
  const round1 = round1raw.map((t, i) => {
    if (t) return t;
    const note =
      "(NO round-1 take — this expert ran out of research steps before writing an assessment. Treat their input as MISSING, not as agreement.)";
    // Show the gap in the UI too — an empty panel reads as a glitch.
    emit({ type: "delta", expertId: EXPERTS[i].id, round: 1, text: note });
    return note;
  });

  if (aborted()) return;

  // ---- Round 2: rebuttal / deliberation ----
  emit({ type: "status", phase: "debate", message: "Council debating each other's takes…" });

  const round2 = await Promise.all(
    EXPERTS.map((e, selfIdx) => {
      // Feed digests, not full transcripts — same signal, a fraction of the tokens.
      const others = EXPERTS.map((x, i) => (i === selfIdx ? null : digest(x, round1[i])))
        .filter(Boolean)
        .join("\n\n");

      // Round 2 has no web search, so the expert needs its OWN round-1 research
      // back (a fresh query has no memory of it) plus the others' digests.
      const prompt = `The card under review:\n\n${brief}\n\nYOUR round-1 research and take:\n\n${round1[selfIdx].trim()}\n\nHere are the other council members' first-round takes (digested):\n\n${others}\n\nWhere do you disagree with them, and why? Do any of their points change your view? Give your UPDATED assessment, ending with three lines exactly:\nPROBABILITY: <0-100>%\nLEAN: <BUY | HOLD | PASS>\nSTATUS: <SETTLED | OPEN>  (SETTLED only if a sourced, decided outcome was found — you cannot upgrade to SETTLED this round, since you cannot search)`;

      return runExpert(e, prompt, 2, emit, signal, onUsage);
    })
  );

  // Synth gets a short digest of where each pilot started plus a larger digest of
  // their FINAL take — the chair weighs positions, it doesn't need full transcripts.
  const finalTakes = EXPERTS.map(
    (e, i) => `${digest(e, round1[i])}\n${digest(e, round2[i], 700, " · FINAL after debate")}`
  ).join("\n\n");

  if (aborted()) return;

  // ---- Fact-gate: a "settled" outcome needs corroboration ----
  // One pilot over-reading a speculative article must not let the council treat
  // a live event as decided. SETTLED claims come from round 1 (the round with
  // web access); fewer than 2 independent claims → the synth is told to treat
  // the outcome as OPEN and discount any asserted result.
  const settledBy = EXPERTS.filter((_, i) => extractStatus(round1[i]) === "SETTLED").map(
    (e) => e.name
  );
  const factGate =
    settledBy.length >= 2
      ? `\n\nFact check: ${settledBy.length} of ${EXPERTS.length} pilots independently sourced the outcome as already SETTLED (${settledBy.join(", ")}). Before treating the outcome as decided, you MUST verify they agree on WHAT happened (same winner / same result). If their reported results disagree, at least one source is wrong — treat the outcome as DISPUTED, do NOT pick a winner, forecast cautiously, and flag the contradiction in Risks.`
      : settledBy.length === 1
        ? `\n\nFact check: only ONE pilot (${settledBy[0]}) claims the outcome is already settled — that is UNCORROBORATED. Treat the outcome as OPEN: discount the asserted result, forecast the probability, and flag the uncorroborated claim in Risks.`
        : `\n\nFact check: no pilot sourced a decided outcome — the event is OPEN. If any take speaks of the result in the past tense, treat it as unsourced speculation, not fact.`;

  // ---- Synthesis: final verdict ----
  emit({ type: "status", phase: "verdict", message: "Synthesizing the final verdict…" });

  const synthSystem = `You are the chair of a prediction-market council. Four expert analysts with different
biases (a quant on base rates, a domain insider on resolution mechanics, a contrarian, and a market/odds reader)
have each researched and debated a card. Weigh their arguments — don't just average them. Note where they agree
and where the disagreement is most informative. Be decisive but honest about uncertainty.\n\n${SHARED_CONTEXT}\n\nToday's date is ${today()}.`;

  const synthPrompt = `The card under review:\n\n${brief}\n\nThe council's takes:\n\n${finalTakes}${factGate}\n\nDeliver the final verdict in markdown with these sections:\n\n## Verdict\nOne punchy sentence.\n\n## Final probability\nA single number 0–100% that the card WINS, plus your confidence (Low / Medium / High).\n\n## The split\nState the range of the four pilots' probabilities (lowest–highest, naming who anchored each end), then call out the SINGLE most informative disagreement — the one clash that actually matters for the decision — and say which side you sided with and why. Don't just note they agreed; surface where the tension was.\n\n## Recommendation\nBUY, HOLD, or PASS — and at the current price, is it +EV? One short paragraph.\n\n## Key factors\n3–5 bullets driving the call.\n\n## Risks\n2–3 bullets on what would make this wrong.\n\nKeep the whole verdict under 300 words.`;

  const synthController = new AbortController();
  const synthTimer = setTimeout(() => synthController.abort(), SYNTH_TIMEOUT_MS);
  if (signal) {
    if (signal.aborted) synthController.abort();
    else signal.addEventListener("abort", () => synthController.abort(), { once: true });
  }
  let verdictText = "";
  try {
    await runAgent(
      {
        role: "synth",
        system: synthSystem,
        prompt: synthPrompt,
        webSearch: false,
        maxTurns: 2,
        signal: synthController.signal,
      },
      {
        onText: (text) => {
          verdictText += text;
          emit({ type: "verdict_delta", text });
        },
        onUsage,
      }
    );
  } catch {
    // Partial verdict already streamed; continue to reconciliation.
  } finally {
    clearTimeout(synthTimer);
  }

  // ---- Reconcile the headline against the pilots (audit #5) ----
  const pilotProbs = EXPERTS.map((_, i) => extractCall(`${round1[i]}\n${round2[i]}`).prob).filter(
    (p): p is number => p != null
  );
  if (pilotProbs.length) {
    const sorted = [...pilotProbs].sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const mid = sorted.length % 2
      ? sorted[(sorted.length - 1) / 2]
      : Math.round((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2);
    const headline = extractVerdictProb(verdictText);
    // Divergent if the headline lands outside the pilots' range or >15pts off the median.
    const divergent =
      headline != null && (headline < min || headline > max || Math.abs(headline - mid) > 15);
    emit({ type: "reconcile", min, max, median: mid, headline, divergent });
  }

  // Persist the finished run to local history (fail-soft; skip aborted/empty runs).
  if (!aborted() && verdictText.trim()) {
    saveRun({
      cardId: card.id,
      cardName: card.name,
      outcomeName: card.outcomeName ?? null,
      eventName: card.event?.name ?? null,
      probability: extractVerdictProb(verdictText),
      call: extractVerdictCall(verdictText),
      verdict: verdictText.trim(),
      inputTokens: totals.input,
      outputTokens: totals.output,
      cacheReadTokens: totals.cacheRead,
      costUsd: totals.costUsd,
      cardJson: JSON.stringify(card),
    });
  }

  emit({ type: "done" });
}
