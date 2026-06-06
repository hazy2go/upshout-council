"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Card, CouncilEvent } from "@/lib/types";
import { EXPERTS } from "@/lib/experts";
import { fromMicro } from "@/lib/upshot";
import { extractCall, extractVerdictProb, extractVerdictCall } from "@/lib/parse";

type RoundData = { text: string; think: string; tools: { tool: string; detail: string }[] };
type ExpertState = { r1: RoundData; r2: RoundData; active: boolean };

const emptyRound = (): RoundData => ({ text: "", think: "", tools: [] });
const emptyExpert = (): ExpertState => ({ r1: emptyRound(), r2: emptyRound(), active: false });

// Pull the latest probability + lean an expert committed to (round 2 wins over round 1).
function readout(st?: ExpertState): { prob: number | null; lean: string | null } {
  return extractCall(`${st?.r1.text ?? ""}\n${st?.r2.text ?? ""}`);
}

/** Compact token count, e.g. 41_300 -> "41.3k". */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Cumulative per-card spend, as carried by `cost` events. */
type CostTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
};

/** Render a cost tally as a compact one-liner, e.g. "41.3k in · 6.2k out · $0.09". */
function fmtCost(c: CostTotals): string {
  let s = `${fmtTokens(c.inputTokens)} in · ${fmtTokens(c.outputTokens)} out`;
  if (c.cacheReadTokens > 0) s += ` · ${fmtTokens(c.cacheReadTokens)} cached`;
  if (c.costUsd > 0) s += ` · $${c.costUsd.toFixed(2)}`;
  return s;
}

type Phase = "idle" | "research" | "debate" | "verdict" | "done";

const CONCURRENCY = 3; // councils streaming at once (shared single subscription)

export default function Home() {
  const [mode, setMode] = useState<"link" | "wallet" | "event" | "history">("link");
  const [input, setInput] = useState(""); // one or many IDs/URLs (newline/comma separated)
  const [wallet, setWallet] = useState("");
  const [eventUrl, setEventUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // `pasteMode` is the Bunny Shield fallback: "card" for the link/wallet single-card
  // paste, "event" for the event-cards-list paste. false = hidden.
  const [pasteMode, setPasteMode] = useState<false | "card" | "event">(false);
  const [pasteValue, setPasteValue] = useState("");

  // wallet picker
  const [picker, setPicker] = useState<Card[] | null>(null);
  const [pickerMeta, setPickerMeta] = useState<{ total: number; shown: number } | null>(null);
  const [search, setSearch] = useState("");
  const [prizeFilter, setPrizeFilter] = useState(""); // prize rail you can win
  const [rarityFilter, setRarityFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // the batch actually running, + which runs have finished (for the scheduler)
  const [runs, setRuns] = useState<Card[]>([]);
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());
  const [runView, setRunView] = useState<"full" | "compact">("full");
  const [batchTitle, setBatchTitle] = useState("");

  const markDone = useCallback(
    (id: string) => setDoneIds((p) => new Set(p).add(id)),
    []
  );

  // Latest cumulative spend per card, reported up by each run for the batch total.
  const [costs, setCosts] = useState<Record<string, CostTotals>>({});
  const reportCost = useCallback(
    (id: string, c: CostTotals) => setCosts((p) => ({ ...p, [id]: c })),
    []
  );
  const batchCost = useMemo(() => {
    const sum: CostTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 };
    for (const c of Object.values(costs)) {
      sum.inputTokens += c.inputTokens;
      sum.outputTokens += c.outputTokens;
      sum.cacheReadTokens += c.cacheReadTokens;
      sum.costUsd += c.costUsd;
    }
    return sum.inputTokens || sum.outputTokens ? sum : null;
  }, [costs]);

  // `compact` is the event view: just the verdict per card, no debate/stream UI.
  function startBatch(cards: Card[], view: "full" | "compact" = "full", title = "") {
    const seen = new Set<string>();
    const uniq = cards.filter((c) => c.id && !seen.has(c.id) && seen.add(c.id));
    if (!uniq.length) return;
    setDoneIds(new Set());
    setCosts({});
    setRunView(view);
    setBatchTitle(title);
    setRuns(uniq);
  }

  function resetBatch() {
    setRuns([]);
    setDoneIds(new Set());
    setCosts({});
    setBatchTitle("");
    setError("");
  }

  // A run is active (allowed to stream) if fewer than CONCURRENCY not-done runs precede it.
  const activeFor = (i: number) => {
    let notDoneBefore = 0;
    for (let j = 0; j < i; j++) if (!doneIds.has(runs[j].id)) notDoneBefore++;
    return notDoneBefore < CONCURRENCY;
  };

  // ---- Link mode: resolve one OR many IDs/URLs into cards, then batch them. ----
  async function resolveOne(token: string): Promise<{ card?: Card; error?: string }> {
    try {
      const res = await fetch(`/api/card?input=${encodeURIComponent(token)}`);
      const data = await res.json();
      if (res.status === 409 && data.error === "bunny_shield") return { error: "bunny_shield" };
      if (!res.ok) return { error: data.error || "fetch failed" };
      return { card: data.card as Card };
    } catch (e) {
      return { error: e instanceof Error ? e.message : "network error" };
    }
  }

  async function handleConveneLinks() {
    const tokens = input.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    if (!tokens.length || busy) return;
    setBusy(true);
    setError("");
    setPasteMode(false);
    const results = await Promise.all(tokens.map(resolveOne));
    const cards = results.map((r) => r.card).filter(Boolean) as Card[];
    const fails = results.filter((r) => !r.card);
    setBusy(false);
    if (!cards.length) {
      if (fails.some((f) => f.error === "bunny_shield")) setPasteMode("card");
      else setError(`Couldn't resolve any cards${fails[0]?.error ? ` (${fails[0].error})` : ""}.`);
      return;
    }
    if (fails.length) {
      const shielded = fails.some((f) => f.error === "bunny_shield");
      setError(
        `Resolved ${cards.length}/${tokens.length}. ${fails.length} failed${shielded ? " — Bunny Shield blocked some; paste those manually." : "."}`
      );
    }
    startBatch(cards);
  }

  async function handlePaste() {
    setError("");
    const endpoint = pasteMode === "event" ? "/api/event" : "/api/card";
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ json: pasteValue }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Could not parse pasted JSON.");
        return;
      }
      const wasEvent = pasteMode === "event";
      setPasteMode(false);
      setPasteValue("");
      if (wasEvent) {
        startBatch(data.cards as Card[], "compact", data.eventName || "EVENT");
      } else {
        startBatch([data.card as Card]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not parse pasted JSON.");
    }
  }

  // ---- Wallet mode: load a profile's predictable cards into the picker. ----
  async function handleLoadWallet() {
    if (!wallet.trim() || busy) return;
    setBusy(true);
    setError("");
    setPicker(null);
    setSelected(new Set());
    try {
      const res = await fetch(`/api/cards?wallet=${encodeURIComponent(wallet)}`);
      const data = await res.json();
      if (res.status === 409 && data.error === "bunny_shield") {
        setError("Bunny Shield blocked the wallet fetch — set UPSHOT_BEARER/UPSHOT_COOKIE or try a clean IP.");
      } else if (!res.ok) {
        setError(data.error || "Failed to load cards.");
      } else {
        setPicker(data.cards as Card[]);
        setPickerMeta({ total: data.total, shown: data.shown });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error.");
    } finally {
      setBusy(false);
    }
  }

  // ---- Event mode: load every card of an event and auto-run them (compact view). ----
  async function handleLoadEvent() {
    if (!eventUrl.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/event?event=${encodeURIComponent(eventUrl)}`);
      const data = await res.json();
      if (res.status === 409 && data.error === "bunny_shield") {
        setError(
          "Bunny Shield blocked the event fetch — set UPSHOT_BEARER/UPSHOT_COOKIE, try a clean IP, or paste the event JSON below."
        );
        setPasteMode("event");
      } else if (!res.ok) {
        setError(data.error || "Failed to load event.");
      } else {
        startBatch(data.cards as Card[], "compact", data.eventName || "EVENT");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error.");
    } finally {
      setBusy(false);
    }
  }

  const prizeOf = (c: Card) => (c.prizeType ?? c.event?.kind ?? "").toUpperCase();
  const rarityOf = (c: Card) => (c.rarity ?? "").toUpperCase();

  const prizeOpts = useMemo(
    () => Array.from(new Set((picker ?? []).map(prizeOf).filter(Boolean))).sort(),
    [picker]
  );
  const rarityOpts = useMemo(
    () => Array.from(new Set((picker ?? []).map(rarityOf).filter(Boolean))).sort(),
    [picker]
  );

  const filtered = useMemo(() => {
    if (!picker) return [];
    const q = search.trim().toLowerCase();
    return picker.filter((c) => {
      if (q && !`${c.name} ${c.event?.name ?? ""} ${c.rarity ?? ""}`.toLowerCase().includes(q))
        return false;
      if (prizeFilter && prizeOf(c) !== prizeFilter) return false;
      if (rarityFilter && rarityOf(c) !== rarityFilter) return false;
      return true;
    });
  }, [picker, search, prizeFilter, rarityFilter]);

  function toggle(id: string) {
    setSelected((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  return (
    <div className="wrap">
      <div className="frame">
        <i className="tl" /><i className="tr" /><i className="bl" /><i className="br" />
      </div>
      <div className="gridfloor" />

      <header className="masthead">
        <div>
          <div className="brandtag">
            AG-SYS <b>//</b> PREDICTION RACING LEAGUE <b>//</b> EST.2099
          </div>
          <h1 className="title">
            UPSHOUT<span className="slash"> / </span>COUNCIL
          </h1>
          <div className="kata">アップショウト・カウンシル — 予測評議会</div>
        </div>
        <div className="regblock">
          <div className="barcode" />
          <small>UNIT {String(EXPERTS.length).padStart(2, "0")} · ONLINE</small>
        </div>
      </header>

      <AuthPill />

      <p className="subtitle">
        {EXPERTS.length} AI prediction-market pilots research, debate, and call your Upshot card.
      </p>

      <div className="tabs">
        <button className={mode === "link" ? "on" : ""} onClick={() => setMode("link")}>
          PASTE LINKS
        </button>
        <button className={mode === "wallet" ? "on" : ""} onClick={() => setMode("wallet")}>
          FROM WALLET
        </button>
        <button className={mode === "event" ? "on" : ""} onClick={() => setMode("event")}>
          EVENT
        </button>
        <button className={mode === "history" ? "on" : ""} onClick={() => setMode("history")}>
          HISTORY
        </button>
      </div>

      {mode === "history" && <HistoryPanel />}

      {mode === "link" && (
        <div className="searchbar col">
          <span className="lead">CARD IDs ▸</span>
          <textarea
            className="multiline"
            placeholder="paste one or many card IDs / upshot.cards URLs — one per line…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={busy}
            rows={3}
          />
          <button onClick={handleConveneLinks} disabled={busy || !input.trim()}>
            {busy ? "RESOLVING…" : "CONVENE"}
          </button>
        </div>
      )}

      {mode === "wallet" && (
        <div className="searchbar">
          <span className="lead">WALLET ▸</span>
          <input
            type="text"
            placeholder="0x… or upshot.cards/profile/0x…"
            value={wallet}
            onChange={(e) => setWallet(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleLoadWallet()}
            disabled={busy}
          />
          <button onClick={handleLoadWallet} disabled={busy || !wallet.trim()}>
            {busy ? "LOADING…" : "LOAD CARDS"}
          </button>
        </div>
      )}

      {mode === "event" && (
        <div className="searchbar">
          <span className="lead">EVENT ▸</span>
          <input
            type="text"
            placeholder="upshot.cards/event/cm… (predicts every card, 3 at a time)"
            value={eventUrl}
            onChange={(e) => setEventUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleLoadEvent()}
            disabled={busy}
          />
          <button onClick={handleLoadEvent} disabled={busy || !eventUrl.trim()}>
            {busy ? "LOADING…" : "RUN EVENT"}
          </button>
        </div>
      )}

      {error && <div className="error">{error}</div>}

      {pasteMode && (
        <div className="paste-box">
          <h3>BUNNY SHIELD BLOCKED THE SERVER FETCH</h3>
          {pasteMode === "event" ? (
            <p>
              Open the event in your logged-in browser, hit{" "}
              <code>{`/api/v1/cards?eventId=<id>&include=event,supply&perPage=100`}</code>,
              and paste the JSON response here. If the event has &gt;100 cards, concatenate
              the <code>data</code> arrays from each page — or paste a page at a time. You
              can also use <b>PASTE TOKEN</b> above and retry RUN EVENT.
            </p>
          ) : (
            <p>
              Open the card in your browser, hit{" "}
              <code>{`/api/v1/cards/<id>?include=event,supply`}</code>, and paste the JSON
              here. (Or use <b>PASTE TOKEN</b> above and retry — usually that's enough.)
            </p>
          )}
          <textarea
            placeholder={
              pasteMode === "event"
                ? '{ "data": [ { "id": "cm…", "name": "…", "event": { … } }, … ] }'
                : '{ "data": { "id": "cm…", "name": "…", "event": { … } } }'
            }
            value={pasteValue}
            onChange={(e) => setPasteValue(e.target.value)}
          />
          <div className="paste-actions">
            <button className="solid" onClick={handlePaste} disabled={!pasteValue.trim()}>
              {pasteMode === "event" ? "USE THESE CARDS" : "USE THIS CARD"}
            </button>
            <button
              className="ghost"
              onClick={() => {
                setPasteMode(false);
                setPasteValue("");
              }}
            >
              CANCEL
            </button>
          </div>
        </div>
      )}

      {mode === "wallet" && picker && runs.length === 0 && (
        <div className="picker">
          <div className="picker-head">
            <input
              className="picker-search"
              placeholder="search by card / event / rarity…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              className="picker-filter"
              value={prizeFilter}
              onChange={(e) => setPrizeFilter(e.target.value)}
            >
              <option value="">ALL PRIZES</option>
              {prizeOpts.map((o) => (
                <option key={o} value={o}>
                  WIN: {o}
                </option>
              ))}
            </select>
            <select
              className="picker-filter"
              value={rarityFilter}
              onChange={(e) => setRarityFilter(e.target.value)}
            >
              <option value="">ALL RARITIES</option>
              {rarityOpts.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            <span className="picker-meta">
              {pickerMeta ? `${pickerMeta.shown} open · ${pickerMeta.total} owned` : ""}
              {search || prizeFilter || rarityFilter ? ` · ${filtered.length} match` : ""}
            </span>
            <button className="ghost" onClick={() => setSelected(new Set(filtered.map((c) => c.id)))}>
              SELECT ALL{search || prizeFilter || rarityFilter ? " (FILTERED)" : ""}
            </button>
            <button className="ghost" onClick={() => setSelected(new Set())}>
              CLEAR
            </button>
            <button
              className="solid"
              disabled={selected.size === 0}
              onClick={() => startBatch((picker ?? []).filter((c) => selected.has(c.id)))}
            >
              PREDICT {selected.size || ""} →
            </button>
          </div>
          {picker.length === 0 ? (
            <div className="picker-empty">
              No cards open to predict — every owned card is past its deadline or already resolved.
            </div>
          ) : (
            <div className="picker-list">
              {filtered.map((c) => (
                <label key={c.id} className={`pick ${selected.has(c.id) ? "sel" : ""}`}>
                  <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                  <span className="pick-name">{c.name}</span>
                  <span className="pick-ev">{c.event?.name ?? ""}</span>
                  <span className="pick-when">
                    {c.event?.eventDate ? new Date(c.event.eventDate).toLocaleDateString() : ""}
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      {runs.length > 0 && (
        <>
          <div className="batchbar">
            <span className="section-label">
              {runView === "compact" ? (batchTitle || "EVENT").toUpperCase() : "COUNCIL BATCH"} ·{" "}
              {runs.length} CARD{runs.length > 1 ? "S" : ""} · {doneIds.size}/{runs.length} DONE ·
              MAX {CONCURRENCY} LIVE
            </span>
            {batchCost && (
              <span className="batchcost" title="Total spend across the whole batch so far">
                Σ {fmtCost(batchCost)}
              </span>
            )}
            <button className="ghost" onClick={resetBatch}>
              NEW BATCH
            </button>
          </div>
          {runView === "compact" ? (
            <div className="event-list">
              {runs.map((c, i) => (
                <EventRow key={c.id} card={c} active={activeFor(i)} onDone={markDone} onCost={reportCost} />
              ))}
            </div>
          ) : (
            <div className="runs">
              {runs.map((c, i) => (
                <CouncilRun key={c.id} card={c} active={activeFor(i)} onDone={markDone} onCost={reportCost} />
              ))}
            </div>
          )}
        </>
      )}

      <div className="foot">
        UPSHOUT COUNCIL <b>//</b> NOT FINANCIAL ADVICE <b>//</b> IT&apos;S JUST NUMBERS
      </div>
    </div>
  );
}

// Compact event-mode run: same council + debate under the hood, but we skip the
// streaming/debate UI and surface only the final verdict (events can have many cards).
// ---- Auth pill: paste the bookmarklet token JSON to authenticate server fetches.
// The token never leaves the process — it's held in memory by /api/auth and used
// as the Authorization header on Upshot calls until the server restarts or the
// token expires. Beats editing .env.local. ----

type AuthStatus = {
  active: boolean;
  source?: string;
  wallet?: string | null;
  expiresAt?: number | null;
  tokenPreview?: string;
};

function AuthPill() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/auth");
      setStatus(await res.json());
    } catch {
      setStatus({ active: false });
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  async function save() {
    setSaving(true);
    setErr("");
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: value }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErr(data.error || "Could not parse token.");
        return;
      }
      setValue("");
      setOpen(false);
      await refresh();
    } finally {
      setSaving(false);
    }
  }

  async function clear() {
    await fetch("/api/auth", { method: "DELETE" });
    await refresh();
  }

  const expiresIn = status?.expiresAt
    ? Math.max(0, Math.round((status.expiresAt - Date.now()) / 60000))
    : null;

  return (
    <div className="auth-pill">
      <div className="auth-pill-row">
        <span className={`auth-dot ${status?.active ? "ok" : "off"}`} />
        <span className="auth-label">
          UPSHOT AUTH ▸{" "}
          {status?.active
            ? `${status.wallet ? `${status.wallet.slice(0, 6)}…${status.wallet.slice(-4)}` : "active"}${
                expiresIn != null ? ` · expires in ${expiresIn}m` : ""
              }`
            : "not set — pastes only / public fetches"}
        </span>
        <button className="ghost sm" onClick={() => setOpen((v) => !v)}>
          {open ? "CLOSE" : status?.active ? "REPLACE" : "PASTE TOKEN"}
        </button>
        {status?.active && (
          <button className="ghost sm" onClick={clear}>
            CLEAR
          </button>
        )}
      </div>
      {open && (
        <div className="auth-pill-body">
          <p>
            Run this bookmarklet on a logged-in <code>upshot.cards</code> tab, then paste
            the copied JSON here (or paste the raw bearer):
          </p>
          <pre className="auth-snippet">
{`javascript:(() => {
  const raw = localStorage.getItem("global-store");
  if (!raw) throw new Error("No global-store — log into upshot.cards first.");
  const token = JSON.parse(raw)?.state?.authState?.accessToken;
  if (!token) throw new Error("No accessToken in global-store.");
  const p = JSON.parse(atob(token.split(".")[1].replace(/-/g,"+").replace(/_/g,"/")));
  const json = JSON.stringify({ token, expires_at: p.exp ? new Date(p.exp*1000).toISOString() : null, wallet: p.walletAddress, user_id: p.id }, null, 2);
  navigator.clipboard?.writeText(json);
  console.log("Copied. Wallet:", p.walletAddress);
})();`}
          </pre>
          <textarea
            placeholder='paste { "token": "eyJ…", "wallet": "0x…", … } or a raw eyJ… bearer'
            value={value}
            onChange={(e) => setValue(e.target.value)}
            spellCheck={false}
          />
          {err && <div className="error">{err}</div>}
          <div className="paste-actions">
            <button
              className="solid"
              onClick={save}
              disabled={!value.trim() || saving}
            >
              {saving ? "SAVING…" : "USE THIS TOKEN"}
            </button>
            <button className="ghost" onClick={() => setOpen(false)}>
              CANCEL
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- History: past council runs from the local SQLite DB ----

type HistoryRun = {
  id: number;
  createdAt: string;
  cardId: string;
  cardName: string;
  outcomeName: string | null;
  eventName: string | null;
  probability: number | null;
  call: string | null;
  verdict: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
};

function HistoryPanel() {
  const [runs, setRuns] = useState<HistoryRun[] | null>(null);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [error, setError] = useState("");

  const load = useCallback(async (q: string) => {
    try {
      const res = await fetch(`/api/history?search=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "failed to load history");
      setRuns(data.runs as HistoryRun[]);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load history");
    }
  }, []);

  // Load on open; refetch (debounced) as the search changes.
  useEffect(() => {
    const t = setTimeout(() => load(search), search ? 250 : 0);
    return () => clearTimeout(t);
  }, [search, load]);

  async function remove(id: number) {
    await fetch(`/api/history?id=${id}`, { method: "DELETE" });
    setRuns((p) => p?.filter((r) => r.id !== id) ?? p);
  }

  async function clearAll() {
    if (!confirm("Wipe the entire research history?")) return;
    await fetch(`/api/history?all=1`, { method: "DELETE" });
    setRuns([]);
  }

  function toggleOpen(id: number) {
    setOpen((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  // SQLite stores datetime('now') in UTC without a zone marker — pin it.
  const fmtDate = (s: string) => new Date(s.replace(" ", "T") + "Z").toLocaleString();

  return (
    <div className="history">
      <div className="searchbar">
        <span className="lead">SEARCH ▸</span>
        <input
          placeholder="filter by card, event, or outcome…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button className="ghost" onClick={clearAll} disabled={!runs?.length}>
          CLEAR ALL
        </button>
      </div>

      {error && <p className="error">{error}</p>}
      {runs === null && !error && <p className="hist-empty">Loading history…</p>}
      {runs?.length === 0 && <p className="hist-empty">No saved researches yet — run a council and it lands here.</p>}

      {!!runs?.length && (
        <div className="event-list">
          {runs.map((r) => (
            <div key={r.id} className="hist-item">
              <div className="erow done hist-row" onClick={() => toggleOpen(r.id)}>
                <span className="erow-dot" />
                <div className="erow-main">
                  <div className="erow-name">{r.outcomeName || r.cardName}</div>
                  <div className="erow-sub">
                    {r.outcomeName ? r.cardName : r.eventName ?? ""}
                    <span className="erow-cost">
                      {" "}· {fmtDate(r.createdAt)} ·{" "}
                      {fmtCost({
                        inputTokens: r.inputTokens,
                        outputTokens: r.outputTokens,
                        cacheReadTokens: r.cacheReadTokens,
                        costUsd: r.costUsd,
                      })}
                    </span>
                  </div>
                </div>
                <div className="erow-state">
                  <span className="erow-prob">{r.probability != null ? `${r.probability}%` : "—"}</span>
                  {r.call && <span className={`callbadge sm ${r.call}`}>{r.call}</span>}
                </div>
                <button
                  className="stop sm"
                  title="Delete this run"
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(r.id);
                  }}
                >
                  ✕
                </button>
              </div>
              {open.has(r.id) && (
                <div className="hist-verdict">
                  <Verdict text={r.verdict} />
                  <a
                    className="buybtn"
                    href={`https://upshot.cards/card-detail/${r.cardId}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    VIEW CARD ↗
                  </a>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EventRow({
  card,
  active,
  onDone,
  onCost,
}: {
  card: Card;
  active: boolean;
  onDone: (id: string) => void;
  onCost?: (id: string, c: CostTotals) => void;
}) {
  const [phase, setPhase] = useState<"queued" | "running" | "done" | "error" | "stopped">(
    active ? "running" : "queued"
  );
  const [verdict, setVerdict] = useState("");
  const [cost, setCost] = useState<CostTotals | null>(null);
  const [errMsg, setErrMsg] = useState("");
  const started = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!active || phase === "stopped") return;
    setPhase("running");
    const controller = new AbortController();
    abortRef.current = controller;
    (async () => {
      try {
        const res = await fetch("/api/council", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ card }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          setErrMsg("failed to start");
          setPhase("error");
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let failed = false;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data:")) continue;
            const json = line.slice(5).trim();
            if (!json) continue;
            const ev = JSON.parse(json) as CouncilEvent;
            if (ev.type === "verdict_delta") setVerdict((v) => v + ev.text);
            else if (ev.type === "cost") {
              const c = {
                inputTokens: ev.inputTokens,
                outputTokens: ev.outputTokens,
                cacheReadTokens: ev.cacheReadTokens,
                costUsd: ev.costUsd,
              };
              setCost(c);
              onCost?.(card.id, c);
            } else if (ev.type === "error") {
              failed = true;
              setErrMsg(ev.message);
            } else if (ev.type === "done") setPhase((p) => (p === "running" ? "done" : p));
          }
        }
        if (failed) setPhase((p) => (p === "running" ? "error" : p));
      } catch (e) {
        if (!controller.signal.aborted) {
          setErrMsg(e instanceof Error ? e.message : "stream error");
          setPhase("error");
        }
      } finally {
        // Don't mark done if we were aborted (unmount / StrictMode) — that would
        // slide the scheduler window and over-spawn. Real completions still call it.
        if (!controller.signal.aborted) onDone(card.id);
      }
    })();
    // Aborts the in-flight council if this row unmounts (e.g. NEW BATCH) so the
    // server-side run stops spending the subscription instead of orphaning.
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  function stop() {
    abortRef.current?.abort();
    setPhase("stopped");
    onDone(card.id);
  }

  const prob = phase === "done" ? extractVerdictProb(verdict) : null;
  const call = phase === "done" ? extractVerdictCall(verdict) : null;
  const cardUrl = `https://upshot.cards/card-detail/${card.id}`;

  return (
    <div className={`erow ${phase}`}>
      <span className="erow-dot" />
      <div className="erow-main">
        <div className="erow-name">{card.outcomeName || card.name}</div>
        <div className="erow-sub">
          {card.outcomeName ? card.name : card.event?.name ?? ""}
          {cost && <span className="erow-cost"> · {fmtCost(cost)}</span>}
        </div>
      </div>
      <div className="erow-state">
        {phase === "queued" && <span className="erow-tag">QUEUED</span>}
        {phase === "running" && (
          <span className="erow-tag run">
            <span className="spinner" /> RUNNING
          </span>
        )}
        {phase === "stopped" && <span className="erow-tag">STOPPED</span>}
        {phase === "error" && (
          <span className="erow-tag err" title={errMsg}>
            ERROR
          </span>
        )}
        {phase === "done" && (
          <>
            <span className="erow-prob">{prob != null ? `${prob}%` : "—"}</span>
            {call && <span className={`callbadge sm ${call}`}>{call}</span>}
          </>
        )}
      </div>
      {phase === "running" ? (
        <button className="stop sm" onClick={stop}>
          ◼
        </button>
      ) : phase === "done" ? (
        <a className="buybtn" href={cardUrl} target="_blank" rel="noreferrer">
          BUY ↗
        </a>
      ) : (
        <span className="buybtn-spacer" />
      )}
    </div>
  );
}

// One independent council run: owns its own stream + state so parallel runs
// never share state or interrupt each other. Starts streaming once `active`.
function CouncilRun({
  card: initialCard,
  active,
  onDone,
  onCost,
}: {
  card: Card;
  active: boolean;
  onDone: (id: string) => void;
  onCost?: (id: string, c: CostTotals) => void;
}) {
  const [card, setCard] = useState<Card>(initialCard);
  const [experts, setExperts] = useState<Record<string, ExpertState>>(() =>
    Object.fromEntries(EXPERTS.map((e) => [e.id, emptyExpert()]))
  );
  const [verdict, setVerdict] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState("Queued…");
  const [error, setError] = useState("");
  const [recon, setRecon] = useState<{
    min: number;
    max: number;
    median: number;
    headline: number | null;
    divergent: boolean;
  } | null>(null);
  const [cost, setCost] = useState<CostTotals | null>(null);
  const [stopped, setStopped] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  function stop() {
    abortRef.current?.abort();
    setStopped(true);
    setStatus("Stopped.");
    setPhase("done");
    onDone(initialCard.id);
  }

  useEffect(() => {
    if (!active || stopped) return;

    const apply = (ev: CouncilEvent) => {
      switch (ev.type) {
        case "card":
          setCard(ev.card);
          break;
        case "status":
          setStatus(ev.message);
          if (ev.phase === "research" || ev.phase === "debate" || ev.phase === "verdict")
            setPhase(ev.phase);
          break;
        case "expert_start":
          setExperts((p) => ({ ...p, [ev.expertId]: { ...(p[ev.expertId] ?? emptyExpert()), active: true } }));
          break;
        case "delta":
          setExperts((p) => {
            const cur = p[ev.expertId] ?? emptyExpert();
            const rk = ev.round === 1 ? "r1" : "r2";
            return { ...p, [ev.expertId]: { ...cur, [rk]: { ...cur[rk], text: cur[rk].text + ev.text } } };
          });
          break;
        case "think":
          setExperts((p) => {
            const cur = p[ev.expertId] ?? emptyExpert();
            const rk = ev.round === 1 ? "r1" : "r2";
            return { ...p, [ev.expertId]: { ...cur, [rk]: { ...cur[rk], think: cur[rk].think + ev.text } } };
          });
          break;
        case "tool":
          setExperts((p) => {
            const cur = p[ev.expertId] ?? emptyExpert();
            const rk = ev.round === 1 ? "r1" : "r2";
            return {
              ...p,
              [ev.expertId]: { ...cur, [rk]: { ...cur[rk], tools: [...cur[rk].tools, { tool: ev.tool, detail: ev.detail }] } },
            };
          });
          break;
        case "expert_done":
          setExperts((p) => ({ ...p, [ev.expertId]: { ...(p[ev.expertId] ?? emptyExpert()), active: false } }));
          break;
        case "verdict_delta":
          setVerdict((v) => v + ev.text);
          break;
        case "cost": {
          const c = {
            inputTokens: ev.inputTokens,
            outputTokens: ev.outputTokens,
            cacheReadTokens: ev.cacheReadTokens,
            costUsd: ev.costUsd,
          };
          setCost(c);
          onCost?.(initialCard.id, c);
          break;
        }
        case "reconcile":
          setRecon({
            min: ev.min,
            max: ev.max,
            median: ev.median,
            headline: ev.headline,
            divergent: ev.divergent,
          });
          break;
        case "error":
          setError(ev.message);
          break;
        case "done":
          setStatus("Verdict delivered.");
          setPhase("done");
          break;
      }
    };

    const controller = new AbortController();
    abortRef.current = controller;

    (async () => {
      setPhase("research");
      setStatus("Convening the council…");
      try {
        const res = await fetch("/api/council", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ card: initialCard }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          setError("Failed to start the council.");
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data:")) continue;
            const json = line.slice(5).trim();
            if (json) apply(JSON.parse(json) as CouncilEvent);
          }
        }
      } catch (e) {
        // Swallow the abort that Stop / unmount triggers; surface real errors.
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Stream error.");
      } finally {
        // Skip if aborted (unmount / StrictMode), else the scheduler over-spawns.
        if (!controller.signal.aborted) onDone(initialCard.id);
      }
    })();
    // Aborts the in-flight council if this panel unmounts (e.g. NEW BATCH) so the
    // server-side run stops spending the subscription instead of orphaning.
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const queued = !active && phase === "idle";
  const running = phase !== "idle" && phase !== "done";

  return (
    <section className="run">
      <CardHeader card={card} />

      <div className="status">
        {running && !stopped && <span className="spinner" />}
        <span>{queued ? "Queued — waiting for a free slot…" : status}</span>
        {cost && (
          <span className="cost" title="Cumulative spend for this card (cache reads shown separately)">
            {fmtCost(cost)}
          </span>
        )}
        {!stopped && (running || queued) && (
          <button className="stop" onClick={stop}>
            ◼ STOP
          </button>
        )}
      </div>

      {error && <div className="error">{error}</div>}
      {verdict && <Verdict text={verdict} />}

      {recon && (
        <div className={`recon ${recon.divergent ? "warn" : "ok"}`}>
          {recon.divergent ? "⚠ HEADLINE DIVERGES" : "✓ HEADLINE IN RANGE"} ·{" "}
          {recon.headline != null ? `${recon.headline}%` : "—"} vs pilots {recon.min}–{recon.max}%
          (median {recon.median}%)
          {recon.divergent && " — the chair's number sits outside where the pilots landed; read 'The split' before trusting it."}
        </div>
      )}

      {phase !== "idle" && phase !== "debate" && (
        <>
          <div className="section-label">
            PILOT GRID · {String(EXPERTS.length).padStart(2, "0")}
            {phase === "research" && " · RESEARCHING"}
          </div>
          <div className="grid">
            {EXPERTS.map((e, i) => {
              const st = experts[e.id];
              const { prob, lean } = readout(st);
              return (
                <div
                  key={e.id}
                  className="expert"
                  style={{ ["--xc" as string]: `var(--${e.id})`, animationDelay: `${i * 70}ms` }}
                >
                  <div className="ehead">
                    <div>
                      <div className="pno">PILOT {String(i + 1).padStart(2, "0")}</div>
                      <div className="ename">{e.name}</div>
                    </div>
                    {st?.active && <span className="spinner" />}
                  </div>
                  <div className="ebias">{e.bias}</div>
                  <div className="readout">
                    <div className="bigp">
                      {prob != null ? prob : "––"}
                      <small>%</small>
                    </div>
                    <div className="bar">
                      <span style={{ width: `${prob ?? 0}%` }} />
                    </div>
                    {lean && <span className={`lean ${lean}`}>{lean}</span>}
                  </div>
                  {st && hasRound(st.r1) && (
                    <Round label="ROUND 1 · RESEARCH" data={st.r1} mentions={false} />
                  )}
                  {st && hasRound(st.r2) && <Round label="ROUND 2 · DEBATE" data={st.r2} mentions />}
                </div>
              );
            })}
          </div>
        </>
      )}

      {(phase === "debate" || phase === "verdict" || phase === "done") && (
        <>
          <div className="section-label">
            THE DEBATE FLOOR · WHO CHALLENGED WHOM
            {phase === "debate" && <span className="live">● LIVE</span>}
          </div>
          <DebateArena experts={experts} live={phase === "debate"} />
        </>
      )}
    </section>
  );
}

const hasRound = (r: RoundData) => !!(r.text || r.think || r.tools.length);

const toolIcon = (t: string) => (t === "WebSearch" ? "🔍" : t === "WebFetch" ? "🌐" : "⚙");

// One round of an expert's work: live search/fetch activity, thinking, then analysis.
function Round({ label, data, mentions }: { label: string; data: RoundData; mentions: boolean }) {
  const [a, b] = label.split("·");
  return (
    <>
      <div className="round-tag">
        {a}·<b>{b}</b>
      </div>
      {data.tools.length > 0 && (
        <div className="activity">
          {data.tools.map((t, i) => (
            <div className="act" key={i}>
              <span className="actk">{toolIcon(t.tool)}</span>
              <span className="actd">{t.detail || t.tool}</span>
            </div>
          ))}
        </div>
      )}
      {data.think.trim() && (
        <details className="think">
          <summary>internal reasoning</summary>
          <div className="think-body">{data.think}</div>
        </details>
      )}
      {data.text && (
        <div className="body md-sm">
          <Markdown source={data.text} mentions={mentions} />
        </div>
      )}
    </>
  );
}

type Exchange = { from: string; to: string; text: string };

function cleanSnippet(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Derive directed challenges from round-2 text: a sentence in pilot A's round-2
// take that names pilot B is an A→B exchange.
function debateExchanges(experts: Record<string, ExpertState>): Exchange[] {
  const res: Exchange[] = [];
  for (const e of EXPERTS) {
    const txt = experts[e.id]?.r2.text;
    if (!txt) continue;
    const sentences = txt.replace(/\n+/g, " ").split(/(?<=[.!?])\s+/);
    const seen = new Set<string>();
    for (const s of sentences) {
      MENTION_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = MENTION_RE.exec(s))) {
        const to = MENTIONS[m[1]];
        if (!to || to === e.id) continue;
        const key = `${e.id}->${to}`;
        if (seen.has(key)) continue; // one exchange per directed pair per speaker
        seen.add(key);
        const snip = cleanSnippet(s);
        if (snip.length > 12) res.push({ from: e.id, to, text: snip.slice(0, 220) });
      }
    }
  }
  return res;
}

const shortName = (id: string) => (EXPERTS.find((e) => e.id === id)?.name ?? id).replace("The ", "");

const pairKey = (a: string, b: string) => [a, b].sort().join("|");

function DebateArena({ experts, live }: { experts: Record<string, ExpertState>; live: boolean }) {
  const [hovered, setHovered] = useState<string | null>(null);
  const exchanges = debateExchanges(experts);
  const edges = Array.from(new Set(exchanges.map((x) => `${x.from}->${x.to}`))).map((k) => {
    const [from, to] = k.split("->");
    return { from, to };
  });

  // A pair is a rebuttal when both directions exist (A challenged B and B challenged A).
  const dirs = new Set(exchanges.map((x) => `${x.from}->${x.to}`));
  const mutual = new Set<string>();
  for (const x of exchanges) if (dirs.has(`${x.to}->${x.from}`)) mutual.add(pairKey(x.from, x.to));

  // Group the feed by unordered pair so rebuttals render together.
  const groups: { key: string; items: Exchange[] }[] = [];
  const gIdx = new Map<string, number>();
  for (const x of exchanges) {
    const k = pairKey(x.from, x.to);
    if (!gIdx.has(k)) {
      gIdx.set(k, groups.length);
      groups.push({ key: k, items: [] });
    }
    groups[gIdx.get(k)!].items.push(x);
  }

  const W = 760, H = 420, cx = W / 2, cy = 196, R = 150, nodeR = 30;
  const N = EXPERTS.length;
  const pos = Object.fromEntries(
    EXPERTS.map((e, i) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / N;
      return [e.id, { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) }];
    })
  ) as Record<string, { x: number; y: number }>;

  const pull = (p: { x: number; y: number }, t: { x: number; y: number }, d: number) => {
    const dx = t.x - p.x, dy = t.y - p.y, l = Math.hypot(dx, dy) || 1;
    return { x: p.x + (dx / l) * d, y: p.y + (dy / l) * d };
  };

  return (
    <div className="debate">
      <svg viewBox={`0 0 ${W} ${H}`} className="arena" role="img" aria-label="Debate graph">
        <defs>
          {EXPERTS.map((e) => (
            <marker key={e.id} id={`arw-${e.id}`} markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto">
              <path d="M0,0 L9,4.5 L0,9 Z" fill={`var(--${e.id})`} />
            </marker>
          ))}
        </defs>

        {edges.map(({ from, to }, i) => {
          const a = pos[from], b = pos[to];
          const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
          const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
          const off = 30;
          const ctrl = { x: mx - (dy / len) * off, y: my + (dx / len) * off };
          const sa = pull(a, ctrl, nodeR + 2);
          const eb = pull(b, ctrl, nodeR + 8);
          const active = !hovered || hovered === from || hovered === to;
          const isMutual = mutual.has(pairKey(from, to));
          return (
            <path
              key={i}
              d={`M ${sa.x} ${sa.y} Q ${ctrl.x} ${ctrl.y} ${eb.x} ${eb.y}`}
              fill="none"
              stroke={`var(--${from})`}
              strokeWidth={hovered === from ? 2.8 : isMutual ? 2.2 : 1.5}
              strokeDasharray={isMutual ? undefined : "5 4"}
              markerEnd={`url(#arw-${from})`}
              opacity={active ? (isMutual ? 0.95 : 0.7) : 0.1}
            />
          );
        })}

        {EXPERTS.map((e, i) => {
          const p = pos[e.id];
          const { prob } = readout(experts[e.id]);
          const speaking = live && experts[e.id]?.active;
          const dim = hovered && hovered !== e.id && !edges.some((g) => (g.from === hovered && g.to === e.id) || (g.to === hovered && g.from === e.id));
          return (
            <g
              key={e.id}
              transform={`translate(${p.x},${p.y})`}
              onMouseEnter={() => setHovered(e.id)}
              onMouseLeave={() => setHovered(null)}
              style={{ cursor: "pointer", opacity: dim ? 0.3 : 1 }}
            >
              {speaking && <circle className="speaking" r={nodeR + 6} fill="none" stroke={`var(--${e.id})`} strokeWidth={1.5} />}
              <circle r={nodeR} fill="#080a18" stroke={`var(--${e.id})`} strokeWidth={speaking ? 3 : 2} />
              <text textAnchor="middle" y={-2} className="node-name" fill={`var(--${e.id})`}>
                {shortName(e.id).toUpperCase()}
              </text>
              <text textAnchor="middle" y={13} className="node-prob" fill="#cdd6ea">
                {prob != null ? `${prob}%` : "··"}
              </text>
              <text textAnchor="middle" y={nodeR + 16} className="node-tag" fill="var(--dim)">
                P{String(i + 1).padStart(2, "0")}
              </text>
            </g>
          );
        })}
      </svg>

      <div className="exchanges">
        {groups.length === 0 ? (
          <div className="exch-empty">
            {live ? "Pilots are taking the floor…" : "No direct challenges surfaced."}
          </div>
        ) : (
          groups.map((g, gi) => {
            const isRebuttal = g.items.length > 1;
            const [pa, pb] = g.key.split("|");
            return (
              <div
                className={`exch${isRebuttal ? " rebuttal" : ""}`}
                key={gi}
                onMouseEnter={() => setHovered(g.items[0].from)}
                onMouseLeave={() => setHovered(null)}
              >
                {isRebuttal ? (
                  <div className="exch-head">
                    <span style={{ color: `var(--${pa})` }}>{shortName(pa)}</span>
                    <span className="arrow rb">⇄ rebuttal ⇄</span>
                    <span style={{ color: `var(--${pb})` }}>{shortName(pb)}</span>
                  </div>
                ) : (
                  <div className="exch-head">
                    <span style={{ color: `var(--${g.items[0].from})` }}>{shortName(g.items[0].from)}</span>
                    <span className="arrow">▸ challenges ▸</span>
                    <span style={{ color: `var(--${g.items[0].to})` }}>{shortName(g.items[0].to)}</span>
                  </div>
                )}
                {g.items.map((x, xi) => (
                  <div className="exch-line" key={xi}>
                    {isRebuttal && (
                      <span className="who" style={{ color: `var(--${x.from})` }}>
                        {shortName(x.from)}:
                      </span>
                    )}
                    <span className="exch-body">“{x.text}”</span>
                  </div>
                ))}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function CardImage({ image, name }: { image?: string; name: string }) {
  const [failed, setFailed] = useState(false);
  // image may be a bare Arweave tx id or a full URL.
  const src = image
    ? /^https?:\/\//.test(image)
      ? image
      : `https://arweave.net/${image}`
    : null;
  if (!src || failed) {
    return <div className="card-img placeholder">◈</div>;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img className="card-img" src={src} alt={name} onError={() => setFailed(true)} />
  );
}

function CardHeader({ card }: { card: Card }) {
  const buy = fromMicro(card.pricing?.buyPrice);
  // Show the reward on its actual rail: CASH cards pay in dollars (potentialPrize),
  // not points, so "0 PTS" was hiding the real prize.
  const rail = (card.prizeType ?? card.event?.kind ?? "").toUpperCase();
  const cash = fromMicro(card.potentialPrize ?? card.prizeAmount);
  const points = fromMicro(card.pointsValue);
  const reward =
    rail === "CASH" && cash != null
      ? `$${cash.toFixed(2)}`
      : points != null
        ? `${points} PTS`
        : null;
  return (
    <div className="card-header">
      <CardImage image={card.image} name={card.name} />
      <div>
        <div className="name">{card.name}</div>
        <div className="meta">
          {card.rarity && <span className="pill">{card.rarity}</span>}
          {card.event?.status && <span className="pill">{card.event.status}</span>}
          {card.event?.name && <span>{card.event.name}</span>}
          {card.event?.eventDate && (
            <span>· {new Date(card.event.eventDate).toLocaleDateString()}</span>
          )}
          {reward && <span>· {reward}</span>}
          {buy != null && (
            <span>· BUY {buy} {card.pricing?.currency ?? "GOLD"}</span>
          )}
        </div>
      </div>
    </div>
  );
}

function Verdict({ text }: { text: string }) {
  // Robust parse: "Final probability" section first, handling bold/decimal/range.
  const heroNum = extractVerdictProb(text);
  const hero = heroNum != null ? String(heroNum) : null;
  const call = extractVerdictCall(text);

  return (
    <div className="verdict">
      {(hero || call) && (
        <div className="hero">
          {hero && (
            <div className="num">
              {hero}
              <small>%</small>
            </div>
          )}
          <div className="label">
            COUNCIL
            <br />
            WIN PROBABILITY
            {call && <span className={`callbadge ${call}`}>{call}</span>}
          </div>
        </div>
      )}
      <div className="verdict-md">
        <Markdown source={text} />
      </div>
    </div>
  );
}

// Other council members, keyed by the distinctive word in their name → color id.
const MENTIONS: Record<string, string> = {
  Quant: "quant",
  Insider: "insider",
  Contrarian: "contrarian",
  Sharp: "sharp",
  Newshound: "newshound",
};
const MENTION_RE = /\b(Quant|Insider|Contrarian|Sharp|Newshound)\b/g;

// Wrap mentions of other pilots so you can see who is debating whom.
function mentionize(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <span key={`${keyBase}-mn${i}`} className="mention" style={{ ["--xc" as string]: `var(--${MENTIONS[m[1]]})` }}>
        {m[1]}
      </span>
    );
    last = MENTION_RE.lastIndex;
    i++;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// Inline tokens: **bold**, `code`, [text](url), plus optional pilot mentions.
function inline(text: string, keyBase: string, mentions = false): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const push = (s: string, k: string) => (mentions ? out.push(...mentionize(s, k)) : out.push(s));
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) push(text.slice(last, m.index), `${keyBase}-t${i}`);
    if (m[2] !== undefined) out.push(<strong key={`${keyBase}-${i}`}>{m[2]}</strong>);
    else if (m[3] !== undefined) out.push(<code key={`${keyBase}-${i}`}>{m[3]}</code>);
    else if (m[4] !== undefined)
      out.push(
        <a key={`${keyBase}-${i}`} href={m[5]} target="_blank" rel="noopener noreferrer">
          {m[4]}
        </a>
      );
    last = re.lastIndex;
    i++;
  }
  if (last < text.length) push(text.slice(last), `${keyBase}-tend`);
  return out;
}

const isTableRow = (l: string) => /\|/.test(l) && /\S/.test(l.replace(/\|/g, ""));
const isTableSep = (l: string) => /^\s*\|?[\s:|-]*-{2,}[\s:|-]*\|?\s*$/.test(l);
const cells = (l: string) =>
  l.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());

// Lightweight markdown: headings, bullets, tables, paragraphs + inline tokens.
function Markdown({ source, mentions = false }: { source: string; mentions?: boolean }) {
  const lines = source.split("\n");
  const blocks: React.ReactNode[] = [];
  let list: string[] = [];
  let table: string[] = [];

  const flushList = (k: string) => {
    if (!list.length) return;
    blocks.push(
      <ul key={k}>
        {list.map((li, i) => (
          <li key={i}>{inline(li, `${k}-${i}`, mentions)}</li>
        ))}
      </ul>
    );
    list = [];
  };
  const flushTable = (k: string) => {
    if (!table.length) return;
    const rows = table.filter((l) => !isTableSep(l)).map(cells);
    const [head, ...body] = rows;
    blocks.push(
      <table key={k}>
        {head && (
          <thead>
            <tr>{head.map((c, i) => <th key={i}>{inline(c, `${k}h${i}`, mentions)}</th>)}</tr>
          </thead>
        )}
        <tbody>
          {body.map((r, ri) => (
            <tr key={ri}>{r.map((c, ci) => <td key={ci}>{inline(c, `${k}${ri}-${ci}`, mentions)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    );
    table = [];
  };

  lines.forEach((raw, idx) => {
    const line = raw.trimEnd();
    if (isTableRow(line)) {
      flushList(`l${idx}`);
      table.push(line);
      return;
    }
    flushTable(`t${idx}`);
    if (/^#{1,6}\s/.test(line)) {
      flushList(`l${idx}`);
      blocks.push(<h2 key={idx}>{inline(line.replace(/^#{1,6}\s/, ""), `h${idx}`, mentions)}</h2>);
    } else if (/^\s*[-*]\s/.test(line)) {
      list.push(line.replace(/^\s*[-*]\s/, ""));
    } else if (/^\s*---+\s*$/.test(line)) {
      flushList(`l${idx}`);
    } else if (line.trim() === "") {
      flushList(`l${idx}`);
    } else {
      flushList(`l${idx}`);
      blocks.push(<p key={idx}>{inline(line, `p${idx}`, mentions)}</p>);
    }
  });
  flushList("lend");
  flushTable("tend");

  return <>{blocks}</>;
}
