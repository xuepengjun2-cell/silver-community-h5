# Camera MPF Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore complete camera photos rejected by MPF strictness without changing their original bytes.

**Architecture:** Retain the strict parser; expose a narrowly bounded compatibility parse result requiring full decoding of every indexed picture. Reuse the existing cancellable low-priority FFmpeg runner and retain the original hash/readback pipeline.

**Tech Stack:** Node.js 20+, FFmpeg, existing TOS and MySQL lifecycle.

**Spec:** `docs/superpowers/specs/2026-11-02-camera-mpf.md`

## Global Constraints

- Preserve original image bytes and download behavior.
- No customer images or credentials enter the repository.
- Transfer size, SHA, stable stat, ETag and readback remain mandatory.
- Only the active October 31 album's verified failed tasks may be resumed.
- No client package or static release is required for a backend-only change.

## Review Focus

- Forged camera metadata cannot bypass actual JPEG structure or decoding.
- Truncated or overlapping secondary images must remain rejected.
- Decode failure, cancellation or timeouts must never publish and must clean scratch.
- Source replacement during asynchronous decoding must be detected.
- Repeated resume must preserve deduplication and not restore deleted media.

### Task 1: Bounded camera compatibility

**Files:** Modify `server/project-image-delivery.js`; test `tests/project-image-delivery.test.js`.

**Interfaces:** `validateProjectImage(file, {ext, expectedSize, signal})` remains unchanged; returns original size, SHA and content type.

- [x] Add repository-owned synthetic MPF with observed zero padding and opaque block suffix; require unchanged bytes/hash and full decode.
- [x] Run the regression and observe strict rejection before changing code.
- [x] Implement compatibility bounds confirmed against the private source audit and cancellable indexed-JPEG decoding.
- [x] Add malformed index/padding/truncation/entropy corruption, dimension bound, cancelled decode and source-replacement regressions.
- [ ] Run image/API tests, all repository checks, and an independent branch review.

### Task 2: Controlled deployment and recovery

**Files:** Operational evidence outside the repository; existing `deploy/release-from-github.cjs`.

**Interfaces:** Exact SHA controlled release; existing authenticated upload-session `/resume` API.

- [ ] Push reviewed fix, pass PR CI, merge, pass exact main CI.
- [ ] Release dry-run/apply with idle and business-data guards; verify runtime module hash and health.
- [ ] Resume the 51 verified tasks through the API; observe one result before resuming the remaining tasks.
- [ ] Reconcile original fingerprints, completed sessions, media counts, public share results and unchanged October 30 records.
