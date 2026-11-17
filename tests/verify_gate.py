# -*- coding: utf-8 -*-
"""
故障注入：验证四层回归门禁是否真能拦截历史出现过的 bug 类型。
每次把一个故障植入临时副本的 index.html，跑四层，检查是否有层报 FAIL。
用法： python tests/verify_gate.py
作用：给四层回归做故障注入体检——植入历史真实 bug，确认门禁仍能拦截。
这是回归机制的回归测试（meta-test），防止检查器自身腐化。
"""
import io
import os
import re
import shutil
import subprocess
import tempfile

SRC = r'D:\test\bdsmtest'
NODE = r'C:\Users\rockszq\.workbuddy\binaries\node\versions\22.22.2-6\node.exe'
PY = r'C:\Users\rockszq\.workbuddy\binaries\python\versions\3.13.12\python.exe'

with io.open(os.path.join(SRC, 'index.html'), encoding='utf-8') as f:
    BASE = f.read()

# (名称, 故障植入函数, 期望拦截层关键词)
FAULTS = []


def fault(name, expect):
    def deco(fn):
        FAULTS.append((name, fn, expect))
        return fn
    return deco


@fault('F1 删掉 a 全局颜色定义（浏览器默认蓝）', 'UI静态层')
def f1(s):
    return s.replace('        a {\n            color: var(--ink-soft);',
                     '        a {\n            /* COLOR REMOVED */', 1)


@fault('F2 canvas 用 var()（静默失效）', 'UI静态层')
def f2(s):
    return s.replace("ctx.strokeStyle = '#e8e3d9'; // = --rule-soft",
                     "ctx.strokeStyle = 'var(--rule-soft)';", 1)


@fault('F3 反向题分值改降序（双重翻转）', '结构层')
def f3(s):
    # 把 id=2 那题的 5 个分值 0,1,2,3,4 反转成 4,3,2,1,0
    old = '''{ text: "完全不会，我乐于承担", scores: { D: 0 } },
                    { text: "不太会，可以接受", scores: { D: 1 } },
                    { text: "一般，说不好", scores: { D: 2 } },
                    { text: "经常会，有些压力", scores: { D: 3 } },'''
    if old not in s:
        return s
    new = '''{ text: "完全不会，我乐于承担", scores: { D: 4 } },
                    { text: "不太会，可以接受", scores: { D: 3 } },
                    { text: "一般，说不好", scores: { D: 2 } },
                    { text: "经常会，有些压力", scores: { D: 1 } },'''
    return s.replace(old, new, 1)


@fault('F4 删掉 exportBtn 的 id（守卫失效）', 'UI静态层')
def f4(s):
    return s.replace('<button id="exportBtn" class="btn btn-secondary">',
                     '<button class="btn btn-secondary">', 1)


@fault('F5 计分翻转逻辑删掉（反向题不翻转）', '结构层')
def f5(s):
    return s.replace('''                                if (question.reverse) {
                                    const maxPerChoice = question.choices.length - 1;
                                    score = maxPerChoice - score;
                                }''',
                     '''                                if (false && question.reverse) {
                                    const maxPerChoice = question.choices.length - 1;
                                    score = maxPerChoice - score;
                                }''', 1)


@fault('F6 四态判定退化（低倾向一致误报冲突）', '端到端')
def f6(s):
    return s.replace('''                    } else if (lowF && highR) {
                        matched += 1; // 低倾向一致
                    } else if (highF && highR) {''',
                     '''                    } else if (lowF && highR) {
                        conflict += 1; // FAULT: 误报冲突
                    } else if (highF && highR) {''', 1)


@fault('F7 JS 语法错误', 'UI静态层')
def f7(s):
    return s.replace('function updateProgress() {', 'function updateProgress( {', 1)


@fault('F8 伪造科学措辞', '结构层')
def f8(s):
    return s.replace('<title>', '科学优化版 ', 1)


@fault('F9 硬编码阈值 dMax=32', '结构层')
def f9(s):
    return s.replace('function updateProgress() {',
                     'const dMax = 32;\n            function updateProgress() {', 1)


@fault('F10 文案承诺不存在的「空格键翻页」', 'UI静态层')
def f10(s):
    return s.replace('选择后自动进入下一题', '按空格键进入下一题', 1)


def run_checks(workdir):
    """返回 {层名: (returncode, 输出)}"""
    cmds = {
        '结构层': [PY, 'tests/verify_scale.py'],
        '计分层': [NODE, 'tests/verify_runtime.mjs'],
        '端到端': [NODE, 'tests/test_e2e.mjs'],
        'UI静态层': [PY, 'tests/verify_ui.py'],
    }
    res = {}
    for name, cmd in cmds.items():
        p = subprocess.run(cmd, cwd=workdir, capture_output=True,
                           text=True, encoding='utf-8', errors='replace', timeout=120)
        res[name] = (p.returncode, (p.stdout or '') + (p.stderr or ''))
    return res


def main():
    print('=' * 70)
    print('故障注入审计：四层回归门禁是否真能拦截历史 bug')
    print('=' * 70)
    tmp_root = os.path.join(tempfile.gettempdir(), 'bdsmtest_gate_verify')
    os.makedirs(tmp_root, exist_ok=True)

    # 基线：原样跑一次，必须全绿
    base_dir = os.path.join(tmp_root, 'baseline')
    if os.path.exists(base_dir):
        shutil.rmtree(base_dir)
    os.makedirs(base_dir)
    shutil.copy(os.path.join(SRC, 'index.html'), os.path.join(base_dir, 'index.html'))
    shutil.copytree(os.path.join(SRC, 'tests'), os.path.join(base_dir, 'tests'))
    base = run_checks(base_dir)
    base_fail = [k for k, (rc, _) in base.items() if rc != 0]
    print('\n基线（未植入故障）: %s' % ('全绿 OK' if not base_fail else 'FAIL ' + str(base_fail)))
    if base_fail:
        print('基线都不绿，故障注入无意义，终止。')
        return 2

    results = []
    for name, fn, expect in FAULTS:
        mutated = fn(BASE)
        changed = mutated != BASE
        wd = os.path.join(tmp_root, re.sub(r'[^A-Za-z0-9]', '_', name)[:20])
        if os.path.exists(wd):
            shutil.rmtree(wd)
        os.makedirs(wd)
        with io.open(os.path.join(wd, 'index.html'), 'w', encoding='utf-8') as f:
            f.write(mutated)
        shutil.copytree(os.path.join(SRC, 'tests'), os.path.join(wd, 'tests'))

        if not changed:
            results.append((name, expect, [], 'ANCHOR_MISS 锚点未命中'))
            print('\n[SKIP] %s -> 锚点未命中（注入失败）' % name)
            continue

        res = run_checks(wd)
        failed = [k for k, (rc, _) in res.items() if rc != 0]
        intercepted = expect in failed
        any_failed = bool(failed)
        if intercepted:
            verdict = 'INTERCEPTED'
        elif any_failed:
            verdict = 'CAUGHT_BY_OTHER(' + ','.join(failed) + ')'
        else:
            verdict = '*** LEAK 漏网 ***'
        results.append((name, expect, failed, verdict))
        print('\n[%s] %s' % (verdict, name))
        print('   期望拦截层: %s | 实际 FAIL 层: %s' % (expect, failed or '无'))
        if not intercepted and any_failed:
            for k in failed:
                tail = [l for l in res[k][1].splitlines() if 'X ' in l or 'FAIL' in l]
                if tail:
                    print('   %s: %s' % (k, tail[-1][:100]))

    print('\n' + '=' * 70)
    print('汇总')
    print('=' * 70)
    leak = 0
    for name, expect, failed, verdict in results:
        print('  %-28s %s' % (verdict, name))
        if 'LEAK' in verdict or 'ANCHOR_MISS' in verdict:
            leak += 1
    print('\n结论: %d/%d 个故障被门禁拦截，%d 个漏网/注入失败' %
          (len(results) - leak, len(results), leak))
    return 0 if leak == 0 else 1


if __name__ == '__main__':
    raise SystemExit(main())
