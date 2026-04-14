# Quality Tiers

Quality tiers set the baseline for product craft. The tier is selected during the Definition of Done phase and affects acceptance criteria, implementer behavior, and evaluator calibration.

## Tier Definitions

### `functional`
**The product works correctly.** No craft requirements beyond correctness.

Appropriate for: CLI tools, backend APIs, internal scripts, libraries, infrastructure.

Baseline: none beyond acceptance criteria.

### `polished`
**The product looks and feels professional.** A user encountering it would not think "this is a prototype."

Appropriate for: SaaS products, public-facing websites, SDK documentation sites, developer tools with UI.

Baseline checklist — all items are **expected** at this tier:
- [ ] Dark/light theme support (respects `prefers-color-scheme` at minimum; toggle preferred)
- [ ] Responsive layout tested at 320px, 768px, 1024px, 1440px
- [ ] Loading states for every async operation (skeleton or spinner, not blank)
- [ ] Error states with recovery action (not just "something went wrong")
- [ ] Empty states with guidance (not blank screens)
- [ ] Favicon and meta tags (title, description, og:image)
- [ ] Consistent spacing and typography scale (no magic numbers)
- [ ] Focus-visible styles for keyboard navigation
- [ ] Page title updates on navigation
- [ ] Smooth scroll behavior

### `delightful`
**The product creates a memorable experience.** Users would share it or comment on the quality.

Appropriate for: consumer-facing products, pitch demos, showcase/portfolio pieces, landing pages.

Baseline checklist — includes everything from `polished`, plus:
- [ ] Smooth page/view transitions (fade, slide, or cross-fade — not hard cuts)
- [ ] Animated sidebar/navigation (collapse/expand with easing)
- [ ] Micro-interactions on user actions (button press feedback, hover effects, success animations)
- [ ] Onboarding or first-run experience (guided tour, progressive disclosure, or welcome state)
- [ ] Custom illustrations or branded visual elements (not stock defaults)
- [ ] Performance budget: LCP < 2.5s, CLS < 0.1, INP < 200ms
- [ ] Sound or haptic feedback where appropriate (optional, but considered)
- [ ] Scroll-triggered animations or parallax (where natural, not gratuitous)
- [ ] 404 page that's on-brand (not browser default)

## Tier Selection Rules

The orchestrator selects the tier during the Definition of Done phase:

1. **Explicit override** — user specifies tier → use it. No questions asked.
2. **Task inference** (auto mode):
   - Task involves CLI, API, backend, library, infrastructure → `functional`
   - Task involves UI, frontend, website, dashboard, docs site → `polished`
   - Task includes "showcase", "demo", "pitch", "delightful", "beautiful", "impressive", "wow" → `delightful`
3. **Interactive mode** (`-i`) — ask the user which tier.
4. **Default** — if ambiguous, default to `polished` for UI work, `functional` for everything else.

Show tier selection:
```
🎯 Quality Tier: {tier}
   Baseline: {N items from tier checklist}
```

## How Tiers Affect the Pipeline

### Acceptance Criteria
The tier's baseline checklist items are **automatically appended** to the user's acceptance criteria. They appear in `.harness/acceptance-criteria.md` under a "## Quality Baseline ({tier})" section.

### Implementer (Build Mode)
The implementer prompt includes the tier checklist. In Build mode, the implementer is expected to address baseline items alongside functional requirements — not as an afterthought, but as part of the first pass.

### Evaluator (Severity Calibration)
Tier adjusts severity for missing baseline items:

| Missing baseline item | `functional` | `polished` | `delightful` |
|-----------------------|-------------|-----------|-------------|
| No dark/light theme | — (not expected) | 🟡 Warning | 🔴 Critical |
| No loading states | 🔵 Suggestion | 🟡 Warning | 🔴 Critical |
| No page transitions | — | 🔵 Suggestion | 🟡 Warning |
| No micro-interactions | — | — | 🟡 Warning |
| No favicon/meta tags | — | 🟡 Warning | 🔴 Critical |
| No responsive layout | — | 🔴 Critical | 🔴 Critical |

The evaluator prompt includes: "This product targets **{tier}** quality tier. Apply the severity calibration from quality-tiers.md."

### Gate Verdict
No change to gate mechanics — the severity adjustment means a `polished` product missing dark mode gets 🟡, which triggers ITERATE, which triggers the implementer in Polish mode. The system naturally loops until the tier baseline is met.
