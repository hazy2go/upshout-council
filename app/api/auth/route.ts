import { NextRequest, NextResponse } from "next/server";
import {
  clearRuntimeAuth,
  getRuntimeAuth,
  parseAuthInput,
  setRuntimeAuth,
} from "@/lib/upshotAuth";

export const runtime = "nodejs";

// GET /api/auth → current auth status (masked).
export async function GET() {
  const a = getRuntimeAuth();
  if (!a) return NextResponse.json({ active: false, source: "env_or_none" });
  return NextResponse.json({
    active: true,
    source: "runtime",
    wallet: a.wallet ?? null,
    userId: a.userId ?? null,
    expiresAt: a.expiresAt,
    // Hint to the UI but never the full token.
    tokenPreview: `${a.bearer.slice(0, 8)}…${a.bearer.slice(-6)}`,
  });
}

// POST /api/auth  { input: "<bookmarklet JSON | accessToken JSON | raw JWT>" }
//   → parse and store in process memory. Token never persisted.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const input = typeof body?.input === "string" ? body.input : "";
    const a = parseAuthInput(input);
    setRuntimeAuth(a);
    return NextResponse.json({
      ok: true,
      wallet: a.wallet ?? null,
      expiresAt: a.expiresAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not parse auth input.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

// DELETE /api/auth → forget the runtime token (env fallback still applies).
export async function DELETE() {
  clearRuntimeAuth();
  return NextResponse.json({ ok: true });
}
