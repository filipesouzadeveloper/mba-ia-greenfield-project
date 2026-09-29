# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 4/14 completed

### SI-03.1 — Infra: MinIO, Redis, FFmpeg e variáveis de ambiente
- **Status:** completed
- **Tests:** no tests (infra); critérios de aceite verificados manualmente (minio/redis healthy, ffmpeg/ffprobe exit 0, Joi rejeita falta de S3_BUCKET/REDIS_HOST, console MinIO 200)
- **Observations:**
  - Tags fixadas: `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` (última publicada) e `redis:8.8.3-alpine` com `--appendonly yes --maxmemory-policy noeviction` (AOF citado na TD-01; `noeviction` é o que o BullMQ exige). Healthcheck do MinIO via `mc ready local`.
  - O npm gravou `^3.1142.0` para os pacotes `@aws-sdk/*` (versão instalada, dentro do range `^3.1141.0` do library-refs).
  - Fixture `requiredEnv` de `src/config/env.validation.integration-spec.ts` ganhou as novas variáveis obrigatórias; sem isso o teste existente quebraria.
  - `.env` local (ignorado pelo git) recebeu o mesmo bloco do `.env.example`, porque as variáveis novas são obrigatórias no boot.
  - Ferramenta `TaskCreate` indisponível nesta sessão; o progress.md é a única lista de SIs.

### SI-03.2 — Criar StorageModule (cliente S3 interno e público)
- **Status:** completed
- **Tests:** 6 passing
- **Observations:**
  - `references/external-systems.md` do testing-guide ainda descreve storage em filesystem local; o plano (TD-02/TD-04) usa MinIO real e foi seguido. Atualizar o guia é tarefa separada.
  - O teste de integração usa um bucket exclusivo por execução (`streamtube-test-<uuid>`), removido no `afterAll`, para provar a criação do bucket sem tocar no bucket de dev.
  - `StorageService` destrói os dois `S3Client` no `onModuleDestroy`, para não deixar handles abertos no Jest.
  - `putObject` aceita só `Buffer` (a thumbnail); stream sem `ContentLength` exigiria `Upload` do `@aws-sdk/lib-storage`, fora do escopo.

### SI-03.3 — Criar QueueModule (conexão BullMQ com Redis)
- **Status:** completed
- **Tests:** 2 passing
- **Observations:**
  - Critério "Redis parado" verificado à mão (2026-09-29): com `redis` parado, a conexão BullMQ emite `getaddrinfo ENOTFOUND redis`.
  - `@nestjs/bullmq@12` (versão do library-refs) é só ESM e o Jest do projeto (CommonJS) não carrega. Filipe escolheu (2026-09-28) fixar `@nestjs/bullmq@^11.0.5`: CommonJS, aceita `bullmq ^6` e NestJS 11, mesma API.
  - `bullmq@6` tornou o `ioredis` peer opcional: instalado `ioredis@^5.11.1` (linha 5, CommonJS; a v6 acabou de sair).
  - `bullmq@6` removeu `queue.client`; o cliente Redis agora vem de `queue.getBackend().client`, cujo tipo `IRedisClient` não expõe `keys`.

### SI-03.4 — Criar entidade Video, migration e gerador de slug
- **Status:** completed
- **Tests:** 9 passing (2 unit slug + 5 integração entidade + 2 do teste de migrations atualizado)
- **Observations:**
  - Migration gerada pelo CLI (`migration:generate`) contra o banco; o diff continha só `videos`. `migration:revert`/`migration:run` conferidos via CLI.
  - `src/database/migrations.integration-spec.ts` atualizado: `videos` em `MANAGED_TABLES`, `video_status` em `MANAGED_ENUM_TYPES`, nova migration na lista, e o teste de revert agora checa a remoção de `videos` + `video_status` (antes checava as tabelas de token, que deixaram de ser a última migration).
  - Entidade usa `enumName: 'video_status'` e nomes explícitos de índice (`UQ_videos_slug`, `IDX_videos_channel_id`, `IDX_videos_status_created_at`) para o `synchronize` dos testes de entidade bater com a migration.
  - Relação só no lado `Video` (`@ManyToOne`); o `@OneToMany` em `Channel` citado em Relations não está nas ações do SI e não foi adicionado (nenhum SI da fase navega de canal para vídeos).
  - `cleanAllTables` não precisou mudar: apagar `channels` remove os vídeos pela FK `ON DELETE CASCADE`.
  - `videos.constants.ts` também traz a allowlist das duas camadas (TD-13) como `VIDEO_ALLOWED_UPLOAD_FORMATS` / `VIDEO_ALLOWED_CODECS`, já que ela faz parte da seção de constantes do Data Model.

### SI-03.5 — Endpoint POST /videos (pré-cadastro + início do multipart)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.6 — Endpoint GET /videos/{id}/upload (retomada do upload)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.7 — Endpoint POST /videos/{id}/upload/complete (conclusão + enfileiramento)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.8 — Endpoint GET /videos/{id} (leitura pelo dono)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.9.1 — Infra: WorkerModule, entrypoint e serviço video-worker
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.9.2 — Processar vídeo no worker (metadados, allowlist, thumbnail)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.10 — Endpoints GET /videos/{slug}/stream e /download (Range → 206)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.11 — Endpoint GET /videos/{slug}/thumbnail
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.12 — Limpar uploads multipart abandonados (job agendado)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.13 — Atualizar openapi.json e documentação do ambiente
- **Status:** pending
- **Tests:** —
- **Observations:** none
