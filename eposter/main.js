// ──────────────────────────────────────────────────────────────────
//  CONSTANTS & GLOBALS
// ──────────────────────────────────────────────────────────────────
const REGION_COL={'Africa':'#ffaa44','Asia':'#ff5f5f','Australia and New Zeland':'#22e8e8','Canada and EUA':'#22cc88','Eastern Mediterranean':'#dd55ee','Europe':'#5b9fff','Latin America':'#ffdd33','Unknown':'#4e6280'};
const THEME_COL={"Music Therapy Community": "#8899aa", "Professionals": "#44aaff", "Older Adults": "#ffaa55", "Children/Pediatric": "#66ccff", "Mental Health": "#ff88aa", "Oncology/Medical": "#ff6666", "Autism/ASD": "#ff6ba8", "COVID-19": "#ff8833", "NICU/Neonatal": "#66ee88", "Neurology": "#cc66ff", "Palliative": "#9966ff", "Adolescents": "#ffe048", "Trauma": "#ff4455", "Adults": "#aaee44", "Other": "#556677", "Disability": "#aa88ff", "Telehealth": "#33ddaa", "Families": "#55eebb"};
const COUNT_COL=d3.scaleSequential(d3.interpolateYlOrRd).domain([1,9]);

let colorMode='region',activeTab='globe',paused=false;
let minEdge=1,minNode=1;
// Network graph parameters (controlled via net-ctrl-panel sliders)
let netNodeSizeMult=2.0, netLinkDist=30, netCharge=45;
let netLinkWidth=1.0, netLinkColorMode='weight'; // 'weight' | 'node'
let activeRegions=new Set(GRAPH_DATA.regions);
let activeThemes=new Set(GRAPH_DATA.themes);
let sim=null,d3svg,gLinks,gNodes;

// Three.js (Disabled)
let renderer,scene,camera,globeGroup,animId;
let isDragging=false,prevMouse={x:0,y:0},rotVel={x:0,y:0};
let raycaster,mouse3d,nodeMeshes=[];
const GLOBE_R=1.9;

// Override de páginas para artigos cujo título duplicado impede lookup correto no ARTICLE_PAGE_MAP
// (ARTICLE_PAGE_MAP é title→page; se dois artigos têm o mesmo título, apenas uma página é armazenada)
// Art.108 vizinhos: art.107→p.254, art.109→p.259 → estimativa: p.256
// ⚠ Confirme a página real do artigo 108 no PDF e atualize aqui se necessário
const ARTICLE_PAGE_OVERRIDE = {
  108: 256
};

// Rebuild articles for each node from ARTICLES_DATA (authoritative source)
// Garante que todos os artigos aparecem mesmo se data.js tiver arrays truncados
// Inclui 'num' no objeto de artigo para lookups precisos (evita colisão por título duplicado/trailing space)
(function(){
  const authorArticlesMap = new Map();
  ARTICLES_DATA.forEach(a => {
    const cleanTitle = a.titulo.trim();
    (a.autores||[]).forEach(author => {
      if(!authorArticlesMap.has(author)) authorArticlesMap.set(author, []);
      authorArticlesMap.get(author).push({
        title: cleanTitle,
        num: a.num,
        theme: a.tema,
        design: a.design,
        page: ARTICLE_PAGE_OVERRIDE[a.num] || ARTICLE_PAGE_MAP[a.titulo] || ARTICLE_PAGE_MAP[cleanTitle] || null
      });
    });
  });
  GRAPH_DATA.nodes.forEach(n => {
    const arts = authorArticlesMap.get(n.id);
    if(arts) {
      n.articles = arts;
      n.count = arts.length;
    }
  });
})();

// Node map
const NODE_MAP=new Map(GRAPH_DATA.nodes.map(n=>[n.id,n]));

// ── Country normalization ──
// Many articles list country variants (USA, United States, EUA, US, etc.)
// Normalize them to canonical names used in our data / ISO table
const COUNTRY_ALIASES = {
  'usa':'United States of America','us':'United States of America',
  'eua':'United States of America','united states':'United States of America',
  'u.s.a.':'United States of America','u.s.':'United States of America',
  'united states of america':'United States of America',
  'uk':'United Kingdom','u.k.':'United Kingdom',
  'united kingdom':'United Kingdom','england':'United Kingdom',
  'scotland':'United Kingdom','wales':'United Kingdom',
  'great britain':'United Kingdom',
  'new zealand':'New Zealand','new zeland':'New Zealand',
  'aotearoa new zealand':'New Zealand','aotearoa':'New Zealand',
  'republic of korea':'South Korea','korea':'South Korea',
  'south korea':'South Korea',
  'malasya':'Malaysia','malasia':'Malaysia',
  'brasil':'Brazil',
  'mozambique':'Mozambique',
  'bermuda':'Bermuda',
};
function normalizeCountry(c){
  if(!c) return c;
  const key = c.trim().toLowerCase();
  return COUNTRY_ALIASES[key] || c.trim();
}

// Normalize country field on all nodes once
GRAPH_DATA.nodes.forEach(n=>{ if(n.country) n.country = normalizeCountry(n.country); });

// Build first-author lookup: articleNum -> firstAuthor
// Usar num (não título) evita: (1) trailing spaces no título, (2) títulos duplicados sobrescreverem entrada
const FIRST_AUTHOR_MAP = new Map();
ARTICLES_DATA.forEach(a => {
  if(a.autores && a.autores.length > 0) FIRST_AUTHOR_MAP.set(a.num, a.autores[0]);
});

// Table state
const TS={
  authors:{data:[],filtered:[],sortCol:'count',sortDir:-1},
  articles:{data:[],filtered:[],sortCol:'num',sortDir:1},
  edges:{data:[],filtered:[],sortCol:'weight',sortDir:-1}
};

// ──────────────────────────────────────────────────────────────────
//  HELPERS
// ──────────────────────────────────────────────────────────────────
function getColor(d){
  if(colorMode==='region')return REGION_COL[d.region]||'#4e6280';
  if(colorMode==='theme')return THEME_COL[d.theme]||'#4e6280';
  return COUNT_COL(Math.min(d.count,9));
}
// Precompute sole authors and direct edges
const SOLE_AUTHORS=new Set();
ARTICLES_DATA.forEach(a=>{if(a.num_autores===1)SOLE_AUTHORS.add(a.autores[0]);});

// "Same paper only" = STAR topology: first author ↔ each co-author.
// Co-authors never connect to each other; solo authors appear as isolated nodes.
const SAME_PAPER_EDGES_MAP=new Map();
ARTICLES_DATA.forEach(a=>{
  const au=a.autores;
  if(au.length<2) return; // solo author → isolated node, no edge
  const first=au[0];
  for(let i=1;i<au.length;i++){
    const co=au[i];
    const key=[first,co].sort().join('|||');
    const cur=SAME_PAPER_EDGES_MAP.get(key);
    if(cur) cur.weight++;
    else{const p=[first,co].sort();SAME_PAPER_EDGES_MAP.set(key,{source:p[0],target:p[1],weight:1});}
  }
});
const SAME_PAPER_EDGES=Array.from(SAME_PAPER_EDGES_MAP.values());

let directOnly=true;

function nodeR(n){
  const c=typeof n==='object'?n.count:n;
  const base=2+Math.sqrt(c)*1.9;
  if(typeof n==='object'&&!SOLE_AUTHORS.has(n.id)) return base*0.62;
  return base;
}
function hex2three(h){return new THREE.Color(parseInt(h.slice(1,3),16)/255,parseInt(h.slice(3,5),16)/255,parseInt(h.slice(5,7),16)/255);}
function latLon(lat,lon,r){
  const phi=(90-lat)*Math.PI/180,theta=(lon+180)*Math.PI/180;
  return new THREE.Vector3(-r*Math.sin(phi)*Math.cos(theta),r*Math.cos(phi),r*Math.sin(phi)*Math.sin(theta));
}
function slugify(s){return encodeURIComponent(s.replace(/\s+/g,'_'));}

function filteredData(){
  const nodes=GRAPH_DATA.nodes.filter(n=>activeRegions.has(n.region)&&activeThemes.has(n.theme)&&n.count>=minNode);
  const nids=new Set(nodes.map(n=>n.id));
  const edgePool=directOnly
    ? SAME_PAPER_EDGES.filter(e=>e.weight>=minEdge&&nids.has(e.source)&&nids.has(e.target))
    : GRAPH_DATA.edges.filter(e=>e.weight>=minEdge&&nids.has(e.source)&&nids.has(e.target));
  if(directOnly){
    // Include ALL filtered nodes (solo authors appear as isolated dots)
    return{nodes,edges:edgePool};
  }
  if(minEdge>1){
    const c=new Set();edgePool.forEach(e=>{c.add(e.source);c.add(e.target);});
    return{nodes:nodes.filter(n=>c.has(n.id)),edges:edgePool};
  }
  return{nodes,edges:edgePool};
}

// ──────────────────────────────────────────────────────────────────
//  FILTERS & LEGEND
// ──────────────────────────────────────────────────────────────────
function buildFilters(){
  const rc={};GRAPH_DATA.nodes.forEach(n=>{rc[n.region]=(rc[n.region]||0)+1;});
  document.getElementById('region-chips').innerHTML=Object.entries(rc).sort((a,b)=>b[1]-a[1]).map(([r,c])=>`<div class="chip" onclick="toggleFilt('region','${r}')"><div class="chip-dot" style="background:${REGION_COL[r]||'#4e6280'}"></div><span class="chip-lbl">${r}</span><span class="chip-n">${c}</span><div class="chip-box on" id="fc-r-${r.replace(/\W/g,'_')}"></div></div>`).join('');
  const tc={};GRAPH_DATA.nodes.forEach(n=>{tc[n.theme]=(tc[n.theme]||0)+1;});
  document.getElementById('theme-chips').innerHTML=Object.entries(tc).sort((a,b)=>b[1]-a[1]).map(([t,c])=>`<div class="chip" onclick="toggleFilt('theme','${t.replace(/'/g,"\\'")}')"><div class="chip-dot" style="background:${THEME_COL[t]||'#4e6280'}"></div><span class="chip-lbl">${t}</span><span class="chip-n">${c}</span><div class="chip-box on" id="fc-t-${t.replace(/\W/g,'_')}"></div></div>`).join('');
  buildLegend();
  initTableData();
  // Set btn-direct active since directOnly starts true
  const btnD=document.getElementById('btn-direct');
  if(btnD) btnD.classList.add('on');
  // Populate country select
  const countrySelectEl = document.getElementById('country-select');
  if(countrySelectEl){
    const countryData = {};
    GRAPH_DATA.nodes.forEach(n => {
      const c = normalizeCountry(n.country||'Unknown');
      if(c === 'Unknown' || c === 'Multiple') return;
      if(!countryData[c]) countryData[c] = {articleNums: new Set()};
      (n.articles||[]).forEach(a => countryData[c].articleNums.add(a.num ?? a.title));
    });
    const sorted = Object.entries(countryData).sort((a,b) => b[1].articleNums.size - a[1].articleNums.size);
    countrySelectEl.innerHTML = '<option value="">— Todos os países —</option>' +
      sorted.map(([k,v]) => `<option value="${k}">${k} (${v.articleNums.size})</option>`).join('');
  }
  // Check URL hash on load
  const hash=window.location.hash.slice(1);
  if(hash){
    if(hash.startsWith('pais_')){
      const cname=decodeURIComponent(hash.slice(5).replace(/_/g,' '));
      setTimeout(()=>filterByCountry(cname),1000);
    } else {
      const id=decodeURIComponent(hash.replace(/_/g,' '));const n=NODE_MAP.get(id);if(n)setTimeout(()=>openCard(n),1000);
    }
  }
}

function toggleFilt(type,val){
  const set=type==='region'?activeRegions:activeThemes;
  const id='fc-'+(type==='region'?'r':'t')+'-'+val.replace(/\W/g,'_');
  const el=document.getElementById(id);
  if(set.has(val)){set.delete(val);el&&el.classList.remove('on');}
  else{set.add(val);el&&el.classList.add('on');}
  onFilt();
}

function setColor(m){
  colorMode=m;
  ['region','theme','count'].forEach(x=>document.getElementById('cp-'+x).classList.toggle('on',m===x));
  document.getElementById('sec-region').style.display=m==='region'?'':'none';
  document.getElementById('sec-theme').style.display=m==='theme'?'':'none';
  buildLegend();refreshView();
}

function buildLegend(){
  const w=document.getElementById('leg-items');
  if(colorMode==='region')w.innerHTML=Object.entries(REGION_COL).map(([k,c])=>`<div class="leg-row" style="opacity:${activeRegions.has(k)?1:.2}"><div class="leg-dot" style="width:7px;height:7px;background:${c}"></div><span class="leg-lbl">${k}</span></div>`).join('');
  else if(colorMode==='theme')w.innerHTML=Object.entries(THEME_COL).map(([k,c])=>`<div class="leg-row" style="opacity:${activeThemes.has(k)?1:.2}"><div class="leg-dot" style="width:7px;height:7px;background:${c}"></div><span class="leg-lbl">${k}</span></div>`).join('');
  else w.innerHTML='<div class="leg-lbl" style="font-size:.63rem;color:var(--dim)">Amarelo→Vermelho = mais artigos</div>';
}

function toggleDirectOnly(){
  directOnly=!directOnly;
  const btn=document.getElementById('btn-direct');
  btn.classList.toggle('on',directOnly);
  onFilt();
}

function onFilt(){
  minEdge=+document.getElementById('sl-me').value;
  minNode=+document.getElementById('sl-mn').value;
  document.getElementById('v-me').textContent=minEdge;
  document.getElementById('v-mn').textContent=minNode;
  const{nodes,edges}=filteredData();
  document.getElementById('s-nodes').textContent=nodes.length;
  document.getElementById('s-edges').textContent=edges.length;
  buildLegend();refreshView();
}

function refreshView(){
  if(activeTab==='globe'){buildMap2D();}
  else if(activeTab==='net')initD3Net();
  else if(activeTab==='regions')initD3Bar('region');
  else if(activeTab==='themes')initD3Bar('theme');
  else renderTable(activeTab);
}

// ── Network live parameter update ──
function updateNetParam(param, val){
  const svgEl = document.getElementById('d3svg');
  if(param==='nsize'){
    netNodeSizeMult=val;
    document.getElementById('v-nsize').textContent=val.toFixed(1)+'×';
    if(gNodes){
      gNodes.attr('r',d=>nodeR(d)*netNodeSizeMult);
      if(svgEl?.__netSim){
        svgEl.__netSim.force('collision',d3.forceCollide(d=>nodeR(d)*netNodeSizeMult+1.5));
        svgEl.__netSim.alpha(0.2).restart();
      }
    }
  } else if(param==='ldist'){
    netLinkDist=val;
    document.getElementById('v-ldist').textContent=val;
    if(svgEl?.__netSim){
      svgEl.__netSim.force('link').distance(val);
      svgEl.__netSim.alpha(0.4).restart();
    }
  } else if(param==='charge'){
    netCharge=val;
    document.getElementById('v-charge').textContent=val;
    if(svgEl?.__netSim){
      svgEl.__netSim.force('charge',d3.forceManyBody().strength(-val));
      svgEl.__netSim.alpha(0.4).restart();
    }
  } else if(param==='lwidth'){
    netLinkWidth=val;
    document.getElementById('v-lwidth').textContent=val.toFixed(1)+'×';
    if(gLinks) gLinks.attr('stroke-width',d=>netLinkW(d));
  } else if(param==='lcolor'){
    netLinkColorMode = netLinkColorMode==='node' ? 'weight' : 'node';
    const btn=document.getElementById('btn-lcolor');
    if(btn) btn.textContent = netLinkColorMode==='node' ? '🎨 Link: Cor do nó' : '⚪ Link: Padrão';
    if(gLinks){
      gLinks.attr('stroke',d=>netLinkStroke(d)).attr('stroke-opacity',d=>netLinkOpacity(d));
    }
  }
}

function netFitView(){
  const svgEl = document.getElementById('d3svg');
  if(svgEl?.__netFit) svgEl.__netFit();
}

// Pan + flash-highlight a node in the network graph by id
function focusNetNode(id){
  const svgEl=document.getElementById('d3svg');
  if(!svgEl||!gNodes) return;
  const nodesCopy=svgEl.__netNodes;
  const z=svgEl.__netZoom;
  const netR=svgEl.__netR;
  if(!nodesCopy||!z) return;
  const nd=nodesCopy.find(n=>n.id===id);
  if(!nd||nd.x==null) return;
  const W=svgEl.clientWidth,H=svgEl.clientHeight;
  const sc=2.8;
  d3.select('#d3svg').transition().duration(650)
    .call(z.transform,d3.zoomIdentity.translate(W/2-sc*nd.x,H/2-sc*nd.y).scale(sc));
  // Flash ring around the node
  gNodes.filter(d=>d.id===id)
    .transition().duration(120).attr('r',d=>(netR||((x)=>x.count||1))(d)*3.5)
      .attr('stroke','#ffdd44').attr('stroke-width',3.5)
    .transition().duration(900).attr('r',d=>(netR||((x)=>x.count||1))(d)*2.2)
      .attr('stroke','#5b9fff').attr('stroke-width',2);
}

// Search dropdown: open card + highlight node if on network tab
function selectAuthor(id){
  const n=NODE_MAP.get(id);
  openCard(n);
  if(activeTab==='net') setTimeout(()=>focusNetNode(id),60);
  document.getElementById('srch-drop').style.display='none';
  document.getElementById('srch-in').value='';
}

function switchTab(t){
  activeTab=t;
  if(t!=='globe') closeSidebarCard();
  ['globe','net','regions','themes','authors','articles','edges'].forEach(x=>document.getElementById('tab-'+x).classList.toggle('on',x===t));
  
  const map2d = document.getElementById('map2d-wrap');
  if(t==='globe') {
    map2d.style.display = 'block';
    map2d.classList.add('active');
    buildMap2D();
  } else {
    map2d.style.display = 'none';
    map2d.classList.remove('active');
  }

  const d3w=document.getElementById('d3-wrap');
  const d3Active=t==='net'||t==='regions'||t==='themes';
  d3w.style.display=d3Active?'block':'none';
  d3w.classList.toggle('active',d3Active);
  ['authors','articles','edges'].forEach(x=>{const el=document.getElementById('tbl-'+x);if(el)el.classList.toggle('active',t===x);});
  const ST={globe:'🌍 Mapa 2D · Clique para abrir card do participante',net:'🔗 Arraste nós · scroll zoom · clique para detalhes',regions:'🗺 Colaborações por região',themes:'🎯 Colaborações por tema',authors:'👤 Tabela de autores',articles:'📄 Tabela de artigos',edges:'🔗 Tabela source–target'};
  document.getElementById('status-txt').textContent=ST[t]||'';
  
  const netCtrl=document.getElementById('net-ctrl-panel');
  if(netCtrl) netCtrl.style.display=t==='net'?'flex':'none';

  if(t==='net')initD3Net();
  else if(t==='regions')initD3Bar('region');
  else if(t==='themes')initD3Bar('theme');
  else if(['authors','articles','edges'].includes(t))renderTable(t);
}

// ──────────────────────────────────────────────────────────────────
//  PARTICIPANT CARD
// ──────────────────────────────────────────────────────────────────
function openCard(n, initialPage){
  if(!n)return;
  // Redirect to sidebar if on globe/map tab, unless a specific page was requested
  if(activeTab==='globe' && !initialPage){showSidebarCard(n);return;}
  const slug=slugify(n.id);
  history.pushState(null,'','#'+slug);

  // Header
  document.getElementById('pc-name').textContent=n.id;
  const regionColor=REGION_COL[n.region]||'#4e6280';
  const themeColor=THEME_COL[n.theme]||'#4e6280';
  document.getElementById('pc-meta').innerHTML=
    `<span class="pcard-tag" style="color:${regionColor};border-color:${regionColor}33;background:${regionColor}11">${n.region}</span>`+
    `<span class="pcard-tag" style="color:${themeColor};border-color:${themeColor}33;background:${themeColor}11">${n.theme}</span>`+
    (n.country?`<span class="ctry">${n.country}</span>`:'');

  // Stats
  const collabs=GRAPH_DATA.edges.filter(e=>e.source===n.id||e.target===n.id);
  const collabCount=new Set(collabs.map(e=>e.source===n.id?e.target:e.source)).size;
  const firstAuthorArts=(n.articles||[]).filter(a=>FIRST_AUTHOR_MAP.get(a.num)===n.id);
  const collabArts=(n.articles||[]).filter(a=>FIRST_AUTHOR_MAP.get(a.num)!==n.id);
  document.getElementById('pc-stat').innerHTML=
    `<div class="pcard-s"><div class="n">${(n.articles||[]).length}</div><div class="l">Total</div></div>`+
    `<div class="pcard-s" title="Como primeiro autor"><div class="n" style="color:#66ee88">${firstAuthorArts.length}</div><div class="l">1º Autor</div></div>`+
    `<div class="pcard-s" title="Em colaboração"><div class="n" style="color:#5b9fff">${collabArts.length}</div><div class="l">Colab.</div></div>`+
    `<div class="pcard-s"><div class="n">${collabCount}</div><div class="l">Coautores</div></div>`;

  const linkEl=document.getElementById('pc-link');
  linkEl.href='#'+slug;
  linkEl.textContent='🔗 #'+decodeURIComponent(slug);

  // Article renderer for overlay card (loads PDF in right column)
  function renderArtRow(a){
    const pg=a.page;
    const pgStr=pg?`<span class="pcard-pg" onclick="event.stopPropagation();loadPdfPage(${pg})" title="Abrir no PDF">p.${pg} ↗</span>`:'';
    const numLabel=`<span style="font-size:.5rem;color:var(--dim);opacity:.6">#${a.num}</span>`;
    return `<div class="pcard-article" onclick="if(${pg||0})loadPdfPage(${pg||0})">
      <div class="pcard-atitle pcard-atitle-full">${a.title}</div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:3px">
        <span class="pcard-atag">${a.design}</span>${pgStr}${numLabel}
      </div>
    </div>`;
  }

  let bodyHtml='';
  if(firstAuthorArts.length>0){
    bodyHtml+=`<div class="pcard-sec" style="color:#66ee88">★ Primeiro Autor (${firstAuthorArts.length})</div>${firstAuthorArts.map(renderArtRow).join('')}`;
  }
  if(collabArts.length>0){
    bodyHtml+=`<div class="pcard-sec" style="margin-top:${firstAuthorArts.length>0?'12':'0'}px;color:#5b9fff">⟳ Em Colaboração (${collabArts.length})</div>${collabArts.map(renderArtRow).join('')}`;
  }

  const collabNodes=collabs.sort((a,b)=>b.weight-a.weight).slice(0,25).map(e=>{
    const oid=e.source===n.id?e.target:e.source;
    const on=NODE_MAP.get(oid)||{};
    return `<div class="pcard-collab">
      <div class="pcard-cname" onclick="openCard(NODE_MAP.get('${oid.replace(/'/g,"\\'")}'))">${oid}</div>
      ${on.country?`<span class="ctry pcard-cctry">${on.country}</span>`:''}
      <span class="pcard-cw">×${e.weight}</span>
    </div>`;
  }).join('');

  bodyHtml+=`<div class="pcard-sec" style="margin-top:14px">Colaboradores (${collabCount})</div>${collabNodes}`;
  document.getElementById('pc-body').innerHTML=bodyHtml;

  // Load the requested page, or first article's page
  const pageToLoad=initialPage||(n.articles||[])[0]?.page;
  if(pageToLoad) loadPdfPage(pageToLoad);
  else document.getElementById('pc-pdf-container').innerHTML='';
  const pcard=document.getElementById('pcard');
  pcard.style.transform='scale(0.92) translateY(20px)';
  pcard.style.opacity='0';
  document.getElementById('card-overlay').classList.add('open');
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    pcard.style.transition='transform .28s cubic-bezier(.34,1.3,.64,1),opacity .2s ease';
    pcard.style.transform='scale(1) translateY(0)';
    pcard.style.opacity='1';
    setTimeout(()=>{pcard.style.transition='';},300);
  }));
}


function showSidebarCard(n){
  if(!n)return;

  // Set URL hash for this author
  const slug = slugify(n.id);
  history.pushState(null,'','#'+slug);

  const regionColor=REGION_COL[n.region]||'#4e6280';
  const themeColor=THEME_COL[n.theme]||'#4e6280';
  document.getElementById('sc-name').textContent=n.id;
  document.getElementById('sc-meta').innerHTML=
    `<span class="pcard-tag" style="color:${regionColor};border-color:${regionColor}33;background:${regionColor}11">${n.region}</span>`+
    `<span class="pcard-tag" style="color:${themeColor};border-color:${themeColor}33;background:${themeColor}11">${n.theme}</span>`+
    (n.country?`<span class="ctry">${n.country}</span>`:'')+
    `<a href="#${slug}" style="font-size:.52rem;color:var(--dim);margin-left:6px;text-decoration:none;opacity:.6" title="Link direto para este participante">🔗 link</a>`;

  // Strict co-authors: only those who shared the SAME paper
  const samePaperCollabs = SAME_PAPER_EDGES.filter(e => e.source === n.id || e.target === n.id);
  const collabCount = samePaperCollabs.length;

  // Separate first-author vs collaboration articles
  const allArts = n.articles || [];
  const firstAuthorArts = allArts.filter(a => FIRST_AUTHOR_MAP.get(a.num) === n.id);
  const collabArts = allArts.filter(a => FIRST_AUTHOR_MAP.get(a.num) !== n.id);

  document.getElementById('sc-stat').innerHTML=
    `<div class="pcard-s"><div class="n">${allArts.length}</div><div class="l">Total</div></div>`+
    `<div class="pcard-s" title="Como primeiro autor"><div class="n" style="color:#66ee88">${firstAuthorArts.length}</div><div class="l">1º Autor</div></div>`+
    `<div class="pcard-s" title="Em colaboração (não primeiro autor)"><div class="n" style="color:#5b9fff">${collabArts.length}</div><div class="l">Colab.</div></div>`+
    `<div class="pcard-s"><div class="n">${collabCount}</div><div class="l">Coautores</div></div>`;

  function renderArtList(arts){
    return arts.map(a=>{
      const pg=a.page;
      const pgStr=pg?`<span class="pcard-pg" onclick="event.stopPropagation();openCard(NODE_MAP.get('${n.id.replace(/'/g,"\\'")}'),${pg})" title="Abrir no PDF">p.${pg} ↗</span>`:'';
      const numLabel=`<span style="font-size:.5rem;color:var(--dim);opacity:.6">#${a.num}</span>`;
      return `<div class="pcard-article" onclick="openCard(NODE_MAP.get('${n.id.replace(/'/g,"\\'")}')${pg?`,${pg}`:''})"
        style="cursor:pointer">
        <div class="pcard-atitle pcard-atitle-full">${a.title}</div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:3px">
          <span class="pcard-atag">${a.design}</span>${pgStr}${numLabel}
        </div>
      </div>`;
    }).join('');
  }

  const collabNodes=samePaperCollabs.sort((a,b)=>b.weight-a.weight).slice(0,20).map(e=>{
    const oid=e.source===n.id?e.target:e.source;
    const on=NODE_MAP.get(oid)||{};
    return `<div class="pcard-collab">
      <div class="pcard-cname" onclick="openCard(NODE_MAP.get('${oid.replace(/'/g,"\\'")}'))">${oid}</div>
      ${on.country?`<span class="ctry pcard-cctry">${on.country}</span>`:''}
      <span class="pcard-cw">×${e.weight}</span>
    </div>`;
  }).join('');

  let bodyHtml = '';
  if(firstAuthorArts.length > 0){
    bodyHtml += `<div class="pcard-sec" style="color:#66ee88">★ Primeiro Autor (${firstAuthorArts.length})</div>${renderArtList(firstAuthorArts)}`;
  }
  if(collabArts.length > 0){
    const scrollHint = collabArts.length > 3 ? `<div style="font-size:.54rem;color:var(--dim);padding:3px 0 2px;opacity:.6;text-align:right">↕ role para ver todos</div>` : '';
    bodyHtml += `<div class="pcard-sec" style="margin-top:${firstAuthorArts.length>0?'12':'0'}px;color:#5b9fff">⟳ Em Colaboração (${collabArts.length})</div>${scrollHint}${renderArtList(collabArts)}`;
  }
  bodyHtml += `<div class="pcard-sec" style="margin-top:14px">Colaboradores (${collabCount})</div>${collabNodes}`;

  document.getElementById('sc-body').innerHTML = bodyHtml;
  document.getElementById('sidebar-filters').style.display='none';
  document.getElementById('sidebar-card').style.display='flex';
}

function closeSidebarCard(){
  document.getElementById('sidebar-card').style.display='none';
  document.getElementById('sidebar-filters').style.display='';
  closePdfPopup();
  history.pushState(null,'',window.location.pathname+window.location.search);
  const sel=document.getElementById('country-select');if(sel)sel.value='';
}

// ── Country card helpers ──
function buildCountryEntry(countryName){
  const {nodes}=filteredData();
  const entry={authors:[],articleNums:new Set(),firstAuthorArts:0,collabArts:0};
  const normName=normalizeCountry(countryName);
  nodes.forEach(n=>{
    if(normalizeCountry(n.country||'Unknown')!==normName)return;
    if(!entry.authors.includes(n.id))entry.authors.push(n.id);
    (n.articles||[]).forEach(a=>{
      entry.articleNums.add(a.num??a.title);
      if(FIRST_AUTHOR_MAP.get(a.num)===n.id)entry.firstAuthorArts++;
      else entry.collabArts++;
    });
  });
  return entry;
}

function filterByCountry(countryName){
  if(!countryName){
    const sel=document.getElementById('country-select');if(sel)sel.value='';
    closeSidebarCard();
    return;
  }
  const sel=document.getElementById('country-select');if(sel)sel.value=countryName;
  const slug='pais_'+slugify(countryName);
  history.pushState(null,'','#'+slug);
  if(activeTab==='globe'){showCountrySidebarCard(countryName,buildCountryEntry(countryName));}
}

function showCountrySidebarCard(countryName,entry){
  if(!entry||entry.authors.length===0)return;
  const artCount=entry.articleNums.size;
  document.getElementById('sc-name').textContent=countryName;
  document.getElementById('sc-meta').innerHTML=
    `<span class="pcard-tag" style="color:#5b9fff;border-color:#5b9fff33;background:#5b9fff11">🗺 País</span>`+
    `<a href="#pais_${slugify(countryName)}" style="font-size:.52rem;color:var(--dim);margin-left:6px;text-decoration:none;opacity:.6" title="Link direto">🔗 link</a>`;
  document.getElementById('sc-stat').innerHTML=
    `<div class="pcard-s"><div class="n">${entry.authors.length}</div><div class="l">Autores</div></div>`+
    `<div class="pcard-s"><div class="n">${artCount}</div><div class="l">Artigos</div></div>`+
    `<div class="pcard-s" title="Publicações como 1º autor"><div class="n" style="color:#66ee88">${entry.firstAuthorArts}</div><div class="l">1º Autor</div></div>`+
    `<div class="pcard-s" title="Em colaboração"><div class="n" style="color:#5b9fff">${entry.collabArts}</div><div class="l">Colab.</div></div>`;
  const authorList=entry.authors
    .sort((a,b)=>(NODE_MAP.get(b)?.count||0)-(NODE_MAP.get(a)?.count||0))
    .map(id=>{
      const n=NODE_MAP.get(id)||{};
      return `<div class="pcard-collab">
        <div class="pcard-cname" onclick="openCard(NODE_MAP.get('${id.replace(/'/g,"\\'")}'))">${id}</div>
        <span class="pcard-cw">${n.count||0} art.</span>
      </div>`;
    }).join('');
  document.getElementById('sc-body').innerHTML=
    `<div class="pcard-sec">Autores (${entry.authors.length})</div>${authorList}`;
  document.getElementById('sidebar-filters').style.display='none';
  document.getElementById('sidebar-card').style.display='flex';
}

function openPdfPopup(title, page) {
  if (!page) return;
  const popup = document.getElementById('pdf-popup');
  document.getElementById('pdf-popup-title').textContent = title;
  popup.classList.add('open');
  loadPdfPage(page, 'pdf-popup-container');
}

function closePdfPopup() {
  const popup = document.getElementById('pdf-popup');
  if (popup) popup.classList.remove('open');
}
function getArticlePageCount(startPage){
  const pages=Object.values(ARTICLE_PAGE_MAP).filter(p=>p>startPage).sort((a,b)=>a-b);
  const endPage=pages.length?pages[0]-1:startPage+2;
  return Math.min(endPage-startPage+1,3);
}

pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
let _pdfDoc=null,_pdfRendering=false,_pdfQueue=null;

async function _getPdfDoc(){
  if(!_pdfDoc) _pdfDoc=await pdfjsLib.getDocument('17th.pdf').promise;
  return _pdfDoc;
}

async function loadPdfPage(pageNum, containerId = 'pc-pdf-container'){
  if(_pdfRendering){_pdfQueue={pageNum, containerId};return;}
  _pdfRendering=true;
  try{
    const doc=await _getPdfDoc();
    const container=document.getElementById(containerId);
    if (!container) return;
    container.innerHTML='';
    const dpr=window.devicePixelRatio||1;
    const targetW=(container.clientWidth-24)*dpr;
    const numPages=Math.min(getArticlePageCount(pageNum),doc.numPages-pageNum+1);
    for(let i=0;i<numPages;i++){
      const page=await doc.getPage(pageNum+i);
      const vp0=page.getViewport({scale:1});
      const scale=(targetW/vp0.width)*0.92;
      const vp=page.getViewport({scale});
      const canvas=document.createElement('canvas');
      canvas.width=vp.width;
      canvas.height=vp.height;
      canvas.style.width=(vp.width/dpr)+'px';
      canvas.style.height=(vp.height/dpr)+'px';
      canvas.style.display='block';
      if(i>0) canvas.style.marginTop='8px';
      container.appendChild(canvas);
      await page.render({canvasContext:canvas.getContext('2d'),viewport:vp}).promise;
    }
    container.scrollTop=0;
  }finally{
    _pdfRendering=false;
    if(_pdfQueue!==null){
      const q=_pdfQueue;
      _pdfQueue=null;
      loadPdfPage(q.pageNum, q.containerId);
    }
  }
}

function openPdfTab(title, page){
  if(page) loadPdfPage(page);
}


function closeCard(){

  if(document.getElementById('sidebar-card').style.display!=='none'){closeSidebarCard();return;}
  const overlay=document.getElementById('card-overlay');
  const pcard=document.getElementById('pcard');


  pcard.style.transition='transform .18s ease,opacity .18s ease';
  pcard.style.transform='scale(0.93)';
  pcard.style.opacity='0';
  setTimeout(()=>{
    overlay.classList.remove('open');
    pcard.style.transition='';pcard.style.transform='';pcard.style.opacity='';
  },190);
  history.pushState(null,'',window.location.pathname+window.location.search);
}
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&document.getElementById('card-overlay').classList.contains('open'))closeCard();});

function handleOverlayClick(e){
  if(e.target===document.getElementById('card-overlay'))closeCard();
}

window.addEventListener('popstate',()=>{
  const hash=window.location.hash.slice(1);
  if(!hash)closeCard();
  else{const id=decodeURIComponent(hash.replace(/_/g,' '));const n=NODE_MAP.get(id);if(n)openCard(n);}
});

// ──────────────────────────────────────────────────────────────────
//  GLOBE v4 — improved texture + animated arcs + instanced nodes
// ──────────────────────────────────────────────────────────────────

// Arc animation state
let arcParticles=[];   // [{mesh, curve, t, speed}]
let arcMeshGroup=null; // Group holding arc tube meshes
let cloudsRef=null;

function initGlobe(){ doneLoading(); }

// Fallback canvas-based Earth when textures fail to load
function buildProceduralEarthMat(){
  const size=2048,half=size/2;
  const c=document.createElement('canvas');c.width=size;c.height=half;
  const ctx=c.getContext('2d');
  const og=ctx.createLinearGradient(0,0,0,half);
  og.addColorStop(0,'#071828');og.addColorStop(.5,'#040e1a');og.addColorStop(1,'#020a14');
  ctx.fillStyle=og;ctx.fillRect(0,0,size,half);
  ctx.fillStyle='#1e4d30';
  [[size*.19,half*.22,size*.09,half*.32,-.1],[size*.24,half*.52,size*.05,half*.28,.1],
   [size*.53,half*.2,size*.05,half*.16,0],[size*.54,half*.48,size*.07,half*.36,0],
   [size*.7,half*.25,size*.18,half*.32,0],[size*.82,half*.58,size*.06,half*.10,0]
  ].forEach(([cx,cy,rx,ry,rot])=>{ctx.beginPath();ctx.ellipse(cx,cy,rx,ry,rot,0,Math.PI*2);ctx.fill();});
  return new THREE.MeshPhongMaterial({map:new THREE.CanvasTexture(c),specular:new THREE.Color(0x112244),shininess:12});
}

// ──────────────────────────────────────────────────────────────────
//  INSTANCED NODES (big perf win: 1 draw call for all points)
// ──────────────────────────────────────────────────────────────────
let instancedMesh=null;

function rebuildGlobePoints(){}

// ──────────────────────────────────────────────────────────────────
//  ANIMATED ARCS — tube geometry + glowing particle dot
// ──────────────────────────────────────────────────────────────────
function buildGlobeArcs(){}

function startGlobeAnim(){}
function stopGlobeAnim(){}
function raycastNodes(){ return null; }
let tipEl=null;
function checkHover(e){}

// ──────────────────────────────────────────────────────────────────
//  D3 NET
// ──────────────────────────────────────────────────────────────────
// ── Network link style helpers (used by initD3Net + updateNetParam) ──
function _netLinkId(d){ return typeof d.source==='object'?d.source.id:d.source; }
function netLinkStroke(d){
  if(netLinkColorMode==='node'){
    const sn=NODE_MAP.get(_netLinkId(d));
    if(!sn) return '#5b9fff';
    const col=d3.color(getColor(sn));
    if(!col) return '#5b9fff';
    col.opacity=d.weight>=3?.85:d.weight===2?.55:.22;
    return col.toString();
  }
  return d.weight>=3?'#5b9fff':d.weight===2?'#3a6abf':'#1e3060';
}
function netLinkOpacity(d){
  return netLinkColorMode==='node'?1:(d.weight>=3?.95:d.weight===2?.65:.32);
}
function netLinkW(d){
  return (d.weight>=3?3.2:d.weight===2?1.8:0.9)*netLinkWidth;
}

function initD3Net(){
  const svg=d3.select('#d3svg');svg.selectAll('*').remove();
  const stage=document.getElementById('stage');
  const W=stage.clientWidth,H=stage.clientHeight;
  const{nodes,edges}=filteredData();
  const nodesCopy=nodes.map(n=>({...n}));
  const edgesCopy=edges.map(e=>({...e}));

  // Build adjacency map for selections
  const netAdj=new Map();
  edges.forEach(e=>{
    const s=typeof e.source==='object'?e.source.id:e.source;
    const t=typeof e.target==='object'?e.target.id:e.target;
    if(!netAdj.has(s))netAdj.set(s,new Map());
    if(!netAdj.has(t))netAdj.set(t,new Map());
    netAdj.get(s).set(t,e.weight||1);
    netAdj.get(t).set(s,e.weight||1);
  });

  const z=d3.zoom().scaleExtent([.05,12]).on('zoom',e=>g.attr('transform',e.transform));
  svg.call(z);
  const g=svg.append('g');

  function netR(d){ return nodeR(d)*netNodeSizeMult; }

  sim=d3.forceSimulation(nodesCopy)
    .force('link',d3.forceLink(edgesCopy).id(d=>d.id).distance(netLinkDist).strength(0.55))
    .force('charge',d3.forceManyBody().strength(-netCharge))
    .force('center',d3.forceCenter(W/2,H/2))
    .force('collision',d3.forceCollide(d=>netR(d)+1.5))
    .force('gravX',d3.forceX(W/2).strength(0.025))
    .force('gravY',d3.forceY(H/2).strength(0.025));

  gLinks=g.append('g').selectAll('line').data(edgesCopy).join('line')
    .attr('stroke',d=>netLinkStroke(d))
    .attr('stroke-opacity',d=>netLinkOpacity(d))
    .attr('stroke-width',d=>netLinkW(d));

  let selectedNetNode=null;

  gNodes=g.append('g').selectAll('circle').data(nodesCopy).join('circle')
    .attr('r',d=>netR(d))
    .attr('fill',d=>getColor(d))
    .attr('opacity',.92)
    .attr('stroke','#04080f')
    .attr('stroke-width',.8)
    .call(d3.drag()
      .on('start',(e,d)=>{if(!e.active)sim.alphaTarget(.3).restart();d.fx=d.x;d.fy=d.y;})
      .on('drag',(e,d)=>{d.fx=e.x;d.fy=e.y;})
      .on('end',(e,d)=>{if(!e.active)sim.alphaTarget(0);d.fx=null;d.fy=null;})
    )
    .on('mouseover',(e,d)=>{
      showTip(e,d);
      if(d!==selectedNetNode){
        d3.select(e.currentTarget).transition().duration(100).attr('r',netR(d)*1.6).attr('stroke','#5b9fff').attr('stroke-width',1.5);
      }
    })
    .on('mousemove',moveTip)
    .on('mouseout',(e,d)=>{
      hideTip();
      if(d!==selectedNetNode){
        d3.select(e.currentTarget).transition().duration(160).attr('r',netR(d)).attr('stroke','#04080f').attr('stroke-width',.8);
      }
    })
    .on('click',(e,d)=>{
      e.stopPropagation();
      selectedNetNode=d;
      const neighbors=netAdj.get(d.id)||new Map();
      const neighborIds=new Set(neighbors.keys());
      const allLinked=new Set([d.id,...neighborIds]);

      gNodes.transition().duration(200)
        .attr('r',n=>{
          if(n.id===d.id)return netR(n)*2.4;
          if(neighborIds.has(n.id))return netR(n)*1.5;
          return netR(n)*0.6;
        })
        .attr('opacity',n=>allLinked.has(n.id)?1:0.08)
        .attr('stroke',n=>n.id===d.id?'#5b9fff':neighborIds.has(n.id)?'#5b9fff88':'#04080f')
        .attr('stroke-width',n=>n.id===d.id?2.5:neighborIds.has(n.id)?1.2:.5);

      gLinks.transition().duration(200)
        .attr('stroke',ed=>{
          const s=typeof ed.source==='object'?ed.source.id:ed.source;
          const t=typeof ed.target==='object'?ed.target.id:ed.target;
          if(s!==d.id&&t!==d.id)return '#0a1428';
          const w=ed.weight||1;
          return w>=3?'#5b9fff':w===2?'#3a8eff':'#2266cc';
        })
        .attr('stroke-opacity',ed=>{
          const s=typeof ed.source==='object'?ed.source.id:ed.source;
          const t=typeof ed.target==='object'?ed.target.id:ed.target;
          if(s!==d.id&&t!==d.id)return 0.03;
          const w=ed.weight||1;
          return w>=3?1:w===2?.8:.55;
        })
        .attr('stroke-width',ed=>{
          const s=typeof ed.source==='object'?ed.source.id:ed.source;
          const t=typeof ed.target==='object'?ed.target.id:ed.target;
          if(s!==d.id&&t!==d.id)return 0.4;
          const w=ed.weight||1;
          return w>=3?4.5:w===2?2.8:1.4;
        });

      openCard(NODE_MAP.get(d.id)||d);
    });

  // Reset on background click
  svg.on('click.netReset',()=>{
    selectedNetNode=null;
    gNodes.transition().duration(200)
      .attr('r',d=>netR(d)).attr('opacity',.92).attr('stroke','#04080f').attr('stroke-width',.8);
    gLinks.transition().duration(200)
      .attr('stroke',d=>netLinkStroke(d))
      .attr('stroke-opacity',d=>netLinkOpacity(d))
      .attr('stroke-width',d=>netLinkW(d));
  });

  // Auto fit-to-view once when simulation settles
  let autoFitted=false;
  sim.on('end',()=>{
    if(autoFitted) return; autoFitted=true;
    const xs=nodesCopy.map(n=>n.x||0), ys=nodesCopy.map(n=>n.y||0);
    const x0=Math.min(...xs),x1=Math.max(...xs),y0=Math.min(...ys),y1=Math.max(...ys);
    const pad=60,dxR=x1-x0+pad*2,dyR=y1-y0+pad*2;
    if(dxR>0&&dyR>0){
      const sc=Math.min(W/dxR,H/dyR,1.2);
      svg.transition().duration(700)
        .call(z.transform,d3.zoomIdentity.translate(W/2-sc*(x0+x1)/2,H/2-sc*(y0+y1)/2).scale(sc));
    }
  });

  // Expose zoom + nodes for focusNetNode()
  svg.node().__netZoom=z;
  svg.node().__netNodes=nodesCopy;

  // Expose fit function for the Fit button
  svg.node().__netFit=()=>{
    const xs=nodesCopy.map(n=>n.x||0),ys=nodesCopy.map(n=>n.y||0);
    const x0=Math.min(...xs),x1=Math.max(...xs),y0=Math.min(...ys),y1=Math.max(...ys);
    const pad=60,dxR=x1-x0+pad*2,dyR=y1-y0+pad*2;
    if(dxR>0&&dyR>0){
      const sc=Math.min(W/dxR,H/dyR,1.2);
      svg.transition().duration(500)
        .call(z.transform,d3.zoomIdentity.translate(W/2-sc*(x0+x1)/2,H/2-sc*(y0+y1)/2).scale(sc));
    }
  };
  // Expose sim for live param updates
  svg.node().__netSim=sim;
  svg.node().__netR=netR;

  sim.on('tick',()=>{
    gLinks.attr('x1',d=>d.source.x).attr('y1',d=>d.source.y).attr('x2',d=>d.target.x).attr('y2',d=>d.target.y);
    gNodes.attr('cx',d=>d.x).attr('cy',d=>d.y);
  });
}

// ──────────────────────────────────────────────────────────────────
//  D3 BAR
// ──────────────────────────────────────────────────────────────────
function initD3Bar(by){
  const svg=d3.select('#d3svg');svg.selectAll('*').remove();
  const stage=document.getElementById('stage');
  const W=stage.clientWidth,H=stage.clientHeight;
  const{nodes,edges}=filteredData();
  const groups={};
  nodes.forEach(n=>{if(!groups[n[by]])groups[n[by]]={nodes:0,edges:0,col:by==='region'?REGION_COL[n[by]]:THEME_COL[n[by]]};groups[n[by]].nodes++;});
  edges.forEach(e=>{const sn=nodes.find(n=>n.id===e.source);if(sn&&groups[sn[by]])groups[sn[by]].edges+=e.weight;});
  const data=Object.entries(groups).sort((a,b)=>b[1].edges-a[1].edges);
  const mg={t:30,r:20,b:90,l:60};
  const pw=W-mg.l-mg.r,ph=H-mg.t-mg.b;
  const x=d3.scaleBand().domain(data.map(d=>d[0])).range([0,pw]).padding(.28);
  const y=d3.scaleLinear().domain([0,d3.max(data,d=>d[1].edges)*1.12]).range([ph,0]);
  const g=svg.append('g').attr('transform',`translate(${mg.l},${mg.t})`);
  g.append('g').attr('transform',`translate(0,${ph})`).call(d3.axisBottom(x)).selectAll('text').attr('fill','#4e6280').attr('font-size','.67rem').attr('transform','rotate(-28)').style('text-anchor','end');
  g.append('g').call(d3.axisLeft(y).ticks(6)).selectAll('text').attr('fill','#4e6280').attr('font-size','.64rem');
  g.selectAll('.domain,.tick line').attr('stroke','#182238');
  g.selectAll('rect').data(data).join('rect')
    .attr('x',d=>x(d[0])).attr('y',d=>y(d[1].edges)).attr('width',x.bandwidth()).attr('height',d=>ph-y(d[1].edges))
    .attr('fill',d=>d[1].col||'#5b9fff').attr('rx',3).attr('opacity',.8);
  g.selectAll('.lbl').data(data).join('text').attr('class','lbl')
    .attr('x',d=>x(d[0])+x.bandwidth()/2).attr('y',d=>y(d[1].edges)-5).attr('text-anchor','middle')
    .attr('fill','#e0e8f8').attr('font-size','.62rem').text(d=>d[1].edges);
  svg.append('text').attr('x',W/2).attr('y',18).attr('text-anchor','middle').attr('fill','#4e6280').attr('font-size','.68rem').text(`Colaborações por ${by==='region'?'Região':'Tema'}`);
}

// ──────────────────────────────────────────────────────────────────
//  TOOLTIP
// ──────────────────────────────────────────────────────────────────
function showTip(e,d){
  if(!tipEl)tipEl=document.getElementById('tip');
  const rc=REGION_COL[d.region]||'#4e6280';
  tipEl.innerHTML=`<div class="tip-name">${d.id}</div><div class="tip-row">País: <span>${d.country||'—'}</span></div><div class="tip-row">Região: <span style="color:${rc}">${d.region}</span></div><div class="tip-row">Artigos: <span>${d.count}</span></div><div style="font-size:.58rem;color:var(--dim);margin-top:4px">Clique para abrir o card →</div>`;
  tipEl.classList.add('vis');moveTip(e);
}
function moveTip(e){
  const s=document.getElementById('stage').getBoundingClientRect();
  let x=e.clientX-s.left+14,y=e.clientY-s.top+14;
  if(x+240>s.width)x-=250;if(y+120>s.height)y-=130;
  tipEl.style.left=x+'px';tipEl.style.top=y+'px';
}
function hideTip(){if(tipEl)tipEl.classList.remove('vis');}

// ──────────────────────────────────────────────────────────────────
//  TABLES
// ──────────────────────────────────────────────────────────────────
function initTableData(){
  TS.authors.data=[...GRAPH_DATA.nodes];
  TS.authors.filtered=[...GRAPH_DATA.nodes];
  TS.articles.data=[...ARTICLES_DATA];
  TS.articles.filtered=[...ARTICLES_DATA];
  const edgesRich=GRAPH_DATA.edges.map(e=>{
    const s=NODE_MAP.get(e.source)||{};const t=NODE_MAP.get(e.target)||{};
    return{...e,source_country:s.country||'',target_country:t.country||''};
  });
  TS.edges.data=edgesRich;TS.edges.filtered=[...edgesRich];
}

function filterTable(tbl){
  const q=(document.getElementById('srch-'+tbl).value||'').toLowerCase();
  TS[tbl].filtered=q?TS[tbl].data.filter(r=>Object.values(r).some(v=>v&&String(v).toLowerCase().includes(q))):[...TS[tbl].data];
  renderTable(tbl);
}

function sortTable(tbl,col,th){
  const st=TS[tbl];
  if(st.sortCol===col)st.sortDir*=-1;
  else{st.sortCol=col;st.sortDir=['count','weight','num_autores','num_refs','num'].includes(col)?-1:1;}
  document.querySelectorAll(`#tbl-${tbl} th`).forEach(h=>h.className='');
  th.className=st.sortDir===1?'asc':'desc';
  renderTable(tbl);
}

function renderTable(tbl){
  const st=TS[tbl];
  const sorted=[...st.filtered].sort((a,b)=>{
    const av=a[st.sortCol],bv=b[st.sortCol];
    if(av==null)return 1;if(bv==null)return -1;
    return(typeof av==='number'?(av-bv):String(av).localeCompare(String(bv)))*st.sortDir;
  });
  const cnt=document.getElementById('cnt-'+tbl);
  if(cnt)cnt.textContent=sorted.length+' registros';
  const tbody=document.getElementById('tbody-'+tbl);
  if(tbl==='authors'){
    tbody.innerHTML=sorted.map(n=>`<tr onclick="openCard(NODE_MAP.get('${n.id.replace(/'/g,"\\'")}'))">
      <td style="color:var(--txt);font-weight:600">${n.id}</td>
      <td><span class="ctry">${n.country||'—'}</span></td>
      <td><span style="color:${REGION_COL[n.region]||'#4e6280'};font-size:.6rem">■</span> ${n.region||'—'}</td>
      <td><span class="badge" style="color:${THEME_COL[n.theme]||'#4e6280'}">${n.theme||'—'}</span></td>
      <td style="color:var(--acc);text-align:center;font-weight:bold">${n.count}</td>
    </tr>`).join('');
  }else if(tbl==='articles'){
    tbody.innerHTML=sorted.map(a=>`<tr>
      <td style="color:var(--dim);text-align:center">${a.num}</td>
      <td title="${a.titulo}" style="color:var(--txt)">${a.titulo}</td>
      <td><span class="badge" style="color:${THEME_COL[a.tema]||'#4e6280'}">${a.tema}</span></td>
      <td style="color:var(--dim)">${a.design}</td>
      <td><span class="ctry">${a.pais||'—'}</span></td>
      <td style="text-align:center">${a.num_autores}</td>
      <td style="text-align:center;color:var(--dim)">${a.num_refs}</td>
    </tr>`).join('');
  }else{
    tbody.innerHTML=sorted.map(e=>`<tr>
      <td style="color:var(--txt);cursor:pointer" onclick="openCard(NODE_MAP.get('${e.source.replace(/'/g,"\\'")}'))">${e.source}</td>
      <td><span class="ctry">${e.source_country||'—'}</span></td>
      <td style="color:var(--txt);cursor:pointer" onclick="openCard(NODE_MAP.get('${e.target.replace(/'/g,"\\'")}'))">${e.target}</td>
      <td><span class="ctry">${e.target_country||'—'}</span></td>
      <td style="text-align:center;font-weight:bold;color:${e.weight>=3?'var(--acc)':e.weight===2?'var(--warn)':'var(--dim)'}">${e.weight}</td>
    </tr>`).join('');
  }
}

// ──────────────────────────────────────────────────────────────────
//  SEARCH
// ──────────────────────────────────────────────────────────────────
function doSearch(q){
  const drop=document.getElementById('srch-drop');
  if(!q){drop.style.display='none';return;}
  const res=GRAPH_DATA.nodes.filter(n=>n.id.toLowerCase().includes(q.toLowerCase())).slice(0,8);
  drop.innerHTML=res.map(n=>`<div class="sdi" onclick="selectAuthor('${n.id.replace(/'/g,"\\'")}')">  ${n.id}<small>${n.country||n.region}</small></div>`).join('');
  drop.style.display=res.length?'block':'none';
}

// ──────────────────────────────────────────────────────────────────
//  MISC
// ──────────────────────────────────────────────────────────────────
function resetView(){
  if(camera)camera.position.z=5.2;
  if(globeGroup)globeGroup.rotation.set(0,0,0);
}
function togglePause(){
  paused=!paused;
  document.getElementById('btn-pause').classList.toggle('lit',paused);
  document.getElementById('btn-pause').textContent=paused?'▶ Retomar':'⏸ Pausar';
}

// ──────────────────────────────────────────────────────────────────
//  THEME SWITCHER
// ──────────────────────────────────────────────────────────────────
function setTheme(t){
  document.documentElement.setAttribute('data-theme', t === 'dark' ? '' : t);
  ['dark','light','warm'].forEach(x=>{
    const el=document.getElementById('theme-'+x);
    if(el) el.classList.toggle('lit', x===t);
  });
  
  // Refresh visualizations to pick up new theme colors
  if (typeof buildMap2D === 'function') buildMap2D();
  
  // If D3 Net or Bar are active, they might need a refresh too
  // We can check which tab is active and re-init the corresponding view
  const activeTab = document.querySelector('.tab.on');
  if (activeTab) {
    const tabId = activeTab.id;
    if (tabId === 'tab-net') initD3Net();
    else if (tabId === 'tab-reg') initD3Bar('region');
    else if (tabId === 'tab-thm') initD3Bar('theme');
  }
  
  // Update open card if any
  const overlay = document.getElementById('card-overlay');
  if (overlay && overlay.classList.contains('open')) {
    const name = document.getElementById('pc-name').textContent;
    const node = NODE_MAP.get(name);
    if (node) openCard(node);
  }
}

// ──────────────────────────────────────────────────────────────────
//  MAP MODE (Flat 2D Map Only)
// ──────────────────────────────────────────────────────────────────
let mapMode = true;
let map2dBuilt = false;

// ──────────────────────────────────────────────────────────────────
//  2D WORLD MAP (Natural Earth projection, Google Maps style)
// ──────────────────────────────────────────────────────────────────
function buildMap2D(){
  const wrap = document.getElementById('map2d-wrap');
  if(!wrap) return;
  const svg = d3.select('#map2d-svg');
  svg.selectAll('*').remove();

  const W = wrap.clientWidth, H = wrap.clientHeight;
  const theme = document.documentElement.getAttribute('data-theme') || 'dark';

  const colors = {
    ocean:      theme==='light' ? '#b8d4ea' : theme==='warm' ? '#0a0604' : '#071020',
    land:       theme==='light' ? '#8fa86e' : theme==='warm' ? '#3a2410' : '#1a3a2a',
    landHover:  theme==='light' ? '#a8c07a' : theme==='warm' ? '#5a3a18' : '#265a38',
    border:     theme==='light' ? 'rgba(80,110,50,.5)' : theme==='warm' ? 'rgba(80,50,20,.4)' : 'rgba(50,100,60,.35)',
    graticule:  theme==='light' ? 'rgba(100,140,180,.25)' : theme==='warm' ? 'rgba(80,60,30,.18)' : 'rgba(30,80,120,.22)',
    linkStrong: theme==='light' ? 'rgba(60,100,220,.85)' : theme==='warm' ? 'rgba(220,140,60,.85)' : 'rgba(91,159,255,.85)',
    linkMed:    theme==='light' ? 'rgba(80,120,200,.45)' : theme==='warm' ? 'rgba(180,100,40,.45)' : 'rgba(91,159,255,.45)',
    linkWeak:   theme==='light' ? 'rgba(80,100,200,.15)' : theme==='warm' ? 'rgba(120,70,25,.18)' : 'rgba(91,159,255,.18)',
    nodeBorder: theme==='light' ? 'rgba(30,20,10,.6)'  : theme==='warm' ? 'rgba(20,10,2,.75)' : '#04080f',
    highlight:  theme==='light' ? '#c0392b' : theme==='warm' ? '#e8a040' : '#5b9fff',
    arcStrong:  theme==='light' ? '#c0392b' : theme==='warm' ? '#e8a040' : '#5b9fff',
    arcWeak:    theme==='light' ? '#a070c0' : theme==='warm' ? '#c08030' : '#8899ff',
  };

  svg.style('background', colors.ocean);

  const projection = d3.geoNaturalEarth1()
    .scale(Math.min(W/6.4, H/3.3))
    .translate([W/2, H/2]);
  const path = d3.geoPath().projection(projection);
  const geoContains = d3.geoContains;

  const zoomBeh = d3.zoom()
    .scaleExtent([0.5, 20])
    .on('zoom', e => { mapG.attr('transform', e.transform); });
  svg.call(zoomBeh).on('dblclick.zoom', null);

  const mapG = svg.append('g').attr('class','map-root');

  const graticule = d3.geoGraticule().step([30,30]);
  mapG.append('path').datum(graticule())
    .attr('d', path).attr('fill','none')
    .attr('stroke', colors.graticule).attr('stroke-width', .5);

  // Country hover tooltip — singleton
  let ctip = document.getElementById('country-tip');
  if(!ctip){
    ctip = document.createElement('div');
    ctip.id = 'country-tip';
    Object.assign(ctip.style, {
      position:'fixed', pointerEvents:'none', display:'none', zIndex:'9999',
      background:'rgba(10,15,30,.92)', color:'#e0e8f8',
      padding:'5px 10px', borderRadius:'5px',
      fontSize:'.65rem', fontFamily:'IBM Plex Mono,monospace',
      border:'1px solid rgba(91,159,255,.3)'
    });
    document.body.appendChild(ctip);
  }

  fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json')
    .then(r=>r.json())
    .then(world=>{
      const countries = topojson.feature(world, world.objects.countries);

      // ── Build authoritative country name from feature properties ──
      // world-atlas 110m doesn't embed names; use a compact ISO-numeric→name table
      // covering common countries. Fallback: centroid-based lookup from node data.
      const ISO_NAMES = {
        4:'Afghanistan',8:'Albania',12:'Algeria',24:'Angola',32:'Argentina',
        36:'Australia',40:'Austria',50:'Bangladesh',56:'Belgium',64:'Bhutan',
        68:'Bolivia',76:'Brazil',100:'Bulgaria',116:'Cambodia',120:'Cameroon',
        124:'Canada',144:'Sri Lanka',152:'Chile',156:'China',170:'Colombia',
        180:'DR Congo',188:'Costa Rica',191:'Croatia',192:'Cuba',203:'Czech Republic',
        204:'Benin',208:'Denmark',218:'Ecuador',818:'Egypt',222:'El Salvador',
        231:'Ethiopia',246:'Finland',250:'France',276:'Germany',288:'Ghana',
        300:'Greece',320:'Guatemala',332:'Haiti',340:'Honduras',356:'India',
        360:'Indonesia',364:'Iran',368:'Iraq',372:'Ireland',376:'Israel',
        380:'Italy',388:'Jamaica',392:'Japan',400:'Jordan',398:'Kazakhstan',
        404:'Kenya',410:'South Korea',414:'Kuwait',418:'Laos',422:'Lebanon',
        430:'Liberia',434:'Libya',458:'Malaysia',484:'Mexico',504:'Morocco',
        508:'Mozambique',516:'Namibia',524:'Nepal',528:'Netherlands',
        554:'New Zealand',558:'Nicaragua',566:'Nigeria',578:'Norway',
        586:'Pakistan',275:'Palestine',591:'Panama',598:'Papua New Guinea',
        600:'Paraguay',604:'Peru',608:'Philippines',616:'Poland',
        620:'Portugal',634:'Qatar',642:'Romania',643:'Russia',
        646:'Rwanda',682:'Saudi Arabia',686:'Senegal',694:'Sierra Leone',
        703:'Slovakia',706:'Somalia',710:'South Africa',724:'Spain',
        729:'Sudan',752:'Sweden',756:'Switzerland',760:'Syria',
        158:'Taiwan',834:'Tanzania',764:'Thailand',768:'Togo',
        788:'Tunisia',792:'Turkey',800:'Uganda',804:'Ukraine',
        784:'United Arab Emirates',826:'United Kingdom',840:'United States of America',
        858:'Uruguay',860:'Uzbekistan',862:'Venezuela',704:'Vietnam',
        887:'Yemen',894:'Zambia',716:'Zimbabwe',
        807:'North Macedonia',499:'Montenegro',688:'Serbia',
        70:'Bosnia and Herzegovina',191:'Croatia',705:'Slovenia',
        112:'Belarus',233:'Estonia',428:'Latvia',440:'Lithuania',
        372:'Ireland',352:'Iceland',442:'Luxembourg',470:'Malta',
        196:'Cyprus',51:'Armenia',31:'Azerbaijan',268:'Georgia',
        496:'Mongolia',418:'Laos',104:'Myanmar',116:'Cambodia'
      };

      // Build a centroid map: feature → projected centroid
      const featCentroids = new Map();
      countries.features.forEach(feat=>{
        const c = path.centroid(feat);
        if(c && !isNaN(c[0])) featCentroids.set(feat, c);
      });

      // ── Build author data lookup by country ──
      const {nodes, edges} = filteredData();
      doneLoading();

      // Group nodes by normalized country name
      // articleNums: Set de IDs únicos de artigos (evita contar o mesmo artigo N vezes quando N autores do mesmo país co-escreveram)
      const countryAuthorMap = new Map(); // countryName -> {authors, articleNums, firstAuthorArts, collabArts}
      nodes.forEach(n=>{
        const c = normalizeCountry(n.country||'Unknown');
        if(!countryAuthorMap.has(c)) countryAuthorMap.set(c, {authors:[], articleNums:new Set(), firstAuthorArts:0, collabArts:0});
        const entry = countryAuthorMap.get(c);
        if(!entry.authors.includes(n.id)) entry.authors.push(n.id);
        // Count first-author vs collab; track unique article nums to avoid double-counting
        (n.articles||[]).forEach(a => {
          entry.articleNums.add(a.num ?? a.title);
          if(FIRST_AUTHOR_MAP.get(a.num) === n.id) entry.firstAuthorArts++;
          else entry.collabArts++;
        });
      });

      // Map each node to its geographic anchor (projected lat/lon)
      nodes.forEach(n => {
        const p = projection([n.lon, n.lat]);
        n._ax = p ? p[0] : W/2;
        n._ay = p ? p[1] : H/2;
      });

      // ── Country color scale (article count) ──
      // Map feat.id → normalized country name for fast fill lookup
      const featCountryName = new Map();
      countries.features.forEach(feat => {
        const name = ISO_NAMES[+feat.id];
        if(name) featCountryName.set(+feat.id, normalizeCountry(name));
      });
      const maxCountryArt = Math.max(1, ...[...countryAuthorMap.values()].map(e => e.articleNums.size));
      // Accent RGB channels for the color gradient
      const accentRGB = theme==='light' ? [192,57,43] : theme==='warm' ? [232,160,64] : [91,159,255];
      // Transparent fill for countries with no data (still captures mouse events)
      const noDataFill = 'rgba(128,128,128,0.04)';

      function getCountryFill(feat){
        const cname = featCountryName.get(+feat.id);
        if(!cname) return noDataFill;
        const entry = countryAuthorMap.get(cname);
        if(!entry || entry.articleNums.size === 0) return noDataFill;
        // Power scale (exponent 0.35) compresses the high end so small countries
        // are still clearly visible even next to USA (75 arts) or Canada (41 arts)
        const t = Math.pow(entry.articleNums.size / maxCountryArt, 0.35);
        const opacity = Math.round((0.15 + t * 0.75) * 100) / 100;
        return `rgba(${accentRGB[0]},${accentRGB[1]},${accentRGB[2]},${opacity})`;
      }

      // ── Country path layer ──
      // Track last hovered feature to avoid re-triggering same tooltip
      let lastHoveredId = null;

      mapG.append('g').selectAll('path.country-path')
        .data(countries.features).join('path')
        .attr('class','country-path')
        .attr('d', path)
        .attr('fill', d => getCountryFill(d))
        .attr('stroke', colors.border)
        .attr('stroke-width', .4)
        .style('cursor', feat => countryAuthorMap.get(featCountryName.get(+feat.id))?.authors.length > 0 ? 'pointer' : 'default')
        .on('click', function(_ev, feat){
          const cname = featCountryName.get(+feat.id);
          if(!cname) return;
          const entry = countryAuthorMap.get(cname);
          if(!entry || entry.authors.length === 0) return;
          filterByCountry(cname);
        })
        .on('mouseover', function(event, feat){
          if(feat.id === lastHoveredId) return;
          lastHoveredId = feat.id;

          // Resolve country name: prefer ISO table, fallback to nearest node
          let countryName = ISO_NAMES[+feat.id];
          if(!countryName){
            const centroid = featCentroids.get(feat);
            if(centroid){
              let closestDist = Infinity;
              nodes.forEach(n=>{
                const dx=n._ax-centroid[0], dy=n._ay-centroid[1];
                const d=Math.sqrt(dx*dx+dy*dy);
                if(d < closestDist){ closestDist=d; countryName=n.country; }
              });
              if(closestDist > 80) countryName = null;
            }
          }

          // Highlight fill: boost opacity + accent border when country has data
          const normalizedName = countryName ? normalizeCountry(countryName) : null;
          const entry = normalizedName ? countryAuthorMap.get(normalizedName) : null;
          const hasData = entry && entry.articleNums.size > 0;
          if(hasData){
            const t = Math.pow(entry.articleNums.size / maxCountryArt, 0.35);
            const opacity = Math.min(0.92, 0.15 + t*0.75 + 0.18);
            d3.select(this)
              .attr('fill', `rgba(${accentRGB[0]},${accentRGB[1]},${accentRGB[2]},${opacity})`)
              .attr('stroke', `rgba(${accentRGB[0]},${accentRGB[1]},${accentRGB[2]},0.9)`)
              .attr('stroke-width', 1.5);
          } else {
            d3.select(this).attr('fill', `rgba(${accentRGB[0]},${accentRGB[1]},${accentRGB[2]},0.08)`);
          }

          if(!countryName){ ctip.style.display='none'; return; }

          let html = `<b>${normalizedName}</b>`;
          if(entry && entry.authors.length > 0){
            const artCount = entry.articleNums.size;
            html += `<br>${entry.authors.length} autor${entry.authors.length>1?'es':''} · ${artCount} artigo${artCount>1?'s':''}`;
            if(entry.firstAuthorArts > 0 || entry.collabArts > 0){
              html += `<br><span style="color:#66ee88">★ ${entry.firstAuthorArts} 1º autor</span> · <span style="color:#5b9fff">⟳ ${entry.collabArts} colab.</span>`;
            }
            html += `<br><span style="color:var(--dim);font-size:.6em">Clique para ver autores →</span>`;
          }
          ctip.innerHTML = html;
          ctip.style.display = 'block';
        })
        .on('mousemove', function(event){
          ctip.style.left = (event.clientX+14)+'px';
          ctip.style.top  = (event.clientY-28)+'px';
        })
        .on('mouseout', function(_ev, feat){
          lastHoveredId = null;
          d3.select(this)
            .attr('fill', getCountryFill(feat))
            .attr('stroke', colors.border)
            .attr('stroke-width', .4);
          ctip.style.display = 'none';
        });

      // Country mesh borders on top of fill
      mapG.append('path')
        .datum(topojson.mesh(world, world.objects.countries, (a,b)=>a!==b))
        .attr('d',path).attr('fill','none')
        .attr('stroke',colors.border).attr('stroke-width',.3);

      // ── D3 force: anchor-only, NO link force (intercontinental links must not pull nodes) ──
      // Nodes stay on their country; collision spreads them within territory.
      const simMap = d3.forceSimulation(nodes)
        .force('collide', d3.forceCollide(d => nodeR(d) * 1.45 + 2).strength(0.85))
        .force('anchorX', d3.forceX(d => d._ax).strength(0.92))
        .force('anchorY', d3.forceY(d => d._ay).strength(0.92))
        .alphaDecay(0.025)
        .velocityDecay(0.75)
        .stop();

      // Settle offline: spread nodes within country territory without link distortion
      for(let i=0; i<500; i++) simMap.tick();

      // ── Build lookups after settling ──
      const nodeById = new Map(nodes.map(n=>[n.id, n]));
      function edgeSrcId(d){ return typeof d.source==='object' ? d.source.id : d.source; }
      function edgeTgtId(d){ return typeof d.target==='object' ? d.target.id : d.target; }
      function getPos(id){ const n=nodeById.get(typeof id==='object'?id.id:id); return n ? {x:n.x||n._ax, y:n.y||n._ay} : {x:0,y:0}; }

      // Adjacency for click interactions
      const adjMap = new Map();
      edges.forEach(e=>{
        const s=edgeSrcId(e), t=edgeTgtId(e);
        if(!adjMap.has(s)) adjMap.set(s, new Map());
        if(!adjMap.has(t)) adjMap.set(t, new Map());
        adjMap.get(s).set(t, e.weight||1);
        adjMap.get(t).set(s, e.weight||1);
      });

      // ── Layers ──
      const edgeG = mapG.append('g').attr('class','map-edges');
      const nodeG = mapG.append('g').attr('class','map-nodes');
      const arcG  = mapG.append('g').attr('class','map-arcs').attr('pointer-events','none');

      // Draw edges (purely visual, no physics influence)
      const edgeSel = edgeG.selectAll('line')
        .data(edges).join('line')
        .attr('x1', d => getPos(edgeSrcId(d)).x)
        .attr('y1', d => getPos(edgeSrcId(d)).y)
        .attr('x2', d => getPos(edgeTgtId(d)).x)
        .attr('y2', d => getPos(edgeTgtId(d)).y)
        .attr('stroke', d => d.weight>=3 ? colors.linkStrong : d.weight===2 ? colors.linkMed : colors.linkWeak)
        .attr('stroke-width', d => d.weight>=3 ? 2.2 : d.weight===2 ? 1.2 : 0.6)
        .attr('stroke-opacity', 1);

      // Bezier arc for selected node connections
      function arcPath(src, tgt){
        const dx=tgt.x-src.x, dy=tgt.y-src.y;
        const dist=Math.sqrt(dx*dx+dy*dy);
        if(dist<1) return '';
        const mx=(src.x+tgt.x)/2, my=(src.y+tgt.y)/2;
        const curv=Math.min(dist*0.22,40);
        const cx=mx-dy/dist*curv, cy=my+dx/dist*curv;
        return `M${src.x},${src.y} Q${cx},${cy} ${tgt.x},${tgt.y}`;
      }

      let selectedNode = null;

      function drawArcs(d){
        arcG.selectAll('*').remove();
        if(!d) return;
        const connections = adjMap.get(d.id);
        if(!connections) return;
        const maxW = Math.max(...[...connections.values()]);
        connections.forEach((w, otherId)=>{
          const other = nodeById.get(otherId);
          if(!other) return;
          const normalized = w / Math.max(maxW, 1);
          const sw = 1.5 + w * 1.5;
          const op = 0.45 + normalized * 0.5;
          const col = w >= 3 ? colors.arcStrong : w === 2 ? colors.linkMed : colors.arcWeak;
          arcG.append('path')
            .datum({srcNode:d, other, weight:w})
            .attr('d', arcPath(d, other))
            .attr('fill','none').attr('stroke', col)
            .attr('stroke-width', sw).attr('stroke-linecap','round')
            .attr('stroke-opacity',0)
            .transition().duration(240).attr('stroke-opacity', op);
        });
      }

      function refreshArcs(){
        arcG.selectAll('path').attr('d', pd=>arcPath(pd.srcNode, pd.other));
      }

      // ── Draw nodes ──
      const nodeSel = nodeG.selectAll('circle')
        .data(nodes).join('circle')
        .attr('cx', d => d.x).attr('cy', d => d.y)
        .attr('r', d => nodeR(d) * 1.45)
        .attr('fill', d => getColor(d))
        .attr('opacity', 0.93)
        .attr('stroke', colors.nodeBorder)
        .attr('stroke-width', 0.8)
        .style('cursor', 'pointer')
        .call(d3.drag()
          .on('start', (event, d) => {
            if(!event.active) simMap.alphaTarget(0.3).restart();
            d.fx=d.x; d.fy=d.y;
          })
          .on('drag', (event, d) => {
            d.fx=event.x; d.fy=event.y;
          })
          .on('end', (event, d) => {
            if(!event.active) simMap.alphaTarget(0);
            // Release: strong anchor pulls node back to its country
            d.fx=null; d.fy=null;
            simMap.alpha(0.25).restart();
          })
        )
        .on('mouseover', (e,d) => {
          showTip(e,d);
          if(d !== selectedNode){
            d3.select(e.currentTarget)
              .transition().duration(120)
              .attr('r', nodeR(d)*2.1)
              .attr('stroke-width', 1.8)
              .attr('stroke', colors.highlight);
          }
        })
        .on('mousemove', moveTip)
        .on('mouseout', (e,d) => {
          hideTip();
          if(d !== selectedNode){
            d3.select(e.currentTarget)
              .transition().duration(180)
              .attr('r', nodeR(d)*1.45)
              .attr('stroke-width', 0.8)
              .attr('stroke', colors.nodeBorder);
          }
        })
        .on('click', (e,d) => {
          e.stopPropagation();
          selectedNode = d;
          const neighbors = adjMap.get(d.id) || new Map();
          const neighborIds = new Set(neighbors.keys());
          const allLinked = new Set([d.id, ...neighborIds]);

          nodeSel.transition().duration(220)
            .attr('r', n => {
              if(n.id===d.id) return nodeR(n)*2.8;
              if(neighborIds.has(n.id)) return nodeR(n)*1.8;
              return nodeR(n)*0.7;
            })
            .attr('opacity', n => allLinked.has(n.id) ? 0.98 : 0.1)
            .attr('stroke-width', n => n.id===d.id ? 3 : neighborIds.has(n.id) ? 1.5 : 0.5)
            .attr('stroke', n => n.id===d.id ? colors.highlight : neighborIds.has(n.id) ? colors.highlight+'99' : colors.nodeBorder);

          edgeSel.transition().duration(200)
            .attr('stroke-opacity', ed => {
              const s=edgeSrcId(ed), t=edgeTgtId(ed);
              return (s===d.id||t===d.id) ? 0 : 0.03;
            });

          drawArcs(d);
          openCard(NODE_MAP.get(d.id)||d);
        });

      // Reset on background click
      svg.on('click.mapReset', () => {
        selectedNode = null;
        arcG.selectAll('*').remove();
        nodeSel.transition().duration(250)
          .attr('r', d => nodeR(d)*1.45)
          .attr('opacity', 0.93)
          .attr('stroke-width', 0.8)
          .attr('stroke', colors.nodeBorder);
        edgeSel.transition().duration(200)
          .attr('stroke-opacity', 1)
          .attr('stroke-width', d => d.weight>=3 ? 2.2 : d.weight===2 ? 1.2 : 0.6);
      });

      function ticked(){
        nodeSel.attr('cx', d=>d.x).attr('cy', d=>d.y);
        edgeSel
          .attr('x1', d=>getPos(edgeSrcId(d)).x)
          .attr('y1', d=>getPos(edgeSrcId(d)).y)
          .attr('x2', d=>getPos(edgeTgtId(d)).x)
          .attr('y2', d=>getPos(edgeTgtId(d)).y);
        if(selectedNode) refreshArcs();
      }

      simMap.on('tick', ticked).alpha(0.05).restart();

      // Zoom to fit
      const xs = nodes.map(n=>n.x), ys = nodes.map(n=>n.y);
      const x0=Math.min(...xs)-20, x1=Math.max(...xs)+20;
      const y0=Math.min(...ys)-20, y1=Math.max(...ys)+20;
      const scale = Math.min(0.95*W/(x1-x0), 0.95*H/(y1-y0), 2);
      const tx = W/2 - scale*(x0+x1)/2;
      const ty = H/2 - scale*(y0+y1)/2;
      svg.call(zoomBeh.transform, d3.zoomIdentity.translate(tx,ty).scale(scale));
    })
    .catch(err=>{ console.error('Map error:', err); });
}
// Load topojson library if needed
(function loadTopojson(){
  if(window.topojson) return;
  const s=document.createElement('script');
  s.src='https://cdnjs.cloudflare.com/ajax/libs/topojson/3.0.2/topojson.min.js';
  document.head.appendChild(s);
})();

function doneLoading(){
  const l=document.getElementById('loading');
  if(l) {
    l.classList.add('gone');
    setTimeout(()=>l.style.display='none',700);
  }
}

window.addEventListener('load',()=>{
  buildFilters();
  setTheme('light');
  // Garantir que o mapa seja construído após o carregamento das bibliotecas e dados
  setTimeout(buildMap2D, 100);
});
