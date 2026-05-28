# Additional Permissions / Restrictions

## Pursuant to Section 7 of the GNU Affero General Public License v3.0

Harmony is licensed under the [GNU AGPL v3](./LICENSE). The following
**additional terms** are hereby applied to your use of this software, as
expressly permitted by Section 7 of the AGPL.

---

### 1. Attribution requirement (AGPL §7(b))

You must retain, in any copy or modified version of the program, the
following Appropriate Legal Notices:

1. The copyright notice in [`COPYRIGHT`](./COPYRIGHT).
2. The visible "Powered by Harmony" attribution link, currently rendered on
   the authentication screen (see `src/components/AuthComponent.vue`),
   linking to <https://github.com/y4my4my4m/harmony> (or, if you fork the
   project, an equivalent link to the original Harmony repository).

You **may** add your own branding alongside the Harmony attribution
(e.g. "Powered by Harmony, hosted by Acme Corp"). You **may not** remove,
hide, alter, or visually obscure the original attribution. The link must
point to the canonical Harmony project, not to your fork.

If you reposition the attribution (for example into an `/about` page or
a footer), it must remain reachable from the program's main user
interface within at most one click.

### 2. Trademark notice (AGPL §7(e))

The name "Harmony" and the project's polar-bear logo (🐻‍❄️ and the icon
files under `public/icon_3d.webp`, `public/favicon/`, and
`src-tauri/icons/`) are **trademarks** (common-law) of y4my4my4m. The
AGPL does not grant you a license to use these marks. See
[TRADEMARK.md](./TRADEMARK.md) for the project's name and logo policy.

If you operate a fork or modified version, you must give it a
distinguishable name and visual identity. You **may** describe your
software as "based on Harmony" or "a Harmony fork".

### 3. No additional restrictions

Other than the items in §1 and §2 above, no further restrictions are
imposed beyond those set forth in the AGPL. If a recipient finds that
any of these additional terms cannot be enforced under applicable law,
that term shall be severed and the remainder shall remain in effect.

---

## How to comply (TL;DR)

If you are running Harmony as an unmodified instance, you are already
compliant - the attribution link is in the default UI and you have not
touched the trademarks.

If you are forking:

1. Rename your fork. Don't call it "Harmony" or use the polar-bear logo.
2. Keep the "Powered by Harmony" link pointing to the original repo
   (you may add your own credit alongside it).
3. Keep `COPYRIGHT`, `LICENSE`, and this file in your repository.
4. State your changes (AGPL §5(b)) - typically a `CHANGELOG.md` entry or
   commit history is sufficient.
5. Make your modified source code available to your users (AGPL §13).

If you are contributing back to upstream Harmony:

You don't need to do anything special. By submitting a pull request you
agree to license your contribution under the same terms as the project.
