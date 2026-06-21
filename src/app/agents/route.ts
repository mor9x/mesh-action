import { listAgents } from "@/lib/suimesh-service";
import { jsonError } from "@/lib/api-errors";
import { requireAuth } from "@/lib/auth";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET() {
  try {
    const user = await requireAuth();
    const agents = await listAgents(user.user_id);
    return Response.json({ agents });
  } catch (error) {
    return jsonError(error, "agent registry unavailable");
  }
}
