# YouTube Downloader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Docker Compose web application that downloads a public YouTube video at an explicitly selected resolution as MP4 or MOV without transcoding and falls back through yt-dlp, self-hosted Cobalt, and YouTube.js.

**Architecture:** A Node.js/TypeScript Fastify service hosts a small React UI and owns validation, format normalization, a single-worker queue, provider fallback, SSE progress, and cleanup. Provider adapters hide yt-dlp, Cobalt, and YouTube.js behind one contract; FFmpeg/ffprobe verify and mux streams without transcoding. Docker Compose runs the application, Cobalt, and bgutil PO-token provider on a private network.

**Tech Stack:** Node.js 22, TypeScript, Fastify, React, Vite, Vitest, Testing Library, Playwright, youtubei.js, yt-dlp, FFmpeg/ffprobe, Docker Compose, Cobalt, bgutil-ytdlp-pot-provider, yt-dlp-getpot-wpc, headless Chromium.

**Spec:** `docs/superpowers/specs/2026-10-06-youtube-downloader-design.md`

## Global Constraints

- Accept only public completed YouTube videos and Shorts from `youtube.com` and `youtu.be`; do not support playlists, live streams, cookies, account login, Premium, Studio, or Takeout.
- The visible flow is URL → inspect → exact resolution → MP4 or MOV → download.
- Never transcode, upscale, change frame rate, or silently substitute a resolution/container; FFmpeg must use stream copy.
- Provider order is yt-dlp → self-hosted Cobalt → YouTube.js; retry only technical failures.
- yt-dlp first uses bgutil PO tokens and may retry once with the guest WPC browser provider; neither path receives account cookies.
- Run one download at a time; keep additional jobs queued.
- Bind to `127.0.0.1:8080` by default; do not expose Cobalt or bgutil ports to the host.
- Delete temporary files after successful transfer, cancellation, failure, expiry after 60 minutes, and startup recovery.
- Support Docker platforms `linux/amd64` and `linux/arm64` for Windows x64 and Apple Silicon Macs.
- Keep online YouTube smoke tests separate from the deterministic test suite.

## Review Focus

- A valid video URL that also contains a playlist parameter must resolve to one canonical video and never trigger playlist processing; Task 1 pins this behavior.
- A provider returning the requested height with an incompatible codec must not enable the chosen container or start transcoding; Task 2 pins this behavior.
- A final access restriction such as `LOGIN_REQUIRED` must stop fallback, while HTTP 403/429 during media transfer must continue fallback; Task 5 pins this boundary.
- A client disconnect during file transfer must retain cleanup guarantees and never delete a file while another active stream still owns it; Task 6 pins ownership behavior.
- A restart with malformed or path-traversing manifests must ignore unsafe paths and clean only directories below the configured work root; Task 6 pins containment.

---

## File Map

- `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts` — build, typecheck, and test configuration.
- `src/shared/contracts.ts` — API DTOs, job states, normalized media types, and provider contracts shared by server and UI.
- `src/server/domain/youtube-url.ts` — strict YouTube URL parsing and canonicalization.
- `src/server/domain/formats.ts` — codec/container compatibility and deterministic quality selection.
- `src/server/domain/errors.ts` — stable error codes and retry classification.
- `src/server/process/run-process.ts` — shell-free child-process execution, progress streaming, timeout, and cancellation.
- `src/server/media/ffmpeg.ts` — ffprobe inspection and stream-copy mux/remux.
- `src/server/providers/{yt-dlp,cobalt,youtubejs}.ts` — provider-specific inspection/download adapters.
- `src/server/orchestrator.ts` — provider order and exact-request verification.
- `src/server/jobs/{store,queue,cleanup}.ts` — in-memory state, serialized execution, leases, expiry, and recovery cleanup.
- `src/server/routes/{inspect,jobs,health}.ts` — HTTP/SSE endpoints.
- `src/server/{app,index,config}.ts` — dependency wiring and process lifecycle.
- `src/web/{App,api,styles}.tsx` and `src/web/main.tsx` — single-card browser workflow.
- `tests/unit`, `tests/integration`, `tests/e2e` — deterministic unit/integration/UI coverage.
- `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.env.example` — reproducible cross-platform deployment.
- `README.md` — macOS/Windows startup, operation, updating, logs, LAN opt-in, and limitations.

### Task 1: Project foundation, contracts, and YouTube URL boundary

**Files:**
- Create: `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `.gitignore`
- Create: `src/shared/contracts.ts`
- Create: `src/server/domain/youtube-url.ts`
- Test: `tests/unit/youtube-url.test.ts`

**Interfaces:**
- Produces: `parseYouTubeUrl(raw: string): ParsedYouTubeUrl`; `ParsedYouTubeUrl = { videoId: string; canonicalUrl: string }`.
- Produces: shared `Container`, `MediaVariant`, `VideoInfo`, `DownloadRequest`, `Job`, `JobState`, `ProgressEvent`, `ProviderErrorCode`, `ProcessRunner`, and `SourceAdapter` types used by every later task.

- [ ] **Step 1: Write failing URL-boundary tests**

  Cover `watch?v=`, `youtu.be/`, `/shorts/`, mobile hosts, surrounding whitespace, a video URL containing `list=`, HTTP, credentials in URL, deceptive suffix hosts, non-video playlist URLs, malformed IDs, and arbitrary URLs. Assert canonical output is exactly `https://www.youtube.com/watch?v=<11-char-id>` and playlist parameters are discarded.

- [ ] **Step 2: Run the focused test and verify failure**

  Run: `npm test -- tests/unit/youtube-url.test.ts`
  Expected: FAIL because project configuration and `parseYouTubeUrl` do not exist.

- [ ] **Step 3: Add the Node/TypeScript/Vite/Vitest foundation and shared contracts**

  Use ESM, strict TypeScript, Node 22 engine, scripts `dev`, `build`, `start`, `typecheck`, `test`, `test:unit`, `test:integration`, and `test:e2e`. Define injectable `ProcessRunner` and `SourceAdapter` contracts with `name`, optional `inspect`, `download(request, destination, signal, onProgress)`, `health`, and `cancel` semantics; no provider-specific IDs may appear in HTTP DTOs.

- [ ] **Step 4: Implement strict canonical URL parsing**

  Implement `parseYouTubeUrl(raw: string): ParsedYouTubeUrl` using the platform `URL` parser and an allowlist of `youtube.com`, `www.youtube.com`, `m.youtube.com`, and `youtu.be`. Accept only HTTPS and an exact 11-character YouTube video ID; canonicalize before passing a URL to any provider.

- [ ] **Step 5: Run tests and typecheck**

  Run: `npm test -- tests/unit/youtube-url.test.ts && npm run typecheck`
  Expected: PASS.

- [ ] **Step 6: Commit**

  Run: `git add package.json package-lock.json tsconfig.json vite.config.ts vitest.config.ts .gitignore src/shared src/server/domain/youtube-url.ts tests/unit/youtube-url.test.ts && git commit -m "feat: establish project contracts and URL validation"`

### Task 2: Format normalization and stream-copy media policy

**Files:**
- Create: `src/server/domain/formats.ts`
- Create: `src/server/media/ffmpeg.ts`
- Test: `tests/unit/formats.test.ts`
- Test: `tests/integration/ffmpeg.test.ts`
- Create: `tests/fixtures/media/README.md`

**Interfaces:**
- Consumes: `Container`, `MediaVariant`, `DownloadRequest`, and injectable `ProcessRunner` from Task 1.
- Produces: `buildDownloadOptions(streams: SourceStream[]): MediaVariant[]`; `selectStreams(streams: SourceStream[], height: number, container: Container): SelectedStreams`.
- Produces: `probeMedia(path: string, signal?: AbortSignal): Promise<ProbeResult>`; `muxCopy(videoPath: string, audioPath: string | null, outputPath: string, container: Container, signal: AbortSignal, onProgress: ProgressCallback): Promise<void>`; `remuxCopy(inputPath: string, outputPath: string, container: Container, signal: AbortSignal): Promise<void>`.

- [ ] **Step 1: Write failing compatibility and exact-selection tests**

  Assert exact height wins over nearest height, the highest compatible bitrate/audio pair is selected, MP4 accepts supported ISO-BMFF combinations, MOV accepts only its declared codec set, an incompatible requested container is absent, and no selector returns a lower resolution as fallback.

- [ ] **Step 2: Run unit tests and verify failure**

  Run: `npm test -- tests/unit/formats.test.ts`
  Expected: FAIL because format policy functions do not exist.

- [ ] **Step 3: Implement normalized stream and container policy**

  Define one explicit compatibility table in `formats.ts`. Keep codec normalization, exact-height grouping, bitrate ordering, approximate-size summation, HDR/FPS preservation, and container availability in this file.

- [ ] **Step 4: Run unit tests and verify success**

  Run: `npm test -- tests/unit/formats.test.ts`
  Expected: PASS.

- [ ] **Step 5: Add generated tiny media fixtures and failing FFmpeg integration tests**

  Generate deterministic color-video and sine-audio fixtures during test setup. Assert `muxCopy` emits playable MP4 and MOV with matching input codecs and resolution, and rejects an incompatible MOV stream without invoking a transcoding codec.

- [ ] **Step 6: Implement shell-free ffprobe and FFmpeg wrappers**

  Call the injected `ProcessRunner`, always pass `-c copy`, parse ffprobe JSON, write to a `.part` path, and atomically rename only after verification. Task 3 supplies the production runner; this task uses a fake in tests.

- [ ] **Step 7: Run focused tests**

  Run: `npm test -- tests/unit/formats.test.ts tests/integration/ffmpeg.test.ts`
  Expected: PASS.

- [ ] **Step 8: Commit**

  Run: `git add src/server/domain/formats.ts src/server/media/ffmpeg.ts tests/unit/formats.test.ts tests/integration/ffmpeg.test.ts tests/fixtures && git commit -m "feat: add exact format and stream-copy policy"`

### Task 3: Process runner and yt-dlp adapter

**Files:**
- Create: `src/server/process/run-process.ts`
- Create: `src/server/providers/yt-dlp.ts`
- Create: `src/server/domain/errors.ts`
- Test: `tests/unit/run-process.test.ts`
- Test: `tests/unit/yt-dlp.test.ts`

**Interfaces:**
- Consumes: canonical URL, shared provider contracts, format functions, and FFmpeg wrapper.
- Produces: `runProcess(command: string, args: readonly string[], options: ProcessOptions): Promise<ProcessResult>` with AbortSignal, timeout, bounded stdout/stderr, and line callbacks.
- Produces: `classifyProviderError(input: ProviderFailure): AppError` and `isRetryable(error: AppError): boolean`.
- Produces: `YtDlpAdapter` implementing `SourceAdapter`, including `inspect` and `download`.

- [ ] **Step 1: Write failing process-runner tests**

  Verify arguments containing shell metacharacters remain literal, cancellation terminates the child, timeout maps to a stable error, output is bounded, and progress lines are delivered without logging media URLs.

- [ ] **Step 2: Run process-runner tests and verify failure**

  Run: `npm test -- tests/unit/run-process.test.ts`
  Expected: FAIL because `runProcess` does not exist.

- [ ] **Step 3: Implement the process runner**

  Implement `runProcess` with literal argument arrays, AbortSignal termination, timeout, bounded output, redacted line callbacks, and stable process errors.

- [ ] **Step 4: Run process-runner tests and verify success**

  Run: `npm test -- tests/unit/run-process.test.ts`
  Expected: PASS.

- [ ] **Step 5: Write failing yt-dlp parsing and error tests**

  Feed recorded JSON/progress/error fixtures. Assert normalization of separate video/audio streams, rejection of live and login-required videos, technical classification for HTTP 403/429 and expired media URLs, final classification for private/age/region restrictions, and redaction of signed URLs.

- [ ] **Step 6: Run yt-dlp tests and verify failure**

  Run: `npm test -- tests/unit/yt-dlp.test.ts`
  Expected: FAIL because `YtDlpAdapter` does not exist.

- [ ] **Step 7: Implement `YtDlpAdapter`**

  Use `--dump-single-json --no-playlist` for inspection and an explicit exact format selector for download. Configure EJS and bgutil HTTP provider for the first attempt; if token generation specifically fails, retry once with WPC guest Chromium, then return a retryable provider error. Never pass cookie flags.

- [ ] **Step 8: Run focused tests and typecheck**

  Run: `npm test -- tests/unit/run-process.test.ts tests/unit/yt-dlp.test.ts && npm run typecheck`
  Expected: PASS.

- [ ] **Step 9: Commit**

  Run: `git add src/server/process src/server/providers/yt-dlp.ts src/server/domain/errors.ts tests/unit/run-process.test.ts tests/unit/yt-dlp.test.ts tests/fixtures && git commit -m "feat: add resilient yt-dlp adapter"`

### Task 4: Cobalt and YouTube.js adapters

**Files:**
- Create: `src/server/providers/cobalt.ts`
- Create: `src/server/providers/youtubejs.ts`
- Test: `tests/unit/cobalt.test.ts`
- Test: `tests/unit/youtubejs.test.ts`

**Interfaces:**
- Consumes: Task 1 provider contracts, Task 2 media helpers, Task 3 error model.
- Produces: `CobaltAdapter` implementing download and health; inspection remains unsupported.
- Produces: `YouTubeJsAdapter` implementing inspect, download, health, and cancellation.

- [ ] **Step 1: Write failing Cobalt API tests**

  Mock `redirect`, `tunnel`, `local-processing`, and `error` responses. Assert exact target height, `h264` request for MP4/MOV, redirect-host validation, bounded streamed download, ffprobe verification, MP4 pass-through, MOV stream-copy remux, and rejection when Cobalt returns a different height or incompatible codec.

- [ ] **Step 2: Run Cobalt tests and verify failure**

  Run: `npm test -- tests/unit/cobalt.test.ts`
  Expected: FAIL because `CobaltAdapter` does not exist.

- [ ] **Step 3: Implement `CobaltAdapter`**

  Implement Cobalt response handling, exact target validation, bounded streaming, MP4 pass-through, and MOV stream-copy remux through Task 2 helpers.

- [ ] **Step 4: Run Cobalt tests and verify success**

  Run: `npm test -- tests/unit/cobalt.test.ts`
  Expected: PASS.

- [ ] **Step 5: Write failing YouTube.js tests**

  Mock Innertube responses. Assert public metadata normalization, live/login restriction mapping, exact stream selection, direct stream download with cancellation, and technical mapping of decipher/player failures.

- [ ] **Step 6: Run YouTube.js tests and verify failure**

  Run: `npm test -- tests/unit/youtubejs.test.ts`
  Expected: FAIL because `YouTubeJsAdapter` does not exist.

- [ ] **Step 7: Implement `YouTubeJsAdapter`**

  Instantiate one guest Innertube client per adapter lifecycle, refresh it after auth/player failures, and use Task 2 selection and muxing rather than duplicating format rules.

- [ ] **Step 8: Run YouTube.js tests and verify success**

  Run: `npm test -- tests/unit/youtubejs.test.ts`
  Expected: PASS.

- [ ] **Step 9: Commit**

  Run: `git add src/server/providers/cobalt.ts src/server/providers/youtubejs.ts tests/unit/cobalt.test.ts tests/unit/youtubejs.test.ts tests/fixtures && git commit -m "feat: add Cobalt and YouTube.js fallbacks"`

### Task 5: Inspection and download orchestrator

**Files:**
- Create: `src/server/orchestrator.ts`
- Test: `tests/unit/orchestrator.test.ts`

**Interfaces:**
- Consumes: ordered adapters, `AppError`, normalized formats, FFmpeg verification.
- Produces: `inspectVideo(url: string, signal: AbortSignal): Promise<VideoInfo>`.
- Produces: `downloadVideo(request: DownloadRequest, destination: string, signal: AbortSignal, onProgress: ProgressCallback): Promise<DownloadResult>`.

- [ ] **Step 1: Write failing orchestration tests**

  Assert inspection order yt-dlp → YouTube.js; download order yt-dlp → Cobalt → YouTube.js; success stops later attempts; HTTP 403/429 and technical provider failures continue; `LOGIN_REQUIRED`, private, age, region, live, cancellation, disk-full, and unsupported-format errors stop immediately; each fallback revalidates exact height/container; all failed partial files are removed.

- [ ] **Step 2: Run test and verify failure**

  Run: `npm test -- tests/unit/orchestrator.test.ts`
  Expected: FAIL because `DownloadOrchestrator` does not exist.

- [ ] **Step 3: Implement `DownloadOrchestrator`**

  Constructor signature: `new DownloadOrchestrator({ inspectors, downloaders, media, logger })`. Return one public error code and correlation ID while retaining redacted attempt details in structured logs.

- [ ] **Step 4: Run tests and typecheck**

  Run: `npm test -- tests/unit/orchestrator.test.ts && npm run typecheck`
  Expected: PASS.

- [ ] **Step 5: Commit**

  Run: `git add src/server/orchestrator.ts tests/unit/orchestrator.test.ts && git commit -m "feat: orchestrate provider fallback"`

### Task 6: Serialized job lifecycle, leases, expiry, and recovery

**Files:**
- Create: `src/server/jobs/store.ts`
- Create: `src/server/jobs/queue.ts`
- Create: `src/server/jobs/cleanup.ts`
- Test: `tests/unit/jobs.test.ts`
- Test: `tests/integration/job-cleanup.test.ts`

**Interfaces:**
- Consumes: `DownloadOrchestrator.downloadVideo`, shared job types.
- Produces: `JobStore.create/get/update/subscribe/acquireFileLease/releaseFileLease`.
- Produces: `DownloadQueue.enqueue/cancel/start/stop` with concurrency fixed to `1`.
- Produces: `recoverWorkRoot(workRoot: string): Promise<void>` and `expireReadyJobs(now: Date): Promise<number>`.

- [ ] **Step 1: Write failing queue/state tests**

  Assert valid state transitions, FIFO order, one active job, real queue position, cancellation for queued and active jobs, progress subscriptions, 60-minute ready expiry, and no fake percent when total size is unknown.

- [ ] **Step 2: Run queue/state tests and verify failure**

  Run: `npm test -- tests/unit/jobs.test.ts`
  Expected: FAIL because the store and queue do not exist.

- [ ] **Step 3: Implement store and queue**

  Implement the declared state machine, FIFO serialization, cancellation, subscriptions, and download-file leases.

- [ ] **Step 4: Run queue/state tests and verify success**

  Run: `npm test -- tests/unit/jobs.test.ts`
  Expected: PASS.

- [ ] **Step 5: Write failing cleanup and containment tests**

  Cover success, failure, cancellation, expiry, startup leftovers, malformed manifests, `../` paths, symlink escapes, and client disconnect. Assert cleanup never leaves the configured work root and a ready file is deleted only after the last download lease closes.

- [ ] **Step 6: Run cleanup tests and verify failure**

  Run: `npm test -- tests/integration/job-cleanup.test.ts`
  Expected: FAIL because recovery and expiry cleanup do not exist.

- [ ] **Step 7: Implement cleanup and file leases**

  Each job owns `<workRoot>/<jobId>/manifest.json`; validate resolved paths start with the real work-root path, refuse symlink traversal, and perform idempotent cleanup.

- [ ] **Step 8: Run job tests**

  Run: `npm test -- tests/unit/jobs.test.ts tests/integration/job-cleanup.test.ts`
  Expected: PASS.

- [ ] **Step 9: Commit**

  Run: `git add src/server/jobs tests/unit/jobs.test.ts tests/integration/job-cleanup.test.ts && git commit -m "feat: manage queued download lifecycle"`

### Task 7: Fastify API, SSE, file transfer, and health

**Files:**
- Create: `src/server/config.ts`
- Create: `src/server/routes/inspect.ts`
- Create: `src/server/routes/jobs.ts`
- Create: `src/server/routes/health.ts`
- Create: `src/server/app.ts`
- Create: `src/server/index.ts`
- Test: `tests/integration/api.test.ts`

**Interfaces:**
- Consumes: URL parser, orchestrator, job store/queue, adapter health.
- Produces: `buildApp(dependencies: AppDependencies): FastifyInstance` and the seven endpoints fixed by the spec.

- [ ] **Step 1: Write failing API tests with injected fake dependencies**

  Assert request/response schemas, 16 KiB JSON limit for functional endpoints, URL validation, exact resolution/container validation, queue creation, job lookup, SSE events and heartbeat, cancellation, file headers, file-lease behavior on disconnect, expired download response, rate limiting, correlation IDs, and health degradation when optional providers are down.

- [ ] **Step 2: Run test and verify failure**

  Run: `npm test -- tests/integration/api.test.ts`
  Expected: FAIL because `buildApp` and routes do not exist.

- [ ] **Step 3: Implement config, dependency wiring, and routes**

  Use Fastify JSON schemas for every body/response, `Content-Disposition` with sanitized UTF-8 filename, SSE `Cache-Control: no-cache`, and graceful shutdown that stops new jobs, aborts the active job, closes adapters, and runs cleanup.

- [ ] **Step 4: Run API tests and typecheck**

  Run: `npm test -- tests/integration/api.test.ts && npm run typecheck`
  Expected: PASS.

- [ ] **Step 5: Commit**

  Run: `git add src/server/config.ts src/server/routes src/server/app.ts src/server/index.ts tests/integration/api.test.ts && git commit -m "feat: expose download HTTP API"`

### Task 8: Single-card React interface

**Files:**
- Create: `index.html`
- Create: `src/web/main.tsx`
- Create: `src/web/App.tsx`
- Create: `src/web/api.ts`
- Create: `src/web/styles.css`
- Test: `tests/unit/App.test.tsx`

**Interfaces:**
- Consumes: HTTP DTOs from `src/shared/contracts.ts` and Task 7 endpoints.
- Produces: complete browser flow with no additional screens.

- [ ] **Step 1: Write failing UI behavior tests**

  Assert initial URL field, paste/submit, loading and validation states, metadata card, exact resolution options, MP4/MOV availability and disabled reasons, estimated size display, download CTA, queue position, determinate/indeterminate progress, retryable user copy, final download navigation, cancellation, and reset to a new URL.

- [ ] **Step 2: Run UI tests and verify failure**

  Run: `npm test -- tests/unit/App.test.tsx`
  Expected: FAIL because the UI does not exist.

- [ ] **Step 3: Implement the API client and accessible single-card UI**

  Keep one page and one primary action per state. Use native controls, keyboard-visible focus, labels, Russian copy from the spec, responsive layout down to 360 px, and reduced-motion support. Do not expose provider names or technical logs.

- [ ] **Step 4: Run UI tests and production build**

  Run: `npm test -- tests/unit/App.test.tsx && npm run build`
  Expected: PASS and Vite emits the client bundle consumed by Fastify static hosting.

- [ ] **Step 5: Commit**

  Run: `git add index.html src/web tests/unit/App.test.tsx vite.config.ts && git commit -m "feat: add focused download interface"`

### Task 9: Docker Compose packaging and operational documentation

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `requirements.lock`
- Create: `.dockerignore`
- Create: `.env.example`
- Create: `README.md`
- Test: `tests/integration/compose-config.test.ts`

**Interfaces:**
- Consumes: built server/UI and all external runtime dependencies.
- Produces: `docker compose up -d` deployment at `http://localhost:8080`.

- [ ] **Step 1: Write failing compose-configuration tests**

  Parse the Compose config and assert exactly the app port binds to `127.0.0.1` by default, Cobalt/bgutil have no host ports, services share only a private network, the temp volume is mounted only where required, health checks exist, no cookies volume exists, and no floating `latest` tag is used.

- [ ] **Step 2: Run test and verify failure**

  Run: `npm test -- tests/integration/compose-config.test.ts`
  Expected: FAIL because deployment files do not exist.

- [ ] **Step 3: Build the multi-stage application image**

  Pin the build/runtime base to `node:22.20.0-bookworm-slim`. In `requirements.lock`, pin `yt-dlp[default]==2026.8.19`, `bgutil-ytdlp-pot-provider==2.0.1`, and `yt-dlp-getpot-wpc==1.1.2`; install their verified transitive lock plus FFmpeg/ffprobe and Chromium. Run the app as a non-root user with write access only to `/work`; expose no internal dependency ports.

- [ ] **Step 4: Define Compose services and health checks**

  Pin Cobalt to `ghcr.io/imputnet/cobalt:11.7.1-a636575` and bgutil to `brainicism/bgutil-ytdlp-pot-provider:2.0.1`; set Cobalt `API_URL=http://cobalt:9000/` and the app's bgutil base URL to `http://bgutil:4416`; keep provider traffic on an internal network; use `127.0.0.1:${APP_PORT:-8080}:8080` and a named temporary volume.

- [ ] **Step 5: Write the operational README**

  Include prerequisites, macOS/Windows commands, first start, health verification, logs, stop, update/rebuild, storage behavior, LAN binding opt-in, known limitations, license notices, and a reminder to download only content the user may lawfully use.

- [ ] **Step 6: Run deterministic verification and validate Compose**

  Run: `npm test && npm run typecheck && npm run build && docker compose config --quiet`
  Expected: all commands exit 0.

- [ ] **Step 7: Build both target platforms where the builder supports them**

  Run: `docker buildx build --platform linux/amd64,linux/arm64 --output=type=cacheonly .`
  Expected: both platform builds complete; if the local builder cannot emulate the second platform, record that limitation and verify each Dockerfile stage with `docker build` on the host platform.

- [ ] **Step 8: Commit**

  Run: `git add Dockerfile docker-compose.yml requirements.lock .dockerignore .env.example README.md tests/integration/compose-config.test.ts && git commit -m "feat: package cross-platform Docker deployment"`

### Task 10: End-to-end workflow and release verification

**Files:**
- Create: `playwright.config.ts`
- Create: `tests/e2e/download-flow.spec.ts`
- Create: `scripts/smoke-youtube.mjs`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: complete product from Tasks 1–9.
- Produces: deterministic browser test and opt-in online smoke command.

- [ ] **Step 1: Write a deterministic end-to-end test**

  Start the app with fake adapters and drive the complete browser flow: inspect URL, choose resolution, choose MP4 or MOV, create job, observe queue/progress, download a fixture, and verify filename/content. Add error scenarios for unavailable format and all-providers-failed.

- [ ] **Step 2: Run the E2E test and verify failure**

  Run: `npm run test:e2e`
  Expected: FAIL until the fake-adapter test harness and final browser integration are wired.

- [ ] **Step 3: Wire the deterministic E2E harness**

  Add a test-only startup path with injected fake adapters and fix only defects that cross the already-tested UI/API/job boundaries.

- [ ] **Step 4: Run the E2E test and verify success**

  Run: `npm run test:e2e`
  Expected: PASS in Chromium with no network access to YouTube.

- [ ] **Step 5: Add the opt-in online smoke script**

  Define `npm run smoke:youtube -- <public-url> --height <number> --container <mp4|mov>`. The script must require an explicit URL, inspect it, download one short file, verify audio/video/resolution through ffprobe, and always clean the job directory.

- [ ] **Step 6: Run the complete deterministic suite**

  Run: `npm test && npm run test:e2e && npm run typecheck && npm run build && docker compose config --quiet`
  Expected: all commands exit 0.

- [ ] **Step 7: Run the online smoke test when network access and a user-approved public test URL are available**

  Run: `npm run smoke:youtube -- <public-url> --height <available-height> --container mp4`
  Expected: the file contains audio and video at the selected height, then the temporary directory is empty. If no URL is supplied, record the smoke test as intentionally not run rather than choosing copyrighted content implicitly.

- [ ] **Step 8: Review the branch against the spec**

  Verify every acceptance criterion in the spec, inspect dependency licenses, scan logs for signed media URLs/tokens, and review `git diff --check` plus `git status`.

- [ ] **Step 9: Commit**

  Run: `git add playwright.config.ts tests/e2e scripts/smoke-youtube.mjs package.json package-lock.json README.md && git commit -m "test: verify complete download workflow"`
