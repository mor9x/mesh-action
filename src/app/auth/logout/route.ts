import { assertSameOrigin, clearAuthCookie } from "@/lib/auth";
import { jsonError } from "@/lib/api-errors";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await clearAuthCookie();
    return Response.json({ authenticated: false });
  } catch (error) {
    return jsonError(error, "logout failed");
  }
}
