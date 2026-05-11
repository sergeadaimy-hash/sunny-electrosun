# Prompt archive

Snapshots of the master prompts before significant restructurings. Each subfolder is a date in YYYY-MM-DD form, taken at the moment immediately before the change.

These files are reference material, not loaded by the running system. The live prompts live one level up in `src/prompts/`.

## 2026-05-11

Last version before the technical-knowledge refactor. After this point:

- Per-product specs (BOS series pack tables, BOS pack kWh figures, Deye product-line declaration, "Deye 12kW = 2.4M NGN") were stripped from `system.md` and moved to a new datasheet-text field on `warehouse_items`, auto-extracted from uploaded PDFs.
- A new dynamic prompt block, "Datasheet Knowledge", is injected per turn with the extracted text for items in scope (customer-mentioned + admin-flagged staples).
- `system.md` Section 8 (engineering principles) was slimmed to universal physics only.
- Section 16 worked examples were cleaned of any hard prices or stock claims.
