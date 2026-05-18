import { useState, useEffect, useRef } from "react";

const W = 480, H = 320, GY = Math.round(H * 0.77), TAU = Math.PI * 2;

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
function drawFoot(ctx, fx, fy, lp, sz, dir, lw, am, stroke, legLen, stepLen, heelToe) {
  const angDeg = Math.asin(Math.min(0.92, stepLen/Math.max(legLen,1))) * (180/Math.PI) * heelToe * Math.sin(lp);
  const a = angDeg * Math.PI/180, hL = sz*0.38, tL = sz*0.62, ca = Math.cos(a), sa = Math.sin(a);
  ctx.save(); ctx.strokeStyle=stroke; ctx.lineWidth=lw*1.15; ctx.lineCap='round'; ctx.globalAlpha=am;
  ctx.beginPath(); ctx.moveTo(fx-hL*ca*dir, fy+hL*sa); ctx.lineTo(fx+tL*ca*dir, fy-tL*sa); ctx.stroke();
  ctx.restore();
}
function applyFeel(t, feel) {
  if (feel <= 0) return t;
  return t + feel * Math.sin(4 * Math.PI * t) / (12 * Math.PI);
}
const cycLen = (fps, speed) => Math.max(2, Math.round(fps * TAU / (speed * 2.5)));

function computePose(phase, cx, p, dir) {
  const {stepLength,kneeLift,torsoLen,legLen,armLen,headSize,legBend,armBend,
         bodyTilt,hipSway,leanAngle,headBob,headPendulum,armSwing,bounce} = p;
  const thigh=legLen*0.52, shin=legLen*0.48, uArm=armLen*0.48, fArm=armLen*0.52;
  const k = Math.min(0.98, Math.abs(Math.sin(phase))*stepLength/Math.max(legLen,1));
  const dip = Math.min(legLen*(1-Math.sqrt(1-k*k))*(1+bounce*0.10), legLen*0.28);
  const hipX = cx + Math.sin(phase)*hipSway*dir, hipY = GY-legLen+dip;
  const tilt = Math.sin(phase)*(bodyTilt*Math.PI/180)*dir + leanAngle*Math.PI/180;
  const sX = hipX+Math.sin(tilt)*torsoLen, sY = hipY-Math.cos(tilt)*torsoLen;
  const hdX = sX+Math.sin(phase)*headPendulum*dir;
  const hdY = sY-headSize*1.4-Math.abs(Math.sin(phase*2))*headBob;
  const fAn={x:cx+Math.sin(phase)*stepLength*dir, y:GY-Math.max(0,Math.cos(phase))*kneeLift};
  const bAn={x:cx+Math.sin(phase+Math.PI)*stepLength*dir, y:GY-Math.max(0,Math.cos(phase+Math.PI))*kneeLift};
  const fK=legKnee(hipX,hipY,fAn.x,fAn.y,thigh,shin,dir); fK.x+=legBend*dir; fK.y=Math.min(fK.y,GY-1);
  const bK=legKnee(hipX,hipY,bAn.x,bAn.y,thigh,shin,dir); bK.x+=legBend*dir; bK.y=Math.min(bK.y,GY-1);
  const {elbow:fE,hand:fH}=armSetup(phase+Math.PI,sX,sY,uArm,fArm,armSwing,armBend,dir);
  const {elbow:bE,hand:bH}=armSetup(phase,sX,sY,uArm,fArm,armSwing,armBend,dir);
  return {hipX,hipY,sX,sY,hdX,hdY,fAn,bAn,fK,bK,fE,fH,bE,bH};
}

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

const FIG_COLORS = [
  {name:'White',stroke:'#FFFFFF',fill:'rgba(255,255,255,0.1)'},
  {name:'Black',stroke:'#2A2A2A',fill:'rgba(0,0,0,0.1)'},
  {name:'Amber',stroke:'#F59E0B',fill:'rgba(245,158,11,0.1)'},
  {name:'Cyan', stroke:'#06B6D4',fill:'rgba(6,182,212,0.1)'},
  {name:'Rose', stroke:'#F43F5E',fill:'rgba(244,63,94,0.1)'},
  {name:'Lime', stroke:'#84CC16',fill:'rgba(132,204,22,0.1)'},
];
const BG_COLORS = [
  {name:'Studio',bg:'#111318'},{name:'Light',bg:'#F0EDE8'},
  {name:'Navy',  bg:'#0F172A'},{name:'Warm', bg:'#292319'},{name:'Slate',bg:'#1E2530'},
];
const KEY_POSES = [
  {key:'contact',label:'Contact',phase:TAU*0.25,color:'#60A5FA',fill:'rgba(96,165,250,0.07)'},
  {key:'down',   label:'Down',   phase:TAU*0.42,color:'#FBBF24',fill:'rgba(251,191,36,0.07)'},
  {key:'passing',label:'Passing',phase:TAU*0.5, color:'#34D399',fill:'rgba(52,211,153,0.07)'},
  {key:'up',     label:'Up',     phase:TAU*0.75,color:'#F87171',fill:'rgba(248,113,113,0.07)'},
];

function renderFrame(canvas, rawPhase, cx, p, st, opts={}) {
  const {forExport=false,transparent=false,keyPoseState=null,onion=null,tickOffset=0} = opts;
  const ctx = canvas.getContext('2d');
  const col = FIG_COLORS[st.figureIdx], bg = BG_COLORS[st.bgIdx];
  const dir = st.flipDir ? -1 : 1, light = bg.bg === '#F0EDE8';
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
  if(!forExport){
    const norm=((snappedRaw%TAU)+TAU)%TAU;
    const frameN=Math.min(Math.floor(norm/TAU*N)+1,N);
    const totalDrw=Math.ceil(N/p.animOn), drwN=Math.min(Math.ceil(frameN/p.animOn),totalDrw);
    const l1=p.animOn===1?`Fr ${frameN} / ${N}`:`Fr ${frameN} / ${N}  (Drw ${drwN} / ${totalDrw})`;
    const l2=`${N} fr · ${(N/p.fps).toFixed(2)}s @ ${p.fps}fps`;
    ctx.save(); ctx.font='bold 10px Courier New'; const tw1=ctx.measureText(l1).width;
    ctx.font='9px Courier New'; const tw2=ctx.measureText(l2).width;
    const bw=Math.max(tw1,tw2)+16,bh=32,bx=W-bw-6,by=6;
    ctx.fillStyle=light?'rgba(240,237,232,0.88)':'rgba(10,11,14,0.82)';
    ctx.beginPath();ctx.roundRect(bx,by,bw,bh,3);ctx.fill();
    ctx.fillStyle=light?'#3A3835':'#C8A96E'; ctx.textAlign='left'; ctx.textBaseline='top';
    ctx.font='bold 10px Courier New'; ctx.fillText(l1,bx+8,by+5);
    ctx.fillStyle=light?'#8A8580':'#5A5650'; ctx.font='9px Courier New'; ctx.fillText(l2,bx+8,by+19);
    ctx.restore();
  }
}

function drawTimingChart(canvas, p) {
  const ctx=canvas.getContext('2d'); const cw=canvas.width,ch=canvas.height;
  ctx.clearRect(0,0,cw,ch); ctx.fillStyle='#0A0B0E'; ctx.fillRect(0,0,cw,ch);
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
    {label:'Body',data:norm(bodyVals),invert:true, color:'#7C8CF8'},
    {label:'Foot',data:norm(footVals),invert:false,color:'#6EE7B7'},
    {label:'Arm', data:norm(armVals), invert:false,color:'#FCD34D'},
  ];
  lanes.forEach(({label,data,invert,color},li)=>{
    const baseY=padY+li*(laneH+gap),trackY=baseY+10,trackH=laneH-10;
    ctx.fillStyle='#2A2825'; ctx.font='8px Courier New'; ctx.textAlign='right';
    ctx.fillText(label,padX-5,trackY+trackH/2+3);
    ctx.fillStyle='#0D0E0C'; ctx.fillRect(padX,trackY,chartW,trackH);
    ctx.beginPath();
    for(let i=0;i<N;i++){
      const x=padX+(i+0.5)/N*chartW, n=invert?1-data[i]:data[i], y=trackY+2+(1-n)*(trackH-4);
      i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
    }
    ctx.strokeStyle=color+'36'; ctx.lineWidth=1; ctx.stroke();
    for(let i=0;i<N;i++){
      const x=padX+(i+0.5)/N*chartW, n=invert?1-data[i]:data[i], y=trackY+2+(1-n)*(trackH-4);
      const isDrw=i%p.animOn===0;
      ctx.beginPath(); ctx.arc(x,y,isDrw?2.5:1.5,0,TAU);
      if(isDrw){ctx.fillStyle=color;ctx.fill();}
      else{ctx.strokeStyle=color+'55';ctx.lineWidth=0.8;ctx.stroke();}
    }
  });
  const axY=padY+lanes.length*(laneH+gap)+4;
  ctx.fillStyle='#2E2C28'; ctx.font='7px Courier New'; ctx.textAlign='center';
  [0,Math.round(N/4),Math.round(N/2),Math.round(3*N/4),N-1].forEach(i=>{
    ctx.fillText(i+1,padX+(i+0.5)/N*chartW,axY+8);
  });
  if(p.animOn>1){
    ctx.fillStyle='#3A3835'; ctx.font='7px Courier New'; ctx.textAlign='right';
    ctx.fillText('● drawing  ○ held',cw-4,ch-2);
  }
}

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
    {key:'leanAngle',    label:'Lean',       min:-25,max:25, step:1,   unit:'°'},
    {key:'bodyTilt',     label:'Body Tilt',  min:0,  max:22, step:0.5, unit:'°'},
    {key:'hipSway',      label:'Hip Sway',   min:0,  max:14, step:0.5, unit:'px'},
    {key:'headBob',      label:'Head Bob',   min:0,  max:14, step:0.5, unit:'px'},
    {key:'headPendulum', label:'Head Swing', min:0,  max:18, step:0.5, unit:'px'},
    {key:'ghostTrail',   label:'Ghost Trail',min:0,  max:6,  step:1,   unit:''},
  ],
};

const SYSTEM_PRESETS = {
  Normal:  {speed:1,   bounce:6,  armSwing:20,stepLength:24,kneeLift:14,torsoLen:44,legLen:68,armLen:46,headSize:14,lineWidth:3,legBend:4, armBend:15,leanAngle:0, bodyTilt:0, hipSway:0, headBob:2,headPendulum:2, heelToe:0.8, feel:0.5},
  March:   {speed:1.3, bounce:13, armSwing:36,stepLength:20,kneeLift:32,torsoLen:46,legLen:68,armLen:46,headSize:14,lineWidth:3,legBend:5, armBend:30,leanAngle:3, bodyTilt:6, hipSway:0, headBob:4,headPendulum:0, heelToe:1.0, feel:0.6},
  Sneak:   {speed:0.55,bounce:3,  armSwing:10,stepLength:14,kneeLift:24,torsoLen:36,legLen:68,armLen:46,headSize:14,lineWidth:3,legBend:18,armBend:40,leanAngle:20,bodyTilt:5, hipSway:2, headBob:0,headPendulum:7, heelToe:-0.7,feel:0.3},
  Strut:   {speed:0.75,bounce:18, armSwing:28,stepLength:32,kneeLift:6, torsoLen:44,legLen:68,armLen:46,headSize:14,lineWidth:3,legBend:4, armBend:20,leanAngle:-6,bodyTilt:11,hipSway:11,headBob:5,headPendulum:6, heelToe:0.4, feel:0.7},
  Robot:   {speed:0.7, bounce:0,  armSwing:20,stepLength:22,kneeLift:24,torsoLen:44,legLen:68,armLen:46,headSize:14,lineWidth:2,legBend:0, armBend:0, leanAngle:0, bodyTilt:0, hipSway:0, headBob:0,headPendulum:0, heelToe:1.0, feel:0.0},
  Toddler: {speed:1.1, bounce:16, armSwing:14,stepLength:14,kneeLift:18,torsoLen:30,legLen:48,armLen:32,headSize:20,lineWidth:3,legBend:8, armBend:28,leanAngle:5, bodyTilt:8, hipSway:6, headBob:6,headPendulum:4, heelToe:0.2, feel:0.5},
};

const DEF_PARAMS = {
  legLen:68,armLen:46,torsoLen:44,headSize:14,footSize:8,lineWidth:3,
  legBend:4,armBend:15,
  speed:1,stepLength:24,kneeLift:14,bounce:6,armSwing:20,heelToe:0.8,
  leanAngle:0,bodyTilt:0,hipSway:0,headBob:2,headPendulum:2,ghostTrail:0,
  fps:24,animOn:1,feel:0.5,
};
const DEF_STYLE = {figureIdx:0,bgIdx:0,showGrid:false,showShadow:false,footDots:false,flipDir:false,loco:'place'};

const store = {
  async get(k){try{return await window.storage.get(k);}catch{return null;}},
  async set(k,v){try{return await window.storage.set(k,v);}catch{return null;}},
  async del(k){try{return await window.storage.delete(k);}catch{return null;}},
  async list(pfx){try{return await window.storage.list(pfx);}catch{return {keys:[]};} },
};

function makeThumbnail(params, style) {
  try {
    const off = document.createElement('canvas'); off.width=W; off.height=H;
    renderFrame(off, TAU*0.5, W/2, params, style, {forExport:true});
    const th = document.createElement('canvas'); th.width=120; th.height=80;
    th.getContext('2d').drawImage(off,0,0,120,80);
    return th.toDataURL('image/jpeg',0.75);
  } catch{return null;}
}

function SliderGrid({sliders, params, onChange}) {
  return (
    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'10px 24px'}}>
      {sliders.map(s=>(
        <div key={s.key} style={{display:'flex',flexDirection:'column',gap:2}}>
          <div style={{display:'flex',justifyContent:'space-between',fontSize:10,letterSpacing:'0.07em',color:'#5A5650'}}>
            <span style={{textTransform:'uppercase'}}>{s.label}</span>
            <span style={{color:'#A8A090'}}>{params[s.key]}{s.unit}</span>
          </div>
          <input type="range" min={s.min} max={s.max} step={s.step} value={params[s.key]}
            onChange={e=>onChange(s.key,+e.target.value)}
            style={{accentColor:'#C8A96E',cursor:'pointer'}}/>
        </div>
      ))}
    </div>
  );
}

export default function WalkCycleTool() {
  const canvasRef=useRef(null),chartRef=useRef(null),animRef=useRef(null);
  const phaseRef=useRef(0),walkXRef=useRef(W/2),tickRef=useRef(0);
  const lastTRef=useRef(null),live=useRef({});
  const scrubRef=useRef(null),scrubBarRef=useRef(null),scrubDrag=useRef(false);
  const [params,setParams]=useState(DEF_PARAMS);
  const [style,setStyle]=useState(DEF_STYLE);
  const [tab,setTab]=useState('walk');
  const [playback,setPlayback]=useState('forward');
  const [keyPoses,setKeyPoses]=useState({contact:false,down:false,passing:false,up:false});
  const [onionOn,setOnionOn]=useState(false);
  const [onionCount,setOnionCount]=useState(2);
  const [exporting,setExporting]=useState(false);
  const [expPct,setExpPct]=useState(0);
  const [expRes,setExpRes]=useState(1);
  const [expTrans,setExpTrans]=useState(false);
  const [userPresets,setUserPresets]=useState([]);
  const [savingPre,setSavingPre]=useState(false);
  const [saveName,setSaveName]=useState('');
  live.current={params,style,playback,keyPoses,onionOn,onionCount};
  const setP=(key,val)=>setParams(prev=>({...prev,[key]:val}));
  const setSt=(key,val)=>setStyle(prev=>({...prev,[key]:val}));
  useEffect(()=>{
    (async()=>{
      try{
        const keys=await store.list('wcs:preset:');
        const loaded=[];
        for(const k of (keys?.keys||[])){
          const r=await store.get(k);
          if(r?.value) loaded.push(JSON.parse(r.value));
        }
        setUserPresets(loaded.sort((a,b)=>a.createdAt-b.createdAt));
      }catch{}
    })();
  },[]);
  useEffect(()=>{
    const canvas=canvasRef.current; if(!canvas) return;
    const loop=ts=>{
      if(!lastTRef.current) lastTRef.current=ts;
      const dt=Math.min((ts-lastTRef.current)/1000,0.05); lastTRef.current=ts;
      const {params:p,style:st,playback:pb,keyPoses:kp,onionOn:oo,onionCount:oc}=live.current;
      const rate=p.speed*2.5,dir=st.flipDir?-1:1;
      if(pb==='forward'||pb==='backward'){
        const sign=pb==='forward'?1:-1;
        phaseRef.current+=sign*dt*rate;
        const pps=(p.stepLength*2*rate)/Math.PI;
        if(st.loco==='walk'){
          walkXRef.current+=sign*dt*pps*dir;
          if(walkXRef.current>W+90) walkXRef.current=-90;
          if(walkXRef.current<-90) walkXRef.current=W+90;
        } else {
          walkXRef.current=W/2;
          tickRef.current-=sign*dt*pps*dir;
        }
      } else if(st.loco!=='walk') walkXRef.current=W/2;
      const cx=st.loco==='walk'?walkXRef.current:W/2;
      renderFrame(canvas,phaseRef.current,cx,p,st,{keyPoseState:kp,onion:{on:oo,count:oc},tickOffset:tickRef.current});
      const N=cycLen(p.fps,p.speed),snapStep=TAU/N*p.animOn;
      const snR=Math.round(phaseRef.current/snapStep)*snapStep;
      const frac=((snR%TAU)+TAU)%TAU/TAU;
      if(scrubRef.current) scrubRef.current.style.left=`${frac*100}%`;
      animRef.current=requestAnimationFrame(loop);
    };
    animRef.current=requestAnimationFrame(loop);
    return ()=>cancelAnimationFrame(animRef.current);
  },[]);
  useEffect(()=>{
    if(tab==='timing'&&chartRef.current) drawTimingChart(chartRef.current,params);
  },[tab,params.fps,params.animOn,params.feel,params.speed,params.stepLength,params.legLen,params.kneeLift,params.armSwing,params.bounce]);
  function getScrubFrac(e){const rect=scrubBarRef.current.getBoundingClientRect();return Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width));}
  function onScrubDown(e){scrubDrag.current=true;phaseRef.current=getScrubFrac(e)*TAU;setPlayback('paused');}
  function onScrubMove(e){if(scrubDrag.current) phaseRef.current=getScrubFrac(e)*TAU;}
  function onScrubUp(){scrubDrag.current=false;}
  function stepFwd(){const N=cycLen(live.current.params.fps,live.current.params.speed);setPlayback('paused');phaseRef.current+=TAU/N*live.current.params.animOn;}
  function stepBwd(){const N=cycLen(live.current.params.fps,live.current.params.speed);setPlayback('paused');phaseRef.current-=TAU/N*live.current.params.animOn;}
  function applySystemPreset(name){setParams(prev=>({...prev,...SYSTEM_PRESETS[name],fps:prev.fps,animOn:prev.animOn}));}
  function applyUserPreset(pre){setParams(prev=>({...prev,...pre.params,fps:prev.fps,animOn:prev.animOn}));}
  async function handleSavePreset(){
    if(!saveName.trim()) return;
    const id=`${Date.now()}`;
    const thumbnail=makeThumbnail(live.current.params,live.current.style);
    const preset={id,name:saveName.trim(),createdAt:Date.now(),params:{...live.current.params},thumbnail};
    await store.set(`wcs:preset:${id}`,JSON.stringify(preset));
    setUserPresets(prev=>[...prev,preset]);setSaveName('');setSavingPre(false);
  }
  async function handleDeletePreset(id){
    await store.del(`wcs:preset:${id}`);
    setUserPresets(prev=>prev.filter(p=>p.id!==id));
  }
  async function doExport(mode){
    setExporting(true);
    const {params:p,style:st}=live.current;
    const N=cycLen(p.fps,p.speed),drawCount=Math.ceil(N/p.animOn),res=expRes;
    const off=document.createElement('canvas');off.width=W*res;off.height=H*res;
    const octx=off.getContext('2d');
    if(mode==='spritesheet'){
      const sh=document.createElement('canvas');sh.width=W*res*drawCount;sh.height=H*res;
      const sc=sh.getContext('2d');
      for(let d=0;d<drawCount;d++){
        const rawPh=d*p.animOn*TAU/N;
        octx.save();if(res>1)octx.scale(res,res);
        renderFrame(off,rawPh,W/2,p,st,{forExport:true,transparent:expTrans});
        octx.restore();sc.drawImage(off,d*W*res,0);
        setExpPct(Math.round((d+1)/drawCount*100));
        await new Promise(r=>setTimeout(r,15));
      }
      const a=document.createElement('a');a.href=sh.toDataURL('image/png');a.download=`walk_spritesheet_${drawCount}drw.png`;a.click();
    } else {
      for(let d=0;d<drawCount;d++){
        const rawPh=d*p.animOn*TAU/N;
        octx.save();if(res>1)octx.scale(res,res);
        renderFrame(off,rawPh,W/2,p,st,{forExport:true,transparent:expTrans});
        octx.restore();
        const prefix=p.animOn>1?'drw':'fr';
        const a=document.createElement('a');a.href=off.toDataURL('image/png');a.download=`walk_${prefix}_${String(d+1).padStart(3,'0')}.png`;a.click();
        setExpPct(Math.round((d+1)/drawCount*100));
        await new Promise(r=>setTimeout(r,90));
      }
    }
    setExporting(false);setExpPct(0);
  }
  const lbl={fontSize:10,letterSpacing:'0.12em',color:'#3E3C38',textTransform:'uppercase',marginBottom:5};
  const tgl=(on)=>({background:on?'rgba(200,169,110,0.12)':'transparent',border:`1px solid ${on?'rgba(200,169,110,0.38)':'#1E1C18'}`,color:on?'#C8A96E':'#484440',borderRadius:3,padding:'3px 7px',cursor:'pointer',fontSize:9,letterSpacing:'0.1em',fontFamily:'inherit',textTransform:'uppercase'});
  const chip=(on)=>({...tgl(on),padding:'4px 13px',fontSize:10,letterSpacing:'0.08em'});
  const tabBody={padding:'14px 16px',display:'flex',flexDirection:'column',gap:16,overflowY:'auto',maxHeight:248};
  const section={display:'flex',flexDirection:'column',gap:8};
  const secLabel={fontSize:9,letterSpacing:'0.18em',color:'#3A3835',textTransform:'uppercase'};
  const N=cycLen(params.fps,params.speed),drawCount=Math.ceil(N/params.animOn);
  return (
    <div style={{fontFamily:"'Courier New',monospace",background:'#0D0E12',color:'#C8C0B0',display:'flex',flexDirection:'column',width:W,userSelect:'none',borderRadius:4,overflow:'hidden'}}>
      <canvas ref={canvasRef} width={W} height={H} style={{display:'block',flexShrink:0}}/>
      <div style={{display:'flex',alignItems:'center',gap:10,padding:'6px 12px',background:'#0B0C10',borderBottom:'1px solid #171820',flexWrap:'wrap',rowGap:5}}>
        <div style={{display:'flex',gap:4,alignItems:'center'}}>
          <span style={{fontSize:8,color:'#3A3835',letterSpacing:'0.1em',textTransform:'uppercase',marginRight:2}}>Fig</span>
          {FIG_COLORS.map((c,i)=>(<button key={c.name} onClick={()=>setSt('figureIdx',i)} title={c.name} style={{width:13,height:13,borderRadius:'50%',background:c.stroke,cursor:'pointer',padding:0,border:i===style.figureIdx?'2px solid #C8A96E':'2px solid transparent'}}/>))}
        </div>
        <div style={{width:1,height:14,background:'#1E1C18'}}/>
        <div style={{display:'flex',gap:4,alignItems:'center'}}>
          <span style={{fontSize:8,color:'#3A3835',letterSpacing:'0.1em',textTransform:'uppercase',marginRight:2}}>BG</span>
          {BG_COLORS.map((c,i)=>(<button key={c.name} onClick={()=>setSt('bgIdx',i)} title={c.name} style={{width:13,height:13,borderRadius:'50%',background:c.bg,cursor:'pointer',padding:0,border:i===style.bgIdx?'2px solid #C8A96E':'2px solid #2A2820'}}/>))}
        </div>
        <div style={{width:1,height:14,background:'#1E1C18'}}/>
        {[['Grid','showGrid'],['Shadow','showShadow'],['Dots','footDots'],['Flip','flipDir']].map(([l,k])=>(<button key={k} onClick={()=>setSt(k,!style[k])} style={tgl(style[k])}>{l}</button>))}
        <div style={{marginLeft:'auto',display:'flex',gap:3}}>
          <button onClick={()=>setSt('loco','place')} style={tgl(style.loco==='place')}>In Place</button>
          <button onClick={()=>setSt('loco','walk')} style={tgl(style.loco==='walk')}>Walking</button>
        </div>
      </div>
      <div style={{display:'flex',alignItems:'center',gap:6,padding:'7px 12px',background:'#0B0C10',borderBottom:'1px solid #131418'}}>
        <button onClick={()=>{phaseRef.current=0;setPlayback('paused');}} style={tgl(false)}>⏮</button>
        <button onClick={stepBwd} style={tgl(false)}>‹</button>
        <button onClick={()=>setPlayback(v=>v==='forward'?'paused':'forward')} style={tgl(playback==='forward')}>{playback==='forward'?'⏸':'▶'}</button>
        <button onClick={()=>setPlayback(v=>v==='backward'?'paused':'backward')} style={{...tgl(playback==='backward'),fontSize:10}}>◀</button>
        <button onClick={stepFwd} style={tgl(false)}>›</button>
        <div style={{flex:1}}/>
        <button onClick={()=>setOnionOn(v=>!v)} style={{...tgl(onionOn),fontSize:9}}>Onion</button>
        {onionOn&&<>
          <button onClick={()=>setOnionCount(v=>Math.max(1,v-1))} style={{...tgl(false),padding:'2px 6px'}}>−</button>
          <span style={{fontSize:10,color:'#7A7060',minWidth:12,textAlign:'center'}}>{onionCount}</span>
          <button onClick={()=>setOnionCount(v=>Math.min(5,v+1))} style={{...tgl(false),padding:'2px 6px'}}>+</button>
        </>}
        <button onClick={()=>setParams(p=>({...p,...DEF_PARAMS,fps:p.fps,animOn:p.animOn}))} style={{...tgl(false),marginLeft:6}}>↺</button>
      </div>
      <div style={{padding:'8px 12px 4px',background:'#0B0C10',borderBottom:'1px solid #131418'}}>
        <div ref={scrubBarRef} onMouseDown={onScrubDown} onMouseMove={onScrubMove} onMouseUp={onScrubUp} onMouseLeave={onScrubUp}
             style={{position:'relative',height:4,background:'#181A1E',borderRadius:2,cursor:'pointer',marginBottom:8}}>
          {KEY_POSES.map(kp=>(<div key={kp.key} style={{position:'absolute',top:0,bottom:0,width:2,borderRadius:1,background:keyPoses[kp.key]?kp.color:'#2A2825',left:`${kp.phase/TAU*100}%`}}/>))}
          <div ref={scrubRef} style={{position:'absolute',top:-4,left:'0%',width:12,height:12,background:'#C8A96E',borderRadius:'50%',transform:'translateX(-50%)',pointerEvents:'none'}}/>
        </div>
        <div style={{display:'flex',gap:5}}>
          {KEY_POSES.map(kp=>(
            <button key={kp.key} onClick={()=>setKeyPoses(v=>({...v,[kp.key]:!v[kp.key]}))} style={{...tgl(keyPoses[kp.key]),borderColor:keyPoses[kp.key]?kp.color:'#1E1C18',color:keyPoses[kp.key]?kp.color:'#3A3835',display:'flex',alignItems:'center',gap:4}}>
              <span style={{width:5,height:5,borderRadius:'50%',display:'inline-block',flexShrink:0,background:keyPoses[kp.key]?kp.color:'#2A2820',boxShadow:keyPoses[kp.key]?`0 0 4px ${kp.color}`:'none'}}/>{kp.label}
            </button>
          ))}
        </div>
      </div>
      <div style={{display:'flex',background:'#0D0E12',borderBottom:'1px solid #171820'}}>
        {['body','walk','style','timing','presets'].map(t=>(
          <button key={t} onClick={()=>setTab(t)} style={{flex:1,background:tab===t?'#111318':'transparent',border:'none',borderBottom:tab===t?'2px solid #C8A96E':'2px solid transparent',color:tab===t?'#C8A96E':'#484440',cursor:'pointer',padding:'9px 4px',fontSize:10,letterSpacing:'0.1em',fontFamily:'inherit',textTransform:'uppercase',transition:'all 0.1s'}}>{t}</button>
        ))}
      </div>
      <div style={{background:'#0D0E12',minHeight:258}}>
        {tab==='body'&&(<div style={tabBody}><SliderGrid sliders={TAB_SLIDERS.body} params={params} onChange={setP}/></div>)}
        {tab==='walk'&&(
          <div style={tabBody}>
            <SliderGrid sliders={TAB_SLIDERS.walk} params={params} onChange={setP}/>
            <div style={{display:'flex',flexDirection:'column',gap:3,paddingTop:4,borderTop:'1px solid #141618'}}>
              <div style={{fontSize:9,color:'#3A3835',letterSpacing:'0.1em',textTransform:'uppercase',marginBottom:2}}>Heel/Toe guide</div>
              <div style={{fontSize:9,color:'#2E2C28',lineHeight:1.6}}>+1 = heel strikes first · 0 = flat · −1 = toe lands first</div>
            </div>
          </div>
        )}
        {tab==='style'&&(<div style={tabBody}><SliderGrid sliders={TAB_SLIDERS.style} params={params} onChange={setP}/></div>)}
        {tab==='timing'&&(
          <div style={tabBody}>
            <div style={{display:'flex',gap:20,flexWrap:'wrap'}}>
              <div style={section}>
                <div style={secLabel}>FPS</div>
                <div style={{display:'flex',gap:5}}>{[12,24,25,30].map(f=>(<button key={f} onClick={()=>setP('fps',f)} style={chip(params.fps===f)}>{f}</button>))}</div>
              </div>
              <div style={section}>
                <div style={secLabel}>Animate On</div>
                <div style={{display:'flex',gap:5}}>{[[1,'1s'],[2,'2s']].map(([n,l])=>(<button key={n} onClick={()=>setP('animOn',n)} style={chip(params.animOn===n)}>{l}</button>))}</div>
              </div>
            </div>
            <div style={{fontSize:9,color:'#3A3835',lineHeight:1.7,padding:'6px 8px',background:'#0A0B0E',borderRadius:3,border:'1px solid #141618'}}>
              {N} frames · {drawCount} drawings · {(N/params.fps).toFixed(2)}s{params.animOn===2&&' · each held 2 frames'}
            </div>
            <div style={section}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <div style={secLabel}>Feel</div>
                <span style={{fontSize:10,color:'#A8A090'}}>{params.feel<=0.15?'Linear':params.feel<=0.4?'Crisp':params.feel<=0.62?'Natural':params.feel<=0.82?'Weighted':'Heavy'}</span>
              </div>
              <input type="range" min={0} max={1} step={0.01} value={params.feel} onChange={e=>setP('feel',+e.target.value)} style={{accentColor:'#C8A96E',cursor:'pointer'}}/>
              <div style={{display:'flex',justifyContent:'space-between',fontSize:8,color:'#2E2C28',marginTop:2}}><span>Linear</span><span>Natural</span><span>Heavy</span></div>
            </div>
            <div style={section}>
              <div style={secLabel}>Spacing Chart</div>
              <canvas ref={chartRef} width={440} height={102} style={{width:'100%',display:'block',borderRadius:3,border:'1px solid #141618'}}/>
              <div style={{display:'flex',gap:14,marginTop:4}}>
                {[['#7C8CF8','Body'],['#6EE7B7','Foot'],['#FCD34D','Arm']].map(([c,l])=>(
                  <div key={l} style={{display:'flex',alignItems:'center',gap:4,fontSize:9,color:'#484440'}}><div style={{width:7,height:7,borderRadius:'50%',background:c,flexShrink:0}}/>{l}</div>
                ))}
              </div>
            </div>
          </div>
        )}
        {tab==='presets'&&(
          <div style={tabBody}>
            <div style={section}>
              <div style={secLabel}>Save Current</div>
              {!savingPre?(
                <button onClick={()=>setSavingPre(true)} style={{...tgl(false),padding:'6px 14px',fontSize:10,alignSelf:'flex-start'}}>+ Save as Preset</button>
              ):(
                <div style={{display:'flex',gap:7}}>
                  <input value={saveName} onChange={e=>setSaveName(e.target.value)} placeholder="Name..." onKeyDown={e=>e.key==='Enter'&&handleSavePreset()} autoFocus
                    style={{flex:1,background:'#14120E',border:'1px solid #302C24',color:'#C8C0B0',borderRadius:3,padding:'5px 9px',fontSize:11,fontFamily:'inherit',outline:'none'}}/>
                  <button onClick={handleSavePreset} style={{background:'#C8A96E',border:'none',color:'#0A0800',borderRadius:3,padding:'5px 12px',cursor:'pointer',fontSize:10,fontFamily:'inherit',fontWeight:'bold'}}>Save</button>
                  <button onClick={()=>{setSavingPre(false);setSaveName('');}} style={{...tgl(false),padding:'5px 9px'}}>✕</button>
                </div>
              )}
            </div>
            <div style={section}>
              <div style={secLabel}>Built-in</div>
              <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                {Object.keys(SYSTEM_PRESETS).map(name=>(
                  <button key={name} onClick={()=>applySystemPreset(name)}
                    style={{background:'#141210',border:'1px solid #2A2620',color:'#C8A96E',borderRadius:3,padding:'5px 14px',cursor:'pointer',fontSize:10,letterSpacing:'0.08em',fontFamily:'inherit',textTransform:'uppercase',transition:'background 0.1s'}}
                    onMouseEnter={e=>e.currentTarget.style.background='#1E1A14'}
                    onMouseLeave={e=>e.currentTarget.style.background='#141210'}>{name}</button>
                ))}
              </div>
            </div>
            <div style={section}>
              <div style={secLabel}>My Presets{userPresets.length>0&&` (${userPresets.length})`}</div>
              {userPresets.length===0&&(<div style={{fontSize:10,color:'#2A2825',padding:'12px 0',textAlign:'center'}}>No presets yet.</div>)}
              <div style={{display:'flex',flexDirection:'column',gap:7}}>
                {userPresets.map(pre=>(
                  <div key={pre.id} style={{display:'flex',alignItems:'center',gap:9,background:'#0E100F',border:'1px solid #1A1814',borderRadius:4,padding:'8px 10px'}}>
                    {pre.thumbnail&&(<img src={pre.thumbnail} alt="" style={{width:60,height:40,objectFit:'cover',borderRadius:2,flexShrink:0,opacity:0.9}}/>)}
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:12,color:'#C8C0B0',fontWeight:'bold',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{pre.name}</div>
                      <div style={{fontSize:9,color:'#2E2C28',marginTop:2}}>{new Date(pre.createdAt).toLocaleDateString()}</div>
                    </div>
                    <div style={{display:'flex',gap:5}}>
                      <button onClick={()=>applyUserPreset(pre)} style={{...tgl(false),padding:'4px 10px',fontSize:9}}>Apply</button>
                      <button onClick={()=>handleDeletePreset(pre.id)} style={{...tgl(false),padding:'4px 8px',fontSize:9,color:'#7A3A3A',borderColor:'#3A2020'}}>✕</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
      <div style={{padding:'12px 16px',background:'#0A0B0E',borderTop:'1px solid #131418'}}>
        <div style={lbl}>Export</div>
        <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap',marginBottom:10}}>
          <button onClick={()=>setExpTrans(v=>!v)} style={tgl(expTrans)}>{expTrans?'Transparent':'Opaque'}</button>
          <div style={{display:'flex',gap:3}}>{[1,2].map(r=>(<button key={r} onClick={()=>setExpRes(r)} style={tgl(expRes===r)}>{r}×</button>))}</div>
          <span style={{fontSize:9,color:'#3A3835',marginLeft:4}}>{drawCount} {params.animOn===2?'drawings':'frames'} · {W*expRes}×{H*expRes}px</span>
        </div>
        <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
          <button onClick={()=>doExport('sequence')} disabled={exporting} style={{background:'#1A1714',border:'1px solid #302C24',color:exporting?'#5A5650':'#C8A96E',borderRadius:3,padding:'7px 14px',cursor:exporting?'not-allowed':'pointer',fontSize:10,letterSpacing:'0.1em',fontFamily:'inherit',textTransform:'uppercase'}}>{exporting?`${expPct}%…`:'↓ PNG Sequence'}</button>
          <button onClick={()=>doExport('spritesheet')} disabled={exporting} style={{background:'#141C20',border:'1px solid #243040',color:exporting?'#5A5650':'#7EC8E3',borderRadius:3,padding:'7px 14px',cursor:exporting?'not-allowed':'pointer',fontSize:10,letterSpacing:'0.1em',fontFamily:'inherit',textTransform:'uppercase'}}>{exporting?`${expPct}%`:'↓ Spritesheet'}</button>
        </div>
        {exporting&&(<div style={{marginTop:8,height:2,background:'#1A1814',borderRadius:1}}><div style={{height:'100%',background:'#C8A96E',width:`${expPct}%`,transition:'width 0.1s',borderRadius:1}}/></div>)}
        <div style={{marginTop:7,fontSize:9,color:'#2A2825',lineHeight:1.6}}>Exports in-place clean frames — onion, key poses and ghost excluded.{params.animOn===2&&` On 2s: ${drawCount} unique drawings.`}</div>
      </div>
    </div>
  );
}
