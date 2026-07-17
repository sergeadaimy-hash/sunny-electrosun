# The Knowledge Vault

The vault is a folder of plain text files that hold ElectroSun's business knowledge. Sunny does not read all of it on every message. Instead, the classifier tags each incoming message with up to 3 topics, and Sunny's reply only receives the matching files, capped at roughly 1,000 tokens. This keeps replies cheap no matter how much knowledge the business adds over time.

No special software is needed to edit these files. Any text editor works (Notes, TextEdit, Notepad, or Obsidian if you like it, the files are ordinary markdown).

## Folder layout

```
vault/
├── tag-map.json            The topic list: which tag loads which file.
├── products/
│   ├── inverters.md
│   ├── batteries.md
│   ├── panels.md
│   └── accessories.md
├── policies/
│   ├── warranty.md
│   ├── delivery.md
│   ├── payment-plans.md
│   └── pricing.md          Pricing POLICY only, never actual prices.
└── playbook/
    ├── objections.md
    ├── escalation-rules.md
    └── language-notes.md
```

## How to edit a knowledge file

1. Open the file and write plain English. Short lines work best.
2. Replace each `[TODO: ...]` line with real knowledge, or delete it.
3. Any line still containing `[TODO` is invisible to Sunny, and so is
   everything between the `%%` markers at the top of each file. A file that
   is still all TODO costs nothing and changes nothing.
4. Never use double dashes anywhere in these files (no em dash, no `--`).
5. Never put prices, stock quantities, or bank account numbers in the vault.
   Prices and stock live in the admin Warehouse Stock tab; account details
   are only shared by the Sales Manager.
6. Changes take effect within about 30 seconds of the file being deployed
   (the vault is read fresh with a short cache, no restart needed). On
   Railway, files ship with the code, so an edit needs a git push to go live.

## The tag map (vault/tag-map.json)

Each entry in `tag-map.json` defines one topic tag:

```json
"warranty": {
  "file": "policies/warranty.md",
  "title": "Warranty policy",
  "description": "warranty terms, guarantees, repairs, replacements",
  "keywords": ["warranty", "guarantee", "replace", "repair"]
}
```

- `file`: which vault file this tag loads.
- `title`: the heading Sunny sees above the content.
- `description`: shown to the classifier so it knows when to pick the tag.
- `keywords`: a deterministic backup. If the classifier returns no tags,
  the code matches these words against the customer's message directly.

To add a new topic: create the markdown file, add an entry here, done.
No code change is needed. The classifier's tag list and the retrieval both
read this map.

## How it works technically (short version)

1. The classifier call gets a small extra instruction block (built from
   `tag-map.json`) asking for a `topic_tags` array in its JSON output.
2. The handler passes those tags into the reply call.
3. `src/vault.js` loads the matching files, strips TODO scaffolding, caps
   the total at `VAULT_PROMPT_BUDGET_TOKENS` (default 1000 tokens, oldest
   content in the last file is trimmed at a line boundary), and wraps it in
   a `<business_knowledge>` block injected after the cached system blocks.
4. Every injection is logged as `vault.injected` with an estimated token
   count, so savings and usage are measurable in the logs.
5. Everything is fail-open: if the vault is missing or broken, Sunny
   replies normally without it.

## Environment variables

| Var | Default | Meaning |
|---|---|---|
| `VAULT_DIR` | `<repo>/vault` | Where the vault lives. |
| `VAULT_PROMPT_BUDGET_TOKENS` | `1000` | Hard cap on injected vault content per message. |
| `VAULT_MAX_TOPIC_FILES` | `3` | Max topic files injected per message. |
