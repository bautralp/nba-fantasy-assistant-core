export type PlayerId = string;

export interface Player {
  /** Stable application ID, assigned independently of name, row order or statistics. */
  readonly id: PlayerId;
  readonly name: string;
  readonly providerIds?: Readonly<Record<string, string>>;
}
