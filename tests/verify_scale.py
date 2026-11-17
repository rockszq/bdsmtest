# -*- coding: utf-8 -*-
"""
量表修补后的验证脚本。
目的：确认改动没有破坏计分链路、题量分布与反向题逻辑。
"""
import io
import re
import json
import sys

PATH = 'index.html'

with io.open(PATH, 'r', encoding='utf-8') as f:
    src = f.read()

errors = []
warnings = []

# ---- 提取 QUESTION_BANK ----
start = src.index('const QUESTION_BANK = [')
end = src.index('];', start)
bank_src = src[start:end + 1]

# 逐题解析
qid_re = re.compile(r"\{\s*id:\s*(\d+),(.*?)\n\s*\}", re.S)
qids = [int(m) for m in re.findall(r"\{\s*id:\s*(\d+),", bank_src)]

print('=' * 62)
print('1. 题库结构')
print('=' * 62)
print('题目总数: %d' % len(qids))
if len(qids) != 48:
    errors.append('题库总数应为 48，实际 %d' % len(qids))
if len(set(qids)) != len(qids):
    errors.append('存在重复题号')

# 维度分布
dims = {'D': [], 'sub': [], 'S': [], 'M': [], 'SW': [], 'BR': []}
for m in re.finditer(r"\{\s*id:\s*(\d+),.*?measures:\s*\[([^\]]+)\]", bank_src, re.S):
    qid = int(m.group(1))
    ds = re.findall(r"'([^']+)'", m.group(2))
    for d in ds:
        if d in dims:
            dims[d].append(qid)

print('\n各维度题量:')
for d, lst in dims.items():
    flag = 'OK' if len(lst) == 8 else '异常'
    print('  %-4s %2d 题  %s   %s' % (d, len(lst), flag, sorted(lst)))
    if len(lst) != 8:
        errors.append('%s 维度题量为 %d，应为 8' % (d, len(lst)))

# ---- 反向题 ----
print()
print('=' * 62)
print('2. 反向题校验')
print('=' * 62)
rev_by_dim = {}
_rev_blocks = re.split(r'(?=\{\s*id:\s*\d+,)', bank_src)
for blk in _rev_blocks:
    if 'reverse: true' not in blk:
        continue
    m_id = re.match(r"\{\s*id:\s*(\d+),", blk)
    m_dim = re.search(r"measures:\s*\[([^\]]+)\]", blk)
    if not m_id or not m_dim:
        continue
    ds = re.findall(r"'([^']+)'", m_dim.group(1))
    for d in ds:
        rev_by_dim.setdefault(d, []).append(int(m_id.group(1)))

for d in dims:
    rs = sorted(rev_by_dim.get(d, []))
    status = 'OK' if len(rs) == 1 else ('未设置' if len(rs) == 0 else '重复')
    print('  %-4s 反向题 %d 道  %s  %s' % (d, len(rs), status, rs))
    if len(rs) == 0:
        warnings.append('%s 维度缺少反向题' % d)

# 重新从 blocks 提取反向题号
rev_ids = sorted([q for lst in rev_by_dim.values() for q in lst])
print('反向题题号: %s' % rev_ids)
if len(rev_ids) != 6:
    errors.append('反向题应为 6 道，实际 %d' % len(rev_ids))

# 校验每道反向题的分值是否为自然升序 0..4（否则会双重翻转）
print('\n反向题分值序列校验（应为升序 0,1,2,3,4）:')
for rid in rev_ids:
    # 题目以 choices 数组的 "]}" 结尾，不能只匹配 "}"
    m = re.search(r"\{\s*id:\s*%d,(.*?)\]\s*\}," % rid, bank_src, re.S)
    if not m:
        errors.append('题号 %d 解析失败' % rid)
        continue
    body = m.group(1)
    dm = re.search(r"measures:\s*\['([^']+)'\]", body)
    dim = dm.group(1) if dm else '?'
    vals = re.findall(r"scores:\s*\{\s*%s:\s*(\d+)\s*\}" % re.escape(dim), body)
    vals = [int(v) for v in vals]
    ascending = vals == sorted(vals) and vals == [0, 1, 2, 3, 4]
    print('  id=%-3d %-4s %s  %s' % (rid, dim, vals, 'OK' if ascending else '异常(会导致双重翻转)'))
    if not ascending:
        errors.append('反向题 id=%d 分值非自然升序: %s' % (rid, vals))

# ---- 计分链路模拟 ----
print()
print('=' * 62)
print('3. 计分链路模拟')
print('=' * 62)

# 解析全部题目为结构体
questions = []
for m in re.finditer(r"\{\s*id:\s*(\d+),(.*?)(?=\n\s*\{ id:|\Z)", bank_src, re.S):
    qid = int(m.group(1))
    body = m.group(2)
    dm = re.search(r"measures:\s*\[([^\]]+)\]", body)
    if not dm:
        continue
    dim = re.findall(r"'([^']+)'", dm.group(1))[0]
    is_rev = 'reverse: true' in body
    n_choices = len(re.findall(r"\{ text:", body))
    questions.append({'id': qid, 'dim': dim, 'reverse': is_rev, 'n': n_choices})

print('解析到题目结构: %d 道' % len(questions))
bad_n = [q for q in questions if q['n'] != 5]
if bad_n:
    errors.append('以下题目选项数不为 5: %s' % [q['id'] for q in bad_n])
else:
    print('所有题目均为 5 点量表  OK')


def simulate(answers):
    """复刻 calculateScores 的逻辑"""
    scores = {d: 0 for d in dims}
    for q in questions:
        ci = answers.get(q['id'])
        if ci is None:
            continue
        scores[q['dim']] += (q['n'] - 1 - ci) if q['reverse'] else ci
    return scores


theoretical_max = 32  # 8 题 x 4 分

# 场景 1：全部选最高档
# 期望：7 道正向题各得 4 分 + 1 道反向题翻转后得 0 分 = 28
all_max = {q['id']: 4 for q in questions}
s = simulate(all_max)
print('\n场景1 全部选第5档 -> 原始分: %s' % s)
expected_max = 7 * 4  # 反向题翻转后贡献 0
for d in dims:
    if s[d] != expected_max:
        errors.append('场景1 %s 维度得 %d，期望 %d' % (d, s[d], expected_max))
print('  各维度: %s  (7正向x4 + 1反向翻转=0)' % {d: '%d/32' % s[d] for d in dims})

# 场景 2：全部选最低档
# 期望：7 道正向题各得 0 分 + 1 道反向题翻转后得 4 分 = 4
all_min = {q['id']: 0 for q in questions}
s2 = simulate(all_min)
print('\n场景2 全部选第1档 -> 原始分: %s' % s2)
expected_min = 4  # 反向题翻转后贡献 4
for d in dims:
    if s2[d] != expected_min:
        errors.append('场景2 %s 维度得 %d，期望 %d' % (d, s2[d], expected_min))

# 场景 3：典型 D 型（正向题选高，反向题选低）—— 应当 D 高
d_type = {}
for q in questions:
    if q['dim'] == 'D':
        d_type[q['id']] = 0 if q['reverse'] else 4
    else:
        d_type[q['id']] = 2
s3 = simulate(d_type)
print('\n场景3 典型 D 型作答 -> %s' % {d: '%d/32 (%.0f%%)' % (s3[d], s3[d] / 32 * 100) for d in dims})
if s3['D'] != theoretical_max:
    errors.append('场景3 D 维度得 %d，应为满分 %d' % (s3['D'], theoretical_max))
if s3['D'] <= s3['sub']:
    errors.append('场景3 D(%d) 应显著高于 sub(%d)' % (s3['D'], s3['sub']))

# 场景 4：sub 型
sub_type = {}
for q in questions:
    if q['dim'] == 'sub':
        sub_type[q['id']] = 0 if q['reverse'] else 4
    else:
        sub_type[q['id']] = 2
s4 = simulate(sub_type)
print('场景4 典型 sub 型 -> D=%d sub=%d' % (s4['D'], s4['sub']))
if s4['sub'] != theoretical_max or s4['sub'] <= s4['D']:
    errors.append('场景4 sub 型作答未正确体现')

# 场景 5：一致性 —— D 高但反向题也选高（应无法拿满，检测到矛盾）
inconsistent = {}
for q in questions:
    if q['dim'] == 'D':
        inconsistent[q['id']] = 4  # 反向题也选「非常会」= 矛盾作答
    else:
        inconsistent[q['id']] = 2
s5 = simulate(inconsistent)
print('场景5 D 维度矛盾作答（正向题与反向题同向）-> D=%d/32' % s5['D'])
if s5['D'] >= theoretical_max:
    errors.append('场景5 矛盾作答未能被计分逻辑区分')

# ---- S/D 构念纠缠检测 ----
print()
print('=' * 62)
print('4. S 维度与 D 维度构念纠缠检测')
print('=' * 62)
power_words = ['掌控', '权力', '服从', '掌控感', '被支配']
s_hits = []
for m in re.finditer(r"\{\s*id:\s*(1[7-9]|2[0-4]),(.*?)\n\s*\}", bank_src, re.S):
    qid = int(m.group(1))
    body = m.group(2)
    for w in ['掌控感', '看到对方服从', '增强权力感', '这是权力的体现', '带来掌控感', '掌控感极强', '最喜欢的控制方式']:
        if w in body:
            s_hits.append((qid, w))
print('S 维度选项中残留的「掌控/权力」类措辞: %d 处' % len(s_hits))
if s_hits:
    for qid, w in s_hits:
        warnings.append('S-Q%d 仍含「%s」——可能与 D 维度纠缠' % (qid, w))
    print('  ' + ', '.join('Q%d(%s)' % (q, w) for q, w in s_hits))
else:
    print('  已解耦  OK')

# ---- 伪科学措辞检测 ----
print()
print('=' * 62)
print('5. 伪科学/营销措辞扫描')
print('=' * 62)
banned = ['科学优化版', '科学设计', '科学版', '基于48个科学', '六维倾向科学']
found = [b for b in banned if b in src]
if found:
    print('仍存在: %s' % found)
    errors.append('仍存在伪科学措辞（这类措辞曾导致交付被质疑）: %s' % found)
else:
    print('关键伪科学措辞已清除  OK')

# ---- 反向题翻转逻辑存在性（结构层不只能靠复刻，必须核对真实实现）----
print()
print('=' * 62)
print('6. 反向题翻转逻辑存在性')
print('=' * 62)
if not re.search(r'if\s*\(\s*question\.reverse\s*\)\s*\{[^}]*maxPerChoice\s*-\s*score', src, re.S):
    errors.append('页面缺少反向题翻转逻辑（question.reverse 分支的 maxPerChoice - score）')
else:
    print('  [OK] 页面存在反向题翻转逻辑')

# ---- 阈值硬编码检测 ----
print()
print('=' * 62)
print('7. 阈值硬编码检测')
print('=' * 62)
hard = re.findall(r'(dMax|subMax|sMax|mMax|brMax|swMax)\s*=\s*(\d+)\s*;', src)
if hard:
    print('仍存在硬编码阈值: %s' % hard)
    errors.append('仍存在硬编码阈值: %s' % hard)
else:
    print('阈值已全部改为复用 calculateTheoreticalMaxScores()  OK')

# ---- 结论 ----
print()
print('=' * 62)
print('结论')
print('=' * 62)
if errors:
    print('[FAIL] %d 项错误:' % len(errors))
    for e in errors:
        print('  X ' + e)
else:
    print('[PASS] 核心计分链路验证通过')

if warnings:
    print('\n[WARN] %d 项待关注:' % len(warnings))
    for w in warnings:
        print('  ! ' + w)
else:
    print('无待关注项')

sys.exit(1 if errors else 0)