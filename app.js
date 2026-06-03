// ===== CONSTANTS =====
const TIER_PRICE = {S:24, A:16, B:10, C:6};
const CHIPS = [
  {id:'wildcard',name:'Wildcard',icon:'🃏',desc:'Unlimited free transfers for the entire Matchday — no penalty'},
  {id:'topfragger',name:'Top Fragger',icon:'🎯',desc:'Top scorer in your squad gets ×2 automatically'},
  {id:'clonecap',name:'Clone Captain',icon:'👥',desc:'Pick 2 captains — both get ×2'},
  {id:'triplecap',name:'Triple Captain',icon:'👑',desc:'Your captain scores ×3 instead of ×2'},
];
const SLOTS = [
  {id:'duel',label:'Duelist',roles:['Duelist']},
  {id:'init',label:'Initiator',roles:['Initiator']},
  {id:'ctrl',label:'Controller',roles:['Controller']},
  {id:'sent',label:'Sentinel',roles:['Sentinel']},
  {id:'any1',label:'Any',roles:['Duelist','Initiator','Controller','Sentinel']},
  {id:'any2',label:'Any',roles:['Duelist','Initiator','Controller','Sentinel']},
  {id:'any3',label:'Any',roles:['Duelist','Initiator','Controller','Sentinel']},
];
const MDS = ['MD1','MD2','MD3','MD4','MD5','MD6','MD7(KO)','MD8(KO)','Final'];

// ===== LOGIN =====
let currentUser = null; // {userId, manager}

async function hashPin(pin){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pin));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}

function showLogin(){
  document.getElementById('loginOverlay').classList.add('open');
}

function hideLogin(){
  document.getElementById('loginOverlay').classList.remove('open');
}

async function doLogin(){
  const manager = document.getElementById('loginManager').value.trim();
  const pin = document.getElementById('loginPin').value.trim();
  if(!manager){ toast('Please enter your name'); return; }
  if(!pin || pin.length!==4 || isNaN(pin)){ toast('PIN must be 4 digits'); return; }

  const pinHash = await hashPin(pin);

  // Check if account exists
  const {data: existing} = await sb.from('users').select('id,pin_hash').eq('manager_name', manager).single();

  if(existing){
    // Returning user — verify PIN
    if(existing.pin_hash !== pinHash){ toast('Wrong PIN'); return; }
    const cloudTeam = await loadFromCloud(existing.id);
    if(cloudTeam) myTeam = {...myTeam, ...cloudTeam};
    else myTeam = {name:manager+"'s Team",manager,slots:{},captain:null,captain2:null,chip:null,transfers:0,penalty:0,chipMD:{},lastMD:0,mdPtsArr:[],id:existing.id};
    currentUser = {userId: existing.id, manager};
    toast('Welcome back, ' + manager + '! ✓');
  } else {
    // New account — insert into users table, get UUID back
    const {data: newUser, error} = await sb.from('users').insert({manager_name:manager, pin_hash:pinHash}).select('id').single();
    if(error){
      if(error.code==='23505') toast('Name already taken — try another');
      else { toast('Error creating account'); console.error(error); }
      return;
    }
    myTeam = {name:manager+"'s Team",manager,slots:{},captain:null,captain2:null,chip:null,transfers:0,penalty:0,chipMD:{},lastMD:0,mdPtsArr:[],id:newUser.id};
    await saveToCloud(newUser.id, myTeam);
    currentUser = {userId: newUser.id, manager};
    toast('Welcome, ' + manager + '! ✓');
  }

  localStorage.setItem('vlt_user', JSON.stringify({userId: currentUser.userId, manager}));
  localStorage.setItem('vlt_my', JSON.stringify(myTeam));
  document.getElementById('navUserName').textContent = manager;
  document.getElementById('navUserBadge').style.display = 'flex';
  hideLogin();
  renderTeamPage();
}

function doLogout(){
  currentUser = null;
  myTeam = {name:'',manager:'',slots:{},captain:null,captain2:null,chip:null,transfers:0,penalty:0,chipMD:{},lastMD:0,mdPtsArr:[]};
  localStorage.removeItem('vlt_user');
  localStorage.removeItem('vlt_my');
  localStorage.removeItem('vlt_my_saved');
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
  if(!userId || !manager) return false;
  // Verify account still exists in DB
  const {data: user} = await sb.from('users').select('id').eq('id', userId).single();
  if(!user){ localStorage.removeItem('vlt_user'); localStorage.removeItem('vlt_my'); return false; }
  // Load team
  const cloudTeam = await loadFromCloud(userId);
  if(cloudTeam) myTeam = {...myTeam, ...cloudTeam};
  currentUser = {userId, manager};
  document.getElementById('navUserName').textContent = manager;
  document.getElementById('navUserBadge').style.display = 'flex';
  localStorage.setItem('vlt_my', JSON.stringify(myTeam));
  return true;
}

async function saveMyTeamCloud(){
  if(!currentUser?.userId) return;
  await saveToCloud(currentUser.userId, myTeam);
  localStorage.setItem('vlt_my', JSON.stringify(myTeam));
}

// ===== SUPABASE =====
const SUPABASE_URL = 'https://ethubdzlnaxyqcpjhlit.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV0aHViZHpsbmF4eXFjcGpobGl0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAwMjc3NTQsImV4cCI6MjA5NTYwMzc1NH0.ULOEj1B-ScKgFSV7KA9WV0DZElSvPAnrLWKcUR2MeG0';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// ===== STATE =====
let S = {players:[],teams:[],settings:{curMD:0,locked:false,budget:100,penalty:8,password:'1234'},scores:{}};
let myTeam = {name:'',manager:'',slots:{},captain:null,captain2:null,chip:null,transfers:0,penalty:0,chipMD:{},lastMD:0,mdPtsArr:[]};
let pickerSlot=null, pickerFilter='ALL', playersFilter='ALL', lbMD=0;

// ===== STORAGE — Supabase Cloud =====
async function saveToCloud(key, value){
  try {
    const {error} = await sb.from('valotasy_data').upsert({key, value:JSON.stringify(value)}, {onConflict:'key'});
    if(error) console.error('Cloud save error:', error);
  } catch(e){ console.error('Cloud save failed:', e); }
}

async function loadFromCloud(key){
  try {
    const {data,error} = await sb.from('valotasy_data').select('value').eq('key',key).single();
    if(error || !data) return null;
    return JSON.parse(data.value);
  } catch(e){ return null; }
}

async function save(){
  // Save to cloud
  await saveToCloud('gameState', S);
  // Also keep local backup
  localStorage.setItem('vlt_s', JSON.stringify(S));
  localStorage.setItem('vlt_my', JSON.stringify(myTeam));
}

function saveMyTeam(){
  localStorage.setItem('vlt_my',JSON.stringify(myTeam));
}

async function load(){
  // Show loading state
  document.getElementById('lbBody').innerHTML='<div style="text-align:center;padding:40px;color:var(--muted);font-size:12px;letter-spacing:1px">Loading from cloud...</div>';

  // Try cloud first
  const cloudState = await loadFromCloud('gameState');
  if(cloudState){
    S = {...S, ...cloudState};
    console.log('✅ Loaded from cloud');
  } else {
    // Fall back to localStorage
    const s = localStorage.getItem('vlt_s');
    if(s) S = {...S, ...JSON.parse(s)};
    console.log('📦 Loaded from localStorage');
  }

  // Load my team from localStorage (personal data stays local)
  const m = localStorage.getItem('vlt_my');
  if(m) myTeam = {...myTeam, ...JSON.parse(m)};

  lbMD = S.settings.curMD;
}

// Real-time listener — auto refresh LB when data changes
function subscribeRealtime(){
  sb.channel('valotasy-changes')
    .on('postgres_changes', {event:'*', schema:'public', table:'valotasy_data'}, (payload)=>{
      if(payload.new && payload.new.key === 'gameState'){
        try {
          const newState = JSON.parse(payload.new.value);
          S = {...S, ...newState};
          lbMD = S.settings.curMD;
          // Auto-refresh current page
          const activePage = document.querySelector('.page.active');
          if(activePage && activePage.id==='page-lb') renderLB();
          if(activePage && activePage.id==='page-team') renderTeamPage();
          if(activePage && activePage.id==='page-players') renderPlayersPage();
          toast('📡 Updated from cloud');
        } catch(e){}
      }
    })
    .subscribe();
}

// ===== TOAST =====
function toast(msg,dur=2200){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),dur);}

// ===== PAGE NAV =====
function goPage(id){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t=>t.classList.remove('active'));
  const map={lb:0,team:1,players:2,rules:3};
  document.querySelectorAll('.nav-tab')[map[id]].classList.add('active');
  if(id==='team' && !currentUser){
    showLogin();
    // Reset tab highlight back to lb
    document.querySelectorAll('.nav-tab').forEach(t=>t.classList.remove('active'));
    document.querySelectorAll('.nav-tab')[0].classList.add('active');
    document.getElementById('page-lb').classList.add('active');
    return;
  }
  document.getElementById('page-'+id).classList.add('active');
  if(id==='lb')renderLB();
  if(id==='team')renderTeamPage();
  if(id==='players')renderPlayersPage();
}

// ===== ADMIN =====
function toggleAdmin(){
  document.getElementById('adminModal').classList.add('open');
  // Always require password - never auto-unlock from stored state
  showAdminLock();
}
function showAdminLock(){
  document.getElementById('adminLock').style.display='block';
  document.getElementById('adminContent').style.display='none';
  document.getElementById('adminPw').value='';
}
function closeAdmin(){document.getElementById('adminModal').classList.remove('open');}
function checkAdmin(){
  if(document.getElementById('adminPw').value===S.settings.password){showAdminContent();}
  else toast('Wrong password');
}
function renderTeamListAdmin(){
  const el=document.getElementById('teamListAdmin');
  const countEl=document.getElementById('teamCount');
  const teams=S.teams||[];
  if(countEl) countEl.textContent=teams.length;
  if(!el) return;
  if(!teams.length){
    el.innerHTML='<div style="color:var(--muted);font-size:12px;padding:8px">No teams yet</div>';
    return;
  }
  el.innerHTML=teams.map(t=>`
    <div style="display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;padding:10px 0;border-bottom:0.5px solid var(--border2)">
      <div>
        <div style="font-size:13px;font-weight:600;color:var(--text)">${t.name||'Unnamed'}</div>
        <div style="font-size:11px;color:var(--muted);margin-top:2px">
          👤 ${t.manager||'—'} &nbsp;·&nbsp;
          🎮 ${Object.values(t.slots||{}).filter(Boolean).length}/7 players &nbsp;·&nbsp;
          ⭐ ${(t.mdPtsArr||[]).reduce((a,b)=>a+(b||0),0)} pts total
        </div>
        <div style="font-size:10px;color:rgba(255,255,255,0.18);margin-top:3px;font-family:monospace">${t.id||'—'}</div>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0">
        <button onclick="openEditTeamAdmin('${t.id}')"
          style="background:rgba(255,255,255,0.05);border:0.5px solid rgba(255,255,255,0.15);color:rgba(255,255,255,0.6);padding:5px 12px;font-size:11px;cursor:pointer;border-radius:4px;white-space:nowrap;transition:.2s"
          onmouseover="this.style.background='rgba(255,255,255,0.1)'" onmouseout="this.style.background='rgba(255,255,255,0.05)'">✏️ Edit</button>
        <button onclick="deleteTeamAdmin('${t.id}')"
          style="background:none;border:0.5px solid rgba(255,70,85,0.3);color:var(--red);padding:5px 12px;font-size:11px;cursor:pointer;border-radius:4px;white-space:nowrap;transition:.2s"
          onmouseover="this.style.background='rgba(255,70,85,0.1)'" onmouseout="this.style.background='none'">🗑 Delete</button>
      </div>
    </div>`).join('');
}

async function deleteTeamAdmin(teamId){
  if(!teamId){toast('Invalid team ID');return;}
  const team=(S.teams||[]).find(t=>t.id===teamId);
  const name=team?`"${team.name}"`:'"this team"';
  if(!confirm(`Remove ${name} from the leaderboard?\nThis cannot be undone.`))return;
  S.teams=(S.teams||[]).filter(t=>t.id!==teamId);
  try{ await sb.from('valotasy_data').delete().eq('key',teamId); }catch(e){console.error(e);}
  await save();
  renderTeamListAdmin();
  renderLB();
  toast(`${name} removed ✓`);
}

function openEditTeamAdmin(teamId){
  const team=(S.teams||[]).find(t=>t.id===teamId);
  if(!team){toast('Team not found');return;}
  document.getElementById('editTeamAdminId').value=teamId;
  document.getElementById('editTeamAdminName').value=team.name||'';
  document.getElementById('editTeamAdminManager').value=team.manager||'';
  document.getElementById('editTeamAdminModal').classList.add('open');
}
function closeEditTeamAdmin(){
  document.getElementById('editTeamAdminModal').classList.remove('open');
}
async function saveEditTeamAdmin(){
  const teamId=document.getElementById('editTeamAdminId').value;
  const newName=document.getElementById('editTeamAdminName').value.trim();
  const newManager=document.getElementById('editTeamAdminManager').value.trim();
  if(!newName){toast('Team name cannot be empty');return;}
  if(!newManager){toast('Manager name cannot be empty');return;}
  const idx=(S.teams||[]).findIndex(t=>t.id===teamId);
  if(idx<0){toast('Team not found');return;}
  S.teams[idx]={...S.teams[idx],name:newName,manager:newManager};
  // Also patch the personal cloud record (keyed by teamId)
  try{
    const {data}=await sb.from('valotasy_data').select('value').eq('key',teamId).single();
    if(data){const rec=JSON.parse(data.value);rec.name=newName;rec.manager=newManager;await saveToCloud(teamId,rec);}
  }catch(e){}
  await save();
  closeEditTeamAdmin();
  renderTeamListAdmin();
  renderLB();
  toast('Team updated ✓');
}


function showAdminContent(){
  document.getElementById('adminLock').style.display='none';
  document.getElementById('adminContent').style.display='block';
  document.getElementById('adminToggle').classList.add('active-admin');
  document.getElementById('setCurMD').value=S.settings.curMD;
  document.getElementById('setLocked').value=S.settings.locked?'1':'0';
  document.getElementById('setBudget').value=S.settings.budget;
  document.getElementById('setPenalty').value=S.settings.penalty;
  document.getElementById('setDeadline').value=S.settings.deadline||'';
  renderAdminPlayers();renderScoreList();renderTeamListAdmin();
}
function addPlayer(){
  const name=document.getElementById('aName').value.trim();
  if(!name){toast('Please enter a player name');return;}
  if(S.players.find(p=>p.name.toLowerCase()===name.toLowerCase())){toast('Player already exists');return;}
  const tier=document.getElementById('aTier').value;
  S.players.push({id:Date.now(),name,team:document.getElementById('aTeam').value,role:document.getElementById('aRole').value,tier,price:TIER_PRICE[tier]});
  document.getElementById('aName').value='';
  save().then(()=>{ renderAdminPlayers();toast(`${name} added ✓`); });
}

// ===== EDIT PLAYER =====
function openEdit(id){
  const p=S.players.find(pl=>pl.id===id);
  if(!p)return;
  document.getElementById('editId').value=id;
  document.getElementById('editName').value=p.name;
  document.getElementById('editTeam').value=p.team;
  document.getElementById('editRole').value=p.role;
  document.getElementById('editTier').value=p.tier;
  document.getElementById('editModal').classList.add('open');
}
function closeEdit(){document.getElementById('editModal').classList.remove('open');}
function saveEdit(){
  const id=parseInt(document.getElementById('editId').value);
  const tier=document.getElementById('editTier').value;
  S.players=S.players.map(p=>{
    if(p.id!==id)return p;
    return {...p,name:document.getElementById('editName').value.trim(),team:document.getElementById('editTeam').value,role:document.getElementById('editRole').value,tier,price:TIER_PRICE[tier]};
  });
  save();renderAdminPlayers();closeEdit();toast('Updated ✓');
}
function deletePlayer(id){
  if(!confirm('Remove this player?'))return;
  S.players=S.players.filter(p=>p.id!==id);
  save().then(()=>{ renderAdminPlayers();toast('Removed ✓'); });
}
function renderAdminPlayers(){
  const el=document.getElementById('playerListAdmin');
  document.getElementById('playerCount').textContent=S.players.length;
  if(!S.players.length){el.innerHTML='<div style="color:var(--muted);font-size:12px;padding:8px">No players yet</div>';return;}
  const roleTag={Duelist:'D',Initiator:'I',Controller:'C',Sentinel:'Se',Any:'An'};
  el.innerHTML=S.players.map(p=>`
    <div class="pla-row">
      <div>${p.name}<br><span style="color:var(--muted);font-size:10px">${p.team}</span></div>
      <div><span class="tag tag-${roleTag[p.role]||'An'}">${p.role.slice(0,3)}</span></div>
      <div><span class="tag tag-${p.tier}">${p.tier}</span></div>
      <div style="color:var(--accent);font-family:'Share Tech Mono',monospace;font-size:11px">${p.price}M</div>
      <div class="pla-actions">
        <button class="btn-sm btn-edit" onclick="openEdit(${p.id})">✏️</button>
        <button class="btn-sm btn-del" onclick="deletePlayer(${p.id})">✕</button>
      </div>
    </div>`).join('');
}
function renderScoreList(){
  const md=parseInt(document.getElementById('aMD').value);
  const el=document.getElementById('scoreList');
  if(!S.players.length){el.innerHTML='<div style="color:var(--muted);font-size:12px">No players yet</div>';return;}
  el.innerHTML=S.players.map(p=>{
    const sc=S.scores[md]&&S.scores[md][p.id]!==undefined?S.scores[md][p.id]:'';
    return `<div class="score-row"><div>${p.name} <span style="color:var(--muted);font-size:10px">${p.team}</span></div><input type="number" id="sc_${p.id}" value="${sc}" placeholder="pts"></div>`;
  }).join('');
}
function saveScores(){
  const md=parseInt(document.getElementById('aMD').value);
  if(!S.scores[md])S.scores[md]={};
  S.players.forEach(p=>{const el=document.getElementById('sc_'+p.id);if(el&&el.value!=='')S.scores[md][p.id]=parseFloat(el.value)||0;});
  S.players=S.players.map(p=>{
    const sc=S.scores[md]&&S.scores[md][p.id]!==undefined?S.scores[md][p.id]:null;
    if(sc===null)return p;
    let np=p.price;
    if(sc>23)np=Math.min(30,+(p.price+1.5).toFixed(1));
    else if(sc>=20)np=Math.min(30,+(p.price+1).toFixed(1));
    else if(sc>=16)np=Math.min(30,+(p.price+0.5).toFixed(1));
    else if(sc>=12)np=p.price;
    else if(sc>=8)np=p.price;
    else if(sc>=5)np=Math.max(4,+(p.price-0.5).toFixed(1));
    else if(sc>=2)np=Math.max(4,+(p.price-1).toFixed(1));
    else np=Math.max(4,+(p.price-1.5).toFixed(1));
    return {...p,price:np};
  });
  save().then(()=>{ toast('Scores saved ✓ Prices updated'); renderScoreList(); });
}
function saveSettings(){
  S.settings={...S.settings,
    curMD:parseInt(document.getElementById('setCurMD').value),
    locked:document.getElementById('setLocked').value==='1',
    budget:parseInt(document.getElementById('setBudget').value)||100,
    penalty:parseInt(document.getElementById('setPenalty').value)||8,
    deadline:document.getElementById('setDeadline').value||''
  };
  const pw=document.getElementById('setPassword').value;if(pw)S.settings.password=pw;
  lbMD=S.settings.curMD;
  save().then(()=>toast('Settings saved ✓'));
  renderDeadlineBanner();
}
function resetAll(){localStorage.removeItem('vlt_s');localStorage.removeItem('vlt_my');location.reload();}

function renderDeadlineBanner(){
  const el=document.getElementById('deadlineBanner');
  if(!el)return;
  const dl=S.settings.deadline;
  if(!dl){el.innerHTML='';return;}
  const now=new Date();const target=new Date(dl);const diff=target-now;
  if(diff<=0){el.innerHTML='<div class="lock-banner">⏰ Deadline has passed</div>';return;}
  const h=Math.floor(diff/3600000);const m=Math.floor((diff%3600000)/60000);const d=Math.floor(h/24);
  const label=d>0?`${d}d ${h%24}h ${m}m`:`${h}h ${m}m`;
  el.innerHTML=`<div style="background:rgba(0,212,255,0.06);border:1px solid rgba(0,212,255,0.2);padding:10px 16px;font-family:'Share Tech Mono',monospace;font-size:11px;color:var(--accent);letter-spacing:1px;margin-bottom:12px;display:flex;align-items:center;gap:8px">⏰ Deadline: <strong>${new Date(dl).toLocaleString('th-TH')}</strong> &nbsp;·&nbsp; Time left: <strong>${label}</strong></div>`;
}

// ===== LEADERBOARD =====
function calcOwnership(){
  const own={};
  const total=(S.teams||[]).length;
  if(!total)return own;
  (S.teams||[]).forEach(t=>{
    Object.values(t.slots||{}).filter(Boolean).forEach(pid=>{
      own[pid]=(own[pid]||0)+1;
    });
  });
  Object.keys(own).forEach(k=>own[k]=Math.round(own[k]/total*100));
  return own;
}

function isDeadlinePassed(){
  const dl=S.settings.deadline;
  if(!dl) return S.settings.locked;
  return new Date()>new Date(dl) || S.settings.locked;
}

function renderLB(){
  document.getElementById('lbMdNav').innerHTML=MDS.map((md,i)=>`<button class="md-btn ${i===lbMD?'on':''}" onclick="lbMD=${i};renderLB()">${md}</button>`).join('');
  const allTeams=S.teams||[];
  const scMD=S.scores[lbMD]||{};
  const ranked=allTeams.map(t=>{
    let mdPts=0;
    const chip=t.chipMD&&t.chipMD[lbMD];
    const pids=t.slots?Object.values(t.slots).filter(Boolean):[];
    if(chip==='topfragger'){
      let maxV=-Infinity;pids.forEach(pid=>{const v=scMD[pid]||0;if(v>maxV)maxV=v;});
      pids.forEach(pid=>{const raw=scMD[pid]||0;mdPts+=raw===maxV?raw*2:raw;});
    } else {
      pids.forEach(pid=>{
        const raw=scMD[pid]||0;const isCap=t.captain==pid;const isCap2=t.captain2==pid;
        let pts=chip==='triplecap'&&isCap?raw*3:(chip==='clonecap'&&(isCap||isCap2))?raw*2:isCap?raw*2:raw;
        mdPts+=pts;
      });
    }
    const storedPts=(t.mdPtsArr||[]);
    // Penalty for this MD
    const isMD1lb=lbMD===0;const isWildcardlb=chip==='wildcard';
    const extralb=(isMD1lb||isWildcardlb)?0:Math.max(0,(t.transfers||0)-2);
    const penlb=extralb*(S.settings.penalty||8);
    const mdScore=mdPts-penlb;
    // Use stored mdPtsArr for total, replace current MD's entry with live calc
    const totalArr=[...storedPts];
    if(totalArr.length>lbMD) totalArr[lbMD]=mdScore;
    else{ while(totalArr.length<lbMD)totalArr.push(0); totalArr.push(mdScore); }
    const total=totalArr.reduce((a,b)=>a+(b||0),0);
    return {...t,mdScore,total};
  }).sort((a,b)=>b.total-a.total);
  const topMD=ranked.length?Math.max(...ranked.map(r=>r.mdScore)):0;
  document.getElementById('statsStrip').innerHTML=`
    <div class="stat-box"><div class="stat-lbl">Leader</div><div class="stat-val" style="font-size:20px">${ranked[0]?.manager||ranked[0]?.name||'—'}</div></div>
    <div class="stat-box"><div class="stat-lbl">Top MD</div><div class="stat-val">${topMD||'—'}</div></div>
    <div class="stat-box"><div class="stat-lbl">Teams</div><div class="stat-val">${ranked.length}</div></div>
    <div class="stat-box"><div class="stat-lbl">Matchday</div><div class="stat-val">${MDS[lbMD]}</div></div>`;
  const body=document.getElementById('lbBody');
  if(!ranked.length){body.innerHTML='<div style="text-align:center;padding:60px;color:var(--muted);font-size:12px;letter-spacing:1px;text-transform:uppercase">No teams yet — invite your friends to pick their squads!</div>';return;}
  body.innerHTML=ranked.map((t,i)=>{
    const gc=i===0?'g1':i===1?'g2':i===2?'g3':'';
    const chip=t.chipMD&&t.chipMD[lbMD];
    const chipObj=chip?CHIPS.find(c=>c.id===chip):null;
    const hiClass=t.mdScore===topMD&&topMD>0?'hi':'';
    const deadlinePassed = isDeadlinePassed();
    return `
    <div class="lb-row ${gc}" style="animation-delay:${i*.05}s" onclick="toggleExpand('exp${i}')">
      <div class="rank-n">${i+1}</div>
      <div class="team-col"><div class="team-nm">${t.name||'Team '+(i+1)}</div><div class="team-mgr">${t.manager||''}</div></div>
      <div class="pts-big c">${t.total}</div>
      <div class="pts-md c ${hiClass}">${t.mdScore>=0?'+':''}${t.mdScore}</div>
      <div class="chip-col">${deadlinePassed&&chipObj?`<span title="${chipObj.name}">${chipObj.icon}</span>`:'<span style="color:var(--muted);font-size:11px">—</span>'}</div>
      <div class="mv c" style="color:var(--muted)">—</div>
    </div>
    <div class="lb-expand" id="exp${i}">
      ${deadlinePassed ? `
      <div class="player-chips">
        ${t.slots?Object.entries(t.slots).map(([sid,pid])=>{
          const p=S.players.find(pl=>pl.id==pid);if(!p)return'';
          const raw=scMD[pid]||0;
          const isCap=t.captain==pid;const isCap2=t.captain2==pid;
          const expChip=t.chipMD&&t.chipMD[lbMD];
          let expPts=raw;
          if(expChip==='triplecap'&&isCap)expPts=raw*3;
          else if(expChip==='clonecap'&&(isCap||isCap2))expPts=raw*2;
          else if(isCap||isCap2)expPts=raw*2;
          const capLabel=isCap?'C':isCap2?'C2':'';
          return`<div class="pc ${(isCap||isCap2)?'cap':''}"><div class="pc-role">${p.role}</div><div class="pc-name">${p.name}${capLabel?` <span style="color:var(--gold);font-size:10px">[${capLabel}]</span>`:''}</div><div class="pc-team">${p.team}</div><div class="pc-pts">${expPts} pts</div></div>`;
        }).join(''):'<div style="color:var(--muted);font-size:12px">No player data</div>'}
      </div>` : `
      <div style="text-align:center;padding:16px;font-size:12px;color:var(--muted);font-family:'Share Tech Mono',monospace;letter-spacing:1px">
        🔒 Squad revealed after deadline
      </div>`}
    </div>`;
  }).join('');
}
function toggleExpand(id){
  document.querySelectorAll('.lb-expand').forEach(e=>{if(e.id!==id)e.classList.remove('open');});
  document.getElementById(id).classList.toggle('open');
}

// ===== MY TEAM =====
function checkMDReset(){
  // Auto-reset transfers when Matchday changes
  const curMD=S.settings.curMD;
  if(myTeam.lastMD!==undefined && myTeam.lastMD!==curMD){
    myTeam.transfers=0;
    myTeam.chip=null;
    myTeam.captain2=null;
    myTeam.lastMD=curMD;
    saveMyTeam();
  } else if(myTeam.lastMD===undefined){
    myTeam.lastMD=curMD;
    saveMyTeam();
  }
}
function renderTeamPage(){
  checkMDReset();
  document.getElementById('myTeamName').value=myTeam.name||'';
  document.getElementById('myManagerName').value=myTeam.manager||'';
  document.getElementById('lockBanner').innerHTML=S.settings.locked?'<div class="lock-banner">🔒 Deadline has passed — team is locked</div>':'';
  // Reset transfers if MD changed since last save
  const curMD=S.settings.curMD;
  if((myTeam.lastMD!==undefined)&&myTeam.lastMD!==curMD){
    myTeam.transfers=0;myTeam.lastMD=curMD;saveMyTeam();
  } else if(myTeam.lastMD===undefined){
    myTeam.lastMD=curMD;saveMyTeam();
  }
  const isMD1=curMD===0;
  const tlEl=document.getElementById('transferLabel');
  if(tlEl){
    if(isMD1) tlEl.innerHTML='<span style="color:#4ade80">MD1 — Unlimited transfers</span>';
    else {
      const used=myTeam.transfers||0;
      const penalty=S.settings.penalty||8;
      const extra=Math.max(0,used-2);
      const penStr=extra>0?` &nbsp;<span style="color:var(--red)">+${extra} over (-${extra*penalty}pts penalty)</span>`:'';
      tlEl.innerHTML=`Transfers this MD: <span id="transferUsed" style="color:${used>2?'var(--red)':'var(--text)'}">${used}</span>/2${penStr}`;
    }
  }
  const isMD1x=S.settings.curMD===0;
  const penPer=S.settings.penalty||8;
  const extraT=isMD1x?0:Math.max(0,(myTeam.transfers||0)-2);
  const penTotal=extraT*penPer;
  document.getElementById('penaltyPts').textContent=`-${penTotal} pts`;
  renderDeadlineBanner();
  renderSlots();renderCaptainList();renderChipList();calcBudget();calcMyPts();
}
function renderSlots(){
  const scMD=S.scores[S.settings.curMD]||{};
  document.getElementById('slotsGrid').innerHTML=SLOTS.map(sl=>{
    const pid=myTeam.slots[sl.id];const p=pid?S.players.find(pl=>pl.id==pid):null;
    const isCap=myTeam.captain==pid||myTeam.captain2==pid;
    const raw=pid&&scMD[pid]?scMD[pid]:0;const dispPts=isCap?raw*2:raw;
    return p?`<div class="slot filled ${isCap?'cap-slot':''}">
      <div class="slot-label" style="display:flex;justify-content:space-between;align-items:center">
        <span>${sl.label}</span>
        <button onclick="event.stopPropagation();removePlayer('${sl.id}')" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px;line-height:1;padding:0 2px;transition:.2s" onmouseover="this.style.color='var(--red)'" onmouseout="this.style.color='var(--muted)'">✕</button>
      </div>
      ${isCap?'<div class="cap-badge">C</div>':''}
      <div class="slot-name" onclick="openPicker('${sl.id}','${sl.label}')" style="cursor:pointer">${p.name}</div>
      <div class="slot-team" onclick="openPicker('${sl.id}','${sl.label}')" style="cursor:pointer">${p.team} · <span class="tag tag-${p.tier}" style="font-size:8px">${p.tier}</span> · <span style="color:var(--accent)">${p.price}M</span></div>
      <div class="slot-pts">${dispPts}</div></div>`
    :`<div class="slot" onclick="openPicker('${sl.id}','${sl.label}')"><div class="slot-label">${sl.label}</div><div class="slot-empty">+ Pick a player</div></div>`;
  }).join('');
}
function removePlayer(slotId){
  const pid=myTeam.slots[slotId];
  if(!pid)return;
  if(S.settings.locked){toast('Deadline has passed — team is locked');return;}
  delete myTeam.slots[slotId];
  if(myTeam.captain==pid)myTeam.captain=null;
  if(myTeam.captain2==pid)myTeam.captain2=null;
  saveMyTeam();renderTeamPage();toast('Player removed');
}
function renderCaptainList(){
  const el=document.getElementById('captainList');
  const filled=Object.values(myTeam.slots||{}).filter(Boolean).map(pid=>S.players.find(p=>p.id==pid)).filter(Boolean);
  if(!filled.length){el.innerHTML='<div style="font-size:11px;color:var(--muted)">Pick players first</div>';return;}
  el.innerHTML=filled.map(p=>{
    const isCap=myTeam.captain==p.id,isCap2=myTeam.captain2==p.id;
    return`<div style="padding:7px 10px;background:var(--s2);border:1px solid ${isCap||isCap2?'var(--gold)':'var(--border2)'};margin-bottom:5px;display:flex;justify-content:space-between;align-items:center;cursor:pointer;transition:.2s" onclick="setCaptain(${p.id})">
      <span style="font-size:13px;font-weight:600">${p.name} <span style="color:var(--muted);font-size:10px">${p.team}</span></span>
      ${isCap?'<span style="color:var(--gold);font-family:\'Bebas Neue\',sans-serif;font-size:16px">C</span>':isCap2?'<span style="color:var(--gold);font-family:\'Bebas Neue\',sans-serif;font-size:14px">C2</span>':'<span style="color:var(--muted);font-size:11px">Select</span>'}
    </div>`;
  }).join('');
}
function setCaptain(pid){
  if(myTeam.chip==='clonecap'){
    if(myTeam.captain==pid)myTeam.captain=null;
    else if(myTeam.captain2==pid)myTeam.captain2=null;
    else if(!myTeam.captain)myTeam.captain=pid;
    else if(!myTeam.captain2)myTeam.captain2=pid;
    else{myTeam.captain=pid;myTeam.captain2=null;}
  } else {myTeam.captain=myTeam.captain==pid?null:pid;myTeam.captain2=null;}
  saveMyTeam();renderSlots();renderCaptainList();calcMyPts();
}
function renderChipList(){
  document.getElementById('chipList').innerHTML=CHIPS.map(c=>{
    const isSelected=myTeam.chip===c.id;
    return`<div class="chip-item ${isSelected?'selected':''}" onclick="selectChip('${c.id}')">
      <div class="chip-icon">${c.icon}</div>
      <div class="chip-info"><div class="chip-nm">${c.name}</div><div class="chip-desc">${c.desc}</div></div>
      ${isSelected?'<div style="font-family:\'Share Tech Mono\',monospace;font-size:9px;color:var(--gold)">ON</div>':''}
    </div>`;
  }).join('');
}
function selectChip(id){
  if(S.settings.locked)return;
  myTeam.chip=myTeam.chip===id?null:id;
  if(myTeam.chip!=='clonecap')myTeam.captain2=null;
  saveMyTeam();renderChipList();renderCaptainList();calcMyPts();
}
function calcBudget(){
  const used=Object.values(myTeam.slots||{}).reduce((sum,pid)=>{
    if(!pid)return sum;const p=S.players.find(pl=>pl.id==pid);return sum+(p?p.price:0);
  },0);
  const budget=S.settings.budget||100;
  const left=budget-used;
  const el=document.getElementById('budgetLeft');
  const tot=document.getElementById('budgetTotal');
  el.textContent=left+'M';el.style.color=left<0?'var(--red)':'var(--accent)';
  if(tot)tot.textContent='/'+budget+'M';
  return left;
}
function calcMyPts(){
  const scMD=S.scores[S.settings.curMD]||{};const chip=myTeam.chip;
  const pids=Object.values(myTeam.slots||{}).filter(Boolean);let total=0;
  if(chip==='topfragger'){
    let maxV=-Infinity;pids.forEach(pid=>{const v=scMD[pid]||0;if(v>maxV)maxV=v;});
    pids.forEach(pid=>{const raw=scMD[pid]||0;total+=raw===maxV?raw*2:raw;});
  } else {
    pids.forEach(pid=>{
      const raw=scMD[pid]||0;
      const isPrimeCap=myTeam.captain==pid;
      const isSecondCap=myTeam.captain2==pid;
      let pts=raw;
      if(chip==='triplecap'&&isPrimeCap) pts=raw*3;
      else if(chip==='clonecap'&&(isPrimeCap||isSecondCap)) pts=raw*2;
      else if(isPrimeCap) pts=raw*2;
      total+=pts;
    });
  }
  // Penalty: MD1 free, wildcard free, else -8 per transfer over 2
  const isMD1=S.settings.curMD===0;
  const isWildcardActive=myTeam.chip==='wildcard';
  const penaltyPer=S.settings.penalty||8;
  const extraTransfers=(isMD1||isWildcardActive)?0:Math.max(0,(myTeam.transfers||0)-2);
  const penaltyTotal=extraTransfers*penaltyPer;
  if(penaltyTotal>0) total-=penaltyTotal;
  document.getElementById('myTotalPts').textContent=total;
}

// ===== PICKER =====
function openPicker(slotId,slotLabel){
  if(S.settings.locked){toast('Deadline has passed — changes are not allowed');return;}
  pickerSlot=slotId;pickerFilter='ALL';
  document.getElementById('pickerTitle').textContent='Pick '+slotLabel;
  document.getElementById('pickerSearch').value='';
  document.querySelectorAll('#pickerModal .filter-btn').forEach((b,i)=>b.classList.toggle('on',i===0));
  document.getElementById('pickerModal').classList.add('open');renderPicker();
}
function closePicker(){document.getElementById('pickerModal').classList.remove('open');pickerSlot=null;}
function setFilter(f,el){pickerFilter=f;document.querySelectorAll('#pickerModal .filter-btn').forEach(b=>b.classList.remove('on'));el.classList.add('on');renderPicker();}
function renderPicker(){
  const q=document.getElementById('pickerSearch').value.toLowerCase();
  const slot=SLOTS.find(s=>s.id===pickerSlot);
  const isAnySlot=pickerSlot&&pickerSlot.startsWith('any');
  const allowedRoles=slot?slot.roles:[];
  const selectedIds=Object.values(myTeam.slots||{}).filter(Boolean).map(Number);
  const teamCount={};
  selectedIds.forEach(pid=>{const p=S.players.find(pl=>pl.id==pid);if(p)teamCount[p.team]=(teamCount[p.team]||0)+1;});
  const list=S.players.filter(p=>{
    if(q&&!p.name.toLowerCase().includes(q)&&!p.team.toLowerCase().includes(q))return false;
    if(pickerFilter!=='ALL'&&p.role!==pickerFilter)return false;
    return true;
  });
  if(!list.length){document.getElementById('pickerBody').innerHTML='<div style="color:var(--muted);text-align:center;padding:32px;font-size:13px">No players found</div>';return;}
  document.getElementById('pickerBody').innerHTML=list.map(p=>{
    const alreadyIn=selectedIds.includes(p.id)&&myTeam.slots[pickerSlot]!=p.id;
    const roleOk=isAnySlot||allowedRoles.includes(p.role);
    const teamFull=(teamCount[p.team]||0)>=2&&!selectedIds.includes(p.id);
    const disabled=alreadyIn||!roleOk||teamFull;
    return`<div class="player-row">
      <div><div class="pr-name">${p.name}</div><div class="pr-vctt">${p.team}</div></div>
      <div class="pr-role">${p.role}</div>
      <div class="pr-tier ${p.tier}">${p.tier}</div>
      <div class="pr-price">${p.price}M</div>
      <button class="pr-add" ${disabled?'disabled':''} onclick="pickPlayer(${p.id})">${alreadyIn?'In squad':teamFull?'Full':!roleOk?'✗':'Pick'}</button>
    </div>`;
  }).join('');
}
function pickPlayer(pid){
  if(!pickerSlot)return;
  const oldPid=myTeam.slots[pickerSlot];
  const p=S.players.find(pl=>pl.id==pid);const oldP=oldPid?S.players.find(pl=>pl.id==oldPid):null;
  const net=(oldP?oldP.price:0)-(p?p.price:0);
  if(calcBudget()+net<0){toast('Not enough budget!');return;}
  const isMD1=S.settings.curMD===0;
  const isWildcard=myTeam.chip==='wildcard';
  myTeam.lastMD=S.settings.curMD;
  if(oldPid&&oldPid!=pid&&!isMD1&&!isWildcard){
    myTeam.transfers=(myTeam.transfers||0)+1;
  }
  myTeam.slots[pickerSlot]=pid;
  if(myTeam.captain==oldPid)myTeam.captain=null;
  if(myTeam.captain2==oldPid)myTeam.captain2=null;
  saveMyTeam();closePicker();renderTeamPage();toast(`${p.name} added ✓`);
}

// ===== SAVE/SUBMIT =====
function saveMyTeam(){
  myTeam.name=document.getElementById('myTeamName')?.value||myTeam.name||'';
  myTeam.manager=document.getElementById('myManagerName')?.value||myTeam.manager||'';
  localStorage.setItem('vlt_my',JSON.stringify(myTeam));
}
function calcMDPts(slots,captain,captain2,chip,md){
  const scMD=S.scores[md]||{};
  const pids=Object.values(slots||{}).filter(Boolean);
  let total=0;
  if(chip==='topfragger'){
    let maxV=-Infinity;pids.forEach(pid=>{const v=scMD[pid]||0;if(v>maxV)maxV=v;});
    pids.forEach(pid=>{const raw=scMD[pid]||0;total+=raw===maxV?raw*2:raw;});
  } else {
    pids.forEach(pid=>{
      const raw=scMD[pid]||0;
      const isCap=captain==pid||captain2==pid;
      let pts=chip==='triplecap'&&isCap?raw*3:isCap?raw*2:raw;
      total+=pts;
    });
  }
  return total;
}
async function saveAndSubmit(){
  if(!myTeam.name){toast('Please enter a team name first');return;}
  if(!myTeam.manager){toast('Please enter a manager name');return;}
  if(calcBudget()<0){toast('Over budget! Please adjust your squad');return;}
  // Calculate actual MD pts for current MD
  const curMD=S.settings.curMD;
  const chipThisMD=myTeam.chip||null;
  const mdPts=calcMDPts(myTeam.slots,myTeam.captain,myTeam.captain2,chipThisMD,curMD);
  const isMD1=curMD===0;const isWildcard=chipThisMD==='wildcard';
  const extra=(isMD1||isWildcard)?0:Math.max(0,(myTeam.transfers||0)-2);
  const penalty=extra*(S.settings.penalty||8);
  const netPts=mdPts-penalty;
  // Store mdPtsArr
  const arr=[...(myTeam.mdPtsArr||[])];
  arr[curMD]=netPts;
  myTeam.mdPtsArr=arr;
  const existing=(S.teams||[]).findIndex(t=>t.id===myTeam.id);
  const teamData={
    id:myTeam.id,name:myTeam.name,manager:myTeam.manager,
    slots:{...myTeam.slots},captain:myTeam.captain,captain2:myTeam.captain2,
    chipMD:{...myTeam.chipMD,[curMD]:chipThisMD},
    mdPtsArr:[...arr],penalty:penalty,transfers:myTeam.transfers||0
  };
  if(existing>=0)S.teams[existing]=teamData;else S.teams=[...(S.teams||[]),teamData];
  document.getElementById('saveInfo').textContent='Saved at '+new Date().toLocaleTimeString('en-US');
  localStorage.setItem('vlt_my_saved',JSON.stringify(myTeam));
  // Update nav badge with team name
  if(currentUser) document.getElementById('navUserName').textContent = myTeam.name||currentUser.manager;
  await save();
  await saveMyTeamCloud();
  toast('Team saved ✓');
}

async function deleteMyTeam(){
  if(!currentUser){ toast('Not logged in'); return; }
  if(!confirm('Remove your team from the leaderboard? You can re-register later.')) return;
  S.teams = (S.teams||[]).filter(t=>t.id!==myTeam.id);
  try { await sb.from('valotasy_data').delete().eq('key', currentUser.userId); } catch(e){}
  myTeam = {name:currentUser.manager+"'s Team", manager:currentUser.manager, slots:{}, captain:null, captain2:null,
    chip:null, transfers:0, penalty:0, chipMD:{}, lastMD:0, mdPtsArr:[], id:currentUser.userId};
  localStorage.setItem('vlt_my', JSON.stringify(myTeam));
  await save();
  toast('Team removed from leaderboard ✓');
  renderTeamPage();
  renderLB();
}

async function removeMyTeamFromLB(){
  if(!currentUser){ toast('Not logged in'); return; }
  if(!confirm('Remove your team from the leaderboard? Your login will remain.')) return;
  S.teams = (S.teams||[]).filter(t => t.id !== myTeam.id);
  try { await sb.from('valotasy_data').delete().eq('key', currentUser.userId); } catch(e){}
  myTeam = {...myTeam, name:currentUser.manager+"'s Team", slots:{}, captain:null, captain2:null,
    chip:null, transfers:0, penalty:0, chipMD:{}, lastMD:S.settings.curMD, mdPtsArr:[]};
  await save();
  saveMyTeam();
  renderTeamPage();
  toast('Team removed from leaderboard ✓');
}

function resetTeamToSaved(){
  const saved=localStorage.getItem('vlt_my_saved');
  if(!saved){toast('No saved team to reset to');return;}
  if(!confirm('Reset to last saved team?'))return;
  myTeam={...JSON.parse(saved)};
  localStorage.setItem('vlt_my',JSON.stringify(myTeam));
  renderTeamPage();toast('Team reset to last save ✓');
}

// ===== PLAYERS PAGE =====
function setPlayersFilter(f,el){playersFilter=f;document.querySelectorAll('#page-players .filter-btn').forEach(b=>b.classList.remove('on'));el.classList.add('on');renderPlayersPage();}
function renderPlayersPage(){
  const q=document.getElementById('playersSearch').value.toLowerCase();
  const scMD=S.scores[S.settings.curMD]||{};
  const list=S.players.filter(p=>{
    if(q&&!p.name.toLowerCase().includes(q)&&!p.team.toLowerCase().includes(q))return false;
    if(playersFilter==='ALL')return true;
    if(['S','A','B','C'].includes(playersFilter))return p.tier===playersFilter;
    return p.role===playersFilter;
  });
  const el=document.getElementById('playersGrid');
  if(!list.length){el.innerHTML='<div style="color:var(--muted);font-family:\'Share Tech Mono\',monospace;font-size:12px;padding:32px 0">No players found</div>';return;}
  const roleColor={Duelist:'#f87171',Initiator:'#60a5fa',Controller:'#a78bfa',Sentinel:'#34d399',Any:'#9ca3af'};
  el.innerHTML=`<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(175px,1fr));gap:10px">
  ${list.map(p=>{
    const pts=scMD[p.id]||0;
    return`<div class="card" style="padding:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <div style="font-family:'Share Tech Mono',monospace;font-size:9px;letter-spacing:1px;color:${roleColor[p.role]||'#9ca3af'}">${p.role}</div>
      </div>
      <div style="font-size:15px;font-weight:700">${p.name}</div>
      <div style="font-size:11px;color:var(--muted);margin-top:2px">${p.team}</div>
      <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-top:10px">
        <span class="tag tag-${p.tier}">${p.tier}</span>
        <span style="font-family:'Share Tech Mono',monospace;font-size:12px;color:var(--accent)">${p.price}M</span>
      </div>
      ${pts?`<div style="font-family:'Bebas Neue',sans-serif;font-size:20px;margin-top:6px">${pts}<small style="font-size:11px;color:var(--muted)"> pts MD${S.settings.curMD+1}</small></div>`:''}
    </div>`;
  }).join('')}
  </div>`;
}

// ===== INIT =====
const DEFAULT_PLAYERS=[
    {id:1,name:'koshmaras',team:'Team Heretics',role:'Controller',tier:'B',price:10},
    {id:2,name:'Wo0t',team:'Team Heretics',role:'Initiator',tier:'B',price:10},
    {id:3,name:'RieNs',team:'Team Heretics',role:'Duelist',tier:'A',price:16},
    {id:4,name:'benjyfishy',team:'Team Heretics',role:'Sentinel',tier:'A',price:16},
    {id:5,name:'Boo',team:'Team Heretics',role:'Controller',tier:'C',price:6},
    {id:6,name:'Jamppi',team:'Team Vitality',role:'Initiator',tier:'B',price:10},
    {id:7,name:'PROFEK',team:'Team Vitality',role:'Controller',tier:'C',price:6},
    {id:8,name:'Derke',team:'Team Vitality',role:'Duelist',tier:'S',price:24},
    {id:9,name:'Chronicle',team:'Team Vitality',role:'Sentinel',tier:'S',price:24},
    {id:10,name:'Sayonara',team:'Team Vitality',role:'Duelist',tier:'S',price:24},
    {id:11,name:'s0pp',team:'FUT Esports',role:'Duelist',tier:'B',price:10},
    {id:12,name:'xeus',team:'FUT Esports',role:'Initiator',tier:'C',price:6},
    {id:13,name:'yetujey',team:'FUT Esports',role:'Controller',tier:'C',price:6},
    {id:14,name:'KROSTALY',team:'FUT Esports',role:'Sentinel',tier:'C',price:6},
    {id:15,name:'sociablEE',team:'FUT Esports',role:'Initiator',tier:'C',price:6},
    {id:16,name:'kiNgg',team:'Leviatán',role:'Duelist',tier:'A',price:16},
    {id:17,name:'blowz',team:'Leviatán',role:'Initiator',tier:'B',price:10},
    {id:18,name:'Sato',team:'Leviatán',role:'Controller',tier:'B',price:10},
    {id:19,name:'spikeziN',team:'Leviatán',role:'Sentinel',tier:'B',price:10},
    {id:20,name:'Neon',team:'Leviatán',role:'Controller',tier:'S',price:24},
    {id:21,name:'BABYBAY',team:'G2 Esports',role:'Duelist',tier:'B',price:10},
    {id:22,name:'valyn',team:'G2 Esports',role:'Initiator',tier:'B',price:10},
    {id:23,name:'jawgemo',team:'G2 Esports',role:'Controller',tier:'A',price:16},
    {id:24,name:'leaf',team:'G2 Esports',role:'Sentinel',tier:'A',price:16},
    {id:25,name:'trent',team:'G2 Esports',role:'Initiator',tier:'S',price:24},
    {id:26,name:'Ethan',team:'NRG',role:'Initiator',tier:'A',price:16},
    {id:27,name:'keiko',team:'NRG',role:'Duelist',tier:'B',price:10},
    {id:28,name:'mada',team:'NRG',role:'Controller',tier:'B',price:10},
    {id:29,name:'skuba',team:'NRG',role:'Sentinel',tier:'B',price:10},
    {id:30,name:'brawk',team:'NRG',role:'Duelist',tier:'S',price:24},
    {id:31,name:'Jinggg',team:'Paper Rex',role:'Duelist',tier:'S',price:24},
    {id:32,name:'f0rsakeN',team:'Paper Rex',role:'Initiator',tier:'A',price:16},
    {id:33,name:'d4v41',team:'Paper Rex',role:'Controller',tier:'B',price:10},
    {id:34,name:'something',team:'Paper Rex',role:'Sentinel',tier:'S',price:24},
    {id:35,name:'invy',team:'Paper Rex',role:'Duelist',tier:'C',price:6},
    {id:36,name:'nobody',team:'EDward Gaming',role:'Duelist',tier:'B',price:10},
    {id:37,name:'ZmjjKK',team:'EDward Gaming',role:'Initiator',tier:'S',price:24},
    {id:38,name:'Smoggy',team:'EDward Gaming',role:'Controller',tier:'A',price:16},
    {id:39,name:'CHICHOO',team:'EDward Gaming',role:'Sentinel',tier:'A',price:16},
    {id:40,name:'cb',team:'EDward Gaming',role:'Initiator',tier:'C',price:6},
    {id:41,name:'WsLeo',team:'XLG Esports',role:'Duelist',tier:'B',price:10},
    {id:42,name:'Rarga',team:'XLG Esports',role:'Initiator',tier:'C',price:6},
    {id:43,name:'NoMan',team:'XLG Esports',role:'Controller',tier:'C',price:6},
    {id:44,name:'Lysoar',team:'XLG Esports',role:'Sentinel',tier:'C',price:6},
    {id:45,name:'happywei',team:'XLG Esports',role:'Duelist',tier:'S',price:24},
    {id:46,name:'vo0kashu',team:'Dragon Ranger Gaming',role:'Duelist',tier:'A',price:16},
    {id:47,name:'Life',team:'Dragon Ranger Gaming',role:'Initiator',tier:'C',price:6},
    {id:48,name:'Nicc',team:'Dragon Ranger Gaming',role:'Controller',tier:'C',price:6},
    {id:49,name:'SpiritZ1',team:'Dragon Ranger Gaming',role:'Sentinel',tier:'C',price:6},
    {id:50,name:'Flex1n',team:'Dragon Ranger Gaming',role:'Controller',tier:'C',price:6},
    {id:51,name:'PatMen',team:'Global Esports',role:'Duelist',tier:'B',price:10},
    {id:52,name:'Wronski',team:'Global Esports',role:'Initiator',tier:'C',price:6},
    {id:53,name:'AAAY',team:'Global Esports',role:'Controller',tier:'B',price:10},
    {id:54,name:'TChomps',team:'Global Esports',role:'Sentinel',tier:'C',price:6},
    {id:55,name:'stellar',team:'Global Esports',role:'Initiator',tier:'C',price:6},
    {id:56,name:'Crws',team:'FULL SENSE',role:'Duelist',tier:'A',price:16},
    {id:57,name:'JitboyS',team:'FULL SENSE',role:'Initiator',tier:'B',price:10},
    {id:58,name:'Primmie',team:'FULL SENSE',role:'Controller',tier:'S',price:24},
    {id:59,name:'Surf',team:'FULL SENSE',role:'Sentinel',tier:'C',price:6},
    {id:60,name:'ChAlalala',team:'FULL SENSE',role:'Initiator',tier:'C',price:6},
];

// ===== DB SETUP CHECK =====
const SETUP_SQL = `-- Run this once in your Supabase SQL Editor
CREATE TABLE IF NOT EXISTS valotasy_data (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE valotasy_data ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_access" ON valotasy_data FOR ALL USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS users (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_name TEXT NOT NULL UNIQUE,
  pin_hash     TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_access" ON users FOR ALL USING (true) WITH CHECK (true);`;

async function ensureDB(){
  const [r1, r2] = await Promise.all([
    sb.from('valotasy_data').select('key').limit(1),
    sb.from('users').select('id').limit(1)
  ]);
  if(!r1.error && !r2.error) return true;

  // One or both tables missing — show setup overlay
  const overlay = document.getElementById('dbSetupOverlay');
  if(overlay) overlay.classList.add('open');
  document.getElementById('lbBody').innerHTML =
    '<div style="text-align:center;padding:60px;color:var(--muted);font-size:12px;letter-spacing:1px">⚠️ Database not set up yet</div>';
  return false;
}

function copySetupSQL(){
  navigator.clipboard.writeText(SETUP_SQL).then(()=>toast('SQL copied ✓'));
}

async function init(){
  const dbReady = await ensureDB();
  if(!dbReady) return; // stop until DB is set up

  await load();

  // Force defaults
  if(!S.settings.budget||S.settings.budget<100) S.settings.budget=100;
  if(!S.settings.penalty||S.settings.penalty===10) S.settings.penalty=8;

  // Seed or patch players — only add missing, never overwrite admin edits
  if(!S.players.length){
    S.players=DEFAULT_PLAYERS;
    await save();
  } else {
    const existingIds=new Set(S.players.map(p=>p.id));
    const missing=DEFAULT_PLAYERS.filter(p=>!existingIds.has(p.id));
    if(missing.length){
      S.players=[...S.players,...missing];
      await save();
    }
  }

  // Try to restore session from localStorage (auto-login)
  await tryAutoLogin();

  // Subscribe to realtime updates
  subscribeRealtime();

  renderLB();
}

init();
