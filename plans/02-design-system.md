# Phase 2 — Design system and application shell

**Goal:** create the calm, responsive product shell and interaction foundation. Depends on Phase 1.

## 2.1 Visual foundations

Choose an independent name and visual identity. Define semantic tokens for surfaces, borders, text, accent, status, spacing, typography, radius, shadows, z-index and motion. Support theme expansion but ship the selected default first. Start with a 4/8/12/16/24/32 spacing rhythm and readable 13–15 px dense UI text; validate contrast, long titles, empty lists and long labels.

## 2.2 Accessible components

Implement buttons, inputs, comboboxes, menus, dialogs, toast, tabs, popovers, skeletons and list/board primitives, using accessible foundations where appropriate. Specify focus restoration, Escape, outside-click behavior, error messages and disabled states. Design overlay stacking, scroll locking, touch targets and responsive behavior.

## 2.3 Shell and navigation

Build workspace switcher, quiet team navigation, content toolbar, main pane and contextual detail panel. Only show authorized workspaces and teams. On narrow viewports use a dismissible sidebar and full-screen detail. Add discoverable keyboard navigation and command palette; shortcuts must not interfere with typing. Include loading, empty, error, unauthorized and expired-session screens.

## 2.4 Motion and perceived speed

Use short hover, press and panel transitions, initially 100–180 ms for hover and 180–240 ms for entry. Prefer opacity and transform, keep controls responsive during animation, and avoid infinite decorative movement and layout thrashing. Respect prefers-reduced-motion; remove nonessential movement while keeping all feedback and controls.

**Acceptance / exit:** documented tokens and components cover realistic states. The shell works at desktop, tablet and mobile sizes; keyboard and screen reader users can navigate and close overlays; visible focus and WCAG 2.2 AA contrast are checked; reduced motion removes nonessential movement. Record a panel performance trace instead of claiming a frame rate without measurement.
