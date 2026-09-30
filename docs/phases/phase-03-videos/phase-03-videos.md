---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-28T14:42:02-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-09-28T14:26:28-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-28T14:29:31-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-09-28T09:49:16-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar no `nestjs-project/` o serviço de armazenamento de arquivos (vídeos e thumbnails) e o serviço de processamento em segundo plano (filas), permitindo upload de vídeos de até 10GB sem impacto na performance, com pré-cadastro automático do vídeo como rascunho ao iniciar o upload, processamento automático após o upload (extração de duração e metadados), geração automática de thumbnail a partir de um frame do vídeo, URL única por vídeo sem conflito, reprodução via streaming sem download completo e download do vídeo pelo usuário.

---

## Step Implementations

### SI-03.1 — Infra: MinIO, Redis, FFmpeg e variáveis de ambiente

**Description:** Sobe a infraestrutura de storage e fila no Compose, instala o FFmpeg na imagem de dev e expõe a configuração tipada que os SIs seguintes consomem.

**Technical actions:**

1. Adicionar ao `nestjs-project/compose.yaml` o serviço `minio` com imagem `pgsty/minio` em tag `RELEASE.*` fixa (per `phase-03-videos/TD-02`), `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`, portas `9000`/`9001`, volume nomeado e healthcheck; e o serviço `redis` com tag fixa, healthcheck e volume (per `phase-03-videos/TD-01`); `nestjs-api` passa a depender de ambos com `condition: service_healthy`.
2. Instalar `ffmpeg` (inclui `ffprobe`) no `nestjs-project/Dockerfile.dev` via `apt install` (per `phase-03-videos/TD-07`, `phase-03-videos/TD-12`).
3. Instalar `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `@nestjs/bullmq` e `bullmq` dentro do container (`docker compose exec nestjs-api npm install ...`), nas versões de `library-refs.md`.
4. Estender `src/config/env.validation.ts` com `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `REDIS_HOST`, `REDIS_PORT`, `QUEUE_PREFIX`; criar `src/config/storage.config.ts` e `src/config/queue.config.ts` com `registerAs('storage', ...)` / `registerAs('queue', ...)` e carregá-los no `ConfigModule.forRoot` do `AppModule`; documentar em `.env.example` com hosts pelos nomes de serviço do Compose (`S3_ENDPOINT=http://minio:9000`, `S3_PUBLIC_ENDPOINT=http://localhost:9000`, `REDIS_HOST=redis`) (per `phase-03-videos/TD-04`, `phase-01-configuracao-base/TD-03`).
5. Criar `src/test/test-env.ts` e registrá-lo em `setupFiles` (depois de `dotenv/config`) no Jest de `package.json` e em `test/jest-e2e.json`: define `QUEUE_PREFIX=streamtube-test` e `S3_PUBLIC_ENDPOINT=$S3_ENDPOINT`, porque de dentro do container `localhost:9000` não alcança o MinIO e a assinatura precisa usar o host que o teste acessa (per `phase-03-videos/TD-12`, `phase-03-videos/TD-04`).

**Tests:** _(empty — Infra; os serviços são exercitados pelos testes de integração de SI-03.2 e SI-03.3)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose ps` mostra `minio` e `redis` com status `healthy`.
- `docker compose exec nestjs-api ffprobe -version` e `docker compose exec nestjs-api ffmpeg -version` terminam com código 0.
- Subir a API sem `S3_BUCKET` ou sem `REDIS_HOST` falha no boot com erro de validação do Joi citando a variável.
- O console do MinIO responde em `http://localhost:9001` a partir do host.

---

### SI-03.2 — Criar StorageModule (cliente S3 interno e público)

**Description:** Encapsula todo acesso ao object storage num módulo próprio, com um cliente S3 para chamadas de servidor e outro para assinar URLs entregues ao navegador.

**Technical actions:**

1. Criar `src/storage/storage.module.ts` com dois providers `S3Client` (tokens `S3_INTERNAL_CLIENT` e `S3_PUBLIC_CLIENT`) construídos a partir de `storageConfig` com `forcePathStyle: true`, `region` e `credentials`; o interno usa `S3_ENDPOINT`, o público `S3_PUBLIC_ENDPOINT` (per `phase-03-videos/TD-04`, `phase-03-videos/TD-02`).
2. Criar `src/storage/storage.service.ts` com `onModuleInit` idempotente (`HeadBucketCommand` → `CreateBucketCommand` quando ausente) e os helpers de chave `originalKey(videoId)` → `videos/{videoId}/original` e `thumbnailKey(videoId)` → `videos/{videoId}/thumbnail.jpg` (per `phase-03-videos/TD-03`).
3. Implementar as operações multipart no `StorageService`: `createMultipartUpload(key, contentType)`, `presignUploadPart(key, uploadId, partNumber)` (cliente público, `expiresIn: 3600`), `listParts(key, uploadId)` (paginando por `PartNumberMarker`), `completeMultipartUpload(key, uploadId, parts)` e `abortMultipartUpload(key, uploadId)` que ignora `NoSuchUpload` (per `phase-03-videos/TD-05`).
4. Implementar as operações de objeto: `headObject(key)`, `getObjectStream(key, range?)` devolvendo `Body` como `Readable` + `ContentLength`/`ContentRange`, `putObject(key, body, contentType)`, `deleteObject(key)` e `presignGetObject(key)` (cliente interno, `expiresIn: 900`) (per `phase-03-videos/TD-08`, `phase-03-videos/TD-10`).
5. Exportar `StorageService` do módulo.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageModule` | Unit: compilation test | `src/storage/storage.module.spec.ts` |
| `StorageService` | Integration: MinIO real — bucket criado, multipart de 1 parte via URL pré-assinada, `listParts`, `complete`, `headObject`, `getObjectStream` com `Range`, `abort` idempotente | `src/storage/storage.service.integration-spec.ts` |

**Dependencies:** SI-03.1 — MinIO, SDK e `storageConfig` precisam existir.

**Acceptance criteria:**

- Com o bucket ausente, iniciar o módulo cria o bucket `S3_BUCKET`; iniciar de novo não gera erro.
- Uma parte enviada por `PUT` na URL devolvida por `presignUploadPart` aparece em `listParts` com seu `PartNumber` e `ETag`.
- `getObjectStream(key, 'bytes=0-9')` devolve exatamente 10 bytes e `ContentRange` `bytes 0-9/{tamanho}`.
- `abortMultipartUpload` sobre um `uploadId` já abortado termina sem lançar erro.

---

### SI-03.3 — Criar QueueModule (conexão BullMQ com Redis)

**Description:** Centraliza a conexão com o Redis e o prefixo da fila, compartilhados pela API (produtora) e pelo worker (consumidor).

**Technical actions:**

1. Criar `src/queue/queue.constants.ts` com `VIDEO_PROCESSING_QUEUE = 'video-processing'`, `PROCESS_VIDEO_JOB = 'process-video'` e `CLEANUP_STALE_UPLOADS_JOB = 'cleanup-stale-uploads'` (per § Events/Messages).
2. Criar `src/queue/queue.module.ts` com `BullModule.forRootAsync({ inject: [queueConfig.KEY], useFactory })` devolvendo `connection: { host, port }` e `prefix` de `QUEUE_PREFIX` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-12`).
3. Importar `QueueModule` no `AppModule`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueModule` | Integration: Redis real — módulo inicia, uma fila registrada aceita `add`/`getJob`, e as chaves no Redis usam o prefixo `streamtube-test` | `src/queue/queue.module.integration-spec.ts` |

**Dependencies:** SI-03.1 — Redis, `@nestjs/bullmq` e `queueConfig` precisam existir.

**Acceptance criteria:**

- Com `REDIS_HOST=redis`, a API inicia e conecta ao Redis sem erro.
- Um job adicionado em ambiente de teste é gravado sob chaves com prefixo `streamtube-test`, não `streamtube`.
- Com o Redis parado, o boot registra erro de conexão citando o host `redis`.

---

### SI-03.4 — Criar entidade Video, migration e gerador de slug

**Description:** Materializa a tabela `videos` do § Data Model e o gerador de slug não enumerável, base de todos os endpoints de vídeo.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` conforme § Data Model → `Video`: enum `VideoStatus` (`draft`, `processing`, `ready`, `failed`), `@ManyToOne(() => Channel)` via `channel_id` com `onDelete: 'CASCADE'`, `transformer` de `bigint` → `number` em `size_bytes` e colunas de metadados nullable (per `phase-03-videos/TD-11`, `phase-03-videos/TD-08`).
2. Criar migration `src/database/migrations/{timestamp}-CreateVideos.ts` com o tipo `video_status`, a tabela, o `UNIQUE` em `slug`, o índice em `channel_id` e o índice (`status`, `created_at`); `down` na ordem inversa (per `phase-03-videos/TD-09`).
3. Criar `src/videos/video-slug.util.ts` com `generateVideoSlug()` = `randomBytes(9).toString('base64url').slice(0, VIDEO_SLUG_LENGTH)` (11 caracteres, ≈66 bits), usando `node:crypto` (per `phase-03-videos/TD-09`).
4. Criar `src/videos/videos.constants.ts` com as constantes de § Data Model → Constantes de upload e formato.
5. Criar `src/videos/videos.module.ts` com `TypeOrmModule.forFeature([Video])` e registrá-lo no `AppModule`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: `slug` único, `status` default `draft`, enum rejeita valor fora da lista, `size_bytes` de 10737418240 volta como `number`, cascade ao remover o canal | `src/videos/entities/video.entity.integration-spec.ts` |
| `generateVideoSlug` | Unit: 11 caracteres no alfabeto base64url, valores distintos em chamadas sucessivas | `src/videos/video-slug.util.spec.ts` |

**Dependencies:** none — só depende de `channels` (Fase 02).

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos` e o tipo `video_status`; `npm run migration:revert` remove ambos.
- Inserir dois vídeos com o mesmo `slug` viola a constraint `UNIQUE`.
- Um vídeo inserido sem `status` é persistido como `draft`.
- Remover um canal remove os vídeos dele.

---

### SI-03.5 — Endpoint POST /videos (pré-cadastro + início do multipart)

**Route:** POST /videos
**Test Specs:** see `nestjs-project/specs/videos-create.plan.md`
**Authorization:** Authenticated (per § Authorization Matrix)

**Description:** Pré-cadastra o vídeo como rascunho ao iniciar o upload e devolve as URLs pré-assinadas das partes, sem que a API receba bytes do vídeo.

**Technical actions:**

1. Criar `src/videos/video-format.ts` com a allowlist da camada 1 (§ Data Model → Allowlist de formatos) e `assertUploadFormat(filename, contentType)`; adicionar `UnsupportedVideoFormatException` (`UNSUPPORTED_VIDEO_FORMAT`, 422) e `VideoTooLargeException` (`VIDEO_TOO_LARGE`, 413) em `src/common/exceptions/domain.exception.ts` (per `phase-03-videos/TD-13`, `phase-02-auth/TD-07`).
2. Adicionar `ChannelsService.findByUserId(userId)` e importar `ChannelsModule` e `StorageModule` no `VideosModule`.
3. Implementar `VideosService.createDraft(userId, dto)`: teto `VIDEO_MAX_SIZE_BYTES`, allowlist, insert com `generateVideoSlug()` e retry em violação de `UNIQUE` do `slug` até `VIDEO_SLUG_MAX_RETRIES` (mesmo padrão de `ChannelsService`), `title` derivado do nome, `createMultipartUpload` em `videos/{videoId}/original`, grava `upload_id` e assina as `part_count` partes (per `phase-03-videos/TD-05`, `phase-03-videos/TD-09`, `phase-03-videos/TD-11`).
4. Criar `src/videos/dto/create-video.dto.ts` (`filename`, `content_type`, `size_bytes` conforme § API Contracts → Validation Rules) e o DTO de resposta com `@ApiProperty`.
5. Criar `src/videos/videos.controller.ts` com `POST /videos` retornando `201` no shape de § API Contracts → `POST /videos`, e `@ApiOperation`/`@ApiResponse` para 201, 400, 401, 413 e 422 (per `openapi-docs-nestjs/TD-01`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `video-format.ts` (camada 1) | Unit: MIME/extensão aceitos, rejeitados e incoerentes; extensão case-insensitive | `src/videos/video-format.spec.ts` |
| `VideosService.createDraft` | Unit: ramos de teto de tamanho, formato e retry de slug (repo e storage mockados) | `src/videos/videos.service.spec.ts` |
| `VideosService.createDraft` | Integration: Postgres + MinIO reais — vídeo `draft` persistido com `upload_id`, `part_count` coerente com `size_bytes`, URL de parte aceita `PUT` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.2 — operações multipart; SI-03.4 — entidade e gerador de slug.

**Acceptance criteria:**

- `POST /videos` autenticado com `{ filename: "clip.mp4", content_type: "video/mp4", size_bytes: 150000000 }` retorna `201` com `status: "draft"`, `slug` de 11 caracteres e `upload.part_count: 3`, com 3 URLs em `upload.parts`.
- O vídeo criado fica persistido com `status = draft` no canal do usuário autenticado.
- `POST /videos` com `content_type: "video/quicktime"` ou `filename: "clip.mov"` retorna `422` com `error: "UNSUPPORTED_VIDEO_FORMAT"`.
- `POST /videos` com `size_bytes: 10737418241` retorna `413` com `error: "VIDEO_TOO_LARGE"`.
- `POST /videos` sem `size_bytes` retorna `400` com `error: "VALIDATION_ERROR"`.
- `POST /videos` sem token retorna `401`.

---

### SI-03.6 — Endpoint GET /videos/{id}/upload (retomada do upload)

**Route:** GET /videos/{id}/upload
**Test Specs:** see `nestjs-project/specs/videos-upload-resume.plan.md`
**Authorization:** Owner (per § Authorization Matrix)

**Description:** Permite retomar um upload interrompido, informando as partes já recebidas e reassinando só as que faltam.

**Technical actions:**

1. Adicionar `VideoNotFoundException` (`VIDEO_NOT_FOUND`, 404) e `InvalidVideoStatusException` (`INVALID_VIDEO_STATUS`, 409) em `src/common/exceptions/domain.exception.ts`.
2. Implementar `VideosService.findOwnedOrFail(userId, id)`, que resolve o canal do usuário e busca por `id` + `channel_id`, lançando `VideoNotFoundException` também quando o vídeo é de outro canal.
3. Implementar `VideosService.getUploadStatus(userId, id)`: exige `status = draft`, chama `listParts` e reassina as partes ausentes de `1..part_count` (per `phase-03-videos/TD-05`).
4. Adicionar a rota ao `VideosController` com `ParseUUIDPipe` (`exceptionFactory` → `BadRequestException`, para cair em `VALIDATION_ERROR`) e decoradores OpenAPI para 200, 400, 401, 404 e 409.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getUploadStatus` | Unit: cálculo de partes faltantes, ramo de status ≠ `draft`, ramo de outro canal | `src/videos/videos.service.spec.ts` |
| `VideosService.getUploadStatus` | Integration: MinIO real — após enviar a parte 1 de 2, `uploaded_parts: [1]` e `parts` só com a parte 2 | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.5 — vídeo `draft` com `upload_id` e `VideosController`.

**Acceptance criteria:**

- `GET /videos/{id}/upload` pelo dono, com 1 de 3 partes enviada, retorna `200` com `upload.uploaded_parts: [1]` e URLs só para as partes 2 e 3.
- Com todas as partes enviadas, retorna `200` com `upload.parts: []`.
- `GET /videos/{id}/upload` de um vídeo de outro canal retorna `404` com `error: "VIDEO_NOT_FOUND"`.
- `GET /videos/{id}/upload` de um vídeo em `processing` retorna `409` com `error: "INVALID_VIDEO_STATUS"`.
- `GET /videos/nao-e-uuid/upload` retorna `400` com `error: "VALIDATION_ERROR"`.

---

### SI-03.7 — Endpoint POST /videos/{id}/upload/complete (conclusão + enfileiramento)

**Route:** POST /videos/{id}/upload/complete
**Test Specs:** see `nestjs-project/specs/videos-upload-complete.plan.md`
**Authorization:** Owner (per § Authorization Matrix)

**Description:** Conclui o multipart, valida o objeto no storage e dispara o processamento automático, levando o vídeo de `draft` a `processing`.

**Technical actions:**

1. Criar `src/videos/video-processing.queue.ts` (`VideoProcessingQueue`) com `@InjectQueue(VIDEO_PROCESSING_QUEUE)` e `enqueue(videoId)`, que chama `Queue.add(PROCESS_VIDEO_JOB, { videoId }, { jobId: videoId, attempts: 3, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: true })`; registrar `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })` no `VideosModule` (per `phase-03-videos/TD-06`, `phase-03-videos/TD-01`, `phase-03-videos/TD-11`).
2. Adicionar `UploadIncompleteException` (`UPLOAD_INCOMPLETE`, 409) em `src/common/exceptions/domain.exception.ts`.
3. Implementar `VideosService.completeUpload(userId, id)` na sequência de § API Contracts → `POST /videos/{id}/upload/complete`: `listParts` → exige `part_count` partes → `completeMultipartUpload` com as ETags do storage → `headObject`; acima do teto, chama `deleteObject`, grava `failed`/`FILE_TOO_LARGE` e lança `VideoTooLargeException`; senão grava `processing`, `size_bytes = ContentLength`, `upload_id = null` e enfileira (per `phase-03-videos/TD-05`, `phase-03-videos/TD-06`).
4. Adicionar a rota ao `VideosController` com `@HttpCode(202)` e decoradores OpenAPI para 202, 400, 401, 404, 409 e 413.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: ramos de partes faltantes, status ≠ `draft`, teto excedido (`FILE_TOO_LARGE`) e sucesso (storage e fila mockados) | `src/videos/videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration: Postgres + MinIO + Redis reais — objeto completo existe, status `processing`, job com `jobId` = id do vídeo na fila | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.3 — conexão da fila; SI-03.6 — `findOwnedOrFail` e exceções de status.

**Acceptance criteria:**

- `POST /videos/{id}/upload/complete` pelo dono, com todas as partes enviadas, retorna `202` com `status: "processing"`.
- Após a conclusão, o objeto `videos/{videoId}/original` existe no bucket e a fila `video-processing` tem um job `process-video` com `jobId` igual ao id do vídeo.
- Concluir com uma parte faltando retorna `409` com `error: "UPLOAD_INCOMPLETE"`, e o vídeo continua `draft`.
- Repetir a conclusão de um vídeo já em `processing` retorna `409` com `error: "INVALID_VIDEO_STATUS"` e não cria um segundo job.
- Concluir o vídeo de outro canal retorna `404` com `error: "VIDEO_NOT_FOUND"`.

---

### SI-03.8 — Endpoint GET /videos/{id} (leitura pelo dono)

**Route:** GET /videos/{id}
**Test Specs:** see `nestjs-project/specs/videos-get.plan.md`
**Authorization:** Owner (per § Authorization Matrix)

**Description:** Expõe ao dono o status, o motivo de falha e os metadados extraídos, tornando visível o resultado do processamento.

**Technical actions:**

1. Criar `src/videos/dto/video-response.dto.ts` com os campos de § API Contracts → `GET /videos/{id}` e `@ApiProperty` (enum de `status`, nullables), mais o mapper `toVideoResponse(video)` (per `phase-03-videos/TD-11`, `phase-03-videos/TD-08`).
2. Adicionar a rota ao `VideosController` usando `findOwnedOrFail` e decoradores OpenAPI para 200, 400, 401 e 404.

**Tests:** _(empty — controller coberto pelo spec E2E de /plan-test-specs; mapper sem ramificação)_

**Dependencies:** SI-03.6 — `findOwnedOrFail`.

**Acceptance criteria:**

- `GET /videos/{id}` pelo dono de um vídeo recém-criado retorna `200` com `status: "draft"` e metadados `null`.
- `GET /videos/{id}` de um vídeo `failed` retorna `200` com `failure_reason` preenchido.
- `GET /videos/{id}` de um vídeo de outro canal retorna `404` com `error: "VIDEO_NOT_FOUND"`.
- `GET /videos/{id}` sem token retorna `401`.

---

### SI-03.9.1 — Infra: WorkerModule, entrypoint e serviço video-worker (auto-split from SI-03.9 by /plan-build)

_Auto-split rationale: original SI would have 9 Technical actions; split per "infrastructure vs behavior"._

**Description:** Cria o processo de worker isolado da API, reaproveitando entidades, configs e o módulo de storage, e o coloca no Compose.

**Technical actions:**

1. Extrair as opções do `TypeOrmModule.forRootAsync` do `AppModule` para `src/database/typeorm-options.factory.ts` e usá-las no `AppModule` e no `WorkerModule`, mantendo `databaseConfig` como fonte única (per convenção herdada de `phase-01-configuracao-base/TD-04`).
2. Criar `src/worker/worker.module.ts` com `ConfigModule` (mesmos `load` e `validationSchema`), TypeORM, `QueueModule`, `StorageModule`, `TypeOrmModule.forFeature([Video])` e `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })`, sem controllers (per `phase-03-videos/TD-07`).
3. Criar `src/worker.ts` com `NestFactory.createApplicationContext(WorkerModule)` e `enableShutdownHooks()`; adicionar os scripts `start:worker` (`node dist/worker`) e `start:worker:dev` (`nest start --watch --entryFile worker`) ao `package.json`.
4. Adicionar ao `compose.yaml` o serviço `video-worker` com o mesmo `build`/volume do `nestjs-api`, `command: npm run start:worker:dev` e `depends_on` `db`, `redis` e `minio` saudáveis (per `phase-03-videos/TD-07`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `WorkerModule` | Integration: o contexto inicia contra Postgres, Redis e MinIO reais e fecha sem handles abertos | `src/worker/worker.module.integration-spec.ts` |

**Dependencies:** SI-03.2 — `StorageModule`; SI-03.3 — `QueueModule`; SI-03.4 — entidade `Video`.

**Acceptance criteria:**

- `docker compose up -d video-worker` sobe o serviço, e `docker compose logs video-worker` mostra o contexto Nest iniciado sem servidor HTTP.
- O serviço `video-worker` não publica porta no host.
- A API continua subindo e respondendo em `http://localhost:3000` após a extração das opções do TypeORM.

---

### SI-03.9.2 — Processar vídeo no worker (metadados, allowlist, thumbnail) (auto-split from SI-03.9 by /plan-build)

_Auto-split rationale: original SI would have 9 Technical actions; split per "infrastructure vs behavior"._

**Description:** Implementa o consumidor do job `process-video`: extrai duração e metadados, valida o formato e gera a thumbnail, levando o vídeo a `ready` ou `failed`.

**Technical actions:**

1. Criar `src/worker/ffmpeg.service.ts` com `probe(url)`, que chama `execFile('ffprobe', [...])` conforme § Events/Messages → `process-video` passo 3 e devolve o JSON tipado, e `extractThumbnail(url, seconds)`, que chama `execFile('ffmpeg', [...])` (passo 6) com `encoding: 'buffer'` e `maxBuffer` adequado e devolve `Buffer`; sem `fluent-ffmpeg` (per `phase-03-videos/TD-08`).
2. Estender `src/videos/video-format.ts` com a camada 2, `classifyProbe(probe)`, que devolve `{ container, video_codec, audio_codec }` ou lança `VideoProcessingFailure` com `NOT_A_VIDEO` ou `UNSUPPORTED_FORMAT`; criar `VideoProcessingFailure extends UnrecoverableError`, carregando `failure_reason` (per `phase-03-videos/TD-13`, `phase-03-videos/TD-11`).
3. Criar `src/worker/video.processor.ts` (`@Processor(VIDEO_PROCESSING_QUEUE)`, `extends WorkerHost`), que despacha `process-video` para os passos 1–7 de § Events/Messages: URL interna via `presignGetObject`, `probe`, `classifyProbe`, thumbnail em 10% da duração (frame 0 quando a duração é menor que 1s), `putObject` do JPEG e atualização condicional `WHERE status = 'processing'` para `ready` (per `phase-03-videos/TD-08`, `phase-03-videos/TD-11`).
4. Implementar `@OnWorkerEvent('failed')` no `VideoProcessor`: com `UnrecoverableError` ou `job.attemptsMade >= job.opts.attempts`, grava `failed` com o `failure_reason` do erro (`PROCESSING_ERROR` quando o erro não é classificado), na mesma atualização condicional.
5. Registrar `FfmpegService` e `VideoProcessor` como providers do `WorkerModule`; criar `src/test/video-fixtures.ts`, que gera vídeos de teste com `ffmpeg -f lavfi testsrc` (MP4 H.264+AAC de 2s, WebM VP9+Opus, MP4 com `mpeg4` e um arquivo de texto) (per `phase-03-videos/TD-12`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `classifyProbe` (camada 2) | Unit: combinações aceitas (`mp4`+`h264`+`aac`, `webm`+`vp9`+`opus`, sem áudio) e rejeitadas (`mpeg4`, `hevc`, MOV/MKV, sem stream de vídeo) | `src/videos/video-format.spec.ts` |
| `FfmpegService` | Integration: FFmpeg real sobre fixture gerado — duração ≈ 2s, 320x240, `h264`; thumbnail devolve JPEG válido | `src/worker/ffmpeg.service.integration-spec.ts` |
| `VideoProcessor` | Integration: worker in-process com Postgres, Redis e MinIO reais — fixture válido vira `ready` com metadados e `thumbnail.jpg`; `mpeg4` vira `failed`/`UNSUPPORTED_FORMAT` sem retry; arquivo de texto vira `failed`/`NOT_A_VIDEO`; vídeo fora de `processing` fica intacto | `src/worker/video.processor.integration-spec.ts` |

**Dependencies:** SI-03.9.1 — `WorkerModule`; SI-03.7 — contrato do job `process-video`.

**Acceptance criteria:**

- Após a conclusão do upload de um MP4 H.264/AAC de 2s, o vídeo chega a `ready` com `duration_seconds` ≈ 2, `width`, `height`, `video_codec: "h264"`, `audio_codec: "aac"` e `container: "mp4"`.
- O objeto `videos/{videoId}/thumbnail.jpg` existe no bucket com `ContentType` `image/jpeg` após o `ready`.
- Um MP4 com codec `mpeg4` termina em `failed` com `failure_reason = UNSUPPORTED_FORMAT` na primeira tentativa.
- Um arquivo que não é vídeo termina em `failed` com `failure_reason = NOT_A_VIDEO`.
- Um job cujo vídeo não está em `processing` termina sem alterar o registro.
- Um erro transitório que persiste nas 3 tentativas termina em `failed` com `failure_reason = PROCESSING_ERROR`.

---

### SI-03.10 — Endpoints GET /videos/{slug}/stream e /download (Range → 206)

**Route:** GET /videos/{slug}/stream, GET /videos/{slug}/download
**Test Specs:** see `nestjs-project/specs/videos-stream.plan.md`
**Authorization:** Anonymous, só para vídeos `ready` (per § Authorization Matrix)

**Description:** Entrega reprodução via streaming, com seek sem download completo, e o download do original a partir do bucket privado, em stream e sem bufferizar.

**Technical actions:**

1. Criar `src/videos/http-range.ts` com `parseRange(header, size)`, que devolve `{ start, end }`, `null` (sem Range, ou múltiplos intervalos → 200) ou `'unsatisfiable'`, e `buildContentDisposition(filename)`, com `filename` ASCII-safe e `filename*=UTF-8''` percent-encoded (per `phase-03-videos/TD-10`).
2. Adicionar `RangeNotSatisfiableException` (`RANGE_NOT_SATISFIABLE`, 416) em `src/common/exceptions/domain.exception.ts`.
3. Implementar `VideosService.findReadyBySlugOrFail(slug)` (lança `VideoNotFoundException` quando o vídeo não existe ou não está `ready`) e `VideosService.openStream(slug, rangeHeader)`, que chama `getObjectStream(originalKey, 'bytes=start-end')` e devolve o vídeo, o intervalo e o `Readable` (per `phase-03-videos/TD-10`, `phase-03-videos/TD-03`).
4. Adicionar ao `VideosController` as duas rotas com `@Public()` e `@Res()`: definem `Content-Type` (pelo `container`), `Content-Length`, `Accept-Ranges: bytes`, `Content-Range` e status `206`/`200`, fazem `pipeline(body, res)` e, só no `/download`, acrescentam `Content-Disposition: attachment`. No `416`, definem `Content-Range: bytes */{size_bytes}` antes de lançar a exceção. Incluir decoradores OpenAPI para 200, 206, 404 e 416.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `parseRange` / `buildContentDisposition` | Unit: `bytes=0-99`, `bytes=100-`, `bytes=-50`, fim além do tamanho (clamp), `start ≥ size`, `start > end`, sintaxe inválida, múltiplos intervalos; nome com acento e aspas | `src/videos/http-range.spec.ts` |
| `VideosService.openStream` | Unit: ramos de vídeo inexistente, não `ready`, com e sem Range, e Range inválido | `src/videos/videos.service.spec.ts` |

**Dependencies:** SI-03.9.2 — vídeos só chegam a `ready` pelo worker.

**Acceptance criteria:**

- `GET /videos/{slug}/stream` sem token e com `Range: bytes=0-1023` de um vídeo `ready` retorna `206` com 1024 bytes, `Content-Range: bytes 0-1023/{size_bytes}` e `Accept-Ranges: bytes`.
- `GET /videos/{slug}/stream` sem `Range` retorna `200` com `Content-Length` igual a `size_bytes` e o corpo idêntico ao arquivo enviado.
- `GET /videos/{slug}/stream` com `Range: bytes={size_bytes}-` retorna `416` com `error: "RANGE_NOT_SATISFIABLE"` e `Content-Range: bytes */{size_bytes}`.
- `GET /videos/{slug}/download` retorna `Content-Disposition: attachment` com o `original_filename`.
- `GET /videos/{slug}/stream` de um vídeo `processing` ou `draft`, ou de um slug inexistente, retorna `404` com `error: "VIDEO_NOT_FOUND"`.

---

### SI-03.11 — Endpoint GET /videos/{slug}/thumbnail

**Route:** GET /videos/{slug}/thumbnail
**Test Specs:** see `nestjs-project/specs/videos-thumbnail.plan.md`
**Authorization:** Anonymous, só para vídeos `ready` (per § Authorization Matrix)

**Description:** Serve pela API a thumbnail gerada no processamento, mantendo o bucket privado.

**Technical actions:**

1. Implementar `VideosService.openThumbnail(slug)`: `findReadyBySlugOrFail`, depois `getObjectStream(thumbnailKey(videoId))` (per `phase-03-videos/TD-10`, `phase-03-videos/TD-03`).
2. Adicionar a rota `@Public()` ao `VideosController` com `Content-Type: image/jpeg`, `Content-Length` e `pipeline(body, res)`, e decoradores OpenAPI para 200 e 404.

**Tests:** _(empty — reusa `findReadyBySlugOrFail` testado em SI-03.10; comportamento HTTP coberto pelo spec E2E)_

**Dependencies:** SI-03.10 — `findReadyBySlugOrFail` e padrão de stream no controller.

**Acceptance criteria:**

- `GET /videos/{slug}/thumbnail` sem token, de um vídeo `ready`, retorna `200` com `Content-Type: image/jpeg` e um corpo JPEG válido.
- `GET /videos/{slug}/thumbnail` de um vídeo fora de `ready`, ou de um slug inexistente, retorna `404` com `error: "VIDEO_NOT_FOUND"`.

---

### SI-03.12 — Limpar uploads multipart abandonados (job agendado)

**Description:** Aborta os multiparts de rascunhos nunca concluídos e marca esses vídeos como falhos, evitando partes órfãs no storage.

**Technical actions:**

1. Criar `src/videos/video-upload-cleanup.service.ts` com `cleanupStaleUploads(now)`: busca vídeos `draft` com `created_at < now - VIDEO_STALE_UPLOAD_HOURS`, chama `abortMultipartUpload` (ignorando `NoSuchUpload`) e faz a atualização condicional `status = failed`, `failure_reason = UPLOAD_EXPIRED`, `upload_id = null` `WHERE status = 'draft'` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-11`).
2. Despachar `CLEANUP_STALE_UPLOADS_JOB` no `VideoProcessor.process` para o serviço acima.
3. Criar `src/worker/video-jobs.scheduler.ts` (`OnApplicationBootstrap`) que chama `queue.upsertJobScheduler('cleanup-stale-uploads', { every: 3600000 })`, e registrá-lo com o serviço no `WorkerModule`. A assinatura de `upsertJobScheduler` não está em `library-refs.md`: consultar a documentação do `bullmq` via context7 antes de implementar (per `phase-03-videos/TD-01`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoUploadCleanupService` | Integration: Postgres + MinIO reais — rascunho com multipart aberto há mais de 24h vira `failed`/`UPLOAD_EXPIRED` e o upload some de `listParts`; rascunho recente e vídeo `processing` ficam intactos | `src/videos/video-upload-cleanup.service.integration-spec.ts` |
| `VideoJobsScheduler` | Integration: Redis real — após o bootstrap existe exatamente um job scheduler `cleanup-stale-uploads`, mesmo após dois bootstraps | `src/worker/video-jobs.scheduler.integration-spec.ts` |

**Dependencies:** SI-03.9.2 — `VideoProcessor` e `WorkerModule`.

**Acceptance criteria:**

- Um vídeo `draft` criado há mais de 24h fica `failed` com `failure_reason = UPLOAD_EXPIRED` e `upload_id = null` após a execução do job.
- O multipart desse vídeo deixa de existir no storage.
- Um vídeo `draft` criado há menos de 24h permanece `draft` com `upload_id` preservado.
- Reiniciar o `video-worker` não cria agendamentos duplicados de `cleanup-stale-uploads`.

---

### SI-03.13 — Atualizar openapi.json e documentação do ambiente

**Description:** Mantém o contrato OpenAPI commitado e a documentação de ambiente em sincronia com os novos endpoints e serviços.

**Technical actions:**

1. Regenerar `nestjs-project/openapi.json` com `npm run openapi:export` dentro do container e commitá-lo (per `openapi-docs-nestjs/TD-02`).
2. Atualizar `nestjs-project/CLAUDE.md` → "Development Environment" e "Environment Startup Verification" com os serviços `minio`, `redis` e `video-worker` e suas verificações de prontidão (`docker compose exec redis redis-cli ping`, healthcheck do MinIO).

**Tests:** _(empty — documentação e artefato gerado; sem comportamento novo)_

**Dependencies:** SI-03.5, SI-03.6, SI-03.7, SI-03.8, SI-03.10, SI-03.11 — todos os endpoints precisam existir; SI-03.9.1 — serviço `video-worker`.

**Acceptance criteria:**

- `openapi.json` contém as 7 operações de § API Contracts, com respostas por status e o envelope de erro.
- `nestjs-project/CLAUDE.md` lista `minio`, `redis` e `video-worker` com o comando de verificação de cada um.

---

## Technical Specifications

### Data Model

#### Video

Tabela `videos` (per `phase-03-videos/TD-09`, `phase-03-videos/TD-11`, `phase-03-videos/TD-08`, `phase-03-videos/TD-13`). Pertence ao canal do usuário autenticado (um usuário tem exatamente um `Channel`).

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated |
| slug | varchar(11) | unique, not null — 11 caracteres base64url de `crypto.randomBytes` (per `phase-03-videos/TD-09`) |
| channel_id | uuid | FK → `channels.id` ON DELETE CASCADE, not null |
| title | varchar(100) | not null — inicializado com `original_filename` sem extensão, truncado em 100 (editável na Fase 04) |
| original_filename | varchar(255) | not null — usado no `Content-Disposition` do download |
| mime_type | varchar(50) | not null — MIME declarado no pré-cadastro, já validado pela allowlist (`video/mp4` \| `video/webm`) |
| size_bytes | bigint | not null — tamanho declarado no pré-cadastro; sobrescrito pelo `ContentLength` do `HeadObject` na conclusão (per `phase-03-videos/TD-05`, `phase-03-videos/TD-08`) |
| upload_id | text | nullable — `UploadId` do multipart; zerado (`null`) após `CompleteMultipartUpload` ou abort |
| status | enum `video_status` (`draft`, `processing`, `ready`, `failed`) | not null, default `draft` (per `phase-03-videos/TD-11`) |
| failure_reason | varchar(50) | nullable — preenchido somente quando `status = failed`; valores em § Events/Messages → Failure reasons |
| duration_seconds | double precision | nullable — preenchido pelo worker |
| width | integer | nullable |
| height | integer | nullable |
| video_codec | varchar(32) | nullable — `codec_name` do stream de vídeo do `ffprobe` |
| audio_codec | varchar(32) | nullable — `codec_name` do stream de áudio; permanece `null` em vídeo sem áudio |
| container | varchar(16) | nullable — valor canônico `mp4` \| `webm` derivado de `format_name` + codecs |
| bitrate | integer | nullable — `format.bit_rate` do `ffprobe` (bits/s) |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now(), atualizado a cada save |

**Relations:** `Channel` has many `Video` (one-to-many); `Video` many-to-one `Channel` via `channel_id`.
**Indexes:** unique on `slug`; index on `channel_id`; index on (`status`, `created_at`) para a varredura de uploads abandonados.
**Notes:**
- `size_bytes` é `bigint`: o driver `pg` devolve string. A entidade usa um `transformer` (`to: v => v`, `from: v => v === null ? null : Number(v)`) para expor `number`; 10GB (10737418240) está abaixo de `Number.MAX_SAFE_INTEGER`.
- Chaves no storage são derivadas do `id` e nunca persistidas: `videos/{videoId}/original` e `videos/{videoId}/thumbnail.jpg` (per `phase-03-videos/TD-03`).
- O enum `video_status` é só o estado técnico do arquivo; publicação/visibilidade (Fase 04) viverá em colunas próprias (per `phase-03-videos/TD-11`).
- Migration nova em `src/database/migrations/` cria o tipo `video_status`, a tabela e os índices; `down` remove na ordem inversa.

#### Constantes de upload e formato (código, não persistidas)

| Constante | Valor | Origem |
|-----------|-------|--------|
| `VIDEO_MAX_SIZE_BYTES` | `10737418240` (10 GiB) | `phase-03-videos/TD-05` |
| `VIDEO_PART_SIZE_BYTES` | `67108864` (64 MiB) | `phase-03-videos/TD-05` |
| `VIDEO_PART_URL_EXPIRES_SECONDS` | `3600` | `phase-03-videos/TD-05` |
| `VIDEO_SLUG_LENGTH` | `11` | `phase-03-videos/TD-09` |
| `VIDEO_SLUG_MAX_RETRIES` | `5` | `phase-03-videos/TD-09` (mesmo padrão de retry do nickname em `ChannelsService`) |
| `VIDEO_STALE_UPLOAD_HOURS` | `24` | `phase-03-videos/TD-03` (limpeza de multipart incompleto) |

**Allowlist de formatos** (per `phase-03-videos/TD-13`, sem AV1 nesta fase):

| Camada | Container | Vídeo (`codec_name`) | Áudio (`codec_name`) |
|--------|-----------|----------------------|----------------------|
| 1 — pré-cadastro (MIME + extensão declarados) | `video/mp4` + `.mp4`; `video/webm` + `.webm` | — | — |
| 2 — worker (`ffprobe`, autoritativa) | `format_name` contém `mp4` → `mp4` | `h264` | `aac`, `mp3` ou sem áudio |
| 2 — worker (`ffprobe`, autoritativa) | `format_name` contém `webm` → `webm` | `vp8`, `vp9` | `opus`, `vorbis` ou sem áudio |

A camada 2 combina container e codecs porque o `ffprobe` reporta MP4/MOV (`mov,mp4,m4a,3gp,3g2,mj2`) e MKV/WebM (`matroska,webm`) pelo mesmo demuxer; qualquer combinação fora da tabela é rejeitada.

### API Contracts

Convenções herdadas: corpo JSON em snake_case; erros no envelope `{ statusCode, error, message }` (per `phase-02-auth/TD-07`); erro de validação de DTO em `400 VALIDATION_ERROR` via `ValidationExceptionFilter`; rotas autenticadas pelo `JwtAuthGuard` global (`APP_GUARD`), rotas abertas marcadas com `@Public()`; cada endpoint documentado com `@ApiOperation`/`@ApiResponse`/`@ApiParam` explícitos (per `openapi-docs-nestjs/TD-01`). Rotas do dono usam o `id` (uuid, `ParseUUIDPipe`); rotas públicas usam o `slug` (per `phase-03-videos/TD-09`, `phase-03-videos/TD-10`). Vídeo inexistente e vídeo de outro canal respondem igual (`404 VIDEO_NOT_FOUND`) para não revelar existência.

#### POST /videos (SI-03.5)

Pré-cadastra o vídeo como `draft`, inicia o multipart (`CreateMultipartUpload`) e devolve as URLs pré-assinadas de `UploadPart` de todas as partes (per `phase-03-videos/TD-05`, `phase-03-videos/TD-11`, `phase-03-videos/TD-13`). As URLs são assinadas com o cliente S3 do endpoint público (`S3_PUBLIC_ENDPOINT`, per `phase-03-videos/TD-04`).

**Request headers:**
- Authorization: Bearer {access_token}
- Content-Type: application/json

**Request body:**
- filename: string, required — 1..255 caracteres; extensão `.mp4` ou `.webm` (case-insensitive)
- content_type: string, required — `video/mp4` ou `video/webm`, coerente com a extensão
- size_bytes: integer, required — ≥ 1; limite de `VIDEO_MAX_SIZE_BYTES` checado no service

**Response 201:**
- id: string (uuid)
- slug: string (11 caracteres)
- status: `"draft"`
- upload: object
  - part_size: integer (`67108864`)
  - part_count: integer (`ceil(size_bytes / part_size)`)
  - expires_at: string (ISO-8601, agora + 3600s)
  - parts: array de `{ part_number: integer (1..part_count), url: string }`

**Error responses:**
- 401: sem token ou token inválido (guard global)
- 400 VALIDATION_ERROR: corpo fora do schema (campo ausente, tipo errado, `filename` > 255)
- 422 UNSUPPORTED_VIDEO_FORMAT: `content_type` ou extensão fora da allowlist, ou extensão incoerente com o MIME
- 413 VIDEO_TOO_LARGE: `size_bytes` > `VIDEO_MAX_SIZE_BYTES`

---

#### GET /videos/{id}/upload (SI-03.6)

Retomada do upload: lista as partes já recebidas (`ListParts`, paginando por `PartNumberMarker`) e reassina apenas as que faltam (per `phase-03-videos/TD-05`).

**Request headers:**
- Authorization: Bearer {access_token}

**Path parameters:**
- id: string (uuid), required

**Response 200:**
- id: string (uuid)
- status: `"draft"`
- upload: object
  - part_size: integer
  - part_count: integer
  - expires_at: string (ISO-8601)
  - uploaded_parts: array de integer (números das partes já presentes no storage, em ordem crescente)
  - parts: array de `{ part_number: integer, url: string }` — somente as partes faltantes (vazio quando todas foram enviadas)

**Error responses:**
- 401: sem token ou token inválido
- 400 VALIDATION_ERROR: `id` não é uuid
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal
- 409 INVALID_VIDEO_STATUS: `status` diferente de `draft`

---

#### POST /videos/{id}/upload/complete (SI-03.7)

Conclui o multipart e enfileira o processamento (per `phase-03-videos/TD-06`). Sequência: `ListParts` → exige `part_count` partes → `CompleteMultipartUpload` com as partes/ETags obtidas do storage (o cliente não envia ETags) → `HeadObject` (existe, `ContentLength` ≤ `VIDEO_MAX_SIZE_BYTES`) → `status = processing`, `size_bytes = ContentLength`, `upload_id = null` → `Queue.add()` com `jobId` = id do vídeo. Repetir a chamada com `status = processing` não reenfileira (o `jobId` fixo também impede duplicidade).

**Request headers:**
- Authorization: Bearer {access_token}

**Path parameters:**
- id: string (uuid), required

**Request body:** nenhum.

**Response 202:**
- id: string (uuid)
- slug: string
- status: `"processing"`

**Error responses:**
- 401: sem token ou token inválido
- 400 VALIDATION_ERROR: `id` não é uuid
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal
- 409 INVALID_VIDEO_STATUS: `status` diferente de `draft`
- 409 UPLOAD_INCOMPLETE: `ListParts` devolve menos partes que `part_count`
- 413 VIDEO_TOO_LARGE: `ContentLength` do `HeadObject` > `VIDEO_MAX_SIZE_BYTES` — o objeto é removido (`DeleteObject`) e o vídeo vai a `failed` com `failure_reason = FILE_TOO_LARGE` antes da resposta

---

#### GET /videos/{id} (SI-03.8)

Leitura do vídeo pelo dono, incluindo status, motivo de falha e metadados extraídos (per `phase-03-videos/TD-11`, `phase-03-videos/TD-08`).

**Request headers:**
- Authorization: Bearer {access_token}

**Path parameters:**
- id: string (uuid), required

**Response 200:**
- id: string (uuid)
- slug: string
- title: string
- original_filename: string
- mime_type: string
- size_bytes: integer
- status: `"draft"` | `"processing"` | `"ready"` | `"failed"`
- failure_reason: string | null
- duration_seconds: number | null
- width: integer | null
- height: integer | null
- video_codec: string | null
- audio_codec: string | null
- container: `"mp4"` | `"webm"` | null
- bitrate: integer | null
- created_at: string (ISO-8601)
- updated_at: string (ISO-8601)

**Error responses:**
- 401: sem token ou token inválido
- 400 VALIDATION_ERROR: `id` não é uuid
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal

---

#### GET /videos/{slug}/stream (SI-03.10)

`@Public()`. Transmite o original do bucket privado sem bufferizar: lê o header `Range`, chama `GetObject` com o mesmo intervalo e faz pipe do `Body` para a resposta (per `phase-03-videos/TD-10`). Disponível apenas para vídeos `ready`.

**Request headers:**
- Range: `bytes=start-end` | `bytes=start-` | `bytes=-suffix`, optional — um único intervalo; múltiplos intervalos são ignorados (resposta 200 completa)

**Path parameters:**
- slug: string, required

**Response 206:** (com `Range` válido)
- headers: `Content-Type` (`video/mp4` \| `video/webm`, derivado de `container`), `Content-Length` (tamanho do intervalo), `Content-Range: bytes start-end/size_bytes`, `Accept-Ranges: bytes`
- body: bytes do intervalo

**Response 200:** (sem `Range`)
- headers: `Content-Type`, `Content-Length: size_bytes`, `Accept-Ranges: bytes`
- body: arquivo completo em stream

**Error responses:**
- 404 VIDEO_NOT_FOUND: slug inexistente ou vídeo com `status` diferente de `ready`
- 416 RANGE_NOT_SATISFIABLE: `start` ≥ `size_bytes`, `start` > `end` ou sintaxe inválida — com header `Content-Range: bytes */{size_bytes}`

---

#### GET /videos/{slug}/download (SI-03.10)

`@Public()`. Mesmo comportamento de `GET /videos/{slug}/stream` (inclusive `Range` → `206`, permitindo retomar o download), acrescentando `Content-Disposition: attachment` com o nome original (per `phase-03-videos/TD-10`).

**Request headers:**
- Range: igual a `/stream`, optional

**Path parameters:**
- slug: string, required

**Response 200 / 206:**
- headers: os mesmos de `/stream` + `Content-Disposition: attachment; filename="{original_filename ASCII-safe}"; filename*=UTF-8''{original_filename percent-encoded}`
- body: arquivo (ou intervalo) em stream

**Error responses:**
- 404 VIDEO_NOT_FOUND: slug inexistente ou vídeo com `status` diferente de `ready`
- 416 RANGE_NOT_SATISFIABLE: igual a `/stream`

---

#### GET /videos/{slug}/thumbnail (SI-03.11)

`@Public()`. Serve `videos/{videoId}/thumbnail.jpg` do bucket privado pela API, no mesmo padrão de stream (per `phase-03-videos/TD-10` — Revisions 2026-09-28, `phase-03-videos/TD-03`).

**Path parameters:**
- slug: string, required

**Response 200:**
- headers: `Content-Type: image/jpeg`, `Content-Length`
- body: JPEG em stream

**Error responses:**
- 404 VIDEO_NOT_FOUND: slug inexistente ou vídeo com `status` diferente de `ready`

---

#### Validation Rules — Videos

- `filename`: `@IsString()`, `@IsNotEmpty()`, `@MaxLength(255)`; a checagem de extensão fica no service (gera `422 UNSUPPORTED_VIDEO_FORMAT`, não `400`)
- `content_type`: `@IsString()`, `@IsNotEmpty()`; a checagem de allowlist fica no service (gera `422 UNSUPPORTED_VIDEO_FORMAT`)
- `size_bytes`: `@IsInt()`, `@Min(1)`; o teto `VIDEO_MAX_SIZE_BYTES` fica no service (gera `413 VIDEO_TOO_LARGE`)
- `id` (path): `ParseUUIDPipe` com `exceptionFactory` que lança `BadRequestException`, para cair no envelope `VALIDATION_ERROR`
- `slug` (path): sem validação de formato; slug malformado resulta em `404 VIDEO_NOT_FOUND` pela busca

### Authorization Matrix

"Owner" = usuário autenticado cujo `Channel.id` é o `channel_id` do vídeo (resolvido a partir de `JwtPayload.sub` → `channels.user_id`). Endpoints públicos usam `@Public()` sobre o `JwtAuthGuard` global; a proteção deles é o slug não enumerável + a restrição a `status = ready` (per `phase-03-videos/TD-10`, `phase-03-videos/TD-09`). Controle de visibilidade/rascunho editorial fica para a Fase 04.

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|---------------|-------|
| POST /videos | ✗ (401) | ✓ (vídeo criado no próprio canal) | — |
| GET /videos/{id}/upload | ✗ (401) | ✗ (404) | ✓ |
| POST /videos/{id}/upload/complete | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/{id} | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/{slug}/stream | ✓ (só `ready`) | ✓ (só `ready`) | ✓ (só `ready`) |
| GET /videos/{slug}/download | ✓ (só `ready`) | ✓ (só `ready`) | ✓ (só `ready`) |
| GET /videos/{slug}/thumbnail | ✓ (só `ready`) | ✓ (só `ready`) | ✓ (só `ready`) |

### Error Catalog

Formato herdado de `phase-02-auth/TD-07`: `{ statusCode, error, message }`, lançado via subclasses de `DomainException` em `src/common/exceptions/domain.exception.ts` e renderizado pelo `DomainExceptionFilter` global.

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | `id` inexistente ou de outro canal (rotas do dono); `slug` inexistente ou vídeo fora de `ready` (rotas públicas) |
| UNSUPPORTED_VIDEO_FORMAT | 422 | Pré-cadastro com `content_type` ou extensão fora da allowlist, ou extensão incoerente com o MIME (per `phase-03-videos/TD-13`, camada 1) |
| VIDEO_TOO_LARGE | 413 | `size_bytes` declarado > 10 GiB no pré-cadastro, ou `ContentLength` do `HeadObject` > 10 GiB na conclusão (per `phase-03-videos/TD-05`) |
| INVALID_VIDEO_STATUS | 409 | Retomada ou conclusão de upload com vídeo fora de `draft` |
| UPLOAD_INCOMPLETE | 409 | Conclusão com menos partes no storage que `part_count` |
| RANGE_NOT_SATISFIABLE | 416 | `Range` inválido ou fora de `[0, size_bytes)` em `/stream` ou `/download`; resposta inclui `Content-Range: bytes */{size_bytes}` |

### Events/Messages

Fila BullMQ `video-processing` sobre o Redis do Compose (serviço `redis`, per `phase-03-videos/TD-01`). Conexão via `BullModule.forRootAsync` com host/porta do `queue.config.ts` e `prefix` vindo de `QUEUE_PREFIX` (default `streamtube`); os testes usam um prefixo próprio (`streamtube-test`) para não concorrer com o `video-worker` de dev (per `phase-03-videos/TD-12`). Consumidor único: `VideoProcessor` (`@Processor('video-processing')`, `extends WorkerHost`), que despacha por `job.name`. Em produção/dev roda no serviço Compose `video-worker` (`worker.ts` → `NestFactory.createApplicationContext(WorkerModule)`, mesma imagem com FFmpeg, per `phase-03-videos/TD-07`); nos testes roda in-process (per `phase-03-videos/TD-12`).

#### process-video

**Payload:**

```json
{ "videoId": "uuid" }
```

**Job options:** `jobId` = `videoId`; `attempts: 3`; `backoff: { type: 'exponential', delay: 1000 }`; `removeOnComplete: true`.
**Producer:** `VideosService` via `VideoProcessingQueue` (`@InjectQueue('video-processing')`) em `POST /videos/{id}/upload/complete` (per `phase-03-videos/TD-06`)
**Consumer:** `VideoProcessor` no `WorkerModule` (per `phase-03-videos/TD-07`)
**Trigger:** conclusão bem-sucedida do multipart, logo após a transição `draft → processing`.
**Delivery semantics:** at-least-once (per `phase-03-videos/TD-01`); o consumidor é idempotente: só age se o vídeo estiver em `processing`, caso contrário encerra o job sem efeito (per `phase-03-videos/TD-11`).

**Processamento** (per `phase-03-videos/TD-08`, `phase-03-videos/TD-13`):

1. Carrega o vídeo; se não existir ou `status ≠ processing`, retorna sem efeito.
2. Gera URL pré-assinada de `GetObject` para `videos/{videoId}/original` com o cliente S3 **interno** (`S3_ENDPOINT`), `expiresIn: 900`.
3. `execFile('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', url])` — o FFmpeg lê só as faixas necessárias via HTTP `Range`.
4. Sem stream de vídeo → `UnrecoverableError` com motivo `NOT_A_VIDEO`.
5. Aplica a allowlist da camada 2 (§ Data Model) sobre `format_name` e `codec_name`; fora dela → `UnrecoverableError` com motivo `UNSUPPORTED_FORMAT`.
6. Thumbnail no instante de 10% da duração; duração < 1s usa o frame 0: `execFile('ffmpeg', ['-v', 'error', '-ss', t, '-i', url, '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'])` com `encoding: 'buffer'` → `PutObject` em `videos/{videoId}/thumbnail.jpg` com `ContentType: image/jpeg`.
7. Em uma única atualização condicional (`WHERE id = :id AND status = 'processing'`): `status = ready`, `duration_seconds`, `width`, `height`, `video_codec`, `audio_codec`, `container`, `bitrate`, `failure_reason = null`.

**Falhas:** erros transitórios (rede, storage, FFmpeg com código ≠ 0) propagam e usam o retry. No evento `@OnWorkerEvent('failed')`, se o erro é `UnrecoverableError` ou `job.attemptsMade >= job.opts.attempts`, o vídeo vai a `failed` com o `failure_reason` do erro (`PROCESSING_ERROR` para erros não classificados), com a mesma atualização condicional por `status = 'processing'`.

#### cleanup-stale-uploads

**Payload:**

```json
{}
```

**Job options:** agendado com `upsertJobScheduler('cleanup-stale-uploads', { every: 3600000 })`, a cada 1h.
**Producer:** `WorkerModule` no bootstrap do `video-worker` (idempotente: `upsert` não duplica o agendamento) (per `phase-03-videos/TD-03`)
**Consumer:** `VideoProcessor` (mesma classe, ramo por `job.name`)
**Trigger:** periódico.
**Delivery semantics:** at-least-once; cada vídeo é tratado de forma idempotente.

**Processamento:** busca vídeos com `status = draft` e `created_at < now() - VIDEO_STALE_UPLOAD_HOURS`; para cada um, `AbortMultipartUpload` (ignora `NoSuchUpload`) e, em seguida, a atualização condicional `status = failed`, `failure_reason = UPLOAD_EXPIRED`, `upload_id = null` `WHERE status = 'draft'`.

#### Failure reasons

Valores fechados gravados em `videos.failure_reason` (per `phase-03-videos/TD-11`, `phase-03-videos/TD-13`):

| failure_reason | Origem | Quando |
|----------------|--------|--------|
| `NOT_A_VIDEO` | worker (`UnrecoverableError`) | `ffprobe` não encontra stream de vídeo ou não reconhece o arquivo |
| `UNSUPPORTED_FORMAT` | worker (`UnrecoverableError`) | Combinação container/codecs fora da allowlist (camada 2) |
| `PROCESSING_ERROR` | worker (retries esgotados) | Falha transitória persistente após 3 tentativas |
| `FILE_TOO_LARGE` | API (`POST /videos/{id}/upload/complete`) | `HeadObject` acima de 10 GiB; o objeto é removido |
| `UPLOAD_EXPIRED` | worker (`cleanup-stale-uploads`) | Rascunho sem conclusão por mais de 24h; o multipart é abortado |

---

## Dependency Map

```
SI-03.1 (root)
├── SI-03.2 — depends on SI-03.1 (MinIO + SDK + storageConfig)
│   └── SI-03.5 — depends on SI-03.2 + SI-03.4 (multipart + entidade/slug)
│       └── SI-03.6 — depends on SI-03.5 (vídeo draft + controller)
│           ├── SI-03.7 — depends on SI-03.6 + SI-03.3 (findOwnedOrFail + fila)
│           │   └── SI-03.9.2 — depends on SI-03.7 + SI-03.9.1 (contrato do job + WorkerModule)
│           │       ├── SI-03.10 — depends on SI-03.9.2 (vídeos ready)
│           │       │   └── SI-03.11 — depends on SI-03.10 (findReadyBySlugOrFail)
│           │       └── SI-03.12 — depends on SI-03.9.2 (VideoProcessor)
│           └── SI-03.8 — depends on SI-03.6 (findOwnedOrFail)
├── SI-03.3 — depends on SI-03.1 (Redis + queueConfig)
└── SI-03.9.1 — depends on SI-03.2 + SI-03.3 + SI-03.4 (storage, fila, entidade)
SI-03.4 (root, independent)
SI-03.13 — depends on SI-03.5, SI-03.6, SI-03.7, SI-03.8, SI-03.9.1, SI-03.10, SI-03.11 (endpoints + serviço video-worker)
```

---

## Deliverables

- [ ] SI-03.1 — Infra: MinIO, Redis, FFmpeg e variáveis de ambiente
- [ ] SI-03.2 — Criar StorageModule (cliente S3 interno e público)
- [ ] SI-03.3 — Criar QueueModule (conexão BullMQ com Redis)
- [ ] SI-03.4 — Criar entidade Video, migration e gerador de slug
- [ ] SI-03.5 — Endpoint POST /videos (pré-cadastro + início do multipart)
- [ ] SI-03.6 — Endpoint GET /videos/{id}/upload (retomada do upload)
- [ ] SI-03.7 — Endpoint POST /videos/{id}/upload/complete (conclusão + enfileiramento)
- [ ] SI-03.8 — Endpoint GET /videos/{id} (leitura pelo dono)
- [ ] SI-03.9.1 — Infra: WorkerModule, entrypoint e serviço video-worker
- [ ] SI-03.9.2 — Processar vídeo no worker (metadados, allowlist, thumbnail)
- [ ] SI-03.10 — Endpoints GET /videos/{slug}/stream e /download (Range → 206)
- [ ] SI-03.11 — Endpoint GET /videos/{slug}/thumbnail
- [ ] SI-03.12 — Limpar uploads multipart abandonados (job agendado)
- [ ] SI-03.13 — Atualizar openapi.json e documentação do ambiente

**Full test suites:**

- [ ] Backend tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)
