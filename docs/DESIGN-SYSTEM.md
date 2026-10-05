# IXG Wall design system

Source: [praveen-anne/ixg-design-system](https://github.com/praveen-anne/ixg-design-system), revision `73be8c15acb24b85acf8e416e8a7227d34ea69c6`.

The wall uses native HTML and JavaScript. IXG's Svelte component styles are adapted to the existing controls so playback, sessions and settings retain their current behavior and no runtime dependencies are added.

- `public/ixg-tokens.css`: upstream token layer with `@theme` changed to native `:root`. Semantic light/dark roles, fonts, data series and base rules are preserved.
- `public/style.css`: existing layout rules, compatibility aliases to IXG semantic roles, and native Button/Input/Tabs/StateBadge adaptations.
- `public/fonts/manrope.woff2` and `space-grotesk.woff2`: upstream variable fonts.
- `public/ixg-logo.svg`: official white knockout.
- The favicon (inline in `index.html` and `login.html`) is the same mark in black on a light tab strip and white on a dark one, set by `prefers-color-scheme` inside the SVG. The brand purple didn't read on Chrome's dark tab strip.

Both wall and sign-in use `data-theme="dark"`. Numerals are Space Grotesk with `tnum`; labels and UI use Manrope. Charts use categorical/sequential tokens, while operational states use the reserved state colors and a text label. New assets are available before sign-in.

To update, compare the upstream token file and component rules with this revision, reapply the native CSS adapter, then run `npm test` and inspect the wall and sign-in in a browser. Use a separate `IXG_DATA_DIR` for any preview so operator sessions are unaffected.
