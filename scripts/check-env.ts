import { loadLocalEnv } from "./load-env";

loadLocalEnv();

type Check = {
  key: string;
  required: boolean;
  ok: boolean;
  note?: string;
};

function hasValue(key: string) {
  const value = process.env[key];
  return typeof value === "string" && value.trim().length > 0;
}

function pushCheck(checks: Check[], key: string, required = true, note?: string) {
  checks.push({
    key,
    required,
    ok: hasValue(key),
    note,
  });
}

const checks: Check[] = [];

pushCheck(checks, "DATABASE_URL");
pushCheck(checks, "SUIMESH_SUI_ADDRESS");
pushCheck(checks, "SUIMESH_SUI_NETWORK");
pushCheck(checks, "SUIMESH_PROTOCOL_MODE");
pushCheck(checks, "SUIMESH_RELAYER_URL");
pushCheck(checks, "SUIMESH_TRACE_PACKAGE_ID");
pushCheck(checks, "SUIMESH_TRACE_REGISTRY_ID");

checks.push({
  key: "SUIMESH_SUI_PRIVATE_KEY|SUIMESH_SUI_KEYSTORE_ENTRY",
  required: true,
  ok: hasValue("SUIMESH_SUI_PRIVATE_KEY") || hasValue("SUIMESH_SUI_KEYSTORE_ENTRY"),
  note: "set one signer source",
});

const llmEnabled = process.env.MESHACTION_LLM_AGENTS === "true";
pushCheck(
  checks,
  "MESHACTION_LLM_AGENTS",
  false,
  llmEnabled ? "enabled" : "optional"
);

if (llmEnabled) {
  pushCheck(checks, "MESHACTION_LLM_API_KEY");
  pushCheck(checks, "MESHACTION_LLM_MODEL");
  pushCheck(checks, "MESHACTION_LLM_BASE_URL", false);
}

const unsafeFlags = [
  "SUIMESH_ALLOW_INSECURE_BYO_HTTP",
  "SUIMESH_ALLOW_LOCAL_BYO_ENDPOINTS",
];
const unsafeEnabled = unsafeFlags.filter((key) => process.env[key] === "true");

const missing = checks.filter((check) => check.required && !check.ok);

for (const check of checks) {
  const status = check.ok ? "present" : check.required ? "missing" : "optional";
  const suffix = check.note ? ` (${check.note})` : "";
  console.log(`${status.padEnd(8)} ${check.key}${suffix}`);
}

if (unsafeEnabled.length > 0) {
  console.error(
    `Unsafe production flags enabled: ${unsafeEnabled.join(", ")}`
  );
}

if (missing.length > 0 || unsafeEnabled.length > 0) {
  process.exit(1);
}

console.log("Deployment environment check passed");
