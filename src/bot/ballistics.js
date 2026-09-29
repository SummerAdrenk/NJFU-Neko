// 弹道：算出射中目标需要的视角。箭：先移动再减速再下坠；雪球、药水这类投掷物：先下坠减速再移动。
// 药水扔出去时比视线高 20°（pitchOffset），计算出发射角后再换算成要看的角度。

export const ARROW = { speed: 3.0, gravity: 0.05, drag: 0.99, dragFirst: false };
export const SNOWBALL = { speed: 1.5, gravity: 0.03, drag: 0.99, dragFirst: true };
export const SPLASH_POTION = { speed: 0.5, gravity: 0.05, drag: 0.99, dragFirst: true, pitchOffset: (20 * Math.PI) / 180 };

export function solveBallistic(from, to, { speed, gravity, drag, dragFirst, pitchOffset = 0 }, maxTicks = 240) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const dy = to.y - from.y;
  const horiz = Math.hypot(dx, dz);
  const yaw = Math.atan2(-dx, -dz);
  if (horiz < 0.05) return { yaw, pitch: dy >= 0 ? Math.PI / 2 - 0.01 : -Math.PI / 2 + 0.01, ticks: Math.abs(dy) / speed };
  const heightAt = (pitch) => {
    let vh = speed * Math.cos(pitch);
    let vy = speed * Math.sin(pitch);
    let h = 0;
    let y = 0;
    for (let t = 0; t < maxTicks; t++) {
      if (dragFirst) {
        vy = (vy - gravity) * drag;
        vh *= drag;
      }
      const nh = h + vh;
      const ny = y + vy;
      if (nh >= horiz) {
        const f = (horiz - h) / vh;
        return { y: y + (ny - y) * f, ticks: t + f };
      }
      h = nh;
      y = ny;
      if (!dragFirst) {
        vh *= drag;
        vy = vy * drag - gravity;
      }
      if (vh < 1e-3) return null;
    }
    return null;
  };
  // 从低往高扫描发射角，找到第一个“正好打到目标高度”的低弹道，再二分细化。
  let prev = null;
  for (let deg = -80; deg <= 80; deg += 1) {
    const p = (deg * Math.PI) / 180;
    const r = heightAt(p);
    const err = r ? r.y - dy : null;
    if (err !== null && prev?.err != null && prev.err < 0 && err >= 0) {
      let lo = prev.p;
      let hi = p;
      let best = r;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        const rm = heightAt(mid);
        if (rm && rm.y - dy >= 0) {
          hi = mid;
          best = rm;
        } else lo = mid;
      }
      const look = Math.max(-Math.PI / 2 + 0.01, hi - pitchOffset);
      return { yaw, pitch: look, launch: hi, ticks: best.ticks };
    }
    prev = { p, err };
  }
  return null;
}
