# Side Panel Trust Design

How to make the "Select & Analyze" panel trustworthy for card sellers.

---

## Problem

The current panel gives conclusions without evidence. Users see outputs like
"PSA 8–9 · medium confidence" or "PSA 10: $340" with no way to verify *why*
the system arrived there. It reads as a black box, which means users can't
build confidence in it over time — and can't catch it when it's wrong.

Trust has four dimensions here:

1. **Explainability** — Can I see what the AI observed?
2. **Honest uncertainty** — Does it tell me when it's not sure?
3. **Data provenance** — Where do the prices come from?
4. **Track record** — Has it been accurate before?

---

## Ideas

### 1. Show analyzed image thumbnails in results
**Effort: low — Impact: high**

The results state shows no images. Users have to remember which photos they
submitted, and can't confirm the AI analyzed the right ones. Add small
thumbnails (Front / Back / Other label) at the top of the results view.

This closes the most basic trust gap: "did it look at what I think it looked at?"

---

### 2. Anchor every claim to its source
**Effort: medium — Impact: high**

Each claim should cite where it came from, inline:

| Claim | Anchor |
|---|---|
| PSA 10: $340 | "Based on 8 eBay sales · last 90 days" |
| Grade 8–9 | "Claude detected: left border heavy, surface clean" |
| ROI: positive | "At $45 listing + $25 fee vs. $340 PSA 10 EV" |

The comps note at the bottom of the current panel is a start. It needs to be
pulled inline and made specific — a trailing footnote is easy to ignore.

---

### 3. Calibrated confidence language
**Effort: low — Impact: medium**

Replace generic labels like "medium confidence" with explanations that name
the limiting factor:

- "Confidence limited — back image was blurry"
- "High confidence — both sides clearly visible, 8 comp sales found"
- "Grade range wide (6–9) — centering unclear from listing angle"

The existing `FRONT ONLY` / `FRONT + BACK` mode badge is a good pattern.
Extend it to explain *why* confidence is what it is, not just what it is.

---

### 4. Surface Claude's reasoning
**Effort: medium — Impact: high**

Claude already produces detailed front/back observation text. Add a
collapsible "AI Reasoning" section that exposes the raw observations:

> *"Front: left border measures approximately 60/40, surface shows faint
> diagonal lines consistent with light play, corners appear sharp.
> Back: centering appears centered, no visible damage."*

This is the strongest single trust signal. Users can agree or disagree with
individual observations, which lets them build a mental model of when to rely
on the system and when to override it.

**Implementation:** The backend already returns `front_analysis` and
`back_analysis` objects. The reasoning text can be assembled from those fields
and shown in a `<details>` element below the grade estimate.

---

### 5. Flag when analysis should not be trusted
**Effort: low — Impact: high**

Proactively surface limitations before users have to wonder. Show a warning
banner when:

- Only one image was analyzed (front-only)
- Image quality score is low (blurry, glare, extreme angle)
- Fewer than 3 comparable sales were found
- The card is a known difficult-to-grade variant

Example:

> ⚠️ *"Only one image analyzed. Front-only assessments miss back defects —
> treat this as a rough estimate."*

Saying "I'm not sure" makes the confident answers more credible. This is
already partially handled by the `FRONT ONLY` mode badge but needs to be
more visible and to cover the other conditions.

---

### 6. Price ranges instead of point estimates
**Effort: low — Impact: medium**

Replace `PSA 10: $340` with `PSA 10: $280–$410 (8 sales)`. A range is more
honest and still actionable. The ROI max-buy calculation can use the
conservative end of the range to avoid over-paying.

---

### 7. "Did this match?" feedback loop
**Effort: medium — Impact: high (compounds over time)**

Add a one-tap feedback widget at the bottom of each result:

```
Was this grade accurate?  [👍 Yes]  [👎 No — actual grade: ___]
```

Store feedback in Supabase linked to the listing URL and predicted grade.
Over time this enables:

- Personal accuracy stats ("8 of 10 predictions within 1 grade")
- Aggregate accuracy surfaced in the panel ("78% accuracy on Charizard ex")
- Fine-tuning signals for future model improvements

This is the compound trust builder — the panel earns credibility through a
track record that users can see.

**Schema sketch:**
```sql
create table grade_feedback (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users,
  listing_url text,
  predicted   jsonb,   -- grade_range, confidence, analysis_mode
  accurate    boolean,
  actual_grade numeric,
  created_at  timestamptz default now()
);
```

---

### 8. Comp card images (stretch)
**Effort: high — Impact: very high**

Show 2–3 thumbnail images of the actual eBay sold listings that anchored the
price estimate. If users can see "these are the specific sales we used," the
price goes from a magic number to a traceable fact.

Requires storing comp URLs server-side and returning them from the `/api/grade/analyze`
endpoint.

---

## Recommended Starting Point

The four highest-leverage changes that require the least new infrastructure:

| Priority | Change | Where |
|---|---|---|
| 1 | Image thumbnails in results | `sidepanel.js` — store URLs in state, render in result view |
| 2 | Calibrated confidence language | `sidepanel.js` — derive text from `analysis_mode` + `image_quality` fields |
| 3 | Reasoning excerpt (collapsible) | `sidepanel.js` + `sidepanel.html` — use existing `front_analysis`/`back_analysis` |
| 4 | "Did this match?" feedback | New Supabase table + small UI widget at result bottom |

Items 1–3 are pure frontend changes to the extension. Item 4 needs a backend
table and a new API endpoint but no changes to the grading pipeline.
