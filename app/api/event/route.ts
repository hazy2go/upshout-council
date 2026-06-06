import { NextRequest, NextResponse } from "next/server";
import { fetchEventCards, parseEventId, BunnyShieldError, normalizeCard } from "@/lib/upshot";
import type { Card } from "@/lib/types";

export const runtime = "nodejs";

// GET /api/event?event=<id-or-url> — list every card (one per outcome) for an event.
export async function GET(req: NextRequest) {
  const input = req.nextUrl.searchParams.get("event") ?? "";
  const eventId = parseEventId(input);
  if (!eventId) {
    return NextResponse.json(
      { error: "Enter an event ID or an upshot.cards/event/<id> URL." },
      { status: 400 }
    );
  }

  try {
    const { eventName, cards } = await fetchEventCards(eventId);
    if (!cards.length) {
      return NextResponse.json({ error: "No cards found for that event." }, { status: 404 });
    }
    return NextResponse.json({ eventId, eventName, count: cards.length, cards });
  } catch (err) {
    if (err instanceof BunnyShieldError) {
      return NextResponse.json({ error: "bunny_shield" }, { status: 409 });
    }
    const message = err instanceof Error ? err.message : "Failed to fetch event";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

// POST /api/event  { json: <pasted /cards?eventId=… response>, eventName?: string }
//   → normalize the embedded card list. Bunny Shield paste fallback for events.
// Accepts the Upshot API response in either form: a `{ data: [...] }` envelope,
// a bare array of card objects, or `{ cards: [...] }`. Pages must be concatenated
// by the user before pasting (instructions in the UI).
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const raw = typeof body.json === "string" ? JSON.parse(body.json) : body.json;

    // Find the array of cards regardless of which wrapper Upshot returned.
    let arr: unknown[] | null = null;
    if (Array.isArray(raw)) arr = raw;
    else if (raw && typeof raw === "object") {
      const r = raw as Record<string, unknown>;
      if (Array.isArray(r.data)) arr = r.data as unknown[];
      else if (Array.isArray(r.cards)) arr = r.cards as unknown[];
    }
    if (!arr || !arr.length) {
      return NextResponse.json(
        { error: "That JSON doesn't look like an event card list (expected an array of cards under `data` or at the top level)." },
        { status: 400 }
      );
    }

    const cards: Card[] = [];
    for (const c of arr) {
      if (c && typeof c === "object") cards.push(normalizeCard(c as Record<string, unknown>));
    }
    const valid = cards.filter((c) => c.id && c.name);
    if (!valid.length) {
      return NextResponse.json(
        { error: "None of the pasted entries parsed as a card (missing id/name)." },
        { status: 400 }
      );
    }

    const eventName =
      (typeof body.eventName === "string" && body.eventName.trim()) ||
      valid.find((c) => c.event?.name)?.event?.name ||
      "";
    const eventId = valid.find((c) => c.event?.id)?.event?.id ?? null;
    return NextResponse.json({ eventId, eventName, count: valid.length, cards: valid });
  } catch {
    return NextResponse.json({ error: "Could not parse the pasted JSON." }, { status: 400 });
  }
}
