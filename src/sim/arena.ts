import { ARENA } from './rl';
import { TUNING } from './tuning';

/** Axis-aligned box (optionally rotated about Y): half extents and centre. */
export interface Box {
  hx: number;
  hy: number;
  hz: number;
  x: number;
  y: number;
  z: number;
  yaw?: number;
}

export interface ArenaGeometry {
  /** Triangle mesh for the wall shell: ramps, side walls, corners, back walls with goal mouths. Normals point into the arena. */
  vertices: Float32Array;
  indices: Uint32Array;
  floorBox: Box;
  ceilingBox: Box;
  /** The two goal boxes (back wall, two post walls, roof each). */
  goalBoxes: Box[];
  /** Solid slabs behind every flat wall section so nothing can tunnel out through the thin shell. */
  backstopBoxes: Box[];
}

export function allColliderBoxes(a: ArenaGeometry): Box[] {
  return [a.floorBox, a.ceilingBox, ...a.goalBoxes, ...a.backstopBoxes];
}

type P2 = [number, number]; // [x, z]

/**
 * Builds the standard soccar arena analytically. See TUNING.rampRadius* for what is approximated.
 * Y is up. The long axis is Z (RL's y). Blue's goal is at -Z, orange's at +Z.
 */
export function buildArenaGeometry(): ArenaGeometry {
  const W2 = ARENA.extentX;
  const L2 = ARENA.extentY;
  const H = ARENA.height;
  const c = ARENA.cornerCut;
  const gw = ARENA.goalHalfWidth;
  const gh = ARENA.goalHeight;
  const gd = ARENA.goalDepth;
  const rF = TUNING.rampRadiusFloor;
  const rC = TUNING.rampRadiusCeiling;
  const N = TUNING.rampSegments;
  const t = TUNING.wallThickness;

  // Octagonal outline, counter-clockwise when viewed from above (+Y).
  const outline: P2[] = [
    [W2 - c, -L2],
    [W2, -L2 + c],
    [W2, L2 - c],
    [W2 - c, L2],
    [-(W2 - c), L2],
    [-W2, L2 - c],
    [-W2, -L2 + c],
    [-(W2 - c), -L2],
  ];
  const E = outline.length;
  // Inward unit normal of each edge i (from outline[i] to outline[i+1]).
  const normals: P2[] = outline.map((a, i) => {
    const b = outline[(i + 1) % E];
    let nx = -(b[1] - a[1]);
    let nz = b[0] - a[0];
    const len = Math.hypot(nx, nz);
    nx /= len;
    nz /= len;
    if (nx * -a[0] + nz * -a[1] < 0) {
      nx = -nx;
      nz = -nz;
    }
    return [nx, nz];
  });

  /** Vertex i of the outline inset by distance d: intersection of the two offset edge lines. */
  const insetVertex = (i: number, d: number): P2 => {
    const ePrev = (i - 1 + E) % E;
    const [n1x, n1z] = normals[ePrev];
    const [n2x, n2z] = normals[i];
    const a1 = outline[ePrev];
    const a2 = outline[i];
    const c1 = n1x * a1[0] + n1z * a1[1] + d;
    const c2 = n2x * a2[0] + n2z * a2[1] + d;
    const det = n1x * n2z - n1z * n2x;
    return [(c1 * n2z - c2 * n1z) / det, (n1x * c2 - n2x * c1) / det];
  };

  /**
   * A ring is the wall outline at one height, as an ordered list of [x, z] points. The two
   * back-wall edges (index 3 at +Z, index 7 at -Z) are split at the goal posts x = ±gw so the
   * goal mouth is its own segment.
   */
  const ringPoints = (d: number): { pts: P2[]; mouth: boolean[] } => {
    const pts: P2[] = [];
    const mouth: boolean[] = []; // mouth[j] describes the segment from pts[j] to pts[j+1]
    for (let i = 0; i < E; i++) {
      pts.push(insetVertex(i, d));
      if (i === 3) {
        const z = L2 - d; // +Z back wall, x decreasing
        mouth.push(false);
        pts.push([gw, z]);
        mouth.push(true);
        pts.push([-gw, z]);
        mouth.push(false);
      } else if (i === 7) {
        const z = -(L2 - d); // -Z back wall, x increasing
        mouth.push(false);
        pts.push([-gw, z]);
        mouth.push(true);
        pts.push([gw, z]);
        mouth.push(false);
      } else {
        mouth.push(false);
      }
    }
    return { pts, mouth };
  };

  // Ring heights and insets: floor ramp, goal top, ceiling ramp.
  const rings: { y: number; d: number }[] = [];
  for (let k = 0; k <= N; k++) {
    const th = (k / N) * (Math.PI / 2);
    rings.push({ y: rF * (1 - Math.cos(th)), d: rF * (1 - Math.sin(th)) });
  }
  rings.push({ y: gh, d: 0 });
  for (let k = 0; k <= N; k++) {
    const ph = (k / N) * (Math.PI / 2);
    rings.push({ y: H - rC + rC * Math.sin(ph), d: rC * (1 - Math.cos(ph)) });
  }

  const verts: number[] = [];
  const idx: number[] = [];
  const addVert = (x: number, y: number, z: number): number => {
    verts.push(x, y, z);
    return verts.length / 3 - 1;
  };

  const ringIdx: number[][] = [];
  let mouthFlags: boolean[] = [];
  for (const r of rings) {
    const { pts, mouth } = ringPoints(r.d);
    mouthFlags = mouth;
    ringIdx.push(pts.map(([x, z]) => addVert(x, r.y, z)));
  }
  const S = ringIdx[0].length;

  // Wall bands between consecutive rings. Winding gives normals pointing INTO the arena.
  for (let k = 0; k < rings.length - 1; k++) {
    const below = ringIdx[k];
    const above = ringIdx[k + 1];
    const bandTop = rings[k + 1].y;
    for (let j = 0; j < S; j++) {
      if (mouthFlags[j] && bandTop <= gh + 1e-6) continue; // open goal mouth
      const j1 = (j + 1) % S;
      idx.push(below[j], above[j1], above[j]);
      idx.push(below[j], below[j1], above[j1]);
    }
  }

  // Goal post caps: close the open end of each floor ramp at the goal posts.
  for (const s of [-1, 1]) {
    for (const sx of [-1, 1]) {
      const corner = addVert(sx * gw, 0, s * L2);
      const profile: number[] = [];
      for (let k = 0; k <= N; k++) {
        profile.push(addVert(sx * gw, rings[k].y, s * (L2 - rings[k].d)));
      }
      // Face the goal mouth (toward the centre line x = 0).
      const inward = -sx;
      for (let k = 0; k < N; k++) {
        if (inward > 0) idx.push(corner, profile[k + 1], profile[k]);
        else idx.push(corner, profile[k], profile[k + 1]);
      }
    }
  }

  const floorBox: Box = { hx: W2 + t, hy: t / 2, hz: L2 + gd + t, x: 0, y: -t / 2, z: 0 };
  const ceilingBox: Box = { hx: W2 + t, hy: t / 2, hz: L2 + t, x: 0, y: H + t / 2, z: 0 };

  const goalBoxes: Box[] = [];
  for (const s of [-1, 1]) {
    const zc = s * (L2 + (gd + t) / 2);
    goalBoxes.push({ hx: gw + t, hy: gh / 2 + t, hz: t / 2, x: 0, y: gh / 2, z: s * (L2 + gd + t / 2) }); // back
    goalBoxes.push({ hx: t / 2, hy: gh / 2 + t, hz: (gd + t) / 2, x: -(gw + t / 2), y: gh / 2, z: zc }); // left post wall
    goalBoxes.push({ hx: t / 2, hy: gh / 2 + t, hz: (gd + t) / 2, x: gw + t / 2, y: gh / 2, z: zc }); // right post wall
    goalBoxes.push({ hx: gw + t, hy: t / 2, hz: (gd + t) / 2, x: 0, y: gh + t / 2, z: zc }); // roof
  }

  // Backstops sit flush behind each wall plane; the ramps are inset from those planes so they never touch.
  const backstopBoxes: Box[] = [];
  const hy = H / 2 + t;
  backstopBoxes.push({ hx: t / 2, hy, hz: L2 - c + t, x: -(W2 + t / 2), y: H / 2, z: 0 });
  backstopBoxes.push({ hx: t / 2, hy, hz: L2 - c + t, x: W2 + t / 2, y: H / 2, z: 0 });
  for (const s of [-1, 1]) {
    const z = s * (L2 + t / 2);
    const sideHx = (W2 - c + t - gw) / 2;
    backstopBoxes.push({ hx: sideHx, hy, hz: t / 2, x: -(gw + sideHx), y: H / 2, z });
    backstopBoxes.push({ hx: sideHx, hy, hz: t / 2, x: gw + sideHx, y: H / 2, z });
    // Flush with the crossbar at gh, extending past the ceiling.
    const aboveHy = (H - gh + t) / 2;
    backstopBoxes.push({ hx: gw, hy: aboveHy, hz: t / 2, x: 0, y: gh + aboveHy, z });
  }
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const nx = sx / Math.SQRT2;
      const nz = sz / Math.SQRT2;
      backstopBoxes.push({
        hx: c / Math.SQRT2 + t,
        hy,
        hz: t / 2,
        x: sx * (W2 - c / 2) + nx * (t / 2),
        y: H / 2,
        z: sz * (L2 - c / 2) + nz * (t / 2),
        yaw: Math.atan2(sx, sz),
      });
    }
  }

  return {
    vertices: new Float32Array(verts),
    indices: new Uint32Array(idx),
    floorBox,
    ceilingBox,
    goalBoxes,
    backstopBoxes,
  };
}
