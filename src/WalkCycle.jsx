import { useState, useEffect, useRef } from "react";
import JSZip from "jszip";

// ── Constants ─────────────────────────────────────────────────────────────────
const W = 480, H = 320, GY = Math.round(H * 0.77), TAU = Math.PI * 2;

// ── Physics helpers ───────────────────────────────────────────────────────────
function legKnee(hx, hy, fx, fy, t, s, dir) {
const dx = fx-hx, dy = fy-hy, d = Math.min(Math.sqrt(dx*dx+dy*dy), t+s-0.5);
const a = Math.acos(Math.max(-1, Math.min(1, (d*d+t*t-s*s)/(2*d*t))));
const base = Math.atan2(dy, dx);
const k1 = {x: hx+Math.cos(base+a)*t, y: hy+Math.sin(base+a)*t};
const k2 = {x: hx+Math.cos(base-a)*t, y: hy+Math.sin(base-a)*t};
return (dir >= 0 ? k1.x >= k2.x : k1.x <= k2.x) ? k1 : k2;
}
function armSetup(ap, shX, shY, uA, fA, swing, bendDeg, dir) {
const max = Math.asin(Math.min(swing / Math.max(uA+fA, 1), 0.95));
const alpha = Math.sin(ap) * max;
const eX = shX + Math.sin(alpha)*dir*uA, eY = shY + Math.cos(alpha)*uA;
const bend = (bendDeg * Math.PI / 180) * Math.max(0, Math.sin(ap));
const fa = alpha + bend;
return { elbow:{x:eX,y:eY}, hand:{x:eX+Math.sin(fa)*dir*fA, y:eY+Math.cos(fa)*fA} };
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
function drawFoot(ctx, fx, fy, lp, sz, dir, lw, am, stroke, legLen, stepLen, heelToe) {
const mtpLen = sz * 0.75, toeLen = sz * 0.25;
const maxDeg = Math.asin(Math.min(0.92, stepLen / Math.max(legLen, 1))) * (180 / Math.PI);
const rawA   = maxDeg * heelToe * Math.sin(lp) * Math.PI / 180;
const onGround = Math.cos(lp) <= 0;
const rise = Math.max(0, GY - fy);                            // ankle height above GY
const t = ((lp % TAU) + TAU) % TAU / TAU;
const geoA = -Math.asin(Math.min(1, rise / mtpLen));          // geometry angle (negative = heel up)

let a;
if (onGround) {
// Stance: flat/contact uses phase angle; heel-rise uses geometry angle
a = rise < 0.5 ? Math.max(0, rawA) : geoA;
} else {
// Swing: single continuous blend from geometry angle (toe-off) → heel-down (contact)
// swingNorm: 0 at toe-off, 0.5 at mid-swing, 1 at contact
const swingNorm = ((t - 0.75 + 1) % 1) / 0.5;
if (swingNorm <= 0.5) {
// Early swing — geometry angle → neutral (rawA×0.4)
const p = Math.sin(swingNorm * Math.PI);                  // 0→1 ease-out
a = geoA + (rawA * 0.4 - geoA) * p;
} else {
// Late swing — neutral → full heel-down (rawA), foot prepares for heel-strike
const p = Math.sin((swingNorm - 0.5) * Math.PI);          // 0→1 ease-in
a = rawA * (0.4 + 0.6 * p);
}
}

const ca = Math.cos(a), sa = Math.sin(a);
const bx = fx + mtpLen * ca * dir;
const by = Math.min(fy - mtpLen * sa, GY);                    // never below GY

// Toe: flat at GY while ball is grounded; follows foot angle when airborne
let tx, ty;
if (by >= GY - 0.5) {
tx = bx + toeLen * dir; ty = GY;                            // flat ground contact
} else {
tx = bx + toeLen * ca * dir;
ty = Math.min(by - toeLen * sa, GY);
}

ctx.save();
ctx.strokeStyle=stroke; ctx.lineWidth=lw*1.15; ctx.lineCap='round'; ctx.lineJoin='round'; ctx.globalAlpha=am;
ctx.beginPath(); ctx.moveTo(fx,fy); ctx.lineTo(bx,by); ctx.lineTo(tx,ty); ctx.stroke();
ctx.restore();
}

// ── Easing ────────────────────────────────────────────────────────────────────
// Redistributes frame time using a double-frequency sine offset.
// This makes the figure dwell at CONTACT (t≈0.25) and TOE-OFF (t≈0.75),
// and rush through PASSING (t≈0, t≈0.5) — which is correct for walk weight.
//
// Velocity = 1 + feel·cos(4πt)/3
//   t=0.25 and t=0.75: velocity = 1 − feel/3  (slowest, min 0.67× at feel=1)
//   t=0   and t=0.5:   velocity = 1 + feel/3  (fastest, max 1.33× at feel=1)
//
// The figure NEVER pauses at any feel value. Boundary conditions preserved:
// applyFeel(0)=0, applyFeel(1)=1 (sin(4π)=0).
function applyFeel(t, feel) {
if (feel <= 0) return t;
return t + feel * Math.sin(4 * Math.PI * t) / (12 * Math.PI);
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

// ── Pure pose engine ──────────────────────────────────────────────────────────
function computePose(phase, cx, p, dir) {
const {stepLength,kneeLift,torsoLen,legLen,armLen,headSize,footSize,legBend,armBend,
bodyTilt,hipSway,leanAngle,headBob,headPendulum,armSwing,bounce} = p;
const thigh=legLen*0.52, shin=legLen*0.48, uArm=armLen*0.48, fArm=armLen*0.52;
// Hip height: derived from how far the stance foot is horizontally from the hip.
// Use the actual planted foot X (not raw sin) so the body correctly rises/dips
// with the real foot geometry rather than a phantom sine position.
const fFootX = footPosX(phase,        stepLength, dir, cx);
const bFootX = footPosX(phase+Math.PI, stepLength, dir, cx);
const stanceDx = Math.min(Math.abs(fFootX-cx), Math.abs(bFootX-cx)); // nearest foot
const k = Math.min(0.98, stanceDx / Math.max(legLen, 1));
const dip = Math.min(legLen*(1-Math.sqrt(1-k*k))*(1+bounce*0.10), legLen*0.28);
const hipX = cx + Math.sin(phase)*hipSway*dir, hipY = GY-legLen+dip;
const tilt = Math.sin(phase)*(bodyTilt*Math.PI/180)*dir + leanAngle*Math.PI/180;
const sX = hipX+Math.sin(tilt)*torsoLen, sY = hipY-Math.cos(tilt)*torsoLen;
const hdX = sX+Math.sin(phase)*headPendulum*dir;
const hdY = sY-headSize*1.4-Math.abs(Math.sin(phase*2))*headBob;
const fAn={x:footPosX(phase,        stepLength,dir,cx), y:GY-Math.max(0,Math.cos(phase))*kneeLift         -heelRise(phase,        footSize)};
const bAn={x:footPosX(phase+Math.PI,stepLength,dir,cx), y:GY-Math.max(0,Math.cos(phase+Math.PI))*kneeLift-heelRise(phase+Math.PI,footSize)};
// legBend biases the knee forward/back by rotating it around the hip
// while keeping the knee at exactly thigh-length from the hip.
// Raw x-offset then renormalize → preserves leg proportions and character height.
function biasKnee(k, bias) {
if (!bias) return k;
const dx=k.x+bias*dir-hipX, dy=k.y-hipY;
const d=Math.sqrt(dx*dx+dy*dy)||thigh;
return {x:hipX+dx/d*thigh, y:hipY+dy/d*thigh};
}
const fK=biasKnee(legKnee(hipX,hipY,fAn.x,fAn.y,thigh,shin,dir), legBend);
fK.y=Math.min(fK.y,GY-1);
const bK=biasKnee(legKnee(hipX,hipY,bAn.x,bAn.y,thigh,shin,dir), legBend);
bK.y=Math.min(bK.y,GY-1);
const {elbow:fE,hand:fH}=armSetup(phase+Math.PI,sX,sY,uArm,fArm,armSwing,armBend,dir);
const {elbow:bE,hand:bH}=armSetup(phase,sX,sY,uArm,fArm,armSwing,armBend,dir);
// Ground is a hard wall — clamp all arm endpoints above GY
[fE,fH,bE,bH].forEach(pt=>{ pt.y=Math.min(pt.y,GY-2); });
return {hipX,hipY,sX,sY,hdX,hdY,fAn,bAn,fK,bK,fE,fH,bE,bH};
}

// ── Draw figure from pose ─────────────────────────────────────────────────────
function drawFigure(ctx, pose, p, col, dir, phase, am=1) {
const {hipX,hipY,sX,sY,hdX,hdY,fAn,bAn,fK,bK,fE,fH,bE,bH} = pose;
const {footSize:fs,heelToe:ht,legLen:ll,stepLength:sl,lineWidth:lw,headSize:hs} = p;
ctx.save(); ctx.strokeStyle=col.stroke; ctx.fillStyle=col.fill;
ctx.lineWidth=lw; ctx.lineCap='round'; ctx.lineJoin='round';
ctx.globalAlpha=0.38*am;
ctx.beginPath(); ctx.moveTo(hipX,hipY); ctx.lineTo(bK.x,bK.y); ctx.lineTo(bAn.x,bAn.y); ctx.stroke();
if(fs>0) drawFoot(ctx,bAn.x,bAn.y,phase+Math.PI,fs,dir,lw,0.38*am,col.stroke,ll,sl,ht);
ctx.globalAlpha=0.30*am;
ctx.beginPath(); ctx.moveTo(sX,sY); ctx.lineTo(bE.x,bE.y); ctx.lineTo(bH.x,bH.y); ctx.stroke();
ctx.globalAlpha=am;
ctx.beginPath(); ctx.moveTo(hipX,hipY); ctx.lineTo(sX,sY); ctx.stroke();
ctx.beginPath(); ctx.moveTo(hipX,hipY); ctx.lineTo(fK.x,fK.y); ctx.lineTo(fAn.x,fAn.y); ctx.stroke();
if(fs>0) drawFoot(ctx,fAn.x,fAn.y,phase,fs,dir,lw,am,col.stroke,ll,sl,ht);
ctx.globalAlpha=0.88*am;
ctx.beginPath(); ctx.moveTo(sX,sY); ctx.lineTo(fE.x,fE.y); ctx.lineTo(fH.x,fH.y); ctx.stroke();
ctx.globalAlpha=am;
ctx.beginPath(); ctx.arc(hdX,hdY,hs,0,TAU); ctx.stroke();
ctx.globalAlpha=0.10*am; ctx.fill();
ctx.restore();
}

// ── Colour palettes ───────────────────────────────────────────────────────────
// Figure colors: ink and pencil tones designed for a light paper background
const FIG_COLORS = [
{name:'Ink',    stroke:'#2A2318',fill:'rgba(42,35,24,0.06)'},
{name:'Pencil', stroke:'#5A5048',fill:'rgba(90,80,72,0.06)'},
{name:'Blue',   stroke:'#3A6090',fill:'rgba(58,96,144,0.06)'},
{name:'Red',    stroke:'#B84040',fill:'rgba(184,64,64,0.06)'},
{name:'Sienna', stroke:'#8B5030',fill:'rgba(139,80,48,0.06)'},
{name:'Forest', stroke:'#3D6B40',fill:'rgba(61,107,64,0.06)'},
];
// BG colors: paper and animation-desk tones. light:true = use dark ink overlay text.
const BG_COLORS = [
{name:'Paper',     bg:'#F4EFE4',light:true},
{name:'Cel',       bg:'#F8F6F0',light:true},
{name:'Aged',      bg:'#EDE5C8',light:true},
{name:'Blueprint', bg:'#D4DFE8',light:true},
{name:'Dark',      bg:'#1A1815',light:false},
];
const KEY_POSES = [
{key:'contact',label:'Contact',phase:TAU*0.25,color:'#3B82F6',fill:'rgba(59,130,246,0.08)'},
{key:'down',   label:'Down',   phase:TAU*0.42,color:'#D97706',fill:'rgba(217,119,6,0.08)'},
{key:'passing',label:'Passing',phase:TAU*0.5, color:'#059669',fill:'rgba(5,150,105,0.08)'},
{key:'up',     label:'Up',     phase:TAU*0.75,color:'#DC2626',fill:'rgba(220,38,38,0.08)'},
];

// ── Full frame render ─────────────────────────────────────────────────────────
function renderFrame(canvas, rawPhase, cx, p, st, opts={}) {
const {forExport=false,transparent=false,keyPoseState=null,onion=null,tickOffset=0} = opts;
const ctx = canvas.getContext('2d');
const col = FIG_COLORS[st.figureIdx], bg = BG_COLORS[st.bgIdx];
const dir = st.flipDir ? -1 : 1, light = bg.light !== false;
const N = cycLen(p.fps, p.speed), snapStep = TAU/N*p.animOn;
const snappedRaw = Math.round(rawPhase/snapStep)*snapStep;
const tN = ((snappedRaw%TAU)+TAU)%TAU/TAU;
const phase = applyFeel(tN, p.feel)*TAU;

ctx.clearRect(0,0,W,H);
if(!transparent){ctx.fillStyle=bg.bg; ctx.fillRect(0,0,W,H);}

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
const sp=Math.max(6,p.stepLength*2); ctx.strokeStyle=light?'rgba(0,0,0,0.22)':'rgba(255,255,255,0.18)'; ctx.lineWidth=1.5;
if(st.loco==='walk'){
for(let x=sp*0.5;x<W+sp;x+=sp){ctx.beginPath();ctx.moveTo(x,GY);ctx.lineTo(x,GY+8);ctx.stroke();}
} else {
const off=((tickOffset%sp)+sp)%sp;
for(let x=off-sp;x<W+sp;x+=sp){ctx.beginPath();ctx.moveTo(x,GY);ctx.lineTo(x,GY+8);ctx.stroke();}
}
}
if(st.showShadow){
const bob=Math.abs(Math.sin(phase))*p.bounce, sw=Math.max(p.legLen*0.55-bob*0.3,12);
ctx.save();ctx.globalAlpha=0.18;ctx.fillStyle=col.stroke;
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
drawFigure(ctx,computePose(gPh,cx,p,dir),p,col,dir,gPh,0.28*(gc-g+1)/gc);
}
drawFigure(ctx,computePose(phase,cx,p,dir),p,col,dir,phase);
{
const norm=((snappedRaw%TAU)+TAU)%TAU;
const frameN=Math.min(Math.floor(norm/TAU*N)+1,N);
const totalDrw=Math.ceil(N/p.animOn), drwN=Math.min(Math.ceil(frameN/p.animOn),totalDrw);
const l1=p.animOn===1?`Fr ${frameN} / ${N}`:`Fr ${frameN} / ${N}  (Drw ${drwN} / ${totalDrw})`;
const l2=`${N} fr · ${(N/p.fps).toFixed(2)}s @ ${p.fps}fps`;
ctx.save(); ctx.font='bold 10px Courier New'; const tw1=ctx.measureText(l1).width;
ctx.font='9px Courier New'; const tw2=ctx.measureText(l2).width;
const bw=Math.max(tw1,tw2)+16,bh=32,bx=W-bw-6,by=6;
ctx.fillStyle=forExport?(transparent?'rgba(0,0,0,0.55)':light?'rgba(244,239,228,0.94)':'rgba(18,16,14,0.88)')
                       :light?'rgba(244,239,228,0.94)':'rgba(18,16,14,0.88)';
ctx.beginPath();ctx.roundRect(bx,by,bw,bh,3);ctx.fill();
ctx.fillStyle=forExport?(transparent?'#ffffff':light?'#2A2318':'#E8DCC8'):light?'#2A2318':'#E8DCC8';
ctx.textAlign='left'; ctx.textBaseline='top';
ctx.font='bold 10px Courier New'; ctx.fillText(l1,bx+8,by+5);
ctx.fillStyle=forExport?(transparent?'rgba(255,255,255,0.75)':light?'#6B5E4A':'#8A7C6A'):light?'#6B5E4A':'#8A7C6A';
ctx.font='9px Courier New'; ctx.fillText(l2,bx+8,by+19);
ctx.restore();
}
}

// ── Timing / spacing chart ────────────────────────────────────────────────────
// Shows how frames are distributed across each body part's motion path.
// Dense dots = moving slowly (dwelling at that pose).
// Sparse dots = moving quickly through.
// Filled dot = drawing frame; hollow = held frame (on 2s).
function drawTimingChart(canvas, p) {
const ctx=canvas.getContext('2d'); const cw=canvas.width,ch=canvas.height;
ctx.clearRect(0,0,cw,ch); ctx.fillStyle='#EAE4D4'; ctx.fillRect(0,0,cw,ch);
const N=cycLen(p.fps,p.speed);
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
ctx.beginPath(); ctx.arc(x,y,isDrw?2.5:1.5,0,TAU);
if(isDrw){ctx.fillStyle=color;ctx.fill();}
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
{key:'legLen',   label:'Leg Length',  min:35,  max:110,step:1,   unit:'px'},
{key:'armLen',   label:'Arm Length',  min:20,  max:80, step:1,   unit:'px'},
{key:'torsoLen', label:'Torso',       min:20,  max:80, step:1,   unit:'px'},
{key:'headSize', label:'Head Size',   min:8,   max:30, step:1,   unit:'px'},
{key:'footSize', label:'Foot Size',   min:0,   max:22, step:1,   unit:'px'},
{key:'lineWidth',label:'Line Weight', min:1,   max:8,  step:0.5, unit:'px'},
{key:'legBend',  label:'Leg Bend',    min:-15, max:28, step:1,   unit:'px'},
{key:'armBend',  label:'Arm Bend',    min:0,   max:60, step:1,   unit:'°'},
],
walk:[
{key:'speed',     label:'Speed',       min:0.2,max:3,  step:0.05,unit:'×'},
{key:'stepLength',label:'Step Length', min:5,  max:55, step:1,   unit:'px'},
{key:'kneeLift',  label:'Knee Lift',   min:0,  max:35, step:1,   unit:'px'},
{key:'bounce',    label:'Bounce',      min:0,  max:20, step:0.5, unit:''},
{key:'armSwing',  label:'Arm Swing',   min:0,  max:50, step:1,   unit:'px'},
{key:'heelToe',   label:'Heel/Toe',    min:-1, max:1,  step:0.05,unit:''},
],
style:[
{key:'leanAngle',    label:'Lean',          min:-25,max:25, step:1,  unit:'°'},
{key:'bodyTilt',     label:'Body Tilt',      min:0,  max:22, step:0.5,unit:'°'},
{key:'hipSway',      label:'Hip Sway',       min:0,  max:14, step:0.5,unit:'px'},
{key:'headBob',      label:'Head Bob',       min:0,  max:14, step:0.5,unit:'px'},
{key:'headPendulum', label:'Head Swing',     min:0,  max:18, step:0.5,unit:'px'},
{key:'ghostTrail',   label:'Ghost Trail',    min:0,  max:6,  step:1,  unit:''},
],
};

// ── System presets ────────────────────────────────────────────────────────────
const SYSTEM_PRESETS = {
Normal:  {speed:1,   bounce:6,  armSwing:20,stepLength:24,kneeLift:14,torsoLen:44,legLen:68,armLen:46,headSize:14,lineWidth:3,  legBend:4,  armBend:15,leanAngle:0, bodyTilt:0, hipSway:0, headBob:2,headPendulum:2, heelToe:0.8, feel:0.5},
March:   {speed:1.3, bounce:13, armSwing:36,stepLength:20,kneeLift:32,torsoLen:46,legLen:68,armLen:46,headSize:14,lineWidth:3,  legBend:5,  armBend:30,leanAngle:3, bodyTilt:6, hipSway:0, headBob:4,headPendulum:0, heelToe:1.0, feel:0.6},
Sneak:   {speed:0.55,bounce:3,  armSwing:10,stepLength:14,kneeLift:24,torsoLen:36,legLen:68,armLen:46,headSize:14,lineWidth:3,  legBend:18, armBend:40,leanAngle:20,bodyTilt:5, hipSway:2, headBob:0,headPendulum:7, heelToe:-0.7,feel:0.3},
Strut:   {speed:0.75,bounce:18, armSwing:28,stepLength:32,kneeLift:6, torsoLen:44,legLen:68,armLen:46,headSize:14,lineWidth:3,  legBend:4,  armBend:20,leanAngle:-6,bodyTilt:11,hipSway:11,headBob:5,headPendulum:6, heelToe:0.4, feel:0.7},
Robot:   {speed:0.7, bounce:0,  armSwing:20,stepLength:22,kneeLift:24,torsoLen:44,legLen:68,armLen:46,headSize:14,lineWidth:2,  legBend:0,  armBend:0, leanAngle:0, bodyTilt:0, hipSway:0, headBob:0,headPendulum:0, heelToe:1.0, feel:0.0},
Toddler: {speed:1.1, bounce:16, armSwing:14,stepLength:14,kneeLift:18,torsoLen:30,legLen:48,armLen:32,headSize:20,lineWidth:3,  legBend:8,  armBend:28,leanAngle:5, bodyTilt:8, hipSway:6, headBob:6,headPendulum:4, heelToe:0.2, feel:0.5},
};

// ── Defaults ──────────────────────────────────────────────────────────────────
const DEF_PARAMS = {
legLen:68,armLen:46,torsoLen:44,headSize:14,footSize:12,lineWidth:3,
legBend:4,armBend:15,   // legBend:4 gives the knee a natural forward lean
speed:1,stepLength:24,kneeLift:14,bounce:6,armSwing:20,heelToe:0.8,
leanAngle:0,bodyTilt:0,hipSway:0,headBob:2,headPendulum:2,ghostTrail:0,
fps:24,animOn:1,feel:0.5,
};
const DEF_STYLE = {figureIdx:0,bgIdx:0,showGrid:false,showShadow:false,footDots:false,flipDir:false,loco:'place'};
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

// ── Theme tokens ──────────────────────────────────────────────────────────────
const T = {
paper:   '#F4EFE4', paperDk:'#E8E2D2', paperLt:'#FAF8F3',
border:  '#C8B99A', borderLt:'#DDD5C0',
ink:     '#2A2318', ink2:'#6B5E4A', ink3:'#9A8C7C', ink4:'#BFB4A4',
blue:    '#4A6FA5', // blue pencil -- active states
red:     '#B84040', // red pencil -- delete/danger
amber:   '#C07830', // warm amber -- secondary accent
};

// ── Shared UI helpers ─────────────────────────────────────────────────────────
function SliderGrid({sliders, params, onChange}) {
return (
<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'10px 24px'}}>
{sliders.map(s=>(
<div key={s.key} style={{display:'flex',flexDirection:'column',gap:2}}>
<div style={{display:'flex',justifyContent:'space-between',fontSize:10,
letterSpacing:'0.07em',color:T.ink2}}>
<span style={{textTransform:'uppercase'}}>{s.label}</span>
<span style={{color:T.ink3}}>{params[s.key]}{s.unit}</span>
</div>
<input type="range" min={s.min} max={s.max} step={s.step} value={params[s.key]}
onChange={e=>onChange(s.key,+e.target.value)}
style={{accentColor:T.blue,cursor:'pointer'}}/>
</div>
))}
</div>
);
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function WalkCycleTool() {
const canvasRef   = useRef(null);
const chartRef    = useRef(null);
const animRef     = useRef(null);
const phaseRef    = useRef(0);
const walkXRef    = useRef(W/2);
const tickRef     = useRef(0);
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
const [downloadReady, setDownloadReady] = useState(null);
const [userPresets, setUserPresets] = useState([]);
const [savingPre,   setSavingPre]   = useState(false);
const [saveName,    setSaveName]    = useState('');

live.current = {params,style,playback,keyPoses,onionOn,onionCount};
const setP  = (key,val) => setParams(p=>({...p,[key]:val}));
const setSt = (key,val) => setStyle(s=>({...s,[key]:val}));

// Load saved presets
useEffect(()=>{
(async()=>{
try{
const keys=await store.list('wcs:preset:');
const loaded=[];
for(const k of (keys?.keys||[])){const r=await store.get(k);if(r?.value) loaded.push(JSON.parse(r.value));}
setUserPresets(loaded.sort((a,b)=>a.createdAt-b.createdAt));
}catch{}
})();
},[]);

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
} else { walkXRef.current=W/2; tickRef.current-=sign*dt*pps*dir; }
} else if(st.loco!=='walk') walkXRef.current=W/2;
const cx=st.loco==='walk'?walkXRef.current:W/2;
renderFrame(canvas,phaseRef.current,cx,p,st,{keyPoseState:kp,onion:{on:oo,count:oc},tickOffset:tickRef.current});
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
if(tab==='timing'&&chartRef.current) drawTimingChart(chartRef.current,params);
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
const applyPreset=pre=>setParams(p=>({...p,...pre,fps:p.fps,animOn:p.animOn}));
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
const doExport=async mode=>{
if(downloadReady){URL.revokeObjectURL(downloadReady.url);setDownloadReady(null);}
setExporting(true);
const {params:p,style:st}=live.current;
const N=cycLen(p.fps,p.speed),dc=Math.ceil(N/p.animOn),res=expRes;
const off=document.createElement('canvas');off.width=W*res;off.height=H*res;
const oc=off.getContext('2d');
let blob,filename;
if(mode==='spritesheet'){
const sh=document.createElement('canvas');sh.width=W*res*dc;sh.height=H*res;
const sc=sh.getContext('2d');
for(let d=0;d<dc;d++){
const rp=d*p.animOn*TAU/N; oc.save();if(res>1)oc.scale(res,res);
renderFrame(off,rp,W/2,p,st,{forExport:true,transparent:expTrans});
oc.restore();sc.drawImage(off,d*W*res,0);
setExpPct(Math.round((d+1)/dc*100));await new Promise(r=>setTimeout(r,15));
}
blob=await canvasToBlob(sh);
filename=`walk_spritesheet_${dc}drw.png`;
} else {
const zip=new JSZip();
for(let d=0;d<dc;d++){
const rp=d*p.animOn*TAU/N; oc.save();if(res>1)oc.scale(res,res);
renderFrame(off,rp,W/2,p,st,{forExport:true,transparent:expTrans});
oc.restore();
zip.file(`walk_${p.animOn>1?'drw':'fr'}_${String(d+1).padStart(3,'0')}.png`, await canvasToBlob(off));
setExpPct(Math.round((d+1)/dc*50));await new Promise(r=>setTimeout(r,15));
}
blob=await zip.generateAsync({type:'blob'},meta=>{setExpPct(50+Math.round(meta.percent/2));});
filename=`walk_sequence_${dc}${p.animOn>1?'drw':'fr'}.zip`;
}
setExporting(false);setExpPct(0);
setDownloadReady({url:URL.createObjectURL(blob),filename});
};

// ── Style helpers (paper & ink theme) ───────────────────────────────────────
const tgl=(on,danger=false)=>({
background:on?(danger?'rgba(184,64,64,0.10)':'rgba(74,111,165,0.12)'):'transparent',
border:`1px solid ${on?(danger?T.red:T.blue):T.border}`,
color:on?(danger?T.red:T.blue):T.ink2,
borderRadius:3,padding:'3px 8px',cursor:'pointer',
fontSize:9,letterSpacing:'0.1em',fontFamily:'inherit',textTransform:'uppercase',transition:'all 0.12s',
});
const chip=on=>({...tgl(on),padding:'5px 14px',fontSize:10});
const tabBody={padding:'14px 16px',display:'flex',flexDirection:'column',gap:16,overflowY:'auto',maxHeight:248,background:T.paperLt};
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
boxShadow:'0 4px 16px rgba(42,35,24,0.15)'}}>

  {/* Header */}
  <div style={{padding:'5px 14px',background:T.paperDk,borderBottom:`1px solid ${T.border}`,
               display:'flex',alignItems:'center',justifyContent:'space-between'}}>
    <div style={{display:'flex',alignItems:'center',gap:8}}>
      <span style={{fontSize:11}}>✏</span>
      <span style={{fontSize:10,fontWeight:'bold',letterSpacing:'0.22em',color:T.ink,textTransform:'uppercase'}}>
        Walk Cycle Studio
      </span>
    </div>
    <span style={{fontSize:8,color:T.ink4,letterSpacing:'0.1em'}}>animation reference</span>
  </div>

  {/* Canvas */}
  <div style={{borderBottom:`1px solid ${T.border}`,boxShadow:`inset 0 1px 3px rgba(42,35,24,0.06)`}}>
    <canvas ref={canvasRef} width={W} height={H} style={{display:'block'}}/>
  </div>

  {/* Display toolbar */}
  <div style={{display:'flex',alignItems:'center',gap:8,padding:'6px 12px',
               background:T.paperDk,borderBottom:`1px solid ${T.border}`,flexWrap:'wrap',rowGap:5}}>
    <div style={{display:'flex',gap:4,alignItems:'center'}}>
      <span style={{fontSize:8,color:T.ink3,letterSpacing:'0.1em',textTransform:'uppercase',marginRight:2}}>Fig</span>
      {FIG_COLORS.map((c,i)=>(
        <button key={c.name} onClick={()=>setSt('figureIdx',i)} title={c.name}
          style={{width:14,height:14,borderRadius:'50%',background:c.stroke,cursor:'pointer',padding:0,
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
        transform:'translateX(-50%)',pointerEvents:'none',boxShadow:'0 1px 4px rgba(42,35,24,0.2)'}}/>
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
        <span style={{fontSize:13,lineHeight:1}}>{t.icon}</span>
        <span>{t.label}</span>
      </button>
    ))}
  </div>

  {/* Tab content */}
  <div style={{background:T.paperLt,minHeight:258}}>

    {tab==='body'&&<div style={tabBody}><SliderGrid sliders={TAB_SLIDERS.body} params={params} onChange={setP}/></div>}

    {tab==='walk'&&(
      <div style={tabBody}>
        <SliderGrid sliders={TAB_SLIDERS.walk} params={params} onChange={setP}/>
        <div style={divider}/>
        <p style={{fontSize:9,color:T.ink3,lineHeight:1.65,fontStyle:'italic',margin:0}}>
          Heel/Toe: +1 heel strikes first · 0 flat foot · −1 toe lands first (sneak)
        </p>
      </div>
    )}

    {tab==='style'&&<div style={tabBody}><SliderGrid sliders={TAB_SLIDERS.style} params={params} onChange={setP}/></div>}

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
          <div style={secLbl}>Built-in</div>
          <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
            {Object.keys(SYSTEM_PRESETS).map(name=>(
              <button key={name} onClick={()=>applyPreset(SYSTEM_PRESETS[name])}
                style={{background:T.paper,border:`1px solid ${T.border}`,color:T.ink2,
                        borderRadius:3,padding:'5px 14px',cursor:'pointer',fontSize:10,
                        letterSpacing:'0.08em',fontFamily:'inherit',textTransform:'uppercase'}}
                onMouseEnter={e=>e.currentTarget.style.background=T.paperDk}
                onMouseLeave={e=>e.currentTarget.style.background=T.paper}>
                {name}
              </button>
            ))}
          </div>
        </div>
        <div style={divider}/>
        <div style={sec}>
          <div style={secLbl}>My Presets {userPresets.length>0&&`(${userPresets.length})`}</div>
          {userPresets.length===0&&(
            <p style={{fontSize:10,color:T.ink4,fontStyle:'italic',margin:0}}>
              No saved presets yet — dial in your settings and save above.
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
                <button onClick={()=>applyPreset(pre.params)} style={{...tgl(false),padding:'4px 10px',fontSize:9}}>Apply</button>
                <button onClick={()=>handleDelPre(pre.id)} style={{...tgl(true,true),padding:'4px 8px',fontSize:9}}>✕</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    )}
  </div>

  {/* Export */}
  <div style={{padding:'12px 16px',background:T.paperDk,borderTop:`1px solid ${T.border}`}}>
    <div style={{fontSize:9,letterSpacing:'0.15em',color:T.ink3,textTransform:'uppercase',marginBottom:8}}>↓ Export</div>
    <div style={{display:'flex',gap:7,alignItems:'center',flexWrap:'wrap',marginBottom:10}}>
      <button onClick={()=>setExpTrans(v=>!v)} style={tgl(expTrans)}>{expTrans?'Transparent':'Opaque'}</button>
      <div style={{display:'flex',gap:3}}>
        {[1,2].map(r=><button key={r} onClick={()=>setExpRes(r)} style={chip(expRes===r)}>{r}×</button>)}
      </div>
      <span style={{fontSize:9,color:T.ink3}}>{dc} {params.animOn===2?'drawings (2s)':'frames'} · {W*expRes}×{H*expRes}px</span>
    </div>
    <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
      <button onClick={()=>doExport('sequence')} disabled={exporting}
        style={{background:exporting?T.paperDk:T.ink,border:`1px solid ${T.ink}`,
                color:exporting?T.ink3:T.paper,borderRadius:3,padding:'7px 14px',
                cursor:exporting?'not-allowed':'pointer',fontSize:10,letterSpacing:'0.1em',fontFamily:'inherit',textTransform:'uppercase'}}>
        {exporting?`${expPct}%  working...`:'↓ PNG Sequence (zip)'}
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
      Sequence exports as a single zip. Spritesheet exports as one PNG. Onion skins, key poses and ghost trail excluded.
      {params.animOn===2&&` On 2s: ${dc} unique drawings, each held 2 frames.`}
    </p>
  </div>
</div>

);
}
