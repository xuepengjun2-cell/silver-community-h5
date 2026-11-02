# WeChat Self-service and HQ Association Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One WeChat entry, immediate own-album access, HQ association before restricted downloads, one review queue.

**Architecture:** Add a compatible self-service endpoint and association metadata on existing users; preserve legacy identity and review routes. Deliver backend first, admin static resources separately, and a native preview from the preserved video baseline rather than uploading main's photo edition.

**Tech Stack:** Node20+, MySQL JSON docs, native WeChat JS/WXML/WXSS, existing H5 admin and controlled release tools.

**Spec:** `docs/superpowers/specs/2026-11-02-wechat-onboarding-simplify-design.md`

## Global Constraints

- New self-service users: active member, own-and-selected empty list, canDownload false, associationStatus pending.
- HQ approval grants materials downloads; public album saving is unchanged.
- Related old account is a reviewed reference, not a userId merge or album ownership transfer.
- Existing accounts/roles/permissions/identities and rejected/revoked/disabled boundaries remain.
- No schema/initDb/dependency/package changes; backend first commit must contain no public static changes.
- Preserve secret configuration; no credentials in source or outputs.
- Native baseline: preserved a742863 + verified domain/DevTools edits; immutable media code outside explicitly reviewed login/download changes.

## Review Focus

- Concurrent self-service attempts for one WeChat cannot create duplicate users or overwrite a legacy account.
- New ordinary users cannot read others' internal albums or download restricted materials by direct API.
- HQ stale/disabled reviewer, manager, target-account or revision must fail without partial grant.
- Late login responses cannot restore manual logout or change account; granted permissions refresh correctly.
- Admin/client delivery must not overwrite server data, historical runtime static drift, or native video functions.

### Task 1: Backend onboarding and association

**Files:** `server.js`, focused `server/account-onboarding.js` if useful, existing identity/scope tests and fake SQL support only.

**Interfaces:** Implement exact endpoints and metadata in Spec. Replies use existing session envelope; add association fields to publicUser. `reviews` item uses kind/id/version, managers active admin/operator.

- [ ] Write integration regressions for self-service, idempotence, denied downloads/direct calls, own scope and unchanged public share.
- [ ] Observe failure before implementation; implement minimal locked/transactional lifecycle without initDb or package changes.
- [ ] Test review approve/reject with CAS revision, inactive references, stale reviewer and legacy compatibility; no account merge/ownership changes.
- [ ] Run identity/concurrency/media boundaries and independent review. Commit backend only; no public files.

### Task 2: Unified admin interface

**Files:** Independent checkout `public/admin.js`, associated CSS/cache labels, `tests/account-review-ui.test.js`.

**Interfaces:** Use Task1 review endpoints; preserve account manager functions under secondary tab. Ordinary association row approves organization/manager/downloads; optional old-account reference in details.

- [ ] Pin meaningful UI interaction expectations before implementation.
- [ ] Render one queue and one primary action per row; collect legacy conflict/role controls into details rather than removing guards.
- [ ] Verify approval/error/refresh flows, escaping, no stale cards and matching API payload; independent review.
- [ ] Integrate static changes only after backend release commit is clean/deployed; publish CDN with exact static baseline separately.

### Task 3: Native login and candidate packaging

**Files:** Separate native branch from a742863; modify entry JS/WXML/WXSS and auth utility; extra download gate changes only if actually needed, never copy photo-edition media pages wholesale.

**Interfaces:** `wechatSession` preserves existing flow; new `onboardWechat` calls /auth/wechat/onboard and stores returned session with existing epoch/manual-logout guards. Server messages gate restricted downloads.

- [ ] Write failing tests for one main WeChat entry, unbound streamlined form, direct onboarding, old binding, pending-download prompt and valid session restore.
- [ ] Implement native UI with three application fields, city optional, password/admin login folded, no separate platform registration form.
- [ ] Test late responses/manual logout/role gates; verify all untouched video/upload/save baseline hashes.
- [ ] Push exact native branch candidate, run relevant CI, generate reproducible source/hash manifest and development preview if tooling is authorized/available. Never call preview upload formal publication.

### Task 4: Integration and delivery

- [ ] Run required checks; independent security/concurrency review of final branches.
- [ ] GitHub-first backend-only release with public tree unchanged, then separate static commit and controlled static release.
- [ ] Verify public caps/health, test approved/rejected download boundaries and existing album counts/ownership; no production test accounts without isolated authorization.
- [ ] Provide native preview and mobile walkthrough. Client review/publication require the actual code baseline and truthful platform-category checks; preserve present formal version until those gates pass.
