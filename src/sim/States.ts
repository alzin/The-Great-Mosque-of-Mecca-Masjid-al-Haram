/**
 * States.ts — the two state machines that drive the simulation.
 *
 * AgentState is per-person. GlobalPhase is the precinct-wide orchestration
 * used to move the whole crowd into and out of congregational prayer.
 *
 * These are plain const objects rather than TypeScript `enum`s so that the
 * source stays fully type-erasable: that keeps `isolatedModules` happy for
 * Vite/esbuild and lets the Node test tooling run the .ts files directly.
 */

export const AgentState = {
  /** Walking in from a gate, heading for the courtyard. */
  ENTERING: 0,
  /** In the courtyard, working outward/inward to merge into the flow. */
  JOINING_TAWAF: 1,
  /** Circumambulating. */
  PERFORMING_TAWAF: 2,
  /** Finished the required circuits, peeling out of the ring. */
  LEAVING_TAWAF: 3,
  /** Heading for a gate to depart the simulated area. */
  EXITING: 4,
  /** Walking to an assigned prayer slot. */
  MOVING_TO_PRAYER: 5,
  /** Settled in a row, running the prayer animation timeline. */
  PRAYING: 6,
  /** Standing up and dispersing after the prayer. */
  RESUMING_ACTIVITY: 7,
  /** Standing still in the courtyard (e.g. after tawaf, before leaving). */
  IDLE: 8,
} as const;

export type AgentState = (typeof AgentState)[keyof typeof AgentState];

export const AGENT_STATE_NAMES: readonly string[] = [
  'ENTERING',
  'JOINING_TAWAF',
  'PERFORMING_TAWAF',
  'LEAVING_TAWAF',
  'EXITING',
  'MOVING_TO_PRAYER',
  'PRAYING',
  'RESUMING_ACTIVITY',
  'IDLE',
];

export const AGENT_STATE_COUNT = AGENT_STATE_NAMES.length;

export const GlobalPhase = {
  NORMAL_ACTIVITY: 0,
  /** Adhan has been called; behaviour begins to shift, tawaf continues. */
  PREPARATION: 1,
  /** Iqamah: tawaf halts, everyone walks to a slot and settles. */
  ROW_FORMATION: 2,
  /** The prayer itself. */
  PRAYER: 3,
  /** Taslim done; standing up and dispersing. */
  POST_PRAYER: 4,
} as const;

export type GlobalPhase = (typeof GlobalPhase)[keyof typeof GlobalPhase];

export const GLOBAL_PHASE_NAMES: readonly string[] = [
  'NORMAL_ACTIVITY',
  'PREPARATION',
  'ROW_FORMATION',
  'PRAYER',
  'POST_PRAYER',
];

/**
 * Animation clip identifiers. These index into the baked vertex-animation
 * texture; see characters/AnimationBank.ts for the definitions.
 */
export const Clip = {
  IDLE: 0,
  WALK: 1,
  SHUFFLE: 2,
  TURN: 3,
  /* Prayer sequence */
  TAKBIR: 4,
  QIYAM: 5,
  TO_RUKU: 6,
  RUKU: 7,
  FROM_RUKU: 8,
  ITIDAL: 9,
  TO_SUJUD: 10,
  SUJUD: 11,
  SUJUD_TO_JALSA: 12,
  JALSA: 13,
  JALSA_TO_SUJUD: 14,
  SUJUD_TO_STAND: 15,
  TASHAHHUD: 16,
  TASLIM: 17,
  SIT_TO_STAND: 18,
} as const;

export type Clip = (typeof Clip)[keyof typeof Clip];

export const CLIP_COUNT = 19;

export const CLIP_NAMES: readonly string[] = [
  'idle', 'walk', 'shuffle', 'turn',
  'takbir', 'qiyam', 'to_ruku', 'ruku', 'from_ruku', 'itidal',
  'to_sujud', 'sujud', 'sujud_to_jalsa', 'jalsa', 'jalsa_to_sujud',
  'sujud_to_stand', 'tashahhud', 'taslim', 'sit_to_stand',
];
