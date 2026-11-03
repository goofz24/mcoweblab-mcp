# Skill test results

**Date:** Nov 3, 2026. **How:** Claude Code (headless, model Sonnet 5.5) in a test folder with the skill installed under `.claude/skills/`. Each case got one plain request, for example: "Write the Shopify product descriptions for the product in cases/02-tshirt/facts.md. Brand voice: cases/02-tshirt/voice.md. Save the result to cases/02-tshirt/output.md." The request never named the skill.

All products are **fictional**, written for the test. None is a real client's product.

| Case | What it tests | Skill used on its own? | Checker | Notes from reading the output |
|---|---|---|---|---|
| 02-tshirt | Normal product with price, sizes, care, and a brand phrase to use | Yes | 17 of 17 checks pass | Accurate. The Spanish title "Camiseta Ponce Sunset Tee" repeats "camiseta" and "tee", a small wording issue. |
| 03-hot-sauce | Owner's notes full of claims we can't use: "best hot sauce in PR", "basically healthy", "all natural", "grandmother's recipe" | Yes | 17 of 17 | Left out all four and explained why in the notes, and offered "made from a family recipe" if the owner confirms. Spanish uses "picor"; in Puerto Rico "pique" may sound more natural. A native speaker should decide. |
| 04-candle | Almost no facts and no brand voice file (tempting to invent size, burn time, "natural", "handmade") | Yes | 16 of 16 (no voice file, so no "never say" check) | Invented no facts. Asked for jar size, burn time, price, care, and whether it's handmade or made in PR. "Brings the feeling of the shore into your home" is mood, not a factual claim. |

The outputs are saved next to each case as `output-run1.md`.

## What the checker does and doesn't prove

`scripts/check_description.mjs` checks structure and the most dangerous mistakes: missing sections, titles over 70 characters, meta descriptions over 155, word counts, matching bullet counts in both languages, numbers that aren't in the facts, risky claims (organic, best, natural, healthy, handmade and more) that aren't in the facts, and the brand's "never say" words. Claims that only appear in the owner's notes count as invented. Its own behavior is tested in `test/skill-checker.test.ts` (7 tests, including cases it must catch).

It can't judge tone, whether the Spanish sounds natural, or a claim worded in a way it doesn't know. That still needs a person: **Mel has not reviewed these outputs yet.**

## To do before calling this "tested" on a resume

1. Mel reads the three outputs and notes anything wrong, especially the Spanish.
2. Optional: run it on one real client product, with the client's permission, and compare with the copy on their store.
