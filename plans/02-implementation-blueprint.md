# Phase 2 implementation blueprint

Status: active · 14 November 2026. This plan expands [Phase 2](02-design-system.md) into reviewable implementation slices. The app uses a CALM product mode: an original warm-neutral interface with a restrained violet action accent. It takes inspiration from low-noise, information-dense product shells without copying another product's identity.

## Current scope and Phase 1 dependencies

The Phase 2 design plan depends on Phase 1. The repository currently contains a React 19 + TypeScript + Vite web app in `apps/web`, split into an app composition root, a workspace feature, shell components, icon component, and token/base/shell/workspace CSS. The root Compose stack has `web`, `api`, and PostgreSQL services; frontend commands run in the `ticketing-app:local` image. The current screen is a static issue workspace shell with a mobile navigation drawer, an explicitly unavailable sign-in/workspace state, and no issue records. Several actions are disabled and labeled unavailable. There are no web forms, active data flows, test files, component library, router, or selected identity provider in the reviewed web scope.

Phase 1 groundwork exists, but its acceptance criteria are not met. Identity/session issuance and verified principals are not available to the web app; workspace/team authorization and real issue APIs are not wired into the shell; staging, CI and deployment acceptance also remain Phase 1 work. Phase 2 must preserve the honest unavailable states and must not introduce sample users, workspaces, issue data, active search, create actions, or other controls that imply a real backend. The current shell's mobile drawer, focus return and reduced-motion CSS are in scope for preservation and eventual verification.

The present styles have a small initial token set, but many literal colors and component-specific values remain in shell and workspace CSS. Most buttons are native buttons with correct labels/disabled behavior, but their styles and classes are local to callers. No input primitive is justified until a genuine form or functional search flow exists; an unused field would be speculative and must not be mounted as a fake control.

## Architecture and boundaries

- `styles/tokens.css` owns semantic design tokens only: color roles, typography, spacing, borders, radii, shadows, stacking, focus and motion. Feature styles consume these roles rather than duplicating raw palette values.
- `components/ui/` owns small reusable presentational/accessibility primitives. It does not own app data, routing, authorization or feature policy. Components expose native HTML semantics and forward native attributes/refs where appropriate.
- `components/shell/` owns composition and shell-specific interaction; `features/workspace/` owns issue-workspace content and states; `app/` composes these modules.
- New interaction behavior is introduced only with a concrete action and data/service contract. Shared abstraction requires at least two real consumers or a clearly reusable primitive contract.
- Keep the current React/Vite/CSS stack and existing Compose dependency boundary. No package manifest or lockfile change is part of this phase's initial slices.

## Delivery slices

### Slice 0 — Baseline and constraints

- Reconcile this blueprint with the existing Phase 2 design plan and Phase 1 status above.
- Preserve source-only work in `apps/web` and this plan. Dependency installation and verification stay inside Docker; no host install, test, build, or commit is part of this slice.
- Done when the actual page map, blocked dependencies, and truthful feature boundary are recorded.

### Slice 1 — Semantic visual foundations (current)

- Replace the small palette-specific variable set with documented semantic roles for canvas/surfaces, text, borders, accent, status, spacing, typography, radii, shadows, z-index, focus and motion. Ship the existing light warm-neutral direction as the default and leave an explicit extension seam for a later theme without shipping a second unreviewed theme.
- Migrate shell and workspace literal colors, focus, spacing/motion constants, and repeated control geometry to the tokens where the values have a semantic equivalent. Keep one-off illustration geometry local when it does not represent a reusable design role.
- Preserve compact readable text, mobile drawer behavior, and reduced-motion behavior. Do not claim contrast is verified until measured.
- Acceptance: semantic token names communicate purpose; component styles use tokens for semantic color/state; 4/8/12/16/24/32 spacing values are available; focus and motion roles exist; no visible state changes meaning or becomes misleading.

### Slice 2 — Shared action and state primitives (current)

- Introduce a native-button wrapper with a small explicit variant/size contract, class composition, and full native attribute/ref forwarding. Keep disabled unavailable actions disabled and retain accessible labels.
- Introduce a reusable status/state message with explicit status tone and semantic live-region choice. Adopt it only in at least two current state locations where shared semantics improve consistency, while keeping feature-specific layout/illustration in the feature CSS.
- Do not create active controls for unavailable features. Do not add a text input until a real form or data-backed search flow has been specified and implemented; when that happens, the input contract must include an associated label, described-by/error support, and native attributes.
- Acceptance: primitives are framework- and data-light, keyboard/native semantics are retained, focus-visible and disabled states are tokenized, state meaning has readable text and is not color-only, and current shell behavior is unchanged.

### Slice 3 — Integrate shell and state coverage

- Move repeated shell actions onto the button primitive and standardize repeated empty/unavailable state semantics without creating fake links, tabs, menus or search results.
- Add shared styling hooks for selected/current and unavailable states only where the state is actually present. Confirm the shell continues to explain that access is unavailable.
- Acceptance: desktop/tablet/mobile information hierarchy is retained; sidebar drawer remains dismissible and focus returns to its trigger; no unavailable item becomes interactive; long workspace labels and narrow widths remain legible.

### Slice 4 — Phase 1-backed form and navigation primitives (deferred)

- After Phase 1 supplies a real user/session/workspace contract, add only the actual forms and navigation flows required by the product. A real search may then justify a labeled input and keyboard behavior; actual menus/dialogs may justify overlay primitives with Escape, outside-click, scroll-lock and focus restoration; actual view switching may justify tabs.
- Add loading/error/unauthorized/expired states driven by real service state, not decorative placeholders. Keep authorization decisions in application/API boundaries.
- Acceptance: each control has a real destination/action and concrete default, focus, disabled/loading/error behavior; server authorization remains authoritative; mobile and screen reader flows match desktop semantics.

### Slice 5 — Verification and handoff

- Run web typecheck and production build in the Docker `web` service/image only. Review keyboard and narrow viewport behavior in an app served from the Docker stack when browser tooling is available. Check contrast ratios for semantic text, focus and control boundaries and record measurements. Check 360, 768, 1024 and 1440 CSS-pixel layouts and reduced-motion behavior.
- Record exact commands and results. Keep unperformed visual/browser checks explicit. Do not make a panel frame-rate claim without a captured trace. No tests/builds are to run on the host.
- Acceptance: Docker verification has explicit results, desktop/tablet/mobile layouts do not introduce accidental horizontal page overflow, keyboard focus is visible, reduced motion removes nonessential animation, and remaining checks are listed with evidence.

## Verification checklist

- Static review: token consumers use semantic roles; primitive APIs preserve native button behavior and don't own product data; imports follow the app → shell/feature → UI direction.
- Accessibility: label/name for every icon-only action; visible keyboard focus; disabled state is native; unavailable/error status is conveyed in text; status announcements are not unnecessarily repeated; drawer still supports Escape, focus containment and focus restoration.
- Responsive: 360px, 768px, 1024px, 1440px and 200% zoom; long titles/workspace labels do not overlap or clip; no accidental horizontal page scrolling; mobile drawer remains usable.
- Motion: `prefers-reduced-motion: reduce` leaves all state feedback available while removing nonessential movement.
- Contrast: measure text at 4.5:1 (3:1 for large text) and relevant non-text controls/focus at 3:1; document results rather than inferring from appearance.
- Runtime: `docker compose exec web bun run --filter @ticketing/web typecheck` and `docker compose exec web bun run --filter @ticketing/web build` after the Compose `web` service/image is available. If the current container entrypoint does not support `exec`, run the equivalent Bun command in a one-off service container using the same image. Never run package install, build or tests on the host.

## Current implementation scope

The first coherent implementation slice covers semantic tokens, reusable native-button and state-message primitives, and migration of existing shell/workspace button and state consumers that have real presentational uses. A text-input primitive and any combobox/menu/dialog/toast/tab/popover/skeleton/list/board component remain out of the initial slice: the current app has no real form, functional search, overlay action, tab state, loading data source or issue rows. They enter scope only with their real workflow and service state.

## Verification recorded · 14 November 2026

- Docker web typecheck and production build passed for the initial slice.
- A Playwright browser running inside Docker checked 360, 768, 1024 and 1440 CSS-pixel widths with reduced motion, with no horizontal page overflow or browser page errors. At 360px it also checked opening the drawer, focus entering it, Escape and scrim dismissal, and focus returning to the trigger. The first check exposed a focus failure; the corrected implementation passed when the browser was rerun against reloaded source.
- A full contrast audit, screen reader testing, 200% zoom, normal-motion layouts and a panel performance trace remain outstanding. These results do not establish Phase 2 acceptance.
