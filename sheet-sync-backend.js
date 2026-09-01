const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
let google = null;
try{
  ({ google } = require('googleapis'));
}catch(e){
  // googleapis is optional at runtime; backend falls back to CSV mode.
}

const PORT = Number(process.env.SHEET_SYNC_PORT || 8787);
const PROJECT_DIR = process.env.SHEET_SYNC_PROJECT_DIR || __dirname;
const CSV_PATH = path.join(PROJECT_DIR, 'pd-sheet.csv');
const WEBHOOK_SECRET = process.env.SHEET_SYNC_SECRET || '';
const POLL_MS = Number(process.env.SHEET_SYNC_POLL_MS || 15000);
const GOOGLE_CREDENTIALS_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS || '';
const SHEET_ID = process.env.SHEET_ID || '12wMk4KqtNY9gQRiWAKpo_O6DSQupgfxYrwZRxAkhYUw';
const SHEET_RANGE = process.env.SHEET_RANGE || 'A:Z';
const GOOGLE_SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const GOOGLE_DIRECTORY_SCOPE = 'https://www.googleapis.com/auth/admin.directory.user.readonly';
let syncInProgress = false;
const REQUIRED_FIELDS = [
  {key:'title', label:'Request Title'},
  {key:'appName', label:'Application'},
  {key:'productDesigner', label:'Product Designer'},
  {key:'productManager', label:'Product Manager'}
];

const state = {
  signature: '',
  lastSyncedAt: 0,
  lastChangedAt: 0,
  lastError: '',
  tasks: [],
  peopleDirectory: [],
  roleDirectory: {pd:[], pm:[], engineer:[]},
  source: 'local:pd-sheet.csv'
};

function normalizeCol(s){
  return String(s || '').replace(/\uFEFF/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
}
function findHeaderIndex(headers, aliases){
  const normalizedAliases = aliases.map(normalizeCol);
  for(let i=0;i<headers.length;i++){
    const h = normalizeCol(headers[i]);
    if(!h) continue;
    if(normalizedAliases.includes(h)) return i;
  }
  for(let i=0;i<headers.length;i++){
    const h = normalizeCol(headers[i]);
    if(!h || h.length < 3) continue;
    if(normalizedAliases.some(a=>a.length >= 3 && (h.includes(a) || a.includes(h)))) return i;
  }
  return -1;
}
function parseCsvRows(text){
  const rows = [];
  let row = [];
  let value = '';
  let inQuotes = false;
  for(let i=0;i<text.length;i++){
    const ch = text[i];
    if(ch === '"'){
      if(inQuotes && text[i+1] === '"'){
        value += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if(ch === ',' && !inQuotes){
      row.push(value);
      value = '';
      continue;
    }
    if((ch === '\n' || ch === '\r') && !inQuotes){
      if(ch === '\r' && text[i+1] === '\n') i++;
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
      continue;
    }
    value += ch;
  }
  if(value.length || row.length){
    row.push(value);
    rows.push(row);
  }
  return rows;
}
function extractSheetTable(rows){
  if(!Array.isArray(rows) || !rows.length) return {headers:[], dataRows:[], headerRowIdx:0};
  let headerRowIdx = -1;
  for(let i=0;i<rows.length;i++){
    const h = (rows[i]||[]).map(normalizeCol).filter(Boolean);
    const hasTitle = h.includes('request title') || h.includes('task name');
    const hasApp = h.includes('application') || h.includes('app name');
    if(hasTitle && hasApp){
      headerRowIdx = i;
      break;
    }
  }
  if(headerRowIdx<0){
    return {headers:(rows[0]||[]).map(normalizeCol), dataRows:rows.slice(1), headerRowIdx:0};
  }
  return {
    headers: (rows[headerRowIdx]||[]).map(normalizeCol),
    dataRows: rows.slice(headerRowIdx+1),
    headerRowIdx
  };
}
function toIsoDate(value){
  if(!value) return '';
  const raw = String(value).trim();
  if(!raw) return '';
  const gvizMatch = raw.match(/^Date\((\d{4}),\s*(\d{1,2}),\s*(\d{1,2})/);
  if(gvizMatch){
    const y = Number(gvizMatch[1]);
    const m = Number(gvizMatch[2]) + 1;
    const d = Number(gvizMatch[3]);
    return `${String(y).padStart(4,'0')}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  }
  if(/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const d = new Date(raw);
  if(isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function sheetTaskKey(title, appName){
  return `${String(title||'').trim().toLowerCase()}::${String(appName||'').trim().toLowerCase()}`;
}
function buildSignature(headers, dataRows){
  const headersPart = (headers||[]).join('\u241f');
  const rowsPart = (dataRows||[]).map(r=>(r||[]).map(c=>String(c||'').trim()).join('\u241f')).join('\u241e');
  return headersPart + '\u241d' + rowsPart;
}
function missingRequiredFields(taskLike){
  return REQUIRED_FIELDS
    .filter(f=>!String(taskLike[f.key] || '').trim())
    .map(f=>f.label);
}
function normalizeEmail(email){
  return String(email||'').trim().toLowerCase();
}
function mergePerson(map, profile){
  const email = normalizeEmail(profile && profile.email);
  if(!email) return;
  const current = map.get(email) || {email, name:'', image:''};
  const nextName = String(profile && profile.name || '').trim();
  const nextImage = String(profile && profile.image || '').trim();
  if(nextName) current.name = nextName;
  if(nextImage) current.image = nextImage;
  map.set(email, current);
}
async function enrichPeopleDirectoryFromGoogle(peopleDirectory, authClient){
  if(!google || !authClient || !Array.isArray(peopleDirectory) || peopleDirectory.length===0) return peopleDirectory || [];
  try{
    const admin = google.admin({version:'directory_v1', auth: authClient});
    for(const person of peopleDirectory){
      const email = normalizeEmail(person && person.email);
      if(!email) continue;
      try{
        const resp = await admin.users.get({userKey: email, projection:'basic', viewType:'domain_public'});
        const user = resp && resp.data ? resp.data : {};
        const fullName = String(user?.name?.fullName || '').trim();
        const thumb = String(user?.thumbnailPhotoUrl || '').trim();
        if(fullName) person.name = fullName;
        if(thumb) person.image = thumb;
      }catch(_err){
        // best effort; keep original chip-derived data when directory lookup fails
      }
    }
  }catch(_err){
    return peopleDirectory;
  }
  return peopleDirectory;
}
function userPrimaryTitle(user){
  const org = Array.isArray(user?.organizations) ? user.organizations.find(o=>o?.primary) || user.organizations[0] : null;
  return String(org?.title || '').trim();
}
function classifyRoleFromTitle(title){
  const t = String(title||'').toLowerCase();
  if(!t) return '';
  if(t.includes('product designer')) return 'pd';
  if(t.includes('product manager')) return 'pm';
  if(t.includes('engineer')) return 'engineer';
  return '';
}
async function fetchRoleDirectoryFromGoogle(authClient){
  const empty = {pd:[], pm:[], engineer:[]};
  if(!google || !authClient) return empty;
  try{
    const admin = google.admin({version:'directory_v1', auth: authClient});
    const byRole = {pd:new Map(), pm:new Map(), engineer:new Map()};
    let pageToken = '';
    for(let i=0;i<8;i++){
      const resp = await admin.users.list({
        customer: 'my_customer',
        maxResults: 500,
        orderBy: 'email',
        pageToken: pageToken || undefined,
        projection: 'full',
        viewType: 'domain_public',
        query: 'isSuspended=false'
      });
      const users = Array.isArray(resp?.data?.users) ? resp.data.users : [];
      users.forEach(user=>{
        const email = normalizeEmail(user?.primaryEmail || '');
        if(!email || !email.endsWith('@totersapp.com')) return;
        const title = userPrimaryTitle(user);
        const role = classifyRoleFromTitle(title);
        if(!role) return;
        const name = String(user?.name?.fullName || '').trim() || email;
        const image = String(user?.thumbnailPhotoUrl || '').trim();
        byRole[role].set(email, {email, name, image, title});
      });
      pageToken = String(resp?.data?.nextPageToken || '');
      if(!pageToken) break;
    }
    return {
      pd: [...byRole.pd.values()],
      pm: [...byRole.pm.values()],
      engineer: [...byRole.engineer.values()]
    };
  }catch(_err){
    return empty;
  }
}
function splitChipNamesFromText(text){
  return String(text||'')
    .split(/[,،\n]+/)
    .map(s=>s.trim())
    .filter(Boolean);
}
function extractPersonChips(cell){
  if(!cell || !Array.isArray(cell.chipRuns)) return [];
  const people = [];
  cell.chipRuns.forEach(run=>{
    const email = normalizeEmail(
      run?.chip?.personProperties?.email ||
      run?.chip?.person?.email ||
      run?.personProperties?.email ||
      run?.person?.email ||
      ''
    );
    if(!email) return;
    const name = String(
      run?.chip?.personProperties?.displayName ||
      run?.chip?.personProperties?.name ||
      run?.chip?.person?.displayName ||
      run?.chip?.person?.name ||
      run?.chip?.displayName ||
      ''
    ).trim();
    const image = String(
      run?.chip?.personProperties?.photoUri ||
      run?.chip?.personProperties?.avatarUri ||
      run?.chip?.person?.photoUri ||
      run?.chip?.person?.avatarUri ||
      run?.chip?.person?.imageUri ||
      ''
    ).trim();
    people.push({email, name, image});
  });
  const byEmail = new Map();
  people.forEach(p=>mergePerson(byEmail, p));
  return [...byEmail.values()];
}
function getPeopleCellData(cols, rowCells, idx){
  const textValue = ((idx>=0 ? cols[idx] : '') || '').trim();
  if(!rowCells || idx<0) return {value:textValue, people:[]};
  const chipPeople = extractPersonChips(rowCells[idx]);
  if(chipPeople.length){
    const fallbackNames = splitChipNamesFromText(textValue);
    chipPeople.forEach((p, i)=>{
      if(!p.name && fallbackNames[i]) p.name = fallbackNames[i];
    });
    return {value: chipPeople.map(p=>p.email).join(', '), people: chipPeople};
  }
  return {value:textValue, people:[]};
}

function mapTasksFromTable(table, dataCellRows){
  const headers = table.headers;
  const idxTitle = findHeaderIndex(headers, ['Request Title', 'Task Name', 'Title']);
  const idxApp = findHeaderIndex(headers, ['Application', 'App Name', 'App']);
  const idxStart = findHeaderIndex(headers, ['Expected Start Time', 'Expected Start Date', 'Start Date']);
  const idxDeadline = findHeaderIndex(headers, ['Expected Deadline', 'Expected Due Date', 'Deadline', 'Due Date']);
  const idxPd = findHeaderIndex(headers, ['Product Designer', 'Designer', 'PD']);
  const idxPm = findHeaderIndex(headers, ['Product Manager', 'PM', 'PM Name', 'Product Manager Email']);
  const idxNotes = findHeaderIndex(headers, ['Notes', 'Task Notes', 'Description']);
  if(idxTitle<0 || idxApp<0){
    throw new Error(`CSV_HEADERS_INVALID: ${headers.join(', ')}`);
  }
  const nextTasks = [];
  const peopleByEmail = new Map();
  table.dataRows.forEach((cols, rowIdx)=>{
    const rowCells = Array.isArray(dataCellRows) ? (dataCellRows[rowIdx] || []) : null;
    const titleRaw = (cols[idxTitle]||'').trim();
    const appNameRaw = (cols[idxApp]||'').trim();
    if(!titleRaw && !appNameRaw) return;
    const title = titleRaw || '(Missing Request Title)';
    const appName = appNameRaw || '--';
    const designerCell = getPeopleCellData(cols, rowCells, idxPd);
    const managerCell = getPeopleCellData(cols, rowCells, idxPm);
    designerCell.people.forEach(p=>mergePerson(peopleByEmail, p));
    managerCell.people.forEach(p=>mergePerson(peopleByEmail, p));
    const productDesignerRaw = designerCell.value;
    const productManagerRaw = managerCell.value;
    const notesRaw = ((idxNotes>=0 ? cols[idxNotes] : '') || '').trim();
    const startDate = toIsoDate(idxStart>=0 ? cols[idxStart] : '');
    const estDate = toIsoDate(idxDeadline>=0 ? cols[idxDeadline] : '');
    const reqMissing = missingRequiredFields({
      title: titleRaw,
      appName: appNameRaw,
      productDesigner: productDesignerRaw,
      productManager: productManagerRaw,
      startDate,
      estDate
    });
    const rowKey = `row-${rowIdx+1}::${sheetTaskKey(title, appName)}`;
    nextTasks.push({
      sheetKey: rowKey,
      title,
      appName,
      productDesigner: productDesignerRaw,
      productManager: productManagerRaw,
      engineers: '',
      notes: notesRaw,
      addedBy: 'google_sheet',
      added_by: 'google_sheet',
      assignee: productDesignerRaw || 'Unassigned',
      startDate,
      estDate,
      missingRequiredFields: reqMissing
    });
  });
  const nextSignature = buildSignature(
    ['sheetKey','title','appName','productDesigner','productManager','notes','added_by','startDate','estDate'],
    nextTasks.map(t=>[t.sheetKey,t.title,t.appName,t.productDesigner,t.productManager,t.notes||'',t.addedBy||'google_sheet',t.startDate,t.estDate])
  );
  return {nextSignature, nextTasks, peopleDirectory:[...peopleByEmail.values()]};
}
function applyTaskSnapshot(nextSignature, nextTasks, peopleDirectory, roleDirectory, source){
  const nextPeople = Array.isArray(peopleDirectory) ? peopleDirectory : [];
  const nextRoles = roleDirectory && typeof roleDirectory==='object'
    ? {pd: Array.isArray(roleDirectory.pd)?roleDirectory.pd:[], pm: Array.isArray(roleDirectory.pm)?roleDirectory.pm:[], engineer: Array.isArray(roleDirectory.engineer)?roleDirectory.engineer:[]}
    : {pd:[], pm:[], engineer:[]};
  const peopleSignature = JSON.stringify(nextPeople.map(p=>[normalizeEmail(p.email), String(p.name||''), String(p.image||'')]));
  const prevPeopleSignature = JSON.stringify((state.peopleDirectory||[]).map(p=>[normalizeEmail(p.email), String(p.name||''), String(p.image||'')]));
  const roleSignature = JSON.stringify([nextRoles.pd, nextRoles.pm, nextRoles.engineer].map(arr=>arr.map(p=>[normalizeEmail(p.email), String(p.name||''), String(p.title||''), String(p.image||'')])));
  const prevRoleSignature = JSON.stringify([state.roleDirectory?.pd||[], state.roleDirectory?.pm||[], state.roleDirectory?.engineer||[]].map(arr=>arr.map(p=>[normalizeEmail(p.email), String(p.name||''), String(p.title||''), String(p.image||'')])));
  const changed = nextSignature !== state.signature || peopleSignature !== prevPeopleSignature || roleSignature !== prevRoleSignature;
  state.signature = nextSignature;
  state.lastSyncedAt = Date.now();
  if(changed) state.lastChangedAt = state.lastSyncedAt;
  state.lastError = '';
  state.tasks = nextTasks;
  state.peopleDirectory = nextPeople;
  state.roleDirectory = nextRoles;
  state.source = source;
  return {changed, count: nextTasks.length};
}
function syncFromCsv(){
  if(!fs.existsSync(CSV_PATH)){
    throw new Error(`CSV_NOT_FOUND:${CSV_PATH}`);
  }
  const csv = fs.readFileSync(CSV_PATH, 'utf8');
  const rows = parseCsvRows(csv);
  const table = extractSheetTable(rows);
  const {nextSignature, nextTasks, peopleDirectory} = mapTasksFromTable(table);
  return applyTaskSnapshot(nextSignature, nextTasks, peopleDirectory, state.roleDirectory || {pd:[], pm:[], engineer:[]}, 'local:pd-sheet.csv');
}
async function syncFromGoogleSheets(){
  if(!google) throw new Error('GOOGLEAPIS_NOT_INSTALLED');
  if(!GOOGLE_CREDENTIALS_PATH) throw new Error('GOOGLE_CREDENTIALS_NOT_SET');
  if(!fs.existsSync(GOOGLE_CREDENTIALS_PATH)) throw new Error(`GOOGLE_CREDENTIALS_NOT_FOUND:${GOOGLE_CREDENTIALS_PATH}`);
  const auth = new google.auth.GoogleAuth({
    keyFile: GOOGLE_CREDENTIALS_PATH,
    scopes: [GOOGLE_SHEETS_SCOPE, GOOGLE_DIRECTORY_SCOPE]
  });
  const client = await auth.getClient();
  const sheets = google.sheets({version:'v4', auth: client});
  const resp = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID,
    ranges: [SHEET_RANGE],
    includeGridData: true,
    fields: 'sheets(data(rowData(values(formattedValue,effectiveValue,chipRuns))))'
  });
  const rowData =
    resp?.data?.sheets?.[0]?.data?.[0]?.rowData && Array.isArray(resp.data.sheets[0].data[0].rowData)
      ? resp.data.sheets[0].data[0].rowData
      : [];
  const cellRows = rowData.map(r=>Array.isArray(r.values) ? r.values : []);
  const rows = cellRows.map(cells=>cells.map(cell=>{
    if(typeof cell?.formattedValue === 'string') return cell.formattedValue;
    const ev = cell?.effectiveValue || {};
    if(typeof ev.stringValue === 'string') return ev.stringValue;
    if(typeof ev.numberValue === 'number') return String(ev.numberValue);
    if(typeof ev.boolValue === 'boolean') return ev.boolValue ? 'TRUE' : 'FALSE';
    return '';
  }));
  const table = extractSheetTable(rows);
  const dataCellRows = cellRows.slice((table.headerRowIdx||0)+1);
  const {nextSignature, nextTasks, peopleDirectory} = mapTasksFromTable(table, dataCellRows);
  const enrichedPeople = await enrichPeopleDirectoryFromGoogle(peopleDirectory, client);
  const roleDirectory = await fetchRoleDirectoryFromGoogle(client);
  return applyTaskSnapshot(nextSignature, nextTasks, enrichedPeople, roleDirectory, `google-sheets:${SHEET_ID}`);
}
async function syncFromSource(){
  if(google && GOOGLE_CREDENTIALS_PATH){
    try{
      return await syncFromGoogleSheets();
    }catch(err){
      // Fall back to CSV mode if Google sync is misconfigured or temporarily failing.
      state.lastError = `GOOGLE_SYNC_FAILED:${String(err && err.message || err)}`;
      return syncFromCsv();
    }
  }
  return syncFromCsv();
}

function json(res, code, data){
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

function readBody(req){
  return new Promise(resolve=>{
    let s = '';
    req.on('data', chunk=>{ s += chunk; });
    req.on('end', ()=>resolve(s));
    req.on('error', ()=>resolve(''));
  });
}

async function handler(req, res){
  if(req.method === 'OPTIONS'){
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if(req.method === 'GET' && url.pathname === '/health'){
    json(res, 200, {ok:true, service:'sheet-sync-backend'});
    return;
  }
  if(req.method === 'GET' && url.pathname === '/api/pd-sheet/status'){
    json(res, 200, {
      ok: !state.lastError,
      lastSyncedAt: state.lastSyncedAt,
      lastChangedAt: state.lastChangedAt,
      lastError: state.lastError,
      count: state.tasks.length,
      source: state.source
    });
    return;
  }
  if(req.method === 'GET' && url.pathname === '/api/pd-sheet/tasks'){
    json(res, 200, {tasks: state.tasks, peopleDirectory: state.peopleDirectory, roleDirectory: state.roleDirectory, lastSyncedAt: state.lastSyncedAt, lastChangedAt: state.lastChangedAt});
    return;
  }
  if(req.method === 'POST' && (url.pathname === '/api/pd-sheet/sync' || url.pathname === '/api/pd-sheet/webhook')){
    if(url.pathname.endsWith('/webhook') && WEBHOOK_SECRET){
      const auth = req.headers['x-sync-secret'] || '';
      if(auth !== WEBHOOK_SECRET){
        json(res, 401, {ok:false, error:'unauthorized'});
        return;
      }
    }
    await readBody(req);
    try{
      const result = await syncFromSource();
      json(res, 200, {ok:true, ...result, count: state.tasks.length, lastSyncedAt: state.lastSyncedAt});
    }catch(err){
      state.lastError = String(err && err.message || err);
      json(res, 500, {ok:false, error: state.lastError});
    }
    return;
  }
  json(res, 404, {ok:false, error:'not_found'});
}

async function runSyncTick(){
  if(syncInProgress) return;
  syncInProgress = true;
  try{
    await syncFromSource();
  }catch(err){
    state.lastError = String(err && err.message || err);
  }finally{
    syncInProgress = false;
  }
}

runSyncTick();
setInterval(()=>{ runSyncTick(); }, POLL_MS);

http.createServer((req, res)=>{
  handler(req, res).catch(err=>{
    json(res, 500, {ok:false, error:String(err && err.message || err)});
  });
}).listen(PORT, ()=>{
  console.log(`[sheet-sync-backend] running on http://localhost:${PORT}`);
  console.log(`[sheet-sync-backend] watching ${CSV_PATH}`);
});

