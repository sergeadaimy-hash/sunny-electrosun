# Sunny Case-Study Deck, Design Spec

Date: 2026-05-27
Status: approved by Serge for build

## Goal

Produce a polished 16:9 PowerPoint case-study deck that promotes Sunny's success at ElectroSun, suitable for three overlapping audiences:

1. Prospects (other businesses, agencies) who might hire Serge to build an agent for them.
2. Investors or partners evaluating the platform potential.
3. Public-facing portfolio piece (website, LinkedIn, talks).

The deck is the artifact Serge presents when someone asks "what does your AI agent actually do?"

## Voice and framing

Third-person. Serge's agency tells ElectroSun's story.
> "We built Sunny for ElectroSun. Here is what he does, how he works, and why he outperforms a chatbot."

ElectroSun is the proof point. The agency is the deliverer.

## Visual identity

Carries forward the existing `presentation/sunny-overview.html` brand DNA so the two artifacts read as one family:

- Background: cream (`#f6efe1`) base with subtle radial gradients of warmer cream.
- Accent: warm sun (`#f4a72a`) with deeper ember (`#c5481c`) for emphasis. Optional teal (`#1f6f7a`) for secondary data accents.
- Type: Fraunces (serif) for headlines, Inter (sans) for body and labels. Italics + gradient fills on key accent words.
- Surfaces: paper cream (`#fbf6ea`) cards on cream background, hairline borders, soft `0 6px 18px -10px` shadow.
- Mood: editorial, confident, AI-native (Anthropic / OpenAI direction).
- Layout density: generous whitespace; one big idea per slide; supporting detail in cards or diagrams beneath.

## Build flow

1. Frontend-design agent builds the deck as a single-file HTML at `presentation/sunny-case-study/index.html` using the bold-modern style above. 16:9 slides, each slide is a `<section class="slide">` with fixed 1920x1080 viewport. Diagrams are SVG (native shapes, not images) so the html-to-pptx bridge can emit them as native PPTX shapes with editable text.
2. Html-to-pptx bridge converts the HTML to `presentation/sunny-case-study.pptx`. Text stays editable. Diagrams become native shapes. Screenshot placeholders become picture-frame shapes that the user can right-click and replace.
3. Both artifacts live in `presentation/`. The HTML version is the browser preview and the editable source; the PPTX is the shareable deliverable.

## Screenshot placeholder strategy

Approved: mocked stand-ins.

Every placeholder is a styled component that shows realistic mock data so the deck reads end-to-end on first open. Each placeholder carries a small `[MOCK]` tag in the corner so it cannot be mistaken for a real screenshot. The user replaces them with real captures from the live admin and from WhatsApp.

Categories of placeholders:

- Admin tab screenshots (7 placeholders): Inbox, Contacts, Warehouse Stock, Owner Chat, Rules editor, Models & Config, Take-over panel.
- WhatsApp conversation screenshots (5 placeholders): technical reply, costing reply, classification + escalation, voice note transcription, owner alert.
- Optional: 2 brand placeholders for any photos Serge wants to add (team, office, etc.).

Total roughly 12 to 15 placeholders.

## Deck outline, 10 sections, ~40 slides

### Section 1, Hook and framing (3 slides)
1. Title: "Sunny: An AI Account Manager for WhatsApp Business". Subtitle: "Case study: ElectroSun, Nigeria. Built by [Agency]."
2. The 30-second pitch: what Sunny does in one screen.
3. The opportunity: why WhatsApp-first markets need this now.

### Section 2, The problem (2 slides)
4. ElectroSun before Sunny: leads piling up, slow replies, missed deals.
5. Why chatbots fail: 5 specific failure modes (no memory, no business context, no escalation, no language coverage, no learning).

### Section 3, Meet Sunny (4 slides)
6. What Sunny does: 8 capabilities at a glance (reply, classify, escalate, transcribe, send photos, send documents, take over, report).
7. Sunny is not a chatbot: 5-point differentiation.
8. A day in Sunny's life: narrative walk-through.
9. By the numbers: lead times, languages, scale.

### Section 4, How he works, the architecture (6 slides)
10. The full architecture diagram. THE big workflow diagram. SVG, native shapes.
11. Where Sunny lives: GitHub (code source of truth) + Railway (running agent + data) + WhatsApp Cloud API (channel).
12. The brain: Anthropic Claude multi-model strategy. Opus 4.7 on customer reply, Sonnet 4.6 on classifier and teacher and owner Q&A. Why split.
13. The pipeline: message in to response out, step by step.
14. Conversation state engine: how Sunny remembers what the customer already said and what was already asked.
15. 14 layers of reply guards: the validators that catch hallucinations, price leaks, repeated questions, prompt-injection, owner-number leaks before any reply ships.

### Section 5, What he knows (4 slides)
16. Warehouse Stock: the source of truth. Stock state per location, prices, datasheets, photos. Edited live from admin, reflects in the next reply.
17. Knowledge layers: master prompts, knowledge facts, conversation history, conversation-state engine.
18. Owner Q&A mode: Sunny answers the owner's questions about his own data (today's stats, last 24h hot leads, pending queries).
19. Voice, photos, documents: Whisper transcription, photo fast-path, datasheet fast-path.

### Section 6, Lead classification and escalation (4 slides)
20. Lead categories: HOT, SERIOUS, COLD, REPEAT_CLIENT, DISQUALIFIED. What each means. How they're detected.
21. HOT lead handoff: payment-ready alert flow. WhatsApp screenshot placeholder showing the owner's view.
22. Negotiation, silent query, repeat: the three other escalation types. When the owner gets paged.
23. Anatomy of an owner alert: header label + customer name + classifier signals + verbatim message + 6-turn conversation brief + admin deep-link + wa.me link. Screenshot placeholder.

### Section 7, The admin platform (9 slides, one per tab)
24. Admin overview: what the owner controls without touching code.
25. Inbox tab. Screenshot placeholder. Two-pane WhatsApp-style view.
26. Contacts tab + Excel export. Screenshot placeholder.
27. Warehouse Stock tab + per-item datasheets + per-item photos. Screenshot placeholder.
28. Owner Chat tab (read-only log of every Sunny to owner message). Screenshot placeholder.
29. Rules editor: live prompt edits with Save (git push) and Deploy (Railway redeploy) buttons. Screenshot placeholder.
30. Models & Config: model IDs, runtime config, env-var booleans, spending. Screenshot placeholder.
31. Human take-over: owner jumps into a conversation, Sunny pauses.
32. Auto-release: Sunny resumes after the owner has been idle for the configured threshold (default 15 minutes).

### Section 8, The proof (5 slides, all with WhatsApp screenshot placeholders)
33. Technical reply speed: customer asks a sizing question, Sunny answers in 6 seconds with the right product from warehouse.
34. Costing reply: customer asks "how much for a 16kWh battery", Sunny quotes from warehouse only on explicit ask.
35. Classification in action: customer says "send me the account", classifier promotes to HOT, owner gets paged.
36. Entertaining conversation: small talk, voice notes, multi-language (English, Pidgin).
37. Owner alert: the exact message the owner sees on his phone.

### Section 9, Why he is different (3 slides)
38. Chatbot vs Sunny: side-by-side comparison table.
39. The 7 pillars: rule discipline, stateful memory, multi-language, multimodal, classification, escalation, admin control.
40. Cost economics: monthly cost vs hiring a human account manager. Per-message cost on Opus, daily budget guardrail.

### Section 10, What is next (2 slides)
41. The white-label roadmap: same architecture, any vertical (solar, dental, real estate, retail, services).
42. Contact / CTA.

## Diagrams that must be SVG (not screenshots)

These are the native diagrams the deck needs. The frontend-design agent builds them as SVG so html-to-pptx can convert them to editable PPTX shapes.

1. The full architecture diagram (slide 10). Shows: WhatsApp Cloud API at the top, Railway container in the middle, GitHub on the left as code source, the SQLite DB and media volume inside Railway, the Anthropic API and OpenAI API as external calls, the owner WhatsApp on the right.
2. The 14 reply guards stack (slide 15). Vertical stack of 14 named layers with arrows, showing the order they run.
3. The classification flow (slide 20). Decision tree from inbound message to category to escalation type.
4. The escalation alert anatomy (slide 23). Annotated mockup of the alert message showing each component.
5. The admin platform map (slide 24). Boxes for each tab with one-line capability per tab.
6. The chatbot-vs-Sunny comparison table (slide 38). Two columns, side by side.
7. The white-label deployment diagram (slide 41). Sunny-template at the top, three example client deployments below.

## Out of scope

- Animations. Slides are static. No Reveal.js, no transitions. The PPT export is what matters; animations would not survive the bridge.
- Per-slide notes (speaker notes). Not in scope for v1.
- Multi-language deck. Deck is English-only.
- Live demo embed. Static deck, no iframes.

## Acceptance criteria

- `presentation/sunny-case-study/index.html` opens in Chrome, scrolls cleanly through 40+ slides, each slide is 1920x1080.
- `presentation/sunny-case-study.pptx` opens in PowerPoint and in Keynote.
- All headlines, body text, table cells in the PPT are editable text (not flattened images).
- Screenshot placeholders are picture-frame shapes that PowerPoint shows as "Change Picture" on right-click.
- No double-dashes anywhere in any slide copy (project rule).
- Mocked stand-in screenshots are clearly tagged `[MOCK]`.
