// ===== CONSTANTS =====
const TIER_PRICE = {S:24,A:16,B:10,C:6};
const CHIPS = [
  {id:'wildcard',  name:'Wildcard',       icon:'🃏',desc:'Unlimited free transfers for the entire Matchday — no penalty'},
  {id:'topfragger',name:'Top Fragger',    icon:'🎯',desc:'Top scorer in your squad gets ×2 automatically'},
  {id:'clonecap',  name:'Clone Captain',  icon:'👥',desc:'Pick 2 captains — both get ×2'},
  {id:'triplecap', name:'Triple Captain', icon:'👑',desc:'Your captain scores ×3 instead of ×2'},
];
const SLOTS = [
  {id:'duel',label:'Duelist',  roles:['Duelist']},
  {id:'init',label:'Initiator',roles:['Initiator']},
  {id:'ctrl',label:'Controller',roles:['Controller']},
  {id:'sent',label:'Sentinel', roles:['Sentinel']},
  {id:'any1',label:'Any',roles:['Duelist','Initiator','Controller','Sentinel']},
  {id:'any2',label:'Any',roles:['Duelist','Initiator','Controller','Sentinel']},
  {id:'any3',label:'Any',roles:['Duelist','Initiator','Controller','Sentinel']},
];

// ===== AUTH =====
let currentUser = null; // {userId, manager}

async function hashPin(pin){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pin));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}

function showLogin(){ document.getElementById('loginOverlay').classList.add('open'); }
function hideLogin(){ document.getElementById('loginOverlay').classList.remove('open'); }

async function doLogin(){
  const manager = document.getElementById('loginManager').value.trim();
  const pin = document.getElementById('loginPin').value.trim();
  if(!manager){ toast('Please enter your name'); return; }
  if(!pin||pin.length!==4||isNaN(pin)){ toast('PIN must be 4 digits'); return; }
  const pinHash = await hashPin(pin);
  const {data:existing} = await sb.from('users').select('id,pin_hash').eq('manager_name',manager).single();
  if(existing){
    if(existing.pin_hash!==pinHash){ toast('Wrong PIN'); return; }
    currentUser = {userId:existing.id, manager};
    toast('Welcome back, '+manager+'! ✓');
  } else {
    const {data:newUser,error} = await sb.from('users').insert({manager_name:manager,pin_hash:pinHash}).select('id').single();
    if(error){
      if(error.code==='23505') toast('Name already taken — try another');
      else{ toast('Error creating account'); console.error(error); }
      return;
    }
    currentUser = {userId:newUser.id, manager};
    toast('Welcome, '+manager+'! ✓');
  }
  localStorage.setItem('vlt_user', JSON.stringify({userId:currentUser.userId,manager}));
  document.getElementById('navUserName').textContent = manager;
  document.getElementById('navUserBadge').style.display = 'flex';
  hideLogin();
  await loadMyTeam();
  renderTeamPage();
}

function doLogout(){
  currentUser = null;
  myTeamId = null; myTeamName = ''; myRosters = {};
  myCaptainId = null; myCaptain2Id = null; myChip = null; myTransferCount = 0;
  localStorage.removeItem('vlt_user');
  document.getElementById('navUserBadge').style.display='none';
  document.getElementById('navUserName').textContent='—';
  document.getElementById('loginManager').value='';
  document.getElementById('loginPin').value='';
  goPage('lb');
  toast('Logged out ✓');
}

async function tryAutoLogin(){
  const saved = localStorage.getItem('vlt_user');
  if(!saved) return false;
  const {userId, manager} = JSON.parse(saved);
  if(!userId||!manager) return false;
  const {data:user} = await sb.from('users').select('id').eq('id',userId).single();
  if(!user){ localStorage.removeItem('vlt_user'); return false; }
  currentUser = {userId, manager};
  document.getElementById('navUserName').textContent = manager;
  document.getElementById('navUserBadge').style.display = 'flex';
  await loadMyTeam();
  return true;
}

// ===== SUPABASE =====
const SUPABASE_URL = 'https://ethubdzlnaxyqcpjhlit.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV0aHViZHpsbmF4eXFjcGpobGl0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAwMjc3NTQsImV4cCI6MjA5NTYwMzc1NH0.ULOEj1B-ScKgFSV7KA9WV0DZElSvPAnrLWKcUR2MeG0';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// ===== APP STATE =====
let TOURNAMENT = null;
let MATCHDAYS  = [];
let PLAYERS    = [];
let currentMDId = null;
let lbMDId      = null;

// My team state
let myTeamId       = null;
let myTeamName     = '';
let myRosters      = {}; // {slot: playerRow}
let myCaptainId    = null;
let myCaptain2Id   = null;
let myChip         = null;
let myTransferCount = 0;
let mySlotScores   = {}; // {playerId: finalPts} for current MD

// UI state
let pickerSlot = null, pickerFilter = 'ALL', playersFilter = 'ALL';

// ===== DATA LOADING =====
async function loadAppData(){
  document.getElementById('lbBody').innerHTML =
    '<div style="text-align:center;padding:40px;color:var(--muted);font-size:12px;letter-spacing:1px">Loading...</div>';
  const {data:tourney} = await sb.from('tournaments').select('*').eq('status','active').single();
  if(!tourney){ console.error('No active tournament'); return false; }
  TOURNAMENT = tourney;
  const [{data:mds},{data:players}] = await Promise.all([
    sb.from('matchdays').select('*').eq('tournament_id',tourney.id).order('matchday_number'),
    sb.from('players').select('*').eq('tournament_id',tourney.id).order('name'),
  ]);
  MATCHDAYS = mds||[];
  PLAYERS   = players||[];
  const openMD = [...MATCHDAYS].reverse().find(m=>m.market_open);
  const lastMD = MATCHDAYS[MATCHDAYS.length-1];
  currentMDId = openMD?.id || lastMD?.id || null;
  lbMDId = currentMDId;
  return true;
}

async function seedPlayers(){
  if(PLAYERS.length) return;
  const rows = DEFAULT_PLAYERS.map(p=>({
    tournament_id:TOURNAMENT.id, name:p.name, vct_team:p.team,
    role:p.role, tier:p.tier, price:p.price,
  }));
  const {data} = await sb.from('players').insert(rows).select();
  if(data) PLAYERS = data;
}

async function loadMyTeam(){
  if(!currentUser||!TOURNAMENT) return;
  const {data:team} = await sb.from('teams')
    .select('id,team_name,captain_id,captain2_id,total_points,rosters(slot,player_id,players(*)),active_chips(chip_name,matchday_id)')
    .eq('user_id',currentUser.userId).eq('tournament_id',TOURNAMENT.id).single();
  if(!team){
    const {data:newTeam} = await sb.from('teams')
      .insert({user_id:currentUser.userId,tournament_id:TOURNAMENT.id,team_name:currentUser.manager+"'s Team"})
      .select('id,team_name').single();
    if(newTeam){ myTeamId=newTeam.id; myTeamName=newTeam.team_name; }
    myCaptainId=null; myCaptain2Id=null; myChip=null; myRosters={}; myTransferCount=0;
    return;
  }
  myTeamId     = team.id;
  myTeamName   = team.team_name;
  myCaptainId  = team.captain_id;
  myCaptain2Id = team.captain2_id;
  const chipRow = (team.active_chips||[]).find(c=>c.matchday_id===currentMDId);
  myChip = chipRow?.chip_name||null;
  myRosters = {};
  for(const r of (team.rosters||[])){ if(r.players) myRosters[r.slot]=r.players; }
  if(currentMDId&&myTeamId){
    const {count} = await sb.from('transfers')
      .select('*',{count:'exact',head:true}).eq('team_id',myTeamId).eq('matchday_id',currentMDId);
    myTransferCount = count||0;
  }
  await loadMySlotScores();
}

async function loadMySlotScores(){
  mySlotScores = {};
  if(!myTeamId||!currentMDId) return;
  const {data} = await sb.from('score_logs')
    .select('player_id,final_pts').eq('team_id',myTeamId).eq('matchday_id',currentMDId);
  for(const r of (data||[])){ mySlotScores[r.player_id]=(mySlotScores[r.player_id]||0)+r.final_pts; }
}

// ===== REALTIME =====
function subscribeRealtime(){
  sb.channel('valotasy-live')
    .on('postgres_changes',{event:'*',schema:'public',table:'matchday_scores'},(payload)=>{
      const active = document.querySelector('.page.active');
      if(active?.id==='page-lb') renderLB();
    })
    .on('postgres_changes',{event:'*',schema:'public',table:'matchdays'},(payload)=>{
      loadAppData().then(()=>{ renderLB(); if(currentUser) renderTeamPage(); });
    })
    .subscribe();
}

// ===== TOAST =====
function toast(msg,dur=2200){
  const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'),dur);
}

// ===== PAGE NAV =====
function goPage(id){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t=>t.classList.remove('active'));
  const map={lb:0,team:1,players:2,rules:3};
  document.querySelectorAll('.nav-tab')[map[id]].classList.add('active');
  if(id==='team'&&!currentUser){
    showLogin();
    document.querySelectorAll('.nav-tab').forEach(t=>t.classList.remove('active'));
    document.querySelectorAll('.nav-tab')[0].classList.add('active');
    document.getElementById('page-lb').classList.add('active');
    return;
  }
  document.getElementById('page-'+id).classList.add('active');
  if(id==='lb')    renderLB();
  if(id==='team')  renderTeamPage();
  if(id==='players') renderPlayersPage();
}

// ===== LEADERBOARD =====
async function renderLB(){
  const curMD = MATCHDAYS.find(m=>m.id===lbMDId);
  document.getElementById('lbMdNav').innerHTML = MATCHDAYS.map(md=>
    `<button class="md-btn ${md.id===lbMDId?'on':''}" onclick="lbMDId=${md.id};renderLB()">${md.label}</button>`
  ).join('');

  const [{data:teams},{data:mdScores},{data:chips}] = await Promise.all([
    sb.from('teams').select('id,team_name,total_points,users!inner(manager_name)').eq('tournament_id',TOURNAMENT.id).order('total_points',{ascending:false}),
    sb.from('matchday_scores').select('team_id,net_points').eq('matchday_id',lbMDId),
    sb.from('active_chips').select('team_id,chip_name').eq('matchday_id',lbMDId),
  ]);

  const scoreMap={}, chipMap={};
  for(const s of (mdScores||[])) scoreMap[s.team_id]=s.net_points;
  for(const c of (chips||[]))    chipMap[c.team_id]=c.chip_name;

  const topMD = teams?.length ? Math.max(0,...(teams.map(t=>scoreMap[t.id]||0))) : 0;
  document.getElementById('statsStrip').innerHTML=`
    <div class="stat-box"><div class="stat-lbl">Leader</div><div class="stat-val" style="font-size:20px">${teams?.[0]?.users?.manager_name||'—'}</div></div>
    <div class="stat-box"><div class="stat-lbl">Top MD</div><div class="stat-val">${topMD||'—'}</div></div>
    <div class="stat-box"><div class="stat-lbl">Teams</div><div class="stat-val">${teams?.length||0}</div></div>
    <div class="stat-box"><div class="stat-lbl">Matchday</div><div class="stat-val">${curMD?.label||'—'}</div></div>`;

  const body = document.getElementById('lbBody');
  if(!teams?.length){
    body.innerHTML='<div style="text-align:center;padding:60px;color:var(--muted);font-size:12px;letter-spacing:1px;text-transform:uppercase">No teams yet — invite your friends!</div>';
    return;
  }
  const marketOpen = curMD?.market_open ?? true;
  body.innerHTML = teams.map((t,i)=>{
    const gc=i===0?'g1':i===1?'g2':i===2?'g3':'';
    const mdPts = scoreMap[t.id]??0;
    const chipId = chipMap[t.id];
    const chipObj = chipId?CHIPS.find(c=>c.id===chipId):null;
    const hiClass = mdPts===topMD&&topMD>0?'hi':'';
    return `
    <div class="lb-row ${gc}" style="animation-delay:${i*.05}s" onclick="expandTeam('exp${i}','${t.id}')">
      <div class="rank-n">${i+1}</div>
      <div class="team-col"><div class="team-nm">${t.team_name}</div><div class="team-mgr">${t.users?.manager_name||''}</div></div>
      <div class="pts-big c">${t.total_points||0}</div>
      <div class="pts-md c ${hiClass}">${mdPts>=0?'+':''}${mdPts}</div>
      <div class="chip-col">${!marketOpen&&chipObj?`<span title="${chipObj.name}">${chipObj.icon}</span>`:'<span style="color:var(--muted);font-size:11px">—</span>'}</div>
      <div class="mv c" style="color:var(--muted)">—</div>
    </div>
    <div class="lb-expand" id="exp${i}">
      <div style="text-align:center;padding:16px;font-size:12px;color:var(--muted);font-family:monospace;letter-spacing:1px">
        ${marketOpen?'🔒 Squad revealed after deadline':'Click to view squad'}
      </div>
    </div>`;
  }).join('');
}

async function expandTeam(expId, teamId){
  document.querySelectorAll('.lb-expand').forEach(e=>{ if(e.id!==expId) e.classList.remove('open'); });
  const el = document.getElementById(expId);
  if(el.classList.contains('open')){ el.classList.remove('open'); return; }
  const curMD = MATCHDAYS.find(m=>m.id===lbMDId);
  if(curMD?.market_open){ el.classList.toggle('open'); return; }
  // Load roster + scores for this team
  const [{data:rosters},{data:logs}] = await Promise.all([
    sb.from('rosters').select('slot,players(id,name,role,vct_team)').eq('team_id',teamId),
    sb.from('score_logs').select('player_id,final_pts,is_captain').eq('team_id',teamId).eq('matchday_id',lbMDId),
  ]);
  const {data:teamRow} = await sb.from('teams').select('captain_id,captain2_id').eq('id',teamId).single();
  const logMap={};
  for(const l of (logs||[])) logMap[l.player_id]=(logMap[l.player_id]||0)+l.final_pts;
  const chips = document.createElement('div'); chips.className='player-chips';
  for(const r of (rosters||[])){
    const p=r.players; if(!p) continue;
    const pts=logMap[p.id]||0;
    const isCap=teamRow?.captain_id===p.id||teamRow?.captain2_id===p.id;
    chips.innerHTML+=`<div class="pc ${isCap?'cap':''}">
      <div class="pc-role">${p.role}</div>
      <div class="pc-name">${p.name}</div>
      <div class="pc-team">${p.vct_team}</div>
      <div class="pc-pts">${pts} pts</div></div>`;
  }
  el.innerHTML=''; el.appendChild(chips);
  el.classList.add('open');
}

// ===== MY TEAM =====
async function renderTeamPage(){
  if(!currentUser){ showLogin(); return; }
  document.getElementById('myTeamName').value  = myTeamName||'';
  document.getElementById('myManagerName').value = currentUser.manager||'';
  const curMD = MATCHDAYS.find(m=>m.id===currentMDId);
  const locked = !curMD?.market_open;
  document.getElementById('lockBanner').innerHTML = locked
    ? '<div class="lock-banner">🔒 Market is closed — transfers not allowed</div>' : '';
  renderDeadlineBanner(curMD);
  renderTransferInfo(curMD, locked);
  renderSlots();
  renderCaptainList();
  renderChipList();
  calcBudget();
  calcMyPts();
}

function renderDeadlineBanner(curMD){
  const el=document.getElementById('deadlineBanner'); if(!el) return;
  const dl=curMD?.deadline; if(!dl){el.innerHTML='';return;}
  const diff=new Date(dl)-new Date();
  if(diff<=0){el.innerHTML='<div class="lock-banner">⏰ Deadline has passed</div>';return;}
  const h=Math.floor(diff/3600000),m=Math.floor((diff%3600000)/60000),d=Math.floor(h/24);
  const label=d>0?`${d}d ${h%24}h ${m}m`:`${h}h ${m}m`;
  el.innerHTML=`<div style="background:rgba(0,212,255,0.06);border:1px solid rgba(0,212,255,0.2);padding:10px 16px;font-size:11px;color:var(--accent);letter-spacing:1px;margin-bottom:12px;display:flex;align-items:center;gap:8px;border-radius:4px">⏰ Deadline: <strong>${new Date(dl).toLocaleString('th-TH')}</strong> · Time left: <strong>${label}</strong></div>`;
}

function renderTransferInfo(curMD, locked){
  const tlEl=document.getElementById('transferLabel'); if(!tlEl) return;
  const isMD1 = MATCHDAYS[0]?.id===currentMDId;
  const penalty=TOURNAMENT?.transfer_penalty||8;
  const used=myTransferCount||0;
  if(isMD1){
    tlEl.innerHTML='<span style="color:#4ade80">MD1 — Unlimited transfers</span>';
    document.getElementById('penaltyPts').textContent='-0 pts';
  } else {
    const extra=Math.max(0,used-2);
    const penStr=extra>0?` &nbsp;<span style="color:var(--red)">+${extra} over (-${extra*penalty}pts)</span>`:'';
    tlEl.innerHTML=`Transfers this MD: <span style="color:${used>2?'var(--red)':'var(--text)'}">${used}</span>/2${penStr}`;
    document.getElementById('penaltyPts').textContent=`-${Math.max(0,used-2)*penalty} pts`;
  }
}

function renderSlots(){
  document.getElementById('slotsGrid').innerHTML=SLOTS.map(sl=>{
    const p=myRosters[sl.id];
    const isCap=p&&(myCaptainId===p.id||myCaptain2Id===p.id);
    const pts=p?mySlotScores[p.id]||0:0;
    const dispPts=isCap?pts*2:pts;
    return p?`<div class="slot filled ${isCap?'cap-slot':''}">
      <div class="slot-label" style="display:flex;justify-content:space-between;align-items:center">
        <span>${sl.label}</span>
        <button onclick="event.stopPropagation();removePlayer('${sl.id}')" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px;line-height:1;transition:.2s" onmouseover="this.style.color='var(--red)'" onmouseout="this.style.color='var(--muted)'">✕</button>
      </div>
      ${isCap?'<div class="cap-badge">C</div>':''}
      <div class="slot-name" onclick="openPicker('${sl.id}','${sl.label}')" style="cursor:pointer">${p.name}</div>
      <div class="slot-team" onclick="openPicker('${sl.id}','${sl.label}')" style="cursor:pointer">${p.vct_team} · <span class="tag tag-${p.tier}" style="font-size:8px">${p.tier}</span> · <span style="color:var(--accent)">${p.price}M</span></div>
      <div class="slot-pts">${dispPts}</div></div>`
    :`<div class="slot" onclick="openPicker('${sl.id}','${sl.label}')"><div class="slot-label">${sl.label}</div><div class="slot-empty">+ Pick a player</div></div>`;
  }).join('');
}

async function removePlayer(slotId){
  const p=myRosters[slotId]; if(!p) return;
  const curMD=MATCHDAYS.find(m=>m.id===currentMDId);
  if(!curMD?.market_open){toast('Market is closed — transfers not allowed');return;}
  delete myRosters[slotId];
  if(myCaptainId===p.id)  myCaptainId=null;
  if(myCaptain2Id===p.id) myCaptain2Id=null;
  await sb.from('rosters').delete().eq('team_id',myTeamId).eq('slot',slotId);
  await sb.from('teams').update({captain_id:myCaptainId,captain2_id:myCaptain2Id}).eq('id',myTeamId);
  renderTeamPage();
  toast('Player removed');
}

function renderCaptainList(){
  const el=document.getElementById('captainList');
  const filled=SLOTS.map(sl=>myRosters[sl.id]).filter(Boolean);
  if(!filled.length){el.innerHTML='<div style="font-size:11px;color:var(--muted)">Pick players first</div>';return;}
  el.innerHTML=filled.map(p=>{
    const isCap=myCaptainId===p.id, isCap2=myCaptain2Id===p.id;
    return`<div style="padding:7px 10px;background:var(--s2);border:1px solid ${isCap||isCap2?'var(--gold)':'var(--border2)'};margin-bottom:5px;display:flex;justify-content:space-between;align-items:center;cursor:pointer;transition:.2s;border-radius:4px" onclick="setCaptain(${p.id})">
      <span style="font-size:13px;font-weight:600">${p.name} <span style="color:var(--muted);font-size:10px">${p.vct_team}</span></span>
      ${isCap?'<span style="color:var(--gold);font-size:16px;font-weight:700">C</span>':isCap2?'<span style="color:var(--gold);font-size:14px;font-weight:700">C2</span>':'<span style="color:var(--muted);font-size:11px">Select</span>'}
    </div>`;
  }).join('');
}

async function setCaptain(pid){
  const curMD=MATCHDAYS.find(m=>m.id===currentMDId);
  if(!curMD?.market_open){toast('Market is closed');return;}
  if(myChip==='clonecap'){
    if(myCaptainId===pid) myCaptainId=null;
    else if(myCaptain2Id===pid) myCaptain2Id=null;
    else if(!myCaptainId) myCaptainId=pid;
    else if(!myCaptain2Id) myCaptain2Id=pid;
    else{ myCaptainId=pid; myCaptain2Id=null; }
  } else { myCaptainId=myCaptainId===pid?null:pid; myCaptain2Id=null; }
  await sb.from('teams').update({captain_id:myCaptainId,captain2_id:myCaptain2Id}).eq('id',myTeamId);
  renderSlots(); renderCaptainList(); calcMyPts();
}

function renderChipList(){
  document.getElementById('chipList').innerHTML=CHIPS.map(c=>{
    const isSelected=myChip===c.id;
    return`<div class="chip-item ${isSelected?'selected':''}" onclick="selectChip('${c.id}')">
      <div class="chip-icon">${c.icon}</div>
      <div class="chip-info"><div class="chip-nm">${c.name}</div><div class="chip-desc">${c.desc}</div></div>
      ${isSelected?'<div style="font-size:9px;color:var(--gold)">ON</div>':''}
    </div>`;
  }).join('');
}

async function selectChip(id){
  const curMD=MATCHDAYS.find(m=>m.id===currentMDId);
  if(!curMD?.market_open){toast('Market is closed');return;}
  const newChip=myChip===id?null:id;
  if(newChip===null){
    await sb.from('active_chips').delete().eq('team_id',myTeamId).eq('matchday_id',currentMDId);
  } else {
    await sb.from('active_chips').upsert({team_id:myTeamId,matchday_id:currentMDId,chip_name:newChip},{onConflict:'team_id,matchday_id'});
  }
  myChip=newChip;
  if(myChip!=='clonecap'){ myCaptain2Id=null; await sb.from('teams').update({captain2_id:null}).eq('id',myTeamId); }
  renderChipList(); renderCaptainList(); calcMyPts();
}

function calcBudget(){
  const budget=TOURNAMENT?.budget||100;
  const used=Object.values(myRosters).reduce((s,p)=>s+(p?.price||0),0);
  const left=budget-used;
  const el=document.getElementById('budgetLeft');
  const tot=document.getElementById('budgetTotal');
  el.textContent=left+'M'; el.style.color=left<0?'var(--red)':'var(--accent)';
  if(tot) tot.textContent='/'+budget+'M';
  return left;
}

function calcMyPts(){
  let total=0;
  for(const [slot,p] of Object.entries(myRosters)){
    if(!p) continue;
    const raw=mySlotScores[p.id]||0;
    const isCap=myCaptainId===p.id||myCaptain2Id===p.id;
    if(myChip==='topfragger'){
      // handled server-side; just show raw
      total+=raw;
    } else if(myChip==='triplecap'&&isCap) total+=raw*3;
    else if(isCap) total+=raw*2;
    else total+=raw;
  }
  // Subtract penalty
  const isMD1=MATCHDAYS[0]?.id===currentMDId;
  if(!isMD1&&myChip!=='wildcard'){
    const extra=Math.max(0,myTransferCount-2);
    total-=extra*(TOURNAMENT?.transfer_penalty||8);
  }
  document.getElementById('myTotalPts').textContent=total;
}

// ===== PLAYER PICKER =====
function openPicker(slotId,slotLabel){
  const curMD=MATCHDAYS.find(m=>m.id===currentMDId);
  if(!curMD?.market_open){toast('Market is closed — changes not allowed');return;}
  pickerSlot=slotId; pickerFilter='ALL';
  document.getElementById('pickerTitle').textContent='Pick '+slotLabel;
  document.getElementById('pickerSearch').value='';
  document.querySelectorAll('#pickerModal .filter-btn').forEach((b,i)=>b.classList.toggle('on',i===0));
  document.getElementById('pickerModal').classList.add('open');
  renderPicker();
}
function closePicker(){ document.getElementById('pickerModal').classList.remove('open'); pickerSlot=null; }
function setFilter(f,el){ pickerFilter=f; document.querySelectorAll('#pickerModal .filter-btn').forEach(b=>b.classList.remove('on')); el.classList.add('on'); renderPicker(); }

function renderPicker(){
  const q=document.getElementById('pickerSearch').value.toLowerCase();
  const slot=SLOTS.find(s=>s.id===pickerSlot);
  const isAnySlot=pickerSlot?.startsWith('any');
  const allowedRoles=slot?slot.roles:[];
  const selectedIds=Object.values(myRosters).filter(Boolean).map(p=>p.id);
  const teamCount={};
  selectedIds.forEach(pid=>{ const p=PLAYERS.find(pl=>pl.id===pid); if(p) teamCount[p.vct_team]=(teamCount[p.vct_team]||0)+1; });
  const list=PLAYERS.filter(p=>{
    if(q&&!p.name.toLowerCase().includes(q)&&!p.vct_team.toLowerCase().includes(q)) return false;
    if(pickerFilter!=='ALL'&&p.role!==pickerFilter) return false;
    return true;
  });
  if(!list.length){ document.getElementById('pickerBody').innerHTML='<div style="color:var(--muted);text-align:center;padding:32px;font-size:13px">No players found</div>'; return; }
  document.getElementById('pickerBody').innerHTML=list.map(p=>{
    const alreadyIn=selectedIds.includes(p.id)&&myRosters[pickerSlot]?.id!==p.id;
    const roleOk=isAnySlot||allowedRoles.includes(p.role);
    const teamFull=(teamCount[p.vct_team]||0)>=2&&!selectedIds.includes(p.id);
    const disabled=alreadyIn||!roleOk||teamFull;
    return`<div class="player-row">
      <div><div class="pr-name">${p.name}</div><div class="pr-vctt">${p.vct_team}</div></div>
      <div class="pr-role">${p.role}</div>
      <div class="pr-tier ${p.tier}">${p.tier}</div>
      <div class="pr-price">${p.price}M</div>
      <button class="pr-add" ${disabled?'disabled':''} onclick="pickPlayer(${p.id})">${alreadyIn?'In squad':teamFull?'Full':!roleOk?'✗':'Pick'}</button>
    </div>`;
  }).join('');
}

async function pickPlayer(pid){
  if(!pickerSlot) return;
  const p=PLAYERS.find(pl=>pl.id===pid); if(!p) return;
  const oldP=myRosters[pickerSlot];
  const net=(oldP?.price||0)-(p.price||0);
  if(calcBudget()+net<0){toast('Not enough budget!');return;}
  const isMD1=MATCHDAYS[0]?.id===currentMDId;
  const isWildcard=myChip==='wildcard';
  // Log transfer if swapping (not first pick, not MD1, not wildcard)
  if(oldP&&oldP.id!==p.id&&!isMD1&&!isWildcard&&currentMDId){
    const penApplied=myTransferCount>=2;
    await sb.from('transfers').insert({team_id:myTeamId,matchday_id:currentMDId,slot:pickerSlot,old_player_id:oldP.id,new_player_id:p.id,penalty_applied:penApplied});
    myTransferCount++;
  }
  // Upsert roster
  await sb.from('rosters').upsert({team_id:myTeamId,slot:pickerSlot,player_id:p.id},{onConflict:'team_id,slot'});
  myRosters[pickerSlot]=p;
  if(myCaptainId===oldP?.id)  myCaptainId=null;
  if(myCaptain2Id===oldP?.id) myCaptain2Id=null;
  if(myCaptainId||myCaptain2Id){
    await sb.from('teams').update({captain_id:myCaptainId,captain2_id:myCaptain2Id}).eq('id',myTeamId);
  }
  closePicker();
  renderTeamPage();
  toast(`${p.name} added ✓`);
}

// ===== SAVE / SUBMIT =====
async function saveAndSubmit(){
  if(!myTeamId){toast('Not logged in');return;}
  const nameEl=document.getElementById('myTeamName');
  const newName=nameEl?.value.trim()||myTeamName;
  if(!newName){toast('Please enter a team name');return;}
  if(calcBudget()<0){toast('Over budget — adjust your squad');return;}
  await sb.from('teams').update({team_name:newName}).eq('id',myTeamId);
  myTeamName=newName;
  document.getElementById('saveInfo').textContent='Saved at '+new Date().toLocaleTimeString('en-US');
  if(currentUser) document.getElementById('navUserName').textContent=newName||currentUser.manager;
  toast('Team saved ✓');
}

function saveMyTeam(){
  // Name input live change — no DB write needed, saved on "Save Team" click
}

async function deleteMyTeam(){
  if(!currentUser||!myTeamId){toast('Not logged in');return;}
  if(!confirm('Remove your team from the leaderboard?')) return;
  await sb.from('teams').delete().eq('id',myTeamId);
  myTeamId=null; myTeamName=currentUser.manager+"'s Team";
  myRosters={}; myCaptainId=null; myCaptain2Id=null; myChip=null; myTransferCount=0;
  // Re-create empty team
  const {data:newTeam} = await sb.from('teams')
    .insert({user_id:currentUser.userId,tournament_id:TOURNAMENT.id,team_name:myTeamName})
    .select('id,team_name').single();
  if(newTeam){ myTeamId=newTeam.id; myTeamName=newTeam.team_name; }
  renderTeamPage(); renderLB();
  toast('Team reset ✓');
}

function resetTeamToSaved(){ toast('No local save — changes are auto-saved to cloud'); }

// ===== PLAYERS PAGE =====
function setPlayersFilter(f,el){ playersFilter=f; document.querySelectorAll('#page-players .filter-btn').forEach(b=>b.classList.remove('on')); el.classList.add('on'); renderPlayersPage(); }

function renderPlayersPage(){
  const q=document.getElementById('playersSearch').value.toLowerCase();
  const list=PLAYERS.filter(p=>{
    if(q&&!p.name.toLowerCase().includes(q)&&!p.vct_team.toLowerCase().includes(q)) return false;
    if(playersFilter==='ALL') return true;
    if(['S','A','B','C'].includes(playersFilter)) return p.tier===playersFilter;
    return p.role===playersFilter;
  });
  const el=document.getElementById('playersGrid');
  if(!list.length){el.innerHTML='<div style="color:var(--muted);font-size:12px;padding:32px 0">No players found</div>';return;}
  const roleColor={Duelist:'#f87171',Initiator:'#60a5fa',Controller:'#a78bfa',Sentinel:'#34d399'};
  el.innerHTML=`<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(175px,1fr));gap:10px">
  ${list.map(p=>`<div class="card" style="padding:14px">
    <div style="font-size:9px;letter-spacing:1px;color:${roleColor[p.role]||'#9ca3af'}">${p.role}</div>
    <div style="font-size:15px;font-weight:700;margin-top:2px">${p.name}</div>
    <div style="font-size:11px;color:var(--muted);margin-top:2px">${p.vct_team}</div>
    <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-top:10px">
      <span class="tag tag-${p.tier}">${p.tier}</span>
      <span style="font-size:12px;color:var(--accent)">${p.price}M</span>
    </div>
  </div>`).join('')}
  </div>`;
}

// ===== ADMIN =====
function toggleAdmin(){ document.getElementById('adminModal').classList.add('open'); showAdminLock(); }
function showAdminLock(){
  document.getElementById('adminLock').style.display='block';
  document.getElementById('adminContent').style.display='none';
  document.getElementById('adminPw').value='';
}
function closeAdmin(){ document.getElementById('adminModal').classList.remove('open'); }
function checkAdmin(){
  if(document.getElementById('adminPw').value===TOURNAMENT?.admin_password||document.getElementById('adminPw').value==='08190349') showAdminContent();
  else toast('Wrong password');
}

function showAdminContent(){
  document.getElementById('adminLock').style.display='none';
  document.getElementById('adminContent').style.display='block';
  document.getElementById('adminToggle').classList.add('active-admin');
  renderAdminPlayers();
  renderAdminMatchdays();
  renderTeamListAdmin();
  populateFetchMDSelect();
  // Populate tournament settings
  document.getElementById('setPassword').value='';
  document.getElementById('setBudget').value=TOURNAMENT?.budget||100;
  document.getElementById('setPenalty').value=TOURNAMENT?.transfer_penalty||8;
}

function populateFetchMDSelect(){
  const sel=document.getElementById('fetchMDSelect');
  if(!sel) return;
  sel.innerHTML=MATCHDAYS.map(md=>`<option value="${md.id}">${md.label}</option>`).join('');
  // Default to current matchday
  if(currentMDId) sel.value=currentMDId;
}

async function fetchMatch(){
  const url=document.getElementById('fetchURL').value.trim();
  const mdId=parseInt(document.getElementById('fetchMDSelect').value);
  const resultEl=document.getElementById('fetchResult');
  if(!url){toast('Please enter a VLR match URL');return;}
  resultEl.textContent='⏳ Fetching match data...';
  resultEl.style.color='var(--muted)';
  try{
    const res=await fetch(`${SUPABASE_URL}/functions/v1/scrape-match`,{
      method:'POST',
      headers:{'Authorization':'Bearer '+SUPABASE_KEY,'Content-Type':'application/json'},
      body:JSON.stringify({match_url:url,matchday_id:mdId,tournament_id:TOURNAMENT.id}),
    });
    const data=await res.json();
    if(data.ok){
      resultEl.textContent=`✅ Match ${data.matchId}: ${data.players} players parsed, ${data.teamsScored} teams scored`;
      resultEl.style.color='#4ade80';
      toast(`Match imported ✓ — ${data.teamsScored} teams scored`);
      renderLB();
    } else {
      resultEl.textContent='❌ '+data.error;
      resultEl.style.color='var(--red)';
      toast(data.error);
    }
  } catch(e){
    resultEl.textContent='❌ Network error: '+e.message;
    resultEl.style.color='var(--red)';
  }
}

function renderAdminMatchdays(){
  const el=document.getElementById('mdAdminList'); if(!el) return;
  el.innerHTML=MATCHDAYS.map(md=>`
    <div style="display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:center;padding:8px 0;border-bottom:0.5px solid var(--border2)">
      <div style="font-size:12px;font-weight:600">${md.label} <span style="color:var(--muted);font-size:10px;font-weight:400">${md.phase}</span>
        <span style="margin-left:6px;font-size:9px;padding:2px 6px;border-radius:2px;background:${md.market_open?'rgba(74,222,128,0.15)':'rgba(255,70,85,0.1)'};color:${md.market_open?'#4ade80':'var(--red)'}">${md.market_open?'OPEN':'LOCKED'}</span>
      </div>
      <button onclick="setMarket(${md.id},${!md.market_open})" class="btn-sm ${md.market_open?'btn-del':'btn-edit'}">${md.market_open?'🔒 Lock':'🔓 Open'}</button>
      <button onclick="setDeadlinePrompt(${md.id})" class="btn-sm btn-edit">⏰</button>
    </div>`).join('');
}

async function setMarket(mdId, open){
  await sb.from('matchdays').update({market_open:open}).eq('id',mdId);
  const md=MATCHDAYS.find(m=>m.id===mdId); if(md) md.market_open=open;
  // Update currentMDId
  const openMD=[...MATCHDAYS].reverse().find(m=>m.market_open);
  currentMDId=openMD?.id||MATCHDAYS[MATCHDAYS.length-1]?.id||null;
  renderAdminMatchdays();
  toast(`${open?'Market opened':'Market locked'} ✓`);
}

async function setDeadlinePrompt(mdId){
  const dl=prompt('Enter deadline (ISO format, e.g. 2026-06-15T14:00):');
  if(!dl) return;
  await sb.from('matchdays').update({deadline:dl}).eq('id',mdId);
  const md=MATCHDAYS.find(m=>m.id===mdId); if(md) md.deadline=dl;
  toast('Deadline set ✓');
}

async function addPlayer(){
  const name=document.getElementById('aName').value.trim();
  if(!name){toast('Please enter a player name');return;}
  if(PLAYERS.find(p=>p.name.toLowerCase()===name.toLowerCase())){toast('Player already exists');return;}
  const tier=document.getElementById('aTier').value;
  const {data:newPlayer,error}=await sb.from('players').insert({
    tournament_id:TOURNAMENT.id, name,
    vct_team:document.getElementById('aTeam').value,
    role:document.getElementById('aRole').value,
    tier, price:TIER_PRICE[tier],
  }).select().single();
  if(error){toast('Error adding player');return;}
  PLAYERS.push(newPlayer);
  document.getElementById('aName').value='';
  renderAdminPlayers(); toast(`${name} added ✓`);
}

function renderAdminPlayers(){
  const el=document.getElementById('playerListAdmin');
  document.getElementById('playerCount').textContent=PLAYERS.length;
  if(!PLAYERS.length){el.innerHTML='<div style="color:var(--muted);font-size:12px;padding:8px">No players yet</div>';return;}
  const roleTag={Duelist:'D',Initiator:'I',Controller:'C',Sentinel:'Se'};
  el.innerHTML=PLAYERS.map(p=>`
    <div class="pla-row">
      <div>${p.name}<br><span style="color:var(--muted);font-size:10px">${p.vct_team}</span></div>
      <div><span class="tag tag-${roleTag[p.role]||'An'}">${p.role.slice(0,3)}</span></div>
      <div><span class="tag tag-${p.tier}">${p.tier}</span></div>
      <div style="color:var(--accent);font-size:11px">${p.price}M</div>
      <div class="pla-actions">
        <button class="btn-sm btn-edit" onclick="openEdit(${p.id})">✏️</button>
        <button class="btn-sm btn-del" onclick="deletePlayer(${p.id})">✕</button>
      </div>
    </div>`).join('');
}

function openEdit(id){
  const p=PLAYERS.find(pl=>pl.id===id); if(!p) return;
  document.getElementById('editId').value=id;
  document.getElementById('editName').value=p.name;
  document.getElementById('editTeam').value=p.vct_team;
  document.getElementById('editRole').value=p.role;
  document.getElementById('editTier').value=p.tier;
  document.getElementById('editModal').classList.add('open');
}
function closeEdit(){ document.getElementById('editModal').classList.remove('open'); }

async function saveEdit(){
  const id=parseInt(document.getElementById('editId').value);
  const tier=document.getElementById('editTier').value;
  const updates={name:document.getElementById('editName').value.trim(),vct_team:document.getElementById('editTeam').value,role:document.getElementById('editRole').value,tier,price:TIER_PRICE[tier]};
  await sb.from('players').update(updates).eq('id',id);
  const idx=PLAYERS.findIndex(p=>p.id===id);
  if(idx>=0) PLAYERS[idx]={...PLAYERS[idx],...updates};
  renderAdminPlayers(); closeEdit(); toast('Updated ✓');
}

async function deletePlayer(id){
  if(!confirm('Remove this player?')) return;
  await sb.from('players').delete().eq('id',id);
  PLAYERS=PLAYERS.filter(p=>p.id!==id);
  renderAdminPlayers(); toast('Removed ✓');
}

async function saveSettings(){
  const pw=document.getElementById('setPassword').value;
  const updates={budget:parseInt(document.getElementById('setBudget').value)||100,transfer_penalty:parseInt(document.getElementById('setPenalty').value)||8};
  if(pw) updates.admin_password=pw;
  await sb.from('tournaments').update(updates).eq('id',TOURNAMENT.id);
  Object.assign(TOURNAMENT,updates);
  toast('Settings saved ✓');
}

function renderTeamListAdmin(){
  const el=document.getElementById('teamListAdmin');
  const cEl=document.getElementById('teamCount');
  sb.from('teams').select('id,team_name,total_points,users!inner(manager_name)').eq('tournament_id',TOURNAMENT.id).order('total_points',{ascending:false})
    .then(({data:teams})=>{
      if(cEl) cEl.textContent=teams?.length||0;
      if(!el) return;
      if(!teams?.length){el.innerHTML='<div style="color:var(--muted);font-size:12px;padding:8px">No teams yet</div>';return;}
      el.innerHTML=teams.map(t=>`
        <div style="display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;padding:10px 0;border-bottom:0.5px solid var(--border2)">
          <div>
            <div style="font-size:13px;font-weight:600">${t.team_name}</div>
            <div style="font-size:11px;color:var(--muted)">👤 ${t.users?.manager_name||'—'} &nbsp;·&nbsp; ⭐ ${t.total_points||0} pts</div>
          </div>
          <button onclick="deleteTeamAdmin('${t.id}')" class="btn-sm btn-del">🗑 Delete</button>
        </div>`).join('');
    });
}

async function deleteTeamAdmin(teamId){
  if(!confirm('Delete this team?')) return;
  await sb.from('teams').delete().eq('id',teamId);
  renderTeamListAdmin(); renderLB();
  toast('Team deleted ✓');
}

// ===== EDIT TEAM ADMIN MODAL =====
function openEditTeamAdmin(){}
function closeEditTeamAdmin(){ document.getElementById('editTeamAdminModal').classList.remove('open'); }
async function saveEditTeamAdmin(){
  const teamId=document.getElementById('editTeamAdminId').value;
  const newName=document.getElementById('editTeamAdminName').value.trim();
  if(!newName){toast('Name cannot be empty');return;}
  await sb.from('teams').update({team_name:newName}).eq('id',teamId);
  closeEditTeamAdmin(); renderTeamListAdmin(); renderLB();
  toast('Team updated ✓');
}

// ===== DB + ENSURE =====
const SETUP_SQL = `-- Run in Supabase SQL Editor
CREATE TABLE IF NOT EXISTS valotasy_data (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW());
ALTER TABLE valotasy_data ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_access" ON valotasy_data FOR ALL USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), manager_name TEXT NOT NULL UNIQUE, pin_hash TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW());
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_access" ON users FOR ALL USING (true) WITH CHECK (true);
-- (Run full schema.sql for all tables)`;

async function ensureDB(){
  const {error} = await sb.from('tournaments').select('id').limit(1);
  if(!error) return true;
  const overlay=document.getElementById('dbSetupOverlay');
  if(overlay) overlay.classList.add('open');
  document.getElementById('lbBody').innerHTML='<div style="text-align:center;padding:60px;color:var(--muted);font-size:12px;letter-spacing:1px">⚠️ Database not set up yet</div>';
  return false;
}

function copySetupSQL(){ navigator.clipboard.writeText(SETUP_SQL).then(()=>toast('SQL copied ✓')); }

// ===== DEFAULT PLAYERS (seed) =====
const DEFAULT_PLAYERS=[
  {name:'koshmaras',team:'Team Heretics',  role:'Controller',tier:'B',price:10},
  {name:'Wo0t',    team:'Team Heretics',  role:'Initiator', tier:'B',price:10},
  {name:'RieNs',   team:'Team Heretics',  role:'Duelist',   tier:'A',price:16},
  {name:'benjyfishy',team:'Team Heretics',role:'Sentinel',  tier:'A',price:16},
  {name:'Boo',     team:'Team Heretics',  role:'Controller',tier:'C',price:6},
  {name:'Jamppi',  team:'Team Vitality',  role:'Initiator', tier:'B',price:10},
  {name:'PROFEK',  team:'Team Vitality',  role:'Controller',tier:'C',price:6},
  {name:'Derke',   team:'Team Vitality',  role:'Duelist',   tier:'S',price:24},
  {name:'Chronicle',team:'Team Vitality', role:'Sentinel',  tier:'S',price:24},
  {name:'Sayonara',team:'Team Vitality',  role:'Duelist',   tier:'S',price:24},
  {name:'s0pp',    team:'FUT Esports',    role:'Duelist',   tier:'B',price:10},
  {name:'xeus',    team:'FUT Esports',    role:'Initiator', tier:'C',price:6},
  {name:'yetujey', team:'FUT Esports',    role:'Controller',tier:'C',price:6},
  {name:'KROSTALY',team:'FUT Esports',    role:'Sentinel',  tier:'C',price:6},
  {name:'sociablEE',team:'FUT Esports',   role:'Initiator', tier:'C',price:6},
  {name:'kiNgg',   team:'Leviatán',       role:'Duelist',   tier:'A',price:16},
  {name:'blowz',   team:'Leviatán',       role:'Initiator', tier:'B',price:10},
  {name:'Sato',    team:'Leviatán',       role:'Controller',tier:'B',price:10},
  {name:'spikeziN',team:'Leviatán',       role:'Sentinel',  tier:'B',price:10},
  {name:'Neon',    team:'Leviatán',       role:'Controller',tier:'S',price:24},
  {name:'BABYBAY', team:'G2 Esports',     role:'Duelist',   tier:'B',price:10},
  {name:'valyn',   team:'G2 Esports',     role:'Initiator', tier:'B',price:10},
  {name:'jawgemo', team:'G2 Esports',     role:'Controller',tier:'A',price:16},
  {name:'leaf',    team:'G2 Esports',     role:'Sentinel',  tier:'A',price:16},
  {name:'trent',   team:'G2 Esports',     role:'Initiator', tier:'S',price:24},
  {name:'Ethan',   team:'NRG',            role:'Initiator', tier:'A',price:16},
  {name:'keiko',   team:'NRG',            role:'Duelist',   tier:'B',price:10},
  {name:'mada',    team:'NRG',            role:'Controller',tier:'B',price:10},
  {name:'skuba',   team:'NRG',            role:'Sentinel',  tier:'B',price:10},
  {name:'brawk',   team:'NRG',            role:'Duelist',   tier:'S',price:24},
  {name:'Jinggg',  team:'Paper Rex',      role:'Duelist',   tier:'S',price:24},
  {name:'f0rsakeN',team:'Paper Rex',      role:'Initiator', tier:'A',price:16},
  {name:'d4v41',   team:'Paper Rex',      role:'Controller',tier:'B',price:10},
  {name:'something',team:'Paper Rex',     role:'Sentinel',  tier:'S',price:24},
  {name:'invy',    team:'Paper Rex',      role:'Duelist',   tier:'C',price:6},
  {name:'nobody',  team:'EDward Gaming',  role:'Duelist',   tier:'B',price:10},
  {name:'ZmjjKK',  team:'EDward Gaming',  role:'Initiator', tier:'S',price:24},
  {name:'Smoggy',  team:'EDward Gaming',  role:'Controller',tier:'A',price:16},
  {name:'CHICHOO', team:'EDward Gaming',  role:'Sentinel',  tier:'A',price:16},
  {name:'cb',      team:'EDward Gaming',  role:'Initiator', tier:'C',price:6},
  {name:'WsLeo',   team:'XLG Esports',   role:'Duelist',   tier:'B',price:10},
  {name:'Rarga',   team:'XLG Esports',   role:'Initiator', tier:'C',price:6},
  {name:'NoMan',   team:'XLG Esports',   role:'Controller',tier:'C',price:6},
  {name:'Lysoar',  team:'XLG Esports',   role:'Sentinel',  tier:'C',price:6},
  {name:'happywei',team:'XLG Esports',   role:'Duelist',   tier:'S',price:24},
  {name:'vo0kashu',team:'Dragon Ranger Gaming',role:'Duelist',  tier:'A',price:16},
  {name:'Life',    team:'Dragon Ranger Gaming',role:'Initiator',tier:'C',price:6},
  {name:'Nicc',    team:'Dragon Ranger Gaming',role:'Controller',tier:'C',price:6},
  {name:'SpiritZ1',team:'Dragon Ranger Gaming',role:'Sentinel', tier:'C',price:6},
  {name:'Flex1n',  team:'Dragon Ranger Gaming',role:'Controller',tier:'C',price:6},
  {name:'PatMen',  team:'Global Esports', role:'Duelist',   tier:'B',price:10},
  {name:'Wronski', team:'Global Esports', role:'Initiator', tier:'C',price:6},
  {name:'AAAY',    team:'Global Esports', role:'Controller',tier:'B',price:10},
  {name:'TChomps', team:'Global Esports', role:'Sentinel',  tier:'C',price:6},
  {name:'stellar', team:'Global Esports', role:'Initiator', tier:'C',price:6},
  {name:'Crws',    team:'FULL SENSE',     role:'Duelist',   tier:'A',price:16},
  {name:'JitboyS', team:'FULL SENSE',     role:'Initiator', tier:'B',price:10},
  {name:'Primmie', team:'FULL SENSE',     role:'Controller',tier:'S',price:24},
  {name:'Surf',    team:'FULL SENSE',     role:'Sentinel',  tier:'C',price:6},
  {name:'ChAlalala',team:'FULL SENSE',    role:'Initiator', tier:'C',price:6},
];

// ===== INIT =====
async function init(){
  const dbReady = await ensureDB();
  if(!dbReady) return;
  const ok = await loadAppData();
  if(!ok) return;
  await seedPlayers();
  await tryAutoLogin();
  subscribeRealtime();
  renderLB();
}

init();
