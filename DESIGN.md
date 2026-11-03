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
- Align the top edges of the project rail and active workspace; rely on the outer grid gap for stacked spacing instead of an extra workspace top margin.
- Allow the entire project rail to collapse without unmounting forms, retaining a visible expand control. Resize only the history viewport with a 44px bottom-right handle, bounded by its column width; arrow keys adjust size and Home restores defaults. Keep toolbar and inspector geometry independent. Layout preferences are session-only.
- Provide native fullscreen for the graph with elevated floating control and inspector surfaces. Allow both to collapse without discarding form input. Reserve desktop space so focused graph rows remain unobscured; on narrow screens use a dismissible inspector overlay. Keep an exit control visible when tools collapse, honor native Escape, and restore normal geometry on exit. Fullscreen is view-only state, not a graph command.
- Use layered dark surfaces, thin cool borders, restrained shadows, and consistent 8/12/16/24px spacing.
- Render the version graph as a Git-style vertical history, not a fit-to-canvas DAG. Parent-child edges determine row order; branch-colored rails and branch-head labels sit beside readable version/description text, while released state uses a shield mark with an accessible status name. Put nodes with no parent or child edges in a distinct unassociated-version column. Keep row height stable so long histories scroll instead of shrinking.
- Keep graph navigation predictable: native vertical scrolling, Shift+wheel horizontal scrolling, and cursor-anchored Ctrl+wheel/toolbar zoom. Zoom must not pan the first row out of reach. Remove node and canvas dragging; use explicit selection, menus, and the searchable parent-version picker for graph edits. Preserve local scrolling for large tables and graphs.
- Route cross-lane edges with a one-row-high curve beside the inner-lane endpoint and a vertical outer-lane segment for the remaining history. Preserve this fork/merge geometry in either sort direction instead of stretching curves across intervening rows.
- Branch scope uses a searchable checkbox dropdown with independent, unlimited multi-selection, Show All, and Clear All. Selected histories form a union without duplicate ancestors; isolated versions remain visible even with no branches selected. Search only narrows the choices, never clears hidden selections. Keep the dropdown open while toggling and support keyboard focus, Escape, and outside-click dismissal.
- Keep graph editing in the right-hand inspector, replacing its read-only details while an operation is open. Include version, parent, merge, branch, and deletion forms. Constrain its height and scroll only the inspector; focus the first editable field without scrolling the page, then return focus to the graph on close. On narrow screens, use a dismissible right-hand overlay with internal scrolling and a visible close control, never a form below the graph.
- Allow only branch labels to drag onto version rows, highlight the target, and require a modal confirmation showing old/new heads before writing. Keep nodes and canvas non-draggable. The branch editor provides the equivalent explicit head selector for keyboard and single-pointer users.
- Add parents with one compact row: an editable combobox with an inset dropdown arrow and an explicit Add button. Filter the version-adjacent recommendations by version/description as the user types; require an actual option selection before enabling Add. Keep options locally scrollable with an empty state and Arrow/Enter/Escape keyboard support.
- Reuse this parent picker for each child in deletion reconnection previews, preserving automatic initial parents and showing removable selected items instead of a wall of candidate checkboxes. Keep each child's search independent and released children read-only.
- Prefer flat SVG icons with visible keyboard focus, accessible names, and a 44px minimum control target.
- Version information hints use the same dark raised surface, cool-blue accent, thin border and restrained shadow as graph panels. Show full version, release text and multiline description on hover/focus; use a viewport-bounded top-layer popover, keep it hoverable and scrollable, and support Escape dismissal instead of native white title tooltips.
- Pointer-triggered version hints follow the cursor with a 16px bottom-right offset, flipping left/up at viewport edges and keeping an 8px viewport margin. Keyboard focus retains row-anchored positioning. Stop following when the pointer leaves the row so the hint remains reachable for reading and scrolling.
- Use transparent icon controls instead of filled, bordered toolbar buttons. Graph commands, file selection/sort, and directory scan actions use a small caption below the icon; hover and keyboard focus disclose supplemental hints. Keep filter labels, menu text, form submissions, registration counts, and destructive confirmations explicit. Disabled tools remain visibly disabled and cannot execute.
- Preserve visible status text for loading, empty, success, disabled, and error states. Never rely on color alone.

## Motion

- Use Vue's built-in `Transition`/`TransitionGroup` and CSS for short list, feedback, and surface transitions; do not add an animation package for these effects.
- Keep motion subtle and non-blocking. Do not animate graph geometry in a way that obscures relationships or interferes with pointer operations.
- Honor `prefers-reduced-motion` by removing non-essential movement and minimizing transition duration.
