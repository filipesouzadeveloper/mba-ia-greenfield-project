# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 12/14 completed

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
- **Status:** completed
- **Tests:** 35 passing (30 unit/integração + 5 E2E de `test/videos-create.e2e-spec.ts`)
- **Observations:**
  - O E2E revelou defeito do SI-03.1 em `test/jest-e2e.json`: `setupFiles` apontava `<rootDir>/src/test/test-env.ts`, mas o `rootDir` é `test/`, então nenhum E2E rodava. Com aprovação do Filipe (2026-09-29), corrigido para `<rootDir>/../src/test/test-env.ts` e adicionado `testTimeout: 120000` (o boot do `AppModule` com MinIO/Redis passa dos 5s no volume do Windows), em commit separado `0c84a97`.
  - Constantes novas em `videos.constants.ts`: `VIDEO_SLUG_UNIQUE_CONSTRAINT` (a entidade passou a usá-la em vez do literal `'UQ_videos_slug'`) e `VIDEO_TITLE_MAX_LENGTH`.
  - Retry de slug detecta a violação pelo nome da constraint (`QueryFailedError.constraint`), não pelo `detail` como em `ChannelsService`.
  - Compensação: se `createMultipartUpload` falhar, o rascunho recém-inserido é removido e o erro propaga (senão ficaria um `draft` sem `upload_id`).
  - Usuário sem canal lança `Error` genérico (invariante: todo usuário tem canal); o plano não define exceção de domínio para esse caso.
  - DTO de resposta em `src/videos/dto/created-video-draft.dto.ts` (`CreatedVideoDraftDto`, `MultipartUploadDto`, `UploadPartUrlDto`).

### SI-03.6 — Endpoint GET /videos/{id}/upload (retomada do upload)
- **Status:** completed
- **Tests:** 16 passing (8 unit + 2 integração em `videos.service`, 6 E2E de `test/videos-upload-resume.e2e-spec.ts`)
- **Observations:**
  - `ParseUUIDPipe` usado sem `exceptionFactory`: o padrão do pipe já lança `BadRequestException` (conferido em `@nestjs/common/pipes/parse-uuid.pipe.js`), que o `ValidationExceptionFilter` converte em `VALIDATION_ERROR`.
  - Cenário 1.4 do test plan (`rejects-video-not-in-draft`) usa `POST /videos/{id}/upload/complete`, que só chega no SI-03.7; o E2E leva o vídeo a `processing` direto pelo repositório. Trocar pela chamada HTTP no SI-03.7.
  - A resolução do canal saiu de `createDraft` para o helper privado `resolveChannelId`, compartilhado com `findOwnedOrFail`; `presignParts` passou a receber a lista de números de parte (retomada assina só as faltantes).
  - Resposta em `src/videos/dto/upload-status.dto.ts` (`UploadStatusDto`, `ResumableUploadDto` estende `MultipartUploadDto` com `uploaded_parts`).
  - Draft sem `upload_id` lança `Error` genérico (invariante: todo `draft` tem multipart; a compensação do SI-03.5 remove o rascunho quando o multipart falha).
  - `npm run test:e2e` não passa `--runInBand` (o `nestjs-project/CLAUDE.md` diz que já passa): duas suítes E2E juntas colidem no banco. Rodado com `--runInBand` explícito; corrigir o script é tarefa separada.

### SI-03.7 — Endpoint POST /videos/{id}/upload/complete (conclusão + enfileiramento)
- **Status:** completed
- **Tests:** 17 passing (10 unit + 2 integração em `videos.service`, 5 E2E de `test/videos-upload-complete.e2e-spec.ts`), mais o cenário 1.4 do resume agora via HTTP
- **Observations:**
  - A transição `draft → processing` (e `draft → failed` no `FILE_TOO_LARGE`) é um `UPDATE ... WHERE id AND status = 'draft'`; `affected = 0` lança `InvalidVideoStatusException` antes do enqueue. Motivo: a doc do BullMQ avisa que, com `removeOnComplete`, um job removido deixa de contar como duplicado, então o `jobId` sozinho não barra um reenfileiramento concorrente.
  - Partes além de `part_count` no `ListParts` são ignoradas no `CompleteMultipartUpload`.
  - `VIDEO_FAILURE_REASONS` (os 5 valores de § Failure reasons) em `videos.constants.ts`; o worker usa os demais nos SIs 03.9.2/03.12.
  - `ProcessVideoJobData` exportado de `src/videos/video-processing.queue.ts` (contrato do job para o SI-03.9.2).
  - Cenário 1.4 do resume trocado pela chamada HTTP com um draft de 1 parte: o S3 recusa concluir com partes não finais < 5 MiB, e o draft padrão do teste tem 3 partes pequenas. Os E2E de vídeo agora também apagam `videos/{id}/original` na limpeza.
  - Se o `enqueue` falhar depois do `UPDATE`, o vídeo fica em `processing` sem job (não há como voltar a `draft`: o multipart já foi concluído). O plano não trata esse caso; fica como tarefa separada (ex.: varredura de `processing` sem job).

### SI-03.8 — Endpoint GET /videos/{id} (leitura pelo dono)
- **Status:** completed
- **Tests:** 5 passing (E2E de `test/videos-get.e2e-spec.ts`); `tsc --noEmit` e lint limpos
- **Observations:**
  - A coluna `container` da entidade é `varchar`; o DTO a tipa como `'mp4' | 'webm' | null` (chaves de `VIDEO_ALLOWED_CODECS`) com um cast no mapper, porque só o worker grava esse campo e ele só aceita containers da allowlist da camada 2.
  - Mapper `toVideoResponse` fica no próprio `video-response.dto.ts`; o controller chama `findOwnedOrFail` e mapeia, sem método novo no service.

### SI-03.9.1 — Infra: WorkerModule, entrypoint e serviço video-worker
- **Status:** completed
- **Tests:** 4 passing (`src/worker/worker.module.integration-spec.ts`, rodado com `--detectOpenHandles` sem handles abertos); `tsc --noEmit` e lint limpos; critérios de aceite verificados à mão (logs do `video-worker` mostram o contexto sem `RouterExplorer`, sem porta publicada, API respondendo `200` em `:3000` com o worker de pé)
- **Observations:**
  - Lacuna do plano: com `autoLoadEntities`, registrar só `Video` no worker falha com `Entity metadata for Video#channel was not found` (`Video` → `Channel` → `User`). Filipe escolheu (2026-09-29) importar o `UsersModule` no `WorkerModule`, que registra `User` e importa o `ChannelsModule`; cada entidade continua no módulo dono. Custo: `UsersService`/`ChannelsService` instanciados sem uso no worker.
  - Além do `typeorm-options.factory.ts` (exporta `typeOrmModuleOptions`, as opções completas do `forRootAsync`), as opções do `ConfigModule.forRoot` foram extraídas para `src/config/config-module.options.ts`, para o worker usar os mesmos `load`/`validationSchema` sem duplicar a lista.
  - `IRedisClient` do bullmq v6 não expõe `ping`; o teste confere `status === 'ready'` da conexão da fila.
  - `nestjs-api` (`start:dev`) e `video-worker` (`start:worker:dev`) compilam no mesmo `dist/` do volume, com `deleteOutDir: true`. Na verificação a API subiu com o worker já rodando e o worker seguiu de pé, mas os dois watchers recompilam no mesmo diretório a cada mudança. Se aparecer corrida (arquivo sumindo no restart), separar o `outDir` do worker é tarefa separada.
  - O `.env` deixa `QUEUE_PREFIX=streamtube`, então o worker de dev consome a fila de dev e não a de teste (`streamtube-test`).

### SI-03.9.2 — Processar vídeo no worker (metadados, allowlist, thumbnail)
- **Status:** completed
- **Tests:** 41 passing nos 3 arquivos do SI (17 novos de `classifyProbe` + 14 existentes em `video-format.spec.ts`, 4 em `ffmpeg.service.integration-spec.ts`, 6 em `video.processor.integration-spec.ts`), todos na 1ª rodada; `worker.module.integration-spec.ts` segue 4/4; `tsc --noEmit` e lint limpos
- **Observations:**
  - O passo 3 de § Events/Messages trata FFmpeg com código ≠ 0 como transitório, mas para um arquivo de texto o `ffprobe` sai com código 1 e `Invalid data found when processing input` (conferido no container). Para cumprir a tabela de Failure reasons ("não reconhece o arquivo" → `NOT_A_VIDEO`) e o critério de aceite, `FfmpegService.probe` lança `UnrecognizedMediaError` nesse caso e o `VideoProcessor` converte em `VideoProcessingFailure(NOT_A_VIDEO)`. Os demais códigos ≠ 0 continuam transitórios.
  - `VideoProcessingFailure` fica em `src/videos/video-processing-failure.ts` (o plano não definia o arquivo); `VideoFailureReason` foi adicionado a `videos.constants.ts`.
  - `findVideoStream` ignora streams com `disposition.attached_pic` (capa de arquivo de áudio), que assim vira `NOT_A_VIDEO`. Um stream de áudio com `codec_name` ausente é rejeitado, não tratado como "sem áudio".
  - Por design da allowlist (mesmo demuxer), um MOV com H.264/AAC é aceito como `mp4` e um MKV com VP9/Opus como `webm`. Os casos "MOV/MKV" do teste unitário são rejeitados pelo codec (MOV com ProRes, MKV com H.264).
  - `readMetadata` grava `duration_seconds`/`bitrate` como `null` quando o `ffprobe` não os informa; sem duração, a thumbnail usa o frame 0.
  - O teste do processor enfileira pelo próprio `VideoProcessingQueue` da API (opções reais: 3 tentativas, backoff exponencial). O caso de erro transitório leva ~3s pelo backoff.
  - Fora do escopo: (1) `execFile` sem `timeout` — uma leitura HTTP travada prende o worker (o lock do BullMQ continua sendo renovado); (2) a mensagem de erro do `execFile` inclui a URL pré-assinada, que vai para o `failedReason` do job no Redis e para o log; (3) o tipo `VideoContainer` está duplicado em `video-format.ts` e `video-response.dto.ts`.
  - O watcher do container `video-worker` não recompilou após as edições (bind mount do Windows sem eventos de arquivo); para o worker de dev carregar o processor é preciso `docker compose restart video-worker`.

### SI-03.10 — Endpoints GET /videos/{slug}/stream e /download (Range → 206)
- **Status:** completed
- **Tests:** 33 novos passing (22 em `http-range.spec.ts`, 6 de `openStream` em `videos.service.spec.ts`, 5 E2E de `test/videos-stream.e2e-spec.ts`), todos na 1ª rodada; lint limpo
- **Observations:**
  - Correção posterior: o commit do SI (2315ca9) saiu com erro de `tsc` no E2E — o `tsc --noEmit` rodou antes de o spec existir. O `binaryParser` estava tipado com `NodeJS.ReadableStream`, que o `.parse()` do supertest não aceita; foi extraído para `src/test/binary-parser.ts`, tipado com o `Response` do supertest, em commit de correção separado.
  - O 416 precisa do `size_bytes` no header `Content-Range`, e o controller não usa `try/catch`. Por isso `openStream` não lança no Range inválido: devolve `{ video, range: 'unsatisfiable' }` sem abrir o objeto, e o helper privado `sendVideo` do controller define `Content-Range: bytes */{size}` e lança `RangeNotSatisfiableException` (como a ação 4 do SI descreve).
  - `Content-Disposition` só é definido depois de descartado o 416, para a resposta de erro JSON do `/download` não virar anexo.
  - `Content-Type` sai de `VIDEO_CONTAINER_MIME_TYPES` (novo em `videos.constants.ts`) pelo `container` gravado pelo worker, com o `mime_type` declarado como reserva.
  - `parseRange` segue o plano: sintaxe inválida (inclusive unidade diferente de `bytes`) vira 416; múltiplos intervalos são ignorados (200). O fallback ASCII do `Content-Disposition` troca não-ASCII, `"` e `\` por `_`; o `filename*` codifica também `'()*` (RFC 5987).
  - Fora do escopo: quando o player aborta a conexão no meio do stream (comum ao dar seek), o `pipeline` rejeita com `Premature close`; o `BaseExceptionFilter` do Nest encerra a resposta corretamente, mas registra o erro no log. Filtrar esse caso é tarefa separada.
  - Fora do escopo: `HEAD` cai na mesma rota e abre o `GetObject` sem precisar do corpo.

### SI-03.11 — Endpoint GET /videos/{slug}/thumbnail
- **Status:** completed
- **Tests:** 2 E2E passing em `test/videos-thumbnail.e2e-spec.ts` (sem unitário, conforme o plano); `tsc --noEmit` e lint limpos
- **Observations:**
  - `Content-Type` e `Content-Length` vêm do próprio objeto no storage: o worker grava a thumbnail com `ContentType: image/jpeg`. Assim a API não duplica o literal que fica em `THUMBNAIL.CONTENT_TYPE` de `worker.constants.ts` (constante do worker, que a API não deve importar).
  - `openThumbnail` devolve o `ObjectStream` do `StorageService` direto. Um vídeo `ready` sem thumbnail no bucket (não deveria existir: o worker grava a thumbnail antes do `ready`) resulta em 500.
  - Novo helper `generateThumbnailFixture()` em `src/test/video-fixtures.ts`: um frame do mesmo `testsrc` codificado como JPEG direto pelo FFmpeg, sem subir o vídeo nem rodar o worker.
  - O `binaryParser` compartilhado (`src/test/binary-parser.ts`) veio da correção do SI-03.10.

### SI-03.12 — Limpar uploads multipart abandonados (job agendado)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.13 — Atualizar openapi.json e documentação do ambiente
- **Status:** pending
- **Tests:** —
- **Observations:** none
