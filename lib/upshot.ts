import type { Card } from "./types";
import { getRuntimeAuth } from "./upshotAuth";

const API_BASE =
  process.env.UPSHOT_API_BASE || "https://api-mainnet.upshotcards.net/api/v1";

/** Thrown when Bunny Shield returns its HTML challenge instead of JSON. */
export class BunnyShieldError extends Error {
  constructor() {
    super("Upshot API is behind Bunny Shield (got HTML challenge, not JSON).");
    this.name = "BunnyShieldError";
  }
}

/**
 * Extract a card ID from a raw ID or any upshot.cards URL.
 * Card IDs are ~25-char strings starting with "cm".
 */
export function parseCardId(input: string): string | null {
  const trimmed = input.trim();
  // Direct ID
  if (/^cm[a-z0-9]{15,}$/i.test(trimmed)) return trimmed;
  // Find a cm... token anywhere (e.g. inside a /card-detail/<id> URL)
  const match = trimmed.match(/cm[a-z0-9]{15,}/i);
  return match ? match[0] : null;
}

async function getJson(url: string): Promise<unknown> {
  const headers: Record<string, string> = {
    // Look like a browser; doesn't defeat Bunny Shield but avoids naive UA blocks.
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    Accept: "application/json",
  };
  // Replay your authenticated browser session so requests clear Bunny Shield
  // (cookies) and pass auth (bearer). Grab both from your browser devtools.
  // Runtime token (pasted via the bookmarklet) wins over the env fallback.
  const runtime = getRuntimeAuth();
  const bearer = runtime?.bearer ?? process.env.UPSHOT_BEARER ?? null;
  if (bearer) {
    headers.Authorization = `Bearer ${bearer.replace(/^Bearer\s+/i, "")}`;
  }
  if (process.env.UPSHOT_COOKIE) headers.Cookie = process.env.UPSHOT_COOKIE;

  const res = await fetch(url, { headers, cache: "no-store" });
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("text/html")) {
    throw new BunnyShieldError();
  }
  if (!res.ok) {
    throw new Error(`Upshot API ${res.status} for ${url}`);
  }
  return res.json();
}

/** Fetch and normalize a card by ID. Throws BunnyShieldError if blocked. */
export async function fetchCard(cardId: string): Promise<Card> {
  const detail = (await getJson(
    `${API_BASE}/cards/${cardId}?include=event,supply`
  )) as { data?: Record<string, unknown> };

  const data = detail.data;
  if (!data) throw new Error("Card not found");

  const card = normalizeCard(data);

  // Best-effort: enrich with a marketplace quote. Don't fail the whole request
  // if pricing is unavailable.
  try {
    const quote = (await getJson(
      `${API_BASE}/shopkeeper/${cardId}?quantity=1`
    )) as { data?: Record<string, unknown> };
    if (quote.data) {
      card.pricing = {
        currency: quote.data.currency as string | undefined,
        buyPrice: quote.data.buyPrice as string | undefined,
        sellPrice: quote.data.sellPrice as string | undefined,
        shopkeeperBalance: quote.data.shopkeeperBalance as string | undefined,
        isTradeable: quote.data.isTradeable as boolean | undefined,
      };
    }
  } catch {
    // ignore pricing failures
  }

  return card;
}

/** Normalize a raw card object (from API or pasted JSON) into our Card shape. */
export function normalizeCard(raw: Record<string, unknown>): Card {
  // Accept either a bare card object or a { data: {...} } envelope.
  const d = (raw.data as Record<string, unknown>) ?? raw;
  const event = (d.event as Record<string, unknown>) ?? undefined;
  return {
    id: String(d.id ?? ""),
    name: String(d.name ?? "Unknown card"),
    rarity: d.rarity as string | undefined,
    maxSupply: d.maxSupply as number | undefined,
    pointsValue: d.pointsValue as string | undefined,
    // Reward rail + cash prize. `kind`/`prizeType` tell us which rail is live;
    // a CASH card carries its value in potentialPrize, not pointsValue.
    prizeType: (d.prizeType ?? d.kind) as string | undefined,
    prizeAmount: d.prizeAmount as string | undefined,
    potentialPrize: d.potentialPrize as string | undefined,
    actualPrize: d.actualPrize as string | undefined,
    minted: (() => {
      const m = (d.supply as Record<string, unknown> | undefined)?.minted;
      const n = m == null ? NaN : Number(m);
      return Number.isNaN(n) ? undefined : n;
    })(),
    image: d.image as string | undefined,
    outcomeId: d.outcomeId as string | undefined,
    outcomeName: (d.outcome as Record<string, unknown> | undefined)?.name as string | undefined,
    event: event
      ? {
          id: event.id as string | undefined,
          name: event.name as string | undefined,
          status: event.status as string | undefined,
          kind: event.kind as string | undefined,
          eventDate: event.eventDate as string | undefined,
          pricePerCard: event.pricePerCard as string | undefined,
          prizePool: event.prizePool as string | undefined,
          winningOutcomeId: (event.winningOutcomeId as string | null) ?? null,
          resolvedAt: (event.resolvedAt as string | null) ?? null,
        }
      : undefined,
  };
}

/** micro-units (6 decimals) → display number. 46620000 -> 46.62 */
export function fromMicro(value?: string | number): number | null {
  if (value === undefined || value === null) return null;
  const n = typeof value === "string" ? Number(value) : value;
  if (Number.isNaN(n)) return null;
  return n / 1_000_000;
}

/** Extract a wallet address (0x + 40 hex) from a raw address or profile URL. */
export function parseWallet(input: string): string | null {
  const m = input.trim().match(/0x[a-fA-F0-9]{40}/);
  return m ? m[0] : null;
}

/** Extract an event ID from a raw ID or an upshot.cards/event/<id> URL. */
export function parseEventId(input: string): string | null {
  const t = input.trim();
  const m = t.match(/event\/(cm[a-z0-9]{15,})/i);
  if (m) return m[1];
  if (/^cm[a-z0-9]{15,}$/i.test(t)) return t;
  return null;
}

/** Fetch every card (one per outcome) for an event, normalized. */
export async function fetchEventCards(
  eventId: string
): Promise<{ eventName: string; cards: Card[] }> {
  const cards: Card[] = [];
  for (let page = 1; page <= 10; page++) {
    const res = (await getJson(
      `${API_BASE}/cards?eventId=${eventId}&include=event,supply&perPage=100&page=${page}`
    )) as { data?: unknown[]; meta?: { lastPage?: number } };
    const arr = Array.isArray(res.data) ? res.data : [];
    for (const c of arr) cards.push(normalizeCard(c as Record<string, unknown>));
    const last = res.meta?.lastPage ?? 1;
    if (!arr.length || page >= last) break;
  }
  const eventName = cards.find((c) => c.event?.name)?.event?.name ?? "";
  return { eventName, cards };
}

/** True if a card's event is still open to predict on (not resolved, not past its date). */
export function isPredictable(card: Card): boolean {
  const e = card.event;
  if (!e) return true;
  if (e.status === "RESOLVED" || e.winningOutcomeId) return false;
  if (e.eventDate) {
    const ms = Date.parse(e.eventDate);
    if (!Number.isNaN(ms) && ms < Date.now()) return false;
  }
  return true;
}

/**
 * Fetch the cards a wallet owns (balances?include=card), normalized. The endpoint
 * returns `data` keyed by cardId with a nested `card` object and owned quantities.
 * Throws BunnyShieldError if the API is gated.
 */
export async function fetchOwnedCards(wallet: string): Promise<Card[]> {
  const out: Card[] = [];
  const perPage = 100;
  for (let page = 1; page <= 10; page++) {
    const res = (await getJson(
      `${API_BASE}/cards/balances/${wallet}?include=card&perPage=${perPage}&page=${page}`
    )) as {
      data?: Record<
        string,
        { card?: Record<string, unknown>; claimedQuantity?: string; unclaimedQuantity?: string }
      >;
      meta?: { lastPage?: number };
    };
    const entries = Object.values(res.data ?? {});
    for (const entry of entries) {
      if (!entry?.card) continue;
      const owned =
        (Number(entry.claimedQuantity ?? 0) || 0) + (Number(entry.unclaimedQuantity ?? 0) || 0);
      // The balances endpoint also returns zero-quantity entries (cards the wallet
      // once held / interacted with). Only surface cards actually owned right now.
      if (owned <= 0) continue;
      const card = normalizeCard(entry.card);
      card.owned = owned;
      out.push(card);
    }
    const last = res.meta?.lastPage ?? 1;
    if (!entries.length || page >= last) break;
  }
  return out;
}
