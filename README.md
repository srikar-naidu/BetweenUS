# Between Us

**Between Us turns the small things people capture into shared memories.**

Friends rarely record the same event from the same perspective. Between Us brings together each member's fragments, finds the details they have in common, and helps a group reconstruct what happened—with evidence and uncertainty kept visible.

It is not a chatbot or a conventional shared-photo feed. The central unit is the **Moment**: a possible real-world event supported by fragments from the group.

## Product demo

Watch the product walkthrough:

<p align="center">
  <video controls muted playsinline width="100%">
    <source src="https://raw.githubusercontent.com/srikar-naidu/BetweenUS/main/public/video.mp4" type="video/mp4">
    Your Markdown viewer does not support embedded video. <a href="https://raw.githubusercontent.com/srikar-naidu/BetweenUS/main/public/video.mp4">Watch or download the Between Us demo</a>.
  </video>
</p>

## How it works

```text
Fragment → Observation → Context → Reasoning → Moment / Story
```

1. Members add text, photos, short videos, or optional voice notes to a group album.
2. A durable background worker analyzes eligible group-visible fragments. Gemma produces structured observations, not captions or free-form chat.
3. Retrieval creates a small context packet from relevant, authorized evidence. The full database is never sent to the model.
4. The system proposes possible shared Moments and cites the fragments behind its claims.
5. Members review, correct, and confirm candidates. Confirmed Moments can be used to create an editable event recap.

The app also includes a weekly Home journal, Friends discovery, group albums, private album covers, Moment review, optional story narration, and generated background music.

## Product principles

- **Evidence first:** generated claims must cite authorized source fragments. Unsupported Gemma output is rejected.
- **Uncertainty stays visible:** a candidate is not presented as a confirmed fact until members review it.
- **Group boundaries matter:** a friend connection does not grant access to another group's memories.
- **Private media stays private:** image and video bytes go only to the configured internal Gemma runtime. Raw voice recordings are never sent to Gemma.
- **Consent is specific:** voice transcription and external story narration require separate user consent.
- **Graceful story fallback:** Gemma is the primary event-story writer. If its runtime is unavailable, the app can create a clearly labeled chronological recap from already-confirmed Moments and their cited sources. Invalid model output and missing or ineligible evidence still fail closed.
- **Async by default:** uploads persist first and are processed by a MongoDB-backed worker, so slow inference does not hold the upload request open.

## Architecture

| Concern | Technology | Responsibility |
| --- | --- | --- |
| Web application | Next.js App Router, React, TypeScript | Albums, fragments, Moments, stories, and APIs |
| Authentication | Better Auth, Google OAuth | Sign-in, sessions, and group membership |
| Canonical data and queue | MongoDB Atlas | Fragments, permissions, Moments, jobs, and private GridFS media |
| Retrieval | Tiger Data | Derived temporal and lexical search for relevant group-visible evidence |
| AI inference | Gemma 4 E2B through `GemmaService` | Structured observations and bounded reconstruction |
| Local AI runtime | Ollama on the developer's machine | Local development and testing only |
| Production AI runtime | Private Ollama service on Render | Gemma inference inside the deployment environment |
| Shared approved memory | Backboard | Group-enabled memory populated from member-approved corrections |
| Optional voice and music | ElevenLabs | Consent-gated transcription and story narration/music |
| Observability | Sentry | Privacy-scrubbed application and worker diagnostics |
| Hosting and jobs | Render web service, worker, and private service | Public app, asynchronous processing, and private Gemma runtime |

Production never connects to a developer's computer. The application uses the `GemmaService` contract rather than depending on Render-specific inference code, so another private Gemma runtime can be added later without rewriting the memory pipeline.

## Run locally

### Requirements

- Node.js `20.19+`, `22.12+`, or `23.2+`
- npm
- MongoDB Atlas (or an appropriately configured MongoDB deployment)
- Tiger Data/Postgres for retrieval
- Ollama with the Gemma 4 E2B model for local AI processing
- Google OAuth credentials to use sign-in

### 1. Install dependencies and configure environment

```powershell
npm ci
Copy-Item .env.example .env.local
```

Fill in the required values in `.env.local`. Do not commit this file or put server secrets in `NEXT_PUBLIC_` variables.

At minimum, configure:

| Variable | Purpose |
| --- | --- |
| `MONGODB_URI`, `MONGODB_DB_NAME` | Canonical data, sessions, private media, and durable jobs |
| `TIGER_DATABASE_URL` | Derived retrieval index |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` | Session signing and application origin |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google sign-in |
| `GEMMA_RUNTIME=local` | Select the local development adapter |
| `OLLAMA_HOST=http://localhost:11434` | Local Ollama address |
| `GEMMA_MODEL=gemma4:e2b` | Gemma model name |
| `GEMMA_TIMEOUT_MS=300000` | Inference timeout |

See [`.env.example`](.env.example) for optional Backboard, ElevenLabs, and Sentry settings.

### 2. Start local Gemma

Install Ollama, then download and start the supported model:

```powershell
ollama pull gemma4:e2b
ollama run gemma4:e2b
```

Keep Ollama running while testing AI features. The local app's processing worker must be able to reach `OLLAMA_HOST`.

### 3. Prepare retrieval and start the app

Apply both SQL migrations to the Tiger Data database:

```text
migrations/tiger/001_fragment_search.sql
migrations/tiger/002_fragment_analysis_search.sql
```

Then run the web app and background worker together:

```powershell
npm run dev
```

Open `http://localhost:3000`. `npm run dev` starts the Next.js server and MongoDB worker; stop the command to stop both. To run only the worker, use `npm run worker`.

### Useful checks

```powershell
npm test
npm run typecheck
npm run build
```

The standard tests use deterministic fixtures and do not need credentials or a running model. To run the opt-in local Gemma integration tests:

```powershell
$env:RUN_GEMMA_INTEGRATION = "true"
npx tsx --test tests/gemma-local.integration.test.ts
Remove-Item Env:RUN_GEMMA_INTEGRATION
```

Image inference on CPU can take minutes. Ensure Ollama is running and the model is installed before interpreting a local “Gemma could not be reached” error; production uses its own Render runtime.

## AI and background processing

### Fragment analysis

Group-visible text, images, and videos are queued for analysis. Gemma receives the relevant text or image/frame bytes and returns schema-constrained observations. The server validates the response and provenance before storing it. Visual confidence is capped, and video processing samples at most six frames. Unchanged media can reuse a validated observation rather than trigger another inference.

Voice uploads are not submitted to Gemma. A member may separately opt into ElevenLabs transcription; the author must review and approve the transcript before the text can enter the memory pipeline.

### Moments and stories

Moment reconstruction uses a compact, authorized evidence packet assembled from MongoDB and retrieval results. It requires corroboration from multiple contributors. Candidate Moments remain reviewable until confirmed.

Event-story generation runs in the background and uses selected confirmed Moments. Gemma is the primary writer and returns evidence-linked sections. If the configured Gemma provider is unavailable, the worker builds a deterministic, chronological recap from confirmed Moment titles and summaries. The UI labels that fallback clearly. Invalid model output, missing observations, stale evidence, revoked consent, and unauthorized sources are not replaced by invented content.

### Optional integrations

- **Backboard:** stores/retrieves group memory only when a group enables the integration and members approve corrections.
- **ElevenLabs:** optional transcription and story narration/music. Transcription and sending story text externally are consent-gated. Configure only the required Speech to Text, Text to Speech, and Music permissions; do not enable voice cloning or unrelated features.
- **Sentry:** reports scrubbed errors and operation metrics. Raw media, prompts, story content, credentials, and group identifiers are excluded by the application's privacy configuration. Disable IP-address storage in the Sentry project privacy settings too.

These integrations are configured with server-side variables. Do not expose their API keys to browser code.

## Deploy to Render

The repository includes [`render.yaml`](render.yaml), a Blueprint defining three services:

1. **`betweenus-web`** — public Next.js application.
2. **`betweenus-background-worker`** — durable MongoDB job processing.
3. **`betweenus-gemma`** — private Ollama/Gemma inference service, reachable by the app services over Render's private network.

To deploy:

1. Push the desired commit to the Git branch connected to Render.
2. In Render, create a **Blueprint** from this repository and select `render.yaml`.
3. Provide the prompted secret values listed below; do not change the private Gemma service to a public service.
4. Deploy the Blueprint. On the first deployment, wait for the Gemma service logs to show that `gemma4:e2b` has downloaded successfully before testing image or video analysis.
5. Set the Google OAuth redirect URI and confirm Atlas/Tiger Data accept connections from the deployed services.
6. Verify sign-in, worker processing, and a test image before inviting a group.

### Render secrets to provide

The Blueprint has `sync: false` placeholders. On initial Blueprint creation, supply:

| Variable | Web | Worker |
| --- | :---: | :---: |
| `MONGODB_URI` | Yes | Yes |
| `TIGER_DATABASE_URL` | Yes | Yes |
| `BACKBOARD_API_KEY` | Yes | Yes |
| `ELEVENLABS_API_KEY` | Yes | Yes |
| `SENTRY_DSN` | Yes | Yes |
| `BETTER_AUTH_SECRET` (at least 32 bytes) | Yes | — |
| `BETTER_AUTH_URL` (final public HTTPS origin) | Yes | — |
| `GOOGLE_CLIENT_ID` | Yes | — |
| `GOOGLE_CLIENT_SECRET` | Yes | — |
| `NEXT_PUBLIC_SENTRY_DSN` | Yes | — |

Use the same MongoDB and Tiger Data databases for the web service and worker. Add `${BETTER_AUTH_URL}/api/auth/callback/google` as an authorized Google OAuth redirect URI. Allow production Render connections in MongoDB Atlas and Tiger Data network settings; a developer-PC IP allowlist entry is not sufficient.

The model name, runtime, private service address, inference timeout, and Ollama limits are already defined in the Blueprint. Do not set `OLLAMA_HOST` to a developer machine.

### Gemma resources and limits

The Blueprint provisions the private Gemma service with **4 CPU, 16 GB RAM, and a 20 GB persistent disk**. The disk keeps Ollama model weights across service restarts. Gemma 4 E2B runs CPU-only on this configuration: expect serialized, potentially minute-scale inference and limited throughput. The service is intended for a small demo, not concurrent production traffic. Measure RAM, disk, CPU, and inference latency in Render before expanding usage. Render pricing and available credits depend on your account; check them in the dashboard before deploying.

The app health endpoint (`/api/health`) checks web-service liveness only; it does not certify Gemma, MongoDB, or Tiger readiness. Check each service's logs and exercise an end-to-end test after the first deployment.

## Repository documentation

The longer product, design, and engineering documents are in [`docs/`](docs/):

- [Product brief](docs/PRODUCT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [AI pipeline](docs/AI_PIPELINE.md)
- [AI contracts](docs/AI_CONTRACTS.md)
- [Context engineering](docs/CONTEXT_ENGINEERING.md)
- [Data model](docs/DATA_MODEL.md)
- [Privacy](docs/PRIVACY.md)
- [MVP scope](docs/MVP.md)
- [Roadmap](docs/ROADMAP.md)
- [Decision log](docs/DECISIONS.md)
- [Implementation plan](docs/IMPLEMENTATION_PLAN.md)
- [Project reference](docs/Project.md)

## Success criteria

Between Us succeeds when different people can contribute fragments from the same experience and the system can connect them into a shared Moment, explain that connection with evidence, preserve uncertainty, and let the group decide what becomes a memory.
