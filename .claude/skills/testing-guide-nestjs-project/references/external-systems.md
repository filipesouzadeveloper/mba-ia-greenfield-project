> Part of the `testing-guide-nestjs-project` skill (see `../SKILL.md`).

# External System Strategies

How each external system is handled in tests. These strategies were confirmed with the team.

---

## PostgreSQL — Real (Docker)

**Strategy:** Real database via the Docker `db` service (already in `compose.yaml`).

**Connection config for tests:**
```typescript
{
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USERNAME ?? 'streamtube',
  password: process.env.DB_PASSWORD ?? 'streamtube',
  database: process.env.DB_DATABASE ?? 'streamtube',
  synchronize: true, // auto-create tables in test setup
}
```

**Test isolation:**
- Use `dataSource.query('DELETE FROM "table_name"')` to clean tables between tests
- Do NOT use `repository.delete({})` — throws `Empty criteria(s) are not allowed`
- Alternative: `repository.clear()` (truncates the table)
- For complex foreign key chains, delete in reverse dependency order or use `TRUNCATE ... CASCADE`
- Use `beforeEach` for cleanup to ensure each test starts with a clean state

**Entity setup:**
- Use `synchronize: true` in test DataSource to auto-create tables from entities
- For integration tests, import only the entities needed by the test — not all entities
- For E2E tests, import `AppModule` which includes all entities via their domain modules

---

## Object Storage — Real MinIO (Docker)

**Strategy:** Real MinIO via the Docker `minio` service (S3 API), reached through `StorageService` (`src/storage/`). No local-filesystem adapter and no S3 mock: multipart upload, presigned URLs and `Range` reads are exactly what must be proven.

**Approach:**
- Tests use the same `S3_*` variables as dev. `src/test/test-env.ts` (in Jest `setupFiles`) sets `S3_PUBLIC_ENDPOINT = S3_ENDPOINT`, because inside the container `localhost:9000` does not reach MinIO and the host is part of the SigV4 signature.
- Use random object keys (`storage.originalKey(randomUUID())`) so suites never collide, and delete the objects you create in `afterAll` (E2E suites also remove `videos/{id}/original`).
- When the test must prove bucket creation, use a throwaway bucket (`streamtube-test-<uuid>`), point `S3_BUCKET` to it before compiling the module and delete it in `afterAll`.
- Upload parts with a plain `fetch(url, { method: 'PUT', body })` on the presigned URL — the same call the browser makes.

**Integration test (shape of `src/storage/storage.service.integration-spec.ts`):**
```typescript
it('lists a part uploaded through a presigned URL', async () => {
  const key = storage.originalKey(randomUUID());
  const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
  const url = await storage.presignUploadPart(key, uploadId, 1);

  const response = await fetch(url, { method: 'PUT', body: content });
  expect(response.status).toBe(200);

  const parts = await storage.listParts(key, uploadId);
  expect(parts.map((part) => part.partNumber)).toEqual([1]);
});
```

---

## Message Queue — Real Redis + BullMQ (Docker)

**Strategy:** Real Redis via the Docker `redis` service, BullMQ through `@nestjs/bullmq` (`src/queue/`). Queue `video-processing`, jobs `process-video` and `cleanup-stale-uploads`.

**Test isolation:**
- `src/test/test-env.ts` sets `QUEUE_PREFIX=streamtube-test`, so test jobs never reach the dev `video-worker` (prefix `streamtube`). Do not override it in a test.
- Use random job ids (`test-${randomUUID()}`) or the video id as `jobId`, and call `queue.obliterate({ force: true })` in `beforeEach`/`afterAll` when the suite asserts queue state.
- Publisher tests assert the job (`queue.getJob(videoId)`) and its data; consumer tests enqueue through the real `VideoProcessingQueue` and wait for the outcome in the database, with the real `VideoProcessor` running in the test module.
- A test that must not have the job consumed (e.g. the scheduler test) compiles a module with the queue only, without the processor.
- Close the module in `afterAll` — open Redis connections keep Jest alive.

```typescript
it('stores job keys under the streamtube-test prefix', async () => {
  const jobId = `test-${randomUUID()}`;
  await queue.add(PROCESS_VIDEO_JOB, { videoId: randomUUID() }, { jobId });

  const redis = await queue.getBackend().client; // bullmq v6: no queue.client
  const testJobHash = await redis.hgetall(
    `streamtube-test:${VIDEO_PROCESSING_QUEUE}:${jobId}`,
  );
  expect(testJobHash.name).toBe(PROCESS_VIDEO_JOB);
});
```

---

## FFmpeg / ffprobe — Real binary (Docker image)

**Strategy:** The real `ffmpeg`/`ffprobe` installed in `Dockerfile.dev`. No committed media fixtures and no mocked probe output in integration tests.

- Generate fixtures at test time with `src/test/video-fixtures.ts` (`generateVideoFixture(...)`, `generateThumbnailFixture()`), which encode short `testsrc` clips with the requested codecs.
- Pure classification rules (allowlist, container/codec mapping) stay in unit tests over plain `ffprobe`-shaped objects (`src/videos/video-format.spec.ts`).

---

## Email — Mailpit (Real SMTP Capture)

**Strategy:** Mailpit — a local SMTP server that captures all emails for inspection via its API. No emails are actually delivered.

**Setup:**
- Add Mailpit to `compose.yaml`:
```yaml
mailpit:
  image: axllent/mailpit
  ports:
    - "1025:1025"   # SMTP
    - "8025:8025"   # Web UI / API
```

**NestJS configuration:**
```typescript
// In mail module or config
{
  transport: {
    host: process.env.SMTP_HOST ?? 'localhost',
    port: Number(process.env.SMTP_PORT ?? 1025),
  },
}
```

**Integration test:**
```typescript
describe('MailService (integration)', () => {
  beforeEach(async () => {
    // Clear all captured emails via Mailpit API
    await fetch('http://localhost:8025/api/v1/messages', { method: 'DELETE' });
  });

  it('should send confirmation email', async () => {
    await mailService.sendConfirmation('user@test.com', 'token-123');

    // Query Mailpit API for captured emails
    const response = await fetch('http://localhost:8025/api/v1/messages');
    const data = await response.json();

    expect(data.messages).toHaveLength(1);
    expect(data.messages[0].To[0].Address).toBe('user@test.com');
    expect(data.messages[0].Subject).toContain('confirm');
  });
});
```

**Key points:**
- Mailpit captures ALL emails — no mocking, no side effects
- Use Mailpit's REST API (`http://localhost:8025/api/v1/messages`) to inspect sent emails
- Clear captured emails in `beforeEach` to ensure test isolation
- Web UI at `http://localhost:8025` for manual debugging
- Tests the full SMTP transport path — if the SMTP config is wrong, the test fails
