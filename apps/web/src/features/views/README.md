# Saved views feature module

Design mode: CALM. This standalone module provides the saved-view catalog and CRUD surface; it is intentionally not imported by the app shell or registered as a route.

## Integration requirements

- Mount `SavedViews` only after the active workspace/team are authorized. Pass the exact `workspaceId` and `teamId` from the authenticated workspace context.
- If the issue workspace should open a saved view, provide `onOpen(view)`. The caller must re-run the saved filter through the authorized issue-list query path and revalidate IDs against current team workflow, assignee, and label data. Do not make client-stored view filters grants.
- Do not serialize `view.filter`, names, titles, or descriptions into `location.search`, hashes, analytics, or logs. The client only sends opaque view IDs and the API's catalog cursor in the path/query string.
- API `403`, `404`, and `409 version_conflict` responses are authoritative. Creator identity is not used to infer current ownership or edit access; the API must enforce the current owner/team-admin policy.
- The catalog cursor is a live traversal ordered by update time and ID, not a snapshot. Keep refresh available and preserve the API cursor opaquely.
- The UI creates views without a filter field, relying on the API's documented version-1 default filter. Editing filters/layout is not part of this catalog surface.

No route, app-shell, or shared style changes are made here. The parent integration should import `SavedViews` from `./features/views/SavedViews` and may import client types from `./features/views/views-api`.
