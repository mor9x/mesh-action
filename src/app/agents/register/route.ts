import { registerAgent } from "@/lib/suimesh-service";
import { jsonError } from "@/lib/api-errors";
import { assertSameOrigin, requireAuth } from "@/lib/auth";
import { clientFingerprint, enforceRateLimit } from "@/lib/rate-limit";
import {
  isActionType,
  type ActionType,
  type AgentManifest,
} from "@/lib/suimesh-data";

export const runtime = "nodejs";
const AGENT_REGISTRATION_LIMIT = Number(
  process.env.MESHACTION_AGENT_REGISTRATION_LIMIT ?? 8
);
const AGENT_REGISTRATION_WINDOW_MS = Number(
  process.env.MESHACTION_AGENT_REGISTRATION_WINDOW_MS ?? 10 * 60_000
);

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
  } catch (error) {
    return jsonError(error, "agent registration failed");
  }
  const body = (await request.json().catch(() => ({}))) as Partial<AgentManifest> & {
    registration_signature?: string;
    signed_at_ms?: number;
  };

  let user;
  try {
    user = await requireAuth();
  } catch (error) {
    return jsonError(error, "agent registration failed");
  }

  if (!body.agent_id || !body.display_name || !body.endpoint) {
    return Response.json(
      { error: "agent_id, display_name, and endpoint are required" },
      { status: 400 }
    );
  }
  if (body.kind && body.kind !== "byo") {
    return Response.json(
      { error: "public registration only supports kind=byo" },
      { status: 400 }
    );
  }
  if (!body.signing_address) {
    return Response.json(
      { error: "signing_address is required for BYO agent registration" },
      { status: 400 }
    );
  }

  const supportedSemanticTypes = coerceSupportedSemanticTypes(
    body.supported_semantic_types
  );
  if (!supportedSemanticTypes) {
    return Response.json(
      { error: "supported_semantic_types contains an unsupported action type" },
      { status: 400 }
    );
  }

  const manifest: AgentManifest = {
    agent_id: body.agent_id,
    display_name: body.display_name,
    kind: "byo",
    capabilities: body.capabilities ?? ["event_envelope"],
    supported_semantic_types: supportedSemanticTypes,
    endpoint: body.endpoint,
    signing_address: body.signing_address,
    memory_provider: body.memory_provider ?? "external://unconfigured",
    required_policy_checks: body.required_policy_checks ?? [
      "registered_identity",
      "signature_valid",
    ],
  };

  try {
    await enforceRateLimit({
      bucket: "agent_registration",
      subject: `${user.user_id}:${clientFingerprint(request)}`,
      limit: AGENT_REGISTRATION_LIMIT,
      windowMs: AGENT_REGISTRATION_WINDOW_MS,
    });
    const registered = await registerAgent(manifest, {
      signature: body.registration_signature,
      signedAtMs: body.signed_at_ms,
    }, user.user_id);
    return Response.json(registered, { status: 201 });
  } catch (error) {
    return jsonError(error, "agent registration failed");
  }
}

function coerceSupportedSemanticTypes(
  value: AgentManifest["supported_semantic_types"] | undefined
): ActionType[] | undefined {
  if (value === undefined) {
    return ["transfer"];
  }
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  return value.every(isActionType) ? value : undefined;
}
