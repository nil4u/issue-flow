# L2 Design System Implementation

The management console uses shadcn/ui with the `amethyst-haze` theme installed through the shadcn CLI.

**一切设计必须来自设计系统的颜色和组件**。

Component rules:

- Header, overview band, repository rows, detail cards, dialogs, inputs, badges, and status panels must use shadcn components first.
- Reusable visual effects live in `apps/web/src/index.css` as `neumo-*` classes.
- The micro-neumorphic layer uses CSS variables, `color-mix()`, large radii, three-part shadows, and `0.2s ease` interactions.
- Inputs use an inset treatment; buttons and cards use raised treatment.
- Avoid `backdrop-blur` and glow-style `0 0 Npx` shadows.

Prompt trial notes:

- Useful: CSS variable + `color-mix()` rules work well with shadcn tokens and make theme tuning centralized.
- Useful: three-layer shadows give buttons, cards, and rows a clearer interaction model without introducing images.
- Adapted: generated shadcn theme variables contain static OKLCH token values because they are the design-system source tokens; custom issue-flow styles consume those variables instead of hardcoding feature colors.
- Adapted: the prompt's `black` and `rgba()` shadow formula is retained only in the prescribed shadow/gradient formulas.
- Recommendation: keep the treatment for the internal console, but apply it selectively to controls and panels rather than every surface.
