/* Medical LLM A/B/C Test — vanilla JS app (3-model blind evaluation) */
(() => {
  'use strict';

  const STORAGE_KEY = 'abc_test_eval_results_v1';
  const EVALUATOR_KEY = 'abc_test_evaluator_v1';
  const TOOL_FEEDBACK_KEY = 'abc_test_tool_feedback_v1';
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
      desc: '환자 상태·검사 수치·동반질환·기존 치료력을 고려할 때 의학적으로 타당하고 안전한가? (기존 처방을 불필요하게 변경하지 않되, 필요한 강화·감량·중단·변경을 적절히 제안했는가?)' },
    { key: 'insurance_compliance', title: '1-2. 보험·제도 부합성 및 실제 처방 가능성',
      desc: '국내 급여 기준·병용 제한·심사 기준에 부합하며 실제로 처방 가능한가? (임상 타당성과 별개로, 급여·심사 관점에서 판단)' },
    { key: 'usability', title: '1-3. 외래 활용성 및 가독성',
      desc: '바쁜 외래에서 빠르게 읽고 처방 의사결정에 활용하기 쉬운가?' },
  ];

  // Score labels shown as a legend / tooltip under each domain.
  const SCORE_LEGEND = {
    5: '외래에서 거의 그대로 참고 가능',
    4: '전반적으로 적절하나 일부 보완 필요',
    3: '참고 가능하나 상당한 수정·검토 필요',
    2: '주요 문제가 있어 제한적으로만 참고 가능',
    1: '중대한 문제가 있어 사용 부적절',
  };

  // Grouped deduction options (feedback: ~10 유형 + 자유기재란)
  const DEDUCTION_GROUPS = [
    { group: '임상 안전성', items: [
      '절대 금기 또는 중대한 주의 약제 제안',
      '주요 위험요인(신기능·간기능·저혈당·고령·CKD·HF·ASCVD) 미반영',
      '필요한 치료 강화·감량·중단·변경 누락, 또는 불필요한 약제 추가·과도한 증량',
    ] },
    { group: '보험·제도', items: [
      '국내 급여 기준 또는 병용 제한 위반',
      '급여 가능성이 불확실한데 이를 표시하지 않음',
      '필요 진단명·검사 기준·선행 약제·서류 요건 미반영',
    ] },
    { group: '외래 활용성', items: [
      '처방안(약제명·용량·빈도·유지/중단/변경)이 불명확',
      '추적 관찰·검사·부작용 모니터링 계획 부족',
      '임상 근거가 부족한 기존 약제의 중단·교체 (기존 치료 변경의 근거 부족)',
      '답변이 장황하여 핵심 처방안 파악이 어려움',
    ] },
    { group: '기타', items: [
      '의학적 사실 왜곡 또는 hallucination',
    ] },
  ];

  const PREFERENCES = [
    'A 답변을 가장 참고하고 싶음',
    'B 답변을 가장 참고하고 싶음',
    'C 답변을 가장 참고하고 싶음',
    '세 답변 모두 우수하여 우열을 가리기 어려움',
    '세 답변이 상호 보완적임 (조합 시 유용)',
    '세 답변 모두 실제 처방 보조 도구로 사용하기 어려움',
  ];
  // Which preference options refer to a specific model (index maps to slot).
  const PREF_MODEL_COUNT = 3;

  const PREF_STRENGTHS = ['약함', '보통', '강함'];

  // Common keys shared by all 3 models, rendered aligned side-by-side.
  const ANSWER_SECTIONS = [
    { key: 'patient_status_analysis', sub: null, title: '① 환자 상태 분석 (Patient Status)' },
    { key: 'prescription_recommendation', sub: 'covered_by_insurance', title: '② 처방 추천 — 급여 가능 (Covered by Insurance)' },
    { key: 'prescription_recommendation', sub: 'non_covered_or_alternative', title: '③ 처방 추천 — 비급여 / 대체 (Non-covered / Alternative)' },
    { key: 'prescription_recommendation', sub: 'other_medications', title: '④ 처방 추천 — 기타 약물 (Other Medications)' },
    { key: 'prescription_recommendation', sub: 'general', title: '⑤ 처방 추천 — 일반 (General)' },
    { key: 'monitoring_and_additional_recommendation', sub: null, title: '⑥ 모니터링 및 추가 권고 (Monitoring)' },
    { key: 'unclassified', sub: null, title: '⑦ 미분류 (Unclassified)' },
  ];

  /** @type {Array<any>} */
  let cases = [];
  let currentId = null;
  /** @type {Record<string, any>} */
  let results = {};
  let evaluator = null;
  let toolFeedback = '';

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
    // null = 미평가 (feedback: no silent default; must be actively scored)
    scores: Object.fromEntries(SLOTS.map(s => [s, Object.fromEntries(SCORE_DOMAINS.map(d => [d.key, null]))])),
    deductions: Object.fromEntries(SLOTS.map(s => [s, []])),
    deduction_note: Object.fromEntries(SLOTS.map(s => [s, ''])),
    preference: null,
    preference_strength: null,
    preference_reason: '',
    saved_at: null,
  });

  // Back-fill new fields onto records loaded from older localStorage snapshots.
  const migrateRecord = (rec) => {
    const base = defaultRecord();
    for (const k of ['deduction_note', 'preference_strength', 'preference_reason']) {
      if (rec[k] === undefined) rec[k] = base[k];
    }
    return rec;
  };

  const ensureRecord = (id) => {
    if (!results[id]) results[id] = defaultRecord();
    return migrateRecord(results[id]);
  };

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  const $ = (sel) => document.querySelector(sel);

  // Remove standalone horizontal rules (---, ***, ___) the models emit as
  // section separators; they render as clutter lines inside the answer cells.
  // Table separator rows (|---|) start with '|' and are left untouched.
  const stripRules = (t) => (t || '')
    .replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Render markdown while protecting LaTeX math ($...$ / $$...$$) from being
  // mangled by the markdown parser (e.g. underscores, backslashes, asterisks).
  // Math is swapped out for sentinel placeholders, markdown runs, then the
  // original math is restored so KaTeX auto-render can typeset it in the DOM.
  const MATH_RE = /\$\$([\s\S]+?)\$\$|\$([^\n$]+?)\$/g;
  const md = (s) => {
    const src = s || '';
    const store = [];
    const guarded = src.replace(MATH_RE, (m) => `${store.push(m) - 1}`);
    let html = marked.parse(guarded);
    html = html.replace(/(\d+)/g, (_, i) => store[Number(i)]);
    return html;
  };

  // Typeset any $...$ / $$...$$ inside an element using KaTeX (no-op if the
  // library failed to load; pre/code blocks are ignored so lab dumps are safe).
  const typesetMath = (el) => {
    if (!el || typeof window.renderMathInElement !== 'function') return;
    try {
      window.renderMathInElement(el, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '$', right: '$', display: false },
        ],
        ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
        throwOnError: false,
      });
    } catch (e) { /* leave raw text if typesetting fails */ }
  };

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

  // Guidelines tabs: 🛠 시스템 사용법 / 📋 평가 가이드라인
  const setGuidelinesTab = (tab) => {
    const panes = { system: $('#gl-pane-system'), eval: $('#gl-pane-eval') };
    const tabs = { system: $('#tab-system'), eval: $('#tab-eval') };
    Object.entries(panes).forEach(([k, el]) => el && el.classList.toggle('hidden', k !== tab));
    Object.entries(tabs).forEach(([k, el]) => {
      if (!el) return;
      const active = k === tab;
      el.classList.toggle('bg-amber-100', active);
      el.classList.toggle('text-amber-900', active);
      el.classList.toggle('text-slate-600', !active);
      el.classList.toggle('hover:bg-amber-50', !active);
    });
  };

  // Sticky top bar so key patient info stays visible while scrolling long answers.
  const renderCaseSummary = (c) => {
    const el = $('#case-summary');
    if (!el) return;
    const emr = c.emr || {};
    const note = emr.outpatient_note || '';
    const grab = (re) => { const m = note.match(re); return m ? m[1] : null; };
    const hba1c = grab(/Hb\s*A1c[^0-9\-]*([0-9]+\.?[0-9]*)/i);
    const egfr = grab(/eGFR[^0-9\-]*([0-9]+\.?[0-9]*)/i);
    const bmi = grab(/BMI[^0-9.]*([0-9]+\.?[0-9]*)/i);
    const chips = [`<span class="sum-chip sum-id">Case ${escapeHtml(c.id)}</span>`];
    if (hba1c) chips.push(`<span class="sum-chip">HbA1c ${escapeHtml(hba1c)}%</span>`);
    if (egfr) chips.push(`<span class="sum-chip">eGFR ${escapeHtml(egfr)}</span>`);
    if (bmi) chips.push(`<span class="sum-chip">BMI ${escapeHtml(bmi)}</span>`);
    el.innerHTML = chips.join('');
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
      const texts = SLOTS.map(s => stripRules(getSectionText(c[mapping[s]], sec.key, sec.sub)));
      if (!texts.some(t => t)) return; // hide sections empty across all models
      // 환자 상태 분석은 길어서 셀 내부 스크롤로 표시
      const scrollCls = sec.key === 'patient_status_analysis' ? ' cmp-cell--scroll' : '';
      const cols = SLOTS.map((s, i) => `
        <div class="cmp-cell${scrollCls}">
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

  const badgeText = { A: 'text-sky-700', B: 'text-violet-700', C: 'text-amber-700' };
  const cellBg = { A: 'bg-sky-50/40', B: 'bg-violet-50/40', C: 'bg-amber-50/40' };

  // Required fields missing before a case can be marked complete.
  const missingRequired = (rec) => {
    const missing = [];
    SLOTS.forEach(s => SCORE_DOMAINS.forEach(d => {
      if (rec.scores[s][d.key] == null) missing.push(`${SLOT_LABEL[s]} · ${d.title.split('.')[0]} 점수`);
    }));
    if (!rec.preference) missing.push('최종 활용 선호도');
    return missing;
  };

  const renderEvaluationForm = (c) => {
    const rec = ensureRecord(c.id);

    // 1. comprehensive scores — 1~5 buttons, no default (미평가 = null)
    const legendLine = [5, 4, 3, 2, 1].map(n => `${n} = ${SCORE_LEGEND[n]}`).join('  ·  ');
    const compEl = $('#form-comprehensive');
    compEl.innerHTML = `<p class="text-[11px] text-slate-400 mb-4">${escapeHtml(legendLine)}</p>`;
    SCORE_DOMAINS.forEach(d => {
      const block = document.createElement('div');
      block.innerHTML = `
        <h4 class="text-sm font-semibold text-slate-700">${escapeHtml(d.title)}</h4>
        <p class="text-xs text-slate-500 mt-0.5 mb-3">${escapeHtml(d.desc)}</p>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          ${SLOTS.map(side => {
            const val = rec.scores[side][d.key];
            return `
            <div class="border border-slate-200 rounded-lg p-3 ${cellBg[side]}">
              <div class="flex items-center justify-between mb-2">
                <span class="text-xs font-semibold ${badgeText[side]}">${SLOT_LABEL[side]}</span>
                <span class="text-[10px] ${val == null ? 'text-rose-400' : 'text-slate-400'}" data-badge="${side}-${d.key}">${val == null ? '미평가' : SCORE_LEGEND[val]}</span>
              </div>
              <div class="score-btns" data-side="${side}" data-domain="${d.key}">
                ${[1, 2, 3, 4, 5].map(n => `<button type="button" class="score-btn${val === n ? ' active' : ''}" data-val="${n}">${n}</button>`).join('')}
              </div>
            </div>`;
          }).join('')}
        </div>
      `;
      compEl.appendChild(block);
    });

    // 2. deductions — grouped + free-text note per model
    const dedGrid = $('#deductions-grid');
    dedGrid.innerHTML = SLOTS.map(side => `
      <div>
        <p class="text-xs font-semibold ${badgeText[side]} mb-2">${SLOT_LABEL[side]}</p>
        <div class="space-y-2">
          ${DEDUCTION_GROUPS.map(g => `
            <p class="ded-group">${escapeHtml(g.group)}</p>
            ${g.items.map(opt => {
              const checked = rec.deductions[side].includes(opt) ? 'checked' : '';
              return `
              <label class="flex items-start gap-2 text-sm cursor-pointer hover:bg-slate-50 rounded px-1.5 py-1">
                <input type="checkbox" class="mt-0.5 accent-emerald-600" data-side="${side}" data-opt="${escapeHtml(opt)}" ${checked} />
                <span class="text-slate-700">${escapeHtml(opt)}</span>
              </label>`;
            }).join('')}`).join('')}
          <p class="ded-group">기타 (직접 입력)</p>
          <textarea class="ded-note w-full text-sm px-2 py-1.5 border border-slate-200 rounded-md focus:outline-none focus:ring-1 focus:ring-emerald-400"
                    rows="2" data-side="${side}" placeholder="위 항목에 없는 문제를 자유롭게 기재">${escapeHtml(rec.deduction_note[side] || '')}</textarea>
        </div>
      </div>`).join('');

    // 3. preference + strength + reason
    const prefEl = $('#preference-group');
    prefEl.innerHTML = `
      ${PREFERENCES.map((opt, i) => `
        <label class="flex items-center gap-2 text-sm cursor-pointer hover:bg-slate-50 rounded px-1.5 py-1">
          <input id="pref-${i}" type="radio" name="preference" class="accent-emerald-600" value="${escapeHtml(opt)}" ${rec.preference === opt ? 'checked' : ''} />
          <span class="text-slate-700">${escapeHtml(opt)}</span>
        </label>`).join('')}
      <div class="mt-3 flex items-center gap-3 flex-wrap">
        <span class="text-xs font-medium text-slate-600">선호 강도 <span class="text-slate-400">(선택)</span></span>
        ${PREF_STRENGTHS.map(s => `
          <label class="flex items-center gap-1.5 text-sm cursor-pointer">
            <input type="radio" name="pref-strength" class="accent-emerald-600" value="${escapeHtml(s)}" ${rec.preference_strength === s ? 'checked' : ''} />
            <span class="text-slate-700">${escapeHtml(s)}</span>
          </label>`).join('')}
      </div>
      <div class="mt-3">
        <p class="text-xs font-medium text-slate-600 mb-1">선호 이유 <span class="text-slate-400">(선택)</span></p>
        <textarea id="pref-reason" rows="2" class="w-full text-sm px-2 py-1.5 border border-slate-200 rounded-md focus:outline-none focus:ring-1 focus:ring-emerald-400"
                  placeholder="선택한 답변을 더/덜 선호하는 이유, 상호 보완 관점 등">${escapeHtml(rec.preference_reason || '')}</textarea>
      </div>`;

    updateSaveStatus(c.id);
    bindFormEvents(c.id);
  };

  const bindFormEvents = (caseId) => {
    document.querySelectorAll('.score-btns').forEach(group => {
      const { side, domain } = group.dataset;
      group.querySelectorAll('.score-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const val = Number(btn.dataset.val);
          ensureRecord(caseId).scores[side][domain] = val;
          group.querySelectorAll('.score-btn').forEach(b => b.classList.toggle('active', b === btn));
          const badge = document.querySelector(`[data-badge="${side}-${domain}"]`);
          if (badge) { badge.textContent = SCORE_LEGEND[val]; badge.className = 'text-[10px] text-slate-400'; }
          saveResults();
          updateSaveStatus(caseId); // refresh 미입력 count without losing focus
        });
      });
    });
    document.querySelectorAll('#deductions-grid input[type="checkbox"]').forEach(el => {
      el.addEventListener('change', () => {
        const { side, opt } = el.dataset;
        const list = ensureRecord(caseId).deductions[side];
        const idx = list.indexOf(opt);
        if (el.checked && idx === -1) list.push(opt);
        if (!el.checked && idx !== -1) list.splice(idx, 1);
        saveResults();
      });
    });
    document.querySelectorAll('#deductions-grid .ded-note').forEach(el => {
      el.addEventListener('input', () => { ensureRecord(caseId).deduction_note[el.dataset.side] = el.value; saveResults(); });
    });
    document.querySelectorAll('input[name="preference"]').forEach(el => {
      el.addEventListener('change', () => { ensureRecord(caseId).preference = el.value; saveResults(); updateSaveStatus(caseId); });
    });
    document.querySelectorAll('input[name="pref-strength"]').forEach(el => {
      el.addEventListener('change', () => { ensureRecord(caseId).preference_strength = el.value; saveResults(); });
    });
    const reason = document.querySelector('#pref-reason');
    if (reason) reason.addEventListener('input', () => { ensureRecord(caseId).preference_reason = reason.value; saveResults(); });
  };

  const updateSaveStatus = (id) => {
    const rec = ensureRecord(id);
    const el = $('#save-status');
    if (rec.is_completed) {
      el.innerHTML = `<span class="inline-flex items-center gap-1.5"><span class="w-2 h-2 rounded-full bg-emerald-500"></span> 완료 표시됨 — 마지막 저장: <span class="mono">${escapeHtml(rec.saved_at || '')}</span></span>`;
    } else {
      const missing = missingRequired(rec);
      const detail = missing.length ? ` · 필수 미입력 ${missing.length}개` : ' · 필수 항목 입력 완료';
      el.innerHTML = `<span class="inline-flex items-center gap-1.5"><span class="w-2 h-2 rounded-full bg-slate-300"></span> 자동 저장됨 (완료 미표시)${escapeHtml(detail)}</span>`;
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
    renderCaseSummary(c);
    renderEMR(c);
    renderComparison(c);
    renderEvaluationForm(c);
    // Typeset LaTeX ($...$) in EMR + model answers into real math symbols.
    typesetMath($('#emr-card'));
    typesetMath($('#comparison'));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Mark the current case complete (with required-field validation).
  // Returns true on success. goNext advances to the next case afterwards.
  const completeCurrent = (goNext) => {
    if (!currentId) return false;
    const rec = ensureRecord(currentId);
    const missing = missingRequired(rec);
    if (missing.length) {
      updateSaveStatus(currentId);
      toast(`❌ 필수 항목 ${missing.length}개 미입력: ${missing.slice(0, 2).join(', ')}${missing.length > 2 ? ' 외' : ''}`);
      return false;
    }
    rec.is_completed = true;
    rec.saved_at = new Date().toISOString().slice(0, 19);
    saveResults();
    renderCaseList();
    updateProgress();
    updateSaveStatus(currentId);
    if (goNext) {
      const ids = cases.map(c => c.id);
      const nextId = ids[ids.indexOf(currentId) + 1];
      if (nextId) { selectCase(nextId); toast(`✅ 완료 표시 후 Case ${nextId}로 이동`); return true; }
      toast('✅ 완료 표시됨 (마지막 케이스)');
      return true;
    }
    toast(`✅ Case ${currentId} 완료 표시됨`);
    return true;
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
      const deduction_note_by_model = {};
      SLOTS.forEach(s => {
        scores_by_model[mapping[s]] = rec.scores[s];
        deductions_by_model[mapping[s]] = rec.deductions[s];
        deduction_note_by_model[mapping[s]] = rec.deduction_note ? rec.deduction_note[s] : '';
      });
      let preferred_model = null;
      const pIdx = PREFERENCES.indexOf(rec.preference);
      if (pIdx >= 0 && pIdx < PREF_MODEL_COUNT) preferred_model = mapping[SLOTS[pIdx]];
      return JSON.stringify({
        evaluator_name: evaluator.name,
        evaluator_email: evaluator.email,
        evaluator_affiliation: evaluator.affiliation || null,
        evaluator_role: evaluator.role || null,
        started_at: evaluator.started_at || null,
        exported_at,
        tool_feedback: toolFeedback || null,
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
        deduction_note_by_slot: rec.deduction_note || {},
        deduction_note_by_model,
        preference: rec.preference,
        preferred_model,
        preference_strength: rec.preference_strength || null,
        preference_reason: rec.preference_reason || null,
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
    toolFeedback = localStorage.getItem(TOOL_FEEDBACK_KEY) || '';
    await loadData();
    cases.forEach(c => ensureRecord(c.id));
    saveResults();

    renderCaseList();
    updateProgress();
    updateEvaluatorChip();
    if (cases.length) selectCase(cases[0].id);

    $('#btn-guidelines').addEventListener('click', () => $('#guidelines-panel').classList.toggle('hidden'));
    $('#btn-guidelines-close').addEventListener('click', () => $('#guidelines-panel').classList.add('hidden'));
    document.querySelectorAll('.gl-tab').forEach(t => t.addEventListener('click', () => setGuidelinesTab(t.dataset.tab)));
    setGuidelinesTab('system');
    $('#btn-export').addEventListener('click', exportJSONL);
    $('#btn-reset').addEventListener('click', resetAll);
    $('#btn-complete').addEventListener('click', () => completeCurrent(false));
    $('#btn-complete-next').addEventListener('click', () => completeCurrent(true));
    $('#btn-load-file').addEventListener('click', () => $('#file-input').click());
    const tf = $('#tool-feedback');
    if (tf) { tf.value = toolFeedback; tf.addEventListener('input', () => { toolFeedback = tf.value; localStorage.setItem(TOOL_FEEDBACK_KEY, toolFeedback); }); }
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
