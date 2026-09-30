---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.8
target_file: nestjs-project/test/videos-get.e2e-spec.ts
---

# GET /videos/{id} Test Plan

## Application Overview

`GET /videos/{id}` expõe ao dono o estado técnico do vídeo — `status`, `failure_reason` e os metadados extraídos pelo worker (duração, dimensões, codecs, container, bitrate) — tornando visível o resultado do processamento. Vídeo inexistente ou de outro canal responde `404 VIDEO_NOT_FOUND`; sem token, `401`.

## Test Scenarios

### 1. GET /videos/{id} (SI-03.8)

**Setup:** Bootstrap do `AppModule` com a config global de `main.ts` (`ValidationPipe`, `DomainExceptionFilter`, `ValidationExceptionFilter`), como em `test/auth.e2e-spec.ts`. `beforeEach` roda `cleanAllTables(dataSource)`, cria dois usuários confirmados com login (dono e outro) e, pelo dono, faz `POST /videos` com `{ "filename": "clip.mp4", "content_type": "video/mp4", "size_bytes": 1000 }`. Postgres e MinIO reais. `afterAll` fecha o app.

#### 1.1. returns-fresh-draft-with-null-metadata

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-28T19:25:00Z

**Steps:**
  1. GET /videos/{id} com Bearer do dono
    - expect: status 200 com `id`, `slug`, `title` = `"clip"`, `original_filename` = `"clip.mp4"`, `mime_type` = `"video/mp4"` e `size_bytes` = 1000 (number)
    - expect: `status` = `"draft"` e `failure_reason` = null
    - expect: `duration_seconds`, `width`, `height`, `video_codec`, `audio_codec`, `container` e `bitrate` são null
    - expect: `created_at` e `updated_at` são ISO-8601

#### 1.2. returns-failure-reason-for-failed-video

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-28T19:25:00Z

**Steps:**
  1. Atualizar o registro via repositório para `status = failed`, `failure_reason = UNSUPPORTED_FORMAT` (a transição real é coberta pelos testes de integração do worker)
  2. GET /videos/{id} com Bearer do dono
    - expect: status 200 com `status` = `"failed"` e `failure_reason` = `"UNSUPPORTED_FORMAT"`

#### 1.3. hides-video-from-other-channel

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-28T19:25:00Z

**Steps:**
  1. GET /videos/{id} com Bearer do outro usuário
    - expect: status 404 com `error` = `"VIDEO_NOT_FOUND"`
  2. GET /videos/{uuid-aleatório} com Bearer do dono
    - expect: status 404 com `error` = `"VIDEO_NOT_FOUND"`

#### 1.4. requires-authentication

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-28T19:25:00Z

**Steps:**
  1. GET /videos/{id} sem header `Authorization`
    - expect: status 401

#### 1.5. rejects-non-uuid-id

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-28T19:25:00Z

**Steps:**
  1. GET /videos/nao-e-uuid com Bearer do dono
    - expect: status 400 com `error` = `"VALIDATION_ERROR"`
