/* Bike network builder — Leaflet + Geoman, talks to editor.py. */
"use strict";

/* Color constants mirror bikenetwork/render_map.py (Okabe-Ito palette). */
const PHASE_COLORS = {1:"#0072B2",2:"#009E73",3:"#D55E00",4:"#E69F00",5:"#56B4E9"};
const TYPE_COLORS = {
  quick_build_separated:"#0072B2", concrete_separated:"#D55E00",
  shared_use_path:"#009E73", buffered_painted:"#E69F00",
  neighborway:"#56B4E9",
  pedestrianized:"#CC79A7"  // shared with STATE on purpose (phase mode only)
};
const TYPE_LABELS = {
  quick_build_separated:"Quick-build separated lane",
  concrete_separated:"Concrete-protected lane",
  shared_use_path:"Shared-use path",
  buffered_painted:"Buffered painted lane (interim)",
  neighborway:"Neighborway (calm shared street)",
  pedestrianized:"Pedestrianized street"
};
const SINGLE="#0072B2", EXISTING="#000000", FUNDED="#E69F00", STATE="#CC79A7", BOUNDARY="#777777";

/* Spot (point) improvements — glyphs/labels mirror bikenetwork/render_map.py. */
const SPOT_GLYPHS = {
  speed_hump:"∩", raised_crosswalk:"▬", raised_intersection:"◆",
  curb_extension:"◖", bike_parking:"P", street_trees:"T", other:"●"
};
const SPOT_LABELS = {
  speed_hump:"Speed hump", raised_crosswalk:"Raised crosswalk",
  raised_intersection:"Raised intersection", curb_extension:"Curb extension",
  bike_parking:"Bike parking", street_trees:"Street trees", other:"Spot improvement"
};
const SPOT_PROPOSED="#1a1a1a", SPOT_EXISTING="#707070";

let map, networkGroup, boundaryGroup, arrowsGroup, spotsGroup;
let features = [];          // [{props, layer}]
let spots = [];             // [{props, marker}] — point improvements
let selected = null;
let selectedSpot = null;
let placingSpot = false;    // "+ Add spot" waits for the next map click
let config = {city:"Malden", phases:[]};
let options = {types:[], statuses:[], jurisdictions:[], color_modes:["phase","type","single"]};
let colorMode = "type";      // path type excites people; phases are for nerds
let dirty = false;
let editMode = false;
let combineFrom = null;      // set while "Combine…" waits for a second path
let phaseView = "all";       // "all" | "0" (today) | a phase number as string

/* ---------- geometry helpers ---------- */
function haversineMiles(a, b){
  const R=3958.7613, rad=Math.PI/180;
  const dLat=(b.lat-a.lat)*rad, dLng=(b.lng-a.lng)*rad;
  const la1=a.lat*rad, la2=b.lat*rad;
  const h=Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.sqrt(h));
}
/* A feature's geometry is one or more segments (a combined path — e.g. a
   trail split by street crossings — is one feature with several). */
function segsOf(layer){
  const l=layer.getLatLngs();
  return (l.length && Array.isArray(l[0])) ? l : [l];
}
function setSegs(layer, segs){ layer.setLatLngs(segs.length===1?segs[0]:segs); }
function featureMiles(f){
  let m=0;
  for(const pts of segsOf(f.layer))
    for(let i=0;i<pts.length-1;i++) m+=haversineMiles(pts[i],pts[i+1]);
  return m;
}
function latlngsFromGeometry(geom){
  // GeoJSON LineString / MultiLineString -> Leaflet latlngs (flat or nested).
  if(!geom) return null;
  let segs = geom.type==="MultiLineString" ? geom.coordinates
           : geom.type==="LineString" ? [geom.coordinates] : [];
  segs = (segs||[]).filter(s=>s && s.length>=2)
                   .map(s=>s.map(c=>L.latLng(c[1],c[0])));
  if(!segs.length) return null;
  return segs.length===1 ? segs[0] : segs;
}

/* ---------- styling ---------- */
function colorFor(p){
  if(colorMode==="single") return SINGLE;
  if(colorMode==="type") return TYPE_COLORS[p.type]||"#444";
  if(p.status==="existing") return EXISTING;
  if(p.status==="funded") return FUNDED;
  if(p.jurisdiction==="state") return STATE;
  return PHASE_COLORS[p.phase]||"#444";
}
function styleFor(p){
  let weight=6, dash=null;
  if(p.status==="existing"){ weight=4; dash="6,6"; }
  else if(p.status==="funded"){ weight=5; dash="10,5"; }
  return {color:colorFor(p), weight, dashArray:dash, opacity:0.95, lineCap:"round"};
}
function restyle(f){
  const s=styleFor(f.props);
  if(selected===f){ s.weight+=3; }
  f.layer.setStyle(s);
  if(selected===f) f.layer.bringToFront();
}
function restyleAll(){ features.forEach(restyle); }

/* Chevrons showing which way a one-way path runs (the drawing order of the
   points IS the direction). Same look as the HTML export: a rotated dark
   glyph with a white halo, readable on the line and the basemap alike.
   Rebuilt whenever geometry/direction change. */
function updateArrows(f){
  // Arrows live in their own group (NOT networkGroup): a FeatureGroup's
  // getBounds() chokes on layers without bounds, which would break fitBounds.
  if(f.arrows){ arrowsGroup.removeLayer(f.arrows); f.arrows=null; }
  if(f.props.directions!==1) return;
  const g=L.layerGroup();
  segsOf(f.layer).forEach(seg=>{
    if(seg.length<2) return;
    const k=Math.max(1, Math.floor(seg.length/2));
    const a=seg[k-1], b=seg[k];
    const dx=(b.lng-a.lng)*Math.cos(a.lat*Math.PI/180);
    const theta=Math.atan2(-(b.lat-a.lat), dx)*180/Math.PI;
    const icon=L.divIcon({className:"dir-arrow", iconSize:[16,16], iconAnchor:[8,8],
      html:`<div style="transform:rotate(${theta.toFixed(0)}deg)">➤</div>`});
    g.addLayer(L.marker([(a.lat+b.lat)/2,(a.lng+b.lng)/2],
      {icon, interactive:false, keyboard:false, pmIgnore:true}));
  });
  g.addTo(arrowsGroup); f.arrows=g;
}
/* Chevron icons are fixed-size DivIcons, so zoomed way out they'd dwarf the
   streets themselves — below this zoom the whole arrows layer comes off. */
const ARROW_MIN_ZOOM = 14;
function syncArrowVisibility(){
  const show = map.getZoom() >= ARROW_MIN_ZOOM;
  if(show && !map.hasLayer(arrowsGroup)) map.addLayer(arrowsGroup);
  else if(!show && map.hasLayer(arrowsGroup)) map.removeLayer(arrowsGroup);
}

/* ---------- feature management ---------- */
function defaultProps(over){
  return Object.assign({
    name:"New path", on_street:"", from:"", to:"",
    phase: (config.phases[0]||{}).phase || 1,
    type: options.types[0]||"quick_build_separated",
    status:"proposed", jurisdiction:"city", directions:2, notes:""
  }, over||{});
}
function addFeature(props, latlngs){
  if(props.treatment && !props.type){ props.type=props.treatment; delete props.treatment; }
  const layer=L.polyline(latlngs, styleFor(props));
  const f={props, layer, arrows:null};
  layer.on("click", ()=>{
    if(combineFrom){ if(f!==combineFrom) combineInto(combineFrom, f); return; }
    if(!editMode) selectFeature(f);
  });
  layer.on("pm:edit", ()=>{ markDirty(); updateArrows(f);
    if(selected===f) updateLenField(f); recomputeTotals(); });
  layer.addTo(networkGroup);
  features.push(f);
  updateArrows(f);
  renderLegend();
  return f;
}
function removeFeature(f){
  networkGroup.removeLayer(f.layer);
  if(f.arrows) arrowsGroup.removeLayer(f.arrows);
  features=features.filter(x=>x!==f);
  // Don't leave upgrade links pointing at a deleted path (the file would
  // fail validation on the next import).
  if(f.props.id) features.forEach(x=>{
    if(x.props.upgrades===f.props.id) x.props.upgrades="";
  });
  if(selected===f) deselect();
  markDirty(); recomputeTotals(); renderLegend();
}
function clearFeatures(){
  deselect();
  features.forEach(f=>{ networkGroup.removeLayer(f.layer);
    if(f.arrows) arrowsGroup.removeLayer(f.arrows); });
  features=[];
}

/* ---------- spot improvements (point features) ---------- */
function spotIcon(p){
  const color = p.status==="existing" ? SPOT_EXISTING : SPOT_PROPOSED;
  const glyph = SPOT_GLYPHS[p.kind] || SPOT_GLYPHS.other;
  return L.divIcon({className:"spot-glyph", iconSize:[18,18], iconAnchor:[9,9],
    html:`<div style="color:${color}">${glyph}</div>`});
}
function addSpot(props, latlng){
  const marker=L.marker(latlng, {icon:spotIcon(props), draggable:true,
                                 pmIgnore:true, keyboard:false});
  const s={props, marker};
  marker.on("click", ()=>{ if(!editMode) selectSpot(s); });
  marker.on("dragend", ()=>{ markDirty(); });
  marker.addTo(spotsGroup);   // own group — never networkGroup (getBounds)
  spots.push(s);
  return s;
}
function removeSpot(s){
  spotsGroup.removeLayer(s.marker);
  spots=spots.filter(x=>x!==s);
  if(selectedSpot===s) deselect();
  markDirty(); recomputeTotals();
}
function clearSpots(){
  spots.forEach(s=>spotsGroup.removeLayer(s.marker));
  spots=[]; selectedSpot=null;
}
function defaultSpotProps(){
  return {name:"", kind:"speed_hump", status:"proposed", phase:null, notes:""};
}
function selectSpot(s){
  if(selected){ const prev=selected; selected=null; restyle(prev); }
  selectedSpot=s;
  document.getElementById("prop-empty").style.display="none";
  document.getElementById("prop-form").style.display="none";
  document.getElementById("spot-form").style.display="";
  fillSpotForm(s);
  if(isMobile() && !document.querySelector(".sidebar").classList.contains("open")){
    document.getElementById("peek-name").textContent =
      s.props.name || SPOT_LABELS[s.props.kind] || "Spot";
    document.getElementById("peek").classList.add("show");
  }
}
function fillSpotForm(s){
  const p=s.props;
  document.getElementById("sel-pill").textContent =
    p.name || SPOT_LABELS[p.kind] || "";
  opt(document.getElementById("s-kind"), options.spot_kinds||Object.keys(SPOT_GLYPHS),
      p.kind, v=>SPOT_LABELS[v]||v.replace(/_/g," "));
  document.getElementById("s-name").value=p.name||"";
  document.getElementById("s-status").value=p.status||"proposed";
  document.getElementById("s-notes").value=p.notes||"";
  fillSpotPhaseSelect(s);
}
function fillSpotPhaseSelect(s){
  const sel=document.getElementById("s-phase");
  if(s.props.status==="proposed"){
    sel.disabled=false;
    sel.innerHTML="";
    const any=document.createElement("option");
    any.value=""; any.textContent="— any time —";
    sel.appendChild(any);
    config.phases.forEach(ph=>{
      const o=document.createElement("option");
      o.value=String(ph.phase); o.textContent=`Phase ${ph.phase}`;
      sel.appendChild(o);
    });
    sel.value = s.props.phase==null ? "" : String(s.props.phase);
  } else {
    sel.innerHTML="<option>— n/a —</option>"; sel.disabled=true;
  }
}
function bindSpotForm(){
  const set=(id,key,cast)=>{
    document.getElementById(id).addEventListener("input", e=>{
      if(!selectedSpot) return;
      selectedSpot.props[key]= cast?cast(e.target.value):e.target.value;
      if(key==="status"){
        if(selectedSpot.props.status!=="proposed") selectedSpot.props.phase=null;
        fillSpotPhaseSelect(selectedSpot);
      }
      if(key==="kind"||key==="status")
        selectedSpot.marker.setIcon(spotIcon(selectedSpot.props));
      if(key==="name"||key==="kind")
        document.getElementById("sel-pill").textContent =
          selectedSpot.props.name || SPOT_LABELS[selectedSpot.props.kind] || "";
      markDirty(); recomputeTotals();
    });
  };
  set("s-name","name"); set("s-notes","notes"); set("s-status","status");
  set("s-kind","kind");
  set("s-phase","phase", v=> v==="" ? null : parseInt(v,10));
  document.getElementById("btn-spot-delete").addEventListener("click", ()=>{
    if(selectedSpot && confirm("Delete this spot?")) removeSpot(selectedSpot);
  });
}
function startPlaceSpot(){
  if(phaseView!=="all") setPhaseView("all");
  deselect();
  placingSpot=true;
  setStatus("Click the map where the improvement goes — Esc cancels.");
}

/* ---------- upgrades (quick-build now, better build later) ---------- */
function ensureId(f){
  // Ids exist only where an upgrade link needs one, so plain files stay clean.
  while(!f.props.id || features.some(x=>x!==f && x.props.id===f.props.id))
    f.props.id="p-"+Math.random().toString(36).slice(2,8);
  return f.props.id;
}
function supersededIdSet(list){
  const ids=new Set(list.map(f=>f.props.id).filter(Boolean));
  const out=new Set();
  list.forEach(f=>{
    if(f.props.upgrades && ids.has(f.props.upgrades)) out.add(f.props.upgrades);
  });
  return out;
}
function planUpgrade(){
  if(!selected) return;
  const target=selected, tid=ensureId(target);
  const segs=segsOf(target.layer).map(seg=>seg.map(p=>L.latLng(p.lat,p.lng)));
  const nums=config.phases.map(x=>x.phase).sort((a,b)=>a-b);
  const after=target.props.phase;
  let next=nums.find(n=>after==null || n>after);
  if(next==null) next=nums.length?nums[nums.length-1]:1;
  const f=addFeature(defaultProps({
    name:(target.props.name||"Path")+" (upgrade)",
    status:"proposed", type:target.props.type,
    jurisdiction:target.props.jurisdiction, directions:target.props.directions,
    on_street:target.props.on_street, from:target.props.from, to:target.props.to,
    upgrades:tid, phase:next
  }), segs.length===1?segs[0]:segs);
  setPhaseView("all");
  markDirty(); recomputeTotals(); selectFeature(f);
  setStatus(`Added an upgrade of “${target.props.name}” — pick its phase and type.`);
}

/* ---------- combining paths ---------- */
function startCombine(){
  if(!selected) return;
  combineFrom=selected;
  setStatus(`Click the path to merge into “${selected.props.name}” — Esc cancels.`);
}
function combineInto(target, other){
  // The other path's line(s) become extra segments of the target; the
  // target's properties win.
  setSegs(target.layer, segsOf(target.layer).concat(segsOf(other.layer)));
  combineFrom=null;
  removeFeature(other);
  updateArrows(target);
  selectFeature(target);
  updateLenField(target); recomputeTotals(); markDirty();
  setStatus(`Combined into “${target.props.name}”.`);
}

/* ---------- selection + property form ---------- */
function isMobile(){ return window.matchMedia("(max-width: 760px)").matches; }
function selectFeature(f){
  selectedSpot=null;
  document.getElementById("spot-form").style.display="none";
  const prev=selected; selected=f;
  if(prev && prev!==f) restyle(prev);
  restyle(f);
  fillForm(f);
  if(isMobile() && !document.querySelector(".sidebar").classList.contains("open")){
    document.getElementById("peek-name").textContent=f.props.name||"(unnamed)";
    document.getElementById("peek").classList.add("show");
  }
}
function deselect(){
  const prev=selected; selected=null; selectedSpot=null;
  if(prev) restyle(prev);
  document.getElementById("prop-form").style.display="none";
  document.getElementById("spot-form").style.display="none";
  document.getElementById("prop-empty").style.display="";
  document.getElementById("sel-pill").textContent="";
  document.getElementById("peek").classList.remove("show");
}
function opt(sel, values, current, labelFn){
  sel.innerHTML="";
  values.forEach(v=>{
    const o=document.createElement("option");
    o.value=String(v); o.textContent=labelFn?labelFn(v):String(v);
    if(String(v)===String(current)) o.selected=true;
    sel.appendChild(o);
  });
}
function fillForm(f){
  const p=f.props;
  document.getElementById("prop-empty").style.display="none";
  document.getElementById("prop-form").style.display="";
  document.getElementById("sel-pill").textContent=p.name||"";
  document.getElementById("f-name").value=p.name||"";
  document.getElementById("f-name").classList.toggle("warn-field", isDefaultName(p.name));
  document.getElementById("f-on").value=p.on_street||"";
  document.getElementById("f-from").value=p.from||"";
  document.getElementById("f-to").value=p.to||"";
  document.getElementById("f-notes").value=p.notes||"";
  opt(document.getElementById("f-status"), options.statuses, p.status);
  opt(document.getElementById("f-juris"), options.jurisdictions, p.jurisdiction);
  opt(document.getElementById("f-type"), options.types, p.type,
      v=>TYPE_LABELS[v]||v.replace(/_/g," "));
  fillPhaseSelect(f);
  document.getElementById("f-dir").value=String(p.directions||2);
  document.getElementById("btn-reverse").style.display =
    p.directions===1 ? "" : "none";
  updateUpgradeRow(f);
  updateLenField(f);
}
function updateUpgradeRow(f){
  const row=document.getElementById("upgrade-row");
  if(f.props.upgrades){
    const target=features.find(x=>x.props.id===f.props.upgrades);
    document.getElementById("upgrade-target").textContent =
      target ? `Replaces “${target.props.name||"(unnamed)"}”` : "Replaces a removed path";
    row.style.display="";
  } else row.style.display="none";
}
function fillPhaseSelect(f){
  // Phase only applies to proposed paths; existing/funded have phase = null.
  const sel=document.getElementById("f-phase");
  if(f.props.status==="proposed"){
    sel.disabled=false;
    if(f.props.phase==null) f.props.phase=(config.phases[0]||{}).phase||1;
    opt(sel, config.phases.map(x=>x.phase), f.props.phase, n=>`Phase ${n}`);
  } else {
    sel.innerHTML="<option>— n/a —</option>"; sel.disabled=true;
  }
}
function updateLenField(f){
  const mi=featureMiles(f);
  document.getElementById("f-len").value=
    `${mi.toFixed(2)} corridor-mi  ·  ${(mi*(f.props.directions||2)).toFixed(2)} lane-mi`;
}
function bindForm(){
  const set=(id,key,cast)=>{
    document.getElementById(id).addEventListener("input", e=>{
      if(!selected) return;
      selected.props[key]= cast?cast(e.target.value):e.target.value;
      if(key==="status"){
        selected.props.phase = selected.props.status==="proposed"
          ? ((config.phases[0]||{}).phase||1) : null;
        // Only a proposed path can be an upgrade of another.
        if(selected.props.status!=="proposed" && selected.props.upgrades){
          selected.props.upgrades="";
          updateUpgradeRow(selected);
        }
        fillPhaseSelect(selected);
      }
      if(["status","jurisdiction","phase","type"].includes(key)){
        restyle(selected);
        // The legend lists only the types in use, so retyping the last
        // path of a kind (or the first of a new one) changes it.
        renderLegend();
      }
      if(key==="name"){
        document.getElementById("sel-pill").textContent=e.target.value;
        e.target.classList.toggle("warn-field", isDefaultName(e.target.value));
        recomputeTotals();
      }
      if(["directions","phase","status","jurisdiction","type"].includes(key)){ updateLenField(selected); recomputeTotals(); }
      if(key==="directions"){
        updateArrows(selected);
        document.getElementById("btn-reverse").style.display =
          selected.props.directions===1 ? "" : "none";
      }
      markDirty();
    });
  };
  set("f-name","name"); set("f-on","on_street"); set("f-from","from");
  set("f-to","to"); set("f-notes","notes"); set("f-status","status");
  set("f-juris","jurisdiction"); set("f-type","type");
  set("f-phase","phase",v=>parseInt(v,10)); set("f-dir","directions",v=>parseInt(v,10));
  document.getElementById("btn-delete").addEventListener("click", ()=>{
    if(selected && confirm("Delete this path?")) removeFeature(selected);
  });
  document.getElementById("btn-upgrade").addEventListener("click", planUpgrade);
  document.getElementById("btn-unlink").addEventListener("click", ()=>{
    if(!selected) return;
    selected.props.upgrades="";
    updateUpgradeRow(selected); markDirty(); recomputeTotals();
  });
}

/* ---------- totals ---------- */
const DEFAULT_NAMES=new Set(["new path","existing path","new corridor",""]);
function isDefaultName(name){ return DEFAULT_NAMES.has(String(name||"").trim().toLowerCase()); }
function money(v){
  if(v>=1e6) return `$${(v/1e6).toFixed(v>=10e6?0:1)}M`;
  if(v>=1e3) return `$${Math.round(v/1e3)}K`;
  return `$${Math.round(v)}`;
}
function recomputeTotals(){
  let city=0, lane=0, state=0, count=0;
  let cLow=0,cHigh=0,sLow=0,sHigh=0, unnamed=0;
  const rates=options.cost_per_mile||{};
  // A corridor that a later phase upgrades counts ONCE in the mileage (the
  // final facility) — but every phase's work still costs money.
  const superseded=supersededIdSet(features);
  for(const f of features){
    const p=f.props;
    if(isDefaultName(p.name)) unnamed++;
    if(p.status!=="proposed") continue;
    const mi=featureMiles(f);
    const [lo,hi]=rates[p.type]||[0,0];
    const counted=!(p.id && superseded.has(p.id));
    if(p.jurisdiction==="state"){ if(counted) state+=mi; sLow+=mi*lo; sHigh+=mi*hi; }
    else {
      if(counted){ city+=mi; lane+=mi*(p.directions||2); count++; }
      cLow+=mi*lo; cHigh+=mi*hi;
    }
  }
  document.getElementById("t-city").textContent=city.toFixed(1);
  document.getElementById("t-lane").textContent=lane.toFixed(1);
  document.getElementById("t-state").textContent=state.toFixed(1);
  document.getElementById("t-count").textContent=count;
  const range=(lo,hi)=> lo||hi ? `${money(lo)} – ${money(hi)}` : "–";
  document.getElementById("c-city").textContent=range(cLow,cHigh);
  document.getElementById("c-state").textContent=range(sLow,sHigh);
  document.getElementById("c-total").textContent=range(cLow+sLow,cHigh+sHigh);
  const built=spots.filter(s=>s.props.status==="existing").length;
  const planned=spots.length-built;
  document.getElementById("t-spots-row").style.display = spots.length ? "" : "none";
  document.getElementById("t-spots").textContent =
    [built?`${built} existing`:"", planned?`${planned} planned`:""]
      .filter(Boolean).join(" · ");
  const warn=document.getElementById("unnamed-warn");
  warn.style.display = unnamed ? "" : "none";
  if(unnamed) warn.textContent =
    `⚠ ${unnamed} path${unnamed>1?"s":""} still ${unnamed>1?"have":"has"} a default name — click to review`;
}
function selectNextUnnamed(){
  const unnamed=features.filter(f=>isDefaultName(f.props.name));
  if(!unnamed.length) return;
  const start=selected ? unnamed.indexOf(selected)+1 : 0;
  const f=unnamed[start % unnamed.length];
  map.fitBounds(f.layer.getBounds().pad(0.3));
  selectFeature(f);
  document.getElementById("f-name").focus();
}

/* ---------- phases ---------- */
function renderPhases(){
  const box=document.getElementById("phases"); box.innerHTML="";
  config.phases.forEach((ph,i)=>{
    const div=document.createElement("div"); div.className="phase";
    div.innerHTML=`
      <div class="ph-top">
        <span class="swatch" style="background:${PHASE_COLORS[ph.phase]||"#444"}"></span>
        <strong>Phase ${ph.phase}</strong>
        <span class="spacer" style="flex:1"></span>
        <button class="rm danger" data-i="${i}">Remove</button>
      </div>`;
    const label=document.createElement("input"); label.value=ph.label||""; label.placeholder="Label";
    const date=document.createElement("input"); date.value=ph.deadline||""; date.placeholder="Deadline e.g. December 31, 2029";
    label.addEventListener("input",e=>{ ph.label=e.target.value; markDirty(); });
    date.addEventListener("input",e=>{ ph.deadline=e.target.value; markDirty(); });
    div.appendChild(label); div.appendChild(date);
    div.querySelector(".rm").addEventListener("click",()=>{
      config.phases.splice(i,1); renderPhases(); if(selected) fillForm(selected); markDirty();
    });
    box.appendChild(div);
  });
  renderPhaseView();
}
function addPhase(){
  const next=(config.phases.reduce((m,p)=>Math.max(m,p.phase),0))+1;
  config.phases.push({phase:next,label:`Phase ${next}`,deadline:""});
  renderPhases(); if(selected) fillForm(selected); markDirty();
}

/* ---------- phase view (Show: full network / today / as of phase N) ---------- */
function renderPhaseView(){
  const sel=document.getElementById("phase-view");
  sel.innerHTML="";
  const add=(v,label)=>{
    const o=document.createElement("option");
    o.value=v; o.textContent=label; sel.appendChild(o);
  };
  add("all","Full network");
  add("0","Today (existing + funded)");
  config.phases.slice().sort((a,b)=>a.phase-b.phase).forEach(ph=>
    add(String(ph.phase), `As of Phase ${ph.phase}${ph.label?": "+ph.label:""}`));
  sel.value=[...sel.options].some(o=>o.value===phaseView)?phaseView:"all";
  phaseView=sel.value;
}
function setPhaseView(v){
  phaseView=v;
  document.getElementById("phase-view").value=v;
  applyPhaseView();
}
function applyPhaseView(){
  let shownSet;
  if(phaseView==="all"){
    shownSet=new Set(features);
  } else {
    const n=parseInt(phaseView,10);  // 0 = today (existing + funded only)
    let shown=features.filter(f=>f.props.status!=="proposed"
      || (f.props.phase!=null && f.props.phase<=n));
    const superseded=supersededIdSet(shown);
    shown=shown.filter(f=>!(f.props.id && superseded.has(f.props.id)));
    shownSet=new Set(shown);
  }
  // A path whose replacement is also on screen (the full view draws both, the
  // upgrade exactly covering it) keeps its line so it stays selectable, but
  // drops its one-way chevron: that arrow describes a facility the upgrade
  // has already replaced, and it floats above the new line.
  const replaced=supersededIdSet([...shownSet]);
  features.forEach(f=>{
    const shown=shownSet.has(f);
    const wantArrows=shown && !(f.props.id && replaced.has(f.props.id));
    if(shown){
      if(!networkGroup.hasLayer(f.layer)) networkGroup.addLayer(f.layer);
    } else {
      if(selected===f) deselect();
      if(networkGroup.hasLayer(f.layer)) networkGroup.removeLayer(f.layer);
    }
    if(f.arrows){
      if(wantArrows && !arrowsGroup.hasLayer(f.arrows)) arrowsGroup.addLayer(f.arrows);
      if(!wantArrows && arrowsGroup.hasLayer(f.arrows)) arrowsGroup.removeLayer(f.arrows);
    }
  });
  // Spots follow the same clock: existing always; proposed once their phase
  // arrives (no phase = any time, so any phased view shows them).
  spots.forEach(s=>{
    let show=true;
    if(phaseView!=="all" && s.props.status==="proposed"){
      const n=parseInt(phaseView,10);
      show = n>0 && (s.props.phase==null || s.props.phase<=n);
    }
    if(show){ if(!spotsGroup.hasLayer(s.marker)) spotsGroup.addLayer(s.marker); }
    else {
      if(selectedSpot===s) deselect();
      if(spotsGroup.hasLayer(s.marker)) spotsGroup.removeLayer(s.marker);
    }
  });
}

/* ---------- legend ---------- */
function renderLegend(){
  const items=[];
  if(colorMode==="phase"){
    config.phases.forEach(p=>items.push([PHASE_COLORS[p.phase]||"#444", `Phase ${p.phase}`, false]));
    items.push([STATE,"State road (request)",false]);
    items.push([FUNDED,"Approved / funded",true]);
    items.push([EXISTING,"Existing",true]);
  } else if(colorMode==="type"){
    const seen=new Set(features.map(f=>f.props.type));
    Object.keys(TYPE_COLORS).forEach(t=>{
      if(seen.has(t)) items.push([TYPE_COLORS[t], TYPE_LABELS[t], false]);
    });
    items.push(["#555","Existing / funded (dashed)",true]);
  } else {
    items.push([SINGLE,"Bike network",false]);
    items.push([SINGLE,"Existing / funded (dashed)",true]);
  }
  const box=document.getElementById("legend"); box.innerHTML="";
  items.forEach(([c,label,dashed])=>{
    const d=document.createElement("div"); d.className="item";
    d.innerHTML=`<span class="ln" style="border-top-color:${c};border-top-style:${dashed?"dashed":"solid"}"></span>${label}`;
    box.appendChild(d);
  });
}

/* ---------- context layers (reference data, not part of the plan) ----------
   Lazy on every axis: nothing is fetched until a layer is first checked, and
   unchecked layers are plain removeLayer'd — zero cost while off. Points are
   drawn on a shared canvas renderer so thousands of markers stay smooth. */
const contextLayers = {};   // id -> {entry, leaflet layer or null, loading}
const contextRenderer = typeof L!=="undefined" ? L.canvas({padding:0.5}) : null;

function contextPopupHtml(props){
  const rows=Object.entries(props||{})
    .filter(([k,v])=>v!=null && v!=="" && typeof v!=="object").slice(0,6)
    .map(([k,v])=>`<div><b>${k.replace(/_/g," ")}</b>: ${String(v)}</div>`);
  return rows.join("") || "<i>(no details)</i>";
}
async function toggleContextLayer(entry, on){
  const state=contextLayers[entry.id];
  if(!on){
    if(state && state.layer) map.removeLayer(state.layer);
    return;
  }
  if(state && state.layer){ state.layer.addTo(map); return; }
  if(state && state.loading) return;
  contextLayers[entry.id]={entry, layer:null, loading:true};
  try{
    const r=await fetch(`/api/layers/${entry.id}`);
    if(!r.ok) throw new Error(r.status);
    const data=await r.json();
    const style=entry.style||{};
    const layer=L.geoJSON(data, {
      renderer: contextRenderer,
      pointToLayer:(ft,ll)=>L.circleMarker(ll,{
        renderer: contextRenderer,
        radius: style.radius||4, color: style.color||"#666", weight:1,
        fillColor: style.color||"#666", fillOpacity:0.55, opacity:0.8}),
      style: ()=>({color: style.color||"#666", weight:2, opacity:0.7}),
      onEachFeature:(ft,l)=>l.bindPopup(
        `<b>${entry.label}</b>`+contextPopupHtml(ft.properties), {maxWidth:260}),
    });
    contextLayers[entry.id]={entry, layer, loading:false};
    // Only add if the box is still checked (the user may have re-toggled).
    const box=document.querySelector(`#layers-list input[data-id="${entry.id}"]`);
    if(!box || box.checked) layer.addTo(map);
  }catch(e){
    contextLayers[entry.id]=null;
    setStatus(`Couldn’t load the “${entry.label}” layer.`);
  }
}
async function initContextLayers(){
  let entries=[];
  try{ entries=await (await fetch("/api/layers")).json(); }catch(e){ return; }
  if(!entries.length) return;
  document.getElementById("layers-card").style.display="";
  const box=document.getElementById("layers-list");
  entries.forEach(entry=>{
    const row=document.createElement("label");
    row.className="layer-row";
    if(entry.description||entry.attribution)
      row.title=[entry.description,entry.attribution].filter(Boolean).join(" — ");
    const cb=document.createElement("input");
    cb.type="checkbox"; cb.dataset.id=entry.id;
    cb.addEventListener("change",()=>toggleContextLayer(entry, cb.checked));
    const sw=document.createElement("span"); sw.className="layer-swatch";
    sw.style.background=(entry.style||{}).color||"#666";
    row.appendChild(cb); row.appendChild(sw);
    row.appendChild(document.createTextNode(entry.label||entry.id));
    box.appendChild(row);
  });
}

/* ---------- autosave ----------
   Every edit schedules a debounced save to the server (network.yaml), so a
   crash or power loss costs at most ~a second of work. There is no Save
   button; the status pill shows the autosave state. */
const AUTOSAVE_MS=1200;
let saveTimer=null, saving=false;
function markDirty(){
  dirty=true; setStatus();
  clearTimeout(saveTimer);
  saveTimer=setTimeout(autosave, AUTOSAVE_MS);
}
function setStatus(msg){
  const el=document.getElementById("status");
  if(msg){ el.innerHTML=msg; return; }
  el.innerHTML = dirty ? '<span class="dirty">Saving…</span>' : "All changes saved";
}
function toGeoJSON(){
  return {type:"FeatureCollection", features: features.map(f=>{
    const segs=segsOf(f.layer).map(seg=>seg.map(p=>[p.lng,p.lat]));
    return {
      type:"Feature",
      properties: Object.assign({}, f.props),
      geometry: segs.length===1
        ? {type:"LineString", coordinates: segs[0]}
        : {type:"MultiLineString", coordinates: segs}
    };
  })};
}
function spotsToGeoJSON(){
  return {type:"FeatureCollection", features: spots.map(s=>{
    const ll=s.marker.getLatLng();
    return {type:"Feature", properties:Object.assign({}, s.props),
            geometry:{type:"Point", coordinates:[ll.lng, ll.lat]}};
  })};
}
function statePayload(){
  return JSON.stringify({network:toGeoJSON(), spots:spotsToGeoJSON(),
                         config:{city:config.city, phases:config.phases}});
}
async function autosave(){
  if(saving){ saveTimer=setTimeout(autosave, 500); return; }  // one save at a time
  saving=true;
  try{
    const r=await fetch("/api/state",{method:"POST",
      headers:{"Content-Type":"application/json"}, body:statePayload()});
    if(r.ok){ dirty=false; setStatus(); }
    else throw new Error(r.status);
  }catch(e){
    setStatus('<span class="dirty">Autosave failed — retrying…</span>');
    saveTimer=setTimeout(autosave, 5000);
  }
  saving=false;
}
async function flushSave(){
  // Make sure the latest edits are on disk (used before exports).
  clearTimeout(saveTimer);
  while(saving) await new Promise(r=>setTimeout(r,100));
  if(dirty) await autosave();
  return !dirty;
}
function showExportNotes(s){
  const c=document.getElementById("result-card"), box=document.getElementById("result");
  const msgs=[...(s.warnings||[]).map(w=>`<span class="warn">! ${w}</span>`),
              ...(s.notices||[])];
  if(!msgs.length){ c.style.display="none"; return; }
  c.style.display="";
  box.innerHTML=msgs.join("\n");
}

/* ---------- import / export ---------- */
function download(url, filename){
  const a=document.createElement("a");
  a.href=url; a.download=filename||"";
  document.body.appendChild(a); a.click(); a.remove();
}
async function exportYaml(){
  if(await flushSave()) download("/api/export/network.yaml","network.yaml");
  else setStatus('<span class="dirty">Export failed — couldn’t save</span>');
}
async function exportOutput(name){
  // Regenerate with the current color mode so the download matches the screen.
  setStatus("Preparing export… (a few seconds)");
  try{
    const r=await fetch(`/api/regenerate?color_mode=${colorMode}`,
      {method:"POST",headers:{"Content-Type":"application/json"}, body:statePayload()});
    const j=await r.json();
    if(!j.ok) throw new Error("regenerate failed");
    dirty=false; setStatus();
    showExportNotes(j.summary);
    download(`/outputs/${name}`, name);
  }catch(e){ setStatus('<span class="dirty">Export failed</span>'); }
}
async function exportBundle(){
  // Everything in one zip: yaml + png + html + geojson.
  setStatus("Preparing export… (a few seconds)");
  try{
    const r=await fetch(`/api/export/bundle.zip?color_mode=${colorMode}`,
      {method:"POST",headers:{"Content-Type":"application/json"}, body:statePayload()});
    if(!r.ok) throw new Error(r.status);
    const url=URL.createObjectURL(await r.blob());
    dirty=false; setStatus();
    download(url, "bike-network.zip");
    URL.revokeObjectURL(url);
  }catch(e){ setStatus('<span class="dirty">Export failed</span>'); }
}
async function importYamlFile(file){
  setStatus("Importing…");
  // Sent as raw bytes: the server detects a .zip bundle (finds the .yaml
  // inside) vs. a plain YAML file by content, not extension.
  const r=await fetch("/api/import",{method:"POST",
    headers:{"Content-Type":"application/octet-stream"},
    body:await file.arrayBuffer()});
  const j=await r.json();
  if(!j.ok){
    setStatus("Import failed");
    alert("This file isn't a valid network file:\n\n" + (j.errors||[]).join("\n"));
    return;
  }
  if(features.length && !confirm(
    "Replace the current network with the imported one? (Tip: Export your "
    + "current network first if you might want it back.)")) { setStatus(); return; }
  clearFeatures(); clearSpots();
  config={city:j.config.city, phases:j.config.phases};
  (j.network.features||[]).forEach(ft=>{
    const ll=latlngsFromGeometry(ft.geometry);
    if(ll) addFeature(ft.properties||defaultProps(), ll);
  });
  ((j.spots||{}).features||[]).forEach(ft=>{
    const c=(ft.geometry||{}).coordinates||[];
    if(c.length===2) addSpot(Object.assign(defaultSpotProps(), ft.properties),
                             L.latLng(c[1], c[0]));
  });
  renderPhases(); renderLegend(); recomputeTotals();
  if(networkGroup.getLayers().length) map.fitBounds(networkGroup.getBounds().pad(0.05));
  markDirty();
}

/* ---------- snap to roads ---------- */
async function snapPoints(pts){
  // pts: [[lat,lng],...]; returns road-following [[lat,lng],...] or null on failure.
  try{
    const r=await fetch("/api/snap",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({points:pts})});
    const j=await r.json();
    return (j.points && j.points.length>=2) ? j.points : null;
  }catch(e){ return null; }
}
async function snapSelected(){
  if(!selected) return;
  setStatus("Snapping to roads…");
  // Combined paths snap segment by segment, so independent (off-street)
  // pieces that fail to snap simply keep their drawn shape.
  const out=[]; let anySnapped=false;
  for(const seg of segsOf(selected.layer)){
    const snapped=await snapPoints(seg.map(p=>[p.lat,p.lng]));
    if(snapped){ anySnapped=true; out.push(snapped.map(c=>L.latLng(c[0],c[1]))); }
    else out.push(seg);
  }
  setSegs(selected.layer, out);
  updateArrows(selected);
  if(anySnapped){ updateLenField(selected); recomputeTotals(); markDirty(); }
  setStatus(anySnapped ? "" : "Couldn’t snap (kept the drawn shape).");
}
function reverseSelected(){
  if(!selected) return;
  const segs=segsOf(selected.layer).slice().reverse()
    .map(seg=>seg.slice().reverse());
  setSegs(selected.layer, segs);
  updateArrows(selected); markDirty();
}

/* ---------- drawing / edit mode ---------- */
let drawDefaults=null;
function startDraw(over){
  // Drawing means editing the full plan — leave any phase preview first.
  if(phaseView!=="all") setPhaseView("all");
  drawDefaults=over; deselect();
  map.pm.enableDraw("Line",{finishOn:"dblclick", continueDrawing:false});
  const snap=document.getElementById("snap").checked;
  setStatus("Click along the route; double-click to finish; Backspace undoes "
    + "the last point."
    + (snap ? " Clicks near a street snap to it; clicks away from streets "
            + "(parks, trails) stay where you put them." : ""));
}
function undoDrawVertex(){
  // Remove the last clicked point of an in-progress drawing, so a misclick
  // doesn't force starting the whole path over.
  const d=map.pm.Draw && map.pm.Draw.Line;
  if(d && d._enabled && typeof d._removeLastVertex==="function"){
    d._removeLastVertex();
    return true;
  }
  return false;
}
function toggleEdit(){
  editMode=!editMode;
  document.getElementById("btn-edit").classList.toggle("toggled", editMode);
  if(editMode){ map.pm.enableGlobalEditMode(); deselect(); setStatus("Edit mode: drag the dots to reshape lines."); }
  else { map.pm.disableGlobalEditMode(); setStatus(); }
}

/* ---------- init ---------- */
async function init(){
  map=L.map("map",{zoomControl:true}).setView([42.4251,-71.0662],14);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    {attribution:"© OpenStreetMap, © CARTO", maxZoom:20}).addTo(map);
  networkGroup=L.featureGroup().addTo(map);
  boundaryGroup=L.featureGroup().addTo(map);
  arrowsGroup=L.layerGroup().addTo(map);
  spotsGroup=L.layerGroup().addTo(map);
  map.pm.setGlobalOptions({pmIgnore:false});

  const res=await fetch("/api/state"); const data=await res.json();
  options=data.options;
  config={city:data.config.city, phases:data.config.phases};

  (data.boundary||[]).forEach(ring=>{
    L.polyline(ring,{color:BOUNDARY,weight:1.5,dashArray:"7,6",opacity:0.8,
      interactive:false, pmIgnore:true}).addTo(boundaryGroup);
  });

  (data.network.features||[]).forEach(ft=>{
    const ll=latlngsFromGeometry(ft.geometry);
    if(ll) addFeature(ft.properties||defaultProps(), ll);
  });
  ((data.spots||{}).features||[]).forEach(ft=>{
    const c=(ft.geometry||{}).coordinates||[];
    if(c.length===2) addSpot(Object.assign(defaultSpotProps(), ft.properties),
                             L.latLng(c[1], c[0]));
  });

  if(networkGroup.getLayers().length) map.fitBounds(networkGroup.getBounds().pad(0.05));
  else if(boundaryGroup.getLayers().length) map.fitBounds(boundaryGroup.getBounds());
  map.on("zoomend", syncArrowVisibility);
  syncArrowVisibility();

  map.on("pm:create", async e=>{
    const drawn=segsOf(e.layer)[0].map(p=>[p.lat,p.lng]);
    map.removeLayer(e.layer); map.pm.disableDraw();
    let geom=drawn;
    if(document.getElementById("snap").checked){
      setStatus("Snapping to roads…");
      geom = await snapPoints(drawn) || drawn;
    }
    const f=addFeature(defaultProps(drawDefaults), geom.map(c=>L.latLng(c[0],c[1])));
    selectFeature(f); markDirty(); recomputeTotals(); setStatus();
  });

  bindForm(); bindSpotForm(); renderPhases(); renderLegend(); recomputeTotals(); setStatus();
  initContextLayers();
  document.getElementById("btn-add").onclick=()=>startDraw({status:"proposed"});
  document.getElementById("btn-add-existing").onclick=()=>startDraw(
    {status:"existing", name:"Existing path", type:"shared_use_path", phase:null});
  document.getElementById("btn-add-spot").onclick=startPlaceSpot;
  map.on("click", e=>{
    if(!placingSpot) return;
    placingSpot=false;
    const s=addSpot(defaultSpotProps(), e.latlng);
    selectSpot(s); markDirty(); recomputeTotals(); setStatus();
  });
  document.getElementById("btn-edit").onclick=toggleEdit;
  document.getElementById("btn-add-phase").onclick=addPhase;
  document.getElementById("btn-snap-sel").onclick=snapSelected;
  document.getElementById("btn-reverse").onclick=reverseSelected;
  document.getElementById("btn-combine").onclick=startCombine;
  document.getElementById("unnamed-warn").onclick=selectNextUnnamed;
  document.addEventListener("keydown", e=>{
    if(e.key==="Escape" && combineFrom){ combineFrom=null; setStatus(); }
    if(e.key==="Escape" && placingSpot){ placingSpot=false; setStatus(); }
    const typing=/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if(!typing && (e.key==="Backspace" || e.key==="Delete"
                   || (e.ctrlKey && e.key.toLowerCase()==="z"))){
      if(undoDrawVertex()) e.preventDefault();
    }
  });
  // Mobile: the sidebar is a slide-over panel; a peek bar previews taps.
  const sidebar=document.querySelector(".sidebar");
  document.getElementById("mobile-details").onclick=()=>{
    sidebar.classList.toggle("open");
    document.getElementById("peek").classList.remove("show");
  };
  document.getElementById("mobile-close").onclick=()=>sidebar.classList.remove("open");
  document.getElementById("peek-edit").onclick=()=>{
    sidebar.classList.add("open");
    document.getElementById("peek").classList.remove("show");
    document.getElementById("prop-form").scrollIntoView({block:"center"});
  };

  document.getElementById("phase-view").addEventListener("change", e=>{
    phaseView=e.target.value; applyPhaseView();
  });

  const phasesBox=document.getElementById("phases-box");
  phasesBox.open = (colorMode==="phase");
  document.getElementById("color-mode").addEventListener("change", e=>{
    colorMode=e.target.value; restyleAll(); renderLegend();
    // Phases are front-and-center only when the map is colored by them.
    phasesBox.open = (colorMode==="phase");
  });

  // Export dropdown.
  const exportBtn=document.getElementById("btn-export");
  const exportMenu=document.getElementById("export-menu");
  exportBtn.addEventListener("click", e=>{
    e.stopPropagation(); exportMenu.hidden=!exportMenu.hidden;
  });
  document.addEventListener("click", ()=>{ exportMenu.hidden=true; });
  exportMenu.querySelectorAll("button").forEach(b=>{
    b.addEventListener("click", e=>{
      e.stopPropagation(); exportMenu.hidden=true;
      const kind=b.dataset.export;
      if(kind==="yaml") exportYaml();
      else if(kind==="bundle") exportBundle();
      else exportOutput(kind);
    });
  });

  document.getElementById("import-file").addEventListener("change", e=>{
    if(e.target.files.length) importYamlFile(e.target.files[0]);
    e.target.value="";
  });
  // Last-ditch flush if the tab closes inside the autosave debounce window.
  // Mobile browsers often kill tabs with no pagehide, so visibilitychange
  // (fires when the app is backgrounded) is the flush that matters there.
  const beaconFlush=()=>{
    if(dirty) navigator.sendBeacon("/api/state",
      new Blob([statePayload()], {type:"application/json"}));
  };
  // Leaflet doesn't notice its container changing size (phone rotation, a
  // header row wrapping, the browser chrome hiding), and leaves the new area
  // blank grey until told. Debounced so a drag-resize isn't a redraw storm.
  let resizeTimer=null;
  const onResize=()=>{
    clearTimeout(resizeTimer);
    resizeTimer=setTimeout(()=>map.invalidateSize(), 150);
  };
  window.addEventListener("resize", onResize);
  window.addEventListener("orientationchange", onResize);

  window.addEventListener("pagehide", beaconFlush);
  document.addEventListener("visibilitychange", ()=>{
    if(document.visibilityState==="hidden") beaconFlush();
  });
}
init();
