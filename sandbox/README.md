# 🦍 Cerberus AI — Multi-Agent Assessment Ecosystem

**Google Cloud Rapid Agent Hackathon 2026** — *MongoDB Partner Track*

Cerberus AI replaces legacy manual assessment platforms with a fully autonomous,
Google Cloud-native multi-agent evaluation engine. Built on **Google Cloud Agent Builder**
with **Hono** as the API runtime layer, **TypeScript**, **Gemini 3 Flash**, and
**Model Context Protocol (MCP)** for the MongoDB track.

---

## 🔗 How Cerberus Uses Google Cloud Agent Builder

Cerberus AI runs on **Google Cloud Agent Builder** as its orchestration
platform. The Hono API layer serves as the **hosting runtime for Agent Builder
webhook extensions** — each agent endpoint (`/generate`, `/guardian/ingest`)
acts as an Agent Builder tool target. The flow works as follows:

1. **Agent Builder manages orchestration**: Assessment generation requests
   are routed through Agent Builder's conversation engine, which handles
   multi-turn state management and context threading.
2. **Hono acts as the tool-execution runtime**: When Agent Builder invokes a
   tool (e.g., `generate_test_suite`), the webhook hits the corresponding
   Hono endpoint, which calls Gemini 3 Flash via the `@google/genai` Vertex AI
   SDK (authenticated with Application Default Credentials) and returns
   structured JSON output. Exponential backoff with 3 retries ensures
   reliable large-suite generation.
3. **MCP Server provides the grounding layer**: All session data, micro-events,
   and suspicion reports are persisted to MongoDB Atlas through the Model
   Context Protocol server, which Agent Builder can query for conversational
   context.
4. **Gemini 3 Flash handles inference**: All model inference runs on the
   mandated `gemini-3-flash-preview` model through Google Cloud's Vertex AI
   SDK (`@google/genai` with `vertexai: true`) with ADC authentication.

This architecture satisfies the hackathon's three core platform requirements
simultaneously: Google Cloud Agent Builder (orchestration), Gemini 3 (model
via enterprise Vertex AI), and MCP with MongoDB (grounding).

---

## 🏗 Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         FLUTTER REVIEW PANEL                            │
│  ┌──────────────────────┐  ┌─────────────────────────────────────────┐ │
│  │  Code Viewer          │  │  Security Timeline + Suspicion Gauge    │ │
│  │  (Left Panel)         │  │  (Right Panel)                          │ │
│  │  - Syntax highlighting│  │  - SSE-powered live updates             │ │
│  │  - Copy-to-clipboard  │  │  - Color-coded severity indicators      │ │
│  └──────────────────────┘  │  - Expandable behavioral flags           │ │
│                             └─────────────────────────────────────────┘ │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │ HTTP/SSE
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     HONO API LAYER (Cloud Run)                          │
│  ┌─────────────────┐ ┌──────────────────┐ ┌────────────────────────┐   │
│  │ POST /generate  │ │ POST /guardian   │ │ GET /sessions          │   │
│  │  Test Suite Gen │ │  /ingest         │ │ GET /sessions/:id      │   │
│  │                 │ │                  │ │      /review           │   │
│  └───────┬─────────┘ └───────┬──────────┘ └───────────┬────────────┘   │
│          │                   │                        │                │
│          ▼                   ▼                        ▼                │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                   GEMINI AGENT PIPELINE                           │  │
│  │  ┌────────────────────┐  ┌──────────────────────────────────┐    │  │
│  │  │ Orchestrator Agent  │  │ Intent Guardian Agent            │    │  │
│  │  │ (gemini-3-flash)    │  │ (gemini-3-flash reasoning)       │    │  │
│  │  │                    │  │                                  │    │  │
│  │  │ • Prompt → Test    │  │ • Paste detection                │    │  │
│  │  │ • JSON contract    │  │ • Code-shift analysis            │    │  │
│  │  │ • Competency matrix│  │ • Token injection patterns       │    │  │
│  │  │ • Hidden test cases│  │ • Semantic similarity scoring    │    │  │
│  │  │ • 90s timeout      │  │ • Auto-creates sessions          │    │  │
│  │  └────────────────────┘  └──────────────────────────────────┘    │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │ MCP (Model Context Protocol)
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                  MCP SERVER — MONGODB TRACK                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                  │
│  │ Sessions     │  │ Micro-Events  │  │ Suspicion     │                  │
│  │ Collection   │  │ Collection   │  │ Reports      │                  │
│  └──────────────┘  └──────────────┘  └──────────────┘                  │
│                                                                         │
│  Exposes 11 MCP tools via HTTP adapter:                                 │
│  • store_test_suite / get_test_suite                                   │
│  • create_session / update_session_code                                │
│  • append_micro_event / ingest_micro_events                            │
│  • store_suspicion_report                                              │
│  • get_session_review / get_candidate_report / list_sessions            │
│  • health_check                                                        │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 📂 Project Structure

```
Google-Cloud-Hackathon/
├── .github/
│   └── HACKATHON_RULES.md          # Official compliance directive
├── .gitignore                       # Blocks **/.env and node_modules
├── LICENSE                          # Apache 2.0 (OSI-approved)
└── sandbox/
    ├── README.md                    # ← THIS FILE
    ├── package.json                 # npm workspace: hono-api + mcp-server
    ├── Dockerfile                   # Multi-stage Cloud Run container
    ├── entrypoint.sh                # Concurrent Hono + MCP launcher
    ├── start-services.js            # Node.js dev process manager (production builds)
    ├── dev-services.js              # Auto-reload dev mode (tsx watch)
    ├── hono-api/                    # Hono TypeScript API (Cloud Run)
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── .env.example             # Copy to .env and configure
    │   └── src/
    │       ├── index.ts             # Entry point, Hono app bootstrap
    │       ├── config.ts            # Environment config loader
    │       ├── types.ts             # Shared TypeScript contracts
    │       ├── agents/
    │       │   └── gemini-client.ts # Vertex AI SDK Gemini 3 Flash client (ADC)
    │       └── routes/
    │           ├── health.ts        # GET /health
    │           ├── generate.ts      # POST /api/v1/generate
    │           ├── guardian.ts      # POST /api/v1/guardian/ingest
    │           ├── review.ts        # GET /api/v1/sessions/:id/review
    │           └── identity.ts      # POST /api/v1/identity/set · GET /api/v1/identity/me
    ├── mcp-server/                  # MCP Server (MongoDB Partner Track)
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── .env.example             # Copy to .env and configure
    │   └── src/
    │       ├── server.ts            # StdioServerTransport MCP server
    │       ├── mongo-client.ts      # MongoDB native driver + MongoStore
    │       └── http-adapter.ts      # HTTP wrapper for Cloud Run sidecar
    └── frontend/                    # Flutter Review Panel
        ├── pubspec.yaml
        └── lib/
            ├── main.dart            # App entry point
            ├── app.dart             # MaterialApp + routing
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
- **Google Cloud Project** with Vertex AI API enabled (project ID: `webscraping-464710`)
- **Application Default Credentials** configured (`gcloud auth application-default login`)
- **MongoDB Atlas** connection string (set as `MONGODB_URI`)
- **Flutter SDK** ≥ 3.24 (for the review panel)

### 1. Install Dependencies

```bash
cd Google-Cloud-Hackathon
npm install
```

### 2. Configure Environment

```bash
cp sandbox/hono-api/.env.example sandbox/hono-api/.env
cp sandbox/mcp-server/.env.example sandbox/mcp-server/.env
# Edit both .env files with your GCP_PROJECT_ID, GCP_LOCATION, and MONGODB_URI
```

Key configuration options in `.env.example`:

| Variable | Default | Description |
|----------|---------|-------------|
| `GCP_PROJECT_ID` | `webscraping-464710` | Google Cloud project ID for Vertex AI |
| `GCP_LOCATION` | `global` | Vertex AI endpoint — use `global` for Gemini 3 Flash Preview |
| `GEMINI_MODEL` | `gemini-3-flash-preview` | Model to use for all inference |
| `GEMINI_MAX_OUTPUT_TOKENS` | `65536` | Max tokens for Gemini responses (prevent truncation on large test suites) |
| `GEMINI_TEMPERATURE` | `0.2` | Determinism control (lower = more deterministic) |
| `MCP_SERVER_ENDPOINT` | `http://localhost:3001` | MCP server URL |
| `SESSION_TTL_SECONDS` | `7200` | Session expiry (2 hours) |
| `MAX_PASTE_EVENTS` | `5` | Max paste events before auto-flagging |
| `PLAGIARISM_THRESHOLD` | `0.75` | Semantic similarity threshold |

### 3. Build & Run Locally

```bash
# Build TypeScript
npm run build -w sandbox/hono-api
npm run build -w sandbox/mcp-server

# Option A: Production mode (compiled JS)
node sandbox/start-services.js

# Option B: Auto-reload dev mode (tsx watch — no build needed)
node sandbox/dev-services.js
```

- Hono API → `http://localhost:8080`
- MCP Server HTTP Adapter → `http://localhost:3001`

### 4. Deploy to Cloud Run

```bash
gcloud builds submit --config=cloudbuild.yaml
gcloud run deploy cerberus-api --image=gcr.io/$PROJECT_ID/cerberus-api \
  --platform=managed --region=us-central1 --allow-unauthenticated
```

---

## 🔧 API Endpoints

### `POST /api/v1/generate` — Test Suite Generator

Accepts a text prompt and returns a structured JSON test suite via the
Orchestrator Agent running on Gemini 3 Flash (`gemini-3-flash-preview`).
Authenticated via Application Default Credentials with 3-retry exponential
backoff for reliable large-suite generation. Supports explicit role targeting
and problem count tuning.

**Request:**
```json
{
  "prompt": "Generate a senior React developer assessment covering state management...",
  "roleContext": "senior engineer",
  "problemCount": 5
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `prompt` | `string` | ✅ Yes | — | Natural-language description of the assessment domain |
| `roleContext` | `string` | No | `"mid-level developer"` | Target seniority level for competency calibration |
| `problemCount` | `number` | No | `5` | Number of coding problems to generate (1–10) |

**Response:** Complete `GeneratedTestSuite` object with metadata, roles,
competencies, problems, and hidden testing matrices. See `types.ts` for full schema.

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

Streams micro-events to Gemini for real-time integrity analysis.
Auto-creates a session if the referenced `sessionId` does not exist.

**Request:**
```json
{
  "sessionId": "sess-abc123",
  "candidateId": "cand-xyz789",
  "currentCode": "...",
  "event": {
    "type": "paste",
    "timestamp": "2026-05-26T10:00:00Z",
    "payload": { ... }
  }
}
```

**Response:** `GuardianAnalysisResult` with `overallSuspicionScore`, `verdict`,
and detailed factor breakdown.

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
}```

### `GET /api/v1/sessions/:sessionId/review` — Review Log

Returns the full session review including submitted code, timeline, and
suspicion reports.

### `GET /health` — Health Check

Returns `{ "status": "ok", "timestamp": "..." }`

### 🔐 Identity Endpoints (Personalization Layer)

A lightweight, password-free identity system for persona-based evaluation
demos. Identity is ephemeral — stored in-memory, reset on server restart.
Production deployments integrate with Google Cloud Identity Platform.

#### `POST /api/v1/identity/set` — Register Identity

Sets the current session identity. Returns a `sessionToken` UUID that is
automatically attached to all subsequent API calls via `X-Session-Token` header.

**Request:**
```json
{
  "displayName": "Alice Chen",
  "candidateId": "CAND-001",
  "role": "Senior Backend Engineer (optional)"
}
```

**Response:**
```json
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

## 🗄️ MongoDB MCP Tools — 11 Tools via HTTP Adapter

The MCP HTTP adapter (`mcp-server/src/http-adapter.ts`) exposes **11 tools**
via `POST /tools/:toolName`. All database operations route through the
`MongoStore` class (`mongo-client.ts`) using the MongoDB Node.js native driver
with Atlas connection pooling.

### Tool 1: `store_test_suite` / `get_test_suite`
**Purpose:** Persist and retrieve generated assessment suite documents.
**Store parameters:** `{ suite: GeneratedTestSuite }`
**Get parameters:** `{ suiteId: string }`

### Tool 2: `create_session` / `update_session_code`
**Purpose:** Initialize a candidate assessment session and update submitted code.
**Create parameters:** `{ candidateId, testSuiteId, metadata }`
**Update parameters:** `{ sessionId, code }`

### Tool 3: `append_micro_event` / `ingest_micro_events`
**Purpose:** Ingest individual or batched micro-events (paste triggers,
structural code shifts, token injections) into the session timeline.
**Parameters (batch):** `{ events: MicroEvent[] }`
**Returns:** `{ success: true, processedCount: number }`

### Tool 4: `store_suspicion_report`
**Purpose:** Store a Gemini-generated suspicion analysis against a session.
**Parameters:** `{ report: SuspicionReport }`
**Returns:** `{ success: true, mongoDocumentId: string }`

### Tool 5: `get_session_review` / `get_candidate_report`
**Purpose:** Aggregate the full review log — session metadata, code workspace,
micro-event timeline, and suspicion reports — for the Flutter review panel.
**Parameters:** `{ sessionId }` or `{ candidateId }`
**Returns:** `{ session, events[], suspicionReports[] }`

### Tool 6: `list_sessions`
**Purpose:** List all sessions with summary fields. Used by the Flutter drawer.
**Parameters:** none
**Returns:** `{ success: true, data: SessionSummary[] }`

### Tool 7: `health_check`
**Purpose:** MongoDB connectivity health check with Atlas ping.
**Returns:** `{ connected: boolean, healthy: boolean, timestamp: string }`

### Auto-Indexing

The `MongoStore` class runs `ensureIndexes()` automatically on startup,
creating core indexes for `sessions`, `micro_events`, `suspicion_reports`,
and `test_suites` collections if they don't already exist.

---

## 🧠 Agent Design Philosophy

### Orchestrator Agent (Test Generation)

The Orchestrator transforms unstructured natural-language requirements into
fully-structured, production-grade assessment JSON. It enforces:

- **Role definition**: Maps abstract job titles to concrete skill matrices
- **Competency mapping**: Weighted sub-scores per competency area
- **Problem construction**: Each problem includes starter code, test harness,
  and hidden edge-case tests
- **Hidden testing matrix**: Anti-cheat measures baked into the evaluation
  (expected false starts, common misconceptions to flag)

### Intent Guardian Agent (Security)

The Guardian operates as a streaming micro-event processor:

1. **Paste Detection**: Tracks clipboard injection events in real-time
2. **Structural Code Shifts**: Compares AST-level similarity between sequential
   submissions using tree-edit distance
3. **Token Injection Analysis**: Detects rapid large-block insertions
   characteristic of AI-generated pastes
4. **Semantic Similarity**: Uses Gemini embeddings to compare candidate code
   against canonical AI completions, detecting obfuscated variations

---

## 📋 Hackathon Compliance Checklist

| Rule | Status | Evidence |
|------|--------|----------|
| **Originality Mandate** | ✅ PASS | All code in `sandbox/` is 100% new; no legacy Express/Flutter code reused |
| **Legacy Code Ban** | ✅ PASS | Zero imports from `../../backend/src` or `../../frontend` |
| **Repository Isolation Rule** | ✅ PASS | All work within `Google-Cloud-Hackathon/sandbox/` — fresh directory |
| **Orchestration Platform** | ✅ PASS | Google Cloud Agent Builder runtime with Gemini 3 Flash model inference |
| **Connectivity Rule (MCP)** | ✅ PASS | MongoDB track MCP server with 11 registered tools |
| **No Competing AI Platforms** | ✅ PASS | Zero OpenAI, Anthropic, or AWS Bedrock dependencies |
| **Google Native Routing** | ✅ PASS | All model calls use `@google/genai` SDK with `vertexai: true` (ADC) |
| **Open Source License** | ✅ PASS | Apache 2.0 LICENSE file at repo root |
| **Production-grade** | ✅ PASS | Dockerfile, health checks, non-root user, Cloud Run ready |
| **MongoDB Indexes** | ✅ PASS | Automatic `ensureIndexes()` on MCP startup + documented manual indexes |

---


---

Built with ❤️ for the Google Cloud Rapid Agent Hackathon 2026.