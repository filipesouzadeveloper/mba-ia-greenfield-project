---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.6
target_file: nestjs-project/test/videos-upload-resume.e2e-spec.ts
---

# GET /videos/{id}/upload Test Plan

## Application Overview

`GET /videos/{id}/upload` permite ao dono retomar um upload interrompido: lista as partes já presentes no MinIO (`ListParts`) e reassina somente as que faltam. Só vale para vídeos em `draft` (`409 INVALID_VIDEO_STATUS` fora disso); vídeo inexistente ou de outro canal responde `404 VIDEO_NOT_FOUND` para não revelar existência; `id` não-uuid cai em `400 VALIDATION_ERROR` via `ParseUUIDPipe`.

## Test Scenarios

### 1. GET /videos/{id}/upload (SI-03.6)

**Setup:** Bootstrap do `AppModule` com a config global de `main.ts` (`ValidationPipe`, `DomainExceptionFilter`, `ValidationExceptionFilter`), como em `test/auth.e2e-spec.ts`. `beforeEach` roda `cleanAllTables(dataSource)`, cria dois usuários confirmados com login (dono e outro) e, pelo dono, faz `POST /videos` com `{ "filename": "clip.mp4", "content_type": "video/mp4", "size_bytes": 150000000 }` (3 partes). As partes são enviadas com `PUT` de poucos bytes direto nas URLs pré-assinadas (o mínimo de 5 MiB do S3 só vale no `CompleteMultipartUpload`). Postgres, MinIO e Redis reais (`QUEUE_PREFIX=streamtube-test`). `afterAll` fecha o app.

#### 1.1. lists-uploaded-and-resigns-missing-parts

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-28T19:25:00Z

**Steps:**
  1. PUT de alguns bytes na URL da parte 1 retornada pelo pré-cadastro
    - expect: status 200 do MinIO
  2. GET /videos/{id}/upload com Bearer do dono
    - expect: status 200 com `status` = `"draft"` e `upload.part_count` = 3
    - expect: `upload.uploaded_parts` = `[1]`
    - expect: `upload.parts` contém só `part_number` 2 e 3, cada um com `url` não vazia

#### 1.2. returns-empty-parts-when-all-uploaded

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-28T19:25:00Z

**Steps:**
  1. PUT de alguns bytes nas URLs das partes 1, 2 e 3
    - expect: status 200 do MinIO em cada uma
  2. GET /videos/{id}/upload com Bearer do dono
    - expect: status 200 com `upload.uploaded_parts` = `[1, 2, 3]`
    - expect: `upload.parts` = `[]`

#### 1.3. hides-video-from-other-channel

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-28T19:25:00Z

**Steps:**
  1. GET /videos/{id}/upload com Bearer do outro usuário
    - expect: status 404 com `error` = `"VIDEO_NOT_FOUND"`
  2. GET /videos/{uuid-aleatório}/upload com Bearer do dono
    - expect: status 404 com `error` = `"VIDEO_NOT_FOUND"`

#### 1.4. rejects-video-not-in-draft

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-28T19:25:00Z

**Steps:**
  1. Levar o vídeo a `processing`: pré-cadastrar com `size_bytes` pequeno (1 parte), PUT da parte 1 e POST /videos/{id}/upload/complete com Bearer do dono
    - expect: status 202
  2. GET /videos/{id}/upload com Bearer do dono
    - expect: status 409 com `error` = `"INVALID_VIDEO_STATUS"`

#### 1.5. rejects-non-uuid-id

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-09-28T19:25:00Z

**Steps:**
  1. GET /videos/nao-e-uuid/upload com Bearer do dono
    - expect: status 400 com `error` = `"VALIDATION_ERROR"`

#### 1.6. requires-authentication

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-28T19:25:00Z

**Steps:**
  1. GET /videos/{id}/upload sem header `Authorization`
    - expect: status 401 (Authorization Matrix: anônimo ✗)
