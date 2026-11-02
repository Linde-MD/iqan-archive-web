# IQAN Archive design system

## Direction

Use a dark, data-dense engineering workspace for project archives and version graphs. Build hierarchy with a deep navy canvas, distinct raised panels, restrained blue accents, and compact labels. Keep the interface technical and calm: no marketing-page hero layout, decorative neon glow, or brand assets from unrelated products.

## Tokens

| Role | Value |
| --- | --- |
| Canvas | `#0b1120` |
| Top bar | `#0d1728` |
| Main panel | `#121c2d` |
| Soft panel | `#18253a` |
| Raised panel | `#1d2b42` |
| Primary text | `#eef4ff` |
| Secondary text | `#afbdd2` |
| Primary action | `#1d4ed8` |
| Accent | `#60a5fa` |
| Focus ring | `#7dd3fc` |
| Border | `#35445c` |
| Success | `#6ee7b7` |
| Warning | `#fcd34d` |
| Error | `#fca5a5` |

Map these roles to the semantic CSS variables in `src/style.css`. Keep normal text at 4.5:1 contrast or higher; important non-text indicators and component boundaries must remain distinguishable. Use branch colors only as supplemental identity, never as the only release or selection signal.

## Typography

- UI and Chinese content: `"Segoe UI", "Microsoft YaHei", system-ui, sans-serif`.
- Version numbers and paths: platform monospace fonts with a readable Chinese fallback.
- Use compact, clearly grouped headings and labels. Do not fetch external fonts at runtime.

## Layout and components

- Keep the project list as a persistent desktop rail beside the active file or graph workspace; stack regions on narrow screens.
- Use layered dark surfaces, thin cool borders, restrained shadows, and consistent 8/12/16/24px spacing.
- Render the version graph as a Git-style vertical history, not a fit-to-canvas DAG. Parent-child edges determine row order; branch-colored rails and branch-head labels sit beside readable version/description text, while released state uses a shield mark with an accessible status name. Put nodes with no parent or child edges in a distinct unassociated-version column. Keep row height stable so long histories scroll instead of shrinking.
- Keep graph navigation predictable: native vertical scrolling, Shift+wheel horizontal scrolling, and cursor-anchored Ctrl+wheel/toolbar zoom. Zoom must not pan the first row out of reach. Remove node and canvas dragging; use explicit selection, menus, and the searchable parent-version picker for graph edits. Preserve local scrolling for large tables and graphs.
- Prefer flat SVG icons with visible keyboard focus, accessible names, and a 44px minimum control target.
- Use transparent icon controls instead of filled, bordered toolbar buttons. Graph commands, file selection/sort, and directory scan actions use a small caption below the icon; hover and keyboard focus disclose supplemental hints. Keep filter labels, menu text, form submissions, registration counts, and destructive confirmations explicit. Disabled tools remain visibly disabled and cannot execute.
- Preserve visible status text for loading, empty, success, disabled, and error states. Never rely on color alone.

## Motion

- Use Vue's built-in `Transition`/`TransitionGroup` and CSS for short list, feedback, and surface transitions; do not add an animation package for these effects.
- Keep motion subtle and non-blocking. Do not animate graph geometry in a way that obscures relationships or interferes with pointer operations.
- Honor `prefers-reduced-motion` by removing non-essential movement and minimizing transition duration.
