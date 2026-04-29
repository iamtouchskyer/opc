# Design System — Theme Architecture

When building UI for this project, follow the **CSS custom property theming** pattern:

## Rules

1. **Never hardcode colors** — always use `var(--token-name)` for any color, shadow, or border value
2. **Token list** — the canonical tokens are defined in `theme-schema.json`. Key tokens:
   - Colors: `--bg`, `--bg-card`, `--text`, `--text-muted`, `--accent`, `--accent-light`, `--border`
   - Typography: `--heading-font`, `--body-font`
   - Shape: `--border-radius`, `--card-shadow`
   - Category colors: `--cat1` through `--cat6`
3. **Theme switching** — use `data-theme="theme-id"` on `<html>` element
4. **Theme generation** — new themes can be generated via `theme-generator.mjs`:
   ```bash
   node theme-generator.mjs generate "style descriptor"
   node theme-generator.mjs export --all --format css-block
   ```

## Pattern Example

```css
/* Good — themeable */
.card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--border-radius);
  box-shadow: var(--card-shadow);
  color: var(--text);
}

/* Bad — hardcoded */
.card {
  background: #ffffff;
  border: 1px solid #eee;
  border-radius: 8px;
  color: #333;
}
```

## Theme JSON Structure

Each theme is a JSON file with `tokens.color`, `tokens.typography`, and `tokens.shape` sections. The token names map 1:1 to CSS custom properties. See `theme-schema.json` for the full specification.
