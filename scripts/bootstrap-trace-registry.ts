import { Transaction } from "@mysten/sui/transactions";

import { loadLocalEnv } from "./load-env";
import { getSuiRuntimeClient, getSuiRuntimeSigner } from "@/lib/sui-executor";

loadLocalEnv();

const DEFAULT_TRACE_PACKAGE_ID =
  process.env.SUIMESH_TRACE_PACKAGE_ID ??
  "0xd9cdc0dad1bf458037c385656b891d29e63896945e9c9e38eb5d811ae7978257";

function readFlag(name: string) {
  return process.argv.includes(name);
}

function readOption(name: string) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value?.startsWith("--") ? undefined : value;
}

function parsedMoveFields(content: unknown) {
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    return undefined;
  }
  const record = content as Record<string, unknown>;
  if (record.dataType !== "moveObject") {
    return undefined;
  }
  const fields =
    record.fields && typeof record.fields === "object" && !Array.isArray(record.fields)
      ? (record.fields as Record<string, unknown>)
      : undefined;
  return fields;
}

async function createTraceRegistry(packageId: string) {
  const signer = getSuiRuntimeSigner();
  const client = getSuiRuntimeClient();
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::trace::create_shared_registry`,
  });
  const result = await client.signAndExecuteTransaction({
    signer: signer.keypair,
    transaction: tx,
    options: {
      showEffects: true,
      showObjectChanges: true,
    },
  });
  await client.waitForTransaction({ digest: result.digest });
  const registry = result.objectChanges?.find(
    (change) =>
      change.type === "created" &&
      change.objectType === `${packageId}::trace::Registry` &&
      typeof change.owner === "object" &&
      change.owner !== null &&
      "Shared" in change.owner
  );
  if (!registry || registry.type !== "created") {
    throw new Error(
      `Trace registry object was not found in objectChanges: ${JSON.stringify(
        result.objectChanges
      )}`
    );
  }
  return {
    registryId: registry.objectId,
    txDigest: result.digest,
  };
}

async function inspectRegistry(packageId: string, registryId: string) {
  const signer = getSuiRuntimeSigner();
  const client = getSuiRuntimeClient();
  const expectedType = `${packageId}::trace::Registry`;
  const response = await client.getObject({
    id: registryId,
    options: {
      showContent: true,
      showOwner: true,
      showType: true,
    },
  });
  if (response.error) {
    throw new Error(`Trace registry read failed: ${response.error.code}`);
  }
  const owner = parsedMoveFields(response.data?.content)?.owner;
  const ownerAddress = typeof owner === "string" ? owner : undefined;
  const actualType = response.data?.type ?? undefined;
  const writable =
    actualType === expectedType &&
    ownerAddress?.toLowerCase() === signer.address.toLowerCase();

  return {
    expectedType,
    actualType,
    ownerAddress,
    runtimeSigner: signer.address,
    writable,
  };
}

const packageId = readOption("--package") ?? DEFAULT_TRACE_PACKAGE_ID;
const existingRegistryId =
  readOption("--registry") ?? process.env.SUIMESH_TRACE_REGISTRY_ID?.trim();
const shouldCreate = readFlag("--create");

let registryId = existingRegistryId;
let createdDigest: string | undefined;

if (!registryId) {
  if (!shouldCreate) {
    throw new Error(
      "Missing SUIMESH_TRACE_REGISTRY_ID. Re-run with --create to create a MeshAction-owned shared registry."
    );
  }
  const created = await createTraceRegistry(packageId);
  registryId = created.registryId;
  createdDigest = created.txDigest;
}

if (!registryId) {
  throw new Error("Trace registry bootstrap failed to resolve a registry id.");
}

const inspection = await inspectRegistry(packageId, registryId);
const output = {
  packageId,
  registryId,
  createdDigest,
  ...inspection,
  exports: {
    SUIMESH_TRACE_PACKAGE_ID: packageId,
    SUIMESH_TRACE_REGISTRY_ID: registryId,
    SUIMESH_SUI_ADDRESS: inspection.runtimeSigner,
  },
};

console.log(JSON.stringify(output, null, 2));
console.log("");
console.log(`export SUIMESH_TRACE_PACKAGE_ID=${packageId}`);
console.log(`export SUIMESH_TRACE_REGISTRY_ID=${registryId}`);
console.log(`export SUIMESH_SUI_ADDRESS=${inspection.runtimeSigner}`);

if (!inspection.writable) {
  throw new Error(
    `Configured trace registry is not writable by runtime signer ${inspection.runtimeSigner}.`
  );
}
