---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.5
target_file: nestjs-project/test/videos-create.e2e-spec.ts
---

# POST /videos Test Plan

## Application Overview

`POST /videos` pré-cadastra um vídeo como `draft` no canal do usuário autenticado, inicia o multipart no MinIO e devolve as URLs pré-assinadas de todas as partes, sem que a API receba bytes do vídeo. Valida o corpo via `ValidationPipe` (`400 VALIDATION_ERROR`), a allowlist de formato da camada 1 (`422 UNSUPPORTED_VIDEO_FORMAT`) e o teto de 10 GiB (`413 VIDEO_TOO_LARGE`). A rota é protegida pelo `JwtAuthGuard` global.

## Test Scenarios

### 1. POST /videos (SI-03.5)

**Setup:** `beforeAll` compila `Test.createTestingModule({ imports: [AppModule] })` e reproduz a config global de `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform`; `DomainExceptionFilter` + `ValidationExceptionFilter`), como em `test/auth.e2e-spec.ts`. `beforeEach` roda `cleanAllTables(dataSource)` e cria um usuário confirmado com login (access token Bearer) — o canal é criado junto com o usuário. Postgres e MinIO reais; `src/test/test-env.ts` já define `S3_PUBLIC_ENDPOINT = S3_ENDPOINT` para que as URLs assinadas sejam acessíveis de dentro do container. `afterAll` fecha o app.

#### 1.1. creates-draft-with-presigned-parts

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-09-28T19:25:00Z

**Steps:**
  1. POST /videos com Bearer do usuário e body `{ "filename": "clip.mp4", "content_type": "video/mp4", "size_bytes": 150000000 }`
    - expect: status 201
    - expect: `status` = `"draft"`, `id` é uuid e `slug` tem 11 caracteres base64url
    - expect: `upload.part_size` = 67108864, `upload.part_count` = 3 e `upload.expires_at` é ISO-8601 no futuro
    - expect: `upload.parts` tem 3 itens com `part_number` 1, 2 e 3, cada um com `url` não vazia
  2. Consultar o registro na tabela `videos` pelo `id` retornado
    - expect: `status = draft`, `upload_id` preenchido, `original_filename = "clip.mp4"`, `title = "clip"`
    - expect: `channel_id` é o canal do usuário autenticado
  3. PUT de alguns bytes na `url` da parte 1
    - expect: status 200 do MinIO com header `ETag`

#### 1.2. rejects-unsupported-format

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-28T19:25:00Z

**Steps:**
  1. POST /videos com Bearer e body `{ "filename": "clip.mp4", "content_type": "video/quicktime", "size_bytes": 1000 }`
    - expect: status 422 com `error` = `"UNSUPPORTED_VIDEO_FORMAT"`
  2. POST /videos com Bearer e body `{ "filename": "clip.mov", "content_type": "video/mp4", "size_bytes": 1000 }`
    - expect: status 422 com `error` = `"UNSUPPORTED_VIDEO_FORMAT"`
  3. Contar registros na tabela `videos`
    - expect: nenhum vídeo foi persistido

#### 1.3. rejects-video-too-large

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-28T19:25:00Z

**Steps:**
  1. POST /videos com Bearer e body `{ "filename": "clip.mp4", "content_type": "video/mp4", "size_bytes": 10737418241 }`
    - expect: status 413 com `error` = `"VIDEO_TOO_LARGE"`
    - expect: nenhum vídeo persistido na tabela `videos`

#### 1.4. rejects-invalid-body

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-09-28T19:25:00Z

**Steps:**
  1. POST /videos com Bearer e body `{ "filename": "clip.mp4", "content_type": "video/mp4" }` (sem `size_bytes`)
    - expect: status 400 com `error` = `"VALIDATION_ERROR"`

#### 1.5. requires-authentication

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-09-28T19:25:00Z

**Steps:**
  1. POST /videos sem header `Authorization` e com body válido
    - expect: status 401
    - expect: nenhum vídeo persistido na tabela `videos`
