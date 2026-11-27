/**
 * Multiplayer damage authority.
 *
 * Every hit in the game goes through `Hostile.damage()`. In a shared fight
 * the enemies are the host's; a hit lands for real only:
 *  - on the host, from the host's own weapons, or forwarded from the guest
 *    (who scored it against their puppet of the same enemy);
 *  - never from a wingman's cosmetic weapon copy, which runs in
 *    {@link cosmetic} scope.
 */
let cosmeticDepth = 0;

/** Run `fn` with every hostile hit inside it reduced to show (no damage, no kill). */
export function cosmetic<T>(fn: () => T): T {
  cosmeticDepth++;
  try {
    return fn();
  } finally {
    cosmeticDepth--;
  }
}

export function inCosmeticScope(): boolean {
  return cosmeticDepth > 0;
}
