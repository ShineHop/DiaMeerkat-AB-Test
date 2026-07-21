/* Medical LLM A/B/C Test — vanilla JS app (3-model blind evaluation) */
(() => {
  'use strict';

  const STORAGE_KEY = 'abc_test_eval_results_v1';
  const EVALUATOR_KEY = 'abc_test_evaluator_v1';
  // Optional local convenience only. On a public host this 404s and the app
  // falls back to the file picker, so patient EMR data is never served.
  const DATA_URL = 'abc_test_emr_0.14k.jsonl';

  // Real model keys present in each record.
  const MODELS = ['meerkat', 'gpt5_4', 'gemma4'];
  // Blind slots shown to the evaluator; real model stays hidden behind these.
  const SLOTS = ['A', 'B', 'C'];
  const SLOT_LABEL = { A: 'Model A', B: 'Model B', C: 'Model C' };

  const SCORE_DOMAINS = [
    { key: 'clinical_safety', title: '1-1. 임상적 안전성 및 타당성',
      desc: '환자의 현재 상태, 검사 수치, 동반질환, 기존 치료력을 고려했을 때 처방 제안이 의학적으로 타당하고 안전한가?' },
    { key: 'insurance_compliance', title: '1-2. 보험·제도 부합성 및 실제 처방 가능성',
      desc: '국내 보험 급여 기준과 실제 외래 처방 관행을 고려했을 때, 제안된 처방이 현실적으로 처방 가능한가?' },
    { key: 'usability', title: '1-3. 외래 활용성 및 가독성',
      desc: '바쁜 외래 환경에서 의사가 빠르게 읽고 처방 의사결정에 활용하기 쉬운가?' },
  ];

  const DEDUCTIONS = [
    '절대 금기 약물 포함 (임상 안전 위반)',
    '환자의 특정 기저질환(예: 신기능 저하 eGFR) 누락/미반영',
    '불필요한 과잉 처방 (Over-expansion)',
    '명백한 국내 보험 규정 위반 (삭감 대상)',
    '의학적 사실 왜곡 (Hallucination)',
    '기존 처방 체계 보존 실패/ 불필요한 처방 변경',
  ];

  const PREFERENCES = [
    'A 답변을 가장 참고하고 싶음',
    'B 답변을 가장 참고하고 싶음',
    'C 답변을 가장 참고하고 싶음',
    '세 답변 간 처방 보조 관점에서 유의미한 차이 없음',
    '세 답변 모두 실제 처방 보조 도구로 사용하기 어려움',
  ];

  // Common keys shared by all 3 models, rendered aligned side-by-side.
  const ANSWER_SECTIONS = [
    { key: 'patient_status_analysis', sub: null, title: '① 환자 상태 분석 (Patient Status)' },
    { key: 'prescription_recommendation', sub: 'covered_by_insurance', title: '② 처방 추천 — 급여 가능 (Covered by Insurance)' },
    { key: 'prescription_recommendation', sub: 'non_covered_or_alternative', title: '③ 처방 추천 — 비급여 / 대체 (Non-covered / Alternative)' },
    { key: 'prescription_recommendation', sub: 'other_medications', title: '④ 처방 추천 — 기타 약물 (Other Medications)' },
    { key: 'prescription_recommendation', sub: 'general', title: '⑤ 처방 추천 — 일반 (General)' },
    { key: 'prescription_rationale', sub: null, title: '⑥ 처방 근거 (Rationale)' },
    { key: 'monitoring_and_additional_recommendation', sub: null, title: '⑦ 모니터링 및 추가 권고 (Monitoring)' },
    { key: 'unclassified', sub: null, title: '⑧ 미분류 (Unclassified)' },
  ];

  /** @type {Array<any>} */
  let cases = [];
  let currentId = null;
  /** @type {Record<string, any>} */
  let results = {};
  let evaluator = null;

  // ---------------------------------------------------------------------------
  // Blind mapping — deterministic per case (stable across reruns/sessions)
  // ---------------------------------------------------------------------------
  const hashSeed = (str) => {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  };
  const mulberry32 = (a) => () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const modelMapping = (id) => {
    const rng = mulberry32(hashSeed(String(id)));
    const m = MODELS.slice();
    for (let i = m.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [m[i], m[j]] = [m[j], m[i]];
    }
    return { A: m[0], B: m[1], C: m[2] };
  };

  const getSectionText = (block, key, sub) => {
    let v = block ? block[key] : null;
    if (sub) v = (v && typeof v === 'object') ? v[sub] : null;
    return (typeof v === 'string') ? v.trim() : '';
  };

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------
  const loadResults = () => {
    try { const raw = localStorage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) : {}; }
    catch { return {}; }
  };
  const saveResults = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(results));

  const loadEvaluator = () => {
    try { const raw = localStorage.getItem(EVALUATOR_KEY); return raw ? JSON.parse(raw) : null; }
    catch { return null; }
  };
  const saveEvaluator = () => localStorage.setItem(EVALUATOR_KEY, JSON.stringify(evaluator));

  const defaultRecord = () => ({
    is_completed: false,
    scores: Object.fromEntries(SLOTS.map(s => [s, Object.fromEntries(SCORE_DOMAINS.map(d => [d.key, 3]))])),
    deductions: Object.fromEntries(SLOTS.map(s => [s, []])),
    preference: null,
    saved_at: null,
  });

  const ensureRecord = (id) => {
    if (!results[id]) results[id] = defaultRecord();
    return results[id];
  };

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  const $ = (sel) => document.querySelector(sel);
  const md = (s) => marked.parse(s || '_(내용 없음)_');

  const updateProgress = () => {
    const total = cases.length;
    const done = cases.filter(c => results[c.id]?.is_completed).length;
    const pct = total ? (done / total) * 100 : 0;
    $('#progress-label').textContent = `${done} / ${total} Completed (${pct.toFixed(1)}%)`;
    $('#progress-bar').style.width = `${pct}%`;
    $('#case-count').textContent = total;
  };

  const renderCaseList = () => {
    const ul = $('#case-list');
    ul.innerHTML = '';
    cases.forEach(c => {
      const rec = ensureRecord(c.id);
      const li = document.createElement('li');
      li.className = 'case-item' + (c.id === currentId ? ' active' : '') + (rec.is_completed ? ' completed' : '');
      li.innerHTML = `
        <span class="dot"></span>
        <span class="flex-1 truncate">Case ${escapeHtml(c.id)}</span>
        <span class="text-[10px] text-slate-400">${rec.is_completed ? '✓' : ''}</span>
      `;
      li.addEventListener('click', () => selectCase(c.id));
      ul.appendChild(li);
    });
  };

  const renderEMR = (c) => {
    const emr = c.emr || {};
    const prev = (emr.previous_prescription || []).map(p => `<li>${escapeHtml(p)}</li>`).join('') || '<li class="text-slate-400">(없음)</li>';
    const ans = (emr.answer_prescription || []).map(p => `<li>${escapeHtml(p)}</li>`).join('') || '<li class="text-slate-400">(없음)</li>';

    $('#emr-card').innerHTML = `
      <div class="flex items-center justify-between mb-3">
        <div class="flex items-center gap-2">
          <span class="text-xs px-2 py-0.5 rounded bg-slate-900 text-white font-mono">Case ${escapeHtml(c.id)}</span>
          <h2 class="text-base font-semibold text-slate-800">🏥 EMR — 외래 기록</h2>
        </div>
        <span class="text-xs text-slate-400">source: ${escapeHtml(emr.source ?? '-')}</span>
      </div>

      <p class="text-xs font-semibold text-slate-600 mb-1">📄 외래 경과 기록 (Outpatient Note) — EMR 내용</p>
      <pre class="emr-note">${escapeHtml(emr.outpatient_note || '-')}</pre>

      <div class="mt-4">
        <p class="text-xs font-semibold text-slate-600 mb-1">💊 이전 처방 (Previous Prescription)</p>
        <ul class="text-sm list-disc pl-5 space-y-0.5 border border-slate-200 rounded-lg p-3 bg-slate-50/50">${prev}</ul>
      </div>

      <details class="mt-4 rounded-lg border border-amber-200 bg-amber-50/60 p-3">
        <summary class="cursor-pointer text-sm font-semibold text-amber-900 select-none">✅ 현재 처방 (Answer Prescription) — 필요 시 펼쳐 보기</summary>
        <p class="text-xs text-amber-800 mt-2 mb-2">⚠️ 실제 처방(정답)입니다. 모델 답변 평가 시 정답에 끌려가는 편향(anchoring)을 막기 위해 기본 숨김 처리했습니다. 판단이 어려울 때만 참고하세요.</p>
        <ul class="text-sm list-disc pl-5 space-y-0.5">${ans}</ul>
      </details>
    `;
  };

  const renderComparison = (c) => {
    const mapping = modelMapping(c.id);
    const wrap = $('#comparison');

    const badgeColor = { A: 'bg-sky-500', B: 'bg-violet-500', C: 'bg-amber-500' };
    const headerCols = SLOTS.map(s => `
      <div class="cmp-head">
        <span class="w-7 h-7 rounded-md ${badgeColor[s]} text-white flex items-center justify-center text-xs font-bold">${s}</span>
        <span class="text-sm font-semibold text-slate-700">${SLOT_LABEL[s]}</span>
      </div>`).join('');

    let sectionsHtml = '';
    ANSWER_SECTIONS.forEach(sec => {
      const texts = SLOTS.map(s => getSectionText(c[mapping[s]], sec.key, sec.sub));
      if (!texts.some(t => t)) return; // hide sections empty across all models
      const cols = SLOTS.map((s, i) => `
        <div class="cmp-cell">
          <div class="md-body prose prose-sm max-w-none">${texts[i] ? md(texts[i]) : '<span class="text-slate-400 text-sm">(내용 없음)</span>'}</div>
        </div>`).join('');
      sectionsHtml += `
        <div class="cmp-section">
          <p class="cmp-title">${escapeHtml(sec.title)}</p>
          <div class="cmp-grid">${cols}</div>
        </div>`;
    });

    const rawCols = SLOTS.map(s => {
      const raw = (c[mapping[s]] && c[mapping[s]].raw_llm_output || '').trim();
      return `
        <details class="cmp-raw">
          <summary class="cursor-pointer text-xs font-semibold text-slate-600 select-none">🔍 ${SLOT_LABEL[s]} — raw_llm_output 보기</summary>
          <div class="md-body prose prose-sm max-w-none mt-2">${raw ? md(raw) : '<span class="text-slate-400 text-sm">(없음)</span>'}</div>
        </details>`;
    }).join('');

    wrap.innerHTML = `
      <div class="bg-white border border-slate-200 rounded-xl p-4">
        <div class="flex items-center justify-between mb-1">
          <h2 class="text-base font-semibold text-slate-800">🆚 모델 답변 비교 (블라인드 A / B / C)</h2>
        </div>
        <p class="text-xs text-slate-500 mb-3">각 공통 항목별로 세 모델(A/B/C)의 답변을 같은 행에 나란히 배치했습니다. 컬럼 위치(A→B→C)는 모든 항목에서 동일합니다.</p>
        <div class="cmp-grid cmp-header">${headerCols}</div>
        <div class="mt-2 space-y-4">${sectionsHtml}</div>
        <p class="cmp-title mt-4">🔍 원본 모델 답변 (Raw Output) — 필요 시 펼쳐 보기</p>
        <div class="cmp-grid">${rawCols}</div>
      </div>`;
  };

  const renderEvaluationForm = (c) => {
    const rec = ensureRecord(c.id);
    const badgeText = { A: 'text-sky-700', B: 'text-violet-700', C: 'text-amber-700' };
    const cellBg = { A: 'bg-sky-50/40', B: 'bg-violet-50/40', C: 'bg-amber-50/40' };

    // 1. comprehensive scores
    const compEl = $('#form-comprehensive');
    compEl.innerHTML = '';
    SCORE_DOMAINS.forEach(d => {
      const block = document.createElement('div');
      block.innerHTML = `
        <h4 class="text-sm font-semibold text-slate-700">${escapeHtml(d.title)}</h4>
        <p class="text-xs text-slate-500 mt-0.5 mb-3">${escapeHtml(d.desc)}</p>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          ${SLOTS.map(side => `
            <div class="border border-slate-200 rounded-lg p-3 ${cellBg[side]}">
              <div class="flex items-center justify-between mb-2">
                <span class="text-xs font-semibold ${badgeText[side]}">${SLOT_LABEL[side]}</span>
                <span class="score-pill" data-pill="${side}-${d.key}">${rec.scores[side][d.key]}</span>
              </div>
              <input type="range" min="1" max="5" step="1" value="${rec.scores[side][d.key]}"
                     class="score-slider" data-side="${side}" data-domain="${d.key}" />
              <div class="flex justify-between text-[10px] text-slate-400 mt-1 px-0.5">
                <span>1</span><span>2</span><span>3</span><span>4</span><span>5</span>
              </div>
            </div>
          `).join('')}
        </div>
      `;
      compEl.appendChild(block);
    });

    // 2. deductions
    const dedGrid = $('#deductions-grid');
    dedGrid.innerHTML = SLOTS.map(side => `
      <div>
        <p class="text-xs font-semibold ${badgeText[side]} mb-2">${SLOT_LABEL[side]}</p>
        <div id="deductions-${side}" class="space-y-1.5"></div>
      </div>`).join('');
    SLOTS.forEach(side => {
      const wrap = document.querySelector(`#deductions-${side}`);
      DEDUCTIONS.forEach(opt => {
        const id = `ded-${side}-${slug(opt)}`;
        const checked = rec.deductions[side].includes(opt) ? 'checked' : '';
        wrap.insertAdjacentHTML('beforeend', `
          <label class="flex items-start gap-2 text-sm cursor-pointer hover:bg-slate-50 rounded px-1.5 py-1">
            <input id="${id}" type="checkbox" class="mt-0.5 accent-emerald-600" data-side="${side}" data-opt="${escapeHtml(opt)}" ${checked} />
            <span class="text-slate-700">${escapeHtml(opt)}</span>
          </label>`);
      });
    });

    // 3. preference
    const prefEl = $('#preference-group');
    prefEl.innerHTML = '';
    PREFERENCES.forEach((opt, i) => {
      const checked = rec.preference === opt ? 'checked' : '';
      prefEl.insertAdjacentHTML('beforeend', `
        <label class="flex items-center gap-2 text-sm cursor-pointer hover:bg-slate-50 rounded px-1.5 py-1">
          <input id="pref-${i}" type="radio" name="preference" class="accent-emerald-600" value="${escapeHtml(opt)}" ${checked} />
          <span class="text-slate-700">${escapeHtml(opt)}</span>
        </label>`);
    });

    updateSaveStatus(c.id);
    bindFormEvents(c.id);
  };

  const bindFormEvents = (caseId) => {
    document.querySelectorAll('.score-slider').forEach(el => {
      el.addEventListener('input', () => {
        const { side, domain } = el.dataset;
        const val = Number(el.value);
        ensureRecord(caseId).scores[side][domain] = val;
        const pill = document.querySelector(`[data-pill="${side}-${domain}"]`);
        if (pill) pill.textContent = val;
        saveResults();
      });
    });
    document.querySelectorAll('#deductions-grid input').forEach(el => {
      el.addEventListener('change', () => {
        const { side, opt } = el.dataset;
        const list = ensureRecord(caseId).deductions[side];
        const idx = list.indexOf(opt);
        if (el.checked && idx === -1) list.push(opt);
        if (!el.checked && idx !== -1) list.splice(idx, 1);
        saveResults();
      });
    });
    document.querySelectorAll('input[name="preference"]').forEach(el => {
      el.addEventListener('change', () => {
        ensureRecord(caseId).preference = el.value;
        saveResults();
      });
    });
  };

  const updateSaveStatus = (id) => {
    const rec = ensureRecord(id);
    const el = $('#save-status');
    if (rec.is_completed) {
      el.innerHTML = `<span class="inline-flex items-center gap-1.5"><span class="w-2 h-2 rounded-full bg-emerald-500"></span> 완료 — 마지막 저장: <span class="mono">${escapeHtml(rec.saved_at || '')}</span></span>`;
    } else {
      el.innerHTML = `<span class="inline-flex items-center gap-1.5"><span class="w-2 h-2 rounded-full bg-slate-300"></span> 아직 저장되지 않음</span>`;
    }
  };

  // ---------------------------------------------------------------------------
  // Selection / actions
  // ---------------------------------------------------------------------------
  const selectCase = (id) => {
    currentId = id;
    const c = cases.find(x => x.id === id);
    if (!c) return;
    renderCaseList();
    renderEMR(c);
    renderComparison(c);
    renderEvaluationForm(c);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const saveCurrent = () => {
    if (!currentId) return;
    const rec = ensureRecord(currentId);
    rec.is_completed = true;
    rec.saved_at = new Date().toISOString().slice(0, 19);
    saveResults();
    renderCaseList();
    updateProgress();
    updateSaveStatus(currentId);
    toast(`✅ Case ${currentId} 평가가 저장되었습니다.`);
  };

  const exportJSONL = () => {
    if (!evaluator) {
      openEvaluatorModal(false);
      toast('먼저 평가자 정보를 입력해 주세요.');
      return;
    }
    if (!cases.length) { toast('내보낼 데이터가 없습니다.'); return; }
    const exported_at = new Date().toISOString().slice(0, 19);
    const lines = cases.map(c => {
      const rec = ensureRecord(c.id);
      const mapping = modelMapping(c.id); // slot -> real model
      const scores_by_model = {};
      const deductions_by_model = {};
      SLOTS.forEach(s => { scores_by_model[mapping[s]] = rec.scores[s]; deductions_by_model[mapping[s]] = rec.deductions[s]; });
      let preferred_model = null;
      const pIdx = PREFERENCES.indexOf(rec.preference);
      if (pIdx >= 0 && pIdx < 3) preferred_model = mapping[SLOTS[pIdx]];
      return JSON.stringify({
        evaluator_name: evaluator.name,
        evaluator_email: evaluator.email,
        evaluator_affiliation: evaluator.affiliation || null,
        evaluator_role: evaluator.role || null,
        started_at: evaluator.started_at || null,
        exported_at,
        case_id: c.id,
        patient_id: c.patient_id ?? c.id,
        source: (c.emr && c.emr.source) || null,
        slot_to_model: mapping,
        is_completed: rec.is_completed,
        saved_at: rec.saved_at,
        scores_by_slot: rec.scores,
        scores_by_model,
        deductions_by_slot: rec.deductions,
        deductions_by_model,
        preference: rec.preference,
        preferred_model,
      });
    });
    const blob = new Blob([lines.join('\n')], { type: 'application/jsonl' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `abc_test_${slugFilename(evaluator.name)}_${dateStamp()}.jsonl`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast(`📦 ${a.download} 다운로드 시작`);
  };

  const dateStamp = () => {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  };
  const slugFilename = (s) => String(s || 'evaluator').replace(/[^\w가-힣ㄱ-ㅎㅏ-ㅣ.-]+/g, '_').slice(0, 40) || 'evaluator';

  // ---------------------------------------------------------------------------
  // Evaluator modal
  // ---------------------------------------------------------------------------
  const openEvaluatorModal = (allowCancel) => {
    const modal = $('#evaluator-modal');
    modal.classList.remove('hidden');
    if (evaluator) {
      $('#ev-name').value = evaluator.name || '';
      $('#ev-email').value = evaluator.email || '';
      $('#ev-affiliation').value = evaluator.affiliation || '';
      $('#ev-role').value = evaluator.role || '';
    }
    $('#ev-cancel').classList.toggle('hidden', !allowCancel);
    setTimeout(() => $('#ev-name').focus(), 50);
  };
  const closeEvaluatorModal = () => $('#evaluator-modal').classList.add('hidden');

  const submitEvaluatorForm = (e) => {
    e.preventDefault();
    const name = $('#ev-name').value.trim();
    const email = $('#ev-email').value.trim();
    if (!name || !email) { toast('❌ 이름과 이메일은 필수입니다.'); return; }
    evaluator = {
      name, email,
      affiliation: $('#ev-affiliation').value.trim(),
      role: $('#ev-role').value.trim(),
      started_at: evaluator?.started_at || new Date().toISOString().slice(0, 19),
    };
    saveEvaluator();
    updateEvaluatorChip();
    closeEvaluatorModal();
    toast(`👤 ${evaluator.name}님으로 시작합니다.`);
  };

  const updateEvaluatorChip = () => {
    const btn = $('#btn-evaluator');
    const label = $('#evaluator-label');
    if (evaluator) { btn.classList.remove('hidden'); label.textContent = `👤 ${evaluator.name}`; }
    else { btn.classList.add('hidden'); }
  };

  const resetAll = () => {
    if (!confirm('모든 평가 결과를 초기화하시겠습니까? 이 작업은 되돌릴 수 없습니다.')) return;
    results = {};
    cases.forEach(c => ensureRecord(c.id));
    saveResults();
    renderCaseList();
    updateProgress();
    if (currentId) selectCase(currentId);
    toast('🗑 초기화 완료');
  };

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  let toastTimer = null;
  const toast = (msg) => {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('toast-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('toast-show'), 2400);
  };

  // ---------------------------------------------------------------------------
  // Data loading (JSONL or JSON array)
  // ---------------------------------------------------------------------------
  const parseCases = (text) => {
    const t = text.trim();
    let arr;
    if (t.startsWith('[')) {
      arr = JSON.parse(t);
    } else {
      arr = t.split(/\r?\n/).filter(l => l.trim()).map((l, i) => {
        try { return JSON.parse(l); }
        catch (e) { throw new Error(`line ${i + 1} 파싱 실패`); }
      });
    }
    if (!Array.isArray(arr)) throw new Error('데이터가 배열/JSONL 형식이 아닙니다.');
    arr.forEach(r => { r.id = String(r.patient_id ?? r.id); });
    return arr;
  };

  const showLoadPrompt = (msg) => {
    $('#emr-card').innerHTML = `
      <div class="p-4 rounded-lg bg-sky-50 border border-sky-200 text-sky-800 text-sm">
        <b>데이터를 불러와 주세요.</b><br/>
        ${escapeHtml(msg)}<br/>
        사이드바의 <b>📁 JSONL 파일 불러오기</b> 버튼으로 <code>abc_test_emr_0.14k.jsonl</code> 을 선택하세요.<br/>
        <span class="text-xs text-sky-600">환자 데이터는 브라우저 안에서만 처리되며 어디에도 업로드되지 않습니다.</span>
      </div>`;
    $('#comparison').innerHTML = '';
  };

  const loadData = async () => {
    try {
      const res = await fetch(DATA_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error('fetch failed');
      cases = parseCases(await res.text());
    } catch (e) {
      cases = [];
      showLoadPrompt('로컬 데이터 파일을 자동으로 찾지 못했습니다 (공개 배포 환경에서는 정상입니다).');
    }
  };

  const loadFromFile = (file) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        cases = parseCases(String(e.target.result));
        cases.forEach(c => ensureRecord(c.id));
        saveResults();
        renderCaseList();
        updateProgress();
        if (cases.length) selectCase(cases[0].id);
        toast(`📁 ${cases.length}개 케이스 로드됨`);
      } catch (err) {
        toast(`❌ 파싱 실패: ${err.message}`);
        console.error(err);
      }
    };
    reader.readAsText(file);
  };

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  const init = async () => {
    marked.setOptions({ gfm: true, breaks: false });
    results = loadResults();
    evaluator = loadEvaluator();
    await loadData();
    cases.forEach(c => ensureRecord(c.id));
    saveResults();

    renderCaseList();
    updateProgress();
    updateEvaluatorChip();
    if (cases.length) selectCase(cases[0].id);

    $('#btn-guidelines').addEventListener('click', () => $('#guidelines-panel').classList.toggle('hidden'));
    $('#btn-export').addEventListener('click', exportJSONL);
    $('#btn-reset').addEventListener('click', resetAll);
    $('#btn-save').addEventListener('click', saveCurrent);
    $('#btn-load-file').addEventListener('click', () => $('#file-input').click());
    $('#file-input').addEventListener('change', (e) => {
      const f = e.target.files?.[0];
      if (f) loadFromFile(f);
      e.target.value = '';
    });

    $('#btn-evaluator').addEventListener('click', () => openEvaluatorModal(true));
    $('#evaluator-form').addEventListener('submit', submitEvaluatorForm);
    $('#ev-cancel').addEventListener('click', closeEvaluatorModal);

    if (!evaluator) openEvaluatorModal(false);
  };

  document.addEventListener('DOMContentLoaded', init);
})();
