// 视线判断：某个玩家是不是正看着猫娘（摸头互动用）。
// 查看猫娘的背包和状态改成“右键她”（需要面板模组）或 #背包 / #菜单，不再在准心对准时显示文字。

const PLAYER_EYE = 1.62;

function viewDirection(pitch, yaw) {
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
}

// 射线与轴对齐包围盒求交（slab 算法）。
function rayHitsBox(origin, dir, min, max, maxDist) {
  let tmin = 0;
  let tmax = maxDist;
  for (const axis of ['x', 'y', 'z']) {
    if (Math.abs(dir[axis]) < 1e-9) {
      if (origin[axis] < min[axis] || origin[axis] > max[axis]) return false;
      continue;
    }
    let t1 = (min[axis] - origin[axis]) / dir[axis];
    let t2 = (max[axis] - origin[axis]) / dir[axis];
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }
  return true;
}

export function isLookingAt(viewer, target, maxDist) {
  const eye = viewer.position.offset(0, viewer.eyeHeight ?? PLAYER_EYE, 0);
  const dir = viewDirection(viewer.pitch, viewer.headYaw ?? viewer.yaw);
  const p = target.position;
  const pad = 0.15;
  return rayHitsBox(eye, dir, { x: p.x - 0.3 - pad, y: p.y - pad, z: p.z - 0.3 - pad }, { x: p.x + 0.3 + pad, y: p.y + 1.8 + pad, z: p.z + 0.3 + pad }, maxDist);
}
