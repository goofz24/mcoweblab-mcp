# Demo runs: real Claude Code using the MCP server

These are real runs from Nov 3, 2026. Claude Code (headless, `claude -p`, model Sonnet 5.5) was started with this server in its MCP config. Below is every tool call Claude made, what the server sent back (shortened), and Claude's final answer, copied from the run logs. Nothing was edited except shortening long results with "...".

## Run 1: a price question in English

**Prompt:** What would a 5-page Shopify site with Spanish translation cost?

- Claude Code loads the tool definitions (ToolSearch).
- **Tool call:** `get_quote` with `{"projectType": "shopify-store", "pages": 5, "addons": ["bilingual"]}`
  - **Result**: `{"projectType":"shopify-store","projectName":"Shopify store","pages":5,"lineItems":[{"id":"shopify-store","name":"Shopify store","amount":800,"confirmed":true},{"id":"bilingual","name":"English + Spanish version","amount":150,"confirmed":false}],"estimateLow":950,"estimateHigh":1190,"monthly":0,"typicalWeeks":4,"isDraft":true,"unconfirmedValuesUsed":["projectTypes.shopify-store.includedPages","projectTypes.shopify-st...`

**Claude's answer:**

> The quote tool gives an estimate of about $950 to $1,190 for a 5-page Shopify site with English and Spanish versions. That is the approved $800 Shopify starting price plus a $150 bilingual add-on, with a buffer on top for the upper end. This is a draft estimate, not a final price: the bilingual price, the number of included pages, the timeline (about 4 weeks) and the buffer percentage are not yet approved, and the final price is set after a free consultation.


## Run 2: Spanish, two questions, before the size-recommendation fix

**Prompt:** Hola, mido 96 cm de pecho. ¿Qué talla de camiseta unisex me queda? También, ¿cuánto costaría un menú QR con carga de productos?

- **Tool call:** `get_size_chart` with `{}`
- **Tool call:** `get_quote` with `{}`
  - **Error result**: `MCP error -32602: Input validation error: Invalid arguments for tool get_size_chart: Invalid option: expected one of "unisex-tshirt"|"womens-top"|"kids-tshirt" at chart`
  - **Error result**: `MCP error -32602: Input validation error: Invalid arguments for tool get_quote: Invalid option: expected one of "custom-website"|"shopify-store"|"qr-menu"|"wallet-card" at projectType`
- Claude Code loads the tool definitions (ToolSearch).
- **Tool call:** `get_size_chart` with `{"chart": "unisex-tshirt", "language": "es", "unit": "cm"}`
  - **Result**: `{"chart":"unisex-tshirt","name":"Camiseta unisex","unit":"cm","sampleData":true,"howToMeasure":"Mide alrededor de la parte más ancha del pecho, debajo de los brazos. Mide el largo desde el punto más alto del hombro hasta el ruedo.","columns":[{"id":"chest","name":"Pecho"},{"id":"length","name":"Largo del cuerpo"}],"rows":[{"size":"S","measurements":{"chest":{"min":86.5,"max":94},"length":{"min":71,"max":71}}},{"size"...`
- **Tool call:** `get_quote` with `{"projectType": "qr-menu", "addons": ["product-upload"], "language": "es"}`
  - **Error result**: `The add-on "product-upload" isn't available for qr-menu. Add-ons for qr-menu: bilingual, copywriting, menu-photos.`
- **Tool call:** `get_quote` with `{"projectType": "qr-menu", "language": "es"}`
  - **Result**: `{"projectType":"qr-menu","projectName":"Menú digital QR","pages":1,"lineItems":[{"id":"qr-menu","name":"Menú digital QR","amount":250,"confirmed":true}],"estimateLow":250,"estimateHigh":320,"monthly":0,"typicalWeeks":1,"isDraft":true,"unconfirmedValuesUsed":["projectTypes.qr-menu.includedPages","projectTypes.qr-menu.baseWeeks","estimate.upperBufferPercent"],"notes":["Estimates are a starting point. The final price is...`

**Claude's answer:**

> **Talla:** con 96 cm de pecho te queda **M** (rango 96.5–104 cm). Estás al límite entre S (86.5–94) y M, así que M es lo más seguro. Si prefieres ajustada, pide S. Ojo: esta tabla es de muestra.
> 
> **Menú QR:** el precio base es **$250**. El estimado es de **$250 a $320**, con unas 1 semana de entrega. Es un borrador, no un precio final. Solo el $250 está confirmado. El rango y el plazo no. Cargar productos no aparece como extra para menús QR. Solo hay extras de bilingüe, redacción y fotos del menú. Cuánto costaría cargar los productos se confirma en una consulta gratis.


## Run 3: the same size question, after adding size recommendations

**Prompt:** Hola, mido 96 cm de pecho. ¿Qué talla de camiseta unisex me queda?

- Claude Code loads the tool definitions (ToolSearch).
- **Tool call:** `get_size_chart` with `{"chart": "unisex-tshirt", "bodyMeasurement": {"measurement": "chest", "value": 96}, "unit": "cm", "language": "es"}`
  - **Result**: `{"chart":"unisex-tshirt","name":"Camiseta unisex","unit":"cm","sampleData":true,"howToMeasure":"Mide alrededor de la parte más ancha del pecho, debajo de los brazos. Mide el largo desde el punto más alto del hombro hasta el ruedo.","columns":[{"id":"chest","name":"Pecho"},{"id":"length","name":"Largo del cuerpo"}],"rows":[{"size":"S","measurements":{"chest":{"min":86.5,"max":94},"length":{"min":71,"max":71}}},{"size"...`

  - ...and at the end of that result: `"recommendation":{"measurement":"chest","value":96,"size":"M","fit":"between","explanation":"Pecho 96 cm queda entre S (hasta 94 cm) y M (desde 96.5 cm). Se sugiere la talla más grande, M, para que no quede apretada."}`

**Claude's answer:**

> Te recomiendo la **M**. Con 96 cm de pecho quedas entre la S (hasta 94 cm) y la M (desde 96,5 cm), y la M evita que te quede apretada.
> 
> Ojo: la tabla es de **datos de ejemplo**, no una tabla final.


## What the runs show

- **Run 1:** Claude picked `get_quote` and the right arguments on its own from the tool description and schema, and it told the person the estimate is a draft because `isDraft` was true.
- **Run 2:** Claude Code's first two calls had no arguments, because it tried the tools before loading their definitions. The server's input schema rejected them with a clear message, Claude loaded the definitions and retried correctly. It also asked for an add-on (`product-upload`) that doesn't exist for QR menus, got a recoverable error listing the valid add-ons, and recovered. But the size answer had a problem: 96 cm falls in the gap between S (up to 94 cm) and M (from 96.5 cm), and Claude guessed, even suggesting S "if you prefer it tight", which doesn't fit.
- **The fix:** `get_size_chart` got an optional `bodyMeasurement` input and returns a `recommendation` computed by code (in a gap, suggest the larger size). Unit tests cover the 96 cm case.
- **Run 3:** Claude passed the measurement, and its answer now comes straight from the server's recommendation.
