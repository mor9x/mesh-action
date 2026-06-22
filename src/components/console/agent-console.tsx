"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ConnectModal,
  useCurrentAccount,
  useSignPersonalMessage,
} from "@mysten/dapp-kit";
import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils";
import {
  AlertTriangle,
  Archive,
  Bell,
  Bot,
  CheckCircle2,
  Code2,
  DatabaseZap,
  FileSearch,
  GitBranch,
  LogOut,
  MessageSquareText,
  Network,
  PanelRight,
  Play,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  SquareTerminal,
  Wallet,
} from "lucide-react";

import { WorkflowGraph } from "@/components/console/workflow-graph";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  actionDefinitions,
  getWorkflowGraph,
  type ActionType,
  type AgentManifest,
  type ChatMessage,
  type NodeStatus,
  type WorkflowGraph as WorkflowGraphData,
  type WorkflowNode,
} from "@/lib/suimesh-data";
import { cn } from "@/lib/utils";

const actionOrder: ActionType[] = ["transfer", "contract_call", "copy_trade"];

const statusLabel: Record<NodeStatus, string> = {
  idle: "Idle",
  ready: "Ready",
  running: "Running",
  blocked: "Blocked",
  approved: "Approved",
  executed: "Executed",
  archived: "Archived",
};

type SessionApiResponse = {
  session: {
    session_id: string;
    trace_id: string;
    messages?: ChatMessage[];
  };
  graph?: WorkflowGraphData;
};

type MessageApiResponse = {
  trace_id: string;
  prepared?: boolean;
  workflow_error?: string;
  policy_decision?: EvaluateApiResponse["policy_decision"];
  trace?: RuntimeTrace;
  messages?: ChatMessage[];
};

type SessionMessagesApiResponse = {
  session_id: string;
  trace_id: string;
  semantic_type: ActionType;
  status: string;
  trace_exists?: boolean;
  messages?: ChatMessage[];
};

type EvaluateApiResponse = {
  policy_decision: {
    status: "approved" | "rejected" | "requires_confirmation";
    reason: string;
  };
};

type ReceiptArchiveRef =
  | string
  | {
      provider?: string;
      blobId?: string;
      digest?: string;
    };

type ExecuteApiResponse = {
  receipt: {
    txDigest?: string;
    effectsHash?: string;
    archive_ref?: ReceiptArchiveRef;
    archive_provider?: string;
    seal_access_ref?: string;
    archive_status?: string;
    archive_error?: string;
  };
};

type RuntimeTraceEvent = {
  id: string;
  label: string;
  actor: string;
  status: NodeStatus;
  timestamp: string;
  summary: string;
};

type RuntimeTrace = {
  trace_id: string;
  session_id: string;
  semantic_type: ActionType;
  status: string;
  action_hash?: string;
  action?: {
    ptbBytes?: string;
    manifest?: {
      actionId?: string;
      summary?: string;
      ptbHash?: string;
      idempotencyKey?: string;
      riskLevel?: string;
      valueAtRisk?: {
        amount?: string;
        coinType?: string;
        decimals?: number;
      };
      primaryTarget?: {
        packageId?: string;
        module?: string;
        function?: string;
      };
      expiresAtMs?: number;
    };
  };
  policy_decision?: {
    decision?: string;
    reason?: string;
  };
  receipt?: ExecuteApiResponse["receipt"] & {
    txDigest?: string;
    effectsHash?: string;
    audit_event_hash?: string;
  };
  events?: RuntimeTraceEvent[];
  verification?: {
    ok: boolean;
    errors: string[];
    scope?: string;
  };
};

type TraceApiResponse = {
  trace: RuntimeTrace;
};

type AgentsApiResponse = {
  agents?: AgentManifest[];
};

type AgentRegisterApiResponse = {
  agent: AgentManifest;
  registry_size: number;
};

type AgentMutationApiResponse = AgentRegisterApiResponse;

type SessionIndexItem = {
  session_id: string;
  semantic_type: ActionType;
  status: string;
  updated_at: string;
  created_at: string;
};

type SessionsApiResponse = {
  sessions?: SessionIndexItem[];
};

type RuntimeStatus = {
  ok: boolean;
  signerConfigured: boolean;
  address?: string;
  network: string;
  rpcUrl: string;
  demoPackageId: string;
  transferRecipient: string;
  transferAmountMist: string;
  copyMaxExposureMist: string;
  errors: string[];
};

type HostedAgentRuntimeStatus = {
  mode: "llm" | "deterministic";
  enabled: boolean;
  requested: boolean;
  configured: boolean;
  provider?: string;
  model?: string;
  baseUrl?: string;
  reason: string;
  errors: string[];
};

type ProtocolStatus = {
  mode: "canonical" | "pg";
  canonical: boolean;
  ok: boolean;
  transport: string;
  traceGuard: string;
  relayerUrl?: string;
  tracePackageId?: string;
  traceRegistryId?: string;
  registry?: {
    objectId: string;
    expectedType: string;
    actualType?: string;
    ownerAddress?: string;
    ownerMatchesSigner: boolean;
    writable: boolean;
    errors: string[];
  };
  errors: string[];
};

type RuntimeStatusApiResponse = {
  hostedAgents?: HostedAgentRuntimeStatus;
  runtime: RuntimeStatus;
  protocol?: ProtocolStatus;
};

type AuthUser = {
  user_id: string;
  wallet_address: string;
  created_at: string;
  last_seen_at: string;
};

type AuthSessionApiResponse = {
  authenticated: boolean;
  user?: AuthUser;
};

type AuthChallengeApiResponse = {
  challenge_id: string;
  wallet_address: string;
  message: string;
  expires_at_ms: number;
};

async function postJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error ?? `Request failed: ${response.status}`);
  }
  return payload as T;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error ?? `Request failed: ${response.status}`);
  }
  return payload as T;
}

function timestampNow() {
  return new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function shortAddress(address: string) {
  return address.length > 18
    ? `${address.slice(0, 8)}...${address.slice(-6)}`
    : address;
}

function encodePersonalMessage(message: string) {
  return new TextEncoder().encode(message);
}

function normalizeAddressForMessage(address: string) {
  const trimmed = address.trim();
  return isValidSuiAddress(trimmed) ? normalizeSuiAddress(trimmed) : trimmed;
}

function buildByoRegistrationMessage(input: {
  agentId: string;
  endpoint: string;
  signingAddress: string;
  capabilities: string[];
  semanticTypes: ActionType[];
  signedAtMs: string | number;
}) {
  return [
    "MeshAction BYO Agent Registration",
    `agent_id=${input.agentId.trim()}`,
    `endpoint=${input.endpoint.trim()}`,
    `signing_address=${normalizeAddressForMessage(input.signingAddress)}`,
    `capabilities=${input.capabilities.slice().sort().join(",")}`,
    `semantic_types=${input.semanticTypes.slice().sort().join(",")}`,
    `signed_at_ms=${input.signedAtMs}`,
  ].join("\n");
}

function runtimeNoticeMessage(action: ActionType, body: string): ChatMessage {
  return {
    id: `runtime_notice_${action}_${Date.now()}`,
    role: "system",
    author: "Runtime",
    body,
    timestamp: timestampNow(),
  };
}

function initialRuntimeNoticeMessage(action: ActionType): ChatMessage {
  return {
    id: `runtime_notice_${action}_initial`,
    role: "system",
    author: "Runtime",
    body: "Connecting to MeshAction runtime...",
    timestamp: "pending",
  };
}

function pendingWorkflowGraph(action: ActionType): WorkflowGraphData {
  const graph = getWorkflowGraph(action);
  return {
    edges: graph.edges,
    nodes: graph.nodes.map((node) => {
      const metadata = { ...node.metadata };
      if (node.node_id === "node_user") {
        metadata.refs = ["session://pending", "trace://pending"];
      }
      if (node.node_id === "node_agent") {
        metadata.headline = "Connecting runtime";
        metadata.details = "Waiting for the server to create a real session.";
      }
      if (node.node_id === "node_policy") {
        metadata.headline = "Awaiting policy evaluation";
        metadata.details = "No inspected PTB facts have been evaluated yet.";
      }
      if (node.node_id === "node_executor") {
        metadata.headline = "Awaiting approved decision";
        metadata.details = "Execution is blocked until a real policy decision exists.";
      }
      if (node.node_id === "node_sui") {
        metadata.headline = "Awaiting execution";
        metadata.details = "No Sui transaction has been submitted for this trace.";
        metadata.refs = ["effects://pending", "network://sui-testnet"];
      }
      if (node.node_id === "node_walrus") {
        metadata.headline = "Awaiting receipt";
        metadata.details = "Archive refs are created only after execution receipt.";
        metadata.refs = ["walrus://pending", "seal://pending"];
      }
      if (node.node_id === "node_audit") {
        metadata.headline = "Awaiting audit";
        metadata.details = "Audit chain is pending until trace events exist.";
        metadata.audit = ["trace://pending", "archive_status:pending"];
      }
      return {
        ...node,
        session_id: "runtime_pending",
        trace_id: "runtime_pending",
        status:
          node.node_id === "node_user" ||
          node.node_id === "node_agent" ||
          node.node_id === "node_memory"
            ? ("ready" as const)
            : ("idle" as const),
        metadata,
      };
    }),
  };
}

export function AgentConsole() {
  const [activeAction, setActiveAction] = useState<ActionType>("transfer");
  const [sessionBootRequest, setSessionBootRequest] = useState<{
    action: ActionType;
    key: number;
  }>({ action: "transfer", key: 0 });
  const [selectedNodeId, setSelectedNodeId] = useState("node_agent");
  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    initialRuntimeNoticeMessage("transfer"),
  ]);
  const [draft, setDraft] = useState("");
  const [sessionQuery, setSessionQuery] = useState("");
  const [pollTransport, setPollTransport] = useState(true);
  const [verifyOnRestore, setVerifyOnRestore] = useState(true);
  const [simulated, setSimulated] = useState(false);
  const [executed, setExecuted] = useState(false);
  const [executionReviewOpen, setExecutionReviewOpen] = useState(false);
  const [executionConfirmationAccepted, setExecutionConfirmationAccepted] =
    useState(false);
  const [busy, setBusy] = useState(false);
  const [runtimeBooting, setRuntimeBooting] = useState(true);
  const [sessionId, setSessionId] = useState<string>();
  const [traceId, setTraceId] = useState<string>();
  const [traceRestorable, setTraceRestorable] = useState(false);
  const [runtimeGraph, setRuntimeGraph] = useState<WorkflowGraphData>();
  const [runtimeTrace, setRuntimeTrace] = useState<RuntimeTrace>();
  const [policyApproved, setPolicyApproved] = useState(false);
  const [registryAgents, setRegistryAgents] = useState<AgentManifest[]>([]);
  const [selectedByoAgentIds, setSelectedByoAgentIds] = useState<
    Partial<Record<ActionType, string>>
  >({});
  const [registryError, setRegistryError] = useState<string>();
  const [sessionError, setSessionError] = useState<string>();
  const [sessionIndex, setSessionIndex] = useState<SessionIndexItem[]>([]);
  const [hostedAgentStatus, setHostedAgentStatus] = useState<HostedAgentRuntimeStatus>();
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus>();
  const [protocolStatus, setProtocolStatus] = useState<ProtocolStatus>();
  const [runtimeStatusError, setRuntimeStatusError] = useState<string>();
  const [authUser, setAuthUser] = useState<AuthUser>();
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string>();

  const pendingGraph = useMemo(() => pendingWorkflowGraph(activeAction), [activeAction]);
  const graph = runtimeGraph ?? pendingGraph;
  const selectedNode =
    graph.nodes.find((node) => node.node_id === selectedNodeId) ??
    graph.nodes[1];
  const activeDefinition = actionDefinitions[activeAction];
  const activeTraceId = traceId ?? "runtime_pending";
  const runtimeBlocker =
    sessionError ??
    runtimeStatusError ??
    (runtimeStatus?.errors.length ? runtimeStatus.errors.join(" | ") : undefined) ??
    (protocolStatus?.errors.length ? protocolStatus.errors.join(" | ") : undefined) ??
    (!runtimeBooting && !runtimeStatus ? "Runtime status unavailable" : undefined);
  const runtimeBlockerLabel = runtimeBlocker
    ? userFacingRuntimeBlocker(runtimeBlocker)
    : undefined;
  const runtimeReady =
    !runtimeBooting &&
    !runtimeBlocker &&
    runtimeStatus?.ok === true &&
    protocolStatus?.ok !== false;
  const signedIn = Boolean(authUser);
  const workflowControlsDisabled = busy || !signedIn || !runtimeReady;
  const chatDisabled = busy || !signedIn || !runtimeReady;
  const highRiskExecutionReviewRequired =
    activeAction === "copy_trade" && !executed;
  const hasInspectedAction = Boolean(runtimeTrace?.action && runtimeTrace.action_hash);
  const policyRequiresConfirmation =
    runtimeTrace?.policy_decision?.decision === "requires_confirmation" ||
    runtimeTrace?.status === "requires_confirmation";
  const showExecutionReview =
    highRiskExecutionReviewRequired &&
    (executionReviewOpen || policyRequiresConfirmation);
  const executeCtaLabel =
    highRiskExecutionReviewRequired && !executionConfirmationAccepted
      ? "Review risk"
      : "Execute";
  const selectedByoAgentId = selectedByoAgentIds[activeAction];
  const activeByoAgentId =
    selectedByoAgentId &&
    registryAgents.some(
      (agent) =>
        agent.agent_id === selectedByoAgentId &&
        agent.kind === "byo" &&
        agent.enabled !== false &&
        agent.identity_verified === true &&
        agent.supported_semantic_types.includes(activeAction)
    )
      ? selectedByoAgentId
      : undefined;
  const topStatusLabel = runtimeBooting
    ? "Connecting"
    : runtimeBlocker
      ? "Blocked"
    : executed
      ? "Executed"
      : runtimeTrace?.status
        ? runtimeTrace.status.replaceAll("_", " ")
        : simulated
          ? "Simulated"
          : "Ready";
  const topStatusTone =
    runtimeBlocker
      ? "amber"
      : executed || runtimeTrace?.status === "executed"
      ? "green"
      : runtimeTrace?.status === "policy_rejected" ||
          runtimeTrace?.status === "requires_confirmation"
        ? "amber"
        : simulated || runtimeTrace
          ? "blue"
          : "neutral";

  const derivedNodes = graph.nodes;

  const loadAgentRegistry = useCallback(async () => {
    try {
      const response = await getJson<AgentsApiResponse>("/agents");
      setRegistryAgents(response.agents ?? []);
      setRegistryError(undefined);
    } catch (error) {
      setRegistryAgents([]);
      setRegistryError(
        error instanceof Error ? error.message : "Agent registry unavailable"
      );
    }
  }, []);

  const loadSessionIndex = useCallback(async () => {
    try {
      const sessions = await getJson<SessionsApiResponse>("/sessions?limit=20");
      setSessionIndex(sessions.sessions ?? []);
      setSessionError(undefined);
      return sessions.sessions ?? [];
    } catch (error) {
      setSessionIndex([]);
      setSessionError(
        error instanceof Error ? error.message : "Session index unavailable"
      );
      return [];
    }
  }, []);

  const loadRuntimeStatus = useCallback(async () => {
    try {
      const response = await getJson<RuntimeStatusApiResponse>("/runtime/status");
      setHostedAgentStatus(response.hostedAgents);
      setRuntimeStatus(response.runtime);
      setProtocolStatus(response.protocol);
      setRuntimeStatusError(undefined);
    } catch (error) {
      setHostedAgentStatus(undefined);
      setRuntimeStatus(undefined);
      setProtocolStatus(undefined);
      setRuntimeStatusError(
        error instanceof Error ? error.message : "Runtime status unavailable"
      );
    }
  }, []);

  const loadAuthSession = useCallback(async () => {
    setAuthLoading(true);
    try {
      const response = await getJson<AuthSessionApiResponse>("/auth/session");
      setAuthUser(response.user);
      setAuthError(undefined);
      return response.user;
    } catch (error) {
      setAuthUser(undefined);
      setAuthError(error instanceof Error ? error.message : "Wallet session unavailable");
      return undefined;
    } finally {
      setAuthLoading(false);
    }
  }, []);

  const refreshGraph = useCallback(
    async (nextSessionId: string, action: ActionType = activeAction) => {
      const response = await fetch(
        `/sessions/${nextSessionId}/graph?semantic_type=${action}`,
        { cache: "no-store" }
      );
      if (!response.ok) {
        return undefined;
      }
      const payload = (await response.json()) as { graph?: WorkflowGraphData };
      if (payload.graph) {
        setRuntimeGraph(payload.graph);
      }
      return payload.graph;
    },
    [activeAction]
  );

  const refreshTrace = useCallback(async (nextTraceId: string) => {
    const response = await fetch(`/traces/${nextTraceId}`, {
      cache: "no-store",
    });
    if (!response.ok) {
      setRuntimeTrace(undefined);
      setTraceRestorable(false);
      return undefined;
    }
    const payload = (await response.json()) as TraceApiResponse;
    setRuntimeTrace(payload.trace);
    setTraceRestorable(true);
    return payload.trace;
  }, []);

  const refreshMessages = useCallback(
    async (nextSessionId: string, action: ActionType = activeAction) => {
      const payload = await getJson<SessionMessagesApiResponse>(
        `/sessions/${nextSessionId}/messages?semantic_type=${action}`
      );
      setMessages(payload.messages ?? []);
      setTraceId(payload.trace_id);
      setTraceRestorable(Boolean(payload.trace_exists));
      return payload;
    },
    [activeAction]
  );

  const refreshCurrent = useCallback(async () => {
    if (!authUser) {
      await loadRuntimeStatus();
      return;
    }
    await Promise.all([
      loadAgentRegistry(),
      loadSessionIndex().catch(() => undefined),
      loadRuntimeStatus(),
    ]);
    let nextTraceId = traceId;
    let shouldRefreshTrace = traceRestorable;
    if (sessionId) {
      await refreshGraph(sessionId, activeAction);
      const messagePayload = await refreshMessages(sessionId, activeAction).catch(
        () => undefined
      );
      if (messagePayload) {
        nextTraceId = messagePayload.trace_id;
        shouldRefreshTrace = Boolean(messagePayload.trace_exists);
      }
    }
    if (nextTraceId && verifyOnRestore && shouldRefreshTrace) {
      await refreshTrace(nextTraceId);
    }
  }, [
    activeAction,
    authUser,
    loadAgentRegistry,
    loadRuntimeStatus,
    loadSessionIndex,
    refreshGraph,
    refreshMessages,
    refreshTrace,
    sessionId,
    traceId,
    traceRestorable,
    verifyOnRestore,
  ]);

  useEffect(() => {
    let cancelled = false;
    const action = sessionBootRequest.action;

    async function bootRuntimeSession() {
      if (authLoading) {
        return;
      }
      if (!authUser) {
        setRuntimeBooting(false);
        setBusy(false);
        setSessionId(undefined);
        setTraceId(undefined);
        setRuntimeGraph(undefined);
        setRuntimeTrace(undefined);
        setSessionIndex([]);
        setRegistryAgents([]);
        setMessages([
          runtimeNoticeMessage(
            action,
            "Sign in with a Sui wallet before creating a MeshAction session."
          ),
        ]);
        return;
      }
      setRuntimeBooting(true);
      setBusy(true);
      setSelectedNodeId("node_agent");
      setSimulated(false);
      setExecuted(false);
      setExecutionReviewOpen(false);
      setExecutionConfirmationAccepted(false);
      setPolicyApproved(false);
      setSessionId(undefined);
      setTraceId(undefined);
      setTraceRestorable(false);
      setRuntimeGraph(undefined);
      setRuntimeTrace(undefined);
      setSessionError(undefined);
      setDraft("");
      setMessages([
        runtimeNoticeMessage(
          action,
          "Workspace ready. Simulate or send a message to start a session."
        ),
      ]);

      try {
        if (cancelled) {
          return;
        }

        setActiveAction(action);

        await Promise.all([
          loadAgentRegistry().catch(() => undefined),
          loadSessionIndex().catch(() => undefined),
          loadRuntimeStatus().catch(() => undefined),
        ]);
      } catch (error) {
        if (!cancelled) {
          const message =
            error instanceof Error ? error.message : "Runtime connection failed";
          setSessionError(message);
          setMessages([
            runtimeNoticeMessage(
              action,
              `Runtime connection failed: ${message}`
            ),
          ]);
        }
      } finally {
        if (!cancelled) {
          setRuntimeBooting(false);
          setBusy(false);
        }
      }
    }

    bootRuntimeSession();

    return () => {
      cancelled = true;
    };
  }, [
    authLoading,
    authUser,
    loadAgentRegistry,
    loadRuntimeStatus,
    loadSessionIndex,
    sessionBootRequest,
  ]);

  useEffect(() => {
    Promise.resolve().then(() => {
      loadAuthSession();
      loadRuntimeStatus();
    });
  }, [loadAuthSession, loadRuntimeStatus]);

  useEffect(() => {
    if (!authUser) {
      return;
    }
    Promise.resolve().then(() => {
      loadAgentRegistry();
    });
  }, [authUser, loadAgentRegistry]);

  useEffect(() => {
    if (!pollTransport || !sessionId) {
      return;
    }
    const timer = window.setInterval(() => {
      refreshCurrent().catch(() => undefined);
    }, 15000);
    return () => window.clearInterval(timer);
  }, [pollTransport, refreshCurrent, sessionId]);

  function handleActionChange(value: string[]) {
    const next = value[0] as ActionType | undefined;
    if (!next) {
      return;
    }

    setActiveAction(next);
    setExecutionReviewOpen(false);
    setExecutionConfirmationAccepted(false);
    setSessionBootRequest({ action: next, key: Date.now() });
  }

  async function ensureSession() {
    if (!authUser) {
      throw new Error("Wallet sign-in required");
    }
    if (sessionId && traceId) {
      return { sessionId, traceId };
    }

    const created = await postJson<SessionApiResponse>("/sessions", {
      semantic_type: activeAction,
      content: activeDefinition.objective,
    });
    setSessionError(undefined);
    setSessionId(created.session.session_id);
    setTraceId(created.session.trace_id);
    setTraceRestorable(false);
    if (created.session.messages?.length) {
      setMessages(created.session.messages);
    }
    if (created.graph) {
      setRuntimeGraph(created.graph);
    }
    return {
      sessionId: created.session.session_id,
      traceId: created.session.trace_id,
    };
  }

  function resetRuntimeState(action: ActionType = activeAction) {
    setSessionId(undefined);
    setTraceId(undefined);
    setTraceRestorable(false);
    setRuntimeGraph(undefined);
    setRuntimeTrace(undefined);
    setSessionIndex([]);
    setRegistryAgents([]);
    setSelectedNodeId("node_agent");
    setSimulated(false);
    setExecuted(false);
    setExecutionReviewOpen(false);
    setExecutionConfirmationAccepted(false);
    setPolicyApproved(false);
    setMessages([
      runtimeNoticeMessage(
        action,
        "Sign in with a Sui wallet before creating a MeshAction session."
      ),
    ]);
  }

  async function handleSignOut() {
    setBusy(true);
    try {
      await postJson("/auth/logout", {});
      setAuthUser(undefined);
      resetRuntimeState();
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Logout failed");
    } finally {
      setBusy(false);
    }
  }

  function handleSignedIn(user: AuthUser) {
    setAuthUser(user);
    setAuthError(undefined);
    setSessionBootRequest({ action: activeAction, key: Date.now() });
  }

  function applyRuntimeTraceState(trace: RuntimeTrace | undefined) {
    const status = trace?.status;
    setSimulated(Boolean(trace));
    setExecuted(status === "executed");
    setPolicyApproved(
      status === "policy_approved" ||
        status === "claimed" ||
        status === "anchored" ||
        status === "executed" ||
        trace?.policy_decision?.decision === "approved"
    );
  }

  async function openSession(session: SessionIndexItem) {
    setBusy(true);
    setRuntimeBooting(false);
    setActiveAction(session.semantic_type);
    setSelectedNodeId("node_agent");
    setDraft("");
    setSessionId(session.session_id);
    setTraceId(undefined);
    setTraceRestorable(false);
    setRuntimeGraph(undefined);
    setRuntimeTrace(undefined);
    setSimulated(false);
    setExecuted(false);
    setExecutionReviewOpen(false);
    setExecutionConfirmationAccepted(false);
    setPolicyApproved(false);
    setSessionError(undefined);

    try {
      const [messagePayload] = await Promise.all([
        refreshMessages(session.session_id, session.semantic_type),
        refreshGraph(session.session_id, session.semantic_type),
      ]);
      setTraceId(messagePayload.trace_id);
      setTraceRestorable(Boolean(messagePayload.trace_exists));
      if (!messagePayload.messages?.length) {
        setMessages([
          runtimeNoticeMessage(
            session.semantic_type,
            "Session restored. No conversation messages were found."
          ),
        ]);
      }
      if (verifyOnRestore && messagePayload.trace_exists) {
        const restoredTrace = await refreshTrace(messagePayload.trace_id);
        applyRuntimeTraceState(restoredTrace);
      }
      await Promise.all([
        loadSessionIndex().catch(() => undefined),
        loadRuntimeStatus().catch(() => undefined),
      ]);
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : "Session restore failed");
      appendSystemMessage(error);
    } finally {
      setBusy(false);
    }
  }

  function appendSystemMessage(error: unknown) {
    setMessages((current) => [
      ...current,
      {
        id: `msg_error_${Date.now()}`,
        role: "system",
        author: "Runtime",
        body: error instanceof Error ? error.message : "Runtime request failed",
        timestamp: new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
        trace_id: activeTraceId,
      },
    ]);
  }

  async function submitMessage() {
    const body = draft.trim();
    if (!body) {
      return;
    }

    setBusy(true);
    try {
      const runtime = await ensureSession();
      const result = await postJson<MessageApiResponse>(
        `/sessions/${runtime.sessionId}/messages`,
        {
          content: body,
          semantic_type: activeAction,
          byo_agent_id: activeByoAgentId,
        }
      );
      if (result.messages?.length) {
        setMessages(result.messages);
      }
      setTraceId(result.trace_id);
      setDraft("");
      setExecutionConfirmationAccepted(false);
      setTraceRestorable(result.prepared === true);
      if (result.trace) {
        setRuntimeTrace(result.trace);
        applyRuntimeTraceState(result.trace);
        setExecutionReviewOpen(
          result.trace.status === "requires_confirmation" ||
            result.trace.policy_decision?.decision === "requires_confirmation"
        );
      } else {
        setSimulated(false);
        setExecuted(false);
        setExecutionReviewOpen(false);
        setPolicyApproved(false);
        setRuntimeTrace(undefined);
      }
      if (result.workflow_error) {
        setSelectedNodeId("node_agent");
      } else if (result.policy_decision) {
        setSelectedNodeId("node_policy");
      } else {
        setSelectedNodeId("node_agent");
      }
      await refreshGraph(runtime.sessionId, activeAction);
      await loadSessionIndex().catch(() => undefined);
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : "Message request failed");
      appendSystemMessage(error);
    } finally {
      setBusy(false);
    }
  }

  async function simulateAction() {
    setBusy(true);
    setExecutionReviewOpen(false);
    setExecutionConfirmationAccepted(false);
    try {
      const runtime = await ensureSession();
      await postJson(`/traces/${runtime.traceId}/propose`, {
        session_id: runtime.sessionId,
        semantic_type: activeAction,
        byo_agent_id: activeByoAgentId,
        force_reprepare: true,
      });
      setTraceRestorable(true);
      applyRuntimeTraceState(await refreshTrace(runtime.traceId));
      const evaluated = await postJson<EvaluateApiResponse>(
        `/traces/${runtime.traceId}/evaluate`,
        {
          session_id: runtime.sessionId,
          semantic_type: activeAction,
          confirmed: false,
        }
      );
      setSimulated(true);
      setPolicyApproved(evaluated.policy_decision.status === "approved");
      setTraceRestorable(true);
      setSelectedNodeId("node_policy");
      const refreshedTrace = await refreshTrace(runtime.traceId);
      applyRuntimeTraceState(refreshedTrace);
      setExecutionReviewOpen(
        refreshedTrace?.status === "requires_confirmation" ||
          refreshedTrace?.policy_decision?.decision === "requires_confirmation"
      );
      await refreshGraph(runtime.sessionId);
      await loadSessionIndex().catch(() => undefined);
    } catch (error) {
      appendSystemMessage(error);
    } finally {
      setBusy(false);
    }
  }

  async function executeAction() {
    if (
      highRiskExecutionReviewRequired &&
      (!hasInspectedAction || !executionConfirmationAccepted)
    ) {
      setExecutionReviewOpen(true);
      setSelectedNodeId("node_policy");
      return;
    }

    setBusy(true);
    try {
      const runtime = await ensureSession();
      let approved = policyApproved;
      if (!policyApproved) {
        const evaluated = await postJson<EvaluateApiResponse>(
          `/traces/${runtime.traceId}/evaluate`,
          {
            session_id: runtime.sessionId,
            semantic_type: activeAction,
            confirmed: true,
          }
        );
        approved = evaluated.policy_decision.status === "approved";
        setPolicyApproved(approved);
        if (!approved) {
          throw new Error(
            `Policy did not approve execution: ${evaluated.policy_decision.reason}`
          );
        }
      }
      const executedResult = await postJson<ExecuteApiResponse>(
        `/traces/${runtime.traceId}/execute`,
        {
          semantic_type: activeAction,
          policy_approved: approved,
          confirmed: true,
        }
      );
      setSimulated(true);
      setExecuted(true);
      setExecutionReviewOpen(false);
      setExecutionConfirmationAccepted(false);
      setTraceRestorable(true);
      setSelectedNodeId("node_sui");
      setMessages((current) => [
        ...current,
        {
          id: `msg_receipt_${Date.now()}`,
          role: "system",
          author: "Policy Sentinel",
          body: `Receipt recorded: ${receiptPrimaryLabel(
            executedResult.receipt,
            runtime.traceId
          )}.`,
          timestamp: new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }),
          trace_id: runtime.traceId,
        },
      ]);
      applyRuntimeTraceState(await refreshTrace(runtime.traceId));
      await refreshGraph(runtime.sessionId);
      await loadSessionIndex().catch(() => undefined);
    } catch (error) {
      appendSystemMessage(error);
    } finally {
      setBusy(false);
    }
  }

  async function disableByoAgent(agent: AgentManifest) {
    setBusy(true);
    try {
      await postJson<AgentMutationApiResponse>(
        `/agents/${encodeURIComponent(agent.agent_id)}/disable`,
        {}
      );
      setSelectedByoAgentIds((current) => {
        const next = { ...current };
        for (const action of actionOrder) {
          if (next[action] === agent.agent_id) {
            delete next[action];
          }
        }
        return next;
      });
      await loadAgentRegistry();
    } catch (error) {
      appendSystemMessage(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mesh-app min-h-screen overflow-x-hidden">
      <div className="relative z-10 mx-auto flex min-h-screen max-w-[1720px] flex-col gap-3 p-2 sm:p-3">
        <TopBar
          statusLabel={topStatusLabel}
          statusTone={topStatusTone}
          busy={busy}
          authUser={authUser}
          authLoading={authLoading}
          onRefresh={() => {
            refreshCurrent().catch(appendSystemMessage);
          }}
          onShowEvents={() => {
            setSelectedNodeId("node_audit");
            if (traceId && verifyOnRestore && traceRestorable) {
              refreshTrace(traceId)
                .then(applyRuntimeTraceState)
                .catch(appendSystemMessage);
            }
          }}
          onShowRuntime={() => {
            setSelectedNodeId("node_executor");
            loadRuntimeStatus().catch(appendSystemMessage);
          }}
          onSignOut={() => {
            handleSignOut().catch(appendSystemMessage);
          }}
        />

        {!authUser ? (
          <>
            <WalletSignInPanel
              authLoading={authLoading}
              authError={authError}
              onSignedIn={handleSignedIn}
            />
            {selectedNodeId === "node_executor" ? (
              <div className="px-2 pb-4 lg:px-0">
                <InspectorPanel
                  action={activeAction}
                  node={selectedNode}
                  executed={executed}
                  runtimeTrace={runtimeTrace}
                  agents={registryAgents}
                  hostedAgentStatus={hostedAgentStatus}
                  runtimeStatus={runtimeStatus}
                  protocolStatus={protocolStatus}
                  runtimeStatusError={runtimeStatusError}
                  className="mx-auto w-full max-w-2xl"
                />
              </div>
            ) : null}
          </>
        ) : (
        <div className="grid flex-1 grid-cols-1 gap-3 lg:grid-cols-[280px_minmax(0,1fr)] xl:grid-cols-[280px_minmax(0,1fr)_340px]">
          <LeftRail
            activeAction={activeAction}
            agents={registryAgents}
            registryError={registryError}
            sessions={sessionIndex}
            currentSessionId={sessionId}
            runtimeBooting={runtimeBooting}
            sessionQuery={sessionQuery}
            onSessionQueryChange={setSessionQuery}
            onOpenSession={(session) => {
              openSession(session).catch(appendSystemMessage);
            }}
            pollTransport={pollTransport}
            onPollTransportChange={setPollTransport}
            verifyOnRestore={verifyOnRestore}
            onVerifyOnRestoreChange={setVerifyOnRestore}
            selectedByoAgentId={activeByoAgentId}
            onSelectByoAgent={(agentId) => {
              setSelectedByoAgentIds((current) => ({
                ...current,
                [activeAction]: agentId,
              }));
            }}
            onDisableByoAgent={(agent) => {
              disableByoAgent(agent).catch(appendSystemMessage);
            }}
            onAgentRegistered={() => {
              loadAgentRegistry();
              loadSessionIndex().catch(() => undefined);
            }}
            className="order-2 lg:order-1"
          />

          <section className="order-1 min-w-0 lg:order-2">
            <div className="mesh-glass min-w-0 overflow-hidden rounded-lg">
              <div className="grid gap-4 border-b border-slate-200 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_auto]">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h1 className="text-lg font-semibold leading-7 text-slate-950">
                      Action workspace
                    </h1>
                    <Badge
                      variant="outline"
                      className="border-slate-200 bg-slate-50 font-mono text-[11px] text-slate-600"
                    >
                      {activeDefinition.semantic_type}
                    </Badge>
                    {hostedAgentStatus ? (
                      <Badge
                        variant="outline"
                        className={cn(
                          "font-mono text-[11px]",
                          hostedAgentStatus.mode === "llm"
                            ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                            : "border-amber-200 bg-amber-50 text-amber-700"
                        )}
                      >
                        {hostedAgentStatus.mode === "llm"
                          ? `hosted:${hostedAgentStatus.model ?? "llm"}`
                          : "hosted:deterministic"}
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">
                    {activeDefinition.objective}
                  </p>
                  {hostedAgentStatus ? (
                    <p className="mt-2 max-w-3xl text-xs leading-5 text-slate-500">
                      {hostedAgentStatus.reason}
                    </p>
                  ) : null}
                  <p className="mt-2 break-all font-mono text-[11px] text-slate-500">
                    {activeTraceId}
                  </p>
                </div>
                <div className="flex min-w-0 flex-col items-start gap-3 lg:items-end">
                  <ActionToggle
                    activeAction={activeAction}
                    onActionChange={handleActionChange}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={simulateAction}
                      disabled={workflowControlsDisabled}
                      title={runtimeBlockerLabel}
                      className="border-slate-200 bg-white text-slate-700 hover:bg-slate-50 hover:text-slate-950"
                    >
                      <FileSearch data-icon="inline-start" />
                      Simulate
                    </Button>
                    <Button
                      size="sm"
                      onClick={executeAction}
                      disabled={workflowControlsDisabled}
                      title={runtimeBlockerLabel}
                      className="bg-slate-950 text-white shadow-sm hover:bg-slate-800"
                    >
                      <Play data-icon="inline-start" />
                      {executeCtaLabel}
                    </Button>
                  </div>
                  {runtimeBlocker ? (
                    <p className="max-w-[360px] text-left text-xs leading-5 text-amber-700 lg:text-right">
                      Runtime blocked: {runtimeBlockerLabel}
                    </p>
                  ) : null}
                </div>
              </div>

              <div className="grid grid-cols-2 border-b border-slate-200 bg-slate-200 sm:grid-cols-4">
                <StageCell label="Intent" value={sessionId ? "sessioned" : "pending"} />
                <StageCell
                  label="Policy"
                  value={
                    policyApproved
                      ? "approved"
                      : runtimeTrace?.policy_decision?.decision ?? "awaiting"
                  }
                />
                <StageCell
                  label="Claim"
                  value={runtimeTrace?.status === "claimed" ? "claimed" : executed ? "used" : "open"}
                />
                <StageCell
                  label="Receipt"
                  value={runtimeTrace?.receipt?.txDigest ? "on-chain" : "pending"}
                />
              </div>

              <div className="grid grid-cols-3 border-b border-slate-200 bg-slate-50">
                <Metric
                  value={String(runtimeTrace?.events?.length ?? messages.length)}
                  label="events"
                />
                <Metric
                  value={String(
                    registryAgents.filter((agent) =>
                      agent.supported_semantic_types.includes(activeAction)
                    ).length || "-"
                  )}
                  label="agents"
                />
                <Metric
                  value={
                    runtimeTrace?.verification
                      ? runtimeTrace.verification.ok
                        ? "ok"
                        : "fail"
                      : "pending"
                  }
                  label="verify"
                />
              </div>

              {showExecutionReview ? (
                <ExecutionReviewPanel
                  action={activeAction}
                  trace={runtimeTrace}
                  accepted={executionConfirmationAccepted}
                  busy={busy}
                  hasInspectedAction={hasInspectedAction}
                  onAcceptedChange={setExecutionConfirmationAccepted}
                  onSimulate={() => {
                    simulateAction().catch(appendSystemMessage);
                  }}
                  onExecute={() => {
                    executeAction().catch(appendSystemMessage);
                  }}
                />
              ) : null}

              <div className="grid min-h-[690px] min-w-0 grid-cols-1 min-[1400px]:grid-cols-[minmax(280px,0.9fr)_minmax(460px,1.1fr)]">
                <ChatPanel
                  messages={messages}
                  draft={draft}
                  onDraftChange={setDraft}
                  onSubmit={submitMessage}
                  action={activeAction}
                  disabled={chatDisabled}
                  blockReason={runtimeBlocker}
                  blockLabel={runtimeBlockerLabel}
                />
                <div className="min-w-0 border-t border-slate-200 bg-slate-50 min-[1400px]:border-l min-[1400px]:border-t-0">
                  <div className="flex items-center justify-between gap-3 px-4 py-3">
                    <div>
                      <h2 className="text-sm font-semibold text-slate-950">Workflow graph</h2>
                      <p className="font-mono text-xs text-slate-500">
                        {activeDefinition.semantic_type}
                      </p>
                    </div>
                    <Badge
                      variant="outline"
                      className={cn(
                        "border-slate-200 bg-white text-slate-600",
                        runtimeReady && "border-emerald-200 bg-emerald-50 text-emerald-700"
                      )}
                    >
                      {runtimeReady ? "Live runtime" : "Runtime blocked"}
                    </Badge>
                  </div>
                  <div className="h-[390px] min-w-0 overflow-hidden border-y border-slate-200 bg-white">
                    <WorkflowGraph
                      key={`${activeTraceId}:${activeAction}`}
                      graphNodes={derivedNodes}
                      graphEdges={graph.edges}
                      selectedNodeId={selectedNodeId}
                      onSelectNode={setSelectedNodeId}
                    />
                  </div>
                  <TraceTimeline
                    action={activeAction}
                    activeTraceId={activeTraceId}
                    messages={messages}
                    simulated={simulated}
                    executed={executed}
                    runtimeTrace={runtimeTrace}
                    runtimeBooting={runtimeBooting}
                  />
                </div>
              </div>
            </div>
          </section>

          <InspectorPanel
            action={activeAction}
            node={selectedNode}
            executed={executed}
            runtimeTrace={runtimeTrace}
            agents={registryAgents}
            hostedAgentStatus={hostedAgentStatus}
            runtimeStatus={runtimeStatus}
            protocolStatus={protocolStatus}
            runtimeStatusError={runtimeStatusError}
            className="order-3"
          />
        </div>
        )}
      </div>
    </main>
  );
}

function TopBar({
  statusLabel,
  statusTone,
  busy,
  authUser,
  authLoading,
  onRefresh,
  onShowEvents,
  onShowRuntime,
  onSignOut,
}: {
  statusLabel: string;
  statusTone: "neutral" | "blue" | "green" | "amber";
  busy: boolean;
  authUser?: AuthUser;
  authLoading: boolean;
  onRefresh: () => void;
  onShowEvents: () => void;
  onShowRuntime: () => void;
  onSignOut: () => void;
}) {
  return (
    <header className="mesh-glass sticky top-3 z-20 rounded-lg px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-lg bg-slate-950 text-white shadow-sm">
            <Network className="size-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-base font-semibold text-slate-950">MeshAction</span>
              <Badge
                variant="outline"
                className="border-blue-200 bg-blue-50 text-blue-700"
              >
                testnet
              </Badge>
            </div>
            <p className="text-xs text-slate-500">
              Workflow console for verifiable Sui actions
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {authUser ? (
            <Badge
              variant="outline"
              className="hidden max-w-[240px] truncate border-emerald-200 bg-emerald-50 font-mono text-[11px] text-emerald-700 sm:inline-flex"
            >
              {shortAddress(authUser.wallet_address)}
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className="hidden border-amber-200 bg-amber-50 text-amber-700 sm:inline-flex"
            >
              {authLoading ? "Checking wallet" : "Wallet required"}
            </Badge>
          )}
          <StatusPill
            label={statusLabel}
            tone={statusTone}
          />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label="Refresh traces"
                  onClick={onRefresh}
                  disabled={busy}
                  className="border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-950"
                />
              }
            >
              <RefreshCw />
            </TooltipTrigger>
            <TooltipContent>Refresh traces</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label="Show trace events"
                  onClick={onShowEvents}
                  className="border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-950"
                />
              }
            >
              <Bell />
            </TooltipTrigger>
            <TooltipContent>Trace events</TooltipContent>
          </Tooltip>
          <Button
            variant="outline"
            size="sm"
            onClick={onShowRuntime}
            className="border-slate-200 bg-white text-slate-700 hover:bg-slate-50 hover:text-slate-950"
          >
            <PanelRight data-icon="inline-start" />
            Runtime
          </Button>
          {authUser ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label="Sign out"
                    onClick={onSignOut}
                    disabled={busy}
                    className="border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-950"
                  />
                }
              >
                <LogOut />
              </TooltipTrigger>
              <TooltipContent>Sign out</TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </div>
    </header>
  );
}

function WalletSignInPanel({
  authLoading,
  authError,
  onSignedIn,
}: {
  authLoading: boolean;
  authError?: string;
  onSignedIn: (user: AuthUser) => void;
}) {
  const currentAccount = useCurrentAccount();
  const signPersonalMessage = useSignPersonalMessage();
  const [walletAddress, setWalletAddress] = useState("");
  const [challenge, setChallenge] = useState<AuthChallengeApiResponse>();
  const [signature, setSignature] = useState("");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const connectedAddress = currentAccount?.address;
  const formBusy = busy || signPersonalMessage.isPending;
  const walletAddressValue = walletAddress || connectedAddress || "";

  async function requestChallenge() {
    setBusy(true);
    setLocalError(undefined);
    try {
      const response = await postJson<AuthChallengeApiResponse>("/auth/challenge", {
        wallet_address: walletAddressValue.trim(),
      });
      setChallenge(response);
      setWalletAddress(response.wallet_address);
      setSignature("");
    } catch (error) {
      setChallenge(undefined);
      setLocalError(error instanceof Error ? error.message : "Challenge request failed");
    } finally {
      setBusy(false);
    }
  }

  async function signInWithConnectedWallet() {
    if (!currentAccount?.address) {
      setLocalError("Connect a Sui wallet before signing in");
      return;
    }
    setBusy(true);
    setLocalError(undefined);
    try {
      const nextChallenge = await postJson<AuthChallengeApiResponse>(
        "/auth/challenge",
        {
          wallet_address: currentAccount.address,
        }
      );
      setWalletAddress(nextChallenge.wallet_address);
      setChallenge(nextChallenge);
      setSignature("");

      const signed = await signPersonalMessage.mutateAsync({
        account: currentAccount,
        message: encodePersonalMessage(nextChallenge.message),
      });
      setSignature(signed.signature);

      const response = await postJson<AuthSessionApiResponse>("/auth/session", {
        challenge_id: nextChallenge.challenge_id,
        signature: signed.signature,
      });
      if (!response.user) {
        throw new Error("Wallet session did not return a user");
      }
      onSignedIn(response.user);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Wallet sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  async function submitSignature() {
    if (!challenge) {
      setLocalError("Create a wallet challenge first");
      return;
    }
    setBusy(true);
    setLocalError(undefined);
    try {
      const response = await postJson<AuthSessionApiResponse>("/auth/session", {
        challenge_id: challenge.challenge_id,
        signature: signature.trim(),
      });
      if (!response.user) {
        throw new Error("Wallet session did not return a user");
      }
      onSignedIn(response.user);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Wallet sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="grid flex-1 place-items-center px-2 py-10">
      <div className="mesh-glass w-full max-w-2xl rounded-lg p-5">
        <div className="flex items-start gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-slate-950 text-white">
            <Wallet className="size-5" />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-slate-950">Wallet sign-in</h1>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              A Sui wallet signature creates or restores your MeshAction account.
            </p>
          </div>
        </div>

        <div className="mt-5 grid gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <ConnectModal
              trigger={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="border-slate-200 bg-white text-slate-700 hover:bg-slate-50 hover:text-slate-950"
                >
                  <Wallet data-icon="inline-start" />
                  {connectedAddress
                    ? shortAddress(connectedAddress)
                    : "Connect Sui wallet"}
                </Button>
              }
            />
            <Button
              type="button"
              size="sm"
              onClick={signInWithConnectedWallet}
              disabled={formBusy || authLoading || !connectedAddress}
              className="bg-slate-950 text-white hover:bg-slate-800"
            >
              <ShieldCheck data-icon="inline-start" />
              Sign in with wallet
            </Button>
          </div>
          {connectedAddress ? (
            <p className="break-all rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 font-mono text-xs text-emerald-700">
              Connected wallet {connectedAddress}
            </p>
          ) : (
            <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
              No browser wallet connected. Manual signature fallback remains available below.
            </p>
          )}
          <Separator />
          <Input
            value={walletAddressValue}
            onChange={(event) => setWalletAddress(event.target.value)}
            placeholder="0x wallet address"
            className="mesh-glass-field h-10 font-mono text-sm"
            disabled={formBusy || authLoading}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={requestChallenge}
              disabled={formBusy || authLoading || !walletAddressValue.trim()}
            >
              <ShieldCheck data-icon="inline-start" />
              Create challenge
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={submitSignature}
              disabled={formBusy || authLoading || !challenge || !signature.trim()}
            >
              <CheckCircle2 data-icon="inline-start" />
              Verify signature
            </Button>
          </div>
          {challenge ? (
            <div className="grid gap-2">
              <RailLabel icon={ShieldCheck} label="Message to sign" />
              <Textarea
                value={challenge.message}
                readOnly
                className="mesh-glass-field min-h-32 resize-none font-mono text-xs text-slate-700"
              />
              <Input
                value={signature}
                onChange={(event) => setSignature(event.target.value)}
                placeholder="Personal message signature"
                className="mesh-glass-field h-10 font-mono text-sm"
                disabled={formBusy || authLoading}
              />
            </div>
          ) : null}
          {localError || authError ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {localError ?? authError}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function Metric({ value, label }: { value: string; label: string }) {
  return (
    <div className="border-r border-slate-200 bg-slate-50 px-3 py-2 last:border-r-0">
      <div className="text-sm font-semibold leading-none text-slate-950">{value}</div>
      <div className="mt-1 font-mono text-[10px] uppercase tracking-normal text-slate-500">
        {label}
      </div>
    </div>
  );
}

function StageCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white px-3 py-2">
      <div className="font-mono text-[10px] uppercase tracking-normal text-slate-500">
        {label}
      </div>
      <div className="mt-1 truncate text-sm font-medium text-slate-950">
        {value}
      </div>
    </div>
  );
}

function ExecutionReviewPanel({
  action,
  trace,
  accepted,
  busy,
  hasInspectedAction,
  onAcceptedChange,
  onSimulate,
  onExecute,
}: {
  action: ActionType;
  trace?: RuntimeTrace;
  accepted: boolean;
  busy: boolean;
  hasInspectedAction: boolean;
  onAcceptedChange: (value: boolean) => void;
  onSimulate: () => void;
  onExecute: () => void;
}) {
  const manifest = trace?.action?.manifest;
  const target = manifest?.primaryTarget
    ? [
        manifest.primaryTarget.packageId,
        manifest.primaryTarget.module,
        manifest.primaryTarget.function,
      ]
        .filter(Boolean)
        .join("::")
    : "pending inspected target";
  const policyDecision = trace?.policy_decision?.decision ?? "simulation required";
  const policyReason =
    trace?.policy_decision?.reason ??
    "Run simulation to inspect the PTB before confirming execution.";
  const valueAtRisk = formatValueAtRisk(manifest?.valueAtRisk);
  const summary =
    manifest?.summary ?? actionDefinitions[action].proposal;

  return (
    <section className="border-b border-amber-200 bg-amber-50/70 px-4 py-3">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="grid size-8 place-items-center rounded-lg bg-amber-100 text-amber-700 ring-1 ring-amber-200">
              <AlertTriangle className="size-4" />
            </span>
            <div>
              <h2 className="text-sm font-semibold text-slate-950">
                Execution review required
              </h2>
              <p className="text-xs leading-5 text-amber-800">
                Copy trade execution needs inspected facts and explicit user confirmation.
              </p>
            </div>
          </div>
          <p className="mt-3 max-w-4xl text-sm leading-6 text-slate-700">
            {summary}
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:min-w-[320px]">
          <label className="flex items-start gap-2 rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm text-slate-700">
            <Checkbox
              checked={accepted}
              disabled={busy || !hasInspectedAction}
              onCheckedChange={(checked) => onAcceptedChange(checked === true)}
              aria-label="Confirm copy trade execution review"
            />
            <span>
              <span className="block font-medium text-slate-950">
                I reviewed the inspected PTB and risk limits.
              </span>
              <span className="block text-xs leading-5 text-slate-500">
                Required before submitting a confirmed execution request.
              </span>
            </span>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onSimulate}
              disabled={busy}
              className="border-amber-200 bg-white text-amber-800 hover:bg-amber-100"
            >
              <FileSearch data-icon="inline-start" />
              {hasInspectedAction ? "Refresh simulation" : "Run simulation"}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={onExecute}
              disabled={busy || !hasInspectedAction || !accepted}
              className="bg-slate-950 text-white hover:bg-slate-800"
            >
              <Play data-icon="inline-start" />
              Confirm and execute
            </Button>
          </div>
        </div>
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-4">
        <ReviewDatum label="Policy state" value={policyDecision} />
        <ReviewDatum label="Max exposure" value={valueAtRisk} />
        <ReviewDatum label="Target" value={target} />
        <ReviewDatum label="Trace" value={trace?.trace_id ?? "pending"} />
      </div>
      <p className="mt-2 text-xs leading-5 text-amber-800">{policyReason}</p>
    </section>
  );
}

function ReviewDatum({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-amber-200 bg-white px-3 py-2">
      <div className="font-mono text-[10px] uppercase tracking-normal text-slate-500">
        {label}
      </div>
      <div className="mt-1 truncate font-mono text-xs text-slate-800">{value}</div>
    </div>
  );
}

function formatValueAtRisk(valueAtRisk?: {
  amount?: string;
  coinType?: string;
  decimals?: number;
}) {
  if (
    valueAtRisk &&
    typeof valueAtRisk.amount === "string"
  ) {
    const decimals = valueAtRisk.decimals ?? 9;
    const coinType = valueAtRisk.coinType ?? "SUI";
    const normalized = Number(valueAtRisk.amount) / 10 ** decimals;
    if (Number.isFinite(normalized)) {
      return `${normalized.toLocaleString(undefined, {
        maximumFractionDigits: 4,
      })} ${coinType}`;
    }
    return `${valueAtRisk.amount} ${coinType}`;
  }
  return "12 SUI";
}

function AgentRegistryCard({
  activeAction,
  agent,
  selected,
  onSelect,
  onDisable,
}: {
  activeAction: ActionType;
  agent: AgentManifest;
  selected: boolean;
  onSelect: (agentId: string) => void;
  onDisable: (agent: AgentManifest) => void;
}) {
  const supportsActiveAction =
    agent.supported_semantic_types.includes(activeAction);
  const enabled = agent.enabled !== false;
  const verified = agent.identity_verified === true;
  const selectable =
    agent.kind === "byo" &&
    enabled &&
    verified &&
    supportsActiveAction &&
    isHttpAgentEndpoint(agent.endpoint);
  const disableAllowed = agent.kind === "byo" && verified && enabled;

  return (
    <div
      className={cn(
        "rounded-lg border p-3",
        selected
          ? "border-blue-300 bg-blue-50"
          : supportsActiveAction && enabled
            ? "border-slate-200 bg-white"
            : "border-slate-200 bg-slate-50"
      )}
    >
      <div className="flex items-start gap-2">
        <Avatar className="size-7 rounded-md">
          <AvatarFallback className="rounded-md bg-slate-900 text-xs text-white">
            {agent.kind === "hosted" ? "H" : "B"}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <p className="truncate text-sm font-medium leading-5">
              {agent.display_name}
            </p>
            {selected ? (
              <Badge className="border-blue-200 bg-white text-blue-700">
                selected
              </Badge>
            ) : null}
            {!enabled ? (
              <Badge className="border-slate-200 bg-slate-100 text-slate-500">
                disabled
              </Badge>
            ) : null}
          </div>
          <p className="truncate font-mono text-[11px] text-slate-500">
            {agent.kind} | {agent.agent_id}
          </p>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {agent.supported_semantic_types.slice(0, 3).map((type) => (
          <Badge
            key={type}
            variant="secondary"
            className="bg-white text-slate-600 ring-1 ring-slate-200"
          >
            {type}
          </Badge>
        ))}
      </div>
      {agent.kind === "byo" ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onSelect(agent.agent_id)}
            disabled={!selectable || selected}
            className="h-7 border-slate-200 bg-white px-2 text-xs text-slate-700 hover:bg-slate-100 hover:text-slate-950"
            title={
              selectable
                ? undefined
                : "BYO agent must be enabled, verified, HTTP(S), and support this action"
            }
          >
            {selected ? "Selected" : "Use for action"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onDisable(agent)}
            disabled={!disableAllowed}
            className="h-7 border-slate-200 bg-white px-2 text-xs text-slate-700 hover:bg-slate-100 hover:text-slate-950"
          >
            Disable
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function isHttpAgentEndpoint(endpoint: string) {
  return endpoint.startsWith("https://") || endpoint.startsWith("http://");
}

function ByoRegistrationForm({
  activeAction,
  onRegistered,
}: {
  activeAction: ActionType;
  onRegistered: () => void;
}) {
  const currentAccount = useCurrentAccount();
  const signPersonalMessage = useSignPersonalMessage();
  const [agentId, setAgentId] = useState("agent_byo_runtime");
  const [displayName, setDisplayName] = useState("BYO Runtime Agent");
  const [endpoint, setEndpoint] = useState("");
  const [signingAddress, setSigningAddress] = useState("");
  const [signedAtMs, setSignedAtMs] = useState(() => String(Date.now()));
  const [signature, setSignature] = useState("");
  const [registering, setRegistering] = useState(false);
  const [result, setResult] = useState<string>();
  const [semanticTypes, setSemanticTypes] = useState<ActionType[]>(() => [
    ...actionOrder,
  ]);
  const capabilities = useMemo(
    () =>
      semanticTypes.includes("copy_trade")
      ? ["event_envelope", "proposal", "ptb_action", "follower_ptb", "receipt_sign"]
        : ["event_envelope", "proposal", "ptb_action", "receipt_sign"],
    [semanticTypes]
  );
  const connectedAddress = currentAccount?.address;
  const registrationBusy = registering || signPersonalMessage.isPending;
  const registrationMessage = buildByoRegistrationMessage({
    agentId,
    endpoint,
    signingAddress,
    capabilities,
    semanticTypes,
    signedAtMs,
  });

  function toggleSemanticType(action: ActionType, checked: boolean) {
    setSignature("");
    setSemanticTypes((current) => {
      if (checked) {
        return actionOrder.filter(
          (candidate) => candidate === action || current.includes(candidate)
        );
      }
      if (current.length <= 1) {
        return current;
      }
      return current.filter((candidate) => candidate !== action);
    });
  }

  async function signRegistrationWithConnectedWallet() {
    if (!currentAccount?.address) {
      setResult("Connect a Sui wallet before signing the BYO registration.");
      return;
    }
    if (!agentId.trim() || !endpoint.trim()) {
      setResult("agent_id and endpoint are required before signing.");
      return;
    }
    if (!semanticTypes.length) {
      setResult("Select at least one supported action before signing.");
      return;
    }

    const nextSignedAtMs = Date.now();
    const nextSigningAddress = currentAccount.address;
    const messageToSign = buildByoRegistrationMessage({
      agentId,
      endpoint,
      signingAddress: nextSigningAddress,
      capabilities,
      semanticTypes,
      signedAtMs: nextSignedAtMs,
    });

    setResult(undefined);
    try {
      const signed = await signPersonalMessage.mutateAsync({
        account: currentAccount,
        message: encodePersonalMessage(messageToSign),
      });
      setSigningAddress(nextSigningAddress);
      setSignedAtMs(String(nextSignedAtMs));
      setSignature(signed.signature);
      setResult(`Signed registration as ${shortAddress(nextSigningAddress)}`);
    } catch (error) {
      setResult(error instanceof Error ? error.message : "Wallet signing failed");
    }
  }

  async function submitRegistration() {
    setRegistering(true);
    setResult(undefined);
    try {
      const response = await postJson<AgentRegisterApiResponse>(
        "/agents/register",
        {
          agent_id: agentId.trim(),
          display_name: displayName.trim(),
          kind: "byo",
          endpoint: endpoint.trim(),
          signing_address: signingAddress.trim(),
          supported_semantic_types: semanticTypes,
          capabilities,
          memory_provider: "external://byo-agent",
          required_policy_checks: ["registered_identity", "signature_valid"],
          signed_at_ms: Number(signedAtMs),
          registration_signature: signature.trim(),
        }
      );
      setResult(`Registered ${response.agent.display_name}`);
      onRegistered();
    } catch (error) {
      setResult(error instanceof Error ? error.message : "Registration failed");
    } finally {
      setRegistering(false);
    }
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-slate-950">
          Register BYO agent
        </span>
        <Badge className="border-slate-200 bg-white text-slate-600">
          {semanticTypes.length} actions
        </Badge>
      </div>
      <div className="flex flex-col gap-2">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {actionOrder.map((action) => (
            <label
              key={action}
              className={cn(
                "flex items-center gap-2 rounded-lg border bg-white px-2 py-1.5 text-xs text-slate-700",
                action === activeAction && "border-slate-300 text-slate-950"
              )}
            >
              <Checkbox
                checked={semanticTypes.includes(action)}
                onCheckedChange={(checked) =>
                  toggleSemanticType(action, checked === true)
                }
                disabled={registrationBusy}
                aria-label={`Register BYO support for ${action}`}
              />
              <span className="truncate">{action}</span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              if (connectedAddress) {
                setSigningAddress(connectedAddress);
              }
            }}
            disabled={!connectedAddress || registrationBusy}
            className="border-slate-200 bg-white text-slate-700 hover:bg-slate-100 hover:text-slate-950"
          >
            <Wallet data-icon="inline-start" />
            Use wallet
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={signRegistrationWithConnectedWallet}
            disabled={
              !connectedAddress ||
              registrationBusy ||
              !agentId.trim() ||
              !endpoint.trim()
            }
            className="border-slate-200 bg-white text-slate-700 hover:bg-slate-100 hover:text-slate-950"
          >
            <ShieldCheck data-icon="inline-start" />
            Sign registration
          </Button>
        </div>
        <Input
          value={agentId}
          onChange={(event) => setAgentId(event.target.value)}
          className="mesh-glass-field h-8 rounded-lg text-xs"
          placeholder="agent_id"
        />
        <Input
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          className="mesh-glass-field h-8 rounded-lg text-xs"
          placeholder="Display name"
        />
        <Input
          value={endpoint}
          onChange={(event) => setEndpoint(event.target.value)}
          className="mesh-glass-field h-8 rounded-lg text-xs"
          placeholder="https://agent.example.com/suimesh"
        />
        <Input
          value={signingAddress}
          onChange={(event) => setSigningAddress(event.target.value)}
          className="mesh-glass-field h-8 rounded-lg text-xs"
          placeholder="Agent wallet signing address"
        />
        <Textarea
          value={registrationMessage}
          readOnly
          className="mesh-glass-field min-h-28 rounded-lg font-mono text-[11px]"
          aria-label="Agent registration message to sign"
        />
        <div className="flex gap-2">
          <Input
            value={signedAtMs}
            onChange={(event) => setSignedAtMs(event.target.value)}
            className="mesh-glass-field h-8 min-w-0 rounded-lg text-xs"
            placeholder="signed_at_ms"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setSignedAtMs(String(Date.now()))}
            className="border-slate-200 bg-white text-slate-700 hover:bg-slate-100 hover:text-slate-950"
          >
            Now
          </Button>
        </div>
        <Textarea
          value={signature}
          onChange={(event) => setSignature(event.target.value)}
          className="mesh-glass-field min-h-16 rounded-lg text-xs"
          placeholder="Agent wallet registration_signature"
        />
        <Button
          type="button"
          size="sm"
          onClick={submitRegistration}
          disabled={
            registrationBusy ||
            !agentId.trim() ||
            !displayName.trim() ||
            !endpoint.trim() ||
            !signingAddress.trim() ||
            !signature.trim()
          }
          className="bg-slate-950 text-white hover:bg-slate-800"
        >
          <Code2 data-icon="inline-start" />
          Register
        </Button>
        {result ? (
          <p className="break-words text-xs leading-5 text-slate-500">{result}</p>
        ) : null}
      </div>
    </div>
  );
}

function LeftRail({
  activeAction,
  agents,
  registryError,
  sessions,
  currentSessionId,
  runtimeBooting,
  sessionQuery,
  onSessionQueryChange,
  onOpenSession,
  pollTransport,
  onPollTransportChange,
  verifyOnRestore,
  onVerifyOnRestoreChange,
  selectedByoAgentId,
  onSelectByoAgent,
  onDisableByoAgent,
  onAgentRegistered,
  className,
}: {
  activeAction: ActionType;
  agents: AgentManifest[];
  registryError?: string;
  sessions: SessionIndexItem[];
  currentSessionId?: string;
  runtimeBooting: boolean;
  sessionQuery: string;
  onSessionQueryChange: (value: string) => void;
  onOpenSession: (session: SessionIndexItem) => void;
  pollTransport: boolean;
  onPollTransportChange: (value: boolean) => void;
  verifyOnRestore: boolean;
  onVerifyOnRestoreChange: (value: boolean) => void;
  selectedByoAgentId?: string;
  onSelectByoAgent: (agentId: string) => void;
  onDisableByoAgent: (agent: AgentManifest) => void;
  onAgentRegistered: () => void;
  className?: string;
}) {
  const sessionSource =
    sessions.length > 0
      ? sessions
      : currentSessionId
        ? [
            {
              session_id: currentSessionId,
              semantic_type: activeAction,
              status: runtimeBooting ? "connecting" : "ready",
              updated_at: new Date().toISOString(),
              created_at: new Date().toISOString(),
            },
          ]
        : [];
  const query = sessionQuery.trim().toLowerCase();
  const visibleSessions = query
    ? sessionSource.filter((session) =>
        [
          session.session_id,
          session.semantic_type,
          session.status,
          actionDefinitions[session.semantic_type].label,
        ]
          .join(" ")
          .toLowerCase()
          .includes(query)
      )
    : sessionSource;

  return (
    <aside
      className={cn(
        "mesh-glass rounded-lg",
        className
      )}
    >
      <div className="border-b border-slate-200 p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <Input
            value={sessionQuery}
            onChange={(event) => onSessionQueryChange(event.target.value)}
            className="mesh-glass-field h-9 rounded-lg pl-8 text-sm placeholder:text-slate-400"
            placeholder="Search sessions"
          />
        </div>
      </div>

      <ScrollArea className="max-h-[520px] lg:h-[780px] lg:max-h-none">
        <div className="p-3">
          <Tabs defaultValue="sessions" className="gap-3">
            <TabsList className="grid w-full grid-cols-3 bg-slate-100">
              <TabsTrigger value="sessions" className="text-xs">
                Sessions
              </TabsTrigger>
              <TabsTrigger value="agents" className="text-xs">
                Agents
              </TabsTrigger>
              <TabsTrigger value="controls" className="text-xs">
                Controls
              </TabsTrigger>
            </TabsList>

            <TabsContent value="sessions" className="mt-3 flex flex-col gap-2">
              <RailLabel icon={MessageSquareText} label="Sessions" />
              {visibleSessions.length === 0 ? (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-500">
                  {runtimeBooting ? "Connecting runtime..." : "No runtime sessions"}
                </div>
              ) : null}
              {visibleSessions.map((session) => (
                <button
                  key={session.session_id}
                  type="button"
                  aria-label={`Open session ${session.session_id}`}
                  onClick={() => onOpenSession(session)}
                  className={cn(
                    "rounded-lg border p-3 text-left transition hover:bg-slate-50",
                    session.session_id === currentSessionId
                      ? "border-blue-200 bg-blue-50"
                      : "border-slate-200 bg-white"
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">
                      {actionDefinitions[session.semantic_type].label}
                    </span>
                    <span className="font-mono text-[11px] text-slate-500">
                      {formatSessionTime(session.updated_at)}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-xs text-slate-500">
                    {session.status} | {session.session_id}
                  </p>
                </button>
              ))}
            </TabsContent>

            <TabsContent value="agents" className="mt-3 flex flex-col gap-3">
              <div className="flex items-center justify-between gap-2">
                <RailLabel icon={Bot} label="Agent Registry" />
                <Badge className="border-slate-200 bg-white text-slate-600">
                  {agents.length || "-"}
                </Badge>
              </div>
              {registryError ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                  Registry unavailable: {registryError}
                </div>
              ) : null}
              {!registryError && agents.length === 0 ? (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-500">
                  Loading registry...
                </div>
              ) : null}
              {agents.map((agent) => (
                <AgentRegistryCard
                  key={agent.agent_id}
                  activeAction={activeAction}
                  agent={agent}
                  selected={agent.agent_id === selectedByoAgentId}
                  onSelect={onSelectByoAgent}
                  onDisable={onDisableByoAgent}
                />
              ))}
              <ByoRegistrationForm
                activeAction={activeAction}
                onRegistered={onAgentRegistered}
              />
            </TabsContent>

            <TabsContent value="controls" className="mt-3 flex flex-col gap-3">
              <RailLabel icon={DatabaseZap} label="Cache policy" />
              <label className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white p-3 text-sm">
                <span>
                  <span className="block font-medium">Poll transport</span>
                  <span className="block text-xs text-slate-500">
                    Update UI cache from SuiMesh events
                  </span>
                </span>
                <Switch
                  checked={pollTransport}
                  onCheckedChange={onPollTransportChange}
                  size="sm"
                  aria-label="Poll transport"
                />
              </label>
              <label className="flex items-start gap-2 rounded-lg border border-slate-200 bg-white p-3 text-sm">
                <Checkbox
                  checked={verifyOnRestore}
                  onCheckedChange={onVerifyOnRestoreChange}
                  aria-label="Verify restored trace"
                />
                <span>
                  <span className="block font-medium">Verify after restore</span>
                  <span className="block text-xs text-slate-500">
                    Ignore tampered cache summaries
                  </span>
                </span>
              </label>
            </TabsContent>
          </Tabs>
        </div>
      </ScrollArea>
    </aside>
  );
}

function ActionToggle({
  activeAction,
  onActionChange,
}: {
  activeAction: ActionType;
  onActionChange: (value: string[]) => void;
}) {
  return (
    <ToggleGroup
      value={[activeAction]}
      onValueChange={onActionChange}
      size="sm"
      variant="outline"
      spacing={0}
      className="rounded-lg border border-slate-200 bg-slate-100 p-1"
      aria-label="Action type"
    >
      {actionOrder.map((action) => (
        <ToggleGroupItem
          key={action}
          value={action}
          className="rounded-md border-0 px-3 text-slate-600 data-[state=on]:bg-white data-[state=on]:text-slate-950 data-[state=on]:shadow-sm"
        >
          {actionDefinitions[action].label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function ChatPanel({
  messages,
  draft,
  onDraftChange,
  onSubmit,
  action,
  disabled,
  blockReason,
  blockLabel,
}: {
  messages: ChatMessage[];
  draft: string;
  onDraftChange: (value: string) => void;
  onSubmit: () => void | Promise<void>;
  action: ActionType;
  disabled: boolean;
  blockReason?: string;
  blockLabel?: string;
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-col">
      <ScrollArea className="min-h-0 min-w-0 flex-1">
        <div className="flex flex-col gap-3 p-4">
          {messages.map((message) => (
            <div
              key={message.id}
              className={cn(
                "min-w-0 max-w-full rounded-lg border p-3 shadow-sm sm:max-w-[92%]",
                message.role === "user"
                  ? "ml-auto border-blue-200 bg-blue-50"
                  : message.role === "system"
                    ? "border-amber-200 bg-amber-50"
                    : "border-slate-200 bg-white"
              )}
            >
              <div className="mb-1 flex min-w-0 items-center justify-between gap-3">
                <span className="min-w-0 truncate text-sm font-medium">
                  {message.author}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-slate-500">
                  {message.timestamp}
                </span>
              </div>
              <p className="break-words text-sm leading-6 text-slate-700">
                {message.body}
              </p>
              {message.trace_id ? (
                <p className="mt-2 break-all font-mono text-[11px] text-slate-500">
                  {message.trace_id}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      </ScrollArea>
      <div className="border-t border-slate-200 bg-slate-50 p-3">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <PromptChip label="transfer" active={action === "transfer"} />
            <PromptChip label="contract_call" active={action === "contract_call"} />
            <PromptChip label="copy_trade" active={action === "copy_trade"} />
          </div>
          <div className="flex min-w-0 gap-2">
            <Textarea
              value={draft}
              onChange={(event) => onDraftChange(event.target.value)}
              placeholder="Ask an agent to prepare and inspect a Sui action"
              className="mesh-glass-field min-h-16 min-w-0 resize-none rounded-lg text-slate-900 placeholder:text-slate-400"
              disabled={disabled}
              onKeyDown={(event) => {
                if (
                  !disabled &&
                  event.key === "Enter" &&
                  (event.metaKey || event.ctrlKey)
                ) {
                  onSubmit();
                }
              }}
            />
            <Button
              type="button"
              size="icon-lg"
              aria-label="Send message"
              onClick={onSubmit}
              disabled={disabled}
              title={blockLabel ?? blockReason}
              className="self-end rounded-lg bg-[color:var(--mesh-system-blue)] text-white hover:bg-[oklch(0.52_0.15_252)]"
            >
              <Send />
            </Button>
          </div>
          {blockReason ? (
            <p className="text-xs leading-5 text-amber-700">
              Runtime blocked: {blockLabel ?? blockReason}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function TraceTimeline({
  action,
  activeTraceId,
  messages,
  simulated,
  executed,
  runtimeTrace,
  runtimeBooting,
}: {
  action: ActionType;
  activeTraceId: string;
  messages: ChatMessage[];
  simulated: boolean;
  executed: boolean;
  runtimeTrace?: RuntimeTrace;
  runtimeBooting: boolean;
}) {
  const events =
    runtimeTrace?.events?.length
      ? runtimeTrace.events
      : messages.length
        ? messages.map(messageToTraceEvent)
        : [
            {
              id: "runtime_pending",
              label: "Runtime",
              actor: "MeshAction",
              status: runtimeBooting ? ("running" as const) : ("idle" as const),
              timestamp: timestampNow(),
              summary: runtimeBooting
                ? "Connecting to MeshAction runtime."
                : "Runtime session has not produced trace events yet.",
            },
          ];
  const progress = runtimeTrace
    ? progressForTrace(runtimeTrace.status, simulated, executed)
    : runtimeBooting
      ? 8
      : messages.length
        ? 18
        : 0;

  return (
    <aside className="min-w-0 border-t border-slate-200 bg-slate-50 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-950">Trace state</h2>
          <p className="font-mono text-[11px] text-slate-500">
            {runtimeTrace?.trace_id ?? activeTraceId}
          </p>
        </div>
        <Badge
          variant={action === "copy_trade" ? "destructive" : "outline"}
          className={cn(
            "border-slate-200 bg-white text-slate-600",
            action === "copy_trade" && "border-rose-200 bg-rose-50 text-rose-700"
          )}
        >
          {actionDefinitions[action].risk} risk
        </Badge>
      </div>

      <Progress value={progress} className="mt-4 h-2 bg-slate-200" />

      <div className="mt-4 flex flex-col gap-3">
        {events.map((event, index) => {
          const currentStatus = event.status;

          return (
            <div key={event.id} className="grid grid-cols-[18px_minmax(0,1fr)] gap-2">
              <div className="flex flex-col items-center">
                <span
                  className={cn(
                    "mt-1 size-2.5 rounded-full",
                    currentStatus === "blocked"
                      ? "bg-amber-300"
                      : currentStatus === "idle"
                        ? "bg-slate-300"
                        : "bg-[color:var(--mesh-system-blue)]"
                  )}
                />
                {index < events.length - 1 ? (
                  <span className="mt-1 h-full min-h-8 w-px bg-slate-200" />
                ) : null}
              </div>
              <div className="min-w-0 pb-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{event.label}</span>
                  <span className="font-mono text-[11px] text-slate-500">
                    {event.timestamp}
                  </span>
                </div>
                <p className="text-xs leading-5 text-slate-500">
                  {event.summary}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function progressForTrace(
  status: string | undefined,
  simulated: boolean,
  executed: boolean
) {
  if (status === "executed" || executed) {
    return 100;
  }
  if (status === "claimed") {
    return 84;
  }
  if (status === "anchored" || status === "policy_approved") {
    return 74;
  }
  if (status === "requires_confirmation" || status === "policy_rejected") {
    return 66;
  }
  if (status === "simulated" || simulated) {
    return 58;
  }
  return 42;
}

function messageToTraceEvent(message: ChatMessage): RuntimeTraceEvent {
  const failed = /failed|error/i.test(message.body);
  return {
    id: message.id,
    label:
      message.role === "user"
        ? "Intent"
        : message.role === "agent"
          ? "AgentMessage"
          : "Runtime",
    actor: message.author,
    status: failed
      ? "blocked"
      : message.role === "system"
        ? "running"
        : "approved",
    timestamp: message.timestamp,
    summary: message.body,
  };
}

function formatSessionTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "now";
  }
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function userFacingRuntimeBlocker(message: string) {
  const normalized = message.toLowerCase();
  if (normalized.includes("database_url")) {
    return "Database connection is not configured for this runtime.";
  }
  if (
    normalized.includes("missing sui signer") ||
    normalized.includes("suimesh_sui_private_key") ||
    normalized.includes("suimesh_sui_keystore_entry")
  ) {
    return "Server-side Sui signer is not configured.";
  }
  if (normalized.includes("does not match signer")) {
    return normalized.includes("trace registry owner")
      ? "Runtime signer does not own the configured MeshAction trace registry."
      : "Configured signer address does not match the private key.";
  }
  if (normalized.includes("suimesh_trace_registry_id")) {
    return "MeshAction trace registry is not configured.";
  }
  if (normalized.includes("trace registry type mismatch")) {
    return "Configured trace registry is not a SuiMesh trace::Registry for this package.";
  }
  if (normalized.includes("endpoint must use https")) {
    return "Selected BYO agent must use HTTPS, or local BYO mode must be enabled.";
  }
  if (normalized.includes("endpoint resolves to")) {
    return "Selected BYO agent endpoint resolves to a blocked network address.";
  }
  return message;
}

function permissionGranted(
  permission: string,
  trace: RuntimeTrace | undefined,
  executed: boolean
) {
  if (!trace) {
    return false;
  }
  if (permission === "claim_once") {
    return (
      trace.status === "claimed" ||
      trace.status === "executed" ||
      Boolean(trace.receipt)
    );
  }
  if (permission === "execute_testnet") {
    return executed || trace.status === "executed" || Boolean(trace.receipt?.txDigest);
  }
  if (permission === "publish_receipt") {
    return Boolean(trace.receipt);
  }
  return false;
}

function InspectorPanel({
  action,
  node,
  executed,
  runtimeTrace,
  agents,
  hostedAgentStatus,
  runtimeStatus,
  protocolStatus,
  runtimeStatusError,
  className,
}: {
  action: ActionType;
  node: WorkflowNode;
  executed: boolean;
  runtimeTrace?: RuntimeTrace;
  agents: AgentManifest[];
  hostedAgentStatus?: HostedAgentRuntimeStatus;
  runtimeStatus?: RuntimeStatus;
  protocolStatus?: ProtocolStatus;
  runtimeStatusError?: string;
  className?: string;
}) {
  const definition = actionDefinitions[action];
  const receipt = runtimeTrace?.receipt;
  const actionManifest = runtimeTrace?.action?.manifest;
  const auditRecords = runtimeTrace
    ? auditRecordsForTrace(runtimeTrace)
    : (node.metadata.audit ?? ["trace pending", "archive_status:pending"]);
  const manifest =
    node.type === "agent"
      ? agents.find((agent) => node.metadata.refs?.includes(agent.agent_id))
      : undefined;

  return (
    <aside
      className={cn(
        "mesh-glass rounded-lg",
        className
      )}
    >
      <ScrollArea className="max-h-[680px] lg:h-[780px] lg:max-h-none">
        <div className="flex flex-col gap-4 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-mono text-[11px] font-medium uppercase tracking-normal text-slate-500">
                Selected node
              </p>
              <h2 className="mt-1 text-xl font-semibold leading-7 text-slate-950">
                {node.label}
              </h2>
              <p className="text-sm text-slate-500">{node.metadata.headline}</p>
            </div>
            <Badge
              variant={node.status === "blocked" ? "destructive" : "outline"}
              className="border-slate-200 bg-white text-slate-600"
            >
              {statusLabel[node.status]}
            </Badge>
          </div>

          <Card className="mesh-glass-soft rounded-lg" size="sm">
            <CardHeader>
              <CardTitle className="text-slate-950">Identity</CardTitle>
              <CardDescription className="text-slate-500">
                {node.type} node details
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <InspectorRow label="Session" value={node.session_id} />
              <InspectorRow label="Trace" value={node.trace_id ?? "none"} />
              <InspectorRow label="Semantic type" value={definition.semantic_type} />
              {manifest ? (
                <>
                  <InspectorRow label="Agent id" value={manifest.agent_id} />
                  <InspectorRow label="Endpoint" value={manifest.endpoint} />
                  <InspectorRow label="Signer" value={manifest.signing_address} />
                  <InspectorRow label="Memory" value={manifest.memory_provider} />
                </>
              ) : null}
            </CardContent>
          </Card>

          <Card className="mesh-glass-soft rounded-lg" size="sm">
            <CardHeader>
              <CardTitle className="text-slate-950">Action state</CardTitle>
              <CardDescription className="text-slate-500">
                {definition.label} generated action and receipt state
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <CodeLine
                icon={SquareTerminal}
                text={
                  actionManifest?.actionId
                    ? `action ${actionManifest.actionId}`
                    : "PTB pending until proposal"
                }
              />
              <CodeLine
                icon={GitBranch}
                text={actionManifest?.summary ?? "proposal pending until agent run"}
              />
              <CodeLine
                icon={CheckCircle2}
                text={
                  receipt?.txDigest ??
                  runtimeTrace?.action_hash ??
                  "digest pending until execution"
                }
              />
              <CodeLine
                icon={Archive}
                text={
                  receipt?.effectsHash
                    ? [
                        `effects ${receipt.effectsHash}`,
                        actionManifest?.ptbHash
                          ? `ptb ${actionManifest.ptbHash}`
                          : undefined,
                      ]
                        .filter(Boolean)
                        .join(" | ")
                    : actionManifest?.ptbHash
                      ? `ptb ${actionManifest.ptbHash} | effects pending`
                      : "ptb pending | effects pending"
                }
              />
            </CardContent>
          </Card>

          {node.node_id === "node_executor" ? (
            <Card className="mesh-glass-soft rounded-lg" size="sm">
              <CardHeader>
                <CardTitle className="text-slate-950">Runtime status</CardTitle>
                <CardDescription className="text-slate-500">
                  Server-side Sui executor configuration
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <InspectorRow
                  label="Signer"
                  value={
                    runtimeStatus?.signerConfigured
                      ? runtimeStatus.address ?? "configured"
                      : "missing"
                  }
                />
                <InspectorRow
                  label="Network"
                  value={runtimeStatus?.network ?? "unknown"}
                />
                <InspectorRow
                  label="RPC"
                  value={runtimeStatus?.rpcUrl ?? "unknown"}
                />
                <InspectorRow
                  label="Package"
                  value={runtimeStatus?.demoPackageId ?? "unknown"}
                />
                <InspectorRow
                  label="Hosted agents"
                  value={
                    hostedAgentStatus
                      ? hostedAgentStatus.mode === "llm"
                        ? hostedAgentStatus.model
                          ? `${hostedAgentStatus.provider ?? "llm"} / ${hostedAgentStatus.model}`
                          : hostedAgentStatus.provider ?? "llm"
                        : "deterministic fallback"
                      : "unknown"
                  }
                />
                <InspectorRow
                  label="Protocol"
                  value={
                    protocolStatus
                      ? `${protocolStatus.transport} / ${protocolStatus.traceGuard}`
                      : "unknown"
                  }
                />
                <InspectorRow
                  label="Trace reg."
                  value={protocolStatus?.traceRegistryId ?? "not configured"}
                />
                <InspectorRow
                  label="Reg. owner"
                  value={protocolStatus?.registry?.ownerAddress ?? "unknown"}
                />
                <InspectorRow
                  label="Writable"
                  value={
                    protocolStatus?.canonical
                      ? protocolStatus.registry?.writable
                        ? "yes"
                        : "no"
                      : "local cache"
                  }
                />
                {runtimeStatusError ||
                runtimeStatus?.errors.length ||
                protocolStatus?.errors.length ? (
                  <CodeLine
                    icon={FileSearch}
                    text={
                      [
                        runtimeStatusError,
                        ...(runtimeStatus?.errors ?? []),
                        ...(protocolStatus?.errors ?? []),
                      ]
                        .filter(Boolean)
                        .join(" | ") ||
                      "runtime status unavailable"
                    }
                  />
                ) : null}
                {hostedAgentStatus?.mode === "deterministic" ? (
                  <CodeLine icon={Bot} text={hostedAgentStatus.reason} />
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          <Card className="mesh-glass-soft rounded-lg" size="sm">
            <CardHeader>
              <CardTitle className="text-slate-950">Policy requirements</CardTitle>
              <CardDescription className="text-slate-500">
                Evaluation is based on inspected facts, not prose
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {(node.metadata.policy ?? definition.policy_checks).map((check) => (
                <div key={check} className="flex items-center gap-2 text-sm">
                  <ShieldCheck className="size-4 text-blue-600" />
                  <span>{check}</span>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className="mesh-glass-soft rounded-lg" size="sm">
            <CardHeader>
              <CardTitle className="text-slate-950">Execution permissions</CardTitle>
              <CardDescription className="text-slate-500">
                Claim and execute remain separated
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {["claim_once", "execute_testnet", "publish_receipt"].map(
                (permission) => (
                  <label key={permission} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={permissionGranted(permission, runtimeTrace, executed)}
                      aria-label={permission}
                      readOnly
                    />
                    <span>{permission}</span>
                  </label>
                )
              )}
            </CardContent>
          </Card>

          <Card className="mesh-glass-soft rounded-lg" size="sm">
            <CardHeader>
              <CardTitle className="text-slate-950">Audit records</CardTitle>
              <CardDescription className="text-slate-500">
                Restore and verification summary
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {auditRecords.map((record) => (
                <div key={record} className="flex items-center gap-2 text-sm">
                  <FileSearch className="size-4 text-slate-500" />
                  <span>{record}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </ScrollArea>
    </aside>
  );
}

function auditRecordsForTrace(trace: RuntimeTrace) {
  const receipt = trace.receipt;
  const records = [
    trace.verification?.ok
      ? "trace verification ok"
      : `trace verification failed: ${
          trace.verification?.errors?.join("; ") ?? "unknown"
        }`,
  ];
  if (receipt?.txDigest) {
    records.push(`tx ${receipt.txDigest}`);
  }
  if (receipt?.archive_provider && receipt.archive_ref) {
    const archiveRecord = archiveRefLabel(
      receipt.archive_ref,
      receipt.archive_provider
    );
    if (archiveRecord) {
      records.push(archiveRecord);
    }
  }
  if (receipt?.seal_access_ref) {
    records.push(receipt.seal_access_ref);
  }
  if (receipt?.archive_status === "failed" && receipt.archive_error) {
    records.push(`archive failed: ${receipt.archive_error}`);
  }
  if (receipt?.audit_event_hash) {
    records.push(`audit ${receipt.audit_event_hash}`);
  }
  return records;
}

function receiptPrimaryLabel(
  receipt: ExecuteApiResponse["receipt"],
  fallback: string
) {
  return receipt.txDigest ?? archiveRefLabel(receipt.archive_ref) ?? fallback;
}

function archiveRefLabel(
  ref: ReceiptArchiveRef | undefined,
  fallbackProvider?: string
) {
  if (!ref) {
    return undefined;
  }
  if (typeof ref === "string") {
    return fallbackProvider ? `${fallbackProvider}://${ref}` : ref;
  }
  const provider = ref.provider ?? fallbackProvider;
  if (provider && ref.blobId) {
    return `${provider}://${ref.blobId}`;
  }
  return ref.blobId ?? ref.digest;
}

function PromptChip({ label, active }: { label: string; active: boolean }) {
  return (
    <Badge
      variant="secondary"
      className={cn(
        "bg-white text-slate-500 ring-1 ring-slate-200",
        active && "bg-slate-950 text-white ring-slate-950"
      )}
    >
      {label}
    </Badge>
  );
}

function RailLabel({
  icon: Icon,
  label,
}: {
  icon: typeof Bot;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2 font-mono text-[11px] font-medium uppercase tracking-normal text-slate-500">
      <Icon className="size-3.5" />
      {label}
    </div>
  );
}

function StatusPill({
  label,
  tone,
}: {
  label: string;
  tone: "neutral" | "blue" | "green" | "amber";
}) {
  return (
    <span
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium",
        tone === "blue" &&
          "border-blue-200 bg-blue-50 text-blue-700",
        tone === "green" && "border-emerald-200 bg-emerald-50 text-emerald-700",
        tone === "amber" && "border-amber-200 bg-amber-50 text-amber-700",
        tone === "neutral" && "border-slate-200 bg-slate-50 text-slate-600"
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          tone === "neutral"
            ? "bg-slate-400"
            : tone === "green"
              ? "bg-[color:var(--mesh-system-green)]"
              : tone === "amber"
                ? "bg-[color:var(--mesh-system-orange)]"
              : "bg-[color:var(--mesh-system-blue)]"
        )}
      />
      {label}
    </span>
  );
}

function InspectorRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[94px_minmax(0,1fr)] gap-2 text-sm">
      <span className="text-slate-500">{label}</span>
      <span className="truncate font-mono text-xs text-slate-800">{value}</span>
    </div>
  );
}

function CodeLine({
  icon: Icon,
  text,
}: {
  icon: typeof Code2;
  text: string;
}) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-slate-200 bg-white p-3">
      <Icon className="mt-0.5 size-4 shrink-0 text-blue-600" />
      <code className="min-w-0 break-words font-mono text-xs leading-5 text-slate-700">
        {text}
      </code>
    </div>
  );
}
