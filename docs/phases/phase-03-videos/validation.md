---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-28T14:42:02-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-28T14:29:31-03:00"
issues:
  - id: IC-1
    status: resolved
    summary: "TD-01/TD-02/TD-05 citam bibliotecas na prosa, mas o campo Libraries está vazio"
    resolved_by: phase-03-videos/TD-01, phase-03-videos/TD-02, phase-03-videos/TD-05, phase-03-videos/TD-08, phase-03-videos/TD-10
  - id: AMB-1
    status: resolved
    summary: "\"Metadados\" extraídos no processamento não estão especificados"
    resolved_by: clarification
  - id: AMB-2
    status: resolved
    summary: "Acesso à thumbnail no bucket privado: indefinido se é da Fase 03 ou 04"
    resolved_by: clarification
  - id: DG-1
    status: resolved
    summary: "TD-10 supõe guard global + @Public() da Fase 02 sem herança confirmada"
    resolved_by: clarification
  - id: OQ-1
    status: resolved
    summary: "TD-13 pending — formatos de vídeo aceitos e transcodificação no browser"
    resolved_by: phase-03-videos/TD-13
  - id: MD-1
    status: resolved
    summary: "Sem TD sobre formatos aceitos / transcodificação para reprodução no browser"
    resolved_by: phase-03-videos/TD-13
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._ _(UI fora do escopo: `## UI Inventory` ausente.)_

## Resolved Issues

- **MD-1** _(resolved_by phase-03-videos/TD-13)_ — Sem TD sobre formatos aceitos / transcodificação para reprodução no browser. A TD foi criada; a pendência de decisão segue rastreada em OQ-1.
- **IC-1** _(resolved_by phase-03-videos/TD-01, TD-02, TD-05, TD-08, TD-10)_ — Campo `**Libraries:**` preenchido via Append revision (2026-09-28, rationale "Explicitar libs da prosa"): TD-01 → `@nestjs/bullmq`, `bullmq`; TD-02 e TD-10 → `@aws-sdk/client-s3`; TD-05 e TD-08 → `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`. Docs cacheadas em `library-refs.md`.
- **AMB-1** _(resolved_by clarification)_ — Metadados persistidos na Fase 03 em **colunas tipadas próprias** na entidade de vídeo: `duration_seconds`, `width`, `height`, `video_codec`, `audio_codec` (nullable — vídeo sem áudio), `container`, `bitrate`, `size_bytes`. Sem campo JSON.
- **AMB-2** _(resolved_by clarification)_ — A **Fase 03 expõe a thumbnail** por rota pública (`@Public()`) na API, para vídeos `ready`, servida a partir do bucket privado (TD-03). Regra do frame: instante em **10% da duração**; vídeos com duração < 1s usam o frame 0.
- **DG-1** _(resolved_by clarification)_ — Pré-requisito confirmado como herdado: a Fase 02 entregou guard JWT global (`APP_GUARD` + `JwtAuthGuard` em `nestjs-project/src/auth/auth.module.ts`) com opt-out por `@Public()` (já usado em `auth.controller.ts` e `app.controller.ts`), conforme `phase-02-auth/TD-02`. A Fase 03 só aplica o decorator.
- **OQ-1** _(resolved_by phase-03-videos/TD-13)_ — TD-13 decidida: Option B — allowlist MP4/WebM + H.264/VP8/VP9 (+ AAC/MP3/Opus/Vorbis ou sem áudio), validada no pré-cadastro (MIME/extensão) e no worker (`ffprobe`), sem transcodificação.
