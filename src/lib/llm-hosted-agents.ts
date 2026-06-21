import type {
  JsonValue,
  PtbInspectionResult,
  SuiPtbAction,
} from "suimesh";
import { ProxyAgent, request as undiciRequest, type Dispatcher } from "undici";

import type { ActionType } from "@/lib/suimesh-data";

const DEFAULT_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_LLM_MODEL = "gpt-4.1-mini";
let proxyDispatcher: Dispatcher | undefined;

type CopySourceContext = {
  sourceTraceId: string;
  sourceActionHash: string;
  sourcePtbHash?: string;
  status?: string;
};

export type HostedAgentMode = "llm" | "deterministic";
export type HostedAgentRuntimeStatus = {
  mode: HostedAgentMode;
  enabled: boolean;
  requested: boolean;
  configured: boolean;
  provider?: string;
  model?: string;
  baseUrl?: string;
  reason: string;
  errors: string[];
};

export type HostedProposalAgentResult = {
  model: string;
  proposal: string;
  summary: string;
  rationale: string;
  riskNotes: string[];
};

export type HostedAuditDecision = "approved" | "requires_confirmation" | "rejected";

export type HostedAuditAgentResult = {
  provider: string;
  model: string;
  decision: HostedAuditDecision;
  rationale: string;
  requiredPolicyChecks: string[];
  warnings: string[];
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
};

export function hostedLlmAgentsEnabled() {
  return (
    llmAgentsEnabledFlag() &&
    Boolean(llmApiKey())
  );
}

export function getHostedAgentRuntimeStatus(): HostedAgentRuntimeStatus {
  const requested = llmAgentsEnabledFlag();
  const configured = Boolean(llmApiKey());
  const enabled = requested && configured;
  const errors: string[] = [];
  if (requested && !configured) {
    errors.push("MESHACTION_LLM_API_KEY is required when MESHACTION_LLM_AGENTS=true");
  }

  return {
    mode: enabled ? "llm" : "deterministic",
    enabled,
    requested,
    configured,
    provider: enabled ? llmProvider() : undefined,
    model: enabled ? llmModel() : undefined,
    baseUrl: enabled ? llmBaseUrl() : undefined,
    reason: enabled
      ? `Hosted agents use ${llmProvider()} ${llmModel()}.`
      : requested
        ? "LLM agents were requested but no API key is configured. Using deterministic fallback."
        : "Hosted agents are using deterministic fallback because MESHACTION_LLM_AGENTS is not enabled.",
    errors,
  };
}

export async function runHostedProposalAgent(input: {
  sessionId: string;
  traceId: string;
  actionType: ActionType;
  userIntent: string;
  copySource?: CopySourceContext;
}): Promise<HostedProposalAgentResult | undefined> {
  if (!hostedLlmAgentsEnabled()) {
    return undefined;
  }

  const parsed = await requestLlmJson({
    agentName: "MeshAction proposal agent",
    system:
      "You are the MeshAction proposal agent, a hosted agent running on top of the SuiMesh protocol. Convert a user intent into a concise proposal for a verifiable Sui PTB workflow. Do not invent recipients, packages, amounts, or permissions. Return only JSON.",
    user: {
      task: "draft_agent_proposal",
      session_id: input.sessionId,
      trace_id: input.traceId,
      semantic_type: input.actionType,
      user_intent: input.userIntent,
      verified_copy_source: input.copySource,
      output_schema: {
        proposal: "string, one or two sentences",
        summary: "string, <= 240 chars",
        rationale: "string",
        risk_notes: ["string"],
      },
    },
  });

  const proposal = stringField(parsed, "proposal");
  const summary = stringField(parsed, "summary");
  const rationale = stringField(parsed, "rationale");
  if (!proposal || !summary || !rationale) {
    throw new Error("MeshAction proposal agent returned an incomplete JSON payload");
  }

  return {
    model: llmModel(),
    proposal,
    summary,
    rationale,
    riskNotes: stringArrayField(parsed, "risk_notes"),
  };
}

export async function runHostedAuditAgent(input: {
  sessionId: string;
  traceId: string;
  actionType: ActionType;
  proposal: string;
  action: SuiPtbAction;
  inspection: PtbInspectionResult;
}): Promise<HostedAuditAgentResult | undefined> {
  if (!hostedLlmAgentsEnabled()) {
    return undefined;
  }

  const parsed = await requestLlmJson({
    agentName: "MeshAction audit agent",
    system:
      "You are the MeshAction audit agent, a hosted agent running on top of the SuiMesh protocol. Review only inspected/simulated PTB facts and the ActionManifest. Approve when facts match the proposal and policy checks cover the risk. Reject manifest mismatches, unsafe targets, failed simulation, or unsupported actions. Return only JSON.",
    user: {
      task: "audit_agent_proposal",
      session_id: input.sessionId,
      trace_id: input.traceId,
      semantic_type: input.actionType,
      proposal: input.proposal,
      action_manifest: input.action.manifest as unknown as JsonValue,
      inspection_facts: input.inspection.facts as unknown as JsonValue,
      simulation: input.inspection.facts.simulation as unknown as JsonValue,
      output_schema: {
        decision: "approved | requires_confirmation | rejected",
        rationale: "string",
        required_policy_checks: ["string"],
        warnings: ["string"],
      },
    },
  });

  const decision = auditDecisionField(parsed, "decision");
  const rationale = stringField(parsed, "rationale");
  if (!decision || !rationale) {
    throw new Error("MeshAction audit agent returned an incomplete JSON payload");
  }

  const requiredPolicyChecks = stringArrayField(parsed, "required_policy_checks");

  return {
    provider: llmProvider(),
    model: llmModel(),
    decision,
    rationale,
    requiredPolicyChecks: requiredPolicyChecks.length
      ? requiredPolicyChecks
      : input.action.manifest.policyRequirements,
    warnings: stringArrayField(parsed, "warnings"),
  };
}

function llmAgentsEnabledFlag() {
  return (
    process.env.MESHACTION_LLM_AGENTS === "true" ||
    process.env.SUIMESH_LLM_AGENTS === "true" ||
    process.env.SUIMESH_OPENAI_AGENTS === "true"
  );
}

function llmProvider() {
  return (
    process.env.MESHACTION_LLM_PROVIDER?.trim() ||
    process.env.SUIMESH_LLM_PROVIDER?.trim() ||
    (llmBaseUrl() === DEFAULT_CHAT_COMPLETIONS_URL ? "openai" : "openai-compatible")
  );
}

function llmModel() {
  return (
    process.env.MESHACTION_LLM_MODEL?.trim() ||
    process.env.SUIMESH_LLM_MODEL?.trim() ||
    process.env.SUIMESH_OPENAI_MODEL?.trim() ||
    process.env.OPENAI_MODEL?.trim() ||
    DEFAULT_LLM_MODEL
  );
}

function llmApiKey() {
  return (
    process.env.MESHACTION_LLM_API_KEY?.trim() ||
    process.env.SUIMESH_LLM_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim()
  );
}

function llmBaseUrl() {
  const baseUrl =
    process.env.MESHACTION_LLM_BASE_URL?.trim() ||
    process.env.SUIMESH_LLM_BASE_URL?.trim() ||
    process.env.OPENAI_BASE_URL?.trim();
  if (!baseUrl) {
    return DEFAULT_CHAT_COMPLETIONS_URL;
  }
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

async function requestLlmJson(input: {
  agentName: string;
  system: string;
  user: Record<string, JsonValue | undefined>;
}) {
  const apiKey = llmApiKey();
  if (!apiKey) {
    throw new Error("MESHACTION_LLM_API_KEY is required when MESHACTION_LLM_AGENTS=true");
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Number(
      process.env.MESHACTION_LLM_TIMEOUT_MS ??
        process.env.SUIMESH_LLM_TIMEOUT_MS ??
        process.env.SUIMESH_OPENAI_TIMEOUT_MS ??
        45_000
    )
  );

  try {
    const body: Record<string, unknown> = {
      model: llmModel(),
      temperature: Number(
        process.env.MESHACTION_LLM_TEMPERATURE ??
          process.env.SUIMESH_LLM_TEMPERATURE ??
          0.1
      ),
      max_tokens: Number(
        process.env.MESHACTION_LLM_MAX_TOKENS ??
          process.env.SUIMESH_LLM_MAX_TOKENS ??
          900
      ),
      messages: [
        { role: "system", content: input.system },
        {
          role: "user",
          content: JSON.stringify(input.user),
        },
      ],
    };
    if (jsonModeEnabled()) {
      body.response_format = { type: "json_object" };
    }

    const response = await undiciRequest(llmBaseUrl(), {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      dispatcher: llmDispatcher(),
    });

    const text = await response.body.text();
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(
        `${input.agentName} failed with HTTP ${response.statusCode}: ${text.slice(0, 500)}`
      );
    }
    const payload = JSON.parse(text) as ChatCompletionResponse;
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error(`${input.agentName} returned no message content`);
    }
    return parseJsonObject(content);
  } finally {
    clearTimeout(timeout);
  }
}

function jsonModeEnabled() {
  return (
    process.env.MESHACTION_LLM_JSON_MODE ??
    process.env.SUIMESH_LLM_JSON_MODE
  ) !== "false";
}

function llmDispatcher() {
  const proxyUrl =
    process.env.MESHACTION_LLM_PROXY_URL?.trim() ||
    process.env.SUIMESH_LLM_PROXY_URL?.trim() ||
    process.env.SUIMESH_OPENAI_PROXY_URL?.trim() ||
    process.env.HTTPS_PROXY?.trim() ||
    process.env.HTTP_PROXY?.trim();
  if (!proxyUrl) {
    return undefined;
  }
  proxyDispatcher ??= new ProxyAgent(proxyUrl);
  return proxyDispatcher;
}

function parseJsonObject(content: string): Record<string, JsonValue> {
  const trimmed = content.trim();
  const unwrapped = trimmed.startsWith("```")
    ? trimmed
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "")
        .trim()
    : trimmed;
  const parsed = JSON.parse(unwrapped);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("MeshAction hosted agent response was not a JSON object");
  }
  return parsed as Record<string, JsonValue>;
}

function stringField(input: Record<string, JsonValue>, key: string) {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArrayField(input: Record<string, JsonValue>, key: string) {
  const value = input[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function auditDecisionField(input: Record<string, JsonValue>, key: string) {
  const value = input[key];
  return value === "approved" ||
    value === "requires_confirmation" ||
    value === "rejected"
    ? value
    : undefined;
}
