// Back-compat shim for SettingsPage panel tests.
//
// The shared provider harness has been generalized to `testProviders.tsx`
// (`TestProviders` / `renderWithProviders`) because the same latent fragility
// exists across non-Settings tests too. The Settings-named exports below are
// kept as thin aliases so existing Settings tests keep working; prefer the
// general names in `@/test/testProviders` for new tests.

import {
  TestProviders,
  renderWithProviders,
} from "@/test/testProviders";

export const SettingsTestProviders = TestProviders;
export const renderWithSettingsProviders = renderWithProviders;
