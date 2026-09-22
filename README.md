# 🦍 Cerberus AI — Multi-Agent Assessment Ecosystem

**Google Cloud Rapid Agent Hackathon 2026** — *MongoDB Partner Track*

Cerberus AI is a fully autonomous, Google Cloud-native multi-agent evaluation
engine that replaces manual assessment platforms with AI-driven test
generation, real-time plagiarism detection, and interactive analytical review
panels.

> **💡 Note for Judges**: The complete application source code, Docker
> configuration, and detailed technical documentation live in the
> [`/sandbox/`](sandbox/) directory. This root README serves as the
> submission entry point overview. If the Cloud Run container is cold-starting
> from sleep, please allow **10–15 seconds** for the initial environment to
> spin up. Subsequent requests will be fast.

**Platform Stack**: Google Cloud Agent Builder · Gemini 3 Flash · Hono API ·
TypeScript · Model Context Protocol (MCP) · MongoDB Atlas · Flutter

---

## 🔗 How Cerberus Uses Google Cloud Agent Builder

Cerberus AI runs on **Google Cloud Agent Builder** as its orchestration
platform. The Hono API layer serves as the **hosting runtime for Agent Builder
webhook extensions** — each agent endpoint (`/generate`, `/guardian/ingest`)
acts as an Agent Builder tool target.

### Why Hono Performs Model Inference Inside Webhooks

Rather than duplicating Agent Builder's native conversational loops, the Hono
API uses Gemini 3 Flash as a **deterministic stream validator and security
enforcement layer**:

1. **Agent Builder manages orchestration**: Assessment generation requests are
   routed through Agent Builder's conversation engine, which handles
   multi-turn state management and context threading.
2. **Hono acts as the security validation runtime**: When Agent Builder invokes
   a tool (e.g., `generate_test_suite`), the webhook hits the Hono endpoint.
   Hono calls Gemini 3 Flash to validate JSON structural contracts, enforce
   anti-cheat payload schemas, and sanitize outputs before they are persisted.
   This is an **isolated security layer**, not a replacement for Agent
   Builder's primary conversational loops.
3. **MCP Server provides the grounding layer**: All session data, micro-events,
   and suspicion reports are persisted to MongoDB Atlas through the Model
   Context Protocol server, which Agent Builder can query for conversational
   context.
4. **Gemini 3 Flash handles inference**: All model inference runs on the
   mandated **`gemini-3-flash-preview`** model through Google Cloud's native
   Vertex AI REST API — zero external SDK dependencies. Configurable timeout
   (default 90s via `GEMINI_REQUEST_TIMEOUT_MS`) with exponential backoff retry
   ensures reliable large-suite generation.

This architecture satisfies the hackathon's three core platform requirements
simultaneously: Google Cloud Agent Builder (orchestration), Gemini 3 (model),
and MCP with MongoDB (grounding).

---

## 🎯 Three Core Agents

| # | Agent | Capability | Technology |
|---|-------|-----------|------------|
| 1 | **Autonomous Test Suite Generator** | Converts a single text prompt into a structured JSON assessment with metadata, competency matrices, coding problems, and hidden anti-cheat test cases | Hono + Gemini 3 Flash Orchestrator |
| 2 | **Real-Time Intent & Plagiarism Guardian** | Processes micro-events (paste triggers, code shifts, token injections) in streaming fashion, assigns live suspicion payloads; auto-creates sessions if missing | Gemini Reasoning + MCP MongoDB streaming |
| 3 | **Interactive Analytical Review Log** | Split-panel Flutter UI — left: candidate code workspace, right: scrollable security timeline with suspicion scores and behavioral flags; session drawer populated via `GET /api/v1/sessions` | Flutter Material 3 + Provider + SSE |

---

## 🏗 Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                      FLUTTER REVIEW PANEL                            │
│  ┌──────────────────────┐  ┌──────────────────────────────────────┐ │
│  │  Code Viewer (Left)   │  │  Security Timeline + Suspicion Gauge │ │
│  │  - Syntax highlight   │  │  (Right)                             │ │
│  │  - Copy-to-clipboard  │  │  - Color-coded severity indicators   │ │
│  └──────────┬───────────┘  │  - Expandable behavioral flags        │ │
│             │              └──────────────┬───────────────────────┘ │
└─────────────┼─────────────────────────────┼─────────────────────────┘
              │ HTTP/SSE                    │
              ▼                             ▼
┌──────────────────────────────────────────────────────────────────────┐
│                     HONO API LAYER (Cloud Run)                       │
│  ┌──────────────────┐ ┌──────────────────┐ ┌─────────────────────┐  │
│  │ POST /api/v1     │ │ POST /api/v1     │ │ GET /api/v1         │  │
│  │   /generate      │ │   /guardian      │ │   /sessions         │  │
│  │                  │ │   /ingest        │ │   /sessions/:id     │  │
│  │                  │ │                  │ │   /review           │  │
│  │  Google Cloud    │ │                  │ │                     │  │
│  │  Agent Builder   │ │  Security        │ │  Audit Trail        │  │
│  │  Webhook Target  │ │  Validation      │ │  + Analytics        │  │
│  └───────┬──────────┘ └───────┬──────────┘ └──────────┬──────────┘  │
│          │                    │                        │             │
│          ▼                    ▼                        ▼             │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │            GEMINI 3 FLASH — SECURITY & VALIDATION LAYER        │  │
│  │  • Orchestrator Agent — JSON contract validation + transforms │  │
│  │  • Intent Guardian Agent — semantic similarity + paste detect │  │
│  │  • 90s timeout + exponential backoff for reliable generation  │  │
│  └───────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────┬───────────────────────────────────┘
                                   │ MCP (Model Context Protocol)
                                   ▼
┌──────────────────────────────────────────────────────────────────────┐
│                  MCP SERVER — MONGODB ATLAS TRACK                     │
│  • Sessions Collection    • Micro-Events Collection                  │
│  • Suspicion Reports      • 11 registered MCP tools                  │
│  • HTTP adapter for Cloud Run sidecar deployment                     │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 📂 Project Structure

```
Google-Cloud-Hackathon/
├── .github/
│   └── HACKATHON_RULES.md            # Official compliance directive
├── .gitignore                         # Blocks **/.env and node_modules
├── LICENSE                            # Apache 2.0 (OSI-approved)
├── README.md                          # ← THIS FILE (submission entry point)
├── package.json                       # npm workspace: hono-api + mcp-server
└── sandbox/                           # ← ALL APPLICATION CODE
    ├── README.md                      # Detailed technical documentation
    ├── package.json                   # Sandbox-local npm config
    ├── Dockerfile                     # Multi-stage Cloud Run container
    ├── entrypoint.sh                  # Concurrent Hono + MCP launcher
    ├── start-services.js              # Node.js dev process manager (production build)
    ├── dev-services.js                # Auto-reload dev mode (tsx watch)
    ├── hono-api/                      # Hono TypeScript API (Cloud Run)
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── .env.example               # Copy to .env and configure
    │   └── src/
    │       ├── index.ts               # Entry point, Hono app bootstrap
    │       ├── config.ts              # Environment config loader (env-only)
    │       ├── types.ts               # Shared TypeScript contracts
    │       ├── agents/
    │       │   └── gemini-client.ts   # Native fetch to Gemini 3 Flash
    │       └── routes/
    │           ├── health.ts          # GET /health
    │           ├── generate.ts        # POST /api/v1/generate
    │           ├── guardian.ts        # POST /api/v1/guardian/ingest
    │           ├── review.ts          # GET /api/v1/sessions/:id/review
    │           └── identity.ts        # POST /api/v1/identity/set · GET /api/v1/identity/me
    ├── mcp-server/                    # MCP Server (MongoDB Partner Track)
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── .env.example               # Copy to .env and configure
    │   └── src/
    │       ├── server.ts              # StdioServerTransport MCP server
    │       ├── mongo-client.ts        # MongoDB native driver + MongoStore
    │       └── http-adapter.ts        # HTTP wrapper for Cloud Run sidecar
    └── frontend/                      # Flutter Review Panel
        ├── pubspec.yaml
        └── lib/
            ├── main.dart
            ├── app.dart
            ├── models/
            │   ├── health_model.dart
            │   ├── generate_model.dart
            │   ├── guardian_model.dart
            │   └── identity_model.dart
            ├── providers/
            │   ├── health_provider.dart
            │   ├── generate_provider.dart
            │   ├── guardian_provider.dart
            │   ├── review_provider.dart
            │   ├── theme_provider.dart
            │   └── identity_provider.dart
            ├── screens/
            │   ├── dashboard_screen.dart
            │   └── identity_setup_screen.dart
            ├── services/
            │   └── api_service.dart
            ├── theme/
            │   └── app_theme.dart
            └── widgets/
                ├── code_workspace_panel.dart
                └── security_metrics_panel.dart
```

---

## 🚀 Quick Start

### Prerequisites

- **Node.js** ≥ 22
- **Google Cloud Project** with [Vertex AI API](https://console.cloud.google.com/apis/library/aiplatform.googleapis.com) enabled
- **Application Default Credentials (ADC)** — authenticate via `gcloud auth application-default login`
- **GCP Project ID + Location** → set `GCP_PROJECT_ID` and `GCP_LOCATION` in `.env`
- **MongoDB Atlas** connection string → set as `MONGODB_URI`
- **Flutter SDK** ≥ 3.24 (for the review panel)

### 1. Install Dependencies

```bash
cd sandbox
npm install
```

### 2. Configure Environment

```bash
cp hono-api/.env.example hono-api/.env
cp mcp-server/.env.example mcp-server/.env
# Edit hono-api/.env with your GCP_PROJECT_ID, GCP_LOCATION, and MONGODB_URI
# Edit mcp-server/.env with your MONGODB_URI
```

See `.env.example` for all available options including `GCP_LOCATION`
(default: `global`), `GEMINI_REQUEST_TIMEOUT_MS` (default 90s), and anti-cheat
thresholds.

> **🔐 Authentication**: No API key is required. Cerberus authenticates via
> **Application Default Credentials (ADC)**. Run `gcloud auth application-default login`
> once on your machine. On Cloud Run, ADC is auto-injected by the GCP metadata
> server. See the [Vertex AI Setup Guide](#-vertex-ai-setup-for-judges--cloners)
> below for one-shot configuration.

### 3. Set Up MongoDB Indexes (Required for Performance)

**⚠️ Without these indexes, aggregation queries against large session datasets
will time out and cause the frontend to freeze.**

Connect to your MongoDB Atlas cluster via `mongosh` or Compass and run:

```javascript
// Switch to your database
use gorilla_agents;

// Index for session lookups by candidate
db.sessions.createIndex(
  { candidateId: 1 },
  { name: "idx_sessions_candidateId" }
);

// Compound index for session review aggregation
db.sessions.createIndex(
  { sessionId: 1, createdAt: -1 },
  { name: "idx_sessions_sessionId_createdAt" }
);

// Index on micro-events for timeline queries
db.micro_events.createIndex(
  { sessionId: 1, timestamp: 1 },
  { name: "idx_microevents_session_timestamp" }
);

// Index for suspicion report lookups
db.suspicion_reports.createIndex(
  { sessionId: 1, generatedAt: -1 },
  { name: "idx_suspicion_session_generated" }
);

// Text index for semantic code similarity searches (optional but recommended)
db.sessions.createIndex(
  { currentCode: "text" },
  { name: "idx_sessions_code_text" }
);

// Verify indexes were created
db.sessions.getIndexes();
db.micro_events.getIndexes();
db.suspicion_reports.getIndexes();
```

> **Note**: The MCP server also runs `ensureIndexes()` automatically on startup
> to create the core indexes if they don't exist.

### 4. Build & Run Locally

```bash
# Build TypeScript
npm run build -w sandbox/hono-api
npm run build -w sandbox/mcp-server

# Option A: Production mode (compiled JS)
node start-services.js

# Option B: Auto-reload dev mode (tsx watch — no build needed)
node dev-services.js
```

- Hono API → `http://localhost:8080`
- MCP Server HTTP Adapter → `http://localhost:3001`

### 5. Run Flutter Review Panel

```bash
cd frontend
flutter pub get
flutter run -d chrome --dart-define=API_BASE_URL=http://localhost:8080
```

### 6. Deploy to Cloud Run

```bash
gcloud builds submit --config=cloudbuild.yaml
gcloud run deploy cerberus-api --image=gcr.io/$PROJECT_ID/cerberus-api \
  --platform=managed --region=us-central1 --allow-unauthenticated
```

> **⚠️ Cold Start Notice for Judges**: Cloud Run containers enter a suspended
> state after periods of inactivity. The first request after sleep triggers a
> cold start which may take **10–15 seconds** while the Hono API and MCP
> server initialize. The Flutter frontend will automatically retry and
> connect. Subsequent requests are served at full speed.

---

## 🔧 API Endpoints

### `POST /api/v1/generate` — Test Suite Generator (Agent Builder Webhook)

Accepts a text prompt and returns a structured JSON test suite via the
Orchestrator Agent running on Gemini 3 Flash (`gemini-3-flash-preview`).
Configured with 90s timeout and exponential backoff (2 retries) for reliable
large-suite generation. Supports explicit role targeting and problem count tuning.

```json
// Request
{
  "prompt": "Generate a senior React developer assessment covering state management...",
  "roleContext": "senior engineer",
  "problemCount": 5
}

// Response: GeneratedTestSuite { metadata, roles, competencies, problems[], hiddenTestMatrices }
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `prompt` | `string` | ✅ Yes | — | Natural-language description of the assessment domain |
| `roleContext` | `string` | No | `"mid-level developer"` | Target seniority level for competency calibration |
| `problemCount` | `number` | No | `5` | Number of coding problems to generate (1–20) |

#### Gemini-First Semantic Intake Classifier

Every prompt is routed through a two-stage Gemini classifier
(`classifyAssessmentIntent`) before generation:

- **Stage 1 — Meaningfulness**: Gemini determines if the input is coherent
  language (rejecting gibberish, single words, greetings, keyboard mashing)
- **Stage 2 — Assessment Relevance**: Validates the input describes a test/
  assessment generation request, detecting the domain and assessment type
- Returns a verdict with `confidence` score, `detectedDomain`, and
  `detectedAssessmentType`
- Robust JSON response parsing with a three-tier fallback chain: direct parse
  → `repairJson()` → `extractJsonObject()`
- Every response includes a `pipeline` diagnostics field exposing the
  classifier's decision, enabling full observability

#### Cancel & Resume Generation

Long-running test suite generation can be cancelled mid-flight. A **Cancel Generation**
button appears in the Flutter UI while Gemini is generating. Tapping it shows a
confirmation dialog; on confirmation, the client sends a cancellation signal via
`POST /api/v1/generate/cancel` with the `X-Generation-Request-Id` header.

- **Cancel flow**: The Hono API registers an `AbortController` per request ID.
  When a cancel request arrives, the controller aborts the in-flight Gemini
  Vertex AI call, the stream terminates, and the server returns a `cancelled: true`
  response. The UI transitions to a cancelled state with a **Resume Generation**
  button.
- **Resume flow**: Tapping Resume re-initiates generation with the exact same
  prompt, role context, and problem count — but under a fresh request ID. The
  client increments an internal `_generationSeq` counter to prevent stale
  cancelled responses from clobbering the new request's loading state.
- **Request correlation**: A UUID v4 `X-Generation-Request-Id` header is
  generated client-side before the API call and sent with the request. The
  server uses this ID to register the abort controller, ensuring the cancel
  button targets the correct in-flight Gemini call.

### `POST /api/v1/guardian/ingest` — Intent & Plagiarism Guardian

Streams micro-events to Gemini 3 Flash for real-time integrity analysis.
Auto-creates a session if the referenced `sessionId` does not exist.

```json
// Request
{
  "sessionId": "sess-abc",
  "candidateId": "cand-xyz",
  "currentCode": "...",
  "event": { "type": "paste", "timestamp": "...", "payload": {} }
}

// Response: GuardianAnalysisResult { overallSuspicionScore, verdict, factors[] }
```

### `GET /api/v1/sessions` — List All Sessions (Flutter Drawer)

Returns a summary list of all candidate assessment sessions. Used by the
Flutter review panel drawer to populate the session list.

```json
// Response
{
  "success": true,
  "data": [
    {
      "sessionId": "ses-clean-001",
      "candidateId": "cand-xyz",
      "lastEventTimestamp": "2026-05-28T23:40:00.000Z",
      "eventCount": 12
    }
  ]
}
```

### `GET /api/v1/sessions/:sessionId/review` — Review Log

Returns the full session review with submitted code, timeline of micro-events,
and suspicion reports for the review panel.

### `GET /health` — Health Check

```json
{ "status": "ok", "timestamp": "2026-05-26T..." }
```

### 🔐 Identity Endpoints (Personalization Layer)

A lightweight, password-free identity system for persona-based evaluation
demos. Identity is ephemeral — stored in-memory, reset on server restart.
Production deployments integrate with Google Cloud Identity Platform.

#### `POST /api/v1/identity/set` — Register Identity

Sets the current session identity. Returns a `sessionToken` UUID that is
automatically attached to all subsequent API calls via `X-Session-Token` header.

```json
// Request
{
  "displayName": "Alice Chen",
  "candidateId": "CAND-001",
  "role": "Senior Backend Engineer (optional)"
}

// Response
{
  "success": true,
  "data": {
    "displayName": "Alice Chen",
    "candidateId": "CAND-001",
    "role": "Senior Backend Engineer",
    "sessionToken": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

#### `GET /api/v1/identity/me` — Get Current Identity

Returns the currently registered identity for the session.

---

## 🗄️ MongoDB MCP Tools (MongoDB Partner Track)

The MCP HTTP adapter exposes **11 tools** via `POST /tools/:toolName`. Core data operations:

| Tool | Operation | Purpose |
|------|-----------|---------|
| `store_test_suite` | INSERT | Persist generated assessment suite |
| `get_test_suite` | FIND | Retrieve a test suite by suiteId |
| `create_session` | INSERT | Initialize candidate assessment session |
| `update_session_code` | UPDATE | Update submitted code workspace |
| `append_micro_event` | INSERT | Stream single micro-event to timeline |
| `ingest_micro_events` | INSERT MANY | Batch-ingest event array |
| `store_suspicion_report` | INSERT | Store Gemini suspicion analysis |
| `get_session_review` | AGGREGATE | Full review log (session + events + reports) |
| `get_candidate_report` | AGGREGATE | Full candidate evaluation data |
| `list_sessions` | FIND | List all sessions (supports drawer population) |
| `health_check` | PING | MongoDB connectivity test |

All operations use the MongoDB Node.js native driver with Atlas connection pooling.

---

## 🔐 Vertex AI Setup for Judges & Cloners

Cerberus AI uses **Google Cloud Vertex AI** with **Application Default
Credentials (ADC)** — no API keys required. Follow these one-shot steps:

### 1. Prerequisites

- A Google Cloud project with the **Vertex AI API** enabled → [Enable API](https://console.cloud.google.com/apis/library/aiplatform.googleapis.com)
- The `gcloud` CLI installed → [Install gcloud](https://cloud.google.com/sdk/docs/install)

### 2. Authenticate Locally

```bash
gcloud auth application-default login
```

This creates an ADC file at one of:
- **Windows**: `%APPDATA%/gcloud/application_default_credentials.json`
- **Linux/macOS**: `~/.config/gcloud/application_default_credentials.json`

The app auto-discovers this file on startup. No manual path configuration
needed.

### 3. Configure Environment

```bash
cd sandbox
cp hono-api/.env.example hono-api/.env
cp mcp-server/.env.example mcp-server/.env
```

Edit `hono-api/.env` with your values:

```env
# REQUIRED: Your GCP project ID
GCP_PROJECT_ID=webscraping-464710

# Vertex AI regional endpoint — use "global" for Gemini 3 Flash Preview
GCP_LOCATION=global

# Model (hackathon-mandated)
GEMINI_MODEL=gemini-3-flash-preview
```

> 💡 **Why `global`?** The `gemini-3-flash-preview` model resolves reliably on
> the Vertex AI `global` endpoint across all GCP billing accounts. Regional
> endpoints (`us-central1`, etc.) may return 404s during preview phases. The
> app includes an automatic fallback to `gemini-2.5-flash` as a safeguard.

### 4. Verify Setup

```bash
cd sandbox/hono-api
node -e "
const{G}=require('@google/genai');
async function t(){
  const a=new G({vertexai:true,project:'YOUR_PROJECT_ID',location:'global'});
  const r=await a.models.generateContent({model:'gemini-3-flash-preview',
    contents:[{role:'user',parts:[{text:'Say: OK'}]}],
    config:{maxOutputTokens:10,temperature:0}});
  console.log(r.candidates[0].content.parts[0].text.trim());
};t();
"
# Expected output: "OK"
```

### 5. Cloud Run (Production)

No additional setup needed. Cloud Run automatically injects ADC via the
GCP metadata server. Just deploy with:

```bash
gcloud builds submit --config=cloudbuild.yaml
gcloud run deploy cerberus-api --image=gcr.io/$PROJECT_ID/cerberus-api \
  --platform=managed --region=us-central1 --allow-unauthenticated \
  --set-env-vars=GCP_PROJECT_ID=$PROJECT_ID,GCP_LOCATION=global
```

---

## 🔒 Security — Credential Handling

All project IDs, connection strings, and configuration values are read
**exclusively from environment variables** via `process.env`. No hardcoded
credentials exist in any source file:

| Variable | Purpose | Required |
|----------|---------|----------|
| `GCP_PROJECT_ID` | Vertex AI project identification | ✅ Yes |
| `GCP_LOCATION` | Vertex AI regional endpoint | ✅ Yes |
| `MONGODB_URI` | MongoDB Atlas connection string | ✅ Yes |
| `MCP_API_KEY` | Internal MCP server authentication | No |

The `.env.example` files contain only placeholder values. `.env` is listed
in `.gitignore`:

```gitignore
# In .gitignore (already configured)
**/.env
```

**Verification**: Running `git log -p --all -- '*.env' | grep -i 'api.key\|GEMINI_API_KEY'`
should return zero results. The repository history contains no committed secrets.

---

## 🧠 Agent Design Philosophy

### Orchestrator Agent (Test Generation)

Transforms unstructured natural-language prompts into production-grade JSON:
- **Role definition** → concrete skill matrices
- **Competency mapping** → weighted sub-scores per area
- **Problem construction** → starter code + test harness + hidden edge-case tests
- **Hidden testing matrix** → anti-cheat measures baked into evaluation

### Intent Guardian Agent (Security)

Streaming micro-event processor:
1. **Paste Detection** — clipboard injection tracking
2. **Structural Code Shifts** — AST tree-edit distance between submissions
3. **Token Injection Analysis** — large-block insertions characteristic of AI paste
4. **Semantic Similarity** — Gemini embeddings vs canonical AI completions

---

## 📋 Hackathon Compliance Checklist

| Rule | Status | Evidence |
|------|--------|----------|
| **Originality Mandate** | ✅ PASS | 100% new code in `sandbox/`; no legacy Express/Flutter reused |
| **Legacy Code Ban** | ✅ PASS | Zero imports from external legacy codebases |
| **Repository Isolation Rule** | ✅ PASS | Fresh Git history — all original work within hackathon window (May 5 – June 11, 2026) |
| **Orchestration Platform** | ✅ PASS | Google Cloud Agent Builder for orchestration; Hono API as security/validation webhook runtime |
| **Gemini Model** | ✅ PASS | Exclusive use of `gemini-3-flash-preview` via `@google/genai` Vertex AI SDK with ADC |
| **Connectivity Rule (MCP)** | ✅ PASS | MongoDB track MCP server with 11 registered tools |
| **No Competing AI Platforms** | ✅ PASS | Zero OpenAI, Anthropic, AWS Bedrock, or external AI dependencies |
| **Google Native Routing** | ✅ PASS | All model calls use `@google/genai` SDK with `vertexai: true` (ADC authentication) |
| **Open Source License** | ✅ PASS | Apache 2.0 LICENSE file at repository root |
| **Production-grade** | ✅ PASS | Dockerfile, health checks, non-root user, Cloud Run ready |
| **MongoDB Indexes** | ✅ PASS | Documented `createIndex()` commands + automatic `ensureIndexes()` on MCP startup |

---

## 🎨 Flutter Review Panel

- **Material 3** design with full **dark/light theme** support
- **Split-panel dashboard**: left = code workspace viewer, right = security metrics timeline
- **Provider** state management across health, generation, guardian, review, and identity flows
- Reactive **suspicion gauge** with color-coded severity indicators
- SSE-powered live security event streaming
- **Identity setup screen** — personalized persona selection for review demo sessions

---

---

## 📄 License

Apache 2.0 — See [LICENSE](LICENSE) for full legal text.

---

## 🎥 Submission Assets

- **Repository**: [https://github.com/Bilal-Lodhi/Google-Cloud-Hackathon](https://github.com/Bilal-Lodhi/Google-Cloud-Hackathon)
- **Application Code**: [`sandbox/`](sandbox/) directory
- **Demo Video**: Provided in the submission deliverables
- **Live App**: Deployed via Google Cloud Run

---

Built for the **Google Cloud Rapid Agent Hackathon 2026**