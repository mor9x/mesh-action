import { getSuiRuntimeStatus } from "@/lib/sui-executor";
import { getHostedAgentRuntimeStatus } from "@/lib/llm-hosted-agents";
import { getSuiMeshProtocolStatus } from "@/lib/suimesh-canonical";

export const runtime = "nodejs";

export async function GET() {
  return Response.json({
    hostedAgents: getHostedAgentRuntimeStatus(),
    runtime: getSuiRuntimeStatus(),
    protocol: await getSuiMeshProtocolStatus(),
  });
}
