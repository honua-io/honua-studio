declare const epochTokenBrand: unique symbol;

/** A snapshot of one {@link StalenessEpoch}; only meaningful when compared against that same epoch. */
export type EpochToken = number & { readonly [epochTokenBrand]: true };

/**
 * Detects superseded async work: capture `current` before awaiting, call `next()` when newer work or a new
 * authority replaces it, and check the captured token with `isCurrent` or `assertCurrent` afterwards.
 */
export class StalenessEpoch {
  #value = 0;

  get current(): EpochToken {
    return this.#value as EpochToken;
  }

  next(): EpochToken {
    this.#value += 1;
    return this.current;
  }

  isCurrent(token: EpochToken | undefined): boolean {
    return token === this.#value;
  }

  assertCurrent(token: EpochToken | undefined, message: string): void {
    if (!this.isCurrent(token)) throw new Error(message);
  }
}
