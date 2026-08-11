# Design Ops Portal

## Files

- `design_ops_portal.html`: single-file entry (all pages in one file, hash routing enabled).
- `dashboard.html`, `database.html`, `iamap.html`, `boards.html`, `ai.html`: standalone page entries for direct page opening.
- `app.js`: shared portal data and logic used by all HTML entries.
- `styles.css`: shared styles used by all HTML entries.

## How to Open

- Open any entry file directly in a browser.
- For a local server (recommended for best browser behavior), run this from the same folder:

```bash
python3 -m http.server 8080
```

Then open:
- `http://localhost:8080/design_ops_portal.html` (single-file mode), or
- `http://localhost:8080/dashboard.html` (or any other page file).

## Routing Behavior

- **Single-file mode** (`design_ops_portal.html`):
  - Uses hash routing (`#dashboard`, `#database`, `#iamap`, `#boards`, `#ai`).
  - Sidebar tab changes update the URL hash.

- **Multi-file mode** (`dashboard.html`, `database.html`, `iamap.html`, `boards.html`, `ai.html`):
  - Each file opens with its matching default page.
  - Sidebar tab changes navigate to the corresponding HTML file.

## Notes

- Sign-in, task boards, IA map, database, dashboard analytics, AI assistant, drawers/modals, and storage behavior are shared and fully connected through `app.js`.
