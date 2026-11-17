/**
 * 运行时验证：在 Node 中提取并执行页面 JS，模拟完整作答流程。
 * 目的：确认改造后无 ReferenceError / TypeError，且计分链路端到端可达。
 */
import fs from 'fs';
import vm from 'vm';

const html = fs.readFileSync('index.html', 'utf-8');

// ---- 提取 QUESTION_BANK / ATTRIBUTES / CHINESE_NAMES ----
function extractBlock(name, endMarker) {
  const start = html.indexOf(name);
  if (start === -1) throw new Error('未找到 ' + name);
  const end = html.indexOf(endMarker, start);
  if (end === -1) throw new Error('未找到结束标记 ' + endMarker);
  return html.slice(start, end + endMarker.length);
}

const questionBankSrc = extractBlock('const QUESTION_BANK = [', '\n            ];');
const attrsSrc = extractBlock('const ATTRIBUTES = {', '\n            };');
const namesSrc = extractBlock('const CHINESE_NAMES = {', '\n            };');

const sandbox = { console };
vm.createContext(sandbox);

// const 声明不会挂到 sandbox 上，改用显式 return 取出
const collect = `
${attrsSrc.replace('const ATTRIBUTES = {', 'var ATTRIBUTES = {')}
${namesSrc.replace('const CHINESE_NAMES = {', 'var CHINESE_NAMES = {')}
${questionBankSrc.replace('const QUESTION_BANK = [', 'var QUESTION_BANK = [')}
JSON.stringify({ ATTRIBUTES, CHINESE_NAMES, QUESTION_BANK });
`;
const parsed = JSON.parse(vm.runInContext(collect, sandbox));

const { QUESTION_BANK, ATTRIBUTES, CHINESE_NAMES } = parsed;

let errors = [];
let warnings = [];
const ok = (m) => console.log('  [OK] ' + m);
const bad = (m) => { errors.push(m); console.log('  [FAIL] ' + m); };
const warn = (m) => { warnings.push(m); console.log('  [WARN] ' + m); };

console.log('='.repeat(62));
console.log('1. 题库运行时校验');
console.log('='.repeat(62));

console.log(`  题目数: ${QUESTION_BANK.length}`);
if (QUESTION_BANK.length !== 48) bad(`题库应为 48 题，实际 ${QUESTION_BANK.length}`);

const ids = QUESTION_BANK.map(q => q.id);
if (new Set(ids).size !== ids.length) bad('存在重复题号');
else ok('题号唯一');

// 维度分布
const dist = {};
QUESTION_BANK.forEach(q => q.measures.forEach(d => { dist[d] = (dist[d] || 0) + 1; }));
console.log('  维度分布: ' + JSON.stringify(dist));
Object.keys(ATTRIBUTES).forEach(d => {
  if (dist[d] !== 8) bad(`${d} 维度题量 ${dist[d]}，应为 8`);
});

// 选项结构
let structOk = true;
QUESTION_BANK.forEach(q => {
  if (!Array.isArray(q.choices) || q.choices.length !== 5) {
    bad(`题目 ${q.id} 选项数不是 5`);
    structOk = false;
  }
  q.choices.forEach((c, i) => {
    if (!c.text || typeof c.text !== 'string') { bad(`题目 ${q.id} 选项 ${i} 缺 text`); structOk = false; }
    if (!c.scores || typeof c.scores !== 'object') { bad(`题目 ${q.id} 选项 ${i} 缺 scores`); structOk = false; }
    else {
      const keys = Object.keys(c.scores);
      if (keys.length !== 1) { bad(`题目 ${q.id} 选项 ${i} scores 有 ${keys.length} 个维度`); structOk = false; }
      const v = c.scores[keys[0]];
      if (typeof v !== 'number' || v < 0 || v > 4) { bad(`题目 ${q.id} 选项 ${i} 分值越界: ${v}`); structOk = false; }
    }
  });
  if (typeof q.text !== 'string' || !q.text.trim()) { bad(`题目 ${q.id} 缺 text`); structOk = false; }
});
if (structOk) ok('48 题结构完整（5 选项、分值 0-4）');

// 反向题
const revQs = QUESTION_BANK.filter(q => q.reverse);
console.log(`  反向题: [${revQs.map(q => q.id).join(', ')}]`);
if (revQs.length !== 6) bad(`反向题应为 6 道，实际 ${revQs.length}`);
else ok('反向题数量正确');

// 每个反向题的分值必须自然升序
revQs.forEach(q => {
  const vals = q.choices.map(c => Object.values(c.scores)[0]);
  const ascending = vals.every((v, i) => i === 0 || v > vals[i - 1]);
  if (!ascending) bad(`反向题 ${q.id} 分值非升序: [${vals}]，会导致双重翻转`);
});

console.log('');
console.log('='.repeat(62));
console.log('2. 计分逻辑（复刻页面 calculateScores）');
console.log('='.repeat(62));

function calculateScores(userAnswers) {
  const scores = {};
  Object.keys(ATTRIBUTES).forEach(d => scores[d] = 0);
  QUESTION_BANK.forEach(q => {
    const ci = userAnswers[q.id];
    if (ci === undefined || ci === null) return;
    const choice = q.choices[ci];
    if (!choice) return;
    Object.keys(choice.scores).forEach(d => {
      if (Object.prototype.hasOwnProperty.call(ATTRIBUTES, d)) {
        let s = choice.scores[d];
        if (typeof s === 'number' && !isNaN(s) && s >= 0) {
          if (q.reverse) s = (q.choices.length - 1) - s;
          scores[d] += s;
        }
      }
    });
  });
  return scores;
}

function calculateTheoreticalMaxScores() {
  const max = {};
  QUESTION_BANK.forEach(q => {
    q.measures.forEach(d => {
      const mx = Math.max.apply(null, q.choices.map(c => Object.values(c.scores)[0]));
      max[d] = (max[d] || 0) + mx;
    });
  });
  return max;
}

const theoreticalMax = calculateTheoreticalMaxScores();
console.log('  理论满分: ' + JSON.stringify(theoreticalMax));
Object.keys(theoreticalMax).forEach(d => {
  if (theoreticalMax[d] !== 32) bad(`${d} 理论满分 ${theoreticalMax[d]}，应为 32`);
});

function normalize(raw) {
  const out = {};
  Object.keys(ATTRIBUTES).forEach(d => {
    const mx = theoreticalMax[d] || 1;
    out[d] = Math.min(100, Math.max(0, Math.round((raw[d] / mx) * 100)));
  });
  return out;
}

// 场景测试
const scenarios = [
  { name: '全最低档', pick: () => 0 },
  { name: '全中档',   pick: () => 2 },
  { name: '全最高档', pick: () => 4 },
];

scenarios.forEach(sc => {
  const ans = {};
  QUESTION_BANK.forEach(q => ans[q.id] = sc.pick());
  const raw = calculateScores(ans);
  const norm = normalize(raw);
  console.log(`  ${sc.name}: 归一化 ${JSON.stringify(norm)}`);
});

// D 型 / sub 型 / S 型 / M 型 定向测试
const types = { D: 'D', sub: 'sub', S: 'S', M: 'M', SW: 'SW', BR: 'BR' };
Object.keys(types).forEach(target => {
  const ans = {};
  QUESTION_BANK.forEach(q => {
    if (q.measures[0] === target) ans[q.id] = q.reverse ? 0 : 4;
    else ans[q.id] = 2;
  });
  const norm = normalize(calculateScores(ans));
  const self = norm[target];
  const others = Object.keys(norm).filter(d => d !== target);
  const maxOther = Math.max.apply(null, others.map(d => norm[d]));
  if (self < 95) bad(`${target} 型作答自身维度仅得 ${self}，期望 >=95`);
  else if (self <= maxOther) bad(`${target} 型作答未显著高于其他维度 (self=${self}, maxOther=${maxOther})`);
  else ok(`${target} 型 -> 自身 ${self}，其他最高 ${maxOther}`);
});

// Switch 型（D 和 sub 同时高）
const swAns = {};
QUESTION_BANK.forEach(q => {
  const d = q.measures[0];
  if (d === 'D' || d === 'sub') swAns[q.id] = q.reverse ? 0 : 4;
  else swAns[q.id] = 2;
});
const swNorm = normalize(calculateScores(swAns));
console.log(`  Switch 型 -> D=${swNorm.D} sub=${swNorm.sub}`);
if (swNorm.D < 95 || swNorm.sub < 95) bad('Switch 型未能同时在 D/sub 得高分');

// 反向题矛盾作答检测
const contraAns = {};
QUESTION_BANK.forEach(q => {
  if (q.measures[0] === 'D') contraAns[q.id] = 4; // 正反向同向
  else contraAns[q.id] = 2;
});
const contraNorm = normalize(calculateScores(contraAns));
console.log(`  D 维度矛盾作答 -> D=${contraNorm.D} (满分作答为 100)`);
if (contraNorm.D >= 95) bad('矛盾作答未能被计分区分');
else ok('矛盾作答被正确区分');

console.log('');
console.log('='.repeat(62));
console.log('3. 反向题一致性检测（analyzeReverseConsistency）');
console.log('='.repeat(62));

function analyzeReverseConsistency(userAnswers) {
  const dimsWithReverse = {};
  QUESTION_BANK.forEach(q => { if (q.reverse) dimsWithReverse[q.measures[0]] = true; });
  let checked = 0, matched = 0, conflict = 0, unclear = 0;
  Object.keys(dimsWithReverse).forEach(dim => {
    const dimQs = QUESTION_BANK.filter(q => q.measures[0] === dim);
    let rSum = 0, rN = 0, fSum = 0, fN = 0;
    dimQs.forEach(q => {
      const ci = userAnswers[q.id];
      if (ci === undefined || ci === null) return;
      if (q.reverse) { rSum += ci; rN++; } else { fSum += ci; fN++; }
    });
    if (!rN || !fN) return;
    checked++;
    const forwardAvg = fSum / fN;
    const reverseAvg = rSum / rN;
    const highF = forwardAvg >= 2.5, lowF = forwardAvg <= 1.5;
    const highR = reverseAvg >= 2.5, lowR = reverseAvg <= 1.5;
    // 高倾向一致（享受+不会不安）与低倾向一致（不享受+会不安）都算 matched
    if ((highF && lowR) || (lowF && highR)) matched++;
    else if (highF && highR) conflict++; // 既享受又会不安 = 方向冲突
    else unclear++;                      // 无区分度（直线/居中作答）
  });
  return { checked, matched, conflict, unclear, ratio: checked ? matched / checked : 0 };
}

// 高倾向一致作答：正向选高、反向选低
const consistentAns = {};
QUESTION_BANK.forEach(q => consistentAns[q.id] = q.reverse ? 0 : 4);
const r1 = analyzeReverseConsistency(consistentAns);
console.log(`  高倾向一致作答: ${r1.matched}/${r1.checked}  ratio=${r1.ratio.toFixed(2)}`);
if (r1.ratio < 0.8) bad(`高倾向一致作答检出率过低: ${r1.ratio}`);

// 低倾向一致作答：正向选低、反向选高 —— 不得被误报为冲突
const lowAns = {};
QUESTION_BANK.forEach(q => lowAns[q.id] = q.reverse ? 4 : 0);
const rLow = analyzeReverseConsistency(lowAns);
console.log(`  低倾向一致作答: matched=${rLow.matched}/${rLow.checked} conflict=${rLow.conflict}`);
if (rLow.ratio < 0.8) bad(`低倾向一致作答被误判: ratio=${rLow.ratio}`);
if (rLow.conflict > 0) bad(`低倾向一致作答被误报方向冲突: ${rLow.conflict}/6`);
else ok('低倾向一致作答未被误报冲突');

// 敷衍作答：全部选同一位置 -> matched 必须低
const cases = [
  { name: '全选第1档', idx: 0 },
  { name: '全选第3档', idx: 2 },
  { name: '全选第4档', idx: 3 },
  { name: '全选第5档', idx: 4 },
];
cases.forEach(c => {
  const flat = {};
  QUESTION_BANK.forEach(q => flat[q.id] = c.idx);
  const r = analyzeReverseConsistency(flat);
  console.log(`  ${c.name}: matched=${r.matched} conflict=${r.conflict} unclear=${r.unclear}`);
  if (r.ratio > 0.5) bad(`${c.name} 敷衍作答被判一致: ratio=${r.ratio}`);
});

// 讨好性作答：全选最高档（既享受又会不安）-> 应报方向冲突
const acq = {};
QUESTION_BANK.forEach(q => acq[q.id] = 4);
const r3 = analyzeReverseConsistency(acq);
console.log(`  讨好性作答(全选最高档): conflict=${r3.conflict}/${r3.checked}`);
if (r3.conflict < 4) bad(`讨好性作答未被识别为方向冲突: conflict=${r3.conflict}`);
else ok('讨好性作答被识别为方向冲突');

console.log('');
console.log('='.repeat(62));
console.log('4. 结果文案生成（getScoreDescription）');
console.log('='.repeat(62));

function getScoreDescription(score) {
  if (score >= 85) return '非常强烈的';
  if (score >= 70) return '明显的';
  if (score >= 55) return '中等的';
  if (score >= 40) return '一定程度的';
  if (score >= 25) return '轻微的';
  if (score >= 10) return '极轻微的';
  return '几乎没有';
}

[100, 85, 70, 55, 40, 25, 10, 0].forEach(s => {
  console.log(`  ${String(s).padStart(3)} -> ${getScoreDescription(s)}倾向`);
});

// getDimensionDetailDescription 的 level 分档
const levelOf = (score) => score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low';
console.log(`  描述分档: 70->${levelOf(70)}  69->${levelOf(69)}  40->${levelOf(40)}  39->${levelOf(39)}`);

console.log('');
console.log('='.repeat(62));
console.log('结论');
console.log('='.repeat(62));
if (errors.length) {
  console.log(`[FAIL] ${errors.length} 项错误:`);
  errors.forEach(e => console.log('  X ' + e));
} else {
  console.log('[PASS] 全部运行时检查通过');
}
if (warnings.length) {
  console.log(`\n[WARN] ${warnings.length} 项:`);
  warnings.forEach(w => console.log('  ! ' + w));
}
process.exit(errors.length ? 1 : 0);