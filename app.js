/* Medical LLM A/B Test — vanilla JS app */
(() => {
  'use strict';

  const STORAGE_KEY = 'ab_test_eval_results_v1';
  const EVALUATOR_KEY = 'ab_test_evaluator_v1';
  const DATA_URL = 'sample_data.json';

  const SCORE_DOMAINS = [
    {
      key: 'clinical_safety',
      title: '1-1. 임상적 안전성 및 타당성',
      desc: '환자의 현재 상태, 검사 수치, 동반질환, 기존 치료력을 고려했을 때 처방 제안이 의학적으로 타당하고 안전한가?',
      considerations: [
        '최신 당뇨병 진료지침 및 일반적인 임상 의사결정 흐름에 부합하는가?',
        '신기능, 간기능, 저혈당 위험, 고령/취약성, 심혈관질환, CKD, HF 등 환자별 위험요인을 적절히 반영했는가?',
        '금기 또는 주의가 필요한 약제를 피하고, 필요한 경우 용량 조절이나 감량을 제시했는가?',
        '혈당 조절 상태에 비해 불필요한 약제 추가, 과도한 증량, 부적절한 인슐린 강화 등 과잉 치료를 하지 않았는가?',
        '반대로 필요한 치료 강화, 감량, 약제 변경을 놓치지 않았는가?',
      ],
    },
    {
      key: 'insurance_compliance',
      title: '1-2. 보험·제도 부합성 및 실제 처방 가능성',
      desc: '국내 보험 급여 기준과 실제 외래 처방 관행을 고려했을 때, 제안된 처방이 현실적으로 처방 가능한가?',
      considerations: [
        '국내 건강보험 급여 기준 및 심사 기준에 부합하는 처방인가?',
        'HbA1c 기준, 선행 약제 사용 여부, 병용 제한, eGFR 기준, 필요 서류 또는 진단 코드 등 급여 판단에 필요한 요소를 적절히 고려했는가?',
        '급여 가능성이 불확실한 경우 이를 명확히 표시했는가?',
        '기존 외래 처방과 비교했을 때, 임상적 근거 없이 기존 약제를 과도하게 중단·교체하지 않았는가?',
        '급여 약제, 비급여 가능 약제, 기타 보조 약제를 적절히 구분했는가?',
      ],
    },
    {
      key: 'usability',
      title: '1-3. 외래 활용성 및 가독성',
      desc: '바쁜 외래 환경에서 의사가 빠르게 읽고 처방 의사결정에 활용하기 쉬운가?',
      considerations: [
        '유지, 중단, 변경, 신규 처방이 명확히 구분되어 있는가?',
        '약제명, 용량, 빈도, 증량 또는 감량 계획이 충분히 구체적인가?',
        '처방 근거가 환자 정보와 연결되어 간결하게 설명되어 있는가?',
        '(만약, 다음 내용이 답변에 존재한다면) 추적 관찰 계획, 다음 내원 시점, 필요한 검사 항목이 환자 위험도에 맞게 제시되어 있는가?',
        '불확실한 부분이나 추가 확인이 필요한 정보를 명확히 표시했는가?',
      ],
    },
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
    'A 답변을 더 참고하고 싶음',
    'B 답변을 더 참고하고 싶음',
    '두 답변 간 처방 보조 관점에서 유의미한 차이 없음',
    '두 답변 모두 실제 처방 보조 도구로 사용하기 어려움',
  ];

  /** @type {Array<any>} */
  let cases = [];
  let currentId = null;
  /** @type {Record<string, any>} */
  let results = {};
  /** @type {{name:string,affiliation:string,role?:string,started_at?:string} | null} */
  let evaluator = null;

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------
  const loadResults = () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  };
  const saveResults = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(results));

  const loadEvaluator = () => {
    try {
      const raw = localStorage.getItem(EVALUATOR_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  };
  const saveEvaluator = () => localStorage.setItem(EVALUATOR_KEY, JSON.stringify(evaluator));

  const defaultRecord = () => ({
    is_completed: false,
    scores: {
      A: Object.fromEntries(SCORE_DOMAINS.map(d => [d.key, 3])),
      B: Object.fromEntries(SCORE_DOMAINS.map(d => [d.key, 3])),
    },
    deductions: { A: [], B: [] },
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
        <span class="flex-1 truncate">${escapeHtml(c.id)}</span>
        <span class="text-[10px] text-slate-400">${rec.is_completed ? '✓' : ''}</span>
      `;
      li.addEventListener('click', () => selectCase(c.id));
      ul.appendChild(li);
    });
  };

  const renderVignette = (c) => {
    const v = c.vignette || {};
    const comorb = (v.comorbidities || []).join(', ') || '-';
    const meds = (v.current_meds || []).map(m => `<li>${escapeHtml(m)}</li>`).join('') || '<li class="text-slate-400">(없음)</li>';
    $('#vignette-card').innerHTML = `
      <div class="flex items-center justify-between mb-3">
        <div class="flex items-center gap-2">
          <span class="text-xs px-2 py-0.5 rounded bg-slate-900 text-white font-mono">${escapeHtml(c.id)}</span>
          <h2 class="text-base font-semibold text-slate-800">임상 케이스</h2>
        </div>
        <span class="text-xs text-slate-400">Patient Vignette</span>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-1">
        <dl class="vignette-row">
          <dt>나이 / 성별</dt><dd>${v.age ?? '-'} / ${escapeHtml(v.sex ?? '-')}</dd>
          <dt>HbA1c</dt><dd>${v.HbA1c ?? '-'} %</dd>
          <dt>eGFR</dt><dd>${v.eGFR ?? '-'} mL/min/1.73㎡</dd>
          <dt>BMI</dt><dd>${v.BMI ?? '-'}</dd>
          <dt>동반질환</dt><dd>${escapeHtml(comorb)}</dd>
        </dl>
        <div>
          <p class="text-xs text-slate-500 mb-1">현재 처방</p>
          <ul class="text-sm list-disc pl-5 space-y-0.5">${meds}</ul>
        </div>
      </div>
      ${v.context ? `<div class="mt-4 p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-900"><b>임상 맥락 — </b>${escapeHtml(v.context)}</div>` : ''}
    `;
  };

  const renderModelOutputs = (c) => {
    $('#model-a').innerHTML = marked.parse(c.model_a || '_(no content)_');
    $('#model-b').innerHTML = marked.parse(c.model_b || '_(no content)_');
  };

  const renderEvaluationForm = (c) => {
    const rec = ensureRecord(c.id);

    // 1. comprehensive scores
    const compEl = $('#form-comprehensive');
    compEl.innerHTML = '';
    SCORE_DOMAINS.forEach(d => {
      const considerationsHtml = (d.considerations || [])
        .map(item => `<li>${escapeHtml(item)}</li>`)
        .join('');
      const block = document.createElement('div');
      block.innerHTML = `
        <div class="flex items-start justify-between gap-3">
          <div class="flex-1">
            <h3 class="text-sm font-semibold text-slate-700">${escapeHtml(d.title)}</h3>
            <p class="text-xs text-slate-500 mt-0.5">${escapeHtml(d.desc)}</p>
          </div>
          <button type="button" class="considerations-toggle shrink-0 text-[11px] px-2 py-1 rounded-md border border-slate-300 text-slate-600 hover:bg-slate-50 inline-flex items-center gap-1"
                  data-target="cons-${d.key}" aria-expanded="false">
            <span>💡 평가 시 고려사항</span>
            <span class="cons-chev transition-transform">▾</span>
          </button>
        </div>
        <div id="cons-${d.key}" class="hidden mt-2 mb-3 p-3 rounded-lg bg-amber-50 border border-amber-200">
          <p class="text-xs font-medium text-amber-900 mb-1.5">평가 시 다음을 함께 고려해 주십시오.</p>
          <ul class="list-disc pl-5 text-xs text-amber-900 space-y-1 leading-relaxed">${considerationsHtml}</ul>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
          ${['A', 'B'].map(side => `
            <div class="border border-slate-200 rounded-lg p-3 ${side === 'A' ? 'bg-sky-50/40' : 'bg-violet-50/40'}">
              <div class="flex items-center justify-between mb-2">
                <span class="text-xs font-semibold ${side === 'A' ? 'text-sky-700' : 'text-violet-700'}">Model ${side}</span>
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

    // wire up "평가 시 고려사항" toggles
    compEl.querySelectorAll('.considerations-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = document.getElementById(btn.dataset.target);
        if (!target) return;
        const expanded = btn.getAttribute('aria-expanded') === 'true';
        btn.setAttribute('aria-expanded', String(!expanded));
        target.classList.toggle('hidden');
        const chev = btn.querySelector('.cons-chev');
        if (chev) chev.style.transform = expanded ? '' : 'rotate(180deg)';
      });
    });

    // 2. deductions
    ['A', 'B'].forEach(side => {
      const wrap = document.querySelector(`#deductions-${side}`);
      wrap.innerHTML = '';
      DEDUCTIONS.forEach(opt => {
        const id = `ded-${side}-${slug(opt)}`;
        const checked = rec.deductions[side].includes(opt) ? 'checked' : '';
        wrap.insertAdjacentHTML('beforeend', `
          <label class="flex items-start gap-2 text-sm cursor-pointer hover:bg-slate-50 rounded px-1.5 py-1">
            <input id="${id}" type="checkbox" class="mt-0.5 accent-emerald-600" data-side="${side}" data-opt="${escapeHtml(opt)}" ${checked} />
            <span class="text-slate-700">${escapeHtml(opt)}</span>
          </label>
        `);
      });
    });

    // 3. preference
    const prefEl = $('#preference-group');
    prefEl.innerHTML = '';
    PREFERENCES.forEach((opt, i) => {
      const id = `pref-${i}`;
      const checked = rec.preference === opt ? 'checked' : '';
      prefEl.insertAdjacentHTML('beforeend', `
        <label class="flex items-center gap-2 text-sm cursor-pointer hover:bg-slate-50 rounded px-1.5 py-1">
          <input id="${id}" type="radio" name="preference" class="accent-emerald-600" value="${escapeHtml(opt)}" ${checked} />
          <span class="text-slate-700">${escapeHtml(opt)}</span>
        </label>
      `);
    });

    // status
    updateSaveStatus(c.id);

    // bind events
    bindFormEvents(c.id);
  };

  const bindFormEvents = (caseId) => {
    document.querySelectorAll('.score-slider').forEach(el => {
      el.addEventListener('input', () => {
        const side = el.dataset.side;
        const domain = el.dataset.domain;
        const val = Number(el.value);
        ensureRecord(caseId).scores[side][domain] = val;
        const pill = document.querySelector(`[data-pill="${side}-${domain}"]`);
        if (pill) pill.textContent = val;
        saveResults();
      });
    });
    document.querySelectorAll('#deductions-A input, #deductions-B input').forEach(el => {
      el.addEventListener('change', () => {
        const side = el.dataset.side;
        const opt = el.dataset.opt;
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
    renderVignette(c);
    renderModelOutputs(c);
    renderEvaluationForm(c);
    const scroller = document.getElementById('main-scroll');
    if (scroller) scroller.scrollTo({ top: 0, behavior: 'smooth' });
    else window.scrollTo({ top: 0, behavior: 'smooth' });
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
    toast(`✅ ${currentId} 평가가 저장되었습니다.`);
  };

  const exportJSONL = () => {
    if (!evaluator) {
      openEvaluatorModal(false);
      toast('먼저 평가자 정보를 입력해 주세요.');
      return;
    }
    const exported_at = new Date().toISOString().slice(0, 19);
    const lines = cases.map(c => {
      const rec = ensureRecord(c.id);
      return JSON.stringify({
        evaluator_name: evaluator.name,
        evaluator_affiliation: evaluator.affiliation,
        evaluator_role: evaluator.role || null,
        started_at: evaluator.started_at || null,
        exported_at,
        case_id: c.id,
        vignette: c.vignette || {},
        is_completed: rec.is_completed,
        saved_at: rec.saved_at,
        scores: rec.scores,
        deductions: rec.deductions,
        preference: rec.preference,
      });
    });
    const blob = new Blob([lines.join('\n')], { type: 'application/jsonl' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ab_test_${slugFilename(evaluator.name)}_${dateStamp()}.jsonl`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast(`📦 ${a.download} 다운로드 시작`);
  };

  const dateStamp = () => {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
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
    const affiliation = $('#ev-affiliation').value.trim();
    if (!name || !affiliation) {
      toast('❌ 이름과 소속은 필수입니다.');
      return;
    }
    evaluator = {
      name,
      affiliation,
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
    if (evaluator) {
      btn.classList.remove('hidden');
      label.textContent = `👤 ${evaluator.name}`;
    } else {
      btn.classList.add('hidden');
    }
  };

  const resetAll = () => {
    if (!confirm('모든 평가 결과를 초기화하시겠습니까? 이 작업은 되돌릴 수 없습니다.')) return;
    results = {};
    cases.forEach(c => ensureRecord(c.id));
    saveResults();
    renderCaseList();
    updateProgress();
    if (currentId) renderEvaluationForm(cases.find(c => c.id === currentId));
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
  // Data loading
  // ---------------------------------------------------------------------------
  const loadData = async () => {
    try {
      const res = await fetch(DATA_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error('fetch failed');
      cases = await res.json();
    } catch (e) {
      console.warn('Falling back: data fetch failed.', e);
      cases = [];
      $('#vignette-card').innerHTML = `
        <div class="p-4 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-sm">
          <b>데이터를 불러올 수 없습니다.</b><br/>
          <code>sample_data.json</code> 파일을 찾을 수 없거나, <code>file://</code> 환경에서 fetch가 차단되었습니다.<br/>
          사이드바의 <b>📁 JSON 파일 불러오기</b> 버튼을 사용해 주십시오.
        </div>`;
    }
  };

  const loadFromFile = (file) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(String(e.target.result));
        if (!Array.isArray(data)) throw new Error('not array');
        cases = data;
        cases.forEach(c => ensureRecord(c.id));
        saveResults();
        renderCaseList();
        updateProgress();
        if (cases.length) selectCase(cases[0].id);
        toast(`📁 ${cases.length}개 케이스 로드됨`);
      } catch (err) {
        toast('❌ JSON 파싱 실패');
        console.error(err);
      }
    };
    reader.readAsText(file);
  };

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  const init = async () => {
    results = loadResults();
    evaluator = loadEvaluator();
    await loadData();
    cases.forEach(c => ensureRecord(c.id));
    saveResults();

    renderCaseList();
    updateProgress();
    updateEvaluatorChip();
    if (cases.length) selectCase(cases[0].id);

    const toggleGuidelines = (forceClose) => {
      const panel = $('#guidelines-panel');
      if (!panel) return;
      if (forceClose === true) panel.classList.add('hidden');
      else if (forceClose === false) panel.classList.remove('hidden');
      else panel.classList.toggle('hidden');
    };

    // Delegated handler: works even if the button is re-rendered, and
    // survives any timing/ordering issues between DOMContentLoaded and init.
    document.addEventListener('click', (e) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;
      if (target.closest('#btn-guidelines-close')) {
        e.preventDefault();
        toggleGuidelines(true);
      } else if (target.closest('#btn-guidelines')) {
        e.preventDefault();
        toggleGuidelines();
      }
    });

    // Topbar height tracking no longer needed: <main> is now the scroll
    // container, so the sidebar sticks relative to <main>'s top (top-4),
    // and the topbar stays visually fixed above it regardless of its height.
    $('#btn-export').addEventListener('click', exportJSONL);
    $('#btn-reset').addEventListener('click', resetAll);
    $('#btn-save').addEventListener('click', saveCurrent);
    $('#btn-load-file').addEventListener('click', () => $('#file-input').click());
    $('#file-input').addEventListener('change', (e) => {
      const f = e.target.files?.[0];
      if (f) loadFromFile(f);
    });

    $('#btn-evaluator').addEventListener('click', () => openEvaluatorModal(true));
    $('#evaluator-form').addEventListener('submit', submitEvaluatorForm);
    $('#ev-cancel').addEventListener('click', closeEvaluatorModal);

    // First-time visitors must enter their identity before evaluating.
    if (!evaluator) {
      openEvaluatorModal(false);
    }
  };

  document.addEventListener('DOMContentLoaded', init);
})();
