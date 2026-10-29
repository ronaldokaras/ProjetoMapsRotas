/* ================= CONFIGURAÇÃO DO SUPABASE ================= */
// COLOQUE SUAS CHAVES AQUI!
const SUPABASE_URL = 'https://lccwcadkhetxllmpcobw.supabase.co';
const SUPABASE_ANON_KEY = 'eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxjY3djYWRraGV0eGxsbXBjb2J3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMyMTg4MzksImV4cCI6MjEwODc5NDgzOX0';
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ================= MAPA ================= */
const map = L.map('map').setView([-25.4284, -49.2733], 14);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);

/* ================= ESTADO ================= */
let startPoint = null, endPoint = null;
let startMarker = null, endMarker = null, routeLayer = null;
let loading = false;
let currentMode = 'driving'; // 'driving', 'motorcycle', 'foot'

/* ================= UI ================= */
const statusEl   = document.getElementById('status');
const infoEl     = document.getElementById('info');
const distEl     = document.getElementById('dist');
const durEl      = document.getElementById('dur');
const costEl     = document.getElementById('cost');
const resetBtn   = document.getElementById('resetBtn');
const routeBtn   = document.getElementById('routeBtn');
const swapBtn    = document.getElementById('swapBtn');
const stepStart  = document.getElementById('stepStart');
const stepEnd    = document.getElementById('stepEnd');
const inputOrigem  = document.getElementById('inputOrigem');
const inputDestino = document.getElementById('inputDestino');
const sugA    = document.getElementById('sugA');
const sugB    = document.getElementById('sugB');
const ghostA  = document.getElementById('ghostA');
const ghostB  = document.getElementById('ghostB');
const geoBtn  = document.getElementById('geoBtn');

/* ================= ÍCONES E HELPERS ================= */
const makeIcon = color => L.divIcon({ className: '', html: `<div class="pin" style="background:${color}"></div>`, iconSize: [22, 22], iconAnchor: [11, 11] });
const startIcon = makeIcon('#16a34a');
const endIcon   = makeIcon('#dc2626');

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function formatDistance(m) { return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`; }
function formatDuration(s) {
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60), r = m % 60;
    return r ? `${h} h ${r} min` : `${h} h`;
}
function formatCurrency(value) { return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value); }
function setStatus(msg, type = 'info', spin = false) { statusEl.className = 'status' + (type === 'ok' ? ' ok' : type === 'error' ? ' error' : ''); statusEl.innerHTML = (spin ? '<span class="spinner"></span>' : '') + msg; }
function updateSteps() {
    stepStart.className = 'step start' + (!startPoint ? ' active' : ' done');
    stepEnd.className = 'step end' + (startPoint && !endPoint ? ' active' : (startPoint && endPoint ? ' done' : ''));
}
function updateButtons() { resetBtn.disabled = !(startPoint || endPoint); routeBtn.disabled = !(startPoint && endPoint) || loading; routeBtn.textContent = loading ? 'Calculando…' : 'Calcular Rota'; }
function syncInputs() {
    inputOrigem.value  = startPoint ? (startPoint.name || `${startPoint.lat.toFixed(5)}, ${startPoint.lng.toFixed(5)}`) : '';
    inputDestino.value = endPoint ? (endPoint.name || `${endPoint.lat.toFixed(5)}, ${endPoint.lng.toFixed(5)}`) : '';
    ghostA.innerHTML = ''; ghostB.innerHTML = '';
}
function clearRoute() { if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; } infoEl.hidden = true; distEl.textContent = '—'; durEl.textContent  = '—'; costEl.textContent = '—'; }

/* ================= NOMINATIM (Busca) ================= */
const ROAD_TYPES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'service', 'living_street', 'pedestrian']);
function isStreetFeature(f) { const p = f.properties || {}; return p.osm_key === 'highway' || (p.osm_key === 'place' && p.osm_value === 'house'); }
function getStreetName(p) { return p.street || p.name || ''; }
function getCompletionName(p) { const s = getStreetName(p); return p.housenumber ? `${s} ${p.housenumber}` : s; }
function formatResultMain(p) { const s = getStreetName(p); return s ? (p.housenumber ? `${s}, ${p.housenumber}` : s) : '(sem nome)'; }
function formatResultContext(p) { const parts = []; if (p.city) parts.push(p.city); if (p.state) parts.push(p.state); return parts.join(' · '); }
function formatResultAddress(p) { const m = formatResultMain(p); const c = formatResultContext(p); return c ? `${m} - ${c}` : m; }

async function searchStreets(query) {
    const c = map.getCenter();
    const url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=20&q=${encodeURIComponent(query)}&viewbox=${c.lng-0.5},${c.lat+0.5},${c.lng+0.5},${c.lat-0.5}&bounded=0&accept-language=pt-BR`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.map(item => ({
        type: "Feature", geometry: { type: "Point", coordinates: [parseFloat(item.lon), parseFloat(item.lat)] },
        properties: { osm_key: "highway", name: item.address?.road || item.display_name.split(',')[0], street: item.address?.road || '', housenumber: item.address?.house_number || '', city: item.address?.city || item.address?.town, state: item.address?.state }
    })).filter(isStreetFeature);
}

async function reverseGeocode(lat, lng) {
    try {
        const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1&accept-language=pt-BR`);
        const data = await res.json();
        if (!data || !data.address) return null;
        const road = data.address.road || data.address.pedestrian || '';
        const city = data.address.city || data.address.town || '';
        return road ? `${road}${data.address.house_number ? ', ' + data.address.house_number : ''} - ${city}` : data.display_name;
    } catch { return null; }
}

/* ================= GHOST TEXT E MARCADORES ================= */
function updateGhostFromResults(input, ghostEl, results) {
    const val = input.value; if (!val) { ghostEl.innerHTML = ''; return; }
    for (const r of results) {
        const name = getCompletionName(r.properties || {});
        if (name && name.toLowerCase().startsWith(val.toLowerCase()) && name.length > val.length) {
            ghostEl.innerHTML = `<span class="typed">${escapeHtml(val)}</span><span class="rest">${escapeHtml(name.slice(val.length))}</span>`;
            return;
        }
    }
    ghostEl.innerHTML = '';
}
function clearGhost(ghostEl) { ghostEl.innerHTML = ''; }

function createMarker(lat, lng, isStart, name) {
    const marker = L.marker([lat, lng], { icon: isStart ? startIcon : endIcon, draggable: true }).addTo(map);
    marker.bindPopup(name ? `${isStart ? '📍' : '🏁'} ${escapeHtml(name)}` : (isStart ? '📍 Origem' : '🏁 Destino'));
    marker.on('dragend', async e => {
        const pos = e.target.getLatLng();
        const point = isStart ? setStart(pos.lat, pos.lng) : setEnd(pos.lat, pos.lng);
        const nm = await reverseGeocode(pos.lat, pos.lng);
        if (nm) { point.name = nm; syncInputs(); marker.setPopupContent(`${isStart ? '📍' : '🏁'} ${escapeHtml(nm)}`); }
    });
    return marker;
}

function setStart(lat, lng, name = null) {
    clearRoute(); startPoint = { lat, lng, name };
    if (startMarker) { startMarker.setLatLng([lat, lng]); startMarker.setPopupContent(name ? `📍 ${escapeHtml(name)}` : '📍 Origem'); }
    else startMarker = createMarker(lat, lng, true, name);
    syncInputs(); updateSteps(); updateButtons();
    if (endPoint) calcularRota(); else setStatus('Origem definida. Agora defina o <strong>destino (B)</strong>.');
    return startPoint;
}

function setEnd(lat, lng, name = null) {
    clearRoute(); endPoint = { lat, lng, name };
    if (endMarker) { endMarker.setLatLng([lat, lng]); endMarker.setPopupContent(name ? `🏁 ${escapeHtml(name)}` : '🏁 Destino'); }
    else endMarker = createMarker(lat, lng, false, name);
    syncInputs(); updateSteps(); updateButtons();
    if (startPoint) calcularRota();
    return endPoint;
}

map.on('click', async e => {
    if (loading) return;
    const { lat, lng } = e.latlng;
    const point = !startPoint ? setStart(lat, lng) : setEnd(lat, lng);
    const name = await reverseGeocode(lat, lng);
    if (name) { point.name = name; syncInputs(); (startPoint === point ? startMarker : endMarker).setPopupContent(`📍 ${escapeHtml(name)}`); }
});

/* ================= AUTOCOMPLETE ================= */
function setupAutocomplete(input, ghostEl, sugEl, isStart) {
    let results = [];
    const runSearch = debounce(async () => {
        const q = input.value.trim();
        if (q.length < 3) { results = []; sugEl.hidden = true; updateGhostFromResults(input, ghostEl, results); return; }
        sugEl.hidden = false; sugEl.innerHTML = '<div class="sug-loading">Buscando ruas…</div>';
        try {
            results = await searchStreets(q);
            if (!results.length) { sugEl.innerHTML = '<div class="sug-empty">Nenhuma rua encontrada</div>'; return; }
            sugEl.innerHTML = results.map((r, i) => `<div class="sug-item" data-idx="${i}"><div class="sug-main">${escapeHtml(formatResultMain(r.properties))}</div><div class="sug-rest">${escapeHtml(formatResultContext(r.properties))}</div></div>`).join('');
            sugEl.querySelectorAll('.sug-item').forEach(el => el.addEventListener('mousedown', ev => { ev.preventDefault(); choose(results[+el.dataset.idx]); }));
            updateGhostFromResults(input, ghostEl, results);
        } catch (err) { sugEl.innerHTML = '<div class="sug-empty">Erro ao buscar.</div>'; }
    }, 500);

    function choose(feature) {
        if (!feature) return;
        sugEl.hidden = true; clearGhost(ghostEl);
        const [lng, lat] = feature.geometry.coordinates;
        const name = formatResultAddress(feature.properties);
        if (isStart) setStart(lat, lng, name); else setEnd(lat, lng, name);
        map.setView([lat, lng], 16); input.blur();
    }

    input.addEventListener('input', () => { updateGhostFromResults(input, ghostEl, results); runSearch(); });
    input.addEventListener('focus', () => { if (results.length) { sugEl.hidden = false; updateGhostFromResults(input, ghostEl, results); } });
    input.addEventListener('blur', () => { setTimeout(() => sugEl.hidden = true, 150); clearGhost(ghostEl); });
    input.addEventListener('keydown', async e => {
        if (e.key === 'Tab' && ghostEl.querySelector('.rest')) { e.preventDefault(); input.value += ghostEl.querySelector('.rest').textContent; clearGhost(ghostEl); runSearch(); return; }
        if (e.key === 'Enter') {
            e.preventDefault();
            if (results.length) { choose(results[0]); return; }
            const q = input.value.trim(); if (!q) return;
            try { const f = await searchStreets(q); if (f.length) choose(f[0]); else setStatus('Rua não encontrada.', 'error'); } catch { setStatus('Erro.', 'error'); }
        }
    });
}

/* ================= GEOLOCALIZAÇÃO E INVERTER ================= */
geoBtn.addEventListener('click', () => {
    if (!navigator.geolocation) return setStatus('Geolocalização não suportada.', 'error');
    setStatus('Obtendo localização…', 'info', true);
    navigator.geolocation.getCurrentPosition(
        async pos => {
            const { latitude: lat, longitude: lng } = pos.coords;
            const point = setStart(lat, lng); map.setView([lat, lng], 16);
            const nm = await reverseGeocode(lat, lng);
            if (nm) { point.name = nm; syncInputs(); startMarker.setPopupContent(`📍 ${escapeHtml(nm)}`); }
        }, err => setStatus(`Erro: ${err.message}`, 'error'), { enableHighAccuracy: true, timeout: 10000 }
    );
});

swapBtn.addEventListener('click', () => {
    if (!startPoint && !endPoint) return;
    [startPoint, endPoint] = [endPoint, startPoint];
    if (startMarker) { map.removeLayer(startMarker); startMarker = null; }
    if (endMarker) { map.removeLayer(endMarker); endMarker = null; }
    clearRoute();
    if (startPoint) startMarker = createMarker(startPoint.lat, startPoint.lng, true, startPoint.name);
    if (endPoint) endMarker = createMarker(endPoint.lat, endPoint.lng, false, endPoint.name);
    syncInputs(); updateSteps(); updateButtons();
    if (startPoint && endPoint) calcularRota();
});

/* ================= SELETOR DE TRANSPORTE ================= */
document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentMode = btn.dataset.mode;
        
        // Se já tiver pontos no mapa, recalcula automaticamente
        if (startPoint && endPoint) calcularRota();
    });
});

/* ================= CÁLCULO DE CUSTO ================= */
function calcularCusto(mode, distanciaMetros, duracaoSegundos) {
    const km = distanciaMetros / 1000;
    const min = duracaoSegundos / 60;
    
    if (mode === 'foot') return 0;
    if (mode === 'motorcycle') return 3.00 + (km * 0.80) + (min * 0.15);
    return 5.00 + (km * 1.50) + (min * 0.30);
}

/* ================= CÁLCULO DE ROTA ================= */
async function calcularRota() {
    if (!startPoint || !endPoint) return;
    clearRoute(); loading = true; updateButtons(); setStatus('Calculando rota…', 'info', true);

    let rotaDesenhada = false;
    let fonteRota = "";
    let distanciaFinal = 0;
    let duracaoFinal = 0;
    
    const cores = { driving: '#16a34a', motorcycle: '#ea580c', foot: '#9333ea' };
    const corRota = cores[currentMode];

    // ---- TENTATIVA 1: PostGIS (Supabase) ----
    try {
        const { data, error } = await supabaseClient.rpc('get_route', {
            start_lat: startPoint.lat, start_lng: startPoint.lng,
            end_lat: endPoint.lat, end_lng: endPoint.lng
        });

        if (!error && data && data.geometry) {
            routeLayer = L.geoJSON(data.geometry, {
                style: { color: corRota, weight: 6, opacity: 0.85, lineCap: 'round', lineJoin: 'round' }
            }).addTo(map);
            
            distanciaFinal = data.distance;
            
            // Cálculo customizado baseado na velocidade de cada meio
            if (currentMode === 'foot') duracaoFinal = distanciaFinal / 1.4; // ~5 km/h
            else if (currentMode === 'motorcycle') duracaoFinal = distanciaFinal / 16.6; // ~60 km/h
            else duracaoFinal = distanciaFinal / 13.8; // ~50 km/h
            
            distEl.textContent = formatDistance(distanciaFinal);
            durEl.textContent  = formatDuration(duracaoFinal);
            infoEl.hidden = false;
            fonteRota = "PostGIS";
            rotaDesenhada = true;
        }
    } catch (err) { console.log("PostGIS falhou. Usando OSRM..."); }

    // ---- TENTATIVA 2: OSRM (Fallback) ----
    if (!rotaDesenhada) {
        try {
            // OSRM público só suporta 'driving'. Usamos driving para todos e ajustamos o tempo depois.
            const url = `https://router.project-osrm.org/route/v1/driving/${startPoint.lng},${startPoint.lat};${endPoint.lng},${endPoint.lat}?overview=full&geometries=geojson`;
            
            const res = await fetch(url);
            const data = await res.json();

            if (data.routes && data.routes.length > 0) {
                const route = data.routes[0];
                routeLayer = L.geoJSON(route.geometry, {
                    style: { color: corRota, weight: 6, opacity: 0.85, lineCap: 'round', lineJoin: 'round' }
                }).addTo(map);

                distanciaFinal = route.distance;
                
                // 🔥 CORREÇÃO MÁGICA AQUI: Forçamos o tempo a mudar mesmo usando a base do OSRM
                if (currentMode === 'foot') duracaoFinal = distanciaFinal / 1.4; 
                else if (currentMode === 'motorcycle') duracaoFinal = distanciaFinal / 16.6; 
                else duracaoFinal = route.duration; // Carro usa o padrão do OSRM
                
                distEl.textContent = formatDistance(distanciaFinal);
                durEl.textContent  = formatDuration(duracaoFinal);
                infoEl.hidden = false;
                fonteRota = "OSRM";
                rotaDesenhada = true;
            }
        } catch (err) { console.error("OSRM falhou:", err); }
    }

    // ---- Finalização e Salvamento ----
    if (rotaDesenhada) {
        const custoEstimado = calcularCusto(currentMode, distanciaFinal, duracaoFinal);
        costEl.textContent = custoEstimado === 0 ? 'Grátis' : formatCurrency(custoEstimado);
        
        map.fitBounds(routeLayer.getBounds(), { paddingTopLeft: [380, 60], paddingBottomRight: [60, 60] });
        
        // 🔥 AJUSTADO PARA MOSTRAR O MODO NO STATUS, SEM FALAR DE BANCO
        const nomeModo = currentMode === 'foot' ? 'A pé' : currentMode === 'motorcycle' ? 'Moto' : 'Carro';
        setStatus(`Rota de ${nomeModo} calculada com sucesso!`, 'ok');
        
        await salvarNoBanco(distanciaFinal, duracaoFinal, custoEstimado, fonteRota);
    } else {
        setStatus('Não foi possível calcular a rota.', 'error');
    }

    loading = false; updateButtons();
}

// Salvamento silencioso no banco (sem poluir a tela)
async function salvarNoBanco(distancia, duracao, custo, fonte) {
    try {
        const payload = {
            origem_nome: startPoint.name || 'Origem',
            origem_lat: startPoint.lat, origem_lng: startPoint.lng,
            origem_geo: `POINT(${startPoint.lng} ${startPoint.lat})`,
            destino_nome: endPoint.name || 'Destino',
            destino_lat: endPoint.lat, destino_lng: endPoint.lng,
            destino_geo: `POINT(${endPoint.lng} ${endPoint.lat})`,
            distancia: distancia, duracao: duracao, custo: custo,
            modo: currentMode, fonte: fonte
        };

        const { error } = await supabaseClient.from('historico_rotas').insert(payload);
        if (!error) console.log(`✅ Rota via ${fonte} salva no banco com sucesso!`);
    } catch (err) { console.error("❌ Erro ao salvar no banco:", err); }
}

/* ================= RESET E INIT ================= */
function resetAll() {
    if (startMarker) map.removeLayer(startMarker);
    if (endMarker) map.removeLayer(endMarker);
    clearRoute(); startPoint = endPoint = null; startMarker = endMarker = null;
    inputOrigem.value = ''; inputDestino.value = ''; sugA.hidden = true; sugB.hidden = true;
    clearGhost(ghostA); clearGhost(ghostB); updateSteps(); updateButtons();
    setStatus('Digite uma rua/avenida ou clique no mapa para marcar a <strong>origem (A)</strong>.');
}
resetBtn.addEventListener('click', resetAll);

setupAutocomplete(inputOrigem, ghostA, sugA, true);
setupAutocomplete(inputDestino, ghostB, sugB, false);
updateSteps(); updateButtons();