import { jsonError } from "@/lib/api-errors";
import { byoAgentChallengeMessage, type ByoAgentChallenge } from "@/lib/agent-identity";
import { actionDefinitions, type ActionType } from "@/lib/suimesh-data";
import {
  buildSuiCopyTradePtbBytes,
  buildSuiDemoMoveCallPtbBytes,
  buildSuiTransferPtbBytes,
  getSuiRuntimeAddress,
  getSuiRuntimeSigner,
  SUI_COPY_MAX_EXPOSURE_MIST,
} from "@/lib/sui-executor";

export const runtime = "nodejs";
export const maxDuration = 120;

type ByoRuntimeRequest = {
  protocol?: unknown;
  version?: unknown;
  kind?: unknown;
  challenge?: Partial<ByoAgentChallenge>;
  challenge_message?: unknown;
  envelope?: {
    session_id?: unknown;
    trace_id?: unknown;
    semantic_type?: unknown;
    source_trace_id?: unknown;
  };
  context_refs?: {
    source_trace_id?: unknown;
  };
};

function asActionType(value: unknown): ActionType {
  if (value === "transfer" || value === "contract_call" || value === "copy_trade") {
    return value;
  }
  throw new Error(`Unsupported semantic_type: ${String(value)}`);
}

function asString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

async function buildActionPtbBytes(input: {
  actionType: ActionType;
  traceId: string;
  sourceTraceId?: string;
}) {
  if (input.actionType === "transfer") {
    return buildSuiTransferPtbBytes();
  }
  if (input.actionType === "contract_call") {
    return buildSuiDemoMoveCallPtbBytes({
      traceId: input.traceId,
      semanticType: "move_call",
    });
  }
  if (!input.sourceTraceId) {
    throw new Error("copy_trade requires source_trace_id");
  }
  return buildSuiCopyTradePtbBytes({
    sourceTraceId: input.sourceTraceId,
    followerTraceId: input.traceId,
    maxExposureMist: SUI_COPY_MAX_EXPOSURE_MIST,
  });
}

export async function GET() {
  try {
    return Response.json({
      ok: true,
      protocol: "suimesh",
      kind: "agent_runtime",
      signer: getSuiRuntimeAddress(),
      supported_semantic_types: ["transfer", "contract_call", "copy_trade"],
      max_exposure_mist: SUI_COPY_MAX_EXPOSURE_MIST,
    });
  } catch (error) {
    return jsonError(error, "BYO runtime unavailable");
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as ByoRuntimeRequest;
    if (body.protocol !== "suimesh") {
      throw new Error("protocol is required");
    }
    if (body.kind !== "agent_request") {
      throw new Error("kind is required");
    }

    const challenge = body.challenge;
    if (!challenge) {
      throw new Error("challenge is required");
    }

    const actionType = asActionType(
      challenge.semanticType ?? body.envelope?.semantic_type
    );
    const traceId = asString(challenge.traceId ?? body.envelope?.trace_id, "trace_id");
    const sourceTraceId =
      typeof body.context_refs?.source_trace_id === "string" &&
      body.context_refs.source_trace_id.trim()
        ? body.context_refs.source_trace_id.trim()
        : typeof challenge.sourceTraceId === "string" && challenge.sourceTraceId.trim()
          ? challenge.sourceTraceId.trim()
          : typeof body.envelope?.source_trace_id === "string" &&
              body.envelope.source_trace_id.trim()
            ? body.envelope.source_trace_id.trim()
            : undefined;

    const canonicalChallenge: ByoAgentChallenge = {
      agentId: asString(challenge.agentId, "agent_id"),
      sessionId: asString(challenge.sessionId ?? body.envelope?.session_id, "session_id"),
      traceId,
      semanticType: actionType,
      sourceTraceId,
      nonce: asString(challenge.nonce, "nonce"),
      createdAtMs:
        typeof challenge.createdAtMs === "number" ? challenge.createdAtMs : Date.now(),
    };

    const canonicalMessage = byoAgentChallengeMessage(canonicalChallenge);
    if (
      typeof body.challenge_message === "string" &&
      body.challenge_message.trim() !== canonicalMessage
    ) {
      throw new Error("challenge_message does not match challenge payload");
    }

    const runtimeSigner = getSuiRuntimeSigner();
    const signed = await runtimeSigner.keypair.signPersonalMessage(
      new TextEncoder().encode(canonicalMessage)
    );
    const ptbBytes = await buildActionPtbBytes({
      actionType,
      traceId,
      sourceTraceId,
    });

    return Response.json({
      proposal: actionDefinitions[actionType].proposal,
      signing_address: runtimeSigner.address,
      signature: signed.signature,
      action: {
        ptbBytes: Buffer.from(ptbBytes).toString("base64url"),
      },
    });
  } catch (error) {
    return jsonError(error, "BYO runtime request failed");
  }
}
