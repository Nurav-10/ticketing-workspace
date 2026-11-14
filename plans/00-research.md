# Phase 0 — Research, scope and decisions

## Evidence collected

The original plan.md was empty and the workspace contained no application source when planning began. This is a greenfield proposal.

On 14 November 2026, REA capture_browser_scenario opened https://linear.app/ in a provider-owned temporary headless Chrome profile, waited, captured DOM and accessibility information, and reported successful browser cleanup. Its retained parent evidence ID is ev_a732c8533599e0bc93842ba180c1546ff8f61e1230fd73eb187d136e2828c145. The ID is session-scoped and may not survive a server restart. REA reported complete coverage of the requested page sections at that moment.

The public marketing demonstration exposed workspace navigation, search and new-issue actions, an issue title, activity and properties, and grouped issue lists with status, priority and labels. This is a public marketing demonstration, not evidence of the authenticated application's exact behavior, animation, private APIs, permissions, backend or performance. No login, private workspace, credentials, private traffic or source code was inspected. Do not copy the reference's branding or example content.

Primary references:

- [Teams](https://linear.app/docs/teams): workspaces, teams and issues; this informs our domain and does not promise parity.
- [Team pages](https://linear.app/docs/default-team-pages): issue, project, cycle and view navigation concepts.
- [Display options](https://linear.app/docs/display-options): filtering, grouping and display properties are separate concepts.
- [Cycles](https://linear.app/docs/use-cycles): time-boxed planning periods; our lifecycle is an independent proposal.
- [Members and roles](https://linear.app/docs/members-roles): roles and team visibility influence access; our permission matrix is separate.
- [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html): row security can provide defense in depth, but owners and privileged roles can bypass it.
- [OWASP authorization guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html): deny by default and validate permissions per request.
- [W3C motion guidance](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions): respect reduced-motion preferences. This interaction-motion criterion is WCAG AAA; target WCAG 2.2 AA plus this voluntary practice.

## 0.1 Define the customer

Confirm internal tracker versus external support desk, personas, first users, essential workflows, hosting region, budget and deadline. Record the primary persona, a success measure, exclusions and unresolved questions.

## 0.2 Validate the workflow

Walk through invite → sign in → join team → create issue → update → comment → locate again. Specify the smallest beta and the role matrix. Decide whether projects and cycles are required at beta.

## 0.3 Confirm technical choices

Review identity providers, hosting and operating costs, supported runtimes, data residency, licenses and dependency security. Record alternatives and reversibility. Select exact compatible versions during implementation. Do not infer Linear's private architecture from its public UI.

## 0.4 Establish the measurement baseline

Define a synthetic dataset including multiple workspaces, private teams and 10,000 issues in a large workspace. Agree client hardware, network, representative load and acceptance thresholds before measuring.

**Exit:** customer and beta scope are agreed; unresolved choices have owners; workflow, security boundary, target scale and measurement setup are written down. Update the overview and affected phases if discovery changes the brief.
