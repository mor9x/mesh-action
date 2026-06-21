import { createHash } from "node:crypto";

import { fromBase64 } from "@mysten/bcs";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { bcs } from "@mysten/sui/bcs";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";

import type { SimulationResult } from "suimesh";

export const SUI_DEMO_PACKAGE_ID =
  "0xdeb6325f80800c0f58d99d28b06a65f4b02adccc3275bd375e144e000bfc6bdd";
export const SUI_TRANSFER_RECIPIENT =
  "0x6400bf33b07967e459544f31e007550de169afb4f578d47e5aa17d6492baa430";
export const SUI_TRANSFER_AMOUNT_MIST = "10000000";
export const SUI_COPY_MAX_EXPOSURE_MIST = "12000000000";

type NetworkName = "mainnet" | "testnet" | "devnet" | "localnet";

type RuntimeSigner = {
  address: string;
  keypair: Ed25519Keypair;
  client: SuiJsonRpcClient;
};

type ExecuteResult = {
  txDigest: string;
  effectsHash: string;
};

export type CopyTradePtbArgs = {
  target: string;
  sourceTraceId: string;
  followerTraceId: string;
  maxExposureMist: string;
};

let runtimeSigner: RuntimeSigner | undefined;

function effectsHash(value: unknown) {
  return `0x${createHash("sha256")
    .update(JSON.stringify(value ?? null))
    .digest("hex")}`;
}

function positiveNumberEnv(name: string, fallback: number) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function transientRpcAttempts() {
  return positiveNumberEnv("SUIMESH_SUI_RPC_RETRY_ATTEMPTS", 3);
}

function transientRpcDelayMs() {
  return positiveNumberEnv("SUIMESH_SUI_RPC_RETRY_DELAY_MS", 1_500);
}

function transientRpcError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("timeout") ||
    message.includes("socket") ||
    message.includes("econnreset") ||
    message.includes("enotfound") ||
    message.includes("temporarily unavailable")
  );
}

async function withTransientRpcRetry<T>(
  label: string,
  action: () => Promise<T>
): Promise<T> {
  const attempts = transientRpcAttempts();
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !transientRpcError(error)) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, transientRpcDelayMs() * attempt)
      );
    }
  }
  throw new Error(
    `${label} failed after ${attempts} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

function keypairFromCliKeystoreEntry(entry: string) {
  const bytes = Buffer.from(entry, "base64");
  const scheme = bytes[0];
  if (scheme !== 0) {
    throw new Error(`Unsupported Sui key scheme in CLI keystore: ${scheme}`);
  }
  return Ed25519Keypair.fromSecretKey(bytes.slice(1));
}

function bytesFromSecretEnv(value: string) {
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(value)) {
    return Buffer.from(value.replace(/^0x/, ""), "hex");
  }

  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 32) {
    return bytes;
  }
  if (bytes.length === 33 && bytes[0] === 0) {
    return bytes.slice(1);
  }
  throw new Error(
    "SUIMESH_SUI_PRIVATE_KEY must be suiprivkey..., a 32-byte hex/base64 Ed25519 secret, or set SUIMESH_SUI_KEYSTORE_ENTRY to a CLI keystore entry"
  );
}

function keypairFromEnv() {
  const privateKey = process.env.SUIMESH_SUI_PRIVATE_KEY?.trim();
  if (privateKey) {
    if (privateKey.startsWith("suiprivkey")) {
      return Ed25519Keypair.fromSecretKey(privateKey);
    }
    return Ed25519Keypair.fromSecretKey(bytesFromSecretEnv(privateKey));
  }

  const keystoreEntry = process.env.SUIMESH_SUI_KEYSTORE_ENTRY?.trim();
  if (keystoreEntry) {
    return keypairFromCliKeystoreEntry(keystoreEntry);
  }

  throw new Error(
    "Missing Sui signer env: set SUIMESH_SUI_PRIVATE_KEY=suiprivkey... or SUIMESH_SUI_KEYSTORE_ENTRY=<base64 CLI keystore entry>"
  );
}

function runtimeNetwork(): NetworkName {
  const raw = (process.env.SUIMESH_SUI_NETWORK ?? "testnet").trim();
  const normalized = raw === "local" ? "localnet" : raw;
  if (
    normalized === "mainnet" ||
    normalized === "testnet" ||
    normalized === "devnet" ||
    normalized === "localnet"
  ) {
    return normalized;
  }
  throw new Error(
    `Invalid SUIMESH_SUI_NETWORK: ${raw}. Expected mainnet, testnet, devnet, or localnet.`
  );
}

function getRuntimeSigner() {
  if (runtimeSigner) {
    return runtimeSigner;
  }

  const keypair = keypairFromEnv();
  const derivedAddress = keypair.getPublicKey().toSuiAddress();
  const expectedAddress = process.env.SUIMESH_SUI_ADDRESS?.trim();
  if (
    expectedAddress &&
    expectedAddress.toLowerCase() !== derivedAddress.toLowerCase()
  ) {
    throw new Error(
      `SUIMESH_SUI_ADDRESS ${expectedAddress} does not match signer ${derivedAddress}`
    );
  }

  const network = runtimeNetwork();
  const rpcUrl = process.env.SUIMESH_SUI_RPC_URL?.trim();
  runtimeSigner = {
    address: expectedAddress ?? derivedAddress,
    keypair,
    client: new SuiJsonRpcClient({
      network,
      url: rpcUrl || getJsonRpcFullnodeUrl(network),
    }),
  };
  return runtimeSigner;
}

export function getSuiRuntimeClient() {
  return getRuntimeSigner().client;
}

export function getSuiRuntimeSigner() {
  return getRuntimeSigner();
}

function utf8Vector(value: string) {
  return Array.from(new TextEncoder().encode(value));
}

async function signAndExecute(tx: Transaction): Promise<ExecuteResult> {
  const runtime = getRuntimeSigner();
  tx.setSender(runtime.address);
  tx.setGasBudget(50_000_000);

  const response = await withTransientRpcRetry(
    "signAndExecuteTransaction",
    () =>
      runtime.client.signAndExecuteTransaction({
        transaction: tx,
        signer: runtime.keypair,
        options: {
          showEffects: true,
          showEvents: true,
          showObjectChanges: true,
          showBalanceChanges: true,
        },
      })
  );

  const status = response.effects?.status;
  if (status?.status !== "success") {
    throw new Error(
      `Sui transaction failed: ${
        status && "error" in status ? status.error : "unknown error"
      }`
    );
  }

  await withTransientRpcRetry("waitForTransaction", () =>
    runtime.client.waitForTransaction({
      digest: response.digest,
      timeout: positiveNumberEnv("SUIMESH_SUI_WAIT_TIMEOUT_MS", 60_000),
      pollInterval: positiveNumberEnv("SUIMESH_SUI_WAIT_POLL_INTERVAL_MS", 1_000),
      options: {
        showEffects: true,
        showEvents: true,
        showObjectChanges: true,
        showBalanceChanges: true,
      },
    })
  );

  return {
    txDigest: response.digest,
    effectsHash: effectsHash(response.effects),
  };
}

function buildSuiTransferTransaction(input: {
  recipient?: string;
  amountMist?: string;
} = {}) {
  const tx = new Transaction();
  const amount = input.amountMist ?? SUI_TRANSFER_AMOUNT_MIST;
  const recipient = input.recipient ?? SUI_TRANSFER_RECIPIENT;
  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(amount)]);
  tx.transferObjects([coin], tx.pure.address(recipient));
  return tx;
}

function buildSuiDemoMoveCallTransaction(input: {
  traceId: string;
  semanticType: string;
  packageId?: string;
}) {
  const tx = new Transaction();
  const packageId = input.packageId ?? SUI_DEMO_PACKAGE_ID;
  tx.moveCall({
    target: `${packageId}::demo_action::mark_action`,
    arguments: [
      tx.pure.vector("u8", utf8Vector(input.traceId)),
      tx.pure.vector("u8", utf8Vector(input.semanticType)),
    ],
  });
  return tx;
}

function buildSuiCopyTradeTransaction(input: {
  sourceTraceId: string;
  followerTraceId: string;
  maxExposureMist?: string;
  packageId?: string;
}) {
  const tx = new Transaction();
  const packageId = input.packageId ?? SUI_DEMO_PACKAGE_ID;
  tx.moveCall({
    target: `${packageId}::demo_action::mirror_leader_ptb`,
    arguments: [
      tx.pure.vector("u8", utf8Vector(input.sourceTraceId)),
      tx.pure.vector("u8", utf8Vector(input.followerTraceId)),
      tx.pure.u64(input.maxExposureMist ?? SUI_COPY_MAX_EXPOSURE_MIST),
    ],
  });
  return tx;
}

export async function buildSuiTransferPtbBytes(input: {
  recipient?: string;
  amountMist?: string;
} = {}) {
  return buildSuiTransferTransaction(input).build({ onlyTransactionKind: true });
}

export async function buildSuiDemoMoveCallPtbBytes(input: {
  traceId: string;
  semanticType: string;
  packageId?: string;
}) {
  return buildSuiDemoMoveCallTransaction(input).build({ onlyTransactionKind: true });
}

export async function buildSuiCopyTradePtbBytes(input: {
  sourceTraceId: string;
  followerTraceId: string;
  maxExposureMist?: string;
  packageId?: string;
}) {
  return buildSuiCopyTradeTransaction(input).build({ onlyTransactionKind: true });
}

export async function devInspectSuiPtb(input: {
  ptbBytes: Uint8Array;
  sender?: string;
}): Promise<SimulationResult> {
  const runtime = getRuntimeSigner();
  const response = await withTransientRpcRetry("devInspectTransactionBlock", () =>
    runtime.client.devInspectTransactionBlock({
      sender: input.sender ?? runtime.address,
      transactionBlock: Transaction.fromKind(input.ptbBytes),
    })
  );
  const status = response.effects.status;
  return {
    ok: status.status === "success",
    gasEstimate: response.effects.gasUsed?.computationCost,
    events: response.events as never,
    error: status.status === "failure" ? status.error : undefined,
  };
}

export function decodeSuiCopyTradePtbArgs(
  ptbBytes: Uint8Array
): CopyTradePtbArgs {
  const snapshot = Transaction.fromKind(ptbBytes).getData() as {
    inputs: Array<{ Pure?: { bytes?: string } }>;
    commands: Array<{
      MoveCall?: {
        package: string;
        module: string;
        function: string;
        arguments?: Array<{ Input?: number }>;
      };
    }>;
  };
  const moveCall = snapshot.commands
    .map((command) => command.MoveCall)
    .find((command) => command !== undefined);
  if (!moveCall) {
    throw new Error("BYO action PTB does not include a MoveCall");
  }
  const args = moveCall.arguments ?? [];
  const target = `${moveCall.package}::${moveCall.module}::${moveCall.function}`;
  return {
    target,
    sourceTraceId: decodePureUtf8Vector(snapshot.inputs, args[0]?.Input),
    followerTraceId: decodePureUtf8Vector(snapshot.inputs, args[1]?.Input),
    maxExposureMist: decodePureU64(snapshot.inputs, args[2]?.Input),
  };
}

function decodePureUtf8Vector(
  inputs: Array<{ Pure?: { bytes?: string } }>,
  index: number | undefined
) {
  if (index === undefined) {
    throw new Error("BYO action PTB is missing vector<u8> argument");
  }
  const raw = inputs[index]?.Pure?.bytes;
  if (!raw) {
    throw new Error("BYO action PTB argument is not pure bytes");
  }
  const bytes = bcs.vector(bcs.u8()).parse(fromBase64(raw));
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

function decodePureU64(
  inputs: Array<{ Pure?: { bytes?: string } }>,
  index: number | undefined
) {
  if (index === undefined) {
    throw new Error("BYO action PTB is missing u64 argument");
  }
  const raw = inputs[index]?.Pure?.bytes;
  if (!raw) {
    throw new Error("BYO action PTB argument is not pure bytes");
  }
  return String(bcs.U64.parse(fromBase64(raw)));
}

export async function executeSuiPtbBytes(ptbBytes: Uint8Array) {
  return signAndExecute(Transaction.fromKind(ptbBytes));
}

export function getSuiRuntimeAddress() {
  return getRuntimeSigner().address;
}

export function getSuiRuntimeStatus() {
  const errors: string[] = [];
  let network: NetworkName = "testnet";
  let address: string | undefined;
  let signerConfigured = false;

  try {
    network = runtimeNetwork();
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Invalid Sui network");
  }

  try {
    const keypair = keypairFromEnv();
    const derivedAddress = keypair.getPublicKey().toSuiAddress();
    const expectedAddress = process.env.SUIMESH_SUI_ADDRESS?.trim();
    if (
      expectedAddress &&
      expectedAddress.toLowerCase() !== derivedAddress.toLowerCase()
    ) {
      throw new Error(
        `SUIMESH_SUI_ADDRESS ${expectedAddress} does not match signer ${derivedAddress}`
      );
    }
    signerConfigured = true;
    address = expectedAddress ?? derivedAddress;
  } catch (error) {
    errors.push(
      error instanceof Error ? error.message : "Sui signer is not configured"
    );
  }

  return {
    ok: errors.length === 0,
    signerConfigured,
    address,
    network,
    rpcUrl:
      process.env.SUIMESH_SUI_RPC_URL?.trim() || getJsonRpcFullnodeUrl(network),
    demoPackageId: SUI_DEMO_PACKAGE_ID,
    transferRecipient: SUI_TRANSFER_RECIPIENT,
    transferAmountMist: SUI_TRANSFER_AMOUNT_MIST,
    copyMaxExposureMist: SUI_COPY_MAX_EXPOSURE_MIST,
    errors,
  };
}
