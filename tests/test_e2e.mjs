/**
 * 端到端人格模拟测试
 * ============================================
 * 直接执行页面里的真实 JS（非复刻），用最小 DOM mock 驱动完整结果生成流程，
 * 校验「分数 -> 结果文案」是否自洽。
 *
 * 覆盖画像：
 *   纯 D / 纯 sub / 纯 S / 纯 M / 纯 SW / 纯 BR
 *   Switch(D+sub 双高) / S+M 双高
 *   真实 vanilla（全低倾向）/ 温和中间型
 *   敷衍直线作答 / 讨好性全高分 / 随机作答
 */
import fs from 'fs';
import vm from 'vm';

const html = fs.readFileSync('index.html', 'utf-8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) { console.error('未找到 script'); process.exit(1); }
let scriptSrc = scriptMatch[1];

// ---- 注入测试钩子：暴露内部函数与 state ----
const hook = `
;window.__TEST__ = {
  state, elements, QUESTION_BANK, ATTRIBUTES, CHINESE_NAMES,
  calculateScores, calculateNormalizedScores, calculateTheoreticalMaxScores,
  checkAnswerConsistency, calculateTestReliability, analyzeReverseConsistency,
  analyzeAnswerPatterns, getScoreDescription, getDimensionDetailDescription,
  getDimensionBehaviorExamples, showResults, initializeTest, startFlow, getTypeProfile
};
`;
const last = scriptSrc.lastIndexOf('})();');
if (last === -1) { console.error('未找到 IIFE 结尾'); process.exit(1); }
scriptSrc = scriptSrc.slice(0, last) + hook + scriptSrc.slice(last);

// ---- 最小 DOM mock ----
function makeEl(id = '') {
  const el = {
    id,
    innerHTML: '',
    textContent: '',
    disabled: false,
    dataset: {},
    style: { setProperty() {} },
    classList: {
      _set: new Set(),
      add(...c) { c.forEach(x => this._set.add(x)); },
      remove(...c) { c.forEach(x => this._set.delete(x)); },
      contains(c) { return this._set.has(c); },
      toggle(c) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); },
    },
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) { (el._children = el._children || []).push(child); },
    querySelector(sel) {
      if (sel === 'canvas') return makeCanvas();
      return null;
    },
    querySelectorAll() { return []; },
    closest() { return null; },
    getAttribute() { return null; },
    setAttribute() {},
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; },
    focus() {},
    scrollIntoView() {},
  };
  return el;
}

function makeCanvas() {
  const noop = () => {};
  return {
    width: 280, height: 280,
    style: { setProperty() {} },
    getContext() {
      return new Proxy({}, {
        get(t, prop) {
          if (prop === 'measureText') return () => ({ width: 10 });
          if (prop === 'createLinearGradient' || prop === 'createRadialGradient')
            return () => ({ addColorStop: noop });
          return noop;
        },
        set() { return true; },
      });
    },
  };
}

const elCache = {};
const documentMock = {
  readyState: 'complete',
  getElementById(id) {
    if (!elCache[id]) elCache[id] = makeEl(id);
    return elCache[id];
  },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  createElement(tag) { return makeEl('<' + tag + '>'); },
  addEventListener() {},
  removeEventListener() {},
  body: makeEl('body'),
};

const windowMock = {
  scrollTo() {},
  addEventListener() {},
  __TEST__: null,
};

const sandbox = {
  document: documentMock,
  window: windowMock,
  console,
  setTimeout: (fn) => { fn(); return 0; },
  clearTimeout: () => {},
  Math, Date, JSON, Object, Array, String, Number, Boolean, Promise, isNaN, parseInt, parseFloat,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

try {
  vm.runInContext(scriptSrc, sandbox, { filename: 'page.js' });
} catch (e) {
  console.error('[FAIL] 页面脚本执行失败:', e.message);
  console.error(e.stack.split('\n').slice(0, 5).join('\n'));
  process.exit(1);
}

const T = windowMock.__TEST__;
if (!T) { console.error('[FAIL] 测试钩子未注入'); process.exit(1); }

let errors = [];
let warnings = [];
const ok = (m) => console.log('    [OK] ' + m);
const bad = (m) => { errors.push(m); console.log('    [FAIL] ' + m); };
const warn = (m) => { warnings.push(m); console.log('    [WARN] ' + m); };

const QB = T.QUESTION_BANK;
const DIMS = Object.keys(T.ATTRIBUTES);
const revIds = new Set(QB.filter(q => q.reverse).map(q => q.id));
const forwardOf = {}; // dim -> 正向题 id 列表
const reverseOf = {};
QB.forEach(q => {
  const d = q.measures[0];
  (q.reverse ? (reverseOf[d] = reverseOf[d] || []) : (forwardOf[d] = forwardOf[d] || [])).push(q.id);
});

/** 构造一个画像的作答 */
function buildAnswers(spec) {
  const ans = {};
  QB.forEach(q => {
    const d = q.measures[0];
    const level = spec[d] !== undefined ? spec[d] : 2; // 默认中档
    ans[q.id] = q.reverse ? (4 - level) : level;
  });
  return ans;
}

/** 用页面真实函数跑完整结果生成 */
function runProfile(name, answers) {
  T.state.questions = [...QB];
  T.state.userAnswers = { ...answers };
  T.state.answeredCount = QB.length;
  T.state.testCompleted = true;
  T.state.responseTimes = {};
  // 填充合理的作答时长（避免触发"作答过快"）
  QB.forEach(q => { T.state.responseTimes[q.id] = 4000; });

  // 清空上一轮的 innerHTML
  Object.values(elCache).forEach(el => { el.innerHTML = ''; });

  try {
    T.showResults();
  } catch (e) {
    bad(`[${name}] showResults 抛出异常: ${e.message}`);
    return null;
  }

  const raw = T.calculateScores().scores;
  const norm = T.calculateNormalizedScores(raw);
  const reliability = T.calculateTestReliability();
  const inconsistencies = T.checkAnswerConsistency();
  const insights = T.analyzeAnswerPatterns();
  const consistency = T.analyzeReverseConsistency();

  return {
    name, raw, norm, reliability, inconsistencies, insights, consistency,
    coreHtml: elCache['coreFindings']?.innerHTML || '',
    detailsHtml: elCache['dimensionDetails']?.innerHTML || '',
    scienceHtml: elCache['testScience']?.innerHTML || '',
    compatHtml: elCache['compatibilityAnalysis']?.innerHTML || '',
    scoresHtml: elCache['scoresContainer']?.innerHTML || '',
  };
}

/** 校验工具 */
function expectNear(val, target, tol, label) {
  if (Math.abs(val - target) > tol) bad(`${label}: ${val}，期望 ${target}±${tol}`);
  else ok(`${label} = ${val}`);
}
function expectHighest(res, dim, label) {
  const others = DIMS.filter(d => d !== dim);
  const maxOther = Math.max(...others.map(d => res.norm[d]));
  if (res.norm[dim] < 85) bad(`${label}: ${dim} 维度仅 ${res.norm[dim]}，期望 >=85`);
  else if (res.norm[dim] <= maxOther) bad(`${label}: ${dim}(${res.norm[dim]}) 未显著高于其他维度(最高 ${maxOther})`);
  else ok(`${label}: ${dim}=${res.norm[dim]}，其他最高 ${maxOther}`);
}
function expectLowest(res, dim, label) {
  const others = DIMS.filter(d => d !== dim);
  const minOther = Math.min(...others.map(d => res.norm[d]));
  if (res.norm[dim] > 15) bad(`${label}: ${dim} 维度 ${res.norm[dim]}，期望 <=15`);
  else if (res.norm[dim] >= minOther + 30) bad(`${label}: ${dim}(${res.norm[dim]}) 未显著低于其他(最低 ${minOther})`);
  else ok(`${label}: ${dim}=${res.norm[dim]}，其他最低 ${minOther}`);
}
/** 分数段与描述文案匹配 */
function expectDescMatch(res, dim, label) {
  const score = res.norm[dim];
  const expected = score >= 70 ? ['非常强烈的', '明显的'] :
                   score >= 40 ? ['中等的', '一定程度的'] :
                   score >= 10 ? ['轻微的', '极轻微的'] : ['几乎没有'];
  const html = res.detailsHtml;
  // 从维度详情卡中截取该维度段落
  const segMatch = html.split('detail-card').find(seg => seg.includes(CHINESE_NAME(dim)));
  if (!segMatch) { warn(`${label}: 详情页未找到 ${dim} 段落`); return; }
  const descMatch = segMatch.match(/(非常强烈的|明显的|中等的|一定程度的|轻微的|极轻微的|几乎没有)倾向/);
  if (!descMatch) { warn(`${label}: ${dim} 段落未解析到倾向描述`); return; }
  if (!expected.includes(descMatch[1])) {
    bad(`${label}: ${dim} 得分 ${score} 但描述为「${descMatch[1]}倾向」，期望 ${expected.join('/')}`);
  } else {
    ok(`${label}: ${dim}=${score} -> 「${descMatch[1]}倾向」匹配`);
  }
}
function CHINESE_NAME(dim) {
  return T.CHINESE_NAMES[dim]; // 如 "D - Dominant 支配"
}

// ============================================================
console.log('='.repeat(64));
console.log('模拟 1：纯 D 型（支配强，其余全部低）');
console.log('='.repeat(64));
{
  const spec = { D: 4, sub: 0, S: 0, M: 0, SW: 0, BR: 0 };
  const r = runProfile('纯D', buildAnswers(spec));
  if (r) {
    expectHighest(r, 'D', '纯D');
    expectLowest(r, 'sub', '纯D');
    expectLowest(r, 'M', '纯D');
    expectDescMatch(r, 'D', '纯D');
    expectDescMatch(r, 'sub', '纯D');
    // 核心发现应点名 D
    if (!r.coreHtml.includes('D - Dominant')) bad('纯D: 核心发现未提及 D 维度');
    else ok('核心发现主要倾向 = D');
    // 类型概括
    if (!r.coreHtml.includes('主导型')) bad('纯D: 缺少「主导型」类型标签');
    else if (!r.coreHtml.includes('Dominant')) bad('纯D: 类型标签缺英文对照');
    else ok('类型概括 = 主导型 (Dominant)');
    // D 的答题特征不应是「幻想型」
    const dInsight = r.insights.D || '';
    if (dInsight.includes('幻想型')) bad('纯D: 答题特征误判为幻想型 -> ' + dInsight);
    else ok('D 答题特征: ' + dInsight.slice(0, 30) + '...');
    // 不应触发 dual_role
    if (r.inconsistencies.some(i => i.type === 'dual_role')) bad('纯D: 不应触发 D+sub 双高提示');
  }
}

console.log('');
console.log('='.repeat(64));
console.log('模拟 2：纯 sub 型');
console.log('='.repeat(64));
{
  const r = runProfile('纯sub', buildAnswers({ sub: 4, D: 0, S: 0, M: 0, SW: 0, BR: 0 }));
  if (r) {
    expectHighest(r, 'sub', '纯sub');
    expectLowest(r, 'D', '纯sub');
    expectDescMatch(r, 'sub', '纯sub');
    if (!r.coreHtml.includes('sub - Submissive')) bad('纯sub: 核心发现未提及 sub');
    else ok('核心发现主要倾向 = sub');
    if (!r.coreHtml.includes('臣服型')) bad('纯sub: 缺少「臣服型」类型标签');
    else ok('类型概括 = 臣服型');
  }
}

console.log('');
console.log('='.repeat(64));
console.log('模拟 3：纯 S 型 / 模拟 4：纯 M 型');
console.log('='.repeat(64));
{
  const rs = runProfile('纯S', buildAnswers({ S: 4, D: 0, sub: 0, M: 0, SW: 0, BR: 0 }));
  if (rs) {
    expectHighest(rs, 'S', '纯S');
    expectLowest(rs, 'M', '纯S');
    expectDescMatch(rs, 'S', '纯S');
  }
  const rm = runProfile('纯M', buildAnswers({ M: 4, D: 0, sub: 0, S: 0, SW: 0, BR: 0 }));
  if (rm) {
    expectHighest(rm, 'M', '纯M');
    expectLowest(rm, 'S', '纯M');
    expectDescMatch(rm, 'M', '纯M');
  }
}

console.log('');
console.log('='.repeat(64));
console.log('模拟 5：纯 BR 型');
console.log('='.repeat(64));
{
  const r = runProfile('纯BR', buildAnswers({ BR: 4, D: 0, sub: 0, S: 0, M: 0, SW: 0 }));
  if (r) {
    expectHighest(r, 'BR', '纯BR');
    // BR 高 + D/sub 低应触发 brat_without_sub 特征组合
    const has = r.inconsistencies.some(i => i.type === 'brat_without_sub');
    if (!has) warn('纯BR: 未触发 brat_without_sub 特征组合说明');
    else ok('触发 brat_without_sub 组合说明（符合预期）');
  }
}

console.log('');
console.log('='.repeat(64));
console.log('模拟 6：Switch 型（D+sub 双高）');
console.log('='.repeat(64));
{
  const r = runProfile('Switch', buildAnswers({ D: 4, sub: 4, S: 1, M: 1, SW: 3, BR: 2 }));
  if (r) {
    if (r.norm.D < 85) bad(`Switch: D=${r.norm.D}，期望 >=85`);
    if (r.norm.sub < 85) bad(`Switch: sub=${r.norm.sub}，期望 >=85`);
    if (r.norm.D >= 85 && r.norm.sub >= 85) ok(`D=${r.norm.D} sub=${r.norm.sub} 双高`);
    const has = r.inconsistencies.some(i => i.type === 'dual_role');
    if (!has) bad('Switch: 应触发 dual_role 特征组合说明');
    else ok('触发 dual_role 说明');
    // 检查说明文案是否为中性（不含「不一致」指责）
    const inc = r.inconsistencies.find(i => i.type === 'dual_role');
    if (inc && inc.message.includes('不一致，建议回顾')) bad('Switch: 文案仍是指责式');
    // 双高时应显示「双向组合特征」（替代次要倾向段，避免信息重复）
    if (r.norm.sub > 50 && r.norm.D > 50 && (r.norm.D - r.norm.sub) <= 15) {
      if (!r.coreHtml.includes('双向组合特征')) {
        bad('Switch: D+sub 双高但核心发现缺少「双向组合特征」段落');
      } else if (!r.coreHtml.includes('Switch')) {
        bad('Switch: 组合说明未点名 Switch 特质');
      } else {
        ok('核心发现包含「双向组合特征」并点名 Switch');
      }
    }
    // 类型概括
    if (!r.coreHtml.includes('双向切换型')) bad('Switch: 缺少「双向切换型」类型标签');
    else ok('类型概括 = 双向切换型 (Switch)');
  }
}

console.log('');
console.log('='.repeat(64));
console.log('模拟 7：S+M 双高（双向强度特质）');
console.log('='.repeat(64));
{
  const r = runProfile('S+M', buildAnswers({ S: 4, M: 4, D: 1, sub: 1, SW: 2, BR: 1 }));
  if (r) {
    if (r.norm.S < 85 || r.norm.M < 85) bad(`S+M: S=${r.norm.S} M=${r.norm.M}，期望双 85+`);
    else ok(`S=${r.norm.S} M=${r.norm.M} 双高`);
    const has = r.inconsistencies.some(i => i.type === 'dual_intensity');
    if (!has) bad('S+M: 应触发 dual_intensity 说明');
    else ok('触发 dual_intensity 说明');
  }
}

console.log('');
console.log('='.repeat(64));
console.log('模拟 8：真实 vanilla（全维度低倾向）');
console.log('='.repeat(64));
{
  // 低倾向者：正向题选 0-1，反向题选 3-4（翻转后 0-1）
  const answers = {};
  QB.forEach(q => {
    const level = (q.id % 2 === 0) ? 0 : 1; // 在 0/1 间轻微摇摆，模拟真实作答
    answers[q.id] = q.reverse ? (4 - level) : level;
  });
  const r = runProfile('vanilla', answers);
  if (r) {
    DIMS.forEach(d => {
      if (r.norm[d] > 25) bad(`vanilla: ${d}=${r.norm[d]}，期望 <=25`);
    });
    ok('各维度均 <=25: ' + DIMS.map(d => `${d}=${r.norm[d]}`).join(' '));
    // 应显示传统关系倾向
    if (!r.coreHtml.includes('传统关系倾向')) warn('vanilla: 未显示「传统关系倾向」段落');
    else ok('显示传统关系倾向段落');
    if (!r.coreHtml.includes('温和传统型')) bad('vanilla: 缺少「温和传统型」类型标签');
    else ok('类型概括 = 温和传统型');
    // 低倾向一致作答（正向低+反向高）是自洽的，绝不能报方向冲突（故障注入 F6 需此断言拦截）
    if (r.consistency.conflict > 0) {
      bad(`vanilla: 低倾向一致作答被误报方向冲突 conflict=${r.consistency.conflict}`);
    } else {
      ok('低倾向一致作答 conflict=0，未误报冲突');
    }
    if (r.consistency.ratio < 0.8) {
      bad(`vanilla: 低倾向一致作答 matched 率过低 ${r.consistency.ratio.toFixed(2)}`);
    }
  }
}

console.log('');
console.log('='.repeat(64));
console.log('模拟 9：温和画像（全维度中等偏上，正向3/反向1，语义一致）');
console.log('='.repeat(64));
{
  const r = runProfile('温和画像', buildAnswers({ D: 3, sub: 3, S: 3, M: 3, SW: 3, BR: 3 }));
  if (r) {
    DIMS.forEach(d => expectNear(r.norm[d], 75, 3, `温和画像 ${d}`));
    console.log('    作答质量: ' + r.reliability.score + '% (' + r.reliability.level + ')');
    r.reliability.factors.forEach(f => console.log('      - ' + f));
    // 语义一致的画像作答不应被误判为敷衍
    if (r.reliability.score < 70) bad(`温和画像: 质量分 ${r.reliability.score}，一致作答不应被误伤`);
    else ok('语义一致的画像作答获得高质量评分');
  }
}

console.log('');
console.log('='.repeat(64));
console.log('模拟 10：直线作答 / 讨好性作答（原始选项位置全相同）');
console.log('='.repeat(64));
{
  [2, 3, 4, 0].forEach(ci => {
    const flat = {};
    QB.forEach(q => flat[q.id] = ci); // 不区分正反向，全部选同一位置
    const r = runProfile('直线' + ci, flat);
    if (r) {
      console.log(`    全选第 ${ci + 1} 档: 质量 ${r.reliability.score}%`);
      const lineFactor = r.reliability.factors.find(f => f.includes('直线'));
      if (!lineFactor) bad(`全选第${ci + 1}档: 未识别为直线作答 -> ${r.reliability.factors.join(' | ')}`);
      else if (r.reliability.score >= 50) bad(`全选第${ci + 1}档: 质量 ${r.reliability.score} 未判低`);
      else ok(`全选第 ${ci + 1} 档 -> 判直线作答 (${r.reliability.score}%)`);
      // 直线作答不应显示「方向冲突」（是无法评估，不是冲突）——升级为硬断言
      if (r.reliability.factors.some(f => f.includes('方向冲突'))) {
        bad(`全选第${ci+1}档: 直线作答被误报「方向冲突」（应为无法评估）`);
      } else {
        ok(`全选第${ci+1}档: 未误报方向冲突`);
      }
    }
  });
  // 讨好型（全 4 档）额外验证分数被拉满但质量判低
  const acq = {};
  QB.forEach(q => acq[q.id] = 4);
  const r4 = runProfile('讨好', acq);
  if (r4) {
    console.log('    讨好型各维度: ' + DIMS.map(d => `${d}=${r4.norm[d]}`).join(' '));
    DIMS.forEach(d => {
      if (r4.norm[d] < 80) warn(`讨好型 ${d}=${r4.norm[d]}（全4档应得高分）`);
    });
    if (r4.reliability.score >= 50) bad(`讨好型: 质量 ${r4.reliability.score} 未判低`);
    else ok('讨好型全 4 档被判低 (' + r4.reliability.score + '%)');
  }
}

console.log('');
console.log('='.repeat(64));
console.log('模拟 11：D 强 + BR 强（brat-dominant 双高组合）');
console.log('='.repeat(64));
{
  const r = runProfile('bratDom', buildAnswers({ D: 4, BR: 4, sub: 1, S: 2, M: 0, SW: 1 }));
  if (r) {
    // D 和 BR 都应显著高（这正是 brat-dominant 的画像）
    if (r.norm.D < 85 || r.norm.BR < 85) bad(`bratDom: D=${r.norm.D} BR=${r.norm.BR}，期望双 85+`);
    else ok(`D=${r.norm.D} BR=${r.norm.BR} 双高`);
    const others = DIMS.filter(d => d !== 'D' && d !== 'BR');
    const maxOther = Math.max(...others.map(d => r.norm[d]));
    if (maxOther > 60) bad(`bratDom: 其他维度过高 (${maxOther})`);
    const has = r.inconsistencies.some(i => i.type === 'brat_dominant');
    if (!has) warn('bratDom: 未触发 brat_dominant 说明');
    else ok('触发 brat_dominant 说明');
  }
}

console.log('');
console.log('='.repeat(64));
console.log('模拟 12：D 型 + 低质量作答信号（快速作答）');
console.log('='.repeat(64));
{
  const answers = buildAnswers({ D: 4, sub: 0, S: 0, M: 0, SW: 0, BR: 0 });
  const r = runProfile('D快速', answers);
  if (r) {
    // 模拟极快作答
    T.state.responseTimes = {};
    QB.forEach(q => { T.state.responseTimes[q.id] = 500; });
    const rel = T.calculateTestReliability();
    console.log('    极速作答(500ms/题)质量: ' + rel.score + '% (' + rel.level + ')');
    rel.factors.forEach(f => console.log('      - ' + f));
    if (rel.score >= 70) warn('极速作答未显著降低质量分');
    else ok('极速作答被降级');
    // 但 D 型作答档位只有 2 种（正向4/反向0），不应因「档位少」被判敷衍
    const distFactor = rel.factors.find(f => f.includes('档位'));
    if (distFactor && distFactor.includes('敷衍')) {
      bad('D型作答因档位少被误判敷衍: ' + distFactor);
    } else if (distFactor) {
      console.log('    档位评价: ' + distFactor);
    }
  }
}

console.log('');
console.log('='.repeat(64));
console.log('模拟 13：年龄确认门 + 沟通清单');
console.log('='.repeat(64));
{
  // 未勾选年龄确认 -> 不应进入作答场景
  // （mock 元素按需创建，先主动查询一次触发创建）
  const gate = documentMock.getElementById('ageGate');
  if (!gate) {
    bad('年龄门: HTML 中无 ageGate 元素');
  } else {
    gate.checked = false;
    const before = (elCache['testScene']?.classList._set.has('active')) || false;
    T.startFlow();
    const after = elCache['testScene'].classList._set.has('active');
    if (after && !before) bad('年龄门: 未确认年龄也进入了作答');
    else ok('未确认年龄时 startFlow 不放行');

    // 勾选后放行
    gate.checked = true;
    T.startFlow();
    if (!elCache['testScene'].classList._set.has('active')) bad('年龄门: 勾选后未进入作答');
    else ok('确认年龄后正常进入作答');
  }

  // 沟通自评清单（KOS 借鉴项）
  const answers = buildAnswers({ D: 4, sub: 0, S: 2, M: 2, SW: 1, BR: 1 });
  const r = runProfile('清单', answers);
  if (r && !r.compatHtml.includes('协商与沟通')) {
    // 清单在 communicationGuide 容器
    const cg = elCache['communicationGuide']?.innerHTML || '';
    if (!cg.includes('协商与沟通自评清单')) bad('安全指南缺少「协商与沟通自评清单」');
    else if (!cg.includes('安全词') || !cg.includes('善后安抚')) bad('沟通清单缺少关键项');
    else ok('协商与沟通自评清单已呈现（含安全词/善后安抚）');
  }
}

// ============================================================
console.log('');
console.log('='.repeat(64));
console.log('结论');
console.log('='.repeat(64));
if (errors.length) {
  console.log(`[FAIL] ${errors.length} 项错误:`);
  errors.forEach(e => console.log('  X ' + e));
} else {
  console.log('[PASS] 全部人格模拟通过');
}
if (warnings.length) {
  console.log(`\n[WARN] ${warnings.length} 项:`);
  [...new Set(warnings)].forEach(w => console.log('  ! ' + w));
}
process.exit(errors.length ? 1 : 0);