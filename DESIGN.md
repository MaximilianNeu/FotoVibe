# FotoVibe design

Guests hold their phones at a party that may move from daylight into a dim room;
start with the device light/dark preference, while allowing an explicit saved
choice from the compact header theme button.

- Restrained warm neutrals with a forest-green action color, defined in OKLCH.
- Native system font, 16px minimum inputs, concise German copy.
- Upload content limited to 32rem; gallery expands into a responsive photo grid.
- At least 48px controls, visible keyboard focus, safe-area padding.
- Photography stays unframed; no decorative cards or stock images.
- Camera and local preview are focused full-screen states with safe-area-aware controls.
- The optional photo-task picker presents four large choices over the party image,
  with compact refresh, personal-task and close controls. In camera and preview the
  selected wording becomes a compact movable overlay that can be pushed away and restored.
- Offline personal tasks use the short `LOKAL` marker until background synchronization
  replaces it with the normal private-task state.
- Gallery tiles identify challenge photos with a short overlay; the photo detail
  view shows the complete saved task wording.
- Very brief state transitions, disabled under prefers-reduced-motion.
