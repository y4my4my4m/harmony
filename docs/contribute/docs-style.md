---
title: Docs style
description: How the Harmony documentation is organised, written and built, and how to add a page.
---

# Docs style

This page is for anyone editing this site. The pages are hand-written Markdown under [`docs/`](https://github.com/y4my4my4m/harmony/tree/master/docs) in the main repository, built with [VitePress](https://vitepress.dev/).

## Where a page goes

The site is split by audience. Put a page in the section of the person who will read it, not the part of the code it describes.

| Section | Directory | Reader |
| --- | --- | --- |
| Use Harmony | `docs/use/` | Someone chatting on an instance |
| Run a server | `docs/run/` | A server owner or moderator |
| Self-host | `docs/self-host/` | An instance operator |
| Build | `docs/build/` | A developer writing a bot, integration or bridge |
| Federation | `docs/federation/` | Admins, and implementers of other ActivityPub software |
| Contribute | `docs/contribute/` | Someone changing Harmony's code |

Inside a section, each page is mainly one kind of document:

- **Tutorial**: a guided first run that ends in something working ([Bot quickstart](/build/bot-quickstart)).
- **How-to**: steps for one task, titled by the task ("Create a role", "Restore a backup").
- **Reference**: complete, flat facts in tables (permissions, CLI commands, routes, environment variables).
- **Explanation**: how and why something works ([Architecture](/contribute/architecture)).

When a page starts to mix kinds, split it or move the reference part into a table at the end.

## Writing

- Plain, concrete, present tense. Use "you" in how-tos.
- Open each page with one or two sentences on what it covers and who it is for.
- Short paragraphs. Tables for anything a reader looks up.
- No marketing words: "seamless", "robust", "powerful", "leverage", "simply", "just", "easily".
- No emoji, including in headings.
- Describe what is true now. Release history belongs in [CHANGELOG.md](https://github.com/y4my4my4m/harmony/blob/master/CHANGELOG.md), not in prose ("now supports", "since 1.6", "we added").
- Containers (`::: tip`, `::: warning`, `::: details`) only for real caveats.

### UI labels

Use the exact English strings from [`src/locales/en.json`](https://github.com/y4my4my4m/harmony/blob/master/src/locales/en.json), in bold, with menu paths joined by an arrow: **User Settings** → **Notifications**. If a label is renamed in `en.json`, search the docs for the old string.

### Facts

Every statement about behaviour, a setting, a limit or an endpoint is checked against the code before it goes in. Old pages and issue threads are leads, not sources. When something cannot be confirmed, leave it out.

## Markdown mechanics

VitePress compiles each page as a Vue template, which has consequences:

- A bare `<word>` in prose is parsed as an HTML tag and breaks the build. Wrap placeholders in backticks (`` `<channel id>` ``) or write `&lt;channel id&gt;`.
- Double curly braces outside a fenced code block are evaluated as a Vue expression. Put template syntax in a fenced block.
- Close every code fence with three backticks on its own line, and give it a language (`bash`, `json`, `ts`, `yaml`, `text`).

Each page starts with frontmatter and a single H1:

```md
---
title: Roles and permissions
description: One plain sentence for search engines and link previews.
---

# Roles and permissions
```

Link to other pages with absolute paths and no extension: `[Install](/self-host/install#dns)`. The build fails on a link to a page that does not exist. It does not check `#anchors`, so check those by hand when you rename a heading.

Diagrams go in code fences with the language `mermaid`; they follow the light and dark theme.

## Add a page

1. Create the Markdown file in the section's directory.
2. Add it to that section's `sidebar` entry in [`docs/.vitepress/config.ts`](https://github.com/y4my4my4m/harmony/blob/master/docs/.vitepress/config.ts). The sidebar is maintained by hand.
3. Link to it from the section's overview page.
4. Build the site (below) to catch dead links.

Moving or renaming a page breaks links from elsewhere. Keep the old path as a stub page with `redirect:` in its frontmatter, as `docs/self-hosting.md` does; the theme sends visitors on, mapping old `#anchors` through `redirectAnchors:`.

## Build and preview

```bash
npm run docs:dev      # live preview at http://localhost:5190
npm run docs:build    # static site in docs/.vitepress/dist
npm run docs:preview  # serve the built site
```

The `docs` job in CI runs `npm run docs:build`, so a dead link or a template error fails the pull request.

Code-level reference (services, stores, components) is not generated into this site. Link to the source on GitHub instead: `https://github.com/y4my4my4m/harmony/blob/master/<path>`.
