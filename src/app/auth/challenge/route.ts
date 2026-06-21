import {
  assertSameOrigin,
  createWalletChallenge,
  normalizeWalletAddress,
} from "@/lib/auth";
import { jsonError } from "@/lib/api-errors";
import { clientFingerprint, enforceRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 120;
const AUTH_CHALLENGE_LIMIT = Number(process.env.MESHACTION_AUTH_CHALLENGE_LIMIT ?? 5);
const AUTH_CHALLENGE_WINDOW_MS = Number(
  process.env.MESHACTION_AUTH_CHALLENGE_WINDOW_MS ?? 5 * 60_000
);

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const body = (await request.json().catch(() => ({}))) as {
      wallet_address?: string;
    };
    if (!body.wallet_address?.trim()) {
      return Response.json({ error: "wallet_address is required" }, { status: 400 });
    }
    const walletAddress = normalizeWalletAddress(body.wallet_address.trim());
    await enforceRateLimit({
      bucket: "auth_challenge",
      subject: `${walletAddress}:${clientFingerprint(request)}`,
      limit: AUTH_CHALLENGE_LIMIT,
      windowMs: AUTH_CHALLENGE_WINDOW_MS,
    });
    return Response.json(await createWalletChallenge(walletAddress), {
      status: 201,
    });
  } catch (error) {
    return jsonError(error, "auth challenge failed");
  }
}
