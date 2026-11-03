# Guide: understand it, run it, explain it

This guide is for you, Mel. Claude Code built this project. Before it goes on your resume or comes up in an interview, you need to be able to run it, change it, and explain every part in your own words. Work through it in order. It should take about 3 to 4 hours.

---

## Part 1. The ideas, in plain words

### What is MCP?

**One sentence for interviews:** MCP (Model Context Protocol) is an open standard that lets an AI app like Claude use outside tools and data through a small server, the same way for every app.

Think of it like a USB port for AI. Before MCP, every app needed its own custom plug-in code. With MCP, you write one server and any MCP app (Claude Desktop, Claude Code, and others) can use it.

There are three roles:

- **Host:** the app the person talks to (Claude Desktop, Claude Code).
- **Client:** the part inside the host that connects to one server.
- **Server:** your program. It says "here are my tools" and runs them when asked.

This server talks over **stdio**: Claude Desktop starts `node dist/index.js` as a child process and they send JSON messages through its stdin and stdout. That's why the code never uses `console.log` (stdout is the message channel); logs go to `console.error`.

### What is a tool, and what's in a tool definition?

A tool is a function the AI can ask your server to run. Its definition (see `src/server.ts`) has:

1. **Name**, like `get_quote`.
2. **Description**: plain English that tells the model *when* to use it. This is the most important part. The model reads it to decide.
3. **Input schema**: the arguments allowed, with types and allowed values. `projectType` can only be one of the four service ids, so the model can't make one up.
4. **Output schema**: the JSON shape of the answer, so the app can trust it.
5. **Annotations**: hints like `readOnlyHint: true` (this tool changes nothing).

### How does Claude decide to call a tool?

When the app starts, it asks the server for its tool list and gives the names, descriptions and schemas to the model. When a person asks something, the model reads those descriptions and decides on its own if a tool would help. If yes, it outputs a "tool call" (tool name plus arguments as JSON). The app sends that to the server, the server runs the function and sends back the result, and the model writes its answer using that result. The model never runs your code itself; it only asks.

You can see this happen in `docs/demo-runs.md`.

### Tool vs resource

A **tool** is something the model *chooses* to call (an action or a lookup with arguments). A **resource** is read-only data the *app or person* can attach as context, like a file. Here, the price list is also a resource (`mcoweblab://pricing.json`).

### What is a Claude skill?

A skill is a folder with a `SKILL.md` file: a name, a one-line description, and written instructions, plus optional templates, examples and scripts. Claude only sees the name and description at first. When a request matches the description, it loads the full instructions. That keeps Claude's context small until the skill is needed.

So the description decides *when* it's used, and the instructions decide *how well*.

---

## Part 2. Run it yourself

Do these on your laptop. Write down anything that doesn't work; that's a real debugging story.

1. Unzip `mcoweblab-mcp.zip` into your Job search folder. Open a terminal there.
2. `npm install`, then `npm run check`. You should see 40 tests pass.
3. `npm run inspect`. The MCP Inspector opens in your browser. Click **Connect**, then **Tools**, then **List Tools**. Call `get_quote` with `shopify-store` and the `bilingual` add-on. Compare with your quote calculator.
4. Try to break it in the Inspector: an add-on that doesn't fit (`menu-photos` on a Shopify store), or 50 pages. Read the errors.
5. Connect it to Claude Desktop (steps in the README). Ask: "What would a 5-page Shopify site with Spanish translation cost?" and "Mido 96 cm de pecho, ¿qué talla de camiseta unisex me queda?". Take screenshots. These are *your* demo, and much better proof than the recorded runs.
6. Install the skill (README) and ask Claude for descriptions of one product. Run the checker on the result.

---

## Part 3. Read the code (in this order)

| File | What to understand |
|---|---|
| `src/tools/getQuote.ts` | How it checks the request, calls `calculateQuote()`, and works out which draft values the quote used. |
| `src/server.ts` | How each tool is registered: description, input schema, output schema. How `respond()` turns a `ToolInputError` into `isError: true`. |
| `src/tools/getSizeChart.ts` | The cm conversion and `recommendSize()` (in a gap, pick the larger size). |
| `src/data.ts` | Why the server refuses to start if a data file is broken. |
| `test/server.test.ts` | How a test talks to the server through a real MCP client in memory. |
| `skills/bilingual-product-descriptions/SKILL.md` | The rules, the output format, the self-check. |
| `skills/.../scripts/check_description.mjs` | What the checker catches, and what it can't. |

---

## Part 4. Exercises (do them yourself)

There are no solutions here on purpose. Ask Claude for a hint if you're stuck, not the answer. Each one you finish is something you can honestly say you did.

1. **Add a size chart.** Add a "women's leggings" chart to `data/size-charts.json` with waist and hip. Run the tests. Then break it on purpose (leave out one hip value) and read the error.
2. **Add a tool.** Write `list_size_charts`: no input, returns each chart's id and name. Add the function in `src/tools/`, register it in `src/server.ts`, and write a test. (Hint: copy how `list_services` is done. One existing test checks the exact list of tools, so you'll need to update it.)
3. **Improve the skill.** Pick one weakness from `evals/RESULTS.md` (for example "picor" vs "pique"), change `SKILL.md` to fix it, rerun that case, and record the result.
4. **Review the skill outputs.** Read the three `output-run1.md` files as a native speaker. Write what you'd change in `evals/RESULTS.md`.

---

## Part 5. Interview practice

Say these out loud. Short and honest beats long and fancy.

**"Tell me about a project where you built with AI."**
> I built an MCP server for my web studio so Claude can look up my services and give accurate quotes. It reuses the pricing code from my website's quote calculator, so the AI and the site always agree. I built it with Claude Code. My job was deciding what it should do, checking it, and testing it with real conversations. One test showed Claude guessing a size when a measurement fell between two sizes, so I moved that decision into code and had the AI explain the result instead.

**"What's MCP?"**
> An open standard for giving AI apps tools and data. You write a server once, and any MCP app can use it.

**"How do you stop the AI from making up prices?"**
> Three ways. The input schema only allows real service and add-on ids. The numbers come from code, not the model. And the data marks which prices I haven't approved, so every quote says when it's a draft and Claude tells the customer.

**"What happens when the model sends bad input?"**
> The server sends back an error that says what's valid, marked as a tool error, so the model can fix the call and try again. You can see it recover in my demo log.

**"How did you test the skill?"**
> I wrote test products, including tricky ones: one with owner opinions like "best hot sauce in PR" and "all natural", and one with almost no facts. I ran the skill on them and checked the output with a script that catches made-up numbers and risky claims, then I read them myself for the Spanish. *(Say the last part only after you've actually read them.)*

**"What would you do next?"**
> Swap in the real size charts from my Size Guide app, read prices live from my site instead of a copy, and add an HTTP version so it could run as a hosted service.

---

## Part 6. Before it goes on your resume

The project rule is that a resume line comes only after the project is public. So:

1. Do Parts 2 to 4.
2. Update the "How I built it" section of the README with what you did.
3. Decide if you want a public GitHub repo. If yes, check that nothing private is in it (there are no API keys or client data in this project).
4. Then the resume line can say:

> **MCO WebLab MCP Server** (TypeScript, Model Context Protocol), GitHub
> Built with Claude Code an MCP server that lets Claude look up MCO WebLab services, quotes and size charts through tools, reusing my quote calculator's pricing logic. Wrote and tested a Claude skill for bilingual (EN/ES) Shopify product descriptions with an automated output checker.

Use "tested" only after you've run the tests and the skill yourself.
