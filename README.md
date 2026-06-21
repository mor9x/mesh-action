<p align="center">
  <img src="./public/mesh-action-logo.jpg" alt="MeshAction" width="720" />
</p>

<p align="center">
  <strong>Verifiable execution for AI actions on Sui.</strong>
</p>

<p align="center">
  MeshAction turns an agent proposal into an inspectable, policy-checked, on-chain action with an encrypted audit trail.
</p>

<p align="center">
  <a href="#why-meshaction">Why</a>
  ·
  <a href="#quickstart">Quickstart</a>
  ·
  <a href="#how-it-works">How it works</a>
  ·
  <a href="#verification">Verification</a>
</p>

---

## Why MeshAction

AI agents are useful only when their actions can be trusted. MeshAction is built for workflows where an agent can propose an action, but execution still needs inspection, policy checks, user review, and a durable receipt.

The console is designed around one principle: **agents propose, MeshAction verifies and executes**.

- Inspect the PTB before it touches the chain.
- Run deterministic policy checks before execution.
- Require explicit review for high-risk actions such as copy trading.
- Execute real Sui testnet transactions from the server-side signer.
- Archive receipt context through Walrus and Seal.
- Restore traces later for verification, debugging, or audit.

## SuiMesh Network And Registry

MeshAction can use the public SuiMesh testnet relay and the public trace package:

```bash
SUIMESH_RELAYER_URL=https://relay.suimesh.link
SUIMESH_TRACE_PACKAGE_ID=0x038caadb65def30619e6ec762715ea6ca232ac1195bc077086bc9a6b7e11bb80
```

The trace registry is different: it is a platform-owned execution ledger. The current SuiMesh trace contract only lets the registry owner call `anchor_action`, so a production MeshAction deployment must use a registry owned by the MeshAction runtime signer or by an explicitly authorized platform operator.

Check a registry before using it:

```bash
sui client object $SUIMESH_TRACE_REGISTRY_ID --json
```

The object must be `${SUIMESH_TRACE_PACKAGE_ID}::trace::Registry`, and `content.owner` must match `SUIMESH_SUI_ADDRESS`. The public test registry may be useful for protocol-owner demos, but it is not a general-purpose registry for other platforms.

## What You Can Run

MeshAction currently ships with three Sui action demos:

| Action | What it does | Guardrail |
| --- | --- | --- |
| `transfer` | Sends a small testnet SUI transfer | PTB inspection and policy check |
| `contract_call` | Calls the published `demo_action::mark_action` Move function | Contract target and argument validation |
| `copy_trade` | Mirrors a verified leader PTB into a follower PTB | Explicit execution review before submit |

The same flow can be extended to other actions where the system must separate proposal, review, execution, and audit.

## Product Surface

The app is a workflow console, not a transaction form. A session keeps the full action lifecycle visible:

- Chat for intent, proposal, and execution feedback.
- Workflow graph for each trace step.
- Inspector panel for the selected node.
- BYO agent registry with signed registration.
- Runtime status for Sui, archive, and model configuration.

Sessions are created only when work starts. Verified BYO agents are never selected silently; the user chooses them per action.

## Quickstart

Install dependencies:

```bash
bun install
```

Create an environment file:

```bash
cp .env.example .env.local
```

MeshAction now consumes the published `suimesh` package directly from npm. To upgrade the SDK, use your package manager normally:

```bash
bun add suimesh@latest
```

MeshAction now treats Bun as the canonical package manager locally and on Vercel. If you also keep a sibling `../suimesh` checkout, `bun install` can materialize `node_modules/suimesh` as a symlinked local package that Turbopack rejects. MeshAction runs a preflight repair step before `dev`, `build`, `start`, and `test` to replace that install with the published npm package automatically.

The project does not force the Bun runtime for `next build` or `next start`. Bun is used for installation and script orchestration, while Next still runs through its stable CLI path because the current Sui dependencies are not fully compatible with `bun run --bun next build`.

Set the required runtime values:

```bash
DATABASE_URL=postgresql://admin:admin@127.0.0.1:5432/admin
SUIMESH_SUI_NETWORK=testnet
SUIMESH_PROTOCOL_MODE=canonical
SUIMESH_RELAYER_URL=https://relay.suimesh.link
SUIMESH_TRACE_PACKAGE_ID=0x038caadb65def30619e6ec762715ea6ca232ac1195bc077086bc9a6b7e11bb80
SUIMESH_TRACE_REGISTRY_ID=0x_YOUR_MESHACTION_TRACE_REGISTRY_ID
SUIMESH_SUI_PRIVATE_KEY=suiprivkey...
SUIMESH_SUI_ADDRESS=0x...
```

Apply database migrations:

```bash
bun run db:migrate
```

Bootstrap a MeshAction-owned trace registry if you do not already have one:

```bash
bun run bootstrap:trace-registry -- --create
```

Start the console:

```bash
bun run dev
```

Run the standard checks:

```bash
bun run deploy:check
bun run lint
bun run build
```

`bun run db:migrate`, `bun run bootstrap:trace-registry`, `bun run deploy:check`, and `bun run smoke:e2e` automatically read `.env.local` and `.env` when those files exist. Explicit shell environment variables still win.

## Configuration

### Sui Signer

Execution uses a server-side Sui signer. Use a Sui bech32 private key when possible:

```bash
SUIMESH_SUI_PRIVATE_KEY=suiprivkey...
SUIMESH_SUI_ADDRESS=0x...
```

A Sui CLI keystore entry is also supported for local compatibility:

```bash
SUIMESH_SUI_KEYSTORE_ENTRY=<base64 Sui CLI keystore entry>
```

Do not commit `.env.local`, `.sui/`, `.sui-home/`, private keys, keystores, generated Move build output, or local SDK aliases. These are ignored by default.

### SuiMesh Relay And Trace Registry

Use the public relay and trace package for live testnet runs:

```bash
SUIMESH_PROTOCOL_MODE=canonical
SUIMESH_RELAYER_URL=https://relay.suimesh.link
SUIMESH_TRACE_PACKAGE_ID=0x038caadb65def30619e6ec762715ea6ca232ac1195bc077086bc9a6b7e11bb80
SUIMESH_TRACE_REGISTRY_ID=0x_YOUR_MESHACTION_TRACE_REGISTRY_ID
```

`SUIMESH_TRACE_REGISTRY_ID` must point at a MeshAction-owned registry. `/runtime/status` reads the Sui object over RPC and reports `protocol.ok=false` if the registry type is wrong or `content.owner` does not match the runtime signer. This avoids reaching the chain only to fail with `E_UNAUTHORIZED_OWNER` during `anchor_action`.

Create or provision the registry during platform bootstrap, then keep the registry ID and the owner signer in your deployment secrets. Postgres remains only an index/cache; the protocol truth is the SuiMesh relay, Sui trace registry, Walrus, and Seal.

### Hosted Agents

Hosted proposal and audit agents are optional. When enabled, MeshAction can call an OpenAI-compatible chat completions endpoint for proposal generation, while the execution path remains deterministic.

```bash
MESHACTION_LLM_AGENTS=true
MESHACTION_LLM_API_KEY=<provider api key>
MESHACTION_LLM_MODEL=gpt-4.1-mini
MESHACTION_LLM_BASE_URL=https://api.openai.com/v1
```

Compatibility aliases are accepted: `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_BASE_URL`, `SUIMESH_LLM_*`, and `SUIMESH_OPENAI_*`.

If your network requires a proxy, configure the standard `HTTPS_PROXY`, `HTTP_PROXY`, or `ALL_PROXY` environment variables before running the app or tests.

If `MESHACTION_LLM_AGENTS` is unset or false, hosted proposal and audit agents stay available in deterministic mode. `/runtime/status` and the console inspector expose whether the app is using a real LLM provider or deterministic fallback.

### API Throttling

Wallet sign-in and public BYO registration routes have conservative rate limits enabled by default:

```bash
MESHACTION_AUTH_CHALLENGE_LIMIT=5
MESHACTION_AUTH_CHALLENGE_WINDOW_MS=300000
MESHACTION_AUTH_SESSION_LIMIT=10
MESHACTION_AUTH_SESSION_WINDOW_MS=300000
MESHACTION_AGENT_REGISTRATION_LIMIT=8
MESHACTION_AGENT_REGISTRATION_WINDOW_MS=600000
```

Tune them per deployment if you expect heavier traffic or stricter abuse controls.

### Walrus And Seal

Walrus and Seal are used for encrypted archive references:

```bash
SUIMESH_WALRUS_PUBLISHER_URL=https://publisher.walrus-testnet.walrus.space
SUIMESH_WALRUS_AGGREGATOR_URL=https://aggregator.walrus-testnet.walrus.space
SUIMESH_WALRUS_EPOCHS=5
SUIMESH_SEAL_PACKAGE_ID=0xdeb6325f80800c0f58d99d28b06a65f4b02adccc3275bd375e144e000bfc6bdd
```

Local archive fallbacks exist for development, but they are not the verification path:

```bash
SUIMESH_WALRUS_DISABLED=true
SUIMESH_SEAL_MODE=local
SUIMESH_LOCAL_ARCHIVE_KEY=<local secret>
```

## How It Works

```text
Intent
  -> Proposal
  -> PTB inspection
  -> Policy evaluation
  -> Claim
  -> User review
  -> Sui execution
  -> Walrus / Seal archive
  -> Trace restore
```

The app stores local session and agent-registry indexes in Postgres. Protocol events, execution receipts, archive references, and restored traces are handled through the SuiMesh SDK. In canonical mode, event delivery uses SuiStack relay and trace ownership is enforced by the on-chain registry; Postgres mirrors events only for UI indexing and recovery speed.

## BYO Agents

BYO agents register with a Sui personal-message signature. Once verified, an agent can be selected for `transfer`, `contract_call`, or `copy_trade`.

Registration signs this body:

```text
MeshAction BYO Agent Registration
agent_id=<agent_id>
endpoint=<endpoint>
signing_address=<sui_address>
capabilities=<sorted comma list>
semantic_types=<sorted comma list>
signed_at_ms=<unix ms>
```

Production BYO endpoints must use HTTPS and must not resolve to loopback or private network addresses. Local HTTP endpoints are available only when explicitly enabled:

```bash
SUIMESH_ALLOW_INSECURE_BYO_HTTP=true
SUIMESH_ALLOW_LOCAL_BYO_ENDPOINTS=true
```

The end-to-end smoke flow spins up a loopback BYO agent on `127.0.0.1`, so these two flags must be enabled on the MeshAction server for local smoke runs.

## API

| Method | Route |
| --- | --- |
| `GET` | `/agents` |
| `POST` | `/agents/register` |
| `POST` | `/agents/:id/disable` |
| `GET` | `/runtime/status` |
| `GET` | `/sessions` |
| `POST` | `/sessions` |
| `POST` | `/sessions/:id/messages` |
| `GET` | `/sessions/:id/graph` |
| `GET` | `/traces/:id` |
| `POST` | `/traces/:id/propose` |
| `POST` | `/traces/:id/evaluate` |
| `POST` | `/traces/:id/execute` |
| `POST` | `/traces/:id/archive` |

## Verification

The MeshAction smoke test has been run against the public test relay, the public trace package, and a registry whose owner signer was configured as the MeshAction runtime signer:

```bash
DATABASE_URL=postgresql://admin:admin@127.0.0.1:5432/admin \
MESHACTION_SMOKE_BASE_URL=http://localhost:3024 \
MESHACTION_SMOKE_BYO_PORT=4024 \
SUIMESH_SUI_NETWORK=testnet \
SUIMESH_PROTOCOL_MODE=canonical \
SUIMESH_RELAYER_URL=https://relay.suimesh.link \
SUIMESH_TRACE_PACKAGE_ID=0x038caadb65def30619e6ec762715ea6ca232ac1195bc077086bc9a6b7e11bb80 \
SUIMESH_TRACE_REGISTRY_ID=0x_YOUR_MESHACTION_TRACE_REGISTRY_ID \
SUIMESH_ALLOW_INSECURE_BYO_HTTP=true \
SUIMESH_ALLOW_LOCAL_BYO_ENDPOINTS=true \
bun run smoke:e2e
```

Covered path:

- Wallet sign-in challenge.
- Signed BYO agent registration and BYO request verification.
- Transfer, contract call, and copy-trade PTB proposal paths.
- Remote SuiStack relay event delivery with local Postgres mirroring.
- Sui devInspect, policy approval, on-chain anchor, claim, execute, receipt, and audit.
- Walrus archive write/read verification.
- Trace restore and verification.

Recent testnet execution digests:

```text
transfer: 4RidUhnnV6i4UdFtaXCLCpC6YXqSAd67B9mdBknK49Ru
contract_call: 3F7PhZKAxafbe5qW6t31wmdJ2wFdJhGqvr4Hap3pTMB4
copy_trade: aHct6R8zbN7oimrb9oapodGn5j6LfV1r2zBjGLUydkm
```

## Demo Move Package

Published testnet package:

```text
0xdeb6325f80800c0f58d99d28b06a65f4b02adccc3275bd375e144e000bfc6bdd
```

Build locally:

```bash
sui move build --path contracts/demo_move_call
```

## Repository

```text
src/app                 Next.js routes and API handlers
src/components/console  Console UI and workflow graph
src/components/ui       Local UI primitives
src/lib                 SuiMesh, Sui, auth, storage, and agent runtime code
scripts                 Smoke test entrypoints
contracts               Demo Move package
docs/concepts           Product and design references
```
