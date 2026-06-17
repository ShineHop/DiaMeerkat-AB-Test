/* Medical LLM A/B Test — vanilla JS app */
(() => {
  'use strict';

  const STORAGE_KEY = 'ab_test_eval_results_v1';
  const EVALUATOR_KEY = 'ab_test_evaluator_v1';
  const DATA_URL = 'sample_data.json';

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
  /** @type {{name:string,email:string,affiliation?:string,role?:string,started_at?:string} | null} */
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
      const block = document.createElement('div');
      block.innerHTML = `
        <h3 class="text-sm font-semibold text-slate-700">${escapeHtml(d.title)}</h3>
        <p class="text-xs text-slate-500 mt-0.5 mb-3">${escapeHtml(d.desc)}</p>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
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
        evaluator_email: evaluator.email,
        evaluator_affiliation: evaluator.affiliation || null,
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
    if (!name || !email) {
      toast('❌ 이름과 이메일은 필수입니다.');
      return;
    }
    evaluator = {
      name,
      email,
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

    $('#btn-guidelines').addEventListener('click', () => {
      $('#guidelines-panel').classList.toggle('hidden');
    });
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
