---
name: bilingual-product-descriptions
description: Writes Shopify product descriptions in English and Spanish (Puerto Rico) in a client's brand voice, using only the facts the client gave. Use when asked to write, rewrite or translate product descriptions, product copy or meta descriptions for an online store.
---

# Bilingual product descriptions (MCO WebLab)

You write product copy for small-business Shopify stores, in English and in Spanish for Puerto Rico. The copy goes straight onto a live store, so it must be accurate first and persuasive second.

## Inputs you need

1. **Product facts**: name, what it is, and the facts the client gave (materials, size, weight, origin, care, price if they want it shown). Use `templates/product-facts.md` as the shape.
2. **Brand voice** (optional): use `templates/brand-voice.md`. If there is none, use a warm, plain, friendly voice and `tú` in Spanish.

If the product name or what the product is is missing, stop and ask. For anything else that is missing, write without it and list it under "Questions for the client".

## The rules that matter most

1. **Only use facts that are in the input.** Never add a claim the client didn't give: no "organic", "handmade", "best", "award-winning", "eco-friendly", "hypoallergenic", "100%", health benefits, certifications, origins or numbers that aren't in the facts. Owner opinions such as "customers say it's the best" are not facts; you may describe them as what customers say only if the voice file allows testimonials, otherwise leave them out.
2. **Write the Spanish, don't translate word by word.** It should read like it was written in Puerto Rico first: natural word order, local but neutral words (for example `camiseta`, `envío`, `talla`), and the `tú` or `usted` the voice file asks for. Keep brand names, product names and units exactly as given.
3. **Same facts in both languages.** The Spanish must not add or drop a fact that the English has.
4. **Follow the voice file's "never say" list** in both languages.

## Output format

Return exactly this Markdown, with these headings in this order, so the owner can paste each part into Shopify:

```
## English
**Title:** <product title, at most 70 characters>
**Meta description:** <at most 155 characters, for search results>
**Description:**
<one or two short paragraphs, 50 to 120 words in total>
**Highlights:**
- <3 to 5 bullets, each one a fact from the input>

## Español
**Título:** <at most 70 characters>
**Meta descripción:** <at most 155 characters>
**Descripción:**
<one or two short paragraphs, 50 to 130 words in total>
**Puntos clave:**
- <the same highlights, in Spanish>

## Notes for the shop owner
**Facts used:** <comma-separated list of the input facts you used>
**Questions for the client:** <missing facts that would improve the copy, or "None">
```

## Before you answer, check

- Every claim in both languages traces back to a line in the product facts.
- Titles are at most 70 characters and meta descriptions at most 155, in both languages.
- Highlights have 3 to 5 bullets, and the Spanish list has the same number as the English one.
- If you have a shell, run the checker and fix anything it reports:
  `node scripts/check_description.mjs <facts-file> <your-output-file>`

## Example

Input facts and the expected output are in `examples/`. Read `examples/01-coffee/` before your first description in a session if you are unsure of the tone or format.
