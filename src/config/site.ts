/**
 * site.ts — Dimensional reconstruction constants for the central area of
 * Masjid al-Haram.
 *
 * PERIOD OF REFERENCE: post-2016 ground-level mataf configuration (the
 * temporary mataf bridge was removed in 1437 AH / 2016 CE, leaving an open
 * ground-level circumambulation courtyard). All figures below are an
 * APPROXIMATE RECONSTRUCTION assembled from published dimensions, not a
 * measured architectural survey. See ASSETS.md and README.md for the source
 * list and the list of documented simplifications.
 *
 * COORDINATE FRAME
 *   - Three.js right-handed, +Y up, metres.
 *   - Kaaba centre at the world origin (0, 0, 0) at courtyard floor level.
 *   - +X = geographic East, -Z = geographic North (so the usual "north up"
 *     map convention holds when looking down the -Y axis).
 *   - The Kaaba's corners point approximately to the cardinal directions,
 *     so its walls run NE / SE / SW / NW.
 *
 * TAWAF DIRECTION
 *   Counter-clockwise as seen from above. In this frame that means the
 *   tangent at a point p (in the XZ plane) is normalize(p.z, -p.x): a
 *   pilgrim at the Black Stone (East corner, +X) moves toward North (-Z),
 *   i.e. toward the Iraqi corner, keeping the Kaaba on their left.
 */

/** Kaaba structure. Widely cited: 13.1 m high, sides 12.86 m x 11.03 m. */
export const KAABA = {
  /** NE (door) and SW wall length, metres. */
  lengthNE: 12.86,
  /** NW (Hijr side) and SE wall length, metres. */
  lengthNW: 11.03,
  height: 13.1,
  /** Shadharwan: sloped marble base, ~25 cm high projecting ~35 cm. */
  baseHeight: 0.25,
  baseProjection: 0.35,
  /** Rotation of the cube about +Y so its corners face the cardinals. */
  yaw: Math.PI / 4,
  /** Door sill height above the courtyard, ~2.13 m. */
  doorSill: 2.13,
  doorWidth: 1.7,
  doorHeight: 3.1,
  /** Hizam: the embroidered gold belt, roughly two thirds up the wall. */
  hizamCentreHeight: 8.9,
  hizamHeight: 0.95,
} as const;

/**
 * Corner bearings measured as angles in the XZ plane, radians, using
 * atan2(z, x) convention. East = 0, North = -pi/2, West = pi, South = +pi/2.
 */
export const CORNERS = {
  /** Hajar al-Aswad — the Black Stone, East corner. Tawaf start line. */
  blackStone: 0,
  /** Rukn al-Iraqi — North corner. */
  iraqi: -Math.PI / 2,
  /** Rukn al-Shami — West corner. */
  shami: Math.PI,
  /** Rukn al-Yamani — South corner. */
  yamani: Math.PI / 2,
} as const;

/**
 * Hijr Ismail / al-Hateem: low semicircular white marble wall off the NW
 * face of the Kaaba. Published figures vary; we use wall height 1.32 m,
 * thickness 0.90 m, and an arc that stands off the NW wall far enough to
 * enclose roughly the classical ~8.4 m span with ~2.2 m gaps at each end.
 */
export const HIJR = {
  /** Arc radius (centreline of the wall) measured from the Hijr's centre. */
  radius: 8.6,
  wallHeight: 1.32,
  wallThickness: 0.9,
  /**
   * The Hijr arc is centred on the midpoint of the Kaaba's NW wall, pushed
   * slightly outward so the enclosure reads as a separate structure.
   */
  centreOffset: 0.0,
  /** Half-angle of the arc measured from the NW normal. */
  halfAngle: 1.15,
} as const;

/**
 * Maqam Ibrahim: glass-and-gilt enclosure in front of the Kaaba's door
 * (NE face). Sources place it roughly 11-13 m from the Kaaba.
 */
export const MAQAM = {
  /** Distance from the Kaaba centre, metres, along the NE normal. */
  distanceFromCentre: 18.0,
  /** Lateral offset along the NE wall from the door axis. */
  lateralOffset: 0.0,
  baseRadius: 1.35,
  baseHeight: 0.35,
  domeRadius: 0.95,
  totalHeight: 3.4,
} as const;

/** Zamzam access kiosk (underground stair head, east of the Kaaba). */
export const ZAMZAM = {
  distanceFromCentre: 24.0,
  bearing: 0.45,
  radius: 2.6,
  height: 1.1,
} as const;

/**
 * The mataf: the open marble circumambulation courtyard. Post-2016 the
 * ground-level open area is substantially wider than the 95 m diameter
 * circle that preceded the expansion; published observation of the area
 * gives roughly 105 x 154 m. We model a circular open courtyard of radius
 * 62 m, ringed by the gallery arcades.
 */
export const MATAF = {
  /** Innermost walkable radius from the Kaaba centre. */
  innerRadius: 8.5,
  /** Outer edge of the open marble courtyard. */
  outerRadius: 62.0,
  /** Radius at which the first gallery colonnade begins. */
  colonnadeRadius: 64.0,
  /** The "line of Hajar al-Aswad": the marked tawaf start/finish stripe. */
  startLineBearing: CORNERS.blackStone,
} as const;

/** Surrounding multi-level gallery structure. */
export const GALLERY = {
  /** Radii of the concentric column rings. */
  columnRings: [66.5, 74.5, 82.5, 90.5],
  columnsPerRing: [44, 50, 56, 62],
  columnRadius: 0.62,
  /** Ground-floor arcade height (springing line of the arches). */
  arcadeHeight: 8.4,
  archRise: 3.0,
  /** Upper floor levels. */
  floorLevels: [0, 12.4, 24.0],
  parapetHeight: 1.1,
  outerWallRadius: 96.0,
  outerWallHeight: 38.0,
} as const;

/**
 * Minarets. Masjid al-Haram has 13; the Saudi-era minarets around the
 * central precinct are commonly given as ~89 m, the King Abdullah
 * expansion minarets as ~139 m. We place a representative ring of six
 * visible from the supported cameras.
 */
export const MINARETS: ReadonlyArray<{
  bearing: number;
  radius: number;
  height: number;
}> = [
  { bearing: -Math.PI / 4, radius: 104, height: 89 },
  { bearing: Math.PI / 4, radius: 104, height: 89 },
  { bearing: (3 * Math.PI) / 4, radius: 104, height: 89 },
  { bearing: (-3 * Math.PI) / 4, radius: 104, height: 89 },
  { bearing: -Math.PI / 2 - 0.28, radius: 112, height: 139 },
  { bearing: -Math.PI / 2 + 0.28, radius: 112, height: 139 },
];

/**
 * Gates: the openings in the gallery ring through which agents enter and
 * leave the mataf. Observation of the mataf reports ~10 entrances/exits;
 * we model eight evenly distributed openings plus two wider ones on the
 * Safa/Marwa (SE) side.
 */
export interface GateSpec {
  readonly id: number;
  readonly name: string;
  readonly bearing: number;
  /** Half-width of the opening, in radians at the colonnade radius. */
  readonly halfWidth: number;
  readonly entry: boolean;
  readonly exit: boolean;
}

export const GATES: ReadonlyArray<GateSpec> = [
  { id: 0, name: 'Bab as-Salam side', bearing: -0.35, halfWidth: 0.075, entry: true, exit: true },
  { id: 1, name: 'Bab an-Nabi side', bearing: 0.42, halfWidth: 0.09, entry: true, exit: true },
  { id: 2, name: 'Mas\u2018a link (Safa)', bearing: 0.95, halfWidth: 0.1, entry: true, exit: true },
  { id: 3, name: 'Bab Ali side', bearing: 1.62, halfWidth: 0.075, entry: true, exit: true },
  { id: 4, name: 'South-west arcade', bearing: 2.35, halfWidth: 0.07, entry: true, exit: true },
  { id: 5, name: 'Bab Ibrahim side', bearing: 3.02, halfWidth: 0.08, entry: true, exit: true },
  { id: 6, name: 'Bab al-\u2018Umrah side', bearing: -2.42, halfWidth: 0.075, entry: true, exit: true },
  { id: 7, name: 'North-west arcade', bearing: -1.85, halfWidth: 0.07, entry: true, exit: true },
  { id: 8, name: 'King Fahd expansion', bearing: -1.32, halfWidth: 0.095, entry: true, exit: true },
  { id: 9, name: 'North arcade', bearing: -0.85, halfWidth: 0.07, entry: true, exit: true },
];

/** Where agents are spawned/despawned, just outside the colonnade. */
export const SPAWN_RADIUS = GALLERY.columnRings[1];

/**
 * Empirically grounded pedestrian parameters.
 *
 * Free-flow preferred speeds follow the distribution used in published
 * tawaf simulation work (young male mean ~1.0 m/s, sigma ~0.2 m/s, with
 * slower cohorts). Observed mean speed close to the Kaaba wall during Hajj
 * is far lower (~0.33 m/s) because of density; that emerges here from the
 * density-speed coupling rather than being imposed.
 */
export const PEDESTRIAN = {
  /** [meanSpeed, sigma, share] cohorts. */
  cohorts: [
    { mean: 1.02, sigma: 0.2, share: 0.3 },
    { mean: 0.92, sigma: 0.18, share: 0.3 },
    { mean: 0.8, sigma: 0.16, share: 0.22 },
    { mean: 0.68, sigma: 0.15, share: 0.18 },
  ],
  minSpeed: 0.22,
  maxSpeed: 1.65,
  /** Personal radius used for collision response. */
  radius: 0.24,
  /** Comfortable interpersonal distance before repulsion kicks in. */
  comfortRadius: 0.62,
  /** Maximum turn rate, radians/second. */
  maxTurnRate: 3.2,
  /** Maximum linear acceleration, m/s^2. */
  maxAccel: 1.9,
  /** Stride length of the baked walk cycle at 1.0 playback rate, metres. */
  strideLength: 1.42,
  heightRange: [1.53, 1.86] as const,
} as const;

/** Prayer row layout parameters. */
export const PRAYER_LAYOUT = {
  /** Radius of the first (innermost) row, from the Kaaba centre. */
  firstRowRadius: 9.6,
  /** Radial distance between successive rows: room for sujud. */
  rowSpacing: 1.28,
  /** Along-row shoulder-to-shoulder spacing. */
  lateralSpacing: 0.62,
  /** Rows stop before the colonnade. */
  lastRowRadius: 60.0,
  /** Radial service aisles kept clear, given as bearings. */
  aisleBearings: [0.42, 2.35] as const,
  aisleHalfWidth: 1.6,
  /** Clearance kept around obstacles when generating slots. */
  obstacleClearance: 0.55,
} as const;
