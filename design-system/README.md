Spotflow Games is the internal multiplayer games platform for Spotflow's remote team: Quiz Arena, Draw & Guess, and Two Truths and a Lie, played live during socials and company events. The interface should feel like game night with colleagues: bright, quick to read across a video call, fair to everyone, and never confusing about what just happened.

> **Status: first draft.** The palette is a proposed starting point. Spotflow's logo and brand colours have not been applied yet; `primary` (Spotflow indigo) is the token to swap when they are. Token names will stay the same, so code built on them keeps working.

## Content fundamentals

- Write like a friendly host. Short, plain sentences in the second person: "You placed 4th." "Waiting for the host to start."
- Lead with the result, then the detail: "**Correct!** +820 points, 2.1 seconds."
- Buttons are verbs that name what happens: "Start game", "Share to Slack", "End session", "Play again". Never "OK" or "Submit".
- Errors say what happened and what to do next, with no apology: "That session has ended. Ask the host for a new code."
- Use people's display names, never emails. Add "(you)" after the current player's name in lists.
- Sentence case everywhere except `label` eyebrows and badges, which are uppercase via CSS.
- No emoji in UI copy. Icons carry meaning instead.
- Game names are fixed: **Quiz Arena**, **Draw & Guess**, **Two Truths and a Lie** (short form "Two Truths" only where space is tight).

## Visual foundations

### Colour

- Page background is `surface`; cards, tiles and rows sit on `surface-raised`; inputs and wells on `surface-sunken`.
- Body text is `ink`; secondary text is `ink-muted`. Both pass 4.5:1 on all three surfaces in both themes.
- `primary` is the one brand colour: primary buttons, links, selection, the current player's row (`primary-soft`). Text on a primary fill is `on-primary`, never literal white, because the dark theme lightens the indigo and needs dark text.
- Each game owns one identity colour, used for its mark, host button, timer ring and badges: `game-quiz` (amber), `game-draw` (green), `game-truths` (coral). Each has `-soft` for tints, `-ink` for coloured text, and `on-` for text on the fill. Never flood a whole screen with an identity fill.
- Status colours are `success` (blue-teal), `danger` (red) and `warning` (amber-brown). `success` is deliberately blue-teal so correct versus wrong never depends on telling green from red.
- Medal tokens (`medal-gold`, `medal-silver`, `medal-bronze`) always carry the rank number on `on-medal`.
- Avatar options (`avatar-bg-*`, `skin-*`, `hair-*`) and the drawing palette (`canvas-paper`, `brush-*`) are identical in both themes, so a player's avatar and a drawing look the same to everyone.

### Never colour or sound alone

This is the system's core rule, from the PRD's accessibility requirements.

- Quiz answers pair colour with a shape and a number: 1 triangle, 2 diamond, 3 circle, 4 square.
- Correct and wrong pair colour with a check or X icon and a word ("Correct", "Your answer").
- Rank 1–3 shows the number inside the medal.
- The last five seconds of a timer turn `warning` and add "4s left" with a clock icon.
- Connection state is a word ("Reconnecting…") plus an icon dot.
- Every sound effect (countdown, correct, game over, winner) has a visual twin. Sound is off until the player turns it on or interacts, and the switch always states its current state.

### Themes

- Two themes, `light` and `dark`. The app follows the operating system by default and lets players override it from the ThemeAndSound control; the choice is saved to their profile.
- Implement it with `data-theme` on `<html>`: no attribute means "System". When building, emit the dark values a second time inside `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { … } }` so System works.
- Dark is not an inverted light theme: accents lighten, `on-` tokens flip to dark ink, and shadows deepen.

### Type

- `display` (Gabarito) for headings, round interstitials and winner moments. Rounded, chunky and readable on a shared screen. Use `display-xl` once per screen at most.
- `body` (Atkinson Hyperlegible) for all UI and running text. It was designed for low-vision readers and keeps similar letters distinct, which matters when a quiz answer has to be read in two seconds.
- `mono` (JetBrains Mono) for join codes, timers and points. Always with `font-variant-numeric: tabular-nums` so scores don't jitter as they count up.
- All three are Google Fonts; load them from fonts.googleapis.com with the fallbacks in `type.families`.

### Spacing and layout

- A 4px base: `space-1` (4) to `space-16` (64). Card padding is `space-6` on desktop and `space-4` on phones; page gutters are `space-10` and `space-4`.
- Breakpoints: phone under 600px, tablet 600–1023px, desktop 1024px and up. Answers go from two columns to one under 480px; Draw & Guess moves the guess feed under the canvas below 1024px; the lobby roster auto-fills 180px columns.
- Every tappable control is at least `size-target` (44px).

### Shape, depth and motion

- Corners come from the radius scale: `radius-md` for controls, `radius-lg` for cards and answers, `radius-xl` for game tiles and dialogs, `radius-full` for avatars and pills.
- Depth is light: `shadow-sm` on resting cards, `shadow-md` for popovers. Game buttons and answer tiles use `shadow-pop`, a solid 4px base that disappears on press, so they feel like physical buzzers.
- Motion uses `duration-fast` for hover and press, `duration-base` for reveals, `duration-slow` for score count-ups and the podium rising. With `prefers-reduced-motion`, cut transitions and show the end state.

### Focus and states

- Keyboard focus is a 2px solid `focus-ring` outline with a 2px offset on every interactive element. It passes 3:1 on all surfaces in both themes.
- Hover darkens fills (`primary-hover`) or tints outlines. Disabled controls move to `surface-sunken` with `ink-muted` text and explain why in the label.
- Quiz answers take number keys 1–4; Two Truths statements take 1–3.

## Iconography

- Spotflow has no game icon set yet, so the previews use simple 24px line icons with a 2.2 stroke, round caps and `currentColor`. For the build, use [Lucide](https://lucide.dev) (MIT), which matches this style: `check`, `x`, `clock`, `copy`, `pencil`, `eraser`, `trash-2`, `volume-2`, `volume-x`, `sun`, `moon`, `monitor`, `users`, `share`, `trophy`, `zap`, `triangle-alert`, `refresh-cw`, `play`, `skip-forward`, `lock`, `calendar`, `star`.
- Game marks: Quiz Arena `circle-help`, Draw & Guess `pencil`, Two Truths `message-square-text`.
- Icon-only buttons need an `aria-label`. Decorative icons get `aria-hidden="true"`.

## Logo

Spotflow's logo isn't in this system yet. Until it is, the app bar sets "Spotflow **Games**" in `display` at 20px, with "Games" in `primary`.

## Components

All styles live in `components/bundle.css` with the `sg-` prefix and read only tokens. Previews are static HTML so they translate directly to any framework.

- **Actions:** Button
- **Identity:** Avatar, Badge, Achievement
- **Games:** GameTile
- **Sessions:** JoinCode, PlayerRoster
- **Gameplay:** Timer, AnswerOption, FeedbackBanner, StatementCard, DrawToolbar, GuessFeed
- **Rankings:** Leaderboard
- **Settings:** ThemeAndSound
- **Game screens:** Lobby, Quiz question (desktop and phone), Draw & Guess (guesser and drawer), Two Truths voting, Results

Names, scores and quiz questions in the previews are sample content.
