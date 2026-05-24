import { useState, useEffect, useRef } from "react";
import JSZip from "jszip";
import { GIFEncoder, quantize, applyPalette } from "gifenc";

// ── Constants ─────────────────────────────────────────────────────────────────
const W = 480, H = 320, GY = Math.round(H * 0.77), TAU = Math.PI * 2;
const DPR = Math.min(window.devicePixelRatio || 1, 2);
const EXP_ASPECTS = [
  {key:'3:2',     label:'3:2',      w:480, h:320},
  {key:'16:9',    label:'16:9',     w:480, h:270},
  {key:'1:1',     label:'Square',   w:320, h:320},
  {key:'9:16',    label:'Portrait', w:270, h:480},
];
// Render src (W×H at res scale) into an expW×expH canvas, letterboxed with bg.
function compositeFrame(src, expW, expH, bgColor, res) {
  const ew=expW*res, eh=expH*res;
  const ex=document.createElement('canvas'); ex.width=ew; ex.height=eh;
  const ctx=ex.getContext('2d');
  ctx.fillStyle=bgColor; ctx.fillRect(0,0,ew,eh);
  const scale=Math.min(ew/src.width, eh/src.height);
  ctx.drawImage(src,0,0,src.width,src.height,
    (ew-src.width*scale)/2,(eh-src.height*scale)/2,src.width*scale,src.height*scale);
  return ex;
}

// ── Physics helpers ───────────────────────────────────────────────────────────
function legKnee(hx, hy, fx, fy, t, s, dir) {
const dx = fx-hx, dy = fy-hy, d = Math.sqrt(dx*dx+dy*dy) || 1;
const a = Math.acos(Math.max(-1, Math.min(1, (d*d+t*t-s*s)/(2*d*t))));
const base = Math.atan2(dy, dx);
const k1 = {x: hx+Math.cos(base+a)*t, y: hy+Math.sin(base+a)*t};
const k2 = {x: hx+Math.cos(base-a)*t, y: hy+Math.sin(base-a)*t};
return (dir >= 0 ? k1.x >= k2.x : k1.x <= k2.x) ? k1 : k2;
}
function biasKnee(kn, bias, dir, hx, hy, t) {
  if (!bias) return kn;
  const dx = kn.x + bias*dir - hx, dy = kn.y - hy;
  const d = Math.sqrt(dx*dx + dy*dy) || t;
  return {x: hx + dx/d*t, y: hy + dy/d*t};
}
function armSetup(ap, shX, shY, uA, fA, swing, bendDeg, dir, armRaise=0, ease=1) {
const max = Math.asin(Math.min(swing / Math.max(uA+fA, 1), 0.95));
const s = Math.sin(ap);
const es = (ease !== 1 && s !== 0) ? (s > 0 ? Math.pow(s, 1/ease) : -Math.pow(-s, 1/ease)) : s;
const alpha = es * max;
const raise = armRaise * Math.PI / 180;
const cosR = Math.cos(raise), sinR = Math.sin(raise);
const eX = shX + Math.sin(alpha)*dir*uA;
const eY = shY + Math.cos(alpha)*cosR*uA;
const eDzRaise = Math.cos(alpha)*sinR*uA;
const bend = (bendDeg * Math.PI / 180) * Math.max(0, s);
const fa = alpha + bend;
const hX = eX + Math.sin(fa)*dir*fA;
const hY = eY + Math.cos(fa)*cosR*fA;
const hDzRaise = Math.cos(fa)*sinR*fA;
return { elbow:{x:eX,y:eY}, hand:{x:hX,y:hY}, eDzRaise, hDzRaise, alpha, fa };
}
// ── Foot drawing ──────────────────────────────────────────────────────────────
// One continuous foot-angle formula through all phases. No mode switching.
//
// The "geometry angle": the exact angle `a` that places the ball of foot at GY
// given the current ankle height.  If ankle is h px above GY and metatarsal
// is mtpLen long, then sin(a) = -h/mtpLen  (negative = pointing downward).
//
//   CONTACT / FLAT STANCE  (ankle at GY, onGround):
//     a = max(0, rawA)  — heel-down on strike, flat at mid-stance. Never negative
//     so the foot can't point underground from a ground-level ankle.
//
//   HEEL-RISE  (ankle above GY, onGround):
//     a = geometry angle  — ball stays exactly on GY while heel lifts. ✓
//
//   SWING  (not onGround, continuous blend):
//     • At toe-off  : a = geometry angle  ← matches heel-rise, NO SNAP
//     • 0→mid-swing : blends to rawA×0.4  (foot relaxes in air)
//     • mid-swing→contact: blends to rawA (full heel-down, prepares for strike)
//     • At contact  : a = rawA           ← matches stance contact, NO SNAP
//
// Ball stays on GY while within reach; lifts smoothly once the ankle rises
// beyond mtpLen. Toe is flat at GY while ball is grounded, angled in the air.
function isDark(hex) { if(!hex||!hex.startsWith('#')) return false; const [r,g,b]=hex.match(/\w\w/g).map(x=>parseInt(x,16)); return 0.299*r+0.587*g+0.114*b<60; }

function drawFoot(ctx, fx, fy, lp, sz, dir, lw, am, stroke, legLen, stepLen, heelToe, liftTilt=0, halo=null, viewCos=1) {
const mtpLen = sz * 0.75, toeLen = sz * 0.25;
const maxDeg = Math.asin(Math.min(0.92, stepLen / Math.max(legLen, 1))) * (180 / Math.PI);
const rawA   = maxDeg * heelToe * Math.sin(lp) * Math.PI / 180;
const onGround = Math.cos(lp) <= 0;
const rise = Math.max(0, GY - fy);                            // ankle height above GY
const t = ((lp % TAU) + TAU) % TAU / TAU;
// geoA: geometry angle that places ball of foot at GY. Capped at -72° so foot never points straight down.
const geoA = Math.max(-Math.PI * 0.4, -Math.asin(Math.min(1, (onGround ? rise : Math.min(rise, sz * 0.45)) / mtpLen)));

let a;
if (onGround) {
// Blend rawA (heel-down at contact, flat at mid-stance) → geoA (heel-rise geometry).
// Smooth transition over first half of foot-size height — no snap.
const rBlend = Math.min(1, rise / Math.max(sz * 0.5, 1));
a = rawA * (1 - rBlend) + geoA * rBlend;
} else {
const swingNorm = ((t - 0.75 + 1) % 1) / 0.5;
if (swingNorm <= 0.5) {
const fadeOut = swingNorm < 0.15 ? Math.cos(swingNorm / 0.15 * Math.PI * 0.5) : 0;
a = geoA * fadeOut;
} else {
// Late swing: prepare heel-down for contact.
// Clamp a >= 0 when ankle is significantly elevated — prevents foot appearing to
// rotate backward from the shin when the foot is raised high (kick-out position).
const p = Math.sin((swingNorm - 0.5) * Math.PI);
a = rawA * (0.4 + 0.6 * p);
if (rise > sz * 0.4) a = Math.max(0, a);
}
a += liftTilt;
}
const ca = Math.cos(a), sa = Math.sin(a);
const bx = fx + mtpLen * ca * dir * viewCos;
const by = Math.min(fy - mtpLen * sa, GY);                    // never below GY

// Toe: flat at GY while ball is grounded; follows foot angle when airborne
let tx, ty;
if (by >= GY - 0.5) {
tx = bx + toeLen * dir * viewCos; ty = GY;                  // flat ground contact
} else {
tx = bx + toeLen * ca * dir * viewCos;
ty = Math.min(by - toeLen * sa, GY);
}

ctx.save();
ctx.lineCap='round'; ctx.lineJoin='round'; ctx.globalAlpha=am;
if(halo){ctx.strokeStyle=halo;ctx.lineWidth=lw*2.4;ctx.beginPath();ctx.moveTo(fx,fy);ctx.lineTo(bx,by);ctx.lineTo(tx,ty);ctx.stroke();}
ctx.strokeStyle=stroke; ctx.lineWidth=lw*1.15;
ctx.beginPath(); ctx.moveTo(fx,fy); ctx.lineTo(bx,by); ctx.lineTo(tx,ty); ctx.stroke();
ctx.restore();
}

// ── Easing ────────────────────────────────────────────────────────────────────
// Redistributes frame time using a double-frequency sine offset.
// This makes the figure dwell at CONTACT (t≈0.25) and TOE-OFF (t≈0.75),
// and rush through PASSING (t≈0, t≈0.5) — which is correct for walk weight.
//
// Velocity = 1 + feel·cos(4πt)/1.5
//   t=0.25 and t=0.75: velocity = 1 − feel/1.5  (slowest, min 0.33× at feel=1)
//   t=0   and t=0.5:   velocity = 1 + feel/1.5  (fastest, max 1.67× at feel=1)
//
// The figure NEVER pauses at any feel value. Boundary conditions preserved:
// applyFeel(0)=0, applyFeel(1)=1 (sin(4π)=0).
function applyFeel(t, feel) {
if (feel <= 0) return t;
return t + feel * Math.sin(4 * Math.PI * t) / (6 * Math.PI);
}
const cycLen = (fps, speed) => Math.max(2, Math.round(fps * TAU / (speed * 2.5)));

// ── Heel rise ────────────────────────────────────────────────────────────────
// Raises the ankle above GY during push-off so the foot geometry can correctly
// show the ball-of-foot staying on the ground while the heel lifts.
//
// Uses cosine half-periods so the derivative is ZERO at every transition point
// (t=0.50 onset, t=0.75 peak, t=0.90 hand-off to swing lift) — no snapping.
//
//   t 0.50→0.75 : ankle rises      0 → sz×0.45  (cosine ease-in)
//   t 0.75→0.90 : ankle falls back sz×0.45 → 0  (cosine ease-out)
//   The decay overlaps with swing lift so the total ankle path is smooth.
function heelRise(lp, sz) {
const t = ((lp % TAU) + TAU) % TAU / TAU;
let frac = 0;
if (t >= 0.50 && t <= 0.75) frac = 0.5 * (1 - Math.cos(Math.PI * (t - 0.50) / 0.25));
else if (t > 0.75 && t < 0.90) frac = 0.5 * (1 + Math.cos(Math.PI * (t - 0.75) / 0.15));
return sz * 0.45 * frac;
}

// The root cause of foot sliding: sin(phase)*stepLength moves the foot continuously
// even when it's supposed to be on the ground. This function fixes that.
//
// Walk cycle phases (normalised t = phase / TAU):
//   t = 0.25 → heel strike (front foot fully forward)
//   t = 0.50 → mid-stance  (foot under body)
//   t = 0.75 → toe-off     (foot fully back)
//   t = 0    → mid-swing   (foot at max height, passing under body)
//
// Stance  [t 0.25→0.75]: foot sweeps back at constant rate → looks planted ✓
// Swing   [t 0.75→0.25]: smooth sine arc from back to front
//
// Continuous at contact/toe-off. The easing formula also has zero offset at
// exactly t=0.25 and t=0.75 (sin(π)=sin(3π)=0), so foot-plant timing is
// preserved regardless of the Feel setting.
function footPosX(lp, sl, dir, cx) {
const t = ((lp % TAU) + TAU) % TAU / TAU;
if (t >= 0.25 && t <= 0.75) {
// Stance: constant-rate backward sweep — the foot stays planted
return cx + dir * sl * (1 - 2 * (t - 0.25) / 0.5);
}
// Swing: sine arc from back position to front contact point
const sf = ((t - 0.75 + 1) % 1) / 0.5;      // 0 at toe-off, 1 at next contact
return cx + dir * sl * Math.sin((sf - 0.5) * Math.PI);
}

// ── Leg solver — IK with forward-biased virtual foot ─────────────────────────
// Ankle = virtual foot target always. Knee = IK from hip to virtual foot.
// swingFull = sin(sf·π): 0 at toe-off AND heel-strike → no discontinuity.
// fwdPeak = sin((sf−0.5)·2π) for sf∈[0.5,1], else 0: peaks at sf=0.75 (foot
// most forward), 0 at both transitions. Controls kneeLift boost + footLift blend.
// After biasKnee, ankle is re-projected to keep shin length exact.
function computeLeg(phase, cx, hipX, hipY, thigh, shin, sl, kneeLift, footLift, legBend, footSize, legLen, dir) {
  const t      = ((phase % TAU) + TAU) % TAU / TAU;
  const footX  = footPosX(phase, sl, dir, cx);
  const baseY  = GY - heelRise(phase, footSize);

  const inSwing  = !(t >= 0.25 && t <= 0.75);
  const sf       = inSwing ? ((t - 0.75 + 1) % 1) / 0.5 : 0;   // 0=toe-off, 1=heel-strike
  const swingFull = inSwing ? Math.sin(sf * Math.PI) : 0;         // 0 at both transitions

  // fwdPeak: complete 0→1→0 half-sine in [sf=0.5, sf=1], zero in early swing.
  // Ensures kneeLift peaks and footLift engages only when foot is forward.
  const fwdPeak = (inSwing && sf >= 0.5) ? Math.sin((sf - 0.5) * 2 * Math.PI) : 0;

  // kneeLift: small clearance all swing (0.3×swingFull), large forward lift (0.7×fwdPeak)
  const maxRaise = Math.max(0, baseY - hipY - (thigh - shin) - 2);
  const raise    = Math.min(
    (swingFull * 0.3 + fwdPeak * 0.7) * (kneeLift / 100) * legLen * 0.9,
    maxRaise
  );
  const footY    = baseY - raise;

  const rawKnee = legKnee(hipX, hipY, footX, footY, thigh, shin, dir);

  // Ankle = virtual foot (never derived from knee)
  let ax = footX, ay = Math.min(footY, GY);

  // footLift: in forward swing only, blend ankle toward thigh-parallel extension
  if (footLift > 0 && fwdPeak > 0) {
    const tx = rawKnee.x - hipX, ty = rawKnee.y - hipY;
    const td = Math.sqrt(tx * tx + ty * ty) || thigh;
    const ex = rawKnee.x + shin * tx / td;
    const ey = rawKnee.y + shin * ty / td;
    const blend = footLift * fwdPeak;
    ax = ax * (1 - blend) + ex * blend;
    ay = Math.min(ay * (1 - blend) + ey * blend, GY);
    // Re-project: blend of two shin-length points moves inside the circle
    const dka = Math.sqrt((ax - rawKnee.x) ** 2 + (ay - rawKnee.y) ** 2) || shin;
    ax = rawKnee.x + (ax - rawKnee.x) / dka * shin;
    ay = Math.min(rawKnee.y + (ay - rawKnee.y) / dka * shin, GY);
  }

  // legBend bias: 0 during swing (shin length stays exact; knee already lifted by kneeLift),
  // fades with |cos(phase)| in stance so it's 0 at both transitions — no snap.
  const biasBlend = inSwing ? 0 : Math.abs(Math.cos(phase));
  const knee = biasKnee(rawKnee, legBend * biasBlend, dir, hipX, hipY, thigh);
  knee.y = Math.min(knee.y, GY - 1);

  // Stance only: maintain exact shin length by heel-lift if the biased knee is too far.
  // Cap the lift so it never exceeds the natural heelRise range — prevents floating with small feet.
  if (!inSwing) {
    const dkf = Math.sqrt((ax - knee.x) ** 2 + (ay - knee.y) ** 2);
    if (dkf > shin) {
      ax = knee.x + (ax - knee.x) * shin / dkf;
      ay = Math.max(knee.y + (ay - knee.y) * shin / dkf, GY - footSize * 0.55);
    }
  }

  return { knee, ankle: { x: ax, y: ay } };
}

// ── Pose engine ───────────────────────────────────────────────────────────────
// IK throughout — no mode switch, no discontinuities at transitions.
function computePose(phase, cx, p, dir) {
const {stepLength,kneeLift,footLift,torsoLen,legLen,armLen,headSize,footSize,legBend,armBend,
bodyTilt,hipSway,shoulderWidth=0,leanAngle,headBob,headPendulum,armSwing,bounce} = p;
const legR=(p.legRatio||0)/100, armR=(p.armRatio||0)/100;
const thigh=legLen*(0.52+legR), shin=legLen*(0.48-legR);
const uArm=armLen*(0.48+armR), fArm=armLen*(0.52-armR);
// stepWidth: lateral z-offset of feet. When wider than legLen, forward reach approaches zero.
const footZ3d = p.stepWidth ?? hipSway;
// Cap sl so IK never snaps. Also reduce max reach when feet are laterally offset (geometry).
const dipCap = legLen * 0.28;
const maxFwdReach = Math.sqrt(Math.max(0, legLen*legLen - footZ3d*footZ3d)) * 0.97;
const sl = Math.min(stepLength, maxFwdReach, Math.sqrt(dipCap * (2 * legLen - dipCap)) * 0.97);
const fFootX = footPosX(phase,        sl, dir, cx);
const bFootX = footPosX(phase+Math.PI, sl, dir, cx);
const stanceDx = Math.min(Math.abs(fFootX-cx), Math.abs(bFootX-cx));
const k = Math.min(0.98, stanceDx / Math.max(legLen, 1));
const dip = Math.min(legLen*(1-Math.sqrt(1-k*k))*(1+bounce*0.10), legLen*0.28);
const hipX = cx, hipY = GY-legLen+dip;
// hipSway: each hip swings forward/back (x) and dips/rises (y) — visible tilt from side view.
// Forward hip shifts ahead (+x) and drops slightly (+y); back hip does the opposite.
// tiltDY adds the vertical component so hips and shoulders visibly counter-rotate.
const rot   = Math.sin(phase) * dir;
const tiltDY = rot * hipSway * 0.4;
const fHipX = hipX + rot*hipSway, fHipY = hipY + tiltDY;
const bHipX = hipX - rot*hipSway, bHipY = hipY - tiltDY;
const bodyTiltDelayRad = (p.bodyTiltDelay||0) * Math.PI/180;
const bodyTiltEaseVal  = p.bodyTiltEase || 1;
const btRaw = Math.sin(phase - bodyTiltDelayRad);
const btEs  = (bodyTiltEaseVal !== 1 && btRaw !== 0) ? (btRaw > 0 ? Math.pow(btRaw, 1/bodyTiltEaseVal) : -Math.pow(-btRaw, 1/bodyTiltEaseVal)) : btRaw;
const tilt = btEs*(bodyTilt*Math.PI/180)*dir + leanAngle*Math.PI/180;
const spineBend = p.spineBend || 0;
const spineDir  = p.spineDir  || 0;
const tiltF = Math.sin(tilt);
const dirBias = spineDir / 10;
const bendF = -tiltF * (1 - Math.abs(dirBias)) + dirBias;
const actualBend = spineBend * bendF;
const maxBend = torsoLen * 0.45;
const clampedBend = Math.max(-maxBend, Math.min(maxBend, actualBend));
const spineChord = Math.sqrt(Math.max(0, torsoLen*torsoLen - 4*clampedBend*clampedBend));
const sX = hipX+Math.sin(tilt)*spineChord, sY = hipY-Math.cos(tilt)*spineChord;
const spCtrlX = hipX*0.25 + sX*0.75 + 2*clampedBend*Math.cos(tilt)*dir;
const spCtrlY = hipY*0.25 + sY*0.75 + 2*clampedBend*Math.sin(tilt)*dir;
const neckLen = headSize*1.4;
const neckTiltRad = (p.headAngle||0) * Math.PI/180;
const swingAngle = headPendulum / Math.max(neckLen, 1);
const headDelayRad = (p.headDelay||0) * Math.PI/180;
const headTheta = neckTiltRad + Math.sin(phase - headDelayRad)*swingAngle;
const hdX = sX + neckLen*Math.sin(headTheta)*dir;
const hdY = sY - neckLen*Math.cos(headTheta) - Math.abs(Math.sin(phase*2))*headBob;
const hdZ = 0;
const headMaxFwd = Math.sin((Math.abs(leanAngle)+Math.abs(bodyTilt))*Math.PI/180)*spineChord
                 + neckLen*Math.sin(Math.abs(neckTiltRad)+swingAngle);
// Shoulders counter-rotate: forward shoulder rises (+y reversed) and goes back (-x)
const shouAmt = shoulderWidth;
const fShoX = sX - rot*shouAmt, fShoY = sY + tiltDY*0.75;
const bShoX = sX + rot*shouAmt, bShoY = sY - tiltDY*0.75;
const sf = computeLeg(phase,        cx, fHipX, fHipY, thigh, shin, sl, kneeLift, footLift, legBend, footSize, legLen, dir);
const sb = computeLeg(phase+Math.PI, cx, bHipX, bHipY, thigh, shin, sl, kneeLift, footLift, legBend, footSize, legLen, dir);
const fAn=sf.ankle, fK=sf.knee, bAn=sb.ankle, bK=sb.knee;
fK.y=Math.min(fK.y,GY-1); bK.y=Math.min(bK.y,GY-1);
const armRaise = p.armRaise || 0;
const armDir   = p.armDirection || 0;
const armDelayRad = (p.armDelay||0) * Math.PI/180;
const armEaseVal  = p.armEase  || 1;
const fAOut=armSetup(phase+Math.PI-armDelayRad,fShoX,fShoY,uArm,fArm,armSwing,armBend,dir,armRaise,armEaseVal);
const bAOut=armSetup(phase      -armDelayRad,  bShoX,bShoY,uArm,fArm,armSwing,armBend,dir,armRaise,armEaseVal);
const {elbow:fE,hand:fH}=fAOut;
const {elbow:bE,hand:bH}=bAOut;
[fE,fH,bE,bH].forEach(pt=>{ pt.y=Math.min(pt.y,GY-2); });
// 3D Y-axis rotation: viewAngle=0 side view, 90 = front, 180 = other side, 270 = back.
// sinA is negated so increasing angle rotates toward the front face.
const va = (p.viewAngle||0) * Math.PI / 180;
const cosA=Math.cos(va), sinA=-Math.sin(va);
const HW=hipSway, SW=shoulderWidth;
// Per-joint arm z-offsets: base clearance + lateral raise contribution + direction (crossing)
const armBaseZ = Math.max(SW, HW);
// Arm crossing (armDir * rot): elbows cross moderately, hands cross more — gives visible
// forearm follow-through angle. Both scale from the same rot*sin so symmetry is preserved.
const fEZ_raw = armBaseZ + fAOut.eDzRaise + armDir * rot * Math.sin(fAOut.alpha) * 0.45;
const bEZ_raw = armBaseZ + bAOut.eDzRaise - armDir * rot * Math.sin(bAOut.alpha) * 0.45;
const fEZ = Math.max(0, fEZ_raw);
const bEZ = Math.max(0, bEZ_raw);
const fHZ = Math.max(0, fEZ_raw + fAOut.hDzRaise + armDir * rot * Math.sin(fAOut.fa) * 1.3);
const bHZ = Math.max(0, bEZ_raw + bAOut.hDzRaise - armDir * rot * Math.sin(bAOut.fa) * 1.3);
const pose = {hipX,hipY,fHipX,bHipX,fHipY,bHipY,sX,sY,spCtrlX,spCtrlY,fShoX,fShoY,bShoX,bShoY,hdX,hdY,headMaxFwd,headTheta,fAn,bAn,fK,bK,fE,fH,bE,bH,
  fDepth:0,bDepth:0,fArmDepth:0,bArmDepth:0,headDepth:0,fKDepth:0,bKDepth:0,
  fEDepth:0,bEDepth:0,fAnDepth:0,bAnDepth:0,fHDepth:0,bHDepth:0,
  fEZ,bEZ,fHZ,bHZ};
pose.fDepth    = -(fHipX-cx)*sinA + HW*cosA;
pose.bDepth    = -(bHipX-cx)*sinA - HW*cosA;
pose.fArmDepth = -(fShoX-cx)*sinA + SW*cosA;
pose.bArmDepth = -(bShoX-cx)*sinA - SW*cosA;
pose.headDepth = -(hdX-cx)*sinA + hdZ*cosA;
// Knees use footZ3d (same as ankles) so the full leg slopes consistently with step width
pose.fKDepth   = -(fK.x-cx)*sinA + footZ3d*cosA;
pose.bKDepth   = -(bK.x-cx)*sinA - footZ3d*cosA;
pose.fAnDepth  = -(fAn.x-cx)*sinA + footZ3d*cosA;
pose.bAnDepth  = -(bAn.x-cx)*sinA - footZ3d*cosA;
pose.fEDepth   = -(fE.x-cx)*sinA + fEZ*cosA;
pose.bEDepth   = -(bE.x-cx)*sinA - bEZ*cosA;
pose.fHDepth   = -(fH.x-cx)*sinA + fHZ*cosA;
pose.bHDepth   = -(bH.x-cx)*sinA - bHZ*cosA;
if (va !== 0) {
  const proj = (x, z) => cx + (x-cx)*cosA + z*sinA;
  pose.hipX=proj(hipX,0); pose.sX=proj(sX,0); pose.spCtrlX=proj(spCtrlX,0); pose.hdX=proj(hdX,hdZ);
  // Knees now use footZ3d (same as ankles) for consistent leg slope
  pose.fHipX=proj(fHipX,HW);  pose.fK={x:proj(fK.x,footZ3d),y:fK.y};  pose.fAn={x:proj(fAn.x,footZ3d),y:fAn.y};
  pose.bHipX=proj(bHipX,-HW); pose.bK={x:proj(bK.x,-footZ3d),y:bK.y}; pose.bAn={x:proj(bAn.x,-footZ3d),y:bAn.y};
  pose.fShoX=proj(fShoX,SW);  pose.fE={x:proj(fE.x,fEZ),y:fE.y};  pose.fH={x:proj(fH.x,fHZ),y:fH.y};
  pose.bShoX=proj(bShoX,-SW); pose.bE={x:proj(bE.x,-bEZ),y:bE.y}; pose.bH={x:proj(bH.x,-bHZ),y:bH.y};
}
return pose;
}

function hexRgba(hex,a){const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);return `rgba(${r},${g},${b},${a})`;}

// ── Draw figure from pose ─────────────────────────────────────────────────────
function drawFigure(ctx, pose, p, col, dir, phase, am=1) {
const {hipX,hipY,fHipX,bHipX,fHipY,bHipY,sX,sY,spCtrlX,spCtrlY,fShoX,fShoY,bShoX,bShoY,hdX,hdY,headMaxFwd=0,headTheta=0,
       fAn,bAn,fK,bK,fE,fH,bE,bH,
       fDepth=0,bDepth=0,fArmDepth=0,bArmDepth=0,headDepth=0,
       fKDepth=0,bKDepth=0,fAnDepth=0,bAnDepth=0,
       fEDepth=0,bEDepth=0,fHDepth=0,bHDepth=0,
       fEZ=1,bEZ=1,fHZ=1,bHZ=1} = pose;
const {footSize:fs,heelToe:ht,legLen:ll,stepLength:sl,lineWidth:lw,headSize:hs} = p;
const sc = k => col.parts ? col.parts[k] : col.stroke;
const haloColor = 'rgba(255,255,255,0.42)';
const footHalo = col.parts && isDark(sc('feet')) ? haloColor : null;
const headHalo = col.parts && isDark(sc('head')) ? haloColor : null;
const va = (p.viewAngle||0)*Math.PI/180;
const cosA = Math.cos(va), sinA = -Math.sin(va);
const viewCos = cosA;
ctx.save(); ctx.fillStyle=col.fill;
ctx.lineWidth=lw; ctx.lineCap='round'; ctx.lineJoin='round';

// Dynamically determine which limb is closer to the viewer based on 3D depth.
// Near front/back view (|cosA|<0.40) depth sort is x-based; use z-sign tiebreaker instead.
const frontCloser = Math.abs(cosA) > 0.40 ? fDepth >= bDepth : sinA <= 0;
// Shoulders counter-rotate vs hips (fShoX = sX - rot*SW, opposite of fHipX).
// At front view fArmDepth = (fShoX-cx) = -rot*SW — correct oscillating depth, no threshold needed.
const armFrontCloser = fArmDepth >= bArmDepth;
// LEGS — use hip-based frontCloser
const [nHipX,nHipY,nK,nAn,nPhase] = frontCloser
  ? [fHipX,fHipY,fK,fAn,phase]
  : [bHipX,bHipY,bK,bAn,phase+Math.PI];
const [xHipX,xHipY,xK,xAn,xPhase] = frontCloser
  ? [bHipX,bHipY,bK,bAn,phase+Math.PI]
  : [fHipX,fHipY,fK,fAn,phase];
// ARMS — use armFrontCloser (independent of legs due to counter-rotation)
const [nShoX,nShoY,nE,nH] = armFrontCloser ? [fShoX,fShoY,fE,fH] : [bShoX,bShoY,bE,bH];
const [xShoX,xShoY,xE,xH] = armFrontCloser ? [bShoX,bShoY,bE,bH] : [fShoX,fShoY,fE,fH];

// Continuous depth → opacity + line weight
const HW = p.hipSway||0, SW = p.shoulderWidth||0;
const dF = (d, s) => s > 0 ? Math.max(0, Math.min(1, (d+s)/(2*s))) : 0.5;
const footZ = p.stepWidth ?? HW;
const tNearLeg    = dF(frontCloser ? fDepth    : bDepth,    HW);
const tFarLeg     = dF(frontCloser ? bDepth    : fDepth,    HW);
const tNearKnee   = dF(frontCloser ? fKDepth   : bKDepth,   footZ);
const tFarKnee    = dF(frontCloser ? bKDepth   : fKDepth,   footZ);
const tNearAnkle  = dF(frontCloser ? fAnDepth  : bAnDepth,  footZ);
const tFarAnkle   = dF(frontCloser ? bAnDepth  : fAnDepth,  footZ);
const armBaseZ = Math.max(SW, HW);
const tNearArm   = dF(armFrontCloser ? fArmDepth : bArmDepth, armBaseZ);
const tFarArm    = dF(armFrontCloser ? bArmDepth : fArmDepth, armBaseZ);
const tNearElbow = dF(armFrontCloser ? fEDepth   : bEDepth,   armBaseZ);
const tFarElbow  = dF(armFrontCloser ? bEDepth   : fEDepth,   armBaseZ);
const tNearHand  = dF(armFrontCloser ? fHDepth   : bHDepth,   armBaseZ);
const tFarHand   = dF(armFrontCloser ? bHDepth   : fHDepth,   armBaseZ);
const nearLegLW=lw*(0.50+0.50*tNearLeg), farLegLW=lw*(0.50+0.50*tFarLeg);
const nearLegA =am*(0.30+0.70*tNearLeg), farLegA =am*(0.30+0.70*tFarLeg);
const nearArmLW=lw*(0.50+0.50*tNearArm), farArmLW=lw*(0.50+0.50*tFarArm);
const nearArmA =am*(0.30+0.70*tNearArm), farArmA =am*(0.30+0.70*tFarArm);
const lwT = t => lw*(0.50+0.50*t);

// Tapered trapezoid: width and opacity both graduate from t0 (start) to t1 (end).
// Dot joints cover the endpoints so no round caps needed.
const segG = (x0,y0,x1,y1,t0,t1,color) => {
  const dx=x1-x0, dy=y1-y0, len=Math.sqrt(dx*dx+dy*dy)||1;
  const nx=-dy/len, ny=dx/len;
  const hw0=lwT(t0)/2, hw1=lwT(t1)/2;
  const g = ctx.createLinearGradient(x0,y0,x1,y1);
  g.addColorStop(0, hexRgba(color, am*(0.30+0.70*t0)));
  g.addColorStop(1, hexRgba(color, am*(0.30+0.70*t1)));
  ctx.globalAlpha=1; ctx.fillStyle=g;
  ctx.beginPath();
  ctx.moveTo(x0+nx*hw0, y0+ny*hw0);
  ctx.lineTo(x1+nx*hw1, y1+ny*hw1);
  ctx.lineTo(x1-nx*hw1, y1-ny*hw1);
  ctx.lineTo(x0-nx*hw0, y0-ny*hw0);
  ctx.closePath(); ctx.fill();
};

// Joint dot helper: filled circle slightly larger than the line endpoint
const dot=(x,y,t,color,s=1)=>{ctx.globalAlpha=am*(0.30+0.70*t);ctx.fillStyle=color;ctx.beginPath();ctx.arc(x,y,lw*(0.6+0.5*t)*s,0,TAU);ctx.fill();};

// Far limbs first (depth-based opacity + weight, per segment)
segG(xHipX,xHipY, xK.x,xK.y,   tFarLeg,    tFarKnee,   sc('legs'));
segG(xK.x,xK.y,   xAn.x,xAn.y, tFarKnee,   tFarAnkle,  sc('legs'));
if(fs>0) drawFoot(ctx,xAn.x,xAn.y,xPhase,fs,dir,farLegLW,farLegA,sc('feet'),ll,sl,ht,0,footHalo,viewCos);
dot(xHipX,xHipY,tFarLeg,sc('legs'));
dot(xK.x,xK.y,tFarKnee,sc('legs'));
segG(xShoX,xShoY, xE.x,xE.y,   tFarArm,    tFarElbow,  sc('arms'));
segG(xE.x,xE.y,   xH.x,xH.y,   tFarElbow,  tFarHand,   sc('arms'));
dot(xShoX,xShoY,tFarArm,sc('arms'));
dot(xE.x,xE.y,tFarElbow,sc('arms'));
dot(xH.x,xH.y,tFarHand,sc('arms'),1.35);

// Spine + crossbars (middle layer, normal weight)
ctx.lineWidth=lw; ctx.globalAlpha=am; ctx.strokeStyle=sc('body');
ctx.beginPath();ctx.moveTo(hipX,hipY);ctx.quadraticCurveTo(spCtrlX,spCtrlY,sX,sY);ctx.stroke();
// Hip & shoulder crossbar gradients: far end (faded) → near end (solid)
const bodyHex=sc('body');
const [farHX,farHY,nearHX,nearHY] = frontCloser ? [bHipX,bHipY,fHipX,fHipY] : [fHipX,fHipY,bHipX,bHipY];
let grad=ctx.createLinearGradient(farHX,farHY,nearHX,nearHY);
grad.addColorStop(0,hexRgba(bodyHex,0.38)); grad.addColorStop(1,bodyHex);
ctx.strokeStyle=grad; ctx.beginPath(); ctx.moveTo(bHipX,bHipY); ctx.lineTo(fHipX,fHipY); ctx.stroke();
const [farSX,farSY,nearSX,nearSY] = armFrontCloser ? [bShoX,bShoY,fShoX,fShoY] : [fShoX,fShoY,bShoX,bShoY];
grad=ctx.createLinearGradient(farSX,farSY,nearSX,nearSY);
grad.addColorStop(0,hexRgba(bodyHex,0.38)); grad.addColorStop(1,bodyHex);
ctx.strokeStyle=grad; ctx.beginPath(); ctx.moveTo(bShoX,bShoY); ctx.lineTo(fShoX,fShoY); ctx.stroke();

// Near limbs last (full weight + full opacity, on top)
segG(nHipX,nHipY, nK.x,nK.y,   tNearLeg,   tNearKnee,  sc('legs'));
segG(nK.x,nK.y,   nAn.x,nAn.y, tNearKnee,  tNearAnkle, sc('legs'));
if(fs>0) drawFoot(ctx,nAn.x,nAn.y,nPhase,fs,dir,nearLegLW,nearLegA,sc('feet'),ll,sl,ht,0,footHalo,viewCos);
dot(nHipX,nHipY,tNearLeg,sc('legs'));
dot(nK.x,nK.y,tNearKnee,sc('legs'));

// Head depth vars — headPendulum swing affects head opacity, size, weight when rotated
const headPend=p.headPendulum||0;
const headNormScale=Math.max(HW,SW,headMaxFwd,1);
const normHD=Math.max(-1,Math.min(1,headDepth/headNormScale));
const headAlpha=Math.min(1.0,1.0+0.35*normHD)*am;
const headLW=lw*Math.max(0.70,1.0+0.20*normHD);
const headR=hs*(1+0.06*normHD);
const drawHead=()=>{
ctx.lineWidth=headLW; ctx.globalAlpha=headAlpha;
if(headHalo){ctx.strokeStyle=haloColor;ctx.lineWidth=headLW*2.0;ctx.beginPath();ctx.arc(hdX,hdY,headR,0,TAU);ctx.stroke();ctx.lineWidth=headLW;}
ctx.strokeStyle=sc('head');
ctx.beginPath(); ctx.arc(hdX,hdY,headR,0,TAU); ctx.stroke();
ctx.globalAlpha=0.10*headAlpha; ctx.fillStyle=col.fill; ctx.fill();
ctx.save();
ctx.strokeStyle=sc('head'); ctx.lineWidth=headLW*0.45; ctx.globalAlpha=0.28*headAlpha;
ctx.beginPath(); ctx.arc(hdX,hdY,headR*0.96,0,TAU); ctx.clip();
const headYawSin=Math.sin(headTheta)*dir;
const pitchAngle=headYawSin*0.7;
const pitchArcOff=pitchAngle*headR*Math.abs(sinA)*0.85;
ctx.translate(hdX,hdY);
ctx.rotate(pitchAngle*cosA);
const arcOff=headYawSin*headR*0.18;
const lat=headR*0.707;
ctx.beginPath(); ctx.moveTo(-headR,-lat); ctx.quadraticCurveTo(0,-lat+arcOff+pitchArcOff,headR,-lat); ctx.stroke();
ctx.beginPath(); ctx.moveTo(-headR,0);    ctx.quadraticCurveTo(0,arcOff+pitchArcOff,     headR,0);    ctx.stroke();
ctx.beginPath(); ctx.moveTo(-headR,lat);  ctx.quadraticCurveTo(0,lat+arcOff+pitchArcOff, headR,lat);  ctx.stroke();
ctx.globalAlpha=0.10*headAlpha;
ctx.beginPath(); ctx.moveTo(-headR,-lat); ctx.quadraticCurveTo(0,-lat-arcOff-pitchArcOff,headR,-lat); ctx.stroke();
ctx.beginPath(); ctx.moveTo(-headR,0);    ctx.quadraticCurveTo(0,-arcOff-pitchArcOff,    headR,0);    ctx.stroke();
ctx.beginPath(); ctx.moveTo(-headR,lat);  ctx.quadraticCurveTo(0,lat-arcOff-pitchArcOff, headR,lat);  ctx.stroke();
for(let i=0;i<4;i++){
  const mRx=headR*Math.abs(Math.sin(va+i*Math.PI/4));
  const fc=Math.cos(i*Math.PI/4);
  if(mRx>1.5){
    const rightFront=fc>0.05, leftFront=fc<-0.05;
    ctx.globalAlpha=0.28*headAlpha;
    ctx.beginPath();
    if(rightFront)     ctx.ellipse(0,0,mRx,headR,0,-Math.PI/2, Math.PI/2);
    else if(leftFront) ctx.ellipse(0,0,mRx,headR,0, Math.PI/2,3*Math.PI/2);
    else               ctx.ellipse(0,0,mRx,headR,0,0,TAU);
    ctx.stroke();
    if(rightFront||leftFront){
      ctx.globalAlpha=0.10*headAlpha;
      ctx.beginPath();
      if(rightFront) ctx.ellipse(0,0,mRx,headR,0, Math.PI/2,3*Math.PI/2);
      else           ctx.ellipse(0,0,mRx,headR,0,-Math.PI/2, Math.PI/2);
      ctx.stroke();
    }
  } else {
    ctx.globalAlpha=0.28*headAlpha;
    ctx.beginPath();ctx.moveTo(0,-headR);ctx.lineTo(0,headR);ctx.stroke();
  }
}
ctx.restore();
};

// Near arm depth-ordered against head: draw whichever is farther first, closer one last (on top).
const nearArmDepth=armFrontCloser ? fArmDepth : bArmDepth;
if(nearArmDepth>headDepth) drawHead();
segG(nShoX,nShoY, nE.x,nE.y,   tNearArm,   tNearElbow, sc('arms'));
segG(nE.x,nE.y,   nH.x,nH.y,   tNearElbow, tNearHand,  sc('arms'));
dot(nShoX,nShoY,tNearArm,sc('arms'));
dot(nE.x,nE.y,tNearElbow,sc('arms'));
dot(nH.x,nH.y,tNearHand,sc('arms'),1.35);
if(nearArmDepth<=headDepth) drawHead();
ctx.restore();
}

// ── Colour palettes ───────────────────────────────────────────────────────────
const FIG_COLORS = [
{name:'Ink',    stroke:'#2A2318',fill:'rgba(42,35,24,0.06)'},
{name:'Pencil', stroke:'#5A5048',fill:'rgba(90,80,72,0.06)'},
{name:'Blue',   stroke:'#3A6090',fill:'rgba(58,96,144,0.06)'},
{name:'Purple', stroke:'#6B40A8',fill:'rgba(107,64,168,0.06)'},
{name:'Sienna', stroke:'#8B5030',fill:'rgba(139,80,48,0.06)'},
{name:'Forest', stroke:'#3D6B40',fill:'rgba(61,107,64,0.06)'},
{name:'Rasta',  stroke:'#2E7D32',fill:'rgba(26,26,26,0.06)',
 parts:{head:'#1A1A1A',feet:'#1A1A1A',legs:'#2E7D32',body:'#E8A020',arms:'#B91C1C'}},
{name:'Matrix',  stroke:'#00CC33',fill:'rgba(0,204,51,0.08)'},
{name:'Crimson', stroke:'#CC0055',fill:'rgba(204,0,85,0.08)'},
];
// BG colors: paper and animation-desk tones. light:true = use dark ink overlay text.
const BG_COLORS = [
{name:'Paper',     bg:'#F4EFE4',light:true},
{name:'Cel',       bg:'#F8F6F0',light:true},
{name:'Aged',      bg:'#EDE5C8',light:true},
{name:'Blueprint', bg:'#D4DFE8',light:true},
{name:'Dark',      bg:'#1A1815',light:false},
{name:'Blush',     bg:'#FDE4F0',light:true},
];
const KEY_POSES = [
{key:'contact',label:'Contact',phase:TAU*0.25,color:'#3B82F6',fill:'rgba(59,130,246,0.08)'},
{key:'down',   label:'Down',   phase:TAU*0.42,color:'#D97706',fill:'rgba(217,119,6,0.08)'},
{key:'passing',label:'Passing',phase:TAU*0.5, color:'#059669',fill:'rgba(5,150,105,0.08)'},
{key:'up',     label:'Up',     phase:TAU*0.75,color:'#DC2626',fill:'rgba(220,38,38,0.08)'},
];

// ── Guinea pig easter egg ─────────────────────────────────────────────────────
// Uses a single continuous bezier path for the body+head silhouette so it looks
// like one organic shape rather than overlapping circles.
// Origin placed at ground level below the pig. ctx.scale(dir*s, s) handles
// direction flip and overall size in one step.
function drawGuineaPig(ctx, cx, groundY, phase, dir, legLen, img) {
const hue = (Date.now() / 12) % 360;
const t = ((phase % TAU) + TAU) % TAU;
const s = Math.max(0.5, Math.min(1.6, (legLen || 68) / 68));
const bob = Math.sin(t * 2) * 3;

ctx.save();
ctx.translate(cx, groundY + bob);
ctx.scale(dir * s, s);
ctx.lineCap = 'round'; ctx.lineJoin = 'round';

// ── LEGS (drawn first so body covers their tops) ────────────────────────────
const legXs = [-32, -17, -2, 12];
const legPO = [0, Math.PI, Math.PI, 0];
ctx.strokeStyle = '#111'; ctx.lineWidth = 6;
legXs.forEach((lx, i) => {
  const sw = Math.sin(t + legPO[i]) * 4;
  ctx.beginPath(); ctx.moveTo(lx, -6); ctx.lineTo(lx + sw, 6); ctx.stroke();
  ctx.fillStyle = '#111';
  ctx.beginPath(); ctx.ellipse(lx + sw, 6, 6, 3, 0, 0, TAU); ctx.fill();
});

if (img) {
  const iw = 100, ih = 63;
  ctx.filter = `sepia(1) saturate(4) hue-rotate(${hue - 30}deg) brightness(0.85)`;
  // PNG faces left — flip horizontally in local space before drawing
  ctx.save();
  ctx.scale(-1, 1);
  ctx.drawImage(img, -50, -ih, iw, ih);
  ctx.restore();
  ctx.filter = 'none';
} else {
  // fallback bezier silhouette
  const bodyColor = `hsl(${hue}, 70%, 45%)`;
  ctx.fillStyle = bodyColor; ctx.strokeStyle = bodyDark; ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(32, -10);
  ctx.bezierCurveTo(38,-14, 43,-26, 42,-36);
  ctx.bezierCurveTo(44,-44, 40,-56, 30,-60);
  ctx.bezierCurveTo(20,-66,  6,-65,  -2,-58);
  ctx.bezierCurveTo(-8,-53, -11,-45, -12,-40);
  ctx.bezierCurveTo(-16,-40, -28,-38, -36,-33);
  ctx.bezierCurveTo(-44,-27, -46,-16, -44,-7);
  ctx.bezierCurveTo(-42, 3,  -34, 6,  -24,  4);
  ctx.bezierCurveTo( -8,-1,   16,-3,   32,-10);
  ctx.closePath(); ctx.fill(); ctx.stroke();
}

ctx.restore();
}

// ── Full frame render ─────────────────────────────────────────────────────────
function renderFrame(canvas, rawPhase, cx, p, st, opts={}) {
const {forExport=false,transparent=false,keyPoseState=null,onion=null,marsvinMode=false,marsvinImg=null} = opts;
const ctx = canvas.getContext('2d');
const dpr = canvas.width / W;
ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
const col = FIG_COLORS[st.figureIdx], bg = BG_COLORS[st.bgIdx];
const dir = st.flipDir ? -1 : 1, light = bg.light !== false;
const T_r = THEMES[st.themeIdx || 0];
const _lc = '#E6E6E6';
let drawCol = col;
if (!bg.light) {
  if (isDark(col.stroke)) {
    drawCol = {...col, stroke:_lc, fill:'rgba(230,230,230,0.06)',
      ...(col.parts ? {parts:Object.fromEntries(Object.entries(col.parts).map(([k,v])=>[k,isDark(v)?_lc:v]))} : {})};
  } else if (col.parts) {
    let _chg=false; const _np={};
    for(const [k,v] of Object.entries(col.parts)){if(isDark(v)){_np[k]=T_r.border;_chg=true;}else _np[k]=v;}
    if(_chg) drawCol={...col,parts:_np};
  }
}
const N = cycLen(p.fps, p.speed), snapStep = TAU/N*p.animOn;
const snappedRaw = Math.round(rawPhase/snapStep)*snapStep;
const tN = ((snappedRaw%TAU)+TAU)%TAU/TAU;
const phase = applyFeel(tN, p.feel)*TAU;

ctx.clearRect(0,0,W,H);
if(marsvinMode){ctx.fillStyle=`hsl(${(Date.now()/12)%360},100%,85%)`;ctx.fillRect(0,0,W,H);}
else if(!transparent){ctx.fillStyle=bg.bg; ctx.fillRect(0,0,W,H);}

if(st.showGrid&&!forExport){
ctx.strokeStyle=light?'rgba(0,0,0,0.07)':'rgba(255,255,255,0.07)'; ctx.lineWidth=1;
for(let x=0;x<=W;x+=20){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();}
for(let y=0;y<=H;y+=20){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();}
ctx.strokeStyle=light?'rgba(0,0,0,0.15)':'rgba(255,255,255,0.15)'; ctx.setLineDash([4,4]);
ctx.beginPath();ctx.moveTo(cx,0);ctx.lineTo(cx,H);ctx.stroke();
ctx.beginPath();ctx.moveTo(0,GY);ctx.lineTo(W,GY);ctx.stroke();
ctx.setLineDash([]);
}
ctx.globalAlpha=1; ctx.strokeStyle=light?'rgba(0,0,0,0.28)':'rgba(255,255,255,0.2)'; ctx.lineWidth=1.5;
ctx.beginPath();ctx.moveTo(0,GY);ctx.lineTo(W,GY);ctx.stroke();
if(!forExport){
const tc=light?'rgba(0,0,0,0.22)':'rgba(255,255,255,0.18)';
if(st.tickMode==='ruler'){
  // Ruler: 10 minor ticks per metre, every 10th tick is a major mark.
  // 1 metre ≈ legLen/0.8 px (floor-to-hip ≈ 0.8 m in character scale).
  const minorSp=Math.max(3,Math.round(p.legLen/8));  // legLen/0.8 / 10 = legLen/8
  ctx.strokeStyle=tc;
  // Centre a major tick at W/2 (ruler origin = character start position).
  const iStart=Math.floor(-W/2/minorSp)-1;
  const iEnd=Math.ceil(W/2/minorSp)+1;
  for(let i=iStart;i<=iEnd;i++){
    const x=W/2+i*minorSp;
    if(x<-minorSp||x>W+minorSp) continue;
    const isMajor=i%10===0;
    ctx.lineWidth=isMajor?1.5:0.8;
    ctx.beginPath();ctx.moveTo(x,GY);ctx.lineTo(x,GY+(isMajor?10:4));ctx.stroke();
  }
} else {
  const sl=p.stepLength;
  const sp=Math.max(6, st.loco==='walk' ? sl*2 : sl);
  const rawOff=st.loco==='walk' ? W/2 : W/2 + sl*dir*(0.5 - phase/Math.PI);
  const off=((rawOff%sp)+sp)%sp;
  ctx.strokeStyle=tc; ctx.lineWidth=1.5;
  for(let x=off-sp;x<W+sp;x+=sp){ctx.beginPath();ctx.moveTo(x,GY);ctx.lineTo(x,GY+8);ctx.stroke();}
}
}
if(st.showShadow){
const bob=Math.abs(Math.sin(phase))*p.bounce, sw=Math.max(p.legLen*0.55-bob*0.3,12);
ctx.save();ctx.globalAlpha=0.18;ctx.fillStyle=drawCol.stroke;
ctx.beginPath();ctx.ellipse(cx,GY+4,sw,5,0,0,TAU);ctx.fill();ctx.restore();
}
if(st.footDots&&!forExport){
ctx.save();
[[phase,'rgba(96,165,250,0.8)'],[phase+Math.PI,'rgba(248,113,113,0.8)']].forEach(([lp,c])=>{
const lift=Math.max(0,Math.cos(lp))*p.kneeLift;
if(lift<4){ctx.globalAlpha=(1-lift/4)*0.9;ctx.fillStyle=c;ctx.beginPath();ctx.arc(cx+Math.sin(lp)*p.stepLength*dir,GY,4,0,TAU);ctx.fill();}
});
ctx.restore();
}
if(!marsvinMode){
if(onion?.on&&!forExport){
for(let i=onion.count;i>=1;i--){
const pN2=((snappedRaw-i*snapStep)%TAU+TAU)%TAU/TAU;
const oPh=applyFeel(pN2,p.feel)*TAU;
drawFigure(ctx,computePose(oPh,cx,p,dir),p,{stroke:'#60A5FA',fill:'rgba(96,165,250,0.04)'},dir,oPh,0.22*(onion.count-i+1)/onion.count);
}
for(let i=1;i<=onion.count;i++){
const pN2=((snappedRaw+i*snapStep)%TAU+TAU)%TAU/TAU;
const oPh=applyFeel(pN2,p.feel)*TAU;
drawFigure(ctx,computePose(oPh,cx,p,dir),p,{stroke:'#F59E0B',fill:'rgba(245,158,11,0.04)'},dir,oPh,0.22*(onion.count-i+1)/onion.count);
}
}
if(keyPoseState&&!forExport)
KEY_POSES.forEach(kp=>{if(keyPoseState[kp.key]) drawFigure(ctx,computePose(kp.phase,cx,p,dir),p,{stroke:kp.color,fill:kp.fill},dir,kp.phase,0.45);});
const gc=forExport?0:(p.ghostTrail|0);
for(let g=gc;g>=1;g--){
const pN2=((snappedRaw-g*0.28)%TAU+TAU)%TAU/TAU;
const gPh=applyFeel(pN2,p.feel)*TAU;
drawFigure(ctx,computePose(gPh,cx,p,dir),p,drawCol,dir,gPh,0.28*(gc-g+1)/gc);
}
drawFigure(ctx,computePose(phase,cx,p,dir),p,drawCol,dir,phase);
} else {
drawGuineaPig(ctx,cx,GY,phase,dir,p.legLen,marsvinImg);
}
{
const norm=((snappedRaw%TAU)+TAU)%TAU;
const frameN=Math.min(Math.floor(norm/TAU*N)+1,N);
const totalDrw=Math.ceil(N/p.animOn), drwN=Math.min(Math.ceil(frameN/p.animOn),totalDrw);
const l1=p.animOn===1?`Fr ${frameN} / ${N}`:`Fr ${frameN} / ${N}  (Drw ${drwN} / ${totalDrw})`;
const l2=`${N} fr · ${(N/p.fps).toFixed(2)}s @ ${p.fps}fps`;
const l3=`${(p.stepLength*p.speed*5/24).toFixed(1)} km/h`;
ctx.save(); ctx.font='bold 10px Courier New'; const tw1=ctx.measureText(l1).width;
ctx.font='9px Courier New'; const tw2=ctx.measureText(l2).width; const tw3=ctx.measureText(l3).width;
const bw=Math.max(tw1,tw2,tw3)+16,bh=44,bx=W-bw-6,by=6;
ctx.fillStyle=forExport?(transparent?'rgba(0,0,0,0.55)':light?'rgba(244,239,228,0.94)':'rgba(18,16,14,0.88)')
                       :light?'rgba(244,239,228,0.94)':'rgba(18,16,14,0.88)';
ctx.beginPath();ctx.roundRect(bx,by,bw,bh,3);ctx.fill();
ctx.fillStyle=forExport?(transparent?'#ffffff':light?'#2A2318':'#E8DCC8'):light?'#2A2318':'#E8DCC8';
ctx.textAlign='left'; ctx.textBaseline='top';
ctx.font='bold 10px Courier New'; ctx.fillText(l1,bx+8,by+5);
ctx.fillStyle=forExport?(transparent?'rgba(255,255,255,0.75)':light?'#6B5E4A':'#8A7C6A'):light?'#6B5E4A':'#8A7C6A';
ctx.font='9px Courier New'; ctx.fillText(l2,bx+8,by+19);
ctx.fillText(l3,bx+8,by+31);
ctx.restore();
}
}

// ── Timing / spacing chart ────────────────────────────────────────────────────
// Shows how frames are distributed across each body part's motion path.
// Dense dots = moving slowly (dwelling at that pose).
// Sparse dots = moving quickly through.
// Filled dot = drawing frame; hollow = held frame (on 2s).
function drawTimingChart(canvas, p, currentPhase) {
const ctx=canvas.getContext('2d'); const cw=canvas.width,ch=canvas.height;
ctx.clearRect(0,0,cw,ch); ctx.fillStyle='#EAE4D4'; ctx.fillRect(0,0,cw,ch);
const N=cycLen(p.fps,p.speed);
const curFrame = currentPhase !== undefined
  ? Math.round(((currentPhase % TAU) + TAU) % TAU / TAU * N) % N
  : -1;
const laneH=22,gap=5,padX=34,padY=4,padR=8,chartW=cw-padX-padR;
const bodyVals=[],footVals=[],armVals=[];
for(let i=0;i<N;i++){
const te=applyFeel(i/N,p.feel),ph=te*TAU;
const k=Math.min(0.98,Math.abs(Math.sin(ph))*p.stepLength/Math.max(p.legLen,1));
bodyVals.push(p.legLen*(1-Math.sqrt(1-k*k))*(1+p.bounce*0.10));
footVals.push(Math.max(0,Math.cos(ph))*p.kneeLift);
armVals.push(Math.sin(ph+Math.PI)*Math.asin(Math.min(p.armSwing/Math.max(p.armLen,1),0.95)));
}
const norm=arr=>{const mn=Math.min(...arr),mx=Math.max(...arr);return arr.map(v=>mx===mn?0.5:(v-mn)/(mx-mn));};
const lanes=[
{label:'Body',data:norm(bodyVals),invert:true, color:'#4A6FA5'},
{label:'Foot',data:norm(footVals),invert:false,color:'#3D8B6A'},
{label:'Arm', data:norm(armVals), invert:false,color:'#C07830'},
];
const totalH=lanes.length*(laneH+gap);
if(curFrame>=0){
const curX=padX+(curFrame+0.5)/N*chartW;
ctx.fillStyle='rgba(0,0,0,0.10)'; ctx.fillRect(curX-0.5,padY,1,totalH+4);
}
lanes.forEach(({label,data,invert,color},li)=>{
const baseY=padY+li*(laneH+gap),trackY=baseY+10,trackH=laneH-10;
ctx.fillStyle='#6B5E4A'; ctx.font='8px Courier New'; ctx.textAlign='right';
ctx.fillText(label,padX-5,trackY+trackH/2+3);
ctx.fillStyle='#D8D0BC'; ctx.fillRect(padX,trackY,chartW,trackH);
ctx.beginPath();
for(let i=0;i<N;i++){
const x=padX+(i+0.5)/N*chartW, n=invert?1-data[i]:data[i], y=trackY+2+(1-n)*(trackH-4);
i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
}
ctx.strokeStyle=color+'50'; ctx.lineWidth=1; ctx.stroke();
for(let i=0;i<N;i++){
const x=padX+(i+0.5)/N*chartW, n=invert?1-data[i]:data[i], y=trackY+2+(1-n)*(trackH-4);
const isDrw=i%p.animOn===0;
const isCur=i===curFrame;
if(isCur){ctx.beginPath();ctx.arc(x,y,5,0,TAU);ctx.fillStyle='white';ctx.fill();}
ctx.beginPath(); ctx.arc(x,y,isCur?3:isDrw?2.5:1.5,0,TAU);
if(isDrw||isCur){ctx.fillStyle=isCur?color:color;ctx.fill();}
else{ctx.strokeStyle=color+'70';ctx.lineWidth=0.8;ctx.stroke();}
}
});
const axY=padY+lanes.length*(laneH+gap)+4;
ctx.fillStyle='#9A8C7C'; ctx.font='7px Courier New'; ctx.textAlign='center';
[0,Math.round(N/4),Math.round(N/2),Math.round(3*N/4),N-1].forEach(i=>{
ctx.fillText(i+1,padX+(i+0.5)/N*chartW,axY+8);
});
if(p.animOn>1){
ctx.fillStyle='#9A8C7C'; ctx.font='7px Courier New'; ctx.textAlign='right';
ctx.fillText('● drawing  ○ held',cw-4,ch-2);
}
}

// ── Slider definitions per tab ────────────────────────────────────────────────
const TAB_SLIDERS = {
body:[
{key:'legLen', label:'Leg Length', min:35, max:110, step:1, unit:'px',
 expand:[
   {key:'legRatio', label:'Thigh / Shin', min:-15, max:15, step:1, unit:'%',
    hint:'+ = longer thigh · − = longer shin'},
 ]},
{key:'armLen',        label:'Arm Length',     min:20,  max:80, step:1,   unit:'px',
 expand:[
   {key:'armRaise', label:'Arm Raise',    min:0,   max:180, step:1, unit:'°', hint:'Raises arms sideways · 90° T-pose · 180° above head'},
   {key:'armRatio', label:'Upper / Fore', min:-15, max:15,  step:1, unit:'%', hint:'+ = longer upper arm · − = longer forearm'},
 ]},
{key:'torsoLen',      label:'Torso',          min:20,  max:80, step:1,   unit:'px'},
{key:'headSize', label:'Head Size', min:8, max:30, step:1, unit:'px',
 expand:[
   {key:'headAngle', label:'Neck Angle', min:-30, max:30, step:1, unit:'°',
    hint:'0 = straight up · + = tilts forward · − = tilts back'},
 ]},
{key:'footSize',      label:'Foot Size',      min:0,   max:22, step:1,   unit:'px'},
{key:'lineWidth',     label:'Line Weight',    min:1,   max:8,  step:0.5, unit:'px'},
{key:'hipSway',       label:'Hip Width',      min:0,   max:16, step:0.5, unit:'px'},
{key:'shoulderWidth', label:'Shoulder Width', min:0,   max:16, step:0.5, unit:'px'},
],
walk:[
{key:'speed',     label:'Speed',       min:0.2,max:3,  step:0.05,unit:'×'},
{key:'stepLength',label:'Step Length', min:0,  max:55, step:1,   unit:'px', computeMax:p=>Math.floor(p.legLen*0.97),
 expand:[
   {key:'stepWidth', label:'Step Width', min:0, max:20, step:0.5, unit:'px', hint:'Lateral foot spread'},
 ]},
{key:'kneeLift',  label:'Knee Lift',   min:0,  max:100,step:1,   unit:'%'},
{key:'footLift',  label:'Foot Lift',   min:0,  max:1,  step:0.05,unit:''},
{key:'bounce',    label:'Bounce',      min:0,  max:20, step:0.5, unit:''},
{key:'armSwing',  label:'Arm Swing',   min:0,  max:50, step:1,   unit:'px',
 expand:[
   {key:'armDirection', label:'Direction', min:0,   max:20,  step:1,   unit:'px',  hint:'Arms follow shoulder rotation — higher values angle forearms toward body center'},
   {key:'armDelay',     label:'Follow',    min:-45, max:45,  step:1,   unit:'°',   hint:'Arms lead (−) or follow (+) body'},
   {key:'armEase',      label:'Ease',      min:0.3, max:3.0, step:0.1, unit:'×',   hint:'< 1 = crisp · 1 = natural · > 1 = heavy'},
 ]},
{key:'heelToe',   label:'Toe/Heel',    min:-1, max:1,  step:0.05,unit:''},
],
style:[
{key:'leanAngle',    label:'Lean',          min:-25,max:25, step:1,  unit:'°'},
{key:'bodyTilt',     label:'Body Tilt',      min:0,  max:22, step:0.5,unit:'°',
 expand:[
   {key:'bodyTiltDelay', label:'Follow', min:-45, max:45,  step:1,   unit:'°', hint:'Tilt leads (−) or follows (+) body'},
   {key:'bodyTiltEase',  label:'Ease',   min:0.3, max:3.0, step:0.1, unit:'×', hint:'< 1 = crisp · 1 = natural · > 1 = heavy'},
 ]},
{key:'spineBend',    label:'Spine Curve',    min:0,  max:50, step:1,  unit:'px',
 expand:[
   {key:'spineDir', label:'Direction', min:-10, max:10, step:0.5, unit:'',
    hint:'0 = arches both ways · + = forward arch only · − = backward arch only'},
 ]},
{key:'legBend',      label:'Leg Bend',       min:-15,max:28, step:1,  unit:'px'},
{key:'armBend',      label:'Arm Bend',       min:0,  max:60, step:1,  unit:'°'},
{key:'headBob',      label:'Head Bob',       min:0,  max:14, step:0.5,unit:'px'},
{key:'headPendulum', label:'Head Swing',     min:0,  max:18, step:0.5,unit:'px',
 expand:[
   {key:'headDelay', label:'Follow', min:-30, max:30, step:1, unit:'°', hint:'Head leads (−) or follows (+) body'},
 ]},
{key:'ghostTrail',   label:'Ghost Trail',    min:0,  max:6,  step:1,  unit:''},
],
};

// ── System presets ────────────────────────────────────────────────────────────
const SYSTEM_PRESETS = {
Normal:  {speed:2.4, bounce:4,  armSwing:8, stepLength:24,kneeLift:25,torsoLen:45,legLen:70,armLen:54,headSize:14,footSize:10,lineWidth:3,legBend:4,  armBend:15,leanAngle:2, bodyTilt:1, hipSway:7,  shoulderWidth:10, headBob:0,headPendulum:1, footLift:0.1,heelToe:0.8, feel:0.5,viewAngle:0},
March:   {speed:1.3, bounce:13, armSwing:36,stepLength:20,kneeLift:55,torsoLen:46,legLen:68,armLen:46,headSize:14,lineWidth:3,  legBend:5,  armBend:30,leanAngle:3, bodyTilt:6, hipSway:0,  shoulderWidth:0,  headBob:4,headPendulum:0, heelToe:1.0, feel:0.6},
Sneak:   {speed:0.55,bounce:3,  armSwing:10,stepLength:14,kneeLift:35,torsoLen:36,legLen:68,armLen:46,headSize:14,lineWidth:3,  legBend:18, armBend:40,leanAngle:20,bodyTilt:5, hipSway:2,  shoulderWidth:2,  headBob:0,headPendulum:7, heelToe:-0.7,feel:0.3},
Strut:   {speed:0.75,bounce:18, armSwing:28,stepLength:32,kneeLift:10,torsoLen:44,legLen:68,armLen:46,headSize:14,lineWidth:3,  legBend:4,  armBend:20,leanAngle:-6,bodyTilt:11,hipSway:11, shoulderWidth:8,  headBob:5,headPendulum:6, heelToe:0.4, feel:0.7},
Robot:   {speed:0.7, bounce:0,  armSwing:20,stepLength:22,kneeLift:35,torsoLen:44,legLen:68,armLen:46,headSize:14,lineWidth:2,  legBend:0,  armBend:0, leanAngle:0, bodyTilt:0, hipSway:0,  shoulderWidth:0,  headBob:0,headPendulum:0, heelToe:1.0, feel:0.0},
Toddler: {speed:1.1, bounce:16, armSwing:14,stepLength:14,kneeLift:25,torsoLen:30,legLen:48,armLen:32,headSize:20,lineWidth:3,  legBend:8,  armBend:28,leanAngle:5, bodyTilt:8, hipSway:6,  shoulderWidth:5,  headBob:6,headPendulum:4, heelToe:0.2, feel:0.5},
};

// ── Defaults ──────────────────────────────────────────────────────────────────
const DEF_PARAMS = {
legLen:70,armLen:54,torsoLen:45,headSize:14,footSize:10,lineWidth:3,
legBend:4,armBend:15,legRatio:0,armRatio:0,armRaise:0,armDirection:0,armDelay:0,armEase:1,bodyTiltDelay:0,bodyTiltEase:1,spineBend:0,spineDir:0,
speed:2.4,stepLength:24,stepWidth:7,kneeLift:25,footLift:0.1,bounce:4,armSwing:8,heelToe:0.8,
leanAngle:2,bodyTilt:1,hipSway:7,shoulderWidth:10,headBob:0,headPendulum:1,headAngle:0,headDelay:0,ghostTrail:0,
fps:24,animOn:1,feel:0.5,viewAngle:0,
};
const DEF_STYLE = {figureIdx:0,bgIdx:0,showGrid:false,showShadow:false,footDots:false,flipDir:false,loco:'place',themeIdx:0,tickMode:'step'};
// figureIdx:0 = Ink (dark, readable on paper)   bgIdx:0 = Paper (warm cream)

// ── Storage helpers ───────────────────────────────────────────────────────────
const store = {
async get(k){try{return await window.storage.get(k);}catch{return null;}},
async set(k,v){try{return await window.storage.set(k,v);}catch{return null;}},
async del(k){try{return await window.storage.delete(k);}catch{return null;}},
async list(pfx){try{return await window.storage.list(pfx);}catch{return {keys:[]};}},
};

// ── Preset thumbnail ──────────────────────────────────────────────────────────
function makeThumbnail(params, style) {
try {
const off = document.createElement('canvas'); off.width=W; off.height=H;
renderFrame(off, TAU*0.5, W/2, params, style, {forExport:true});
const th = document.createElement('canvas'); th.width=120; th.height=80;
th.getContext('2d').drawImage(off,0,0,120,80);
return th.toDataURL('image/jpeg',0.75);
} catch{return null;}
}

// ── Theme palettes ────────────────────────────────────────────────────────────
// Each theme carries its own identity (title, fonts) and auto-applies canvas/figure.
const THEMES = [
{ // 0 — Silly Walks Studio (default)
  title:"Seb's Silly Walks Studio",
  subtitle:"ITS JUST A 2D ANIMATION REFERENCE TOOL",
  titleFont:"'Rye', 'Georgia', serif",
  titleSize:19,
  subtitleFont:"'Courier New', monospace",
  tabIcons:{body:'⊙',walk:'≋',style:'✦',timing:'◷',presets:'⊟'},
  defaultBgIdx:0, defaultFigIdx:0,
  paper:'#F4EFE4',paperDk:'#E8E2D2',paperLt:'#FAF8F3',
  border:'#C8B99A',borderLt:'#DDD5C0',
  ink:'#2A2318',ink2:'#574A38',ink3:'#7A6C5C',ink4:'#9E9080',
  blue:'#4A6FA5',red:'#B84040',amber:'#C07830',
},
{ // 1 — NeuroPrancer Nexus (cyberpunk)
  title:"Seb's NeuroPrancer Nexus",
  subtitle:"ITS JUST A GLITCH IN THE WALKCYCLE",
  titleFont:"'Orbitron', 'Courier New', monospace",
  titleSize:13,
  subtitleFont:"'Courier New', monospace",
  tabIcons:{body:'⬡',walk:'⊳',style:'⌬',timing:'⧗',presets:'≣'},
  defaultBgIdx:4, defaultFigIdx:7,  // Dark canvas, Matrix green figure
  paper:'#080D08',paperDk:'#050905',paperLt:'#0C140C',
  border:'#1A4A1A',borderLt:'#2A6A2A',
  ink:'#00FF41',ink2:'#00CC33',ink3:'#008822',ink4:'#004A14',
  blue:'#00FFCC',red:'#FF0044',amber:'#CCFF00',
},
{ // 2 — Sassy Sashay Salon
  title:"Seb's Sassy Sashay Salon",
  subtitle:"ITS JUST A SLUTTY STRUT CLUB",
  titleFont:"'Righteous', cursive",
  titleSize:18,
  subtitleFont:"'Courier New', monospace",
  tabIcons:{body:'💄',walk:'👠',style:'🍸',timing:'💃',presets:'💅'},
  defaultBgIdx:5, defaultFigIdx:8,  // Blush canvas, Crimson figure
  paper:'#FFF0F8',paperDk:'#FFD6EC',paperLt:'#FFF8FC',
  border:'#E8509A',borderLt:'#F4A0C8',
  ink:'#880030',ink2:'#CC0055',ink3:'#E0609A',ink4:'#F0A0C0',
  blue:'#CC0066',red:'#FF0044',amber:'#FF8800',
},
];
function ha(hex, a) { // hex or hsl + alpha → rgba/hsla string
if(typeof hex==='string'&&hex.startsWith('hsl(')) return hex.replace('hsl(','hsla(').replace(')',`,${a})`);
const [r,g,b]=hex.match(/\w\w/g).map(x=>parseInt(x,16)); return `rgba(${r},${g},${b},${a})`;
}

// ── SVG theme icons — each carries its own theme colours so they preview correctly ──
const IconThemeDefault = () => (
<svg width="22" height="22" viewBox="0 0 24 24">
  <circle cx="12" cy="12" r="11" fill="#F4EFE4" stroke="#C8B99A" strokeWidth="1"/>
  <g fill="none" stroke="#2A2318" strokeWidth="1.6" strokeLinecap="round">
    <circle cx="12" cy="12" r="3.5"/>
    <line x1="12" y1="3.5" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="20.5"/>
    <line x1="4.9" y1="4.9" x2="6.7" y2="6.7"/><line x1="17.3" y1="17.3" x2="19.1" y2="19.1"/>
    <line x1="3.5" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="20.5" y2="12"/>
    <line x1="4.9" y1="19.1" x2="6.7" y2="17.3"/><line x1="17.3" y1="6.7" x2="19.1" y2="4.9"/>
  </g>
</svg>);
const IconThemeCyber = () => (
<svg width="22" height="22" viewBox="0 0 24 24">
  <circle cx="12" cy="12" r="11" fill="#080D08" stroke="#1A4A1A" strokeWidth="1"/>
  <g fill="none" stroke="#00FF41" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 5.5a5.5 5.5 0 0 0-5.5 5.5c0 2 1 3.8 2.5 4.8V18h6v-2.2c1.5-1 2.5-2.8 2.5-4.8A5.5 5.5 0 0 0 12 5.5z"/>
    <line x1="9.5" y1="18" x2="14.5" y2="18"/>
    <circle cx="10" cy="11.5" r="1.2" fill="#00FF41"/>
    <circle cx="14" cy="11.5" r="1.2" fill="#00FF41"/>
  </g>
</svg>);
const IconThemeSassy = () => (
<svg width="22" height="22" viewBox="0 0 24 24">
  <circle cx="12" cy="12" r="11" fill="#FFF0F8" stroke="#E8509A" strokeWidth="1"/>
  <path d="M12 18.5l-6.5-6.5a4.2 4.2 0 0 1 6.5-5.2 4.2 4.2 0 0 1 6.5 5.2z" fill="#CC0055" stroke="none"/>
  <path d="M8 17.5c1-1.5 2.5-1.5 4-1 1.5.5 3 .5 4-1" fill="none" stroke="#FF85AF" strokeWidth="0.8" strokeLinecap="round"/>
</svg>);
const THEME_ICONS = [<IconThemeDefault/>, <IconThemeCyber/>, <IconThemeSassy/>];

// ── Shared UI helpers ─────────────────────────────────────────────────────────
function SliderGrid({sliders, params, onChange, expanded, onToggle}) {
// Flatten slider list, inserting expanded sub-sliders after their parent
const items = [];
sliders.forEach(s => {
  items.push(s);
  if (s.expand && expanded?.has(s.key)) {
    s.expand.forEach(sub => items.push({...sub, _child: true, _parentKey: s.key}));
  }
});
return (
<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'6px 16px'}}>
{items.map(s=>(
<div key={s.key} style={{display:'flex',flexDirection:'column',gap:2,
  ...(s._child ? {gridColumn:'span 2', paddingLeft:16, borderLeft:'2px solid var(--border-lt)', marginTop:-4} : {})}}>
<div style={{display:'flex',justifyContent:'space-between',fontSize:s._child?9:10,
letterSpacing:'0.07em',color:'var(--ink2)'}}>
  <div style={{display:'flex',alignItems:'center',gap:4}}>
    {s._child && <span style={{color:'var(--ink4)',fontSize:9,marginRight:1}}>↳</span>}
    <span style={{textTransform:'uppercase'}}>{s.label}</span>
    {s.expand && (
      <button onClick={()=>onToggle(s.key)} style={{
        background:expanded?.has(s.key)?'var(--blue)':'transparent',
        border:`1px solid ${expanded?.has(s.key)?'var(--blue)':'var(--border)'}`,
        color:expanded?.has(s.key)?'var(--paper)':'var(--ink3)',
        borderRadius:2,padding:'0 5px',cursor:'pointer',
        fontSize:9,lineHeight:'14px',fontFamily:'inherit',userSelect:'none',flexShrink:0}}>
        {expanded?.has(s.key)?'−':'+'}
      </button>
    )}
  </div>
  <span style={{color:'var(--ink3)'}}>{params[s.key]}{s.unit}</span>
</div>
<input type="range" min={s.min} max={s.computeMax?s.computeMax(params):s.max} step={s.step} value={params[s.key]??0}
onChange={e=>onChange(s.key,+e.target.value)}/>
{s.hint && <div style={{fontSize:8,color:'var(--ink4)',marginTop:1,fontStyle:'italic'}}>{s.hint}</div>}
</div>
))}
</div>
);
}

// ── View angle indicator — top-down schematic showing camera position ─────────
function ViewAngleIndicator({ angle, T }) {
const va = (angle||0) * Math.PI / 180;
const cx=24, cy=24, R=17;
const camX=cx+R*Math.cos(va), camY=cy-R*Math.sin(va);
const dx=cx-camX, dy=cy-camY, len=Math.sqrt(dx*dx+dy*dy)||1;
const tipX=camX+(dx/len)*(R-8), tipY=camY+(dy/len)*(R-8);
return (
<svg width="48" height="48" viewBox="0 0 48 48" style={{flexShrink:0,opacity:0.9}}>
  <circle cx={cx} cy={cy} r={R} fill="none" stroke={T.ink3} strokeWidth="0.6" strokeDasharray="2,3"/>
  <ellipse cx={cx} cy={cy} rx={4} ry={6} fill={T.ink} fillOpacity="0.1" stroke={T.ink} strokeWidth="1.2" strokeOpacity="0.5"/>
  <circle cx={cx} cy={cy-8} r={1.8} fill={T.ink} fillOpacity="0.45"/>
  <circle cx={camX} cy={camY} r={3} fill={T.blue}/>
  <line x1={camX} y1={camY} x2={tipX} y2={tipY} stroke={T.blue} strokeWidth="1.5" strokeOpacity="0.55"/>
</svg>
);
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function WalkCycleTool() {
const canvasRef   = useRef(null);
const chartRef    = useRef(null);
const animRef     = useRef(null);
const phaseRef    = useRef(0);
const walkXRef    = useRef(W/2);
const lastTRef    = useRef(null);
const live        = useRef({});
const scrubRef    = useRef(null);
const scrubBarRef = useRef(null);
const scrubDrag   = useRef(false);

const [params,      setParams]      = useState(DEF_PARAMS);
const [style,       setStyle]       = useState(DEF_STYLE);
const [tab,         setTab]         = useState('walk');
const [playback,    setPlayback]    = useState('forward');
const [keyPoses,    setKeyPoses]    = useState({contact:false,down:false,passing:false,up:false});
const [onionOn,     setOnionOn]     = useState(false);
const [onionCount,  setOnionCount]  = useState(2);
const [exporting,   setExporting]   = useState(false);
const [expPct,      setExpPct]      = useState(0);
const [expRes,      setExpRes]      = useState(1);
const [expTrans,    setExpTrans]    = useState(false);
const [expAspect,   setExpAspect]   = useState('3:2');
const [downloadReady, setDownloadReady] = useState(null);
const [userPresets,   setUserPresets]   = useState([]);
const [savingPre,     setSavingPre]     = useState(false);
const [saveName,      setSaveName]      = useState('');
const [activePreset,  setActivePreset]  = useState(null);
const [importCode,    setImportCode]    = useState('');
const [importErr,     setImportErr]     = useState(false);
const [copyMsg,       setCopyMsg]       = useState('');
const [marsvinMode,   setMarsvinMode]   = useState(false);
const [marsvinHue,    setMarsvinHue]    = useState(0);
const [expandedSliders, setExpandedSliders] = useState(new Set());
const marsvinImgRef = useRef(null);
useEffect(() => {
  const img = new Image();
  img.src = '/walkcycle/marsvin.png';
  img.onload = () => { marsvinImgRef.current = img; };
}, []);

live.current = {params,style,playback,keyPoses,onionOn,onionCount,marsvinMode,tab};
const toggleExpand = key => setExpandedSliders(s => { const n=new Set(s); n.has(key)?n.delete(key):n.add(key); return n; });
const setP  = (key,val) => { setActivePreset(null); setParams(p=>{
  const next={...p,[key]:val};
  if(key==='legLen') next.stepLength=Math.min(next.stepLength, Math.floor(val*0.97));
  return next;
}); };
const setSt = (key,val) => setStyle(s=>({...s,[key]:val}));

let T = THEMES[style.themeIdx ?? 0];
if(marsvinMode){
const h=marsvinHue;
T={...T,
title:'🐾 DESMONDS MARSVIN!!',
subtitle:'ITS JUST A WALKING GUINEA PIG',
titleFont:"'Righteous', cursive",
titleSize:17,
paper:    `hsl(${h},100%,88%)`,
paperDk:  `hsl(${(h+30)%360},100%,78%)`,
paperLt:  `hsl(${(h+60)%360},100%,92%)`,
border:   `hsl(${(h+120)%360},100%,55%)`,
borderLt: `hsl(${(h+150)%360},100%,70%)`,
ink:      `hsl(${(h+180)%360},90%,22%)`,
ink2:     `hsl(${(h+200)%360},80%,32%)`,
ink3:     `hsl(${(h+220)%360},70%,42%)`,
ink4:     `hsl(${(h+240)%360},60%,52%)`,
blue:     `hsl(${(h+60)%360},100%,42%)`,
red:      `hsl(${(h+90)%360},100%,42%)`,
amber:    `hsl(${(h+120)%360},100%,42%)`,
tabIcons: {body:'🐾',walk:'🥕',style:'✨',timing:'🌈',presets:'🐹'},
};}
useEffect(()=>{
  document.documentElement.dataset.theme = ['light','dark','pink'][style.themeIdx ?? 0];
},[style.themeIdx]);
useEffect(()=>{
  if(!marsvinMode) return;
  const id=setInterval(()=>setMarsvinHue(h=>(h+2)%360),50);
  return ()=>clearInterval(id);
},[marsvinMode]);
// Load saved presets + read URL hash
useEffect(()=>{
(async()=>{
try{
const keys=await store.list('wcs:preset:');
const loaded=[];
for(const k of (keys?.keys||[])){const r=await store.get(k);if(r?.value) loaded.push(JSON.parse(r.value));}
setUserPresets(loaded.sort((a,b)=>a.createdAt-b.createdAt));
}catch{}
})();
const hash=window.location.hash.slice(1);
if(hash){try{const p=JSON.parse(atob(hash));setParams(prev=>({...prev,...p}));}catch{}}
},[]);

// Share helpers
const makeCode=()=>btoa(JSON.stringify(live.current.params));
const flashMsg=msg=>{setCopyMsg(msg);setTimeout(()=>setCopyMsg(''),1800);};
const copyCode=()=>{navigator.clipboard.writeText(makeCode()).then(()=>flashMsg('Code copied!'));};
const copyLink=()=>{
  const code=makeCode();
  history.replaceState(null,'',`#${code}`);
  navigator.clipboard.writeText(window.location.href).then(()=>flashMsg('Link copied!'));
};
const doImport=code=>{
  try{
    const p=JSON.parse(atob(code.trim()));
    setParams(prev=>({...prev,...p,fps:prev.fps,animOn:prev.animOn}));
    setActivePreset(null);setImportCode('');setImportErr(false);
  }catch{setImportErr(true);}
};

// Animation loop
useEffect(()=>{
const canvas=canvasRef.current; if(!canvas) return;
const loop=ts=>{
if(!lastTRef.current) lastTRef.current=ts;
const dt=Math.min((ts-lastTRef.current)/1000,0.05); lastTRef.current=ts;
const {params:p,style:st,playback:pb,keyPoses:kp,onionOn:oo,onionCount:oc}=live.current;
const rate=p.speed*2.5, dir=st.flipDir?-1:1;
if(pb==='forward'||pb==='backward'){
const sign=pb==='forward'?1:-1;
phaseRef.current+=sign*dt*rate;
const pps=(p.stepLength*2*rate)/Math.PI;
if(st.loco==='walk'){
walkXRef.current+=sign*dt*pps*dir;
if(walkXRef.current>W+90) walkXRef.current=-90;
if(walkXRef.current<-90)  walkXRef.current=W+90;
} else { walkXRef.current=W/2; }
} else if(st.loco!=='walk') walkXRef.current=W/2;
const cx=st.loco==='walk'?walkXRef.current:W/2;
renderFrame(canvas,phaseRef.current,cx,p,st,{keyPoseState:kp,onion:{on:oo,count:oc},marsvinMode:live.current.marsvinMode,marsvinImg:marsvinImgRef.current});
if(live.current.tab==='timing'&&chartRef.current) drawTimingChart(chartRef.current,p,phaseRef.current);
const N=cycLen(p.fps,p.speed),snap=TAU/N*p.animOn;
const frac=((Math.round(phaseRef.current/snap)*snap%TAU)+TAU)%TAU/TAU;
if(scrubRef.current) scrubRef.current.style.left=`${frac*100}%`;
animRef.current=requestAnimationFrame(loop);
};
animRef.current=requestAnimationFrame(loop);
return ()=>cancelAnimationFrame(animRef.current);
},[]);

// Timing chart
useEffect(()=>{
if(tab==='timing'&&chartRef.current) drawTimingChart(chartRef.current,params,phaseRef.current);
},[tab,params.fps,params.animOn,params.feel,params.speed,params.stepLength,
params.legLen,params.kneeLift,params.armSwing,params.bounce]);

// Scrubber
const getSF=e=>{const r=scrubBarRef.current.getBoundingClientRect();return Math.max(0,Math.min(1,(e.clientX-r.left)/r.width));};
const onSD=e=>{scrubDrag.current=true;phaseRef.current=getSF(e)*TAU;setPlayback('paused');};
const onSM=e=>{if(scrubDrag.current) phaseRef.current=getSF(e)*TAU;};
const onSU=()=>{scrubDrag.current=false;};

const stepFwd=()=>{const N=cycLen(live.current.params.fps,live.current.params.speed);setPlayback('paused');phaseRef.current+=TAU/N*live.current.params.animOn;};
const stepBwd=()=>{const N=cycLen(live.current.params.fps,live.current.params.speed);setPlayback('paused');phaseRef.current-=TAU/N*live.current.params.animOn;};

// Presets
const applyPreset=(pre,name)=>{setParams(p=>({...p,...pre,fps:p.fps,animOn:p.animOn}));setActivePreset(name||null);};
const handleSavePre=async()=>{
if(!saveName.trim()) return;
const id=`${Date.now()}`;
const thumbnail=makeThumbnail(live.current.params,live.current.style);
const preset={id,name:saveName.trim(),createdAt:Date.now(),params:{...live.current.params},thumbnail};
await store.set(`wcs:preset:${id}`,JSON.stringify(preset));
setUserPresets(v=>[...v,preset]); setSaveName(''); setSavingPre(false);
};
const handleDelPre=async id=>{await store.del(`wcs:preset:${id}`);setUserPresets(v=>v.filter(p=>p.id!==id));};

// Export
const canvasToBlob=canvas=>new Promise(res=>canvas.toBlob(res,'image/png'));
const getAspect=()=>EXP_ASPECTS.find(a=>a.key===expAspect)||EXP_ASPECTS[0];
const doExport=async mode=>{
if(downloadReady){URL.revokeObjectURL(downloadReady.url);setDownloadReady(null);}
setExporting(true);
const {params:p,style:st}=live.current;
const N=cycLen(p.fps,p.speed),dc=Math.ceil(N/p.animOn),res=expRes;
const baseName=(activePreset||'walk').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');
const off=document.createElement('canvas');off.width=W*res;off.height=H*res;
const oc=off.getContext('2d');
const bg=BG_COLORS[st.bgIdx];
let blob,filename;
if(mode==='spritesheet'){
// Spritesheet always uses native 3:2 canvas dimensions
const cols=Math.ceil(Math.sqrt(dc)), rows=Math.ceil(dc/cols);
const sh=document.createElement('canvas');sh.width=W*res*cols;sh.height=H*res*rows;
const sc=sh.getContext('2d');
for(let d=0;d<dc;d++){
const rp=d*p.animOn*TAU/N;
renderFrame(off,rp,W/2,p,st,{forExport:true,transparent:expTrans});
sc.drawImage(off,(d%cols)*W*res,Math.floor(d/cols)*H*res);
setExpPct(Math.round((d+1)/dc*100));await new Promise(r=>setTimeout(r,15));
}
blob=await canvasToBlob(sh);
filename=`${baseName}_spritesheet_${cols}x${rows}_${dc}drw.png`;
} else {
const {w:aw,h:ah}=getAspect();
const zip=new JSZip();
for(let d=0;d<dc;d++){
const rp=d*p.animOn*TAU/N;
renderFrame(off,rp,W/2,p,st,{forExport:true,transparent:expTrans});
const frame=compositeFrame(off,aw,ah,bg.bg,res);
zip.file(`walk_${p.animOn>1?'drw':'fr'}_${String(d+1).padStart(3,'0')}.png`, await canvasToBlob(frame));
setExpPct(Math.round((d+1)/dc*50));await new Promise(r=>setTimeout(r,15));
}
blob=await zip.generateAsync({type:'blob'},meta=>{setExpPct(50+Math.round(meta.percent/2));});
filename=`${baseName}_sequence_${aw*res}x${ah*res}_${dc}${p.animOn>1?'drw':'fr'}.zip`;
}
setExporting(false);setExpPct(0);
setDownloadReady({url:URL.createObjectURL(blob),filename});
};
const doGifExport=async()=>{
if(downloadReady){URL.revokeObjectURL(downloadReady.url);setDownloadReady(null);}
setExporting(true);
const {params:p,style:st}=live.current;
const N=cycLen(p.fps,p.speed),dc=Math.ceil(N/p.animOn),res=expRes;
const {w:aw,h:ah}=getAspect();
const ew=aw*res, eh=ah*res;
const bg=BG_COLORS[st.bgIdx];
const baseName=(activePreset||'walk').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');
const off=document.createElement('canvas');off.width=W*res;off.height=H*res;
const gif=GIFEncoder();
const delay=Math.round(1000/p.fps*p.animOn);
for(let d=0;d<dc;d++){
const rp=d*p.animOn*TAU/N;
renderFrame(off,rp,W/2,p,st,{forExport:true,transparent:false});
const frame=compositeFrame(off,aw,ah,bg.bg,res);
const {data}=frame.getContext('2d').getImageData(0,0,ew,eh);
const palette=quantize(data,256);
gif.writeFrame(applyPalette(data,palette),ew,eh,{palette,delay});
setExpPct(Math.round((d+1)/dc*100));await new Promise(r=>setTimeout(r,10));
}
gif.finish();
const blob=new Blob([gif.bytes()],{type:'image/gif'});
const filename=`${baseName}_${ew}x${eh}.gif`;
setExporting(false);setExpPct(0);
setDownloadReady({url:URL.createObjectURL(blob),filename});
};

// ── Style helpers (paper & ink theme) ───────────────────────────────────────
const tgl=(on,danger=false)=>({
background:on?(danger?ha(T.red,0.10):ha(T.blue,0.12)):'transparent',
border:`1px solid ${on?(danger?T.red:T.blue):T.border}`,
color:on?(danger?T.red:T.blue):T.ink2,
borderRadius:3,padding:'3px 8px',cursor:'pointer',
fontSize:9,letterSpacing:'0.1em',fontFamily:'inherit',textTransform:'uppercase',transition:'all 0.12s',
});
const chip=on=>({...tgl(on),padding:'5px 14px',fontSize:10});
const tabBody={padding:'10px 14px',display:'flex',flexDirection:'column',gap:10,overflowY:'auto',maxHeight:268,background:T.paperLt};
const sec={display:'flex',flexDirection:'column',gap:8};
const secLbl={fontSize:9,letterSpacing:'0.18em',color:T.ink3,textTransform:'uppercase'};
const divider={width:'100%',height:1,background:T.borderLt,margin:'2px 0'};

const N=cycLen(params.fps,params.speed), dc=Math.ceil(N/params.animOn);
const TABS=[
{key:'body',  icon:'⊙',label:'Body'},
{key:'walk',  icon:'≋',label:'Walk'},
{key:'style', icon:'✦',label:'Style'},
{key:'timing',icon:'◷',label:'Timing'},
{key:'presets',icon:'⊟',label:'Presets'},
];

return (
<div style={{fontFamily:"'Courier New',monospace",background:T.paper,color:T.ink,
display:'flex',flexDirection:'column',width:W,
border:`1px solid ${T.border}`,borderRadius:4,overflow:'hidden',
boxShadow:`0 4px 16px ${ha(T.ink,0.18)}`,
'--blue':T.blue,'--red':T.red,'--amber':T.amber,
'--ink':T.ink,'--ink2':T.ink2,'--ink3':T.ink3,'--ink4':T.ink4,
'--paper':T.paper,'--paper-dk':T.paperDk,'--paper-lt':T.paperLt,
'--border':T.border,'--border-lt':T.borderLt}}>

  {/* Header */}
  <div style={{padding:'8px 16px 7px',background:T.paperDk,borderBottom:`1px solid ${T.border}`,
               display:'flex',alignItems:'center'}}>
    <div style={{display:'flex',flexDirection:'column',alignItems:'flex-start',gap:2}}>
      <span style={{fontFamily:T.titleFont,fontSize:T.titleSize,color:T.ink,
                    letterSpacing:'0.04em',lineHeight:1,
                    textShadow:`1px 1px 0 ${T.border}`}}>
        {T.title}
      </span>
      <span style={{fontFamily:T.subtitleFont,fontSize:8,color:T.ink2,
                    letterSpacing:'0.2em',textTransform:'uppercase'}}>
        {T.subtitle}
      </span>
    </div>
    <div style={{flex:1,display:'flex',justifyContent:'flex-end',gap:5}}>
      {THEMES.map((th,idx)=>{
        const active=(style.themeIdx??0)===idx;
        return(
        <button key={idx} title={th.title}
          onClick={()=>{setSt('themeIdx',idx);setSt('bgIdx',th.defaultBgIdx);setSt('figureIdx',th.defaultFigIdx);}}
          style={{background:active?T.borderLt:'transparent',
                  border:`1.5px solid ${active?T.border:T.borderLt}`,
                  borderRadius:'50%',width:30,height:30,padding:0,cursor:'pointer',
                  display:'flex',alignItems:'center',justifyContent:'center',
                  transition:'all 0.15s',boxShadow:active?`0 0 6px ${ha(T.ink,0.25)}`:'none'}}>
          {THEME_ICONS[idx]}
        </button>);
      })}
    </div>
  </div>

  {/* Canvas */}
  <div style={{borderBottom:`1px solid ${T.border}`,boxShadow:`inset 0 1px 3px ${ha(T.ink,0.06)}`}}>
    <canvas ref={canvasRef} width={W*DPR} height={H*DPR} style={{display:'block',width:W,height:H}}/>
  </div>

  {/* Display toolbar */}
  <div style={{display:'flex',alignItems:'center',gap:8,padding:'6px 12px',
               background:T.paperDk,borderBottom:`1px solid ${T.border}`,flexWrap:'wrap',rowGap:5}}>
    <div style={{display:'flex',gap:4,alignItems:'center'}}>
      <span style={{fontSize:8,color:T.ink3,letterSpacing:'0.1em',textTransform:'uppercase',marginRight:2}}>Fig</span>
      {FIG_COLORS.map((c,i)=>(
        <button key={c.name} onClick={()=>setSt('figureIdx',i)} title={c.name}
          style={{
            width: c.parts ? 20 : 14,
            height: 14,
            borderRadius: c.parts ? 2 : '50%',
            background: c.parts
              ? 'linear-gradient(to bottom,#2E7D32 33%,#E8A020 33% 66%,#B91C1C 66%)'
              : (!BG_COLORS[style.bgIdx].light && isDark(c.stroke) ? '#E6E6E6' : c.stroke),
            cursor:'pointer',padding:0,
            border:i===style.figureIdx?`2px solid ${T.blue}`:`2px solid ${T.borderLt}`}}/>
      ))}
    </div>
    <div style={{width:1,height:14,background:T.border}}/>
    <div style={{display:'flex',gap:4,alignItems:'center'}}>
      <span style={{fontSize:8,color:T.ink3,letterSpacing:'0.1em',textTransform:'uppercase',marginRight:2}}>BG</span>
      {BG_COLORS.map((c,i)=>(
        <button key={c.name} onClick={()=>setSt('bgIdx',i)} title={c.name}
          style={{width:14,height:14,borderRadius:'50%',background:c.bg,cursor:'pointer',padding:0,
                  border:i===style.bgIdx?`2px solid ${T.blue}`:`1px solid ${T.border}`}}/>
      ))}
    </div>
    <div style={{width:1,height:14,background:T.border}}/>
    {[['⊞','Grid','showGrid'],['◐','Shadow','showShadow'],['⁛','Dots','footDots'],['⇄','Flip','flipDir']].map(([ic,l,k])=>(
      <button key={k} onClick={()=>setSt(k,!style[k])} style={tgl(style[k])}>{ic} {l}</button>
    ))}
    <div style={{marginLeft:'auto',display:'flex',gap:3}}>
      <button onClick={()=>setSt('loco','place')} style={tgl(style.loco==='place')}>⟳ Place</button>
      <button onClick={()=>setSt('loco','walk')}  style={tgl(style.loco==='walk')} >→ Walk</button>
    </div>
  </div>

  {/* Playback */}
  <div style={{display:'flex',alignItems:'center',gap:5,padding:'6px 12px',
               background:T.paper,borderBottom:`1px solid ${T.borderLt}`}}>
    <button onClick={()=>{phaseRef.current=0;setPlayback('paused');}} style={tgl(false)} title="First">⏮</button>
    <button onClick={stepBwd} style={tgl(false)} title="Step back">‹</button>
    <button onClick={()=>setPlayback(v=>v==='forward'?'paused':'forward')} style={{...tgl(playback==='forward'),minWidth:60}}>
      {playback==='forward'?'⏸ Pause':'▶ Play'}
    </button>
    <button onClick={()=>setPlayback(v=>v==='backward'?'paused':'backward')} style={tgl(playback==='backward')}>◀</button>
    <button onClick={stepFwd} style={tgl(false)} title="Step forward">›</button>
    <div style={{flex:1}}/>
    <button onClick={()=>setOnionOn(v=>!v)} style={tgl(onionOn)}>◎ Onion</button>
    {onionOn&&<>
      <button onClick={()=>setOnionCount(v=>Math.max(1,v-1))} style={{...tgl(false),padding:'2px 6px'}}>−</button>
      <span style={{fontSize:10,color:T.ink3,minWidth:12,textAlign:'center'}}>{onionCount}</span>
      <button onClick={()=>setOnionCount(v=>Math.min(5,v+1))} style={{...tgl(false),padding:'2px 6px'}}>+</button>
    </>}
    <button onClick={()=>setSt('tickMode',style.tickMode==='ruler'?'step':'ruler')}
      style={tgl(style.tickMode==='ruler')}>{style.tickMode==='ruler'?'⊢ Ruler':'↕ Steps'}</button>
    <button onClick={()=>setParams(p=>({...p,...DEF_PARAMS,fps:p.fps,animOn:p.animOn}))}
      style={{...tgl(false),marginLeft:4}} title="Reset">↺</button>
  </div>

  {/* Scrubber */}
  <div style={{padding:'8px 12px 5px',background:T.paper,borderBottom:`1px solid ${T.borderLt}`}}>
    <div ref={scrubBarRef} onMouseDown={onSD} onMouseMove={onSM} onMouseUp={onSU} onMouseLeave={onSU}
         style={{position:'relative',height:3,background:T.borderLt,borderRadius:2,cursor:'pointer',marginBottom:8}}>
      {KEY_POSES.map(kp=>(
        <div key={kp.key} style={{position:'absolute',top:0,bottom:0,width:2,borderRadius:1,
          background:keyPoses[kp.key]?kp.color:T.borderLt,left:`${kp.phase/TAU*100}%`}}/>
      ))}
      <div ref={scrubRef} style={{position:'absolute',top:-5,left:'0%',width:13,height:13,
        background:T.ink,border:`2px solid ${T.paper}`,borderRadius:'50%',
        transform:'translateX(-50%)',pointerEvents:'none',boxShadow:`0 1px 4px ${ha(T.ink,0.2)}`}}/>
    </div>
    <div style={{display:'flex',gap:5,flexWrap:'wrap'}}>
      {KEY_POSES.map(kp=>(
        <button key={kp.key} onClick={()=>setKeyPoses(v=>({...v,[kp.key]:!v[kp.key]}))}
          style={{...tgl(keyPoses[kp.key]),borderColor:keyPoses[kp.key]?kp.color:T.border,
                  color:keyPoses[kp.key]?kp.color:T.ink3,display:'flex',alignItems:'center',gap:4}}>
          <span style={{width:5,height:5,borderRadius:'50%',display:'inline-block',
            background:keyPoses[kp.key]?kp.color:T.borderLt,flexShrink:0}}/>
          {kp.label}
        </button>
      ))}
    </div>
  </div>

  {/* Tabs */}
  <div style={{display:'flex',background:T.paperDk,borderBottom:`1px solid ${T.border}`}}>
    {TABS.map(t=>(
      <button key={t.key} onClick={()=>setTab(t.key)}
        style={{flex:1,background:tab===t.key?T.paperLt:T.paperDk,border:'none',
                borderBottom:tab===t.key?`2px solid ${T.ink}`:`2px solid transparent`,
                borderRight:`1px solid ${T.borderLt}`,
                color:tab===t.key?T.ink:T.ink3,cursor:'pointer',
                padding:'7px 4px 5px',fontSize:8,letterSpacing:'0.1em',
                fontFamily:'inherit',textTransform:'uppercase',transition:'all 0.1s',
                display:'flex',flexDirection:'column',alignItems:'center',gap:2}}>
        <span style={{fontSize:13,lineHeight:1}}>{T.tabIcons?.[t.key] ?? t.icon}</span>
        <span>{t.label}</span>
      </button>
    ))}
  </div>

  {/* View Angle — always visible */}
  <div style={{display:'flex',alignItems:'center',gap:12,
               padding:'8px 16px',borderBottom:`1px solid ${T.border}`,
               background:T.paperDk}}>
    <div style={{flex:1,display:'flex',flexDirection:'column',gap:2}}>
      <div style={{display:'flex',justifyContent:'space-between',fontSize:10,
                   letterSpacing:'0.07em',color:'var(--ink2)'}}>
        <span style={{textTransform:'uppercase'}}>View Angle</span>
        <span style={{color:'var(--ink3)'}}>{params.viewAngle}°</span>
      </div>
      <input type="range" min={0} max={360} step={1} value={params.viewAngle}
        onChange={e=>setP('viewAngle',+e.target.value)}/>
      <div style={{display:'flex',justifyContent:'space-between',fontSize:8,color:'var(--ink4)',marginTop:1}}>
        <span>Side</span><span>Front</span><span>Side</span><span>Back</span><span>Side</span>
      </div>
    </div>
    <ViewAngleIndicator angle={params.viewAngle} T={T}/>
  </div>

  {/* Tab content */}
  <div style={{background:T.paperLt,minHeight:258}}>

  {marsvinMode&&(
    <div style={{...tabBody,alignItems:'center',gap:20,textAlign:'center'}}>
      <div style={{fontSize:22,fontWeight:'bold',color:T.ink,fontFamily:"'Righteous',cursive",letterSpacing:'0.05em'}}>
        🐾 MARSVIN MODE 🐾
      </div>
      <div style={{width:'100%',display:'flex',flexDirection:'column',gap:6}}>
        <label style={{fontSize:10,color:T.ink2,textTransform:'uppercase',letterSpacing:'0.12em'}}>Speed</label>
        <input type="range" min={0.2} max={5} step={0.05} value={params.speed}
          onChange={e=>setP('speed',+e.target.value)}
          style={{width:'100%',accentColor:'hotpink',cursor:'pointer'}}/>
      </div>
      <div style={{width:'100%',display:'flex',flexDirection:'column',gap:6}}>
        <label style={{fontSize:10,color:T.ink2,textTransform:'uppercase',letterSpacing:'0.12em'}}>Size</label>
        <input type="range" min={35} max={110} step={1} value={params.legLen}
          onChange={e=>setP('legLen',+e.target.value)}
          style={{width:'100%',accentColor:'hotpink',cursor:'pointer'}}/>
      </div>
      <button onClick={()=>{setMarsvinMode(false);setSt('loco','place');}}
        style={{background:'transparent',border:'2px solid hotpink',color:T.ink,
                borderRadius:3,padding:'7px 20px',cursor:'pointer',fontSize:10,fontFamily:'inherit',
                letterSpacing:'0.1em',textTransform:'uppercase'}}>
        Back to Normal
      </button>
    </div>
  )}

  {!marsvinMode&&<>

    {tab==='body'&&(
      <div style={tabBody}>
        <SliderGrid sliders={TAB_SLIDERS.body} params={params} onChange={setP} expanded={expandedSliders} onToggle={toggleExpand}/>
      </div>
    )}

    {tab==='walk'&&(
      <div style={tabBody}>
        <SliderGrid sliders={TAB_SLIDERS.walk} params={params} onChange={setP} expanded={expandedSliders} onToggle={toggleExpand}/>
        <div style={divider}/>
        <p style={{fontSize:9,color:T.ink3,lineHeight:1.65,fontStyle:'italic',margin:0}}>
          Toe/Heel: −1 toe lands first · 0 flat foot · +1 heel strikes first
        </p>
      </div>
    )}

    {tab==='style'&&<div style={tabBody}><SliderGrid sliders={TAB_SLIDERS.style} params={params} onChange={setP} expanded={expandedSliders} onToggle={toggleExpand}/></div>}

    {tab==='timing'&&(
      <div style={tabBody}>
        <div style={{display:'flex',gap:20,flexWrap:'wrap'}}>
          <div style={sec}>
            <div style={secLbl}>FPS</div>
            <div style={{display:'flex',gap:5}}>
              {[12,24,25,30].map(f=><button key={f} onClick={()=>setP('fps',f)} style={chip(params.fps===f)}>{f}</button>)}
            </div>
          </div>
          <div style={sec}>
            <div style={secLbl}>Animate On</div>
            <div style={{display:'flex',gap:5}}>
              {[[1,'Ones'],[2,'Twos']].map(([n,lb])=>(
                <button key={n} onClick={()=>setP('animOn',n)} style={chip(params.animOn===n)} title={`On ${lb}`}>{n}s</button>
              ))}
            </div>
          </div>
        </div>
        <div style={{fontSize:9,color:T.ink2,lineHeight:1.7,padding:'5px 10px',
                     background:T.paperDk,borderRadius:3,border:`1px solid ${T.borderLt}`}}>
          {N} frames · {dc} drawing{dc!==1?'s':''} · {(N/params.fps).toFixed(2)}s loop
          {params.animOn===2&&<span style={{color:T.ink3}}> — each held 2 frames</span>}
        </div>
        <div style={sec}>
          <div style={{display:'flex',justifyContent:'space-between'}}>
            <div style={secLbl}>Feel</div>
            <span style={{fontSize:10,color:T.ink2}}>
              {params.feel<=0.15?'Linear':params.feel<=0.4?'Crisp':params.feel<=0.62?'Natural':params.feel<=0.82?'Weighted':'Heavy'}
            </span>
          </div>
          <input type="range" min={0} max={1} step={0.01} value={params.feel}
            onChange={e=>setP('feel',+e.target.value)} style={{accentColor:T.blue,cursor:'pointer'}}/>
          <div style={{display:'flex',justifyContent:'space-between',fontSize:8,color:T.ink4,marginTop:1}}>
            <span>Linear</span><span>Natural</span><span>Heavy</span>
          </div>
          <p style={{fontSize:9,color:T.ink3,lineHeight:1.6,fontStyle:'italic',margin:'4px 0 0'}}>
            Dwells at contact &amp; toe-off — rushes through passing. Shapes drawing frame positions.
          </p>
        </div>
        <div style={sec}>
          <div style={secLbl}>Spacing Chart</div>
          <canvas ref={chartRef} width={440} height={102}
            style={{width:'100%',display:'block',borderRadius:3,border:`1px solid ${T.border}`}}/>
          <div style={{display:'flex',gap:14,marginTop:4}}>
            {[['#4A6FA5','Body height'],['#3D8B6A','Foot lift'],['#C07830','Arm swing']].map(([c,l])=>(
              <div key={l} style={{display:'flex',alignItems:'center',gap:5,fontSize:9,color:T.ink3}}>
                <div style={{width:7,height:7,borderRadius:'50%',background:c,flexShrink:0}}/>{l}
              </div>
            ))}
          </div>
        </div>
      </div>
    )}

    {tab==='presets'&&(
      <div style={tabBody}>
        <div style={sec}>
          <div style={secLbl}>Built-in</div>
          <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
            {Object.keys(SYSTEM_PRESETS).map(name=>(
              <button key={name} onClick={()=>applyPreset(SYSTEM_PRESETS[name],name)}
                style={{background:T.paper,border:`1px solid ${T.border}`,color:T.ink2,
                        borderRadius:3,padding:'5px 14px',cursor:'pointer',fontSize:10,
                        letterSpacing:'0.08em',fontFamily:'inherit',textTransform:'uppercase'}}
                onMouseEnter={e=>e.currentTarget.style.background=T.paperDk}
                onMouseLeave={e=>e.currentTarget.style.background=T.paper}>
                {name}
              </button>
            ))}
            <button
              onClick={()=>{const next=!marsvinMode;setMarsvinMode(next);if(next){setSt('loco','walk');setPlayback('forward');}}}
              style={{background:marsvinMode?'hotpink':T.paper,
                      border:`2px solid ${marsvinMode?'deeppink':T.border}`,
                      color:marsvinMode?'#fff':T.ink2,
                      fontWeight:marsvinMode?'bold':'normal',
                      borderRadius:3,padding:'5px 14px',cursor:'pointer',fontSize:10,
                      letterSpacing:'0.08em',fontFamily:'inherit',textTransform:'uppercase'}}>
              {marsvinMode?'MARSVIN!! 🐾':'MARSVIN?'}
            </button>
          </div>
        </div>
        <div style={divider}/>
        <div style={sec}>
          <div style={secLbl}>My Presets {userPresets.length>0&&`(${userPresets.length})`}</div>
          {userPresets.length===0&&(
            <p style={{fontSize:10,color:T.ink4,fontStyle:'italic',margin:0}}>
              No saved presets yet — dial in your settings and save below.
            </p>
          )}
          {userPresets.map(pre=>(
            <div key={pre.id} style={{display:'flex',alignItems:'center',gap:9,
                                     background:T.paper,border:`1px solid ${T.border}`,
                                     borderRadius:4,padding:'7px 10px'}}>
              {pre.thumbnail&&<img src={pre.thumbnail} alt=""
                style={{width:60,height:40,objectFit:'cover',borderRadius:2,
                        flexShrink:0,border:`1px solid ${T.borderLt}`}}/>}
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:12,color:T.ink,fontWeight:'bold',
                             overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{pre.name}</div>
                <div style={{fontSize:9,color:T.ink4,marginTop:2}}>{new Date(pre.createdAt).toLocaleDateString()}</div>
              </div>
              <div style={{display:'flex',gap:5,flexShrink:0}}>
                <button onClick={()=>applyPreset(pre.params,pre.name)} style={{...tgl(false),padding:'4px 10px',fontSize:9}}>Apply</button>
                <button onClick={()=>handleDelPre(pre.id)} style={{...tgl(true,true),padding:'4px 8px',fontSize:9}}>✕</button>
              </div>
            </div>
          ))}
        </div>
        <div style={divider}/>
        <div style={sec}>
          <div style={secLbl}>Save Current Settings</div>
          {!savingPre
            ? <button onClick={()=>setSavingPre(true)} style={{...tgl(false),padding:'6px 14px',fontSize:10,alignSelf:'flex-start'}}>+ Save as Preset</button>
            : <div style={{display:'flex',gap:7}}>
                <input value={saveName} onChange={e=>setSaveName(e.target.value)}
                  placeholder="Name this preset..." onKeyDown={e=>e.key==='Enter'&&handleSavePre()} autoFocus
                  style={{flex:1,background:T.paper,border:`1px solid ${T.border}`,color:T.ink,
                          borderRadius:3,padding:'5px 9px',fontSize:11,fontFamily:'inherit',outline:'none'}}/>
                <button onClick={handleSavePre}
                  style={{background:T.ink,border:'none',color:T.paper,borderRadius:3,
                          padding:'5px 12px',cursor:'pointer',fontSize:10,fontFamily:'inherit',fontWeight:'bold'}}>
                  Save
                </button>
                <button onClick={()=>{setSavingPre(false);setSaveName('');}} style={{...tgl(false),padding:'5px 9px'}}>✕</button>
              </div>
          }
        </div>
        <div style={divider}/>
        <div style={sec}>
          <div style={secLbl}>Share</div>
          <div style={{display:'flex',gap:6,flexWrap:'wrap',alignItems:'center'}}>
            <button onClick={copyCode} style={{...tgl(false),padding:'5px 12px',fontSize:10}}>⧉ Copy Code</button>
            <button onClick={copyLink} style={{...tgl(false),padding:'5px 12px',fontSize:10}}>⧉ Copy Link</button>
            {copyMsg&&<span style={{fontSize:9,color:T.blue}}>{copyMsg}</span>}
          </div>
          <div style={{display:'flex',gap:6}}>
            <input value={importCode} onChange={e=>{setImportCode(e.target.value);setImportErr(false);}}
              placeholder="Paste code to import…" onKeyDown={e=>e.key==='Enter'&&doImport(importCode)}
              style={{flex:1,background:T.paper,border:`1px solid ${importErr?T.red:T.border}`,color:T.ink,
                      borderRadius:3,padding:'5px 9px',fontSize:10,fontFamily:'inherit',outline:'none'}}/>
            <button onClick={()=>doImport(importCode)}
              style={{background:T.ink,border:'none',color:T.paper,borderRadius:3,
                      padding:'5px 10px',cursor:'pointer',fontSize:10,fontFamily:'inherit'}}>
              Import
            </button>
          </div>
          {importErr&&<span style={{fontSize:9,color:T.red}}>Invalid code</span>}
        </div>
      </div>
    )}
  </>}
  </div>

  {/* Export */}
  <div style={{padding:'12px 16px',background:T.paperDk,borderTop:`1px solid ${T.border}`}}>
    <div style={{fontSize:9,letterSpacing:'0.15em',color:T.ink3,textTransform:'uppercase',marginBottom:8}}>↓ Export</div>
    <div style={{display:'flex',gap:7,alignItems:'center',flexWrap:'wrap',marginBottom:8}}>
      <button onClick={()=>setExpTrans(v=>!v)} style={tgl(expTrans)}>{expTrans?'Transparent':'Opaque'}</button>
      <div style={{display:'flex',gap:3}}>
        {[1,2].map(r=><button key={r} onClick={()=>setExpRes(r)} style={chip(expRes===r)}>{r}×</button>)}
      </div>
      <div style={{display:'flex',gap:3}}>
        {EXP_ASPECTS.map(a=><button key={a.key} onClick={()=>setExpAspect(a.key)} style={chip(expAspect===a.key)}>{a.label}</button>)}
      </div>
    </div>
    <div style={{fontSize:9,color:T.ink3,marginBottom:10}}>
      {(()=>{const {w,h}=getAspect();return`${dc} ${params.animOn===2?'drawings (2s)':'frames'} · ${w*expRes}×${h*expRes}px · sheet ${Math.ceil(Math.sqrt(dc))}×${Math.ceil(dc/Math.ceil(Math.sqrt(dc)))} (native 3:2)`;})()}
    </div>
    <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
      <button onClick={()=>doExport('sequence')} disabled={exporting}
        style={{background:exporting?T.paperDk:T.ink,border:`1px solid ${T.ink}`,
                color:exporting?T.ink3:T.paper,borderRadius:3,padding:'7px 14px',
                cursor:exporting?'not-allowed':'pointer',fontSize:10,letterSpacing:'0.1em',fontFamily:'inherit',textTransform:'uppercase'}}>
        {exporting?`${expPct}%  working...`:'↓ PNG Sequence'}
      </button>
      <button onClick={doGifExport} disabled={exporting}
        style={{background:'transparent',border:`1px solid ${T.blue}`,
                color:exporting?T.ink4:T.blue,borderRadius:3,padding:'7px 14px',
                cursor:exporting?'not-allowed':'pointer',fontSize:10,letterSpacing:'0.1em',fontFamily:'inherit',textTransform:'uppercase'}}>
        {exporting?`${expPct}%`:'↓ GIF'}
      </button>
      <button onClick={()=>doExport('spritesheet')} disabled={exporting}
        style={{background:'transparent',border:`1px solid ${T.border}`,
                color:exporting?T.ink4:T.ink2,borderRadius:3,padding:'7px 14px',
                cursor:exporting?'not-allowed':'pointer',fontSize:10,letterSpacing:'0.1em',fontFamily:'inherit',textTransform:'uppercase'}}>
        {exporting?`${expPct}%`:'↓ Spritesheet'}
      </button>
    </div>
    {exporting&&(
      <div style={{marginTop:9,height:2,background:T.borderLt,borderRadius:1}}>
        <div style={{height:'100%',background:T.ink,width:`${expPct}%`,transition:'width 0.1s',borderRadius:1}}/>
      </div>
    )}
    {downloadReady&&(
      <a href={downloadReady.url} download={downloadReady.filename}
         onClick={()=>setTimeout(()=>{URL.revokeObjectURL(downloadReady.url);setDownloadReady(null);},500)}
         style={{display:'block',marginTop:10,padding:'8px 12px',background:T.blue,color:'#fff',
                 borderRadius:3,fontSize:11,textAlign:'center',textDecoration:'none',
                 letterSpacing:'0.08em',fontFamily:'inherit'}}>
        ↓ {downloadReady.filename}
      </a>
    )}
    <p style={{marginTop:8,fontSize:9,color:T.ink4,lineHeight:1.6,fontStyle:'italic',margin:'8px 0 0'}}>
      PNG/GIF use selected aspect ratio (letterboxed). Spritesheet always uses native 3:2. Onion skins and ghost trail excluded.
      {params.animOn===2&&` On 2s: ${dc} unique drawings, each held 2 frames.`}
    </p>
  </div>
</div>

);
}
