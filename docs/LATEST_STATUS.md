# DASH APP — Latest Status

> **Superseded for the release (28 September 2026).** The Play Store release
> candidate is on branch `claude/awesome-bardeen-95lgbd` (a fast-forward of
> `claude/playstore-readiness`), not `main`. Its current state — what is
> proven, what is built but unproven, the release blockers and what needs
> David — is in [`docs/release/README.md`](release/README.md). The rest of
> this page is the 4 September checkpoint of `main`, kept as history.

**Updated:** 2026-09-04

This file is the short current checkpoint for picking the project up quickly. For full architecture, security, decisions, and operational detail, continue with `HANDOFF.md`, `ARCHITECTURE.md`, and `docs/DECISIONS.md`.

## Current source of truth

- Working branch: `main`
- Latest GitHub commit before this status update: `eabaf722` — Milestone II merge-status update
- Milestone II PostgreSQL/PostGIS + Redis production path is merged on `main`.
- The application has **not** been deployed to production and should not yet be described as production-ready.

## Milestone II verification now completed

The real-infrastructure gates that were originally marked pending have been exercised:

- PostgreSQL/PostGIS path verified against the real service.
- PostGIS containment verification: **14/14 checks passed**, including boundary and hole semantics.
- Boundary-inclusive containment uses `ST_Covers` and SRID parameters are explicitly bound as PostgreSQL integers.
- Redis 7 verification: **8/8 checks passed**.
- Shared fail-closed rate limiting was verified across two API instances.
- PostgreSQL migrations/schema drift checks passed against the real infrastructure path.

The earlier statement that Milestone II was only implemented but unverified is therefore obsolete.

## Development workstation checkpoint

Recent local setup work established the WSL2/Linux development path:

- Ubuntu 24.04 is installed under WSL2.
- Linux development user created: `mrdash`.
- Prisma Client generation completed successfully with Prisma `6.19.3` using `packages/db/prisma/schema.prisma`.
- The latest observed local `git status --short` showed one modified working-tree file: `apps/api/src/adapters/postgis.ts`.

That local modification is **not claimed as committed here**. It should be reviewed/diffed on the workstation before it is committed or discarded, so this repository checkpoint does not silently overwrite unverified local work.

## Verified codebase state from Milestone II

Milestone II introduced the production infrastructure path while preserving the SQLite development path:

- Dual Prisma schema strategy for SQLite development and PostgreSQL production, with drift/divergence guards.
- PostGIS-backed `GeoPort.zonesContaining` using database topology checks.
- Redis responsibilities intentionally limited to fail-closed rate limiting and queueing; durable state remains in PostgreSQL.
- Readiness checks report dependencies without disclosing provider/host/configuration details.
- BullMQ and ioredis production-path support added without replacing durable database state.

At the Milestone II implementation checkpoint, the recorded verification set included **938 tests across 31 files**, clean typecheck across four projects, clean lint, successful 11-route build, domain coverage above 97% statements, SQLite migration/drift verification, smoke checks, and dispatch checks.

## Still outstanding before a real release

The next release work remains operational/integration work rather than pretending the code is already production-ready: secret-store/key-management setup, real external provider integrations, backup and restore rehearsal, scheduled maintenance/retention jobs, production observability, deployment, and external verification.

No new release tag is created by this status update.
