# Web client

This is an initial issue-tracker application shell. Workspace identity and issue data are not connected, so the shell shows unavailable states and disables actions that have no implementation. No workspace users, teams, or issues are fabricated.

## Commands

- `bun --filter @ticketing/web dev` — start Vite on `0.0.0.0:5173`
- `bun --filter @ticketing/web typecheck` — run strict TypeScript checking
- `bun --filter @ticketing/web build` — typecheck and build the production bundle
- `bun --filter @ticketing/web preview` — serve the built bundle

The Vite development server proxies same-origin `/api` requests to `http://api:3000`. This hostname assumes the web container and API service share the Compose network; it is not expected to resolve when Vite runs directly on the host.

## Source layout

- `src/app/` composes the page and owns the responsive navigation drawer state.
- `src/components/shell/` contains the workspace sidebar and top toolbar.
- `src/components/ui/` contains the small shared icon primitive.
- `src/features/workspace/` owns the issue list, unavailable state, and contextual details panel.
- `src/styles/` separates design tokens, base rules, shell styling, and workspace styling.
