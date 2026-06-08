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
let FIXTURES   = [];
let predMDId   = null;
let currentMDId = null;
let lbMDId      = null;
let _countdownTimer = null;

// My team state (draft — not persisted until confirmTeam())
let myTeamId       = null;
let myTeamName     = '';
let myRosters      = {}; // {slot: playerRow}   ← draft
let myBuyPrices    = {}; // {slot: price_paid}   ← draft
let myBudgetAdj    = 0;  // kept for compat — actual budget uses calcDraftBudgetAdj()
let myCaptainId    = null;
let myCaptain2Id   = null;
let myChip         = null;
let myTransferCount = 0;
let mySlotScores   = {}; // {playerId: finalPts} for current MD

// Saved state — snapshot of last DB-committed squad (for diff & discard)
let savedRosters      = {};
let savedBuyPrices    = {};
let savedBudgetAdj    = 0;
let savedCaptainId    = null;
let savedCaptain2Id   = null;
let savedTransferCount = 0;
let isDirty           = false;

// UI state
let pickerSlot = null, pickerFilter = 'ALL', playersFilter = 'ALL';

// ===== MARKET LOCK =====
function isMarketLocked(md){
  if(!md) return true;
  if(!md.market_open) return true;                                      // admin locked
  if(md.deadline && new Date() > new Date(md.deadline)) return true;   // deadline passed
  return false;
}

// ===== DATA LOADING =====
async function loadAppData(){
  document.getElementById('lbBody').innerHTML =
    '<div style="text-align:center;padding:40px;color:var(--muted);font-size:12px;letter-spacing:1px">Loading...</div>';
  const {data:tourney} = await sb.from('tournaments').select('*').eq('status','active').single();
  if(!tourney){ console.error('No active tournament'); return false; }
  TOURNAMENT = tourney;
  const [{data:mds},{data:players},{data:fixtures}] = await Promise.all([
    sb.from('matchdays').select('*').eq('tournament_id',tourney.id).order('matchday_number'),
    sb.from('players').select('*').eq('tournament_id',tourney.id).order('name'),
    sb.from('fixtures').select('*').eq('tournament_id',tourney.id).order('scheduled_time'),
  ]);
  MATCHDAYS = mds||[];
  PLAYERS   = players||[];
  FIXTURES  = fixtures||[];
  const openMD = [...MATCHDAYS].reverse().find(m=>m.market_open);
  const lastMD = MATCHDAYS[MATCHDAYS.length-1];
  currentMDId = openMD?.id || lastMD?.id || null;
  lbMDId = currentMDId;
  if (!predMDId) predMDId = currentMDId;
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
    .select('id,team_name,captain_id,captain2_id,total_points,budget_adjustment,rosters(slot,player_id,buy_price,players(*)),active_chips(chip_name,matchday_id)')
    .eq('user_id',currentUser.userId).eq('tournament_id',TOURNAMENT.id).single();
  if(!team){
    const {data:newTeam} = await sb.from('teams')
      .insert({user_id:currentUser.userId,tournament_id:TOURNAMENT.id,team_name:currentUser.manager+"'s Team"})
      .select('id,team_name').single();
    if(newTeam){ myTeamId=newTeam.id; myTeamName=newTeam.team_name; }
    myCaptainId=null; myCaptain2Id=null; myChip=null; myRosters={}; myBuyPrices={}; myBudgetAdj=0; myTransferCount=0;
    return;
  }
  myTeamId     = team.id;
  myTeamName   = team.team_name;
  myCaptainId  = team.captain_id;
  myCaptain2Id = team.captain2_id;
  const chipRow = (team.active_chips||[]).find(c=>c.matchday_id===currentMDId);
  myChip = chipRow?.chip_name||null;
  myBudgetAdj = team.budget_adjustment ?? 0;
  myRosters = {}; myBuyPrices = {};
  for(const r of (team.rosters||[])){
    if(r.players){ myRosters[r.slot]=r.players; myBuyPrices[r.slot]=r.buy_price??r.players.price; }
  }
  if(currentMDId&&myTeamId){
    const {count} = await sb.from('transfers')
      .select('*',{count:'exact',head:true}).eq('team_id',myTeamId).eq('matchday_id',currentMDId);
    myTransferCount = count||0;
  }
  // Snapshot DB state — used for diff (change log) and discard
  savedRosters      = Object.fromEntries(Object.entries(myRosters).map(([k,v])=>[k,v]));
  savedBuyPrices    = {...myBuyPrices};
  savedBudgetAdj    = myBudgetAdj;
  savedCaptainId    = myCaptainId;
  savedCaptain2Id   = myCaptain2Id;
  savedTransferCount = myTransferCount;
  isDirty           = false;
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
    .on('postgres_changes',{event:'*',schema:'public',table:'predictions'},(payload)=>{
      const active=document.querySelector('.page.active');
      if(active?.id==='page-predict') renderPredictPage();
    })
    .on('postgres_changes',{event:'UPDATE',schema:'public',table:'players'},(payload)=>{
      const updated=payload.new; if(!updated) return;
      // Keep PLAYERS array in sync
      const lp=PLAYERS.find(p=>p.id===updated.id);
      if(lp) lp.price=updated.price;
      // Keep draft + saved rosters in sync so sell price uses current price
      for(const rp of Object.values(myRosters)){ if(rp?.id===updated.id) rp.price=updated.price; }
      for(const rp of Object.values(savedRosters)){ if(rp?.id===updated.id) rp.price=updated.price; }
      const active=document.querySelector('.page.active');
      if(active?.id==='page-team') renderSlots();
      if(active?.id==='page-players') renderPlayers?.();
    })
    .on('postgres_changes',{event:'*',schema:'public',table:'fixtures'},(payload)=>{
      const ev=payload.eventType;
      if(ev==='INSERT'&&payload.new) FIXTURES.push(payload.new);
      else if(ev==='UPDATE'&&payload.new){
        const idx=FIXTURES.findIndex(f=>f.id===payload.new.id);
        if(idx>=0) FIXTURES[idx]=payload.new; else FIXTURES.push(payload.new);
      } else if(ev==='DELETE'&&payload.old){
        FIXTURES=FIXTURES.filter(f=>f.id!==payload.old.id);
      }
      const active=document.querySelector('.page.active');
      if(active?.id==='page-schedule') renderSchedulePage();
    })
    .subscribe();
}

// ===== TOAST =====
function toast(msg,dur=2200){
  const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'),dur);
}

let _confirmResolve=null;
function showConfirm(title, msg, okLabel='Confirm'){
  return new Promise(resolve=>{
    _confirmResolve=resolve;
    document.getElementById('confirmTitle').textContent=title;
    document.getElementById('confirmMsg').textContent=msg;
    document.getElementById('confirmOkBtn').textContent=okLabel;
    document.getElementById('confirmModal').classList.add('open');
  });
}
function resolveConfirm(result){
  document.getElementById('confirmModal').classList.remove('open');
  if(_confirmResolve){ _confirmResolve(result); _confirmResolve=null; }
}

// ===== DRAFT STATE HELPERS =====

// Budget adjustment from original players truly removed from squad (not just rearranged)
function calcDraftBudgetAdj(){
  const currentIds=new Set(Object.values(myRosters).map(p=>p?.id).filter(Boolean));
  let adj=savedBudgetAdj;
  for(const sl of SLOTS){
    const orig=savedRosters[sl.id];
    if(!orig||currentIds.has(orig.id)) continue; // still in squad somewhere
    const bp=savedBuyPrices[sl.id]||orig.price;
    adj-=(bp-Math.min(bp,orig.price)); // deduct realized loss (0 if price rose)
  }
  return adj;
}

// Total transfers for this MD including unsaved draft picks
function calcDraftTransfers(){
  const savedIds=new Set(Object.values(savedRosters).map(p=>p?.id).filter(Boolean));
  let count=savedTransferCount;
  for(const p of Object.values(myRosters)){
    if(p&&!savedIds.has(p.id)) count++;
  }
  return count;
}

// Numeric budget remaining (does not update DOM)
function getDraftBudget(){
  const budget=TOURNAMENT?.budget||100;
  const used=Object.values(myBuyPrices).reduce((s,v)=>s+(v||0),0);
  return budget-used+calcDraftBudgetAdj();
}

// ===== PAGE NAV =====
function goPage(id){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t=>t.classList.remove('active'));
  const map={lb:0,team:1,players:2,rules:3,schedule:4,predict:5};
  document.querySelectorAll('.nav-tab')[map[id]].classList.add('active');
  if((id==='team'||id==='predict')&&!currentUser){
    showLogin();
    document.querySelectorAll('.nav-tab').forEach(t=>t.classList.remove('active'));
    document.querySelectorAll('.nav-tab')[0].classList.add('active');
    document.getElementById('page-lb').classList.add('active');
    return;
  }
  document.getElementById('page-'+id).classList.add('active');
  if(id==='lb'){ renderLB(); startCountdown(); }
  else stopCountdown();
  if(id==='team')     renderTeamPage();
  if(id==='players')  renderPlayersPage();
  if(id==='schedule') renderSchedulePage();
  if(id==='predict')  renderPredictPage();
}

// ===== LEADERBOARD =====
async function renderLB(){
  const curMD = MATCHDAYS.find(m=>m.id===lbMDId);
  document.getElementById('lbMdNav').innerHTML = MATCHDAYS.map(md=>
    `<button class="md-btn ${md.id===lbMDId?'on':''}" onclick="lbMDId=${md.id};renderLB();startCountdown()">${md.label}</button>`
  ).join('');

  // IDs of all matchdays up to and including the selected one (for cumulative total)
  const mdIdsUpTo = MATCHDAYS.filter(m=>m.matchday_number<=(curMD?.matchday_number||0)).map(m=>m.id);

  const [{data:teams},{data:mdScores},{data:allScores},{data:chips}] = await Promise.all([
    sb.from('teams').select('id,team_name,users!inner(manager_name)').eq('tournament_id',TOURNAMENT.id),
    sb.from('matchday_scores').select('team_id,net_points').eq('matchday_id',lbMDId),
    mdIdsUpTo.length
      ? sb.from('matchday_scores').select('team_id,net_points').in('matchday_id',mdIdsUpTo)
      : Promise.resolve({data:[]}),
    sb.from('active_chips').select('team_id,chip_name').eq('matchday_id',lbMDId),
  ]);

  // Cumulative total through the selected matchday (frozen — based on locked matchday_scores rows)
  const cumulMap={}, scoreMap={}, chipMap={};
  for(const s of (allScores||[]))  cumulMap[s.team_id]=(cumulMap[s.team_id]||0)+(s.net_points||0);
  for(const s of (mdScores||[]))   scoreMap[s.team_id]=s.net_points;
  for(const c of (chips||[]))      chipMap[c.team_id]=c.chip_name;

  // Sort by cumulative total at end of selected matchday
  const sorted=[...(teams||[])].sort((a,b)=>(cumulMap[b.id]||0)-(cumulMap[a.id]||0));

  const topMD = sorted.length ? Math.max(0,...sorted.map(t=>scoreMap[t.id]||0)) : 0;
  document.getElementById('statsStrip').innerHTML=`
    <div class="stat-box"><div class="stat-lbl">Leader</div><div class="stat-val" style="font-size:20px">${sorted[0]?.users?.manager_name||'—'}</div></div>
    <div class="stat-box"><div class="stat-lbl">Top MD</div><div class="stat-val">${topMD||'—'}</div></div>
    <div class="stat-box"><div class="stat-lbl">Teams</div><div class="stat-val">${sorted.length||0}</div></div>
    <div class="stat-box"><div class="stat-lbl">Matchday</div><div class="stat-val">${curMD?.label||'—'}</div></div>`;

  renderLBDeadline();
  const body = document.getElementById('lbBody');
  if(!sorted.length){
    body.innerHTML='<div style="text-align:center;padding:60px;color:var(--muted);font-size:12px;letter-spacing:1px;text-transform:uppercase">No teams yet — invite your friends!</div>';
    return;
  }
  const marketOpen = !isMarketLocked(curMD);
  body.innerHTML = sorted.map((t,i)=>{
    const gc=i===0?'g1':i===1?'g2':i===2?'g3':'';
    const mdPts  = scoreMap[t.id]??0;
    const cumul  = cumulMap[t.id]||0;
    const chipId = chipMap[t.id];
    const chipObj = chipId?CHIPS.find(c=>c.id===chipId):null;
    const hiClass = mdPts===topMD&&topMD>0?'hi':'';
    return `
    <div class="lb-row ${gc}" style="animation-delay:${i*.05}s" onclick="expandTeam('exp${i}','${t.id}')">
      <div class="rank-n">${i+1}</div>
      <div class="team-col"><div class="team-nm">${t.team_name}</div><div class="team-mgr">${t.users?.manager_name||''}</div></div>
      <div class="pts-big c">${cumul}</div>
      <div class="pts-md c ${hiClass}">${mdPts>=0?'+':''}${mdPts}</div>
      <div class="chip-col">${!marketOpen&&chipObj?`<span title="${chipObj.name}">${chipObj.icon}</span>`:'<span style="color:var(--muted);font-size:11px">—</span>'}</div>
      <div class="mv c" style="color:var(--muted)">—</div>
    </div>
    <div class="lb-expand" id="exp${i}">
      <div style="text-align:center;padding:16px;font-size:12px;color:var(--muted);font-family:monospace;letter-spacing:1px">
        ${marketOpen?'Click to view squad':'🔒 Squad revealed after deadline'}
      </div>
    </div>`;
  }).join('');
}

function startCountdown(){
  stopCountdown();
  renderLBDeadline();
  _countdownTimer = setInterval(renderLBDeadline, 1000);
}

function stopCountdown(){
  if(_countdownTimer){ clearInterval(_countdownTimer); _countdownTimer=null; }
}

function renderLBDeadline(){
  const el = document.getElementById('lbDeadlineBanner');
  if(!el) return;

  // Use the deadline of the matchday being viewed in LB
  const md = MATCHDAYS.find(m=>m.id===lbMDId);
  if(!md?.deadline){
    el.innerHTML='';
    return;
  }

  const now  = new Date();
  const target = new Date(md.deadline);
  const diff = target - now;

  if(diff <= 0){
    el.innerHTML=`
      <div style="background:rgba(255,70,85,0.08);border:0.5px solid rgba(255,70,85,0.3);
        padding:10px 16px;border-radius:4px;margin-bottom:14px;
        display:flex;align-items:center;gap:10px;font-size:12px;font-weight:500;color:var(--red)">
        🔒 Deadline passed — transfers closed
      </div>`;
    stopCountdown();
    return;
  }

  const totalSec = Math.floor(diff/1000);
  const days  = Math.floor(totalSec/86400);
  const hours = Math.floor((totalSec%86400)/3600);
  const mins  = Math.floor((totalSec%3600)/60);
  const secs  = totalSec%60;

  const pad = n=>String(n).padStart(2,'0');
  const parts = days>0
    ? `${days}d ${pad(hours)}h ${pad(mins)}m ${pad(secs)}s`
    : `${pad(hours)}h ${pad(mins)}m ${pad(secs)}s`;

  // Colour shifts red as deadline approaches (< 1 hour)
  const urgent = diff < 3600000;
  const color  = urgent ? 'var(--red)' : 'var(--accent)';
  const bg     = urgent ? 'rgba(255,70,85,0.06)' : 'rgba(0,212,255,0.06)';
  const border = urgent ? 'rgba(255,70,85,0.25)' : 'rgba(0,212,255,0.2)';

  const deadlineStr = target.toLocaleString('en-GB',{
    day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'
  });

  el.innerHTML=`
    <div style="background:${bg};border:0.5px solid ${border};
      padding:10px 16px;border-radius:4px;margin-bottom:14px;
      display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
      <div style="font-size:11px;color:var(--muted)">
        ⏰ <strong style="color:${color}">${md.label}</strong> Deadline: ${deadlineStr}
      </div>
      <div style="font-size:20px;font-weight:700;letter-spacing:2px;color:${color};font-variant-numeric:tabular-nums">
        ${parts}
      </div>
    </div>`;
}

async function expandTeam(expId, teamId){
  document.querySelectorAll('.lb-expand').forEach(e=>{ if(e.id!==expId) e.classList.remove('open'); });
  const el = document.getElementById(expId);
  if(!el) return;
  if(el.classList.contains('open')){ el.classList.remove('open'); return; }

  // Always fetch fresh matchday status — don't trust potentially stale MATCHDAYS cache
  const {data:freshMD} = await sb.from('matchdays').select('market_open,deadline').eq('id',lbMDId).single();
  const locked = freshMD ? isMarketLocked(freshMD) : true;

  if(!locked){
    // Market still open — hide squads
    el.innerHTML='<div style="text-align:center;padding:16px;font-size:12px;color:var(--muted);letter-spacing:1px">🔒 Squad revealed after deadline</div>';
    el.classList.add('open');
    return;
  }

  // Deadline passed — show squad
  el.innerHTML='<div style="text-align:center;padding:16px;font-size:12px;color:var(--muted)">Loading...</div>';
  el.classList.add('open');

  // Use separate queries to avoid FK join issues
  const [{data:rosters},{data:logs},{data:teamRow}] = await Promise.all([
    sb.from('rosters').select('slot,player_id').eq('team_id',teamId),
    sb.from('score_logs').select('player_id,final_pts').eq('team_id',teamId).eq('matchday_id',lbMDId),
    sb.from('teams').select('captain_id,captain2_id').eq('id',teamId).single(),
  ]);

  const playerIds = (rosters||[]).map(r=>r.player_id).filter(Boolean);
  const {data:playerList} = playerIds.length
    ? await sb.from('players').select('id,name,role,vct_team').in('id',playerIds)
    : {data:[]};

  const playerMap={};
  for(const p of (playerList||[])) playerMap[p.id]=p;

  const logMap={};
  for(const l of (logs||[])) logMap[l.player_id]=(logMap[l.player_id]||0)+l.final_pts;

  const chips = document.createElement('div'); chips.className='player-chips';
  for(const r of (rosters||[])){
    if(!r.player_id) continue;
    const p=playerMap[r.player_id]; if(!p) continue;
    const pts=logMap[p.id]||0;
    const isCap=teamRow?.captain_id===p.id||teamRow?.captain2_id===p.id;
    chips.innerHTML+=`<div class="pc ${isCap?'cap':''}">
      <div class="pc-role">${p.role}</div>
      <div class="pc-name">${p.name}</div>
      <div class="pc-team">${p.vct_team}</div>
      <div class="pc-pts">${pts} pts</div></div>`;
  }

  // Guard: only update if element is still in the DOM (not wiped by re-render)
  if(document.getElementById(expId)){
    el.innerHTML='';
    el.appendChild(chips);
  }
}

// ===== MY TEAM =====
async function renderTeamPage(){
  if(!currentUser){ showLogin(); return; }
  document.getElementById('myTeamName').value  = myTeamName||'';
  document.getElementById('myManagerName').value = currentUser.manager||'';
  const curMD = MATCHDAYS.find(m=>m.id===currentMDId);
  const locked = isMarketLocked(curMD);
  document.getElementById('lockBanner').innerHTML = locked
    ? '<div class="lock-banner">🔒 Market is closed — transfers not allowed</div>' : '';
  renderDeadlineBanner(curMD);
  renderTransferInfo(curMD, locked);
  renderSlots();
  renderCaptainList();
  renderChipList();
  calcBudget();
  calcMyPts();
  renderChangesPanel();
  // Save bar state
  const discardBtn=document.getElementById('discardBtn');
  const confirmBtn=document.getElementById('confirmBtn');
  const saveInfo=document.getElementById('saveInfo');
  if(discardBtn) discardBtn.style.display=isDirty?'':'none';
  if(confirmBtn){ confirmBtn.textContent=isDirty?'✓ Confirm & Save':'✓ Save Team'; confirmBtn.classList.toggle('btn-accent',isDirty); }
  if(saveInfo) saveInfo.textContent=isDirty?'Unsaved changes':'All changes saved';
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
  const isWildcardActive = myChip==='wildcard';
  const penalty=TOURNAMENT?.transfer_penalty||8;
  const used=calcDraftTransfers();
  if(isMD1){
    tlEl.innerHTML='<span style="color:#4ade80">MD1 — Unlimited transfers</span>';
    document.getElementById('penaltyPts').textContent='-0 pts';
  } else if(isWildcardActive){
    tlEl.innerHTML=`Transfers this MD: <span style="color:#4ade80">${used}</span> &nbsp;<span style="color:#4ade80">🃏 Wildcard — no penalty</span>`;
    document.getElementById('penaltyPts').textContent='-0 pts';
  } else {
    const extra=Math.max(0,used-2);
    const penStr=extra>0?` &nbsp;<span style="color:var(--red)">+${extra} over (-${extra*penalty}pts)</span>`:'';
    tlEl.innerHTML=`Transfers this MD: <span style="color:${used>2?'var(--red)':'var(--text)'}">${used}</span>/2${penStr}`;
    document.getElementById('penaltyPts').textContent=`-${Math.max(0,used-2)*penalty} pts`;
  }
}

let dragSlot=null;

function renderSlots(){
  document.getElementById('slotsGrid').innerHTML=SLOTS.map(sl=>{
    const p=myRosters[sl.id];
    const isCap=p&&(myCaptainId===p.id||myCaptain2Id===p.id);
    const pts=p?mySlotScores[p.id]||0:0;
    const dispPts=isCap?pts*2:pts;
    const changed=savedRosters[sl.id]?.id!==p?.id;
    const pendingClass=changed?'slot-pending':'';
    return p
      ?`<div id="slot_${sl.id}" class="slot filled ${isCap?'cap-slot':''} ${pendingClass}"
          ondragover="slotDragOver(event,'${sl.id}')" ondragleave="slotDragLeave('${sl.id}')" ondrop="slotDrop(event,'${sl.id}')">
          <div class="slot-label" style="display:flex;justify-content:space-between;align-items:center">
            <span style="display:flex;align-items:center;gap:5px">
              <span class="drag-handle" draggable="true"
                ondragstart="slotDragStart(event,'${sl.id}')"
                ondragend="slotDragEnd(event,'${sl.id}')"
                title="Drag to rearrange">⠿</span>
              ${sl.label}
            </span>
            <button onclick="event.stopPropagation();removePlayer('${sl.id}')" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px;line-height:1;transition:.2s" onmouseover="this.style.color='var(--red)'" onmouseout="this.style.color='var(--muted)'">✕</button>
          </div>
          ${isCap?'<div class="cap-badge">C</div>':''}
          <div class="slot-name" onclick="openPicker('${sl.id}','${sl.label}')" style="cursor:pointer">${p.name}</div>
          <div class="slot-team" onclick="openPicker('${sl.id}','${sl.label}')" style="cursor:pointer">${p.vct_team} · <span class="tag tag-${p.tier}" style="font-size:8px">${p.tier}</span> · <span style="color:var(--accent)">${p.price}M</span></div>
          <div class="slot-pts">${dispPts}</div>
        </div>`
      :`<div id="slot_${sl.id}" class="slot"
          onclick="openPicker('${sl.id}','${sl.label}')"
          ondragover="slotDragOver(event,'${sl.id}')" ondragleave="slotDragLeave('${sl.id}')" ondrop="slotDrop(event,'${sl.id}')">
          <div class="slot-label">${sl.label}</div>
          <div class="slot-empty">+ Pick a player</div>
        </div>`;
  }).join('');
}

function slotDragStart(e,slotId){
  dragSlot=slotId;
  e.dataTransfer.effectAllowed='move';
  e.dataTransfer.setData('text/plain',slotId);
  setTimeout(()=>{ const el=document.getElementById('slot_'+slotId); if(el) el.style.opacity='0.4'; },0);
}
function slotDragEnd(e,slotId){
  dragSlot=null;
  document.querySelectorAll('.slot').forEach(el=>{ el.style.opacity='1'; el.classList.remove('drag-over'); });
}
function slotDragOver(e,slotId){
  e.preventDefault(); e.dataTransfer.dropEffect='move';
  if(slotId===dragSlot) return;
  document.getElementById('slot_'+slotId)?.classList.add('drag-over');
}
function slotDragLeave(slotId){
  document.getElementById('slot_'+slotId)?.classList.remove('drag-over');
}
async function slotDrop(e,targetId){
  e.preventDefault();
  document.getElementById('slot_'+targetId)?.classList.remove('drag-over');
  const fromId=dragSlot; dragSlot=null;
  if(!fromId||fromId===targetId) return;

  const curMD=MATCHDAYS.find(m=>m.id===currentMDId);
  if(isMarketLocked(curMD)){toast('Market is closed');return;}

  const fromPlayer=myRosters[fromId];
  const toPlayer=myRosters[targetId];
  if(!fromPlayer) return;

  // Role validation
  const fromDef=SLOTS.find(s=>s.id===fromId);
  const toDef=SLOTS.find(s=>s.id===targetId);
  if(!toDef.roles.includes(fromPlayer.role)){toast(`${fromPlayer.name} can't play ${toDef.label}`);return;}
  if(toPlayer&&!fromDef.roles.includes(toPlayer.role)){toast(`${toPlayer.name} can't play ${fromDef.label}`);return;}

  const fromBuy=myBuyPrices[fromId];
  const toBuy=myBuyPrices[targetId];

  if(toPlayer){
    myRosters[fromId]=toPlayer; myBuyPrices[fromId]=toBuy;
    myRosters[targetId]=fromPlayer; myBuyPrices[targetId]=fromBuy;
  } else {
    myRosters[targetId]=fromPlayer; myBuyPrices[targetId]=fromBuy;
    delete myRosters[fromId]; delete myBuyPrices[fromId];
  }
  isDirty=true;
  renderTeamPage();
  toast('Squad updated ✓');
}

async function removePlayer(slotId){
  const p=myRosters[slotId]; if(!p) return;
  const curMD=MATCHDAYS.find(m=>m.id===currentMDId);
  if(isMarketLocked(curMD)){toast('Market is closed — transfers not allowed');return;}
  const isOrigPlayer=savedRosters[slotId]?.id===p.id;
  const buyPriceForSell=isOrigPlayer?(savedBuyPrices[slotId]||p.price):(myBuyPrices[slotId]||p.price);
  const sellVal=Math.min(buyPriceForSell, p.price||0);
  const isMD1=MATCHDAYS[0]?.id===currentMDId;
  const isWildcard=myChip==='wildcard';
  const transferWarning=(!isMD1&&!isWildcard)?'\nRe-adding them later will cost a transfer.':'';
  const ok=await showConfirm('Remove Player',`Remove ${p.name}?\nSell value: ${sellVal}M${transferWarning}`,'Remove');
  if(!ok) return;
  delete myRosters[slotId]; delete myBuyPrices[slotId];
  if(myCaptainId===p.id) myCaptainId=null;
  if(myCaptain2Id===p.id) myCaptain2Id=null;
  isDirty=true;
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
  if(isMarketLocked(curMD)){toast('Market is closed');return;}
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
  if(isMarketLocked(curMD)){toast('Market is closed');return;}
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
  const left=getDraftBudget();
  const budget=TOURNAMENT?.budget||100;
  const el=document.getElementById('budgetLeft');
  const tot=document.getElementById('budgetTotal');
  el.textContent=left+'M'; el.style.color=left<0?'var(--red)':'var(--accent)';
  if(tot) tot.textContent='/'+budget+'M';
  return left;
}

function calcMyPts(){
  // mySlotScores comes from score_logs.final_pts which already includes
  // captain multiplier and chip effects — just sum them directly
  let total = Object.values(myRosters).reduce((sum, p) => {
    return sum + (p ? (mySlotScores[p.id] || 0) : 0);
  }, 0);
  // Subtract transfer penalty (before any match scored, still preview correctly)
  const isMD1 = MATCHDAYS[0]?.id === currentMDId;
  const isWildcard = myChip === 'wildcard';
  if(!isMD1 && !isWildcard){
    const extra = Math.max(0, calcDraftTransfers() - 2);
    total -= extra * (TOURNAMENT?.transfer_penalty || 8);
  }
  document.getElementById('myTotalPts').textContent = total;
}

// ===== PLAYER PICKER =====
function openPicker(slotId,slotLabel){
  const curMD=MATCHDAYS.find(m=>m.id===currentMDId);
  if(isMarketLocked(curMD)){toast('Market is closed — changes not allowed');return;}
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

  // Internal move: player already in squad at another slot — no transfer, no budget change
  const existingSlot=Object.keys(myRosters).find(s=>s!==pickerSlot&&myRosters[s]?.id===p.id);
  if(existingSlot){
    const movedBuyPrice=myBuyPrices[existingSlot];
    myRosters[pickerSlot]=p; myBuyPrices[pickerSlot]=movedBuyPrice;
    delete myRosters[existingSlot]; delete myBuyPrices[existingSlot];
    if(oldP&&oldP.id!==p.id){
      if(myCaptainId===oldP.id) myCaptainId=null;
      if(myCaptain2Id===oldP.id) myCaptain2Id=null;
    }
    isDirty=true;
    closePicker(); renderTeamPage(); toast(`${p.name} moved ✓`);
    return;
  }

  // Normal market pick — budget check by simulating the pick
  const prevP=myRosters[pickerSlot];
  const prevBuy=myBuyPrices[pickerSlot];
  myRosters[pickerSlot]=p; myBuyPrices[pickerSlot]=p.price;
  if(getDraftBudget()<0){
    myRosters[pickerSlot]=prevP; myBuyPrices[pickerSlot]=prevBuy;
    toast('Not enough budget!'); return;
  }
  if(myCaptainId===oldP?.id) myCaptainId=null;
  if(myCaptain2Id===oldP?.id) myCaptain2Id=null;
  isDirty=true;
  closePicker(); renderTeamPage(); toast(`${p.name} added ✓`);
}

// ===== DRAFT CONFIRM / DISCARD =====
async function confirmTeam(){
  if(!myTeamId){toast('Not logged in');return;}
  if(getDraftBudget()<0){toast('Over budget — adjust your squad');return;}

  // Save team name
  const newName=(document.getElementById('myTeamName')?.value.trim())||myTeamName;
  if(!newName){toast('Please enter a team name');return;}

  const isMD1=MATCHDAYS[0]?.id===currentMDId;
  const isWildcard=myChip==='wildcard';
  const savedIds=new Set(Object.values(savedRosters).map(p=>p?.id).filter(Boolean));

  // Build transfer log for new market players
  const transfers=[]; let txCount=savedTransferCount;
  if(!isMD1&&!isWildcard&&currentMDId){
    for(const sl of SLOTS.map(s=>s.id)){
      const curr=myRosters[sl];
      if(!curr||savedIds.has(curr.id)) continue;
      transfers.push({team_id:myTeamId,matchday_id:currentMDId,slot:sl,
        old_player_id:savedRosters[sl]?.id||null,new_player_id:curr.id,
        penalty_applied:txCount>=2});
      txCount++;
    }
  }

  const finalAdj=calcDraftBudgetAdj();

  // Batch DB writes
  const ops=[];
  const rosterUpserts=Object.entries(myRosters).map(([slot,p])=>({team_id:myTeamId,slot,player_id:p.id,buy_price:myBuyPrices[slot]}));
  if(rosterUpserts.length) ops.push(sb.from('rosters').upsert(rosterUpserts,{onConflict:'team_id,slot'}));
  // Delete cleared slots
  const clearedSlots=SLOTS.map(s=>s.id).filter(sl=>savedRosters[sl]&&!myRosters[sl]);
  for(const sl of clearedSlots) ops.push(sb.from('rosters').delete().eq('team_id',myTeamId).eq('slot',sl));
  if(transfers.length) ops.push(sb.from('transfers').insert(transfers));
  ops.push(sb.from('teams').update({team_name:newName,captain_id:myCaptainId,captain2_id:myCaptain2Id,budget_adjustment:finalAdj}).eq('id',myTeamId));

  await Promise.all(ops);

  // Sync state
  myTeamName=newName; myBudgetAdj=finalAdj; myTransferCount=txCount;
  savedRosters=Object.fromEntries(Object.entries(myRosters).map(([k,v])=>[k,v]));
  savedBuyPrices={...myBuyPrices}; savedBudgetAdj=finalAdj;
  savedCaptainId=myCaptainId; savedCaptain2Id=myCaptain2Id; savedTransferCount=txCount;
  isDirty=false;

  if(currentUser) document.getElementById('navUserName').textContent=newName||currentUser.manager;
  renderTeamPage(); renderLB();
  toast('Team confirmed ✓');
}

function discardDraft(){
  myRosters=Object.fromEntries(Object.entries(savedRosters).map(([k,v])=>[k,v]));
  myBuyPrices={...savedBuyPrices}; myBudgetAdj=savedBudgetAdj;
  myCaptainId=savedCaptainId; myCaptain2Id=savedCaptain2Id; myTransferCount=savedTransferCount;
  isDirty=false;
  renderTeamPage();
  toast('Changes discarded');
}

function renderChangesPanel(){
  const el=document.getElementById('changesPanel'); if(!el) return;
  if(!isDirty){el.style.display='none'; el.innerHTML=''; return;}

  const savedIds=new Set(Object.values(savedRosters).map(p=>p?.id).filter(Boolean));
  const isMD1=MATCHDAYS[0]?.id===currentMDId;
  const isWildcard=myChip==='wildcard';
  const rows=[];

  for(const sl of SLOTS){
    const orig=savedRosters[sl.id];
    const curr=myRosters[sl.id];
    if(orig?.id===curr?.id) continue; // no change for this slot
    const isTransfer=curr&&!savedIds.has(curr.id);
    const outLabel=orig?`<span style="color:var(--red)">${orig.name}</span>`:'<span style="color:var(--muted)">empty</span>';
    const inLabel=curr?`<span style="color:#4ade80">${curr.name}</span>`:'<span style="color:var(--muted)">removed</span>';
    const badge=isTransfer&&!isMD1&&!isWildcard?'<span style="font-size:9px;background:rgba(255,70,85,0.15);color:var(--red);padding:1px 5px;border-radius:3px;margin-left:4px">TRANSFER</span>':'';
    rows.push(`<div style="display:flex;align-items:center;gap:6px;font-size:12px;padding:4px 0;border-bottom:1px solid var(--border)">
      <span style="font-size:9px;color:var(--muted);width:32px;flex-shrink:0">${sl.label}</span>
      ${outLabel} <span style="color:var(--muted)">→</span> ${inLabel}${badge}
    </div>`);
  }

  const draftTx=calcDraftTransfers();
  const penalty=TOURNAMENT?.transfer_penalty||8;
  const extra=(!isMD1&&!isWildcard)?Math.max(0,draftTx-2):0;
  const txStr=isMD1?'MD1 — free':`${draftTx}/2${extra>0?` <span style="color:var(--red)">+${extra} penalty (-${extra*penalty}pts)</span>`:''}`;

  el.style.display='block';
  el.innerHTML=`<div style="background:rgba(0,212,255,0.04);border:1px solid rgba(0,212,255,0.15);border-radius:6px;padding:12px 16px;margin-bottom:10px">
    <div style="font-size:10px;font-weight:600;letter-spacing:1.5px;color:var(--accent);margin-bottom:8px">PENDING CHANGES</div>
    ${rows.length?rows.join(''):'<div style="font-size:12px;color:var(--muted)">Only slot rearrangements — no transfers</div>'}
    <div style="display:flex;gap:16px;margin-top:10px;font-size:11px;color:var(--muted)">
      <span>Budget: <strong style="color:${getDraftBudget()<0?'var(--red)':'var(--accent)'}">${getDraftBudget()}M</strong></span>
      <span>Transfers: <strong>${txStr}</strong></span>
    </div>
  </div>`;
}

function saveMyTeam(){} // kept for input oninput hook

async function deleteMyTeam(){
  if(!currentUser||!myTeamId){toast('Not logged in');return;}
  if(!await showConfirm('Remove Team','Remove your team from the leaderboard? This cannot be undone.','Remove')) return;
  await sb.from('teams').delete().eq('id',myTeamId);
  myTeamId=null; myTeamName=currentUser.manager+"'s Team";
  myRosters={}; savedRosters={}; myCaptainId=null; myCaptain2Id=null; myChip=null;
  myTransferCount=0; savedTransferCount=0; isDirty=false;
  const {data:newTeam}=await sb.from('teams')
    .insert({user_id:currentUser.userId,tournament_id:TOURNAMENT.id,team_name:myTeamName})
    .select('id,team_name').single();
  if(newTeam){ myTeamId=newTeam.id; myTeamName=newTeam.team_name; }
  renderTeamPage(); renderLB();
  toast('Team reset ✓');
}

function resetTeamToSaved(){ discardDraft(); }

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
  // Populate tournament settings
  document.getElementById('setPassword').value='';
  document.getElementById('setBudget').value=TOURNAMENT?.budget||100;
  document.getElementById('setPenalty').value=TOURNAMENT?.transfer_penalty||8;
}

function renderAdminMatchdays(){
  const el=document.getElementById('mdAdminList'); if(!el) return;
  el.innerHTML=MATCHDAYS.map(md=>{
    const dlDisplay = md.deadline ? new Date(md.deadline).toLocaleString('en-GB',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}) : '';
    const mdFixtures = FIXTURES.filter(f=>f.matchday_id===md.id);

    const fixtureRows = mdFixtures.length ? mdFixtures.map(fx=>{
      const timeStr = fx.scheduled_time ? new Date(fx.scheduled_time).toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}) : 'TBD';
      const done = fx.status==='completed';
      return `<div style="display:flex;align-items:center;gap:6px;padding:6px 0;border-bottom:0.5px solid rgba(255,255,255,0.04);flex-wrap:wrap">
        <span style="font-size:12px;font-weight:600;flex:1;min-width:140px">${fx.team_a} <span style="color:var(--muted);font-weight:400">vs</span> ${fx.team_b} <span style="color:var(--muted);font-size:10px">· ${timeStr}</span></span>
        <span style="font-size:9px;padding:2px 6px;border-radius:2px;white-space:nowrap;background:${done?'rgba(74,222,128,0.12)':'rgba(255,255,255,0.05)'};color:${done?'#4ade80':'var(--muted)'}">${done?'SCORED':'SCHEDULED'}</span>
        <input id="fx_url_${fx.id}" value="${fx.vlr_match_url||''}" placeholder="VLR.gg URL..." ${done?'disabled':''} style="background:var(--s2);border:0.5px solid var(--border2);color:var(--text);padding:4px 8px;font-size:11px;outline:none;border-radius:3px;width:180px;${done?'opacity:0.4':''}">
        <button onclick="scoreFixture(${fx.id},${md.id})" class="btn-sm ${done||md.scores_locked?'':'btn-edit'}" ${done||md.scores_locked?'disabled':''} style="${done||md.scores_locked?'opacity:0.4':''}">⚡</button>
        <button onclick="deleteFixture(${fx.id})" class="btn-sm btn-del">✕</button>
      </div>`;
    }).join('') : `<div style="font-size:11px;color:var(--muted);padding:6px 0">No fixtures yet</div>`;

    return `
    <div style="padding:12px 0;border-bottom:0.5px solid var(--border2)">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">
        <span style="font-size:12px;font-weight:600">${md.label}</span>
        <span style="font-size:9px;color:var(--muted)">${md.phase}</span>
        <span style="font-size:9px;padding:2px 6px;border-radius:2px;background:${md.market_open?'rgba(74,222,128,0.15)':'rgba(255,70,85,0.1)'};color:${md.market_open?'#4ade80':'var(--red)'}">${md.market_open?'OPEN':'LOCKED'}</span>
        ${md.scores_locked?`<span style="font-size:9px;padding:2px 6px;border-radius:2px;background:rgba(250,204,21,0.12);color:#facc15">📊 SCORES FINAL</span>`:''}
        <button onclick="setMarket(${md.id},${!md.market_open})" class="btn-sm ${md.market_open?'btn-del':'btn-edit'}" style="margin-left:auto">${md.market_open?'🔒 Lock':'🔓 Open'}</button>
        <button onclick="lockMatchdayScores(${md.id},${!md.scores_locked})" class="btn-sm" style="font-size:9px;background:${md.scores_locked?'rgba(250,204,21,0.1)':'rgba(255,255,255,0.06)'};border:0.5px solid ${md.scores_locked?'rgba(250,204,21,0.3)':'var(--border2)'};color:${md.scores_locked?'#facc15':'var(--muted)'}">${md.scores_locked?'🔓 Unlock Scores':'📊 Lock Scores'}</button>
      </div>
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:${dlDisplay?'4px':'8px'}">
        <span style="font-size:10px;font-weight:500;letter-spacing:0.5px;color:var(--muted);text-transform:uppercase;white-space:nowrap">⏰ Deadline</span>
        <input readonly id="dl_${md.id}" placeholder="Pick date & time..."
          style="flex:1;background:var(--s2);border:0.5px solid var(--border2);color:var(--text);padding:5px 10px;font-size:12px;outline:none;border-radius:3px;cursor:pointer">
        <button onclick="setDeadline(${md.id})" class="btn-sm btn-edit" style="white-space:nowrap">Set</button>
        ${md.deadline?`<button onclick="clearDeadline(${md.id})" class="btn-sm btn-del" style="white-space:nowrap">Clear</button>`:''}
      </div>
      ${dlDisplay?`<div style="font-size:10px;color:var(--muted);margin-bottom:10px">📅 ${dlDisplay}</div>`:''}
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <span style="font-size:10px;font-weight:600;letter-spacing:1px;color:var(--muted);text-transform:uppercase">🎮 Fixtures</span>
        <button id="priceBtn_${md.id}" onclick="updatePlayerPrices(${md.id})" class="btn-sm btn-edit" style="font-size:9px">💰 Update Prices</button>
      </div>
      <div>${fixtureRows}</div>
      <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;align-items:center">
        <input id="fx_a_${md.id}" placeholder="Team A" style="background:var(--s2);border:0.5px solid var(--border2);color:var(--text);padding:5px 8px;font-size:12px;outline:none;border-radius:3px;flex:1;min-width:90px">
        <span style="color:var(--muted);font-size:11px;white-space:nowrap">vs</span>
        <input id="fx_b_${md.id}" placeholder="Team B" style="background:var(--s2);border:0.5px solid var(--border2);color:var(--text);padding:5px 8px;font-size:12px;outline:none;border-radius:3px;flex:1;min-width:90px">
        <input readonly id="fx_t_${md.id}" placeholder="Date & time..." style="background:var(--s2);border:0.5px solid var(--border2);color:var(--text);padding:5px 8px;font-size:12px;outline:none;border-radius:3px;flex:1;min-width:120px;cursor:pointer">
        <button onclick="addFixture(${md.id})" class="btn-sm btn-edit">+ Add</button>
      </div>
    </div>`;
  }).join('');

  // Init Flatpickr on deadline inputs
  MATCHDAYS.forEach(md=>{
    const input = document.getElementById('dl_'+md.id);
    if(!input) return;
    flatpickr(input, {
      enableTime: true, time_24hr: true, dateFormat: 'Y-m-dTH:i',
      altInput: true, altFormat: 'd M Y — H:i',
      defaultDate: md.deadline||null, disableMobile: false, theme: 'dark',
      onChange(selectedDates, dateStr){ input._selectedDate = dateStr; },
    });
  });

  // Init Flatpickr on fixture time inputs
  MATCHDAYS.forEach(md=>{
    const input = document.getElementById('fx_t_'+md.id);
    if(!input) return;
    flatpickr(input, {
      enableTime: true, time_24hr: true, dateFormat: 'Y-m-dTH:i',
      altInput: true, altFormat: 'd M Y — H:i',
      disableMobile: false, theme: 'dark',
    });
  });
}

async function setMarket(mdId, open){
  await sb.from('matchdays').update({market_open:open}).eq('id',mdId);
  const md=MATCHDAYS.find(m=>m.id===mdId); if(md) md.market_open=open;
  if(open){
    // Auto-lock scores for all matchdays before this one
    const openedMD=MATCHDAYS.find(m=>m.id===mdId);
    if(openedMD){
      const toLock=MATCHDAYS.filter(m=>m.matchday_number<openedMD.matchday_number&&!m.scores_locked);
      if(toLock.length){
        await sb.from('matchdays').update({scores_locked:true}).in('id',toLock.map(m=>m.id));
        toLock.forEach(m=>m.scores_locked=true);
      }
    }
  }
  const openMD=[...MATCHDAYS].reverse().find(m=>m.market_open);
  currentMDId=openMD?.id||MATCHDAYS[MATCHDAYS.length-1]?.id||null;
  renderAdminMatchdays();
  toast(`${open?'Market opened':'Market locked'} ✓`);
}

async function lockMatchdayScores(mdId, lock){
  await sb.from('matchdays').update({scores_locked:lock}).eq('id',mdId);
  const md=MATCHDAYS.find(m=>m.id===mdId); if(md) md.scores_locked=lock;
  renderAdminMatchdays();
  toast(lock?'Scores locked ✓':'Scores unlocked ✓');
}

async function setDeadline(mdId){
  const input=document.getElementById('dl_'+mdId);
  const dl=input?._flatpickr?.latestSelectedDateObj;
  if(!dl){ toast('Please pick a date and time first'); return; }
  const iso=dl.toISOString();
  await sb.from('matchdays').update({deadline:iso}).eq('id',mdId);
  const md=MATCHDAYS.find(m=>m.id===mdId); if(md) md.deadline=iso;
  renderAdminMatchdays();
  toast(`Deadline set ✓`);
}

async function clearDeadline(mdId){
  await sb.from('matchdays').update({deadline:null}).eq('id',mdId);
  const md=MATCHDAYS.find(m=>m.id===mdId); if(md) md.deadline=null;
  renderAdminMatchdays();
  toast('Deadline cleared ✓');
}

// ── Price Change Formula ─────────────────────────────────────────
// >23→+1.5M | 18-23→+1M | 13-17→+0.5M | 6-12→0
// 3-5→-0.5M | 0-2→-1M | <0→-1.5M
function priceChangeDelta(score){
  if(score > 23)  return  1.5;
  if(score >= 18) return  1.0;
  if(score >= 13) return  0.5;
  if(score >= 6)  return  0.0;
  if(score >= 3)  return -0.5;
  if(score >= 0)  return -1.0;
  return -1.5;
}

async function updatePlayerPrices(mdId){
  const btn = document.getElementById('priceBtn_'+mdId);
  if(btn) btn.textContent = 'Updating...';

  // Use match_player_cache: one row per real player per match (not per fantasy team)
  const {data:cache, error} = await sb.from('match_player_cache')
    .select('player_name,kills,k4,k5,k6,k7,clutch_1v2,clutch_1v3,clutch_1v4,clutch_1v5,rating_rank,is_lowest_rating,is_winner,clean_sheet_win')
    .eq('matchday_id', mdId);

  if(error || !cache?.length){
    console.error('updatePlayerPrices: no cache data', {error, mdId, cacheLen: cache?.length});
    toast('No match data for this matchday');
    if(btn) btn.textContent = '💰 Update Prices';
    return;
  }
  console.log(`updatePlayerPrices: ${cache.length} cache rows for matchday ${mdId}`);

  // Sum raw pts per player across all matches in the matchday
  const ptsMap = {};
  for(const r of cache){
    const n = r.player_name;
    if(!ptsMap[n]) ptsMap[n] = 0;
    let pts = 0;
    pts += Math.floor(r.kills / 10);
    pts += r.k4*3; pts += r.k5*4; pts += r.k6*5; pts += r.k7*5;
    pts += r.clutch_1v2 + r.clutch_1v3 + r.clutch_1v4 + r.clutch_1v5;
    const rank = r.rating_rank;
    if(rank===1) pts+=3; else if(rank===2) pts+=2; else if(rank===3) pts+=1;
    if(r.is_lowest_rating) pts-=3;
    if(r.is_winner){ pts+=2; if(r.clean_sheet_win) pts+=1; }
    ptsMap[n] += pts;
  }
  console.log('ptsMap (scraped name → pts):', ptsMap);

  // Fetch all players and match case-insensitively against scraped names
  const {data:allPlayers, error:playerErr} = await sb.from('players').select('id,name,price').eq('tournament_id', TOURNAMENT.id);
  console.log(`allPlayers: ${allPlayers?.length} rows`, playerErr||'');

  // Build a lowercase lookup from scraped names → pts
  const ptsMapLower = {};
  for(const [n,v] of Object.entries(ptsMap)) ptsMapLower[n.toLowerCase().trim()] = {pts:v, scraped:n};

  const unmatched = [];
  const log = [];
  let updated = 0;
  for(const p of (allPlayers||[])){
    const key = p.name.toLowerCase().trim();
    const entry = ptsMapLower[key];
    if(!entry){ continue; } // didn't play this matchday
    const score = entry.pts;
    const d = priceChangeDelta(score);
    const newPrice = Math.min(30, Math.max(4, +(p.price + d).toFixed(1)));
    const capped = newPrice === p.price + d ? '' : ' [CAPPED]';
    log.push(`${p.name}: pts=${score} delta=${d>=0?'+':''}${d} ${p.price}M→${newPrice}M${capped}`);
    await sb.from('players').update({previous_price: p.price, price: newPrice}).eq('id', p.id);
    const localP = PLAYERS.find(pl=>pl.id===p.id);
    if(localP) localP.price = newPrice;
    // Keep myRosters in sync so sell price uses current price, not stale load price
    for(const rp of Object.values(myRosters)){ if(rp?.id===p.id) rp.price=newPrice; }
    updated++;
  }

  // Warn about scraped names that had no DB match
  for(const [lc, entry] of Object.entries(ptsMapLower)){
    const matched = (allPlayers||[]).some(p=>p.name.toLowerCase().trim()===lc);
    if(!matched) unmatched.push(entry.scraped);
  }

  console.table(log.map(l=>{
    const [name,...rest]=l.split(':'); return {player:name.trim(), detail:rest.join(':').trim()};
  }));
  if(unmatched.length) console.warn('No DB match for scraped names:', unmatched);

  renderAdminPlayers();
  if(btn) btn.textContent = '💰 Update Prices';
  const warn = unmatched.length ? ` | No DB match: ${unmatched.join(', ')}` : '';
  toast(`💰 Updated ${updated} players${warn} — see console for details`);
}

async function addFixture(mdId){
  const teamA=document.getElementById('fx_a_'+mdId)?.value.trim();
  const teamB=document.getElementById('fx_b_'+mdId)?.value.trim();
  if(!teamA||!teamB){toast('Enter both team names');return;}
  const timeInput=document.getElementById('fx_t_'+mdId);
  const scheduledTime=timeInput?._flatpickr?.latestSelectedDateObj?.toISOString()||null;
  const {data,error}=await sb.from('fixtures').insert({
    matchday_id:mdId, tournament_id:TOURNAMENT.id,
    team_a:teamA, team_b:teamB, scheduled_time:scheduledTime, status:'scheduled',
  }).select().single();
  if(error){toast('Error adding fixture');console.error(error);return;}
  FIXTURES.push(data);
  document.getElementById('fx_a_'+mdId).value='';
  document.getElementById('fx_b_'+mdId).value='';
  renderAdminMatchdays();
  toast('Fixture added ✓');
}

async function deleteFixture(fxId){
  if(!await showConfirm('Delete Fixture','Delete this fixture? This cannot be undone.','Delete')) return;
  await sb.from('fixtures').delete().eq('id',fxId);
  FIXTURES=FIXTURES.filter(f=>f.id!==fxId);
  renderAdminMatchdays();
  toast('Fixture deleted ✓');
}

async function scoreFixture(fxId, mdId){
  const urlInput=document.getElementById('fx_url_'+fxId);
  const url=urlInput?.value.trim();
  if(!url){toast('Enter VLR.gg match URL first');return;}
  const fx=FIXTURES.find(f=>f.id===fxId);
  if(fx?.status==='completed'){toast('Already scored');return;}
  toast('⏳ Scoring match...');
  try{
    const res=await fetch(`${SUPABASE_URL}/functions/v1/scrape-match`,{
      method:'POST',
      headers:{'Authorization':'Bearer '+SUPABASE_KEY,'Content-Type':'application/json'},
      body:JSON.stringify({match_url:url,matchday_id:mdId,tournament_id:TOURNAMENT.id,fixture_id:fxId}),
    });
    const data=await res.json();
    if(data.ok){
      if(fx){fx.status='completed';fx.vlr_match_url=url;}
      renderAdminMatchdays();
      renderLB();
      toast(`Scored ✓ — ${data.teamsScored} teams updated`);
    } else {
      toast('❌ '+data.error);
    }
  } catch(e){
    toast('Network error: '+e.message);
  }
}


async function resetPrices(){
  const {data:players}=await sb.from('players').select('id,price,previous_price').eq('tournament_id',TOURNAMENT.id).not('previous_price','is',null);
  if(!players?.length){toast('No previous prices saved');return;}
  for(const p of players){
    await sb.from('players').update({price:p.previous_price,previous_price:null}).eq('id',p.id);
  }
  toast(`↩️ Prices reset for ${players.length} players ✓`);
}

async function resetAllPrices(){
  if(!await showConfirm('Reset All Prices','Reset ALL player prices to base?\nS = 24M · A = 16M · B = 10M · C = 6M','Reset')) return;
  const {data:players}=await sb.from('players').select('id,price,base_price').eq('tournament_id',TOURNAMENT.id).not('base_price','is',null);
  if(!players?.length){toast('Run the base_price SQL in Supabase first');return;}
  for(const p of players){
    await sb.from('players').update({price:p.base_price,previous_price:p.price}).eq('id',p.id);
    const localP=PLAYERS.find(pl=>pl.id===p.id);
    if(localP) localP.price=p.base_price;
  }
  renderAdminPlayers();
  toast(`🔄 All prices reset to base for ${players.length} players ✓`);
}

// ===== PREDICTIONS =====
async function renderPredictPage(){
  const el=document.getElementById('predictContainer');
  if(!el) return;

  if(!currentUser){ showLogin(); return; }

  el.innerHTML='<div style="text-align:center;padding:60px;color:var(--muted);font-size:12px;letter-spacing:1px">Loading...</div>';

  if(!myTeamId){
    el.innerHTML='<div style="text-align:center;padding:60px;color:var(--muted)">Could not load team — please refresh</div>';
    return;
  }

  if(!predMDId) predMDId = currentMDId || MATCHDAYS[0]?.id;

  try{
  // Load user's predictions and all prediction totals in parallel
  const [{data:myPreds,error:e1},{data:allPreds},{data:allTeams}] = await Promise.all([
    sb.from('predictions').select('*').eq('team_id',myTeamId).eq('tournament_id',TOURNAMENT.id),
    sb.from('predictions').select('team_id,points_earned').eq('tournament_id',TOURNAMENT.id),
    sb.from('teams').select('id,team_name,users!inner(manager_name)').eq('tournament_id',TOURNAMENT.id),
  ]);
  if(e1){
    el.innerHTML=`<div style="text-align:center;padding:60px;color:var(--red);font-size:12px">DB error: ${e1.message}<br><br>Have you run the SQL to create the predictions table?</div>`;
    return;
  }

  const predMap={};
  for(const p of (myPreds||[])) predMap[p.fixture_id]=p;

  // Build prediction leaderboard
  const predTotals={};
  for(const p of (allPreds||[])){ if(p.points_earned!=null) predTotals[p.team_id]=(predTotals[p.team_id]||0)+p.points_earned; }
  const sortedTeams=(allTeams||[]).map(t=>({...t,predPts:predTotals[t.id]||0})).sort((a,b)=>b.predPts-a.predPts);

  const curMD=MATCHDAYS.find(m=>m.id===predMDId);
  const mdFixtures=FIXTURES.filter(f=>f.matchday_id===predMDId);
  const locked=isMarketLocked(curMD);

  // MD tabs
  const mdNav=MATCHDAYS.map(md=>
    `<button class="md-btn ${md.id===predMDId?'on':''}" onclick="predMDId=${md.id};renderPredictPage()">${md.label}</button>`
  ).join('');

  // Fixture rows
  const SCORE_OPTS=[{a:2,b:0},{a:2,b:1},{a:1,b:2},{a:0,b:2}];
  let fixturesHtml='';
  if(!mdFixtures.length){
    fixturesHtml='<div style="color:var(--muted);font-size:12px;padding:16px 0">No fixtures for this matchday</div>';
  } else {
    fixturesHtml=mdFixtures.map(fx=>{
      const pred=predMap[fx.id];
      const hasResult=fx.result_a!=null&&fx.result_b!=null;

      if(locked||hasResult){
        // Results view
        const predStr=pred?`${pred.score_a}-${pred.score_b}`:'No pick';
        const resultStr=hasResult?`${fx.result_a}-${fx.result_b}`:'TBD';
        const pts=pred?.points_earned;
        const ptsColor=pts>0?'#4ade80':'var(--muted)';
        return `<div class="card" style="padding:14px 16px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
          <div style="flex:1;min-width:140px">
            <div style="font-size:13px;font-weight:600">${fx.team_a} <span style="color:var(--muted);font-weight:400">vs</span> ${fx.team_b}</div>
            <div style="font-size:11px;color:var(--muted);margin-top:3px">Your pick: <strong>${predStr}</strong>${pred?.is_doubled?' · <span style="color:var(--gold)">×2</span>':''}</div>
          </div>
          <div style="text-align:center">
            <div style="font-size:9px;color:var(--muted);letter-spacing:1px;text-transform:uppercase;margin-bottom:2px">Result</div>
            <div style="font-size:20px;font-weight:700;color:var(--accent)">${resultStr}</div>
          </div>
          <div style="text-align:right;min-width:48px">
            <div style="font-size:9px;color:var(--muted);letter-spacing:1px;text-transform:uppercase;margin-bottom:2px">Pts</div>
            <div style="font-size:22px;font-weight:700;color:${ptsColor}">${pts!=null?pts:'—'}</div>
          </div>
        </div>`;
      }

      // Prediction form
      const isDoubled=pred?.is_doubled||false;
      const scoreBtns=SCORE_OPTS.map(s=>{
        const sel=pred&&pred.score_a===s.a&&pred.score_b===s.b;
        return `<button onclick="setPredScore(${fx.id},${s.a},${s.b})"
          data-pred-fix="${fx.id}" data-sa="${s.a}" data-sb="${s.b}"
          style="${sel?'background:var(--accent);color:#000;border-color:var(--accent);font-weight:700':'background:rgba(255,255,255,0.04);border:0.5px solid rgba(255,255,255,0.12);color:rgba(255,255,255,0.4)'}"
          class="btn-sm">${s.a}-${s.b}</button>`;
      }).join('');

      return `<div class="card" style="padding:14px 16px;margin-bottom:8px">
        <div style="font-size:12px;font-weight:600;margin-bottom:10px">${fx.team_a} <span style="color:var(--muted);font-weight:400">vs</span> ${fx.team_b}</div>
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <input type="hidden" id="pa_${fx.id}" value="${pred?.score_a??''}">
          <input type="hidden" id="pb_${fx.id}" value="${pred?.score_b??''}">
          ${scoreBtns}
          <button onclick="togglePredDouble(${fx.id},${predMDId})" id="dbl_${fx.id}" data-active="${isDoubled}"
            class="btn-sm" style="${isDoubled?'background:rgba(255,185,0,0.15);border-color:rgba(255,185,0,0.4);color:var(--gold)':''}">×2</button>
          <button onclick="submitPrediction(${fx.id},${predMDId})" class="btn-sm btn-edit">Save</button>
        </div>
        ${pred?`<div style="font-size:10px;color:var(--muted);margin-top:8px">Saved: ${pred.score_a}-${pred.score_b}${pred.is_doubled?' · <span style="color:var(--gold)">×2</span>':''}</div>`:''}
      </div>`;
    }).join('');
  }

  // Prediction leaderboard
  const lbHtml=sortedTeams.length?sortedTeams.map((t,i)=>`
    <div style="display:grid;grid-template-columns:32px 1fr auto;gap:8px;align-items:center;padding:8px 0;border-bottom:0.5px solid var(--border2)">
      <div style="font-size:13px;font-weight:700;color:${i===0?'var(--gold)':i===1?'#9ca3af':i===2?'#CD7F32':'var(--muted)'}">${i+1}</div>
      <div><div style="font-size:13px;font-weight:600">${t.team_name}</div><div style="font-size:11px;color:var(--muted)">${t.users?.manager_name||''}</div></div>
      <div style="font-size:20px;font-weight:700;color:${t.predPts>0?'var(--accent)':'var(--muted)'}">${t.predPts}</div>
    </div>`).join(''):'<div style="color:var(--muted);font-size:12px;padding:8px 0">No predictions yet</div>';

  const el=document.getElementById('predictContainer'); if(!el) return;
  el.innerHTML=`
    <div class="hero" style="padding:40px 20px 28px">
      <div class="event-tag">🔮 PREDICTIONS</div>
      <h1>VALO<span>TASY</span><br>PREDICT</h1>
      <div class="hero-sub">PREDICT MATCH SCORES · EARN BONUS POINTS</div>
    </div>
    <div style="background:rgba(0,212,255,0.05);border:0.5px solid rgba(0,212,255,0.15);padding:10px 14px;border-radius:4px;font-size:11px;color:var(--muted);margin-bottom:16px;line-height:2">
      🎯 <strong style="color:var(--text)">Exact score</strong> → 3 pts + 1 pt per correct team score = up to <strong style="color:var(--accent)">5 pts</strong><br>
      ✅ <strong style="color:var(--text)">Correct winner</strong> → 1 pt + 1 pt per correct team score = up to <strong style="color:var(--accent)">3 pts</strong><br>
      ❌ Wrong winner → +1 pt per correct team score only &nbsp;·&nbsp;
      <span style="color:var(--gold)">×2</span> multiplies total · one per matchday
    </div>
    <div class="md-nav">${mdNav}</div>
    <div style="margin-bottom:28px">
      <div style="font-size:10px;font-weight:600;letter-spacing:1.5px;color:var(--muted);text-transform:uppercase;margin-bottom:12px">
        ${curMD?.label||''} — ${locked?'🔒 Locked':'Open for Predictions'}
      </div>
      ${fixturesHtml}
    </div>
    <div class="admin-card" style="margin-top:0">
      <h3>🏆 Prediction Standings</h3>
      <div>${lbHtml}</div>
    </div>`;
  } catch(e) {
    el.innerHTML=`<div style="text-align:center;padding:60px;color:var(--red);font-size:12px">Error: ${e.message}</div>`;
    console.error('renderPredictPage:', e);
  }
}

function setPredScore(fxId, scoreA, scoreB){
  document.getElementById('pa_'+fxId).value=scoreA;
  document.getElementById('pb_'+fxId).value=scoreB;
  document.querySelectorAll(`[data-pred-fix="${fxId}"]`).forEach(b=>{
    const isSelected = b.dataset.sa==scoreA && b.dataset.sb==scoreB;
    b.style.background    = isSelected ? 'var(--accent)'              : 'rgba(255,255,255,0.04)';
    b.style.color         = isSelected ? '#000'                       : 'rgba(255,255,255,0.4)';
    b.style.borderColor   = isSelected ? 'var(--accent)'              : 'rgba(255,255,255,0.12)';
    b.style.fontWeight    = isSelected ? '700'                        : '400';
  });
}

function togglePredDouble(fxId, mdId){
  const btn=document.getElementById('dbl_'+fxId); if(!btn) return;
  const isActive=btn.dataset.active==='true';
  // Clear x2 from all other fixtures in this MD
  FIXTURES.filter(f=>f.matchday_id===mdId&&f.id!==fxId).forEach(f=>{
    const ob=document.getElementById('dbl_'+f.id);
    if(ob){ ob.dataset.active='false'; ob.style.cssText=''; }
  });
  btn.dataset.active=isActive?'false':'true';
  btn.style.cssText=!isActive?'background:rgba(255,185,0,0.15);border-color:rgba(255,185,0,0.4);color:var(--gold)':'';
}

async function submitPrediction(fxId, mdId){
  if(!myTeamId){ toast('Please login'); return; }
  const md=MATCHDAYS.find(m=>m.id===mdId);
  if(isMarketLocked(md)){ toast('Predictions are locked'); return; }
  const scoreA=parseInt(document.getElementById('pa_'+fxId)?.value);
  const scoreB=parseInt(document.getElementById('pb_'+fxId)?.value);
  if(isNaN(scoreA)||isNaN(scoreB)){ toast('Pick a score first'); return; }
  const isDoubled=document.getElementById('dbl_'+fxId)?.dataset.active==='true';

  // Clear x2 from other predictions in this MD if doubling this one
  if(isDoubled){
    await sb.from('predictions').update({is_doubled:false})
      .eq('team_id',myTeamId).eq('matchday_id',mdId).neq('fixture_id',fxId);
  }
  const {error}=await sb.from('predictions').upsert({
    team_id:myTeamId, fixture_id:fxId, matchday_id:mdId,
    tournament_id:TOURNAMENT.id, score_a:scoreA, score_b:scoreB, is_doubled:isDoubled,
  },{onConflict:'team_id,fixture_id'});
  if(error){ toast('Error saving prediction'); console.error(error); return; }
  toast('Prediction saved ✓');
  renderPredictPage();
}

function renderSchedulePage(){
  const el=document.getElementById('scheduleContainer'); if(!el) return;
  const statusColor={scheduled:'var(--muted)',live:'#4ade80',completed:'var(--accent)'};
  const statusLabel={scheduled:'Upcoming',live:'LIVE',completed:'Completed'};
  const html=MATCHDAYS.map(md=>{
    const mdFixtures=FIXTURES.filter(f=>f.matchday_id===md.id);
    const fixtureHtml=mdFixtures.length?mdFixtures.map(fx=>{
      const timeStr=fx.scheduled_time
        ?new Date(fx.scheduled_time).toLocaleString('en-GB',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})
        :'TBD';
      const s=fx.status||'scheduled';
      return `<div class="card" style="padding:14px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px">
        <div style="flex:1">
          <div style="font-size:14px;font-weight:600">${fx.team_a} <span style="color:var(--muted);font-weight:400">vs</span> ${fx.team_b}</div>
          <div style="font-size:11px;color:var(--muted);margin-top:3px">⏰ ${timeStr}</div>
        </div>
        <span style="font-size:9px;font-weight:600;letter-spacing:1px;padding:3px 8px;border-radius:2px;white-space:nowrap;background:${s==='completed'?'rgba(0,212,255,0.08)':s==='live'?'rgba(74,222,128,0.12)':'rgba(255,255,255,0.05)'};color:${statusColor[s]||'var(--muted)'}">${statusLabel[s]||'Upcoming'}</span>
      </div>`;
    }).join(''):`<div style="font-size:12px;color:var(--muted);padding:8px 0">No fixtures scheduled yet</div>`;
    return `<div style="margin-bottom:28px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;padding-bottom:8px;border-bottom:0.5px solid var(--border2)">
        <span style="font-size:13px;font-weight:700;letter-spacing:1px">${md.label}</span>
        <span style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px">${md.phase}</span>
      </div>
      ${fixtureHtml}
    </div>`;
  }).join('');
  el.innerHTML=`<div class="hero" style="padding:40px 20px 28px">
    <div class="event-tag">📅 MATCH SCHEDULE</div>
    <h1>VALO<span>TASY</span><br>SCHEDULE</h1>
    <div class="hero-sub">VCT MASTERS LONDON 2026</div>
  </div>
  <div>${html||'<div style="text-align:center;padding:40px;color:var(--muted)">No fixtures scheduled yet</div>'}</div>`;
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
  if(!await showConfirm('Remove Player','Remove this player from the tournament roster?','Remove')) return;
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
  if(!await showConfirm('Delete Team','Delete this team and all their data? This cannot be undone.','Delete')) return;
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
  startCountdown();
}

init();
