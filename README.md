# Upshout Council

An AI council that researches and predicts on [Upshot Cards](https://upshot.cards).
Paste a card ID or URL and five prediction-market **pilots** — each with a different
bias — research it with web search, debate each other, and a synthesizer delivers a
final probability + **BUY / HOLD / PASS** verdict. Styled as a Designers Republic ×
WipEout '95 HUD.

> **It runs on a subscription you already pay for — not an API key.** Point it at your
> **Claude** plan *or* your **ChatGPT (Codex)** plan and it drives that CLI locally. No
> per-call billing.

---

## Pick cards two ways

- **Paste links** — one or many card IDs / `upshot.cards` URLs (one per line). Each becomes
  its own council run.
- **From wallet** — enter a wallet address or `upshot.cards/profile/0x…` URL to load every
  card that profile owns, then **search and filter** (by prize currency you can win —
  CASH / GOLD / SHOT — and by rarity) and multi-select which to predict. Only cards still
  **open to predict** (not resolved, not past their event date) are shown.
- **Event** — paste an `upshot.cards/event/<id>` URL to fetch every outcome card in that
  event and auto-run them. Shown as a **compact verdict list** (no per-card debate UI,
  since events can have many cards): each row has a live status dot, and on finish the win
  probability, a BUY/HOLD/PASS call, and a **BUY ↗** link straight to the card.

Selected cards run as **parallel councils** — up to **3 at once** (they share your single
subscription), the rest queue automatically. Each card gets its own independent panel with
its own **Stop** button, so runs never interrupt or bleed into each other. Stop aborts the
stream end-to-end (client → server → every agent), so it actually stops spending your plan.

After the verdict, a **reconciliation** note flags when the synthesizer's headline
probability lands outside where the four pilots actually landed — a cue to read *The split*
before trusting the number.

## How it works

1. **Resolve the card** — `GET /api/card?input=<id-or-url>` fetches it from the Upshot API
   server-side (or `GET /api/cards?wallet=<addr>` for a whole profile). If Bunny Shield
   blocks the request (HTML challenge), the UI falls back to pasting the card JSON
   (`POST /api/card`).
2. **Convene the council** — `POST /api/council` streams the deliberation over SSE:
   - **Round 1** — the four experts research independently (parallel, web search,
     agentic loop capped at `COUNCIL_R1_MAX_TURNS`, default 6).
   - **Round 2** — each rebuts the others after seeing their takes. This is a **single
     no-web-search turn**: the expert gets its own round-1 research back plus digests of
     the others, and argues from that. (Re-running the agentic search loop here was the
     single biggest token sink.)
   - **Synthesis** — a final verdict weighs the arguments into one probability + call.
     The chair reads **digests** of each pilot's takes, not full transcripts.

The orchestration (`lib/council.ts`) is provider-agnostic: it asks `lib/llm` to run each
turn, and `lib/llm` dispatches to whichever backend you selected.

### The four pilots (`lib/experts.ts`)

| Pilot          | Bias                  |
| -------------- | --------------------- |
| The Quant      | Base rates & priors   |
| The Insider    | Domain expertise      |
| The Contrarian | Fade the consensus    |
| The Sharp      | Market & odds reader  |

(Recency is a cross-cutting instruction every pilot follows, rather than a dedicated seat.)

Experts and the synthesizer all run on Sonnet / `gpt-5-codex` by default — a synth turn
runs per card, and Opus is ~5× the cost, so it is **not** the default. Override with
`CLAUDE_SYNTH_MODEL=opus` only if you accept that burn. All via your subscription — see below.

### Token budget & live cost readout

A single card is **9 LLM calls** (4 research + 4 rebuttals + 1 synthesis); an event can be
10+ cards, so the pipeline is aggressively token-tuned:

- Round 1's agentic search loop is capped (`COUNCIL_R1_MAX_TURNS=6` by default) — each
  extra turn re-sends the whole growing context including fetched pages, so cost grows
  quadratically with turns. Lower it only with care — below ~6 experts can run out of steps before writing their assessment.
- Round 2 runs **without web search** as a single turn (see above).
- The toolset is a positive base set (`tools: ["WebSearch","WebFetch"]`, nothing on
  no-search turns) — `allowedTools` alone only gates permissions, it doesn't remove
  schema tokens, and a full toolset triggers schema deferral that makes experts burn
  their first turn on ToolSearch.
- Experts are budgeted to 3 searches and ~150 words; the verdict to ~300 words. An
  expert that runs out of steps without answering is marked as **MISSING** downstream
  (never silently empty — round 2 would otherwise "debate" research that doesn't exist
  and confabulate facts nobody sourced).

Every turn reports its real usage: the UI shows a **live token/cost tally** per card (in
the status ticker, and per row in Event mode) plus a **Σ batch total** in the batch bar.
On API-key billing the dollar cost shows too; on a subscription it's tokens only.

### Run history (local SQLite)

Every finished run is saved to a **local SQLite DB** — `data/council.db`, created
automatically on first use (override the path with `COUNCIL_DB_PATH`; the `data/` dir is
gitignored). Stored per run: card/event/outcome, final probability + call, the full verdict
markdown, token/cost totals, and a timestamp.

The **HISTORY** tab in the UI lists past researches (newest first) with search, expandable
verdicts, per-run delete, and CLEAR ALL. Programmatic access:

```bash
GET    /api/history?search=&limit=   # list runs (JSON)
DELETE /api/history?id=N             # delete one
DELETE /api/history?all=1            # wipe history
```

Saving is fail-soft: a broken DB never kills a live council stream. Aborted/stopped runs
are not saved.

---

## Setup

### 0. Prerequisites

- **Node.js 18+**
- A working login for **one** of the two providers (next step).

```bash
git clone https://github.com/hazy2go/upshout-council.git
cd upshout-council
npm install
cp .env.example .env.local
```

### 1. Pick your provider

Edit `.env.local` and set `LLM_PROVIDER` to `claude` or `codex`.

<details open>
<summary><b>Option A — Claude (Claude Code subscription)</b></summary>

Uses the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk),
which drives your local `claude` CLI login.

```bash
# 1. Install Claude Code if you don't have it, then log in once:
claude            # then run /login   (or: claude setup-token)

# 2. In .env.local:
LLM_PROVIDER=claude
```

> ⚠️ Make sure **`ANTHROPIC_API_KEY` is NOT set** in your environment. If it is, the SDK
> bills the API instead of using your subscription.

The `claude` binary must be on your `PATH` (it is, if you use Claude Code). Optional model
overrides: `CLAUDE_EXPERT_MODEL` (default `sonnet`), `CLAUDE_SYNTH_MODEL` (default `sonnet`).
</details>

<details>
<summary><b>Option B — Codex (ChatGPT subscription)</b></summary>

Uses the [Codex SDK](https://www.npmjs.com/package/@openai/codex-sdk), which drives your
local `codex` CLI login. Web search runs through Codex's built-in search tool.

```bash
# 1. Install Codex if you don't have it:
npm install -g @openai/codex          # or: brew install codex

# 2. Log in with your ChatGPT plan (opens a browser):
codex             # choose "Sign in with ChatGPT"   (or: codex login)

# 3. In .env.local:
LLM_PROVIDER=codex
```

> ⚠️ Make sure **`OPENAI_API_KEY` / `CODEX_API_KEY` are NOT set**. If they are, Codex bills
> the API instead of using your ChatGPT subscription.

Optional overrides: `CODEX_EXPERT_MODEL` / `CODEX_SYNTH_MODEL` (default `gpt-5-codex`),
`CODEX_REASONING_EFFORT` (`minimal`|`low`|`medium`|`high`|`xhigh`).

> Web search availability depends on your ChatGPT plan. If a run can't search, the council
> still reasons but won't cite fresh facts.
</details>

### 2. Run it

```bash
npm run dev       # http://localhost:3000
```

Paste an Upshot card ID or URL and watch the council deliberate. The header shows which
provider is active (`…via Claude` / `…via Codex (ChatGPT)`).

Quick CLI smoke test without the UI:

```bash
npm run council:demo
```

---

## Switching providers

It's just one env var — no code change:

```bash
LLM_PROVIDER=claude   # Claude plan
LLM_PROVIDER=codex    # ChatGPT plan
```

Restart `npm run dev` after changing `.env.local`.

---

## Environment reference

| Variable | Default | Purpose |
| --- | --- | --- |
| `LLM_PROVIDER` | `claude` | `claude` or `codex` |
| `CLAUDE_EXPERT_MODEL` | `sonnet` | expert model (Claude) |
| `CLAUDE_SYNTH_MODEL` | `sonnet` | synthesizer model (Claude) |
| `CODEX_EXPERT_MODEL` | `gpt-5-codex` | expert model (Codex) |
| `CODEX_SYNTH_MODEL` | `gpt-5-codex` | synthesizer model (Codex) |
| `CODEX_REASONING_EFFORT` | — | Codex reasoning effort |
| `UPSHOT_API_BASE` | mainnet | override the Upshot API URL |
| `UPSHOT_SHOT_USD` | — | dollars per 1 SHOT (for USD EV; see below) |
| `UPSHOT_BEARER` | — | replay browser auth for server-side card fetch |
| `UPSHOT_COOKIE` | — | Bunny Shield cookies (the part that clears the shield) |
| `COUNCIL_EXPERT_TIMEOUT_MS` | `210000` | abort a hung expert turn (keeps partial output) |
| `COUNCIL_SYNTH_TIMEOUT_MS` | `180000` | abort a hung synthesis turn |
| `COUNCIL_R1_MAX_TURNS` | `6` | round-1 agentic search turn cap per expert (cost grows quadratically) |
| `COUNCIL_DB_PATH` | `data/council.db` | where the SQLite run history lives |

### Pricing & expected value

Upshot cards pay on different rails — **CASH** (USD-pegged), **POINTS/GOLD**, or **SHOT** —
and trade on a secondary market that's often in a *different* currency than the prize. The
council:

- judges value against the **live secondary-market buy price**, not the mint price (mints
  are frequently sold out and unobtainable), and
- converts the buy price to USD when possible. Upshot exposes **no SHOT/USD rate**, so set
  `UPSHOT_SHOT_USD` to get dollar EV directly; otherwise the council reports the
  **break-even** rate ("BUY only if 1 SHOT < $X") instead of guessing.

### Bunny Shield note

The Upshot API sits behind Bunny Shield, which flags IPs. If your IP is flagged, server-side
fetches return the HTML challenge. The UI gives you three escape hatches, in order of how
much pain they cost:

1. **PASTE TOKEN** (top of the page). Run this bookmarklet on a logged-in `upshot.cards` tab
   and paste the copied JSON — the app pulls out the bearer (and decodes its JWT for the
   wallet + expiry) and uses it for all subsequent fetches. The token never touches disk; it
   sits in process memory until the server restarts or it expires. Beats editing
   `.env.local`.

   ```js
   javascript:(() => {
     const raw = localStorage.getItem("global-store");
     const token = JSON.parse(raw)?.state?.authState?.accessToken;
     const p = JSON.parse(atob(token.split(".")[1].replace(/-/g,"+").replace(/_/g,"/")));
     const json = JSON.stringify({ token, expires_at: p.exp ? new Date(p.exp*1000).toISOString() : null, wallet: p.walletAddress, user_id: p.id }, null, 2);
     navigator.clipboard?.writeText(json);
   })();
   ```

2. **Paste the API response JSON**. If the bearer alone isn't enough (Bunny Shield is still
   blocking by IP), each fetch flow (single card, event) lets you paste the raw JSON straight
   from your browser's DevTools → Network panel.

3. **`UPSHOT_BEARER` / `UPSHOT_COOKIE` in `.env.local`**. The classic path — replay your
   browser session with full headers. The runtime token from (1) takes precedence when set.
   See `upshot-api/BUNNY_SHIELD.md`.

---

## Layout

```
app/
  page.tsx              # the HUD dashboard (client)
  layout.tsx            # fonts + shell
  globals.css           # the whole aesthetic
  api/card/route.ts     # fetch / paste-fallback
  api/council/route.ts  # SSE deliberation stream
  api/history/route.ts  # run history: list / delete (local SQLite)
  api/auth/route.ts     # runtime Upshot bearer (paste bookmarklet token)
  api/event/route.ts    # event card list + paste-JSON fallback
lib/
  council.ts            # orchestration (rounds + synthesis), provider-agnostic
  llm/
    index.ts            # provider dispatch (LLM_PROVIDER) + runAgent()
    claude.ts           # Claude Agent SDK runner (Claude sub)
    codex.ts            # Codex SDK runner (ChatGPT sub)
    types.ts            # shared RunRequest / callbacks / TurnUsage contract
  db.ts                 # SQLite run history (auto-created at data/council.db)
  upshotAuth.ts         # in-memory runtime bearer (bookmarklet paste flow)
  experts.ts            # the four personas
  upshot.ts             # Upshot client + Bunny Shield detection
  types.ts
data/council.db         # local run history (gitignored, created on first run)
upshot-api/             # cloned API docs (reference)
```

Adding a third provider is just another file in `lib/llm/` implementing `LlmRunner` and a
branch in `lib/llm/index.ts`.

---

Not financial advice. It's just numbers.
